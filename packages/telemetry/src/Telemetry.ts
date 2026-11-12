import * as OtelLogger from "@effect/opentelemetry/OtelLogger"
import * as OtelMetrics from "@effect/opentelemetry/OtelMetrics"
import * as OtelTracer from "@effect/opentelemetry/OtelTracer"
import * as OtelResource from "@effect/opentelemetry/Resource"
import { context, propagation, trace } from "@opentelemetry/api"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchLogRecordProcessor, type LogRecordProcessor } from "@opentelemetry/sdk-logs"
import { type MetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Config, Effect, Layer, Metric } from "effect"
import * as Metrics from "./Metrics.ts"

/** `service.namespace` of every Incident Copilot process; dashboards filter on it. */
export const SERVICE_NAMESPACE = "incident-copilot"

export interface ServiceInfo {
  /** `service.name`, e.g. `incident-api`, `incident-mcp-observability`. */
  readonly serviceName: string
  readonly serviceVersion?: string
}

export interface Processors {
  readonly spanProcessor: SpanProcessor
  readonly metricReader?: MetricReader
  readonly logRecordProcessor?: LogRecordProcessor
}

/**
 * Registers a Node tracer provider globally, together with the AsyncLocalStorage context manager
 * and the W3C propagator. The global registration is what lets the Anthropic SDK find the
 * provider without being handed it, and the context manager plus `@effect/opentelemetry`'s
 * context hook is what makes its `anthropic.messages.create` span a child of the Effect span the
 * call runs in. Unregistered on release so tests can install a fresh provider.
 */
const globalTracerProvider = (spanProcessor: SpanProcessor) =>
  Layer.effect(
    OtelTracer.OtelTracerProvider,
    Effect.gen(function* () {
      const resource = yield* OtelResource.Resource
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const provider = new NodeTracerProvider({ resource, spanProcessors: [spanProcessor] })
          provider.register()
          return provider
        }),
        (provider) =>
          Effect.promise(() => provider.forceFlush().finally(() => provider.shutdown())).pipe(
            Effect.ignore,
            Effect.interruptible,
            Effect.timeoutOption("3 seconds"),
            Effect.ensuring(
              Effect.sync(() => {
                trace.disable()
                context.disable()
                propagation.disable()
              }),
            ),
          ),
      )
    }),
  )

/**
 * Tracing, metrics and logs from explicit processors. `TelemetryLive` wires OTLP exporters into
 * this; tests pass in-memory exporters.
 */
export const layerFromProcessors = (service: ServiceInfo, processors: Processors): Layer.Layer<never> => {
  const resource = OtelResource.layerFromEnv(
    OtelResource.configToAttributes({
      serviceName: service.serviceName,
      ...(service.serviceVersion === undefined ? {} : { serviceVersion: service.serviceVersion }),
      attributes: { "service.namespace": SERVICE_NAMESPACE },
    }),
  )
  const tracing = OtelTracer.layer.pipe(Layer.provide(globalTracerProvider(processors.spanProcessor)))
  const metricReader = processors.metricReader
  const metrics =
    metricReader === undefined
      ? Layer.empty
      : OtelMetrics.layer(() => metricReader, { temporality: "cumulative", shutdownTimeout: "3 seconds" })
  const logs =
    processors.logRecordProcessor === undefined
      ? Layer.empty
      : OtelLogger.layer({ mergeWithExisting: true }).pipe(
          Layer.provide(OtelLogger.layerLoggerProvider(processors.logRecordProcessor)),
        )
  return Layer.mergeAll(tracing, metrics, logs).pipe(Layer.provide(resource))
}

/** Environment the OTLP setup reads. Names follow the OpenTelemetry SDK env spec where one exists. */
export const TelemetryConfig = Config.all({
  disabled: Config.Boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false)),
  endpoint: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.withDefault("http://localhost:4318")),
  metricIntervalMs: Config.Int("OTEL_METRIC_EXPORT_INTERVAL").pipe(Config.withDefault(15_000)),
  dailyBudgetUsd: Config.Number("LLM_DAILY_BUDGET_USD").pipe(Config.withDefault(10)),
})

const signalUrl = (endpoint: string, signal: "traces" | "metrics" | "logs") =>
  `${endpoint.replace(/\/+$/, "")}/v1/${signal}`

/**
 * Exports traces, metrics and logs over OTLP/HTTP to the Collector at
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and publishes the daily budget gauge. Provide it last, around the
 * whole application, so every span is exported. With `OTEL_SDK_DISABLED=true` nothing is exported
 * and Effect's default in-process tracer stays in place.
 */
export const TelemetryLive = (service: ServiceInfo): Layer.Layer<never, Config.ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* TelemetryConfig
      if (config.disabled) return Layer.empty
      const exporters = layerFromProcessors(service, {
        spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url: signalUrl(config.endpoint, "traces") })),
        metricReader: new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: signalUrl(config.endpoint, "metrics") }),
          exportIntervalMillis: config.metricIntervalMs,
        }),
        logRecordProcessor: new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: signalUrl(config.endpoint, "logs") }),
        }),
      })
      const budget = Layer.effectDiscard(Metric.update(Metrics.llmDailyBudgetUsd, config.dailyBudgetUsd))
      return Layer.merge(exporters, budget)
    }),
  )
