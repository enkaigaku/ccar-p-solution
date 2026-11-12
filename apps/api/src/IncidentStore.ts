import {
  ActionProposal,
  Alert,
  AlertId,
  type AlertmanagerWebhook,
  AlertNotFound,
  type Decision,
  type Feedback,
  Investigation,
  InvestigationId,
  InvestigationNotFound,
  type ProposalId,
  ProposalNotFound,
  ProposalNotPending,
  type Severity,
} from "@incident/contracts"
import { Context, DateTime, Effect, Layer, Option, Ref } from "effect"

interface State {
  readonly alerts: ReadonlyMap<AlertId, Alert>
  readonly investigations: ReadonlyMap<InvestigationId, Investigation>
  readonly proposals: ReadonlyMap<ProposalId, ActionProposal>
  readonly feedback: ReadonlyMap<InvestigationId, ReadonlyArray<Feedback>>
}

const emptyState: State = { alerts: new Map(), investigations: new Map(), proposals: new Map(), feedback: new Map() }

const toSeverity = (label: string | undefined): Severity =>
  label === "critical" || label === "warning" ? label : "info"

/**
 * In-memory persistence for M0, so `apps/web` can develop against a working API.
 * Replaced by a Postgres-backed layer with the same interface in M2.
 */
export class IncidentStore extends Context.Service<
  IncidentStore,
  {
    ingestWebhook(payload: AlertmanagerWebhook): Effect.Effect<ReadonlyArray<AlertId>>
    listAlerts(): Effect.Effect<ReadonlyArray<Alert>>
    startInvestigation(alertId: AlertId): Effect.Effect<Investigation, AlertNotFound>
    getInvestigation(id: InvestigationId): Effect.Effect<Investigation, InvestigationNotFound>
    listProposals(id: InvestigationId): Effect.Effect<ReadonlyArray<ActionProposal>, InvestigationNotFound>
    addFeedback(id: InvestigationId, feedback: Feedback): Effect.Effect<void, InvestigationNotFound>
    listFeedback(id: InvestigationId): Effect.Effect<ReadonlyArray<Feedback>, InvestigationNotFound>
    addProposal(proposal: ActionProposal): Effect.Effect<void, InvestigationNotFound>
    decide(id: ProposalId, decision: Decision): Effect.Effect<ActionProposal, ProposalNotFound | ProposalNotPending>
  }
>()("@incident/api/IncidentStore") {
  static readonly layerMemory = Layer.effect(
    IncidentStore,
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState)

      const requireInvestigation = Effect.fnUntraced(function* (id: InvestigationId) {
        const found = (yield* Ref.get(state)).investigations.get(id)
        if (found === undefined) return yield* new InvestigationNotFound({ id })
        return found
      })

      const ingestWebhook = Effect.fn("IncidentStore.ingestWebhook")(function* (payload: AlertmanagerWebhook) {
        const now = yield* DateTime.now
        const alerts = payload.alerts.map(
          (raw) =>
            new Alert({
              id: AlertId.make(raw.fingerprint),
              fingerprint: raw.fingerprint,
              name: raw.labels.alertname ?? "unknown",
              service: raw.labels.service ?? "unknown",
              severity: toSeverity(raw.labels.severity),
              status: raw.status,
              summary: raw.annotations.summary ?? "",
              labels: raw.labels,
              startsAt: Option.getOrElse(DateTime.make(raw.startsAt), () => now),
            }),
        )
        yield* Ref.update(state, (s) => ({
          ...s,
          alerts: new Map([...s.alerts, ...alerts.map((a) => [a.id, a] as const)]),
        }))
        return alerts.map((a) => a.id)
      })

      const startInvestigation = Effect.fn("IncidentStore.startInvestigation")(function* (alertId: AlertId) {
        if (!(yield* Ref.get(state)).alerts.has(alertId)) return yield* new AlertNotFound({ id: alertId })
        const now = yield* DateTime.now
        const investigation = new Investigation({
          id: InvestigationId.make(crypto.randomUUID()),
          alertId,
          status: "queued",
          hypotheses: [],
          promptVersion: "unset",
          indexVersion: "unset",
          model: "unset",
          createdAt: now,
          updatedAt: now,
        })
        yield* Ref.update(state, (s) => ({
          ...s,
          investigations: new Map([...s.investigations, [investigation.id, investigation]]),
        }))
        return investigation
      })

      const decide = Effect.fn("IncidentStore.decide")(function* (id: ProposalId, decision: Decision) {
        const proposal = (yield* Ref.get(state)).proposals.get(id)
        if (proposal === undefined) return yield* new ProposalNotFound({ id })
        if (proposal.status !== "pending") return yield* new ProposalNotPending({ id, status: proposal.status })
        const decided = new ActionProposal({ ...proposal, status: decision })
        yield* Ref.update(state, (s) => ({ ...s, proposals: new Map([...s.proposals, [id, decided]]) }))
        return decided
      })

      return IncidentStore.of({
        ingestWebhook,
        listAlerts: () => Ref.get(state).pipe(Effect.map((s) => [...s.alerts.values()])),
        startInvestigation,
        getInvestigation: requireInvestigation,
        listProposals: (id) =>
          requireInvestigation(id).pipe(
            Effect.andThen(Ref.get(state)),
            Effect.map((s) => [...s.proposals.values()].filter((p) => p.investigationId === id)),
          ),
        addFeedback: (id, feedback) =>
          requireInvestigation(id).pipe(
            Effect.andThen(
              Ref.update(state, (s) => ({
                ...s,
                feedback: new Map([...s.feedback, [id, [...(s.feedback.get(id) ?? []), feedback]]]),
              })),
            ),
          ),
        listFeedback: (id) =>
          requireInvestigation(id).pipe(
            Effect.andThen(Ref.get(state)),
            Effect.map((s) => s.feedback.get(id) ?? []),
          ),
        addProposal: (proposal) =>
          requireInvestigation(proposal.investigationId).pipe(
            Effect.andThen(
              Ref.update(state, (s) => ({ ...s, proposals: new Map([...s.proposals, [proposal.id, proposal]]) })),
            ),
          ),
        decide,
      })
    }),
  )
}
