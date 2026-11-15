import {
  CurrentPrincipal,
  type Feedback,
  FeedbackId,
  FeedbackRecord,
  IncidentApi,
  type InvestigationId,
  ReportSnapshot,
  requireRole,
} from "@incident/contracts"
import { recordFeedback } from "@incident/telemetry"
import { DateTime, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { FeedbackStore } from "./feedback/FeedbackStore.ts"
import { IncidentStore } from "./IncidentStore.ts"
import { InvestigationRunner } from "./InvestigationRunner.ts"
import { Postmortems } from "./postmortem/Postmortems.ts"

const SystemHandlers = HttpApiBuilder.group(IncidentApi, "system", (handlers) =>
  Effect.succeed(handlers.handleAll({ health: () => Effect.void })),
)

const SessionHandlers = HttpApiBuilder.group(IncidentApi, "session", (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      current: () =>
        Effect.gen(function* () {
          return yield* CurrentPrincipal
        }),
    }),
  ),
)

const AlertsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "alerts",
  Effect.fn(function* (handlers) {
    const store = yield* IncidentStore
    return handlers.handleAll({
      webhook: ({ payload }) => store.ingestWebhook(payload).pipe(Effect.map((accepted) => ({ accepted }))),
      list: () => requireRole("viewer").pipe(Effect.andThen(store.listAlerts())),
    })
  }),
)

const InvestigationsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "investigations",
  Effect.fn(function* (handlers) {
    const store = yield* IncidentStore
    const runner = yield* InvestigationRunner
    const feedbackStore = yield* FeedbackStore
    const postmortems = yield* Postmortems

    const submitFeedback = Effect.fn("feedback.submit")(function* (id: InvestigationId, feedback: Feedback) {
      const principal = yield* requireRole("responder")
      const investigation = yield* store.getInvestigation(id)
      // The alert of a stored investigation always exists; the store never deletes alerts.
      const alert = yield* store.getAlert(investigation.alertId).pipe(Effect.orDie)
      const record = new FeedbackRecord({
        id: FeedbackId.make(crypto.randomUUID()),
        investigationId: id,
        feedback,
        submittedBy: { subject: principal.subject, name: principal.name },
        report: new ReportSnapshot({
          alert,
          status: investigation.status,
          hypotheses: investigation.hypotheses,
          promptVersion: investigation.promptVersion,
          indexVersion: investigation.indexVersion,
          model: investigation.model,
          ...(investigation.traceId === undefined ? {} : { traceId: investigation.traceId }),
        }),
        createdAt: yield* DateTime.now,
      })
      yield* feedbackStore.add(record)
      yield* recordFeedback(feedback.rating)
      // Joins the feedback to the investigation's trace. Free text (root cause, comment) stays out of spans.
      yield* Effect.annotateCurrentSpan({
        "incident.investigation.id": id,
        "incident.feedback.id": record.id,
        "incident.feedback.rating": feedback.rating,
        "incident.feedback.has_root_cause": (feedback.actualRootCause ?? "").trim() !== "",
        ...(investigation.traceId === undefined ? {} : { "incident.investigation.trace_id": investigation.traceId }),
      })
    })

    return handlers.handleAll({
      start: ({ payload }) => requireRole("responder").pipe(Effect.andThen(runner.start(payload.alertId))),
      get: ({ params }) => requireRole("viewer").pipe(Effect.andThen(store.getInvestigation(params.id))),
      proposals: ({ params }) => requireRole("viewer").pipe(Effect.andThen(store.listProposals(params.id))),
      feedback: ({ params, payload }) => submitFeedback(params.id, payload),
      generatePostmortem: ({ params }) =>
        requireRole("responder").pipe(Effect.andThen(postmortems.generate(params.id))),
      postmortem: ({ params }) => requireRole("viewer").pipe(Effect.andThen(postmortems.get(params.id))),
    })
  }),
)

const PostmortemsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "postmortems",
  Effect.fn(function* (handlers) {
    const postmortems = yield* Postmortems
    return handlers.handleAll({
      edit: ({ params, payload }) =>
        requireRole("responder").pipe(Effect.andThen(postmortems.edit(params.id, payload))),
      // Only an approver's decision can put a postmortem into the knowledge base the agent retrieves from.
      review: ({ params, payload }) =>
        Effect.flatMap(requireRole("approver"), (reviewer) =>
          postmortems.review(params.id, payload.decision, reviewer),
        ),
    })
  }),
)

const FeedbackHandlers = HttpApiBuilder.group(
  IncidentApi,
  "feedback",
  Effect.fn(function* (handlers) {
    const feedbackStore = yield* FeedbackStore
    return handlers.handleAll({
      list: ({ query }) =>
        requireRole("viewer").pipe(
          Effect.andThen(
            feedbackStore.list({
              hasRootCause: query.hasRootCause === undefined ? undefined : query.hasRootCause === "true",
              since: query.since,
            }),
          ),
        ),
    })
  }),
)

const ProposalsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "proposals",
  Effect.fn(function* (handlers) {
    const runner = yield* InvestigationRunner
    return handlers.handleAll({
      // Only an approver's decision can lead to a write action; the principal is recorded with the decision.
      decide: ({ params, payload }) =>
        Effect.flatMap(requireRole("approver"), (approver) =>
          runner.decide(params.id, { decision: payload.decision, approver, comment: payload.comment }),
        ),
    })
  }),
)

/** All handler layers, still requiring the stores, an `InvestigationRunner`, `Postmortems` and `Authentication`. */
export const HandlersLayer = Layer.mergeAll(
  SystemHandlers,
  SessionHandlers,
  AlertsHandlers,
  InvestigationsHandlers,
  ProposalsHandlers,
  PostmortemsHandlers,
  FeedbackHandlers,
)

export const ApiRoutes = HttpApiBuilder.layer(IncidentApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(HandlersLayer),
)
