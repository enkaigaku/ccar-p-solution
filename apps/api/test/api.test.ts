import { assert, describe, it } from "@effect/vitest"
import {
  ActionProposal,
  AlertId,
  Authentication,
  Feedback,
  IncidentApi,
  type Investigation,
  InvestigationId,
  Principal,
  ProposalId,
  Retriever,
  ToggleFlag,
} from "@incident/contracts"
import { DateTime, Duration, Effect, Layer, Schedule } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { Investigator } from "../src/agent/Investigator.ts"
import { ApprovalExecutor } from "../src/approval/ApprovalExecutor.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"
import { InvestigationEvents } from "../src/events/InvestigationEvents.ts"
import { HandlersLayer } from "../src/Http.ts"
import { IncidentStore } from "../src/IncidentStore.ts"
import { InvestigationRunner } from "../src/InvestigationRunner.ts"
import { ObservabilityGateway } from "../src/mcp/ObservabilityGateway.ts"
import { OpsGateway } from "../src/mcp/OpsGateway.ts"
import { Triage } from "../src/triage/Triage.ts"
import { goodReport, toggleProposal, webhook, window } from "./fixtures.ts"
import {
  type FakeReply,
  fakeAnthropic,
  jsonText,
  observabilitySession,
  opsServer,
  reply,
  signingKey,
  toolUse,
} from "./harness.ts"

const makeClient = HttpApiTest.groups(IncidentApi, ["system", "session", "alerts", "investigations", "proposals"])

const operator = new Principal({ subject: "u-1", name: "operator", roles: ["viewer", "responder", "approver"] })

/** The whole api behind the HTTP handlers, with fake Claude replies, in-process MCP servers and the stub retriever. */
const testApp = (replies: Array<FakeReply>, principal: Principal = operator) =>
  Effect.gen(function* () {
    const claude = fakeAnthropic(replies)
    const ops = yield* opsServer
    const audit = yield* AuditLog.makeMemory
    const services = Layer.mergeAll(
      IncidentStore.layerMemory,
      InvestigationEvents.layer,
      claude.layer,
      Layer.succeed(AuditLog, audit.service),
      Retriever.layerStub,
      ObservabilityGateway.layerFrom(observabilitySession),
      Layer.succeed(OpsGateway, OpsGateway.fromSession(ops.open)),
    )
    const app = InvestigationRunner.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Triage.layer,
          Layer.effect(Investigator, Investigator.make({ maxTurns: 10, maxCostUsd: 5 })),
          Layer.effect(ApprovalExecutor, ApprovalExecutor.make(signingKey)),
        ),
      ),
      Layer.provideMerge(services),
    )
    const layer = Layer.mergeAll(
      HandlersLayer.pipe(Layer.provideMerge(app), Layer.provideMerge(Authentication.layerStub(principal))),
      HttpServer.layerServices,
    )
    return { layer, requests: claude.requests, executed: ops.executed, audit: audit.records }
  })

const triageReply = reply(
  "end_turn",
  [
    jsonText({
      category: "error-rate",
      service: "checkout",
      severity: "critical",
      summary: "checkout requests fail",
      retrievalQuery: "checkout HighErrorRate errors",
      relatedAlertIds: [],
    }),
  ],
  { model: "claude-haiku-5-5" },
)

const settled = (client: Effect.Success<typeof makeClient>, id: InvestigationId) =>
  client.investigations.get({ params: { id } }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (inv: Investigation) => inv.status !== "queued" && inv.status !== "running",
    }),
    Effect.timeout(Duration.seconds(10)),
  )

describe("IncidentApi", () => {
  it.live("investigates an alert end to end and executes an approved proposal through mcp-ops", () =>
    Effect.gen(function* () {
      const app = yield* testApp([
        triageReply,
        reply("tool_use", [
          toolUse("t1", "query_logs", { service: "payment", ...window, level: "error" }),
          toolUse("t2", "query_logs", { service: "checkout", ...window, level: "error" }),
        ]),
        reply("tool_use", [toolUse("t3", "propose_action", toggleProposal)]),
        reply("end_turn", [jsonText(goodReport)]),
      ])
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        const { accepted } = yield* client.alerts.webhook({ payload: webhook })
        const started = yield* client.investigations.start({ payload: { alertId: accepted[0]! } })
        assert.strictEqual(started.status, "queued")
        // Starting again while it runs returns the same investigation instead of a duplicate.
        const again = yield* client.investigations.start({ payload: { alertId: accepted[0]! } })
        assert.strictEqual(again.id, started.id)

        const done = yield* settled(client, started.id)
        assert.strictEqual(done.status, "awaiting_approval")
        assert.strictEqual(done.model, "claude-opus-5-5")
        assert.strictEqual(done.promptVersion, "investigate@1+method-error-rate@2")
        assert.strictEqual(done.hypotheses[0]?.evidence[0]?.ref, "logs-payment#0")
        assert.include(done.retrievedChunkIds ?? [], "stub-runbook-1")
        assert.isAbove(done.usage?.costUsd ?? 0, 0)
        assert.isDefined(done.traceId)

        const proposals = yield* client.investigations.proposals({ params: { id: started.id } })
        assert.strictEqual(proposals.length, 1)
        const proposal = proposals[0]!
        assert.strictEqual(proposal.status, "pending")
        assert.deepStrictEqual(yield* app.executed, [])

        const decided = yield* client.proposals.decide({
          params: { id: proposal.id },
          payload: { decision: "approved" },
        })
        assert.strictEqual(decided.status, "executed")
        assert.strictEqual(decided.decidedBy, "operator")
        assert.deepStrictEqual(yield* app.executed, ["toggle paymentFailure off"])
        // The decision and the signed approval both name the authenticated approver, by subject.
        const records = yield* app.audit
        const decision = records.find((r) => r.kind === "decision")
        assert.deepStrictEqual(JSON.parse(decision?.payload ?? "{}"), {
          decision: "approved",
          approver: { subject: "u-1", name: "operator" },
        })
        const approval = records.find((r) => r.kind === "approval")
        assert.strictEqual(JSON.parse(approval?.payload ?? "{}").approver, "u-1")

        const final = yield* client.investigations.get({ params: { id: started.id } })
        assert.strictEqual(final.status, "completed")
        // Triage first (Haiku), then three agent turns (Opus).
        assert.deepStrictEqual(
          app.requests.map((r) => r.model),
          ["claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"],
        )
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.live("marks the investigation failed when the model refuses", () =>
    Effect.gen(function* () {
      const app = yield* testApp([triageReply, reply("refusal", [])])
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        const { accepted } = yield* client.alerts.webhook({ payload: webhook })
        const started = yield* client.investigations.start({ payload: { alertId: accepted[0]! } })
        const done = yield* settled(client, started.id)
        assert.strictEqual(done.status, "failed")
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.effect("returns InvestigationNotFound and AlertNotFound for unknown ids", () =>
    Effect.gen(function* () {
      const app = yield* testApp([])
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        yield* client.health()
        const error = yield* client.investigations
          .get({ params: { id: InvestigationId.make("missing") } })
          .pipe(Effect.flip)
        assert.strictEqual(error._tag, "InvestigationNotFound")
        const noAlert = yield* client.investigations
          .start({ payload: { alertId: webhook.alerts[0]!.fingerprint as never } })
          .pipe(Effect.flip)
        assert.strictEqual(noAlert._tag, "AlertNotFound")
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.effect("appends feedback to an existing investigation and rejects it for an unknown one", () =>
    Effect.gen(function* () {
      const app = yield* testApp([])
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        const store = yield* IncidentStore
        const [alertId] = yield* store.ingestWebhook(webhook)
        const investigation = yield* store.startInvestigation(alertId!)
        yield* client.investigations.feedback({
          params: { id: investigation.id },
          payload: new Feedback({ rating: "down" }),
        })
        yield* client.investigations.feedback({
          params: { id: investigation.id },
          payload: new Feedback({ rating: "up", actualRootCause: "paymentFailure flag enabled" }),
        })
        const feedback = yield* store.listFeedback(investigation.id)
        assert.deepStrictEqual(
          feedback.map((f) => f.rating),
          ["down", "up"],
        )
        const error = yield* client.investigations
          .feedback({ params: { id: InvestigationId.make("missing") }, payload: new Feedback({ rating: "up" }) })
          .pipe(Effect.flip)
        assert.strictEqual(error._tag, "InvestigationNotFound")
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.effect("decides a pending proposal exactly once, rejects without executing, and expires stale ones", () =>
    Effect.gen(function* () {
      const app = yield* testApp([])
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        const store = yield* IncidentStore
        const [alertId] = yield* store.ingestWebhook(webhook)
        const investigation = yield* store.startInvestigation(alertId!)
        const now = yield* DateTime.now
        const proposal = (id: string, createdAt: DateTime.Utc) =>
          new ActionProposal({
            id: ProposalId.make(id),
            investigationId: investigation.id,
            action: ToggleFlag.make({ flag: "paymentFailure", variant: "off" }),
            rationale: "Flag enabled a failing code path",
            expectedEffect: "checkout error rate returns below 1%",
            rollbackPlan: "Set the flag back to its previous variant",
            status: "pending",
            createdAt,
          })
        yield* store.addProposal(proposal("p-reject", now))
        yield* store.addProposal(proposal("p-stale", DateTime.subtract(now, { minutes: 11 })))

        const rejected = yield* client.proposals.decide({
          params: { id: ProposalId.make("p-reject") },
          payload: { decision: "rejected" },
        })
        assert.strictEqual(rejected.status, "rejected")
        assert.strictEqual(rejected.decidedBy, "operator")
        assert.deepStrictEqual(
          (yield* app.audit).map((r) => r.kind),
          ["decision"],
        )
        const again = yield* client.proposals
          .decide({ params: { id: ProposalId.make("p-reject") }, payload: { decision: "approved" } })
          .pipe(Effect.flip)
        assert.strictEqual(again._tag, "ProposalNotPending")

        const stale = yield* client.proposals
          .decide({ params: { id: ProposalId.make("p-stale") }, payload: { decision: "approved" } })
          .pipe(Effect.flip)
        assert.strictEqual(stale._tag, "ProposalNotPending")
        assert.strictEqual((yield* store.getProposal(ProposalId.make("p-stale"))).status, "expired")
        assert.deepStrictEqual(yield* app.executed, [])
      }).pipe(Effect.provide(app.layer))
    }),
  )

  const pendingProposal = Effect.gen(function* () {
    const store = yield* IncidentStore
    const [alertId] = yield* store.ingestWebhook(webhook)
    const investigation = yield* store.startInvestigation(alertId ?? AlertId.make("missing"))
    const proposal = new ActionProposal({
      id: ProposalId.make("p-1"),
      investigationId: investigation.id,
      action: ToggleFlag.make({ flag: "paymentFailure", variant: "off" }),
      rationale: "Flag enabled a failing code path",
      expectedEffect: "checkout error rate returns below 1%",
      rollbackPlan: "Set the flag back to its previous variant",
      status: "pending",
      createdAt: yield* DateTime.now,
    })
    yield* store.addProposal(proposal)
    return { alertId: investigation.alertId, investigationId: investigation.id, proposal }
  })

  it.effect("a responder can investigate and give feedback but cannot decide a proposal", () =>
    Effect.gen(function* () {
      const responder = new Principal({ subject: "u-2", name: "bob", roles: ["viewer", "responder"] })
      const app = yield* testApp([], responder)
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        const { investigationId, proposal } = yield* pendingProposal
        yield* client.investigations.feedback({
          params: { id: investigationId },
          payload: new Feedback({ rating: "up" }),
        })
        for (const decision of ["approved", "rejected"] as const) {
          const denied = yield* client.proposals
            .decide({ params: { id: proposal.id }, payload: { decision } })
            .pipe(Effect.flip)
          assert.strictEqual(denied._tag, "Forbidden")
          assert.strictEqual(denied._tag === "Forbidden" ? denied.required : undefined, "approver")
        }
        // Nothing changed and nothing reached mcp-ops or the audit trail.
        const store = yield* IncidentStore
        const after = yield* store.getProposal(proposal.id)
        assert.strictEqual(after.status, "pending")
        assert.isUndefined(after.decidedBy)
        assert.deepStrictEqual(yield* app.executed, [])
        assert.deepStrictEqual(yield* app.audit, [])
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.effect("a viewer can read but cannot start an investigation, give feedback or decide", () =>
    Effect.gen(function* () {
      const app = yield* testApp([], new Principal({ subject: "u-3", name: "carol", roles: ["viewer"] }))
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        const { alertId, investigationId, proposal } = yield* pendingProposal
        assert.strictEqual((yield* client.alerts.list()).length, 1)
        assert.strictEqual((yield* client.investigations.get({ params: { id: investigationId } })).id, investigationId)
        assert.strictEqual((yield* client.investigations.proposals({ params: { id: investigationId } })).length, 1)
        const denied = yield* Effect.all([
          client.investigations.start({ payload: { alertId } }).pipe(Effect.flip),
          client.investigations
            .feedback({ params: { id: investigationId }, payload: new Feedback({ rating: "down" }) })
            .pipe(Effect.flip),
          client.proposals.decide({ params: { id: proposal.id }, payload: { decision: "approved" } }).pipe(Effect.flip),
        ])
        assert.deepStrictEqual(
          denied.map((e) => e._tag),
          ["Forbidden", "Forbidden", "Forbidden"],
        )
        assert.deepStrictEqual(yield* app.executed, [])
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.effect("a principal without roles can only see who they are", () =>
    Effect.gen(function* () {
      const nobody = new Principal({ subject: "u-4", name: "dave", roles: [] })
      const app = yield* testApp([], nobody)
      yield* Effect.gen(function* () {
        const client = yield* makeClient
        assert.deepStrictEqual(yield* client.session.current(), nobody)
        const denied = yield* client.alerts.list().pipe(Effect.flip)
        assert.strictEqual(denied._tag, "Forbidden")
      }).pipe(Effect.provide(app.layer))
    }),
  )

  it.effect("reports the authenticated principal", () =>
    Effect.gen(function* () {
      const app = yield* testApp([])
      const principal = yield* makeClient.pipe(
        Effect.flatMap((client) => client.session.current()),
        Effect.provide(app.layer),
      )
      assert.deepStrictEqual(principal, operator)
    }),
  )
})
