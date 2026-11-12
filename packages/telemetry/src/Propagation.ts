import { Effect, Option, Tracer } from "effect"

/**
 * W3C trace context for MCP requests. Following the OpenTelemetry MCP semantic conventions, the
 * client puts `traceparent` in the request's `params._meta` and the server continues the trace
 * from it, so one investigation stays one trace across api, mcp-observability and mcp-ops.
 *
 * Plain Effect, no OpenTelemetry SDK, so it also works where tracing is disabled (tests).
 */

export interface TraceMeta {
  readonly traceparent: string
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const INVALID_TRACE_ID = "0".repeat(32)
const INVALID_SPAN_ID = "0".repeat(16)

export const formatTraceparent = (span: {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}) => `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`

/** Parses a version-00 `traceparent`. Returns none for malformed or all-zero ids. */
export const parseTraceparent = (value: string): Option.Option<Tracer.ExternalSpan> => {
  const match = TRACEPARENT.exec(value.trim().toLowerCase())
  if (match === null) return Option.none()
  const [, traceId, spanId, flags] = match
  if (traceId === undefined || spanId === undefined || flags === undefined) return Option.none()
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return Option.none()
  return Option.some(Tracer.externalSpan({ traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 }))
}

/**
 * The `_meta` entries to attach to an outgoing MCP request: the current span's trace context, or
 * nothing outside a span.
 */
export const currentTraceMeta: Effect.Effect<Partial<TraceMeta>> = Effect.currentParentSpan.pipe(
  Effect.map((span): Partial<TraceMeta> => ({ traceparent: formatTraceparent(span) })),
  Effect.orElseSucceed((): Partial<TraceMeta> => ({})),
)

/**
 * Runs `self` as a continuation of the trace in an incoming MCP request's `_meta`. Without a valid
 * `traceparent` the effect runs unchanged and its spans start a new trace.
 */
export const withTraceMeta =
  (meta: Readonly<Record<string, unknown>> | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const value = meta?.traceparent
    if (typeof value !== "string") return self
    return Option.match(parseTraceparent(value), {
      onNone: () => self,
      onSome: (parent) => Effect.withParentSpan(self, parent),
    })
  }
