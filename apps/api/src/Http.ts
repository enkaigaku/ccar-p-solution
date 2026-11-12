import { IncidentApi } from "@incident/contracts"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { IncidentStore } from "./IncidentStore.ts"

const SystemHandlers = HttpApiBuilder.group(IncidentApi, "system", (handlers) =>
  Effect.succeed(handlers.handleAll({ health: () => Effect.void })),
)

const AlertsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "alerts",
  Effect.fn(function* (handlers) {
    const store = yield* IncidentStore
    return handlers.handleAll({
      webhook: ({ payload }) => store.ingestWebhook(payload).pipe(Effect.map((accepted) => ({ accepted }))),
      list: () => store.listAlerts(),
    })
  }),
)

const InvestigationsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "investigations",
  Effect.fn(function* (handlers) {
    const store = yield* IncidentStore
    return handlers.handleAll({
      start: ({ payload }) => store.startInvestigation(payload.alertId),
      get: ({ params }) => store.getInvestigation(params.id),
      proposals: ({ params }) => store.listProposals(params.id),
      feedback: ({ params, payload }) => store.addFeedback(params.id, payload),
    })
  }),
)

const ProposalsHandlers = HttpApiBuilder.group(
  IncidentApi,
  "proposals",
  Effect.fn(function* (handlers) {
    const store = yield* IncidentStore
    return handlers.handleAll({
      decide: ({ params, payload }) => store.decide(params.id, payload.decision),
    })
  }),
)

/** All handler layers, still requiring an `IncidentStore`. */
export const HandlersLayer = Layer.mergeAll(SystemHandlers, AlertsHandlers, InvestigationsHandlers, ProposalsHandlers)

export const ApiRoutes = HttpApiBuilder.layer(IncidentApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(HandlersLayer),
)
