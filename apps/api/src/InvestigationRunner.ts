import {
  ActionProposal,
  type AlertId,
  type AlertNotFound,
  APPROVAL_TOKEN_MAX_TTL_MINUTES,
  type Decision,
  HypothesisUpdated,
  type Investigation,
  type InvestigationId,
  type InvestigationStatus,
  ProposalCreated,
  ProposalId,
  type ProposalNotFound,
  ProposalNotPending,
  StatusChanged,
  StepStarted,
} from "@incident/contracts"
import { recordInvestigationOutcome, SpanName } from "@incident/telemetry"
import { Cause, Config, Context, DateTime, Duration, Effect, FiberSet, Layer, Semaphore } from "effect"
import { Investigator } from "./agent/Investigator.ts"
import { ApprovalExecutor } from "./approval/ApprovalExecutor.ts"
import { InvestigationEvents } from "./events/InvestigationEvents.ts"
import { IncidentStore } from "./IncidentStore.ts"
import { Triage } from "./triage/Triage.ts"

export const RunnerConfig = Config.all({
  /** Investigations running at the same time; the rest wait in `queued`. */
  maxConcurrent: Config.Int("MAX_CONCURRENT_INVESTIGATIONS").pipe(Config.withDefault(2)),
  /** Hard limit for one investigation (design doc SLO: first report p95 <= 90 s). */
  timeout: Config.Duration("INVESTIGATION_TIMEOUT").pipe(Config.withDefault(Duration.minutes(5))),
  /**
   * Recorded as the approver in approval tokens until the console has OIDC login (Keycloak, design doc
   * "认证与授权"). Then it becomes the signed-in approver's identity.
   */
  approver: Config.String("APPROVER_ID").pipe(Config.withDefault("console-operator")),
})

/** Approval requests expire this long after the agent proposed them (design doc: 10 minutes). */
const PROPOSAL_TTL = Duration.minutes(APPROVAL_TOKEN_MAX_TTL_MINUTES)

/**
 * Orchestrates one investigation as one trace: triage (workflow) -> retrieval + agent loop -> report ->
 * approval requests. Runs in the background; progress goes to the store and to `InvestigationEvents` (SSE).
 * Also owns the approval flow: a human decision, then execution through `ApprovalExecutor`.
 */
export class InvestigationRunner extends Context.Service<
  InvestigationRunner,
  {
    /** Starts (or, for an alert already under investigation, returns) an investigation. Returns immediately. */
    start(alertId: AlertId): Effect.Effect<Investigation, AlertNotFound>
    decide(id: ProposalId, decision: Decision): Effect.Effect<ActionProposal, ProposalNotFound | ProposalNotPending>
  }
>()("@incident/api/InvestigationRunner") {
  static readonly layer = Layer.effect(
    InvestigationRunner,
    Effect.gen(function* () {
      const config = yield* RunnerConfig
      const store = yield* IncidentStore
      const events = yield* InvestigationEvents
      const triage = yield* Triage
      const investigator = yield* Investigator
      const executor = yield* ApprovalExecutor
      const fibers = yield* FiberSet.make()
      const slots = yield* Semaphore.make(config.maxConcurrent)

      const setStatus = (id: InvestigationId, status: InvestigationStatus) =>
        store
          .updateInvestigation(id, { status })
          .pipe(Effect.andThen(events.publish(new StatusChanged({ investigationId: id, status }))))

      const pipeline = Effect.fnUntraced(function* (investigation: Investigation) {
        const id = investigation.id
        const traceId = yield* Effect.currentSpan.pipe(
          Effect.map((span) => span.traceId),
          Effect.orElseSucceed(() => undefined),
        )
        yield* store.updateInvestigation(id, { status: "running", ...(traceId === undefined ? {} : { traceId }) })
        yield* events.publish(new StatusChanged({ investigationId: id, status: "running" }))

        yield* events.publish(new StepStarted({ investigationId: id, step: "triage" }))
        const alert = yield* store.getAlert(investigation.alertId)
        const firing = (yield* store.listAlerts()).filter((a) => a.status === "firing")
        const triaged = yield* triage.triage(alert, firing)

        const report = yield* investigator.investigate({ investigationId: id, alert, triage: triaged })
        yield* store.updateInvestigation(id, {
          hypotheses: report.hypotheses,
          promptVersion: report.promptVersion,
          indexVersion: report.indexVersion,
          model: report.model,
        })
        yield* events.publish(new HypothesisUpdated({ investigationId: id, hypotheses: report.hypotheses }))

        const now = yield* DateTime.now
        for (const draft of report.proposals) {
          const proposal = new ActionProposal({
            id: ProposalId.make(crypto.randomUUID()),
            investigationId: id,
            action: draft.action,
            rationale: draft.rationale,
            expectedEffect: draft.expectedEffect,
            rollbackPlan: draft.rollbackPlan,
            status: "pending",
            createdAt: now,
          })
          yield* store.addProposal(proposal)
          yield* events.publish(new ProposalCreated({ investigationId: id, proposal }))
        }

        const status: InvestigationStatus =
          report.status === "completed" && report.proposals.length > 0 ? "awaiting_approval" : report.status
        yield* setStatus(id, status)
        yield* recordInvestigationOutcome({ status, costUsd: report.costUsd, toolCalls: report.toolCalls })
        yield* Effect.annotateCurrentSpan({
          "incident.investigation.status": status,
          "incident.investigation.turns": report.turns,
          "incident.investigation.retrieved_chunks": report.retrievedChunkIds.length,
        })
      })

      const run = (investigation: Investigation) =>
        pipeline(investigation).pipe(
          Effect.timeout(config.timeout),
          Effect.catchCause((cause) =>
            Effect.logError("Investigation failed", Cause.pretty(cause)).pipe(
              Effect.andThen(setStatus(investigation.id, "failed")),
              Effect.andThen(recordInvestigationOutcome({ status: "failed", costUsd: 0, toolCalls: 0 })),
              Effect.ignore,
            ),
          ),
          Effect.annotateLogs({ investigationId: investigation.id }),
          // One investigation is one trace, independent of the HTTP request that started it.
          Effect.withSpan(SpanName.investigation, {
            root: true,
            attributes: { "incident.investigation.id": investigation.id, "incident.alert.id": investigation.alertId },
          }),
          slots.withPermits(1),
        )

      const start = Effect.fn("InvestigationRunner.start")(function* (alertId: AlertId) {
        yield* store.getAlert(alertId)
        const active = yield* store.findActiveInvestigation(alertId)
        if (active._tag === "Some") return active.value
        const investigation = yield* store.startInvestigation(alertId)
        yield* FiberSet.run(fibers, run(investigation))
        return investigation
      })

      /** An investigation waiting for approval completes once none of its proposals is pending. */
      const completeIfDecided = (id: InvestigationId) =>
        Effect.gen(function* () {
          const investigation = yield* store.getInvestigation(id)
          if (investigation.status !== "awaiting_approval") return
          const proposals = yield* store.listProposals(id)
          if (proposals.some((p) => p.status === "pending" || p.status === "approved")) return
          yield* setStatus(id, "completed")
        }).pipe(Effect.ignore)

      const decide = Effect.fn("InvestigationRunner.decide")(function* (id: ProposalId, decision: Decision) {
        const pending = yield* store.getProposal(id)
        const now = yield* DateTime.now
        if (
          pending.status === "pending" &&
          DateTime.isGreaterThan(now, DateTime.addDuration(pending.createdAt, PROPOSAL_TTL))
        ) {
          yield* store.setProposalStatus(id, "expired")
          yield* completeIfDecided(pending.investigationId)
          return yield* new ProposalNotPending({ id, status: "expired" })
        }
        const decided = yield* store.decide(id, decision)
        if (decided.status !== "approved") {
          yield* completeIfDecided(decided.investigationId)
          return decided
        }
        const outcome = yield* executor.execute(decided, config.approver).pipe(
          Effect.as("executed" as const),
          Effect.catch((error) =>
            Effect.logWarning("Approved action failed", error.message).pipe(Effect.as("failed" as const)),
          ),
        )
        const final = yield* store.setProposalStatus(id, outcome)
        yield* completeIfDecided(final.investigationId)
        return final
      })

      return InvestigationRunner.of({ start, decide })
    }),
  )
}
