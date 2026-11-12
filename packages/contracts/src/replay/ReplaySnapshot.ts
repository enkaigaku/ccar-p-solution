import { Schema } from "effect"
import { AlertmanagerAlert } from "../domain/Alert.ts"
import {
  GetServiceStatusInput,
  GetServiceStatusOutput,
  GetServiceTopologyInput,
  GetServiceTopologyOutput,
  GetTraceInput,
  GetTraceOutput,
  type ObservabilityToolName,
  QueryLogsInput,
  QueryLogsOutput,
  QueryMetricsInput,
  QueryMetricsOutput,
} from "../mcp/ObservabilityTools.ts"

/**
 * Recorded telemetry for one fault-injection case (ADR 007).
 *
 * `@incident/evals` records a snapshot by calling the live `mcp-observability` tools as an MCP client,
 * so every `output` is already PII-redacted and carries the `ref` the agent will cite.
 * `mcp-observability` in replay mode answers tool calls from the snapshot instead of live backends.
 *
 * Layout: `REPLAY_DIR/snapshot.json`, or `REPLAY_DIR/<REPLAY_CASE>/snapshot.json` when `REPLAY_CASE` is set.
 * The labelled root cause is deliberately not part of the snapshot, so it can never leak to the agent.
 */

export const ReplaySnapshotVersion = 1

const recorded = <const Tool extends ObservabilityToolName, I extends Schema.Top, O extends Schema.Top>(
  tool: Tool,
  input: I,
  output: O,
) => Schema.Struct({ tool: Schema.Literal(tool), input, output })

export const RecordedToolCall = Schema.Union([
  recorded("query_metrics", QueryMetricsInput, QueryMetricsOutput),
  recorded("query_logs", QueryLogsInput, QueryLogsOutput),
  recorded("get_trace", GetTraceInput, GetTraceOutput),
  recorded("get_service_status", GetServiceStatusInput, GetServiceStatusOutput),
  recorded("get_service_topology", GetServiceTopologyInput, GetServiceTopologyOutput),
])
export type RecordedToolCall = typeof RecordedToolCall.Type

/** A tool name with its input, as the replay server receives it. */
export type ToolCallRequest = RecordedToolCall extends infer C
  ? C extends RecordedToolCall
    ? Pick<C, "tool" | "input">
    : never
  : never

export class ReplaySnapshot extends Schema.Class<ReplaySnapshot>("@incident/contracts/ReplaySnapshot")({
  version: Schema.Literal(ReplaySnapshotVersion),
  caseId: Schema.NonEmptyString,
  recordedAt: Schema.DateTimeUtcFromString,
  /** The telemetry window the recorder queried. Replayed queries outside it still match; times are ignored. */
  window: Schema.Struct({ start: Schema.DateTimeUtcFromString, end: Schema.DateTimeUtcFromString }),
  /** The alert as Alertmanager would have sent it; evals posts it to `/alerts/webhook`. */
  alert: AlertmanagerAlert,
  calls: Schema.Array(RecordedToolCall),
}) {}

const squash = (text: string) => text.trim().replace(/\s+/g, " ")

/**
 * Exact match key for a tool call. Time fields (`start`, `end`, `stepSeconds`) and `limit` are excluded because
 * the agent never picks the same values the recorder did. Replay falls back to {@link replayFallbackKey}
 * when no exact key matches, and returns an empty result (or "trace not found" for `get_trace`) after that.
 */
export const replayKey = (call: ToolCallRequest): string => {
  switch (call.tool) {
    case "query_metrics":
      return `query_metrics|${squash(call.input.promql)}`
    case "query_logs":
      return `query_logs|${call.input.service}|${call.input.contains ?? ""}|${call.input.level ?? ""}`
    case "get_trace":
      return `get_trace|${call.input.traceId}`
    case "get_service_status":
    case "get_service_topology":
      return `${call.tool}|${call.input.service ?? ""}`
  }
}

/**
 * Coarser key: tool name plus the service the call is about. `undefined` for tools without a meaningful fallback:
 * another PromQL query's series or another trace would be misleading evidence, so those only match exactly.
 */
export const replayFallbackKey = (call: ToolCallRequest): string | undefined => {
  switch (call.tool) {
    case "query_logs":
    case "get_service_status":
    case "get_service_topology":
      return `${call.tool}|${call.input.service ?? ""}`
    case "query_metrics":
    case "get_trace":
      return undefined
  }
}
