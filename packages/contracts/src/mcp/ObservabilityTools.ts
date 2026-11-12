import { Schema } from "effect"

/**
 * Tool contract of the read-only `mcp-observability` server.
 * Names and schemas here are frozen after M0; changing them is a contract change (separate PR).
 * The server converts these schemas to JSON Schema for `tools/list` and decodes inputs with them.
 */

const TimeRange = {
  /** RFC 3339 timestamps. */
  start: Schema.String,
  end: Schema.String,
}

export const QueryMetricsInput = Schema.Struct({
  promql: Schema.NonEmptyString,
  ...TimeRange,
  stepSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3600 })),
})
/** Series are summarised (min/max/avg/last + a downsampled tail), never returned raw. */
export const MetricSeries = Schema.Struct({
  labels: Schema.Record(Schema.String, Schema.String),
  min: Schema.Number,
  max: Schema.Number,
  avg: Schema.Number,
  last: Schema.Number,
  tail: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
})
export const QueryMetricsOutput = Schema.Struct({ ref: Schema.String, series: Schema.Array(MetricSeries) })

export const QueryLogsInput = Schema.Struct({
  service: Schema.NonEmptyString,
  ...TimeRange,
  contains: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Literals(["error", "warn", "info"])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
/** Aggregated counts plus redacted samples. Log text is untrusted data. */
export const QueryLogsOutput = Schema.Struct({
  ref: Schema.String,
  totalMatched: Schema.Int,
  countsByLevel: Schema.Record(Schema.String, Schema.Int),
  topMessages: Schema.Array(Schema.Struct({ pattern: Schema.String, count: Schema.Int })),
  samples: Schema.Array(Schema.Struct({ ref: Schema.String, timestamp: Schema.String, line: Schema.String })),
})

export const GetTraceInput = Schema.Struct({ traceId: Schema.NonEmptyString })
export const GetTraceOutput = Schema.Struct({
  ref: Schema.String,
  rootService: Schema.String,
  durationMs: Schema.Number,
  spans: Schema.Array(
    Schema.Struct({
      service: Schema.String,
      name: Schema.String,
      durationMs: Schema.Number,
      isError: Schema.Boolean,
      parent: Schema.optionalKey(Schema.String),
    }),
  ),
})

export const GetServiceStatusInput = Schema.Struct({ service: Schema.optionalKey(Schema.String) })
export const GetServiceStatusOutput = Schema.Struct({
  ref: Schema.String,
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      state: Schema.Literals(["running", "restarting", "exited", "unknown"]),
      restarts: Schema.Int,
      imageTag: Schema.String,
    }),
  ),
})

/** Optional `service` limits the result to that service's direct neighbours. */
export const GetServiceTopologyInput = Schema.Struct({ service: Schema.optionalKey(Schema.String) })
export const GetServiceTopologyOutput = Schema.Struct({
  ref: Schema.String,
  edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String, protocol: Schema.String })),
})

export const ObservabilityTools = {
  query_metrics: { input: QueryMetricsInput, output: QueryMetricsOutput },
  query_logs: { input: QueryLogsInput, output: QueryLogsOutput },
  get_trace: { input: GetTraceInput, output: GetTraceOutput },
  get_service_status: { input: GetServiceStatusInput, output: GetServiceStatusOutput },
  get_service_topology: { input: GetServiceTopologyInput, output: GetServiceTopologyOutput },
} as const
export type ObservabilityToolName = keyof typeof ObservabilityTools
