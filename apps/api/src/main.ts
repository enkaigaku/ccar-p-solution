import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { IncidentApi } from "@incident/contracts"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiScalar } from "effect/http-api"
import { ApiRoutes } from "./Http.ts"
import { IncidentStore } from "./IncidentStore.ts"

const DocsRoute = HttpApiScalar.layer(IncidentApi, { path: "/docs" })

const ServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("API_PORT").pipe(Config.withDefault(3000))
    return HttpRouter.serve(Layer.mergeAll(ApiRoutes, DocsRoute)).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
    )
  }),
).pipe(Layer.provide(IncidentStore.layerMemory))

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
