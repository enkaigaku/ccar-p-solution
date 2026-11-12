import { Metric } from "effect"
import { MetricName } from "./Conventions.ts"

/**
 * Effect metric instruments. Exported through `@effect/opentelemetry` as OTLP metrics, so labels
 * are added per update with `Metric.withAttributes`. Keep label values low-cardinality: model,
 * step, stop reason, rating, outcome, index version. Never investigation ids.
 */

const counter = (name: string, description: string) => Metric.counter(name, { description, incremental: true })

export const llmRequests = counter(
  MetricName.llmRequests,
  "Claude responses by model, step, stop_reason and whether a fallback model served them",
)
export const llmCostUsd = counter(MetricName.llmCostUsd, "Claude spend in USD by model and step")
export const llmInputTokens = counter(MetricName.llmInputTokens, "Uncached input tokens by model and step")
export const llmOutputTokens = counter(MetricName.llmOutputTokens, "Output tokens by model and step")
export const llmCacheReadTokens = counter(MetricName.llmCacheReadTokens, "Prompt-cache read tokens by model and step")
export const llmCacheWriteTokens = counter(
  MetricName.llmCacheWriteTokens,
  "Prompt-cache write tokens by model, step and ttl",
)

export const llmDailyBudgetUsd = Metric.gauge(MetricName.llmDailyBudgetUsd, {
  description: "Configured daily Claude budget in USD; the spend alert compares against it",
})

export const investigations = counter(MetricName.investigations, "Finished investigations by outcome status")

export const investigationCostUsd = Metric.histogram(MetricName.investigationCostUsd, {
  description: "Claude spend per investigation in USD (SLO: mean <= 0.30)",
  boundaries: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2],
})

export const investigationToolCalls = Metric.histogram(MetricName.investigationToolCalls, {
  description: "Tool calls made by the agent per investigation",
  boundaries: [0, 1, 2, 4, 6, 8, 12, 16, 24, 32],
})

export const feedback = counter(MetricName.feedback, "Report feedback by rating (up/down)")

export const retrievalTop1Score = Metric.histogram(MetricName.retrievalTop1Score, {
  description: "Rerank score of the best chunk per retrieval, by index_version",
  boundaries: Metric.linearBoundaries({ start: 0.1, width: 0.1, count: 10 }),
})

export const unapprovedWriteAttempts = counter(
  MetricName.unapprovedWriteAttempts,
  "Write tool calls rejected by mcp-ops for a missing or invalid ApprovalToken, by reason",
)
