import { DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { CommandRunner } from "./CommandRunner.ts"
import { ToolError } from "./McpToolServer.ts"
import { ObsConfig } from "./ObsConfig.ts"
import { redactLogLine } from "./Redaction.ts"
import { makeRef, TelemetrySource } from "./TelemetrySource.ts"

/** Upper bounds that keep tool results small enough for the model's context. */
export const LIMITS = {
  metricSeries: 20,
  metricTailPoints: 12,
  logLinesScanned: 1000,
  defaultLogSamples: 20,
  topMessages: 10,
  sampleChars: 1000,
  traceSpans: 100,
} as const

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const TRACE_ID = /^[0-9a-fA-F]{16,32}$/

const requireFormat = (field: string, value: string, pattern: RegExp) =>
  pattern.test(value) ? Effect.void : Effect.fail(new ToolError({ message: `Invalid ${field}: "${value}"` }))

const parseTime = (field: string, value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () => Effect.fail(new ToolError({ message: `${field} must be an RFC 3339 timestamp` })),
    onSome: (t) => Effect.succeed(DateTime.toUtc(t)),
  })

const parseWindow = Effect.fnUntraced(function* (input: { readonly start: string; readonly end: string }) {
  const start = yield* parseTime("start", input.start)
  const end = yield* parseTime("end", input.end)
  if (!DateTime.isLessThan(start, end)) return yield* new ToolError({ message: "start must be before end" })
  return {
    start,
    end,
    seconds: Math.max(1, Math.round((DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 1000)),
  }
})

const round = (n: number) => Number(n.toPrecision(6))

// ---------------------------------------------------------------- Prometheus

const PromSuccess = <A extends Schema.Top>(data: A) => Schema.Struct({ status: Schema.Literal("success"), data })
const PromError = Schema.Struct({ error: Schema.String })
const PromMatrix = PromSuccess(
  Schema.Struct({
    result: Schema.Array(
      Schema.Struct({
        metric: Schema.Record(Schema.String, Schema.String),
        values: Schema.Array(Schema.Tuple([Schema.Number, Schema.String])),
      }),
    ),
  }),
)
const PromVector = PromSuccess(
  Schema.Struct({
    result: Schema.Array(
      Schema.Struct({
        metric: Schema.Record(Schema.String, Schema.String),
        value: Schema.Tuple([Schema.Number, Schema.String]),
      }),
    ),
  }),
)

/** Summarise one series: min/max/avg/last plus an evenly spaced tail that always ends at the last point. */
export const summariseSeries = (
  labels: Record<string, string>,
  values: ReadonlyArray<readonly [number, string]>,
  tailPoints: number = LIMITS.metricTailPoints,
) => {
  const points = values.map(([t, v]) => [t, Number(v)] as const).filter(([, v]) => Number.isFinite(v))
  if (points.length === 0) return undefined
  const nums = points.map(([, v]) => v)
  const step = Math.max(1, Math.ceil(points.length / tailPoints))
  const tail = points.filter((_, i) => (points.length - 1 - i) % step === 0).slice(-tailPoints)
  return {
    labels,
    min: round(Math.min(...nums)),
    max: round(Math.max(...nums)),
    avg: round(nums.reduce((a, b) => a + b, 0) / nums.length),
    last: round(nums[nums.length - 1] ?? 0),
    tail: tail.map(([t, v]) => [DateTime.formatIso(DateTime.makeUnsafe(t * 1000)), round(v)] as const),
  }
}

// ---------------------------------------------------------------- Loki

const LokiStreams = Schema.Struct({
  status: Schema.String,
  data: Schema.Struct({
    result: Schema.Array(
      Schema.Struct({
        stream: Schema.Record(Schema.String, Schema.String),
        values: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      }),
    ),
  }),
})

/** Collapse variable parts so similar lines group together. Input is already redacted. */
export const messagePattern = (line: string): string =>
  line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 200)

const logQlString = (value: string) => JSON.stringify(value)

// ---------------------------------------------------------------- Tempo (OTLP JSON)

const OtlpAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({ stringValue: Schema.optionalKey(Schema.String) }),
})
const OtlpSpan = Schema.Struct({
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
  name: Schema.String,
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  status: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])) })),
})
const OtlpResourceSpans = Schema.Struct({
  resource: Schema.optionalKey(Schema.Struct({ attributes: Schema.optionalKey(Schema.Array(OtlpAttribute)) })),
  scopeSpans: Schema.optionalKey(Schema.Array(Schema.Struct({ spans: Schema.optionalKey(Schema.Array(OtlpSpan)) }))),
})
const TempoTrace = Schema.Struct({
  batches: Schema.optionalKey(Schema.Array(OtlpResourceSpans)),
  resourceSpans: Schema.optionalKey(Schema.Array(OtlpResourceSpans)),
})
type TempoTrace = typeof TempoTrace.Type

export const summariseTrace = (trace: TempoTrace, maxSpans: number = LIMITS.traceSpans) => {
  const flat = [...(trace.batches ?? []), ...(trace.resourceSpans ?? [])].flatMap((rs) => {
    const service = rs.resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue ?? "unknown"
    return (rs.scopeSpans ?? []).flatMap((ss) =>
      (ss.spans ?? []).map((s) => ({
        id: s.spanId,
        parentId: s.parentSpanId === undefined || s.parentSpanId === "" ? undefined : s.parentSpanId,
        service,
        name: s.name,
        start: BigInt(s.startTimeUnixNano),
        end: BigInt(s.endTimeUnixNano),
        isError: s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR",
      })),
    )
  })
  if (flat.length === 0) return undefined
  const byId = new Map(flat.map((s) => [s.id, s]))
  const ms = (ns: bigint) => Number(ns / 1000n) / 1000
  // bigint nanoseconds: Math.min/max do not accept bigint.
  let minStart = flat[0]?.start ?? 0n
  let maxEnd = flat[0]?.end ?? 0n
  for (const s of flat) {
    if (s.start < minStart) minStart = s.start
    if (s.end > maxEnd) maxEnd = s.end
  }
  const root = flat
    .filter((s) => s.parentId === undefined || !byId.has(s.parentId))
    .sort((a, b) => (a.start < b.start ? -1 : 1))[0]

  // Keep error spans first, then the slowest, so truncation drops the least informative spans.
  const kept = new Set(
    [...flat]
      .sort((a, b) => Number(b.isError) - Number(a.isError) || Number(b.end - b.start - (a.end - a.start)))
      .slice(0, maxSpans),
  )
  return {
    rootService: root?.service ?? "unknown",
    durationMs: ms(maxEnd - minStart),
    spans: flat
      .filter((s) => kept.has(s))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      .map((s) => {
        const parent = s.parentId === undefined ? undefined : byId.get(s.parentId)
        return {
          service: s.service,
          name: s.name,
          durationMs: ms(s.end - s.start),
          isError: s.isError,
          ...(parent === undefined ? {} : { parent: `${parent.service}/${parent.name}` }),
        }
      }),
  }
}

// ---------------------------------------------------------------- Docker

const DockerContainer = Schema.Struct({
  Name: Schema.String,
  RestartCount: Schema.Int,
  State: Schema.Struct({ Status: Schema.String }),
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
})

const containerState = (status: string): "running" | "restarting" | "exited" | "unknown" =>
  status === "running" || status === "restarting"
    ? status
    : status === "exited" || status === "dead"
      ? "exited"
      : "unknown"

/** `ghcr.io/open-telemetry/demo:2.1.3-checkout` → `2.1.3-checkout`. */
export const imageTag = (image: string): string => {
  const withoutDigest = image.split("@")[0] ?? image
  const lastColon = withoutDigest.lastIndexOf(":")
  return lastColon > withoutDigest.lastIndexOf("/") ? withoutDigest.slice(lastColon + 1) : "latest"
}

const TopologyFile = Schema.Struct({
  edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String, protocol: Schema.String })),
})

// ---------------------------------------------------------------- Layer

export const LiveSourceLayer = Layer.effect(
  TelemetrySource,
  Effect.gen(function* () {
    const config = yield* ObsConfig
    const fs = yield* FileSystem.FileSystem
    const runner = yield* CommandRunner
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.acceptJson))

    const backendError = (backend: string) => (cause: { readonly message: string }) =>
      new ToolError({ message: `${backend} request failed: ${cause.message}` })

    const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(PromError))

    /** GET JSON from a backend. Non-2xx responses become a `ToolError` carrying the backend's message. */
    const getJson = <A>(
      backend: string,
      url: string,
      params: Record<string, string>,
      schema: Schema.Codec<A, unknown>,
    ): Effect.Effect<A, ToolError> =>
      Effect.gen(function* () {
        const res = yield* http.get(url, { urlParams: params })
        if (res.status === 404) return yield* new ToolError({ message: `${backend}: not found` })
        if (res.status < 200 || res.status >= 300) {
          const text = yield* res.text
          const detail = Option.match(decodeErrorBody(text), {
            onNone: () => text.slice(0, 300),
            onSome: (body) => body.error,
          })
          return yield* new ToolError({ message: `${backend} returned ${res.status}: ${detail}` })
        }
        return yield* HttpClientResponse.schemaBodyJson(schema)(res)
      }).pipe(
        Effect.mapError((e) => (e instanceof ToolError ? e : backendError(backend)(e))),
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(new ToolError({ message: `${backend} request timed out` })),
        }),
      )

    const prom = <A>(path: string, params: Record<string, string>, schema: Schema.Codec<A, unknown>) =>
      getJson("Prometheus", `${config.prometheusUrl}${path}`, params, schema)

    const queryMetrics: TelemetrySource["Service"]["queryMetrics"] = Effect.fn("LiveSource.queryMetrics")(
      function* (input) {
        yield* parseWindow(input)
        const body = yield* prom(
          "/api/v1/query_range",
          { query: input.promql, start: input.start, end: input.end, step: `${input.stepSeconds}s` },
          PromMatrix,
        )
        const series = body.data.result
          .flatMap((r) => summariseSeries(r.metric, r.values) ?? [])
          .sort((a, b) => b.max - a.max)
          .slice(0, LIMITS.metricSeries)
        return { ref: makeRef("query_metrics", input), series }
      },
    )

    const queryLogs: TelemetrySource["Service"]["queryLogs"] = Effect.fn("LiveSource.queryLogs")(function* (input) {
      yield* requireFormat("service", input.service, SERVICE_NAME)
      const window = yield* parseWindow(input)
      const filters = [
        ...(input.contains === undefined ? [] : [`|= ${logQlString(input.contains)}`]),
        ...(input.level === undefined ? [] : [`| ${config.lokiLevelLabel}=${logQlString(input.level)}`]),
      ]
      const selector = `{${config.lokiServiceLabel}=${logQlString(input.service)}} ${filters.join(" ")}`.trim()
      const range = { start: input.start, end: input.end }

      const [counts, lines] = yield* Effect.all(
        [
          getJson(
            "Loki",
            `${config.lokiUrl}/loki/api/v1/query`,
            {
              query: `sum by (${config.lokiLevelLabel}) (count_over_time(${selector} [${window.seconds}s]))`,
              time: input.end,
            },
            PromVector,
          ),
          getJson(
            "Loki",
            `${config.lokiUrl}/loki/api/v1/query_range`,
            { query: selector, ...range, limit: String(LIMITS.logLinesScanned), direction: "backward" },
            LokiStreams,
          ),
        ],
        { concurrency: 2 },
      )

      const countsByLevel = Object.fromEntries(
        counts.data.result.map((r) => [r.metric[config.lokiLevelLabel] ?? "unknown", Math.round(Number(r.value[1]))]),
      )
      const entries = lines.data.result
        .flatMap((s) => s.values.map(([ns, line]) => ({ ns: BigInt(ns), line: redactLogLine(line) })))
        .sort((a, b) => (a.ns > b.ns ? -1 : a.ns < b.ns ? 1 : 0))

      const patterns = new Map<string, number>()
      for (const { line } of entries) {
        const p = messagePattern(line)
        patterns.set(p, (patterns.get(p) ?? 0) + 1)
      }
      const ref = makeRef("query_logs", input)
      return {
        ref,
        totalMatched: Object.values(countsByLevel).reduce((a, b) => a + b, 0),
        countsByLevel,
        topMessages: [...patterns.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, LIMITS.topMessages)
          .map(([pattern, count]) => ({ pattern, count })),
        samples: entries.slice(0, input.limit ?? LIMITS.defaultLogSamples).map((e, i) => ({
          ref: `${ref}#${i}`,
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(Number(e.ns / 1_000_000n))),
          line: e.line.slice(0, LIMITS.sampleChars),
        })),
      }
    })

    const getTrace: TelemetrySource["Service"]["getTrace"] = Effect.fn("LiveSource.getTrace")(function* (input) {
      yield* requireFormat("traceId", input.traceId, TRACE_ID)
      const trace = yield* getJson("Tempo", `${config.tempoUrl}/api/traces/${input.traceId}`, {}, TempoTrace).pipe(
        Effect.mapError((e) => (e.message.endsWith("not found") ? new ToolError({ message: "Trace not found" }) : e)),
      )
      const summary = summariseTrace(trace)
      if (summary === undefined) return yield* new ToolError({ message: "Trace not found" })
      return { ref: makeRef("get_trace", input), ...summary }
    })

    const docker = (args: ReadonlyArray<string>) =>
      runner.run("docker", args).pipe(Effect.mapError((e) => new ToolError({ message: e.message })))

    const getServiceStatus: TelemetrySource["Service"]["getServiceStatus"] = Effect.fn("LiveSource.getServiceStatus")(
      function* (input) {
        if (input.service !== undefined) yield* requireFormat("service", input.service, SERVICE_NAME)
        const ids = (yield* docker([
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${config.composeProject}`,
          ...(input.service === undefined ? [] : ["--filter", `label=com.docker.compose.service=${input.service}`]),
        ]))
          .split("\n")
          .filter((line) => line.trim() !== "")
        const containers =
          ids.length === 0
            ? []
            : yield* docker(["inspect", ...ids]).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(DockerContainer)))),
                Effect.mapError(() => new ToolError({ message: "Could not parse docker inspect output" })),
              )
        return {
          ref: makeRef("get_service_status", input),
          services: containers
            .map((c) => ({
              name: c.Config.Labels?.["com.docker.compose.service"] ?? c.Name.replace(/^\//, ""),
              state: containerState(c.State.Status),
              restarts: c.RestartCount,
              imageTag: imageTag(c.Config.Image),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      },
    )

    const getServiceTopology: TelemetrySource["Service"]["getServiceTopology"] = Effect.fn(
      "LiveSource.getServiceTopology",
    )(function* (input) {
      const live = yield* prom(
        "/api/v1/query",
        { query: `sum by (client, server, connection_type) (increase(${config.serviceGraphMetric}[1h])) > 0` },
        PromVector,
      ).pipe(
        Effect.map((body) =>
          body.data.result.flatMap((r) => {
            const from = r.metric.client
            const to = r.metric.server
            if (from === undefined || to === undefined) return []
            const kind = r.metric.connection_type
            return [{ from, to, protocol: kind === undefined || kind === "" ? "rpc" : kind }]
          }),
        ),
        Effect.orElseSucceed(() => []),
      )
      const edges =
        live.length > 0
          ? live
          : yield* fs.readFileString(config.topologyFile).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TopologyFile))),
              Effect.map((file) => file.edges),
              Effect.mapError(() => new ToolError({ message: "No service graph data and no readable topology file" })),
            )
      return {
        ref: makeRef("get_service_topology", input),
        edges: edges
          .filter((e) => input.service === undefined || e.from === input.service || e.to === input.service)
          .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
      }
    })

    return TelemetrySource.of({ queryMetrics, queryLogs, getTrace, getServiceStatus, getServiceTopology })
  }),
)
