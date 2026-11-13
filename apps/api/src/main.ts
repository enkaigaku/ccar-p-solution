import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { IncidentApi } from "@incident/contracts"
import { TelemetryLive } from "@incident/telemetry"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiScalar } from "effect/http-api"
import { EventsRoute } from "./EventsRoute.ts"
import { ApiRoutes } from "./Http.ts"
import { AppLive } from "./Live.ts"

const DocsRoute = HttpApiScalar.layer(IncidentApi, { path: "/docs" })

const ServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("API_PORT").pipe(Config.withDefault(3000))
    return HttpRouter.serve(Layer.mergeAll(ApiRoutes, EventsRoute, DocsRoute)).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
    )
  }),
).pipe(
  Layer.provide(AppLive),
  // Provided last so every span, including the HTTP server spans, is exported.
  Layer.provide(TelemetryLive({ serviceName: "incident-api" })),
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
