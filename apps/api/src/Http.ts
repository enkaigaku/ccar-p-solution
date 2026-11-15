import { CurrentPrincipal, IncidentApi, requireRole } from "@incident/contracts"
import { recordFeedback } from "@incident/telemetry"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { IncidentStore } from "./IncidentStore.ts"
import { InvestigationRunner } from "./InvestigationRunner.ts"

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
    return handlers.handleAll({
      start: ({ payload }) => requireRole("responder").pipe(Effect.andThen(runner.start(payload.alertId))),
      get: ({ params }) => requireRole("viewer").pipe(Effect.andThen(store.getInvestigation(params.id))),
      proposals: ({ params }) => requireRole("viewer").pipe(Effect.andThen(store.listProposals(params.id))),
      feedback: ({ params, payload }) =>
        requireRole("responder").pipe(
          Effect.andThen(store.addFeedback(params.id, payload)),
          Effect.tap(() => recordFeedback(payload.rating)),
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

/** All handler layers, still requiring an `IncidentStore`, an `InvestigationRunner` and `Authentication`. */
export const HandlersLayer = Layer.mergeAll(
  SystemHandlers,
  SessionHandlers,
  AlertsHandlers,
  InvestigationsHandlers,
  ProposalsHandlers,
)

export const ApiRoutes = HttpApiBuilder.layer(IncidentApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(HandlersLayer),
)
