import { createHash } from "node:crypto"
import type {
  GetServiceStatusInput,
  GetServiceStatusOutput,
  GetServiceTopologyInput,
  GetServiceTopologyOutput,
  GetTraceInput,
  GetTraceOutput,
  QueryLogsInput,
  QueryLogsOutput,
  QueryMetricsInput,
  QueryMetricsOutput,
} from "@incident/contracts"
import { Context, type Effect } from "effect"
import type { ToolError } from "./McpToolServer.ts"

type In<S extends { readonly Type: unknown }> = S["Type"]

/**
 * Where tool results come from: the live backends, or a recorded snapshot (replay).
 * Implementations return complete outputs including `ref`; the server only redacts and trims them.
 */
export class TelemetrySource extends Context.Service<
  TelemetrySource,
  {
    queryMetrics(input: In<typeof QueryMetricsInput>): Effect.Effect<In<typeof QueryMetricsOutput>, ToolError>
    queryLogs(input: In<typeof QueryLogsInput>): Effect.Effect<In<typeof QueryLogsOutput>, ToolError>
    getTrace(input: In<typeof GetTraceInput>): Effect.Effect<In<typeof GetTraceOutput>, ToolError>
    getServiceStatus(
      input: In<typeof GetServiceStatusInput>,
    ): Effect.Effect<In<typeof GetServiceStatusOutput>, ToolError>
    getServiceTopology(
      input: In<typeof GetServiceTopologyInput>,
    ): Effect.Effect<In<typeof GetServiceTopologyOutput>, ToolError>
  }
>()("@incident/mcp-observability/TelemetrySource") {}

const REF_PREFIX = {
  query_metrics: "metrics",
  query_logs: "logs",
  get_trace: "trace",
  get_service_status: "status",
  get_service_topology: "topology",
} as const

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
        )
      : value

/**
 * Evidence id for one tool result: deterministic for the same tool and input, so a report's
 * citations can be checked against the tool results of the same investigation.
 */
export const makeRef = (tool: keyof typeof REF_PREFIX, input: unknown): string =>
  `${REF_PREFIX[tool]}-${createHash("sha256")
    .update(JSON.stringify(canonical([tool, input])))
    .digest("hex")
    .slice(0, 12)}`
