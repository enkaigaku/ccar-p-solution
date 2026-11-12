/**
 * Names shared by every process that emits telemetry (api, mcp-observability, mcp-ops) and by the
 * Grafana dashboards and alert rules in `infra/observability`. Renaming anything here means
 * updating those files in the same PR.
 */

/** Orchestration span names. One investigation is one trace rooted at `investigation`. */
export const SpanName = {
  /** Alert ingestion through the webhook. */
  alertIngest: "incident.alert.ingest",
  /** Triage workflow (single Haiku call). SLO: p95 <= 5s. */
  triage: "incident.triage",
  /** Whole investigation, from start to first report. SLO: p95 <= 90s, alert at 120s. */
  investigation: "incident.investigation",
  /** RAG retrieval for one query. */
  retrieve: "incident.retrieve",
  /** One turn of the agent tool loop. */
  agentTurn: "incident.agent.turn",
  /** One MCP tool call made by the agent. */
  toolCall: "incident.tool.call",
  /** Report generation and evidence validation. */
  report: "incident.report",
  /** Approval executor calling `mcp-ops`. */
  opsExecute: "incident.ops.execute",
} as const
export type SpanName = (typeof SpanName)[keyof typeof SpanName]

/**
 * Span attributes added on top of the OpenTelemetry GenAI conventions the Anthropic SDK already
 * records on its own `anthropic.messages.create` spans.
 */
export const Attr = {
  investigationId: "incident.investigation.id",
  alertId: "incident.alert.id",
  /** Which pipeline step a model call belongs to: triage, investigate, postmortem, judge. */
  llmStep: "incident.llm.step",
  promptVersion: "incident.prompt.version",
  /** SHA-256 of the rendered prompt. The text itself goes to the audit table, never to a span. */
  promptSha256: "incident.prompt.sha256",
  indexVersion: "incident.index.version",
  costUsd: "incident.llm.cost_usd",
  cacheHitRatio: "incident.llm.cache_hit_ratio",
  fallbackUsed: "incident.llm.fallback_used",
  toolName: "incident.tool.name",
  /** SHA-256 of a tool result. Same rule as prompts: hash on the span, text in the audit table. */
  toolResultSha256: "incident.tool.result_sha256",
  /** GenAI semantic convention keys we set ourselves on orchestration spans. */
  genAiRequestModel: "gen_ai.request.model",
  genAiResponseModel: "gen_ai.response.model",
  genAiFinishReasons: "gen_ai.response.finish_reasons",
  genAiInputTokens: "gen_ai.usage.input_tokens",
  genAiOutputTokens: "gen_ai.usage.output_tokens",
  genAiCacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  genAiCacheWriteTokens: "gen_ai.usage.cache_write.input_tokens",
} as const

/** Pipeline steps that call Claude. Used as the `step` label on every LLM metric. */
export type LlmStep = "triage" | "investigate" | "postmortem" | "judge"

/**
 * Metric names as Effect sees them. The Collector exports them to Prometheus with
 * `UnderscoreEscapingWithoutSuffixes`, so `incident.llm.cost_usd` becomes `incident_llm_cost_usd`
 * and histograms gain `_bucket` / `_sum` / `_count`.
 */
export const MetricName = {
  llmRequests: "incident.llm.requests",
  llmCostUsd: "incident.llm.cost_usd",
  llmInputTokens: "incident.llm.input_tokens",
  llmOutputTokens: "incident.llm.output_tokens",
  llmCacheReadTokens: "incident.llm.cache_read_tokens",
  llmCacheWriteTokens: "incident.llm.cache_write_tokens",
  llmDailyBudgetUsd: "incident.llm.daily_budget_usd",
  investigations: "incident.investigations",
  investigationCostUsd: "incident.investigation.cost_usd",
  investigationToolCalls: "incident.investigation.tool_calls",
  feedback: "incident.feedback",
  retrievalTop1Score: "incident.retrieval.rerank_top1_score",
  unapprovedWriteAttempts: "incident.ops.unapproved_write_attempts",
} as const
