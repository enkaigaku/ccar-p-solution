import { fileURLToPath } from "node:url"
import { Config, Context, Effect, Layer, Option, type Scope } from "effect"
import { connect, endpointFromConfig, McpError, type McpSession, transportFor } from "./McpSession.ts"

const defaultEntry = fileURLToPath(new URL("../../../../packages/mcp-observability/src/main.ts", import.meta.url))

/** Variables a spawned `mcp-observability` needs. Nothing else (in particular no API keys) reaches the child. */
const PASS_ENV = [
  "PROMETHEUS_URL",
  "LOKI_URL",
  "TEMPO_URL",
  "LOKI_SERVICE_LABEL",
  "LOKI_LEVEL_LABEL",
  "SERVICE_GRAPH_METRIC",
  "TOPOLOGY_FILE",
  "OTEL_DEMO_COMPOSE_PROJECT",
  "DOCKER_HOST",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SDK_DISABLED",
  "OTEL_RESOURCE_ATTRIBUTES",
]

/** Replay case ids become a directory name; anything else is refused instead of escaping `OBS_REPLAY_DIR`. */
const SAFE_CASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Read-only telemetry tools for the investigation agent (`mcp-observability`). This is the only MCP server the
 * agent can reach; `mcp-ops` is connected exclusively by the approval executor (`OpsGateway`).
 *
 * One session per investigation. With `OBS_REPLAY_DIR` set, each session spawns the server in replay mode for the
 * alert's fingerprint (`REPLAY_CASE`), which is how `packages/evals` serves one recorded snapshot per case.
 */
export class ObservabilityGateway extends Context.Service<
  ObservabilityGateway,
  {
    open(options: { readonly replayCase: string }): Effect.Effect<McpSession, McpError, Scope.Scope>
  }
>()("@incident/api/mcp/ObservabilityGateway") {
  static readonly layer = Layer.effect(
    ObservabilityGateway,
    Effect.gen(function* () {
      const endpoint = yield* endpointFromConfig("OBSERVABILITY", defaultEntry, PASS_ENV)
      const replayDir = yield* Config.option(Config.String("OBS_REPLAY_DIR"))
      if (Option.isSome(replayDir) && endpoint._tag === "http") {
        yield* Effect.logWarning("OBS_REPLAY_DIR is ignored with OBSERVABILITY_MCP_URL; replay needs a stdio server")
      }
      const open = Effect.fn("ObservabilityGateway.open")(function* (options: { readonly replayCase: string }) {
        if (endpoint._tag === "http" || Option.isNone(replayDir)) {
          return yield* connect("mcp-observability", () => transportFor(endpoint))
        }
        if (!SAFE_CASE.test(options.replayCase)) {
          return yield* new McpError({
            server: "mcp-observability",
            message: "alert fingerprint is not a replay case id",
          })
        }
        const env = { ...endpoint.env, REPLAY_DIR: replayDir.value, REPLAY_CASE: options.replayCase }
        return yield* connect("mcp-observability", () => transportFor({ ...endpoint, env }))
      })
      return ObservabilityGateway.of({ open })
    }),
  )

  /** Every investigation gets a session from `make` (tests: an in-process server or a fake). */
  static readonly layerFrom = (make: Effect.Effect<McpSession, McpError, Scope.Scope>) =>
    Layer.succeed(ObservabilityGateway, ObservabilityGateway.of({ open: () => make }))
}
