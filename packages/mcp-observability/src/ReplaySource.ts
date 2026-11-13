import {
  type RecordedToolCall,
  ReplaySnapshot,
  replayFallbackKey,
  replayKey,
  type ToolCallRequest,
} from "@incident/contracts"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ToolError } from "./McpToolServer.ts"
import { makeRef, TelemetrySource } from "./TelemetrySource.ts"

/*
 * Replay mode (ADR 007): answer tool calls from a telemetry snapshot recorded during fault injection.
 * Snapshot format and matching keys are the `ReplaySnapshot` contract.
 */

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

      type RecordedLogs = Extract<RecordedToolCall, { readonly tool: "query_logs" }>
      const logsByService = new Map<string, Array<RecordedLogs>>()
      for (const recorded of snapshot.calls) {
        if (recorded.tool !== "query_logs") continue
        logsByService.set(recorded.input.service, [...(logsByService.get(recorded.input.service) ?? []), recorded])
      }
      /**
       * Logs without an exact match. `level` is an exact filter in the live source, so a query for one level is only
       * answered from a recording of that level; a query for all levels is answered from the unfiltered recording,
       * or from the recording with the most matches when the snapshot has none.
       */
      const logsFallback = (input: RecordedLogs["input"]): RecordedLogs | undefined => {
        const recordings = logsByService.get(input.service) ?? []
        if (input.level !== undefined) return recordings.find((r) => r.input.level === input.level)
        return (
          recordings.find((r) => r.input.level === undefined) ??
          recordings.toSorted((a, b) => b.output.totalMatched - a.output.totalMatched)[0]
        )
      }

      const lookup = (call: ToolCallRequest): RecordedToolCall | undefined => {
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
          const exactHit = exact.get(replayKey({ tool: "query_logs", input }))
          const hit = exactHit?.tool === "query_logs" ? exactHit : logsFallback(input)
          return Effect.succeed(
            hit !== undefined
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
        // A per-service call that was not recorded is answered from the recorded unfiltered call, filtered the way
        // the live source filters. The recorded ref is kept: the data comes from that recorded result.
        getServiceStatus: (input) => {
          const hit = lookup({ tool: "get_service_status", input })
          if (hit?.tool === "get_service_status") return Effect.succeed(hit.output)
          const all = input.service === undefined ? undefined : lookup({ tool: "get_service_status", input: {} })
          return Effect.succeed(
            all?.tool === "get_service_status"
              ? { ref: all.output.ref, services: all.output.services.filter((s) => s.name === input.service) }
              : { ref: makeRef("get_service_status", input), services: [] },
          )
        },
        getServiceTopology: (input) => {
          const hit = lookup({ tool: "get_service_topology", input })
          if (hit?.tool === "get_service_topology") return Effect.succeed(hit.output)
          const all = input.service === undefined ? undefined : lookup({ tool: "get_service_topology", input: {} })
          return Effect.succeed(
            all?.tool === "get_service_topology"
              ? {
                  ref: all.output.ref,
                  edges: all.output.edges.filter((e) => e.from === input.service || e.to === input.service),
                }
              : { ref: makeRef("get_service_topology", input), edges: [] },
          )
        },
      })
    }),
  )
