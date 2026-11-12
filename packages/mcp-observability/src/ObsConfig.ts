import { fileURLToPath } from "node:url"
import { Config, Context, Effect, Layer, Option } from "effect"

const bundledTopology = fileURLToPath(new URL("./topology/otel-demo.json", import.meta.url))

/** Backends queried in live mode. Defaults match `infra/observability` on the developer's Mac. */
export class ObsConfig extends Context.Service<
  ObsConfig,
  {
    readonly prometheusUrl: string
    readonly lokiUrl: string
    readonly tempoUrl: string
    /** Loki stream label holding the service name (OTLP ingestion uses `service_name`). */
    readonly lokiServiceLabel: string
    /** Loki label or structured-metadata field holding the normalised level. */
    readonly lokiLevelLabel: string
    /** Prometheus counter produced by a service-graph connector, used for live topology. */
    readonly serviceGraphMetric: string
    /** Static topology used when the service-graph metric has no data. */
    readonly topologyFile: string
    readonly composeProject: string
  }
>()("@incident/mcp-observability/ObsConfig") {
  static readonly layer = Layer.effect(
    ObsConfig,
    Effect.gen(function* () {
      const str = (name: string, fallback: string) => Config.String(name).pipe(Config.withDefault(fallback))
      return ObsConfig.of({
        prometheusUrl: yield* str("PROMETHEUS_URL", "http://localhost:9090"),
        lokiUrl: yield* str("LOKI_URL", "http://localhost:3100"),
        tempoUrl: yield* str("TEMPO_URL", "http://localhost:3200"),
        lokiServiceLabel: yield* str("LOKI_SERVICE_LABEL", "service_name"),
        lokiLevelLabel: yield* str("LOKI_LEVEL_LABEL", "detected_level"),
        serviceGraphMetric: yield* str("SERVICE_GRAPH_METRIC", "traces_service_graph_request_total"),
        topologyFile: yield* str("TOPOLOGY_FILE", bundledTopology),
        composeProject: yield* str("OTEL_DEMO_COMPOSE_PROJECT", "opentelemetry-demo"),
      })
    }),
  )
}

/** `REPLAY_DIR` (and optionally `REPLAY_CASE`) switch the server to snapshot replay. */
export const ReplayLocation = Config.all({
  dir: Config.option(Config.String("REPLAY_DIR")),
  caseId: Config.option(Config.String("REPLAY_CASE")),
}).pipe(Config.map(({ dir, caseId }) => Option.map(dir, (d) => ({ dir: d, caseId: Option.getOrUndefined(caseId) }))))
