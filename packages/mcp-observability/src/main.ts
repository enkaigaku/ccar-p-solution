import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Logger, Option } from "effect"
import { CommandRunner } from "./CommandRunner.ts"
import { LiveSourceLayer } from "./LiveSource.ts"
import { serveHttp, serveStdio } from "./McpToolServer.ts"
import { ObsConfig, ReplayLocation } from "./ObsConfig.ts"
import { makeObservabilityServer } from "./ObservabilityServer.ts"
import { ReplaySourceLayer } from "./ReplaySource.ts"

/**
 * Entry point. `MCP_TRANSPORT=stdio` (default) or `http` (Streamable HTTP on `MCP_HTTP_HOST:MCP_HTTP_PORT/mcp`,
 * bearer `MCP_HTTP_TOKEN`). With `REPLAY_DIR` set, results come from a recorded snapshot instead of live backends.
 */
// Startup failures (bad config, unreadable snapshot) end the process with the error printed.
const LiveLayer = LiveSourceLayer.pipe(
  Layer.provide([ObsConfig.layer, CommandRunner.layer, NodeHttpClient.layerUndici]),
  Layer.provide(NodeServices.layer),
  Layer.orDie,
)

const SourceLayer = Layer.unwrap(
  Effect.map(ReplayLocation, (replay) =>
    Option.isSome(replay)
      ? ReplaySourceLayer(replay.value).pipe(Layer.provide(NodeServices.layer), Layer.orDie)
      : LiveLayer,
  ),
)

const MainLayer = SourceLayer.pipe(
  // stdout carries the MCP protocol in stdio mode, so every log line goes to stderr.
  Layer.provideMerge(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
)

const program = Effect.gen(function* () {
  const transport = yield* Config.Literals(["stdio", "http"], "MCP_TRANSPORT").pipe(Config.withDefault("stdio"))
  if (transport === "stdio") return yield* serveStdio(makeObservabilityServer)
  return yield* serveHttp(makeObservabilityServer, {
    host: yield* Config.String("MCP_HTTP_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: yield* Config.Port("MCP_HTTP_PORT").pipe(Config.withDefault(3101)),
    token: yield* Config.Redacted("MCP_HTTP_TOKEN"),
  })
})

program.pipe(Effect.provide(MainLayer), NodeRuntime.runMain)
