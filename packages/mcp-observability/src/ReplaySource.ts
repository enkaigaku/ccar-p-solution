import { ObservabilityTools } from "@incident/contracts"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ToolError } from "./McpToolServer.ts"
import { makeRef, TelemetrySource } from "./TelemetrySource.ts"

/*
 * Replay mode (ADR 007): answer tool calls from a telemetry snapshot recorded during fault injection.
 *
 * TEMPORARY: the snapshot schema and matching keys below mirror the `ReplaySnapshot` contract that the
 * evals work package is adding to `@incident/contracts`. Once that lands, this file imports it instead.
 */

const call = <T extends string, I extends Schema.Top, O extends Schema.Top>(tool: T, io: { input: I; output: O }) =>
  Schema.Struct({ tool: Schema.Literal(tool), input: io.input, output: io.output })

export const RecordedToolCall = Schema.Union([
  call("query_metrics", ObservabilityTools.query_metrics),
  call("query_logs", ObservabilityTools.query_logs),
  call("get_trace", ObservabilityTools.get_trace),
  call("get_service_status", ObservabilityTools.get_service_status),
  call("get_service_topology", ObservabilityTools.get_service_topology),
])
export type RecordedToolCall = typeof RecordedToolCall.Type

export const ReplaySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  caseId: Schema.String,
  recordedAt: Schema.String,
  window: Schema.Struct({ start: Schema.String, end: Schema.String }),
  alert: Schema.Unknown,
  calls: Schema.Array(RecordedToolCall),
})
export type ReplaySnapshot = typeof ReplaySnapshot.Type

/** A tool name with its decoded input, as recorded or as received. */
type PickCall<C> = C extends RecordedToolCall ? Pick<C, "tool" | "input"> : never
export type ToolCall = PickCall<RecordedToolCall>

/**
 * Exact matching key. Time window, step and limit are dropped: the agent never asks for exactly the
 * window that was recorded, and the snapshot already covers the incident window.
 */
export const replayKey = (call: ToolCall): string => {
  switch (call.tool) {
    case "query_metrics":
      return `${call.tool}:${call.input.promql.replace(/\s+/g, "")}`
    case "query_logs":
      return `${call.tool}:${call.input.service}|${call.input.contains ?? ""}|${call.input.level ?? ""}`
    case "get_trace":
      return `${call.tool}:${call.input.traceId}`
    case "get_service_status":
    case "get_service_topology":
      return `${call.tool}:${call.input.service ?? ""}`
  }
}

/** Looser key tried after an exact miss: same tool and service. Metrics and traces only match exactly. */
export const replayFallbackKey = (call: ToolCall): string | undefined => {
  switch (call.tool) {
    case "query_metrics":
    case "get_trace":
      return undefined
    default:
      return `${call.tool}~${call.input.service ?? ""}`
  }
}

export const ReplaySourceLayer = (location: { readonly dir: string; readonly caseId: string | undefined }) =>
  Layer.effect(
    TelemetrySource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file =
        location.caseId === undefined
          ? path.join(location.dir, "snapshot.json")
          : path.join(location.dir, location.caseId, "snapshot.json")
      const snapshot = yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReplaySnapshot))))
      yield* Effect.logInfo(`Replay mode: case ${snapshot.caseId} (${snapshot.calls.length} recorded calls)`)

      const exact = new Map<string, RecordedToolCall>()
      const fallback = new Map<string, RecordedToolCall>()
      // First recording wins when several calls share a key.
      for (const recorded of snapshot.calls) {
        const key = replayKey(recorded)
        if (!exact.has(key)) exact.set(key, recorded)
        const loose = replayFallbackKey(recorded)
        if (loose !== undefined && !fallback.has(loose)) fallback.set(loose, recorded)
      }

      const lookup = (call: ToolCall): RecordedToolCall | undefined => {
        const loose = replayFallbackKey(call)
        return exact.get(replayKey(call)) ?? (loose === undefined ? undefined : fallback.get(loose))
      }

      return TelemetrySource.of({
        queryMetrics: (input) => {
          const hit = lookup({ tool: "query_metrics", input })
          return Effect.succeed(
            hit?.tool === "query_metrics" ? hit.output : { ref: makeRef("query_metrics", input), series: [] },
          )
        },
        queryLogs: (input) => {
          const hit = lookup({ tool: "query_logs", input })
          return Effect.succeed(
            hit?.tool === "query_logs"
              ? hit.output
              : {
                  ref: makeRef("query_logs", input),
                  totalMatched: 0,
                  countsByLevel: {},
                  topMessages: [],
                  samples: [],
                },
          )
        },
        getTrace: (input) => {
          const hit = lookup({ tool: "get_trace", input })
          return hit?.tool === "get_trace"
            ? Effect.succeed(hit.output)
            : Effect.fail(new ToolError({ message: "Trace not found" }))
        },
        getServiceStatus: (input) => {
          const hit = lookup({ tool: "get_service_status", input })
          return Effect.succeed(
            hit?.tool === "get_service_status"
              ? hit.output
              : { ref: makeRef("get_service_status", input), services: [] },
          )
        },
        getServiceTopology: (input) => {
          const hit = lookup({ tool: "get_service_topology", input })
          return Effect.succeed(
            hit?.tool === "get_service_topology"
              ? hit.output
              : { ref: makeRef("get_service_topology", input), edges: [] },
          )
        },
      })
    }),
  )
