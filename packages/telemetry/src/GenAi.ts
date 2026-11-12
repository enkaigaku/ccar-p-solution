import { createHash } from "node:crypto"
import { Effect, Metric, Option } from "effect"
import { Attr, type LlmStep } from "./Conventions.ts"
import * as Metrics from "./Metrics.ts"
import { type CostOptions, cacheHitRatio, costUsd, tokenBreakdown, type UsageLike } from "./Pricing.ts"

/**
 * Hex SHA-256 of a prompt or tool result. Spans carry only this hash (security rule 5); the text
 * goes to the audit table keyed by trace id.
 */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

export interface PromptInfo {
  readonly step: LlmStep
  readonly promptVersion: string
  /** The rendered prompt. Only its hash is recorded. */
  readonly renderedPrompt: string
}

/** Tags the current span with the prompt version and the hash of the rendered prompt. */
export const annotatePrompt = (info: PromptInfo): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [Attr.llmStep]: info.step,
    [Attr.promptVersion]: info.promptVersion,
    [Attr.promptSha256]: sha256Hex(info.renderedPrompt),
  })

/** The parts of a Messages API response that telemetry reads. `Message` and `BetaMessage` both fit. */
export interface ResponseLike {
  readonly model: string
  readonly stop_reason: string | null
  readonly usage: UsageLike
}

export interface ClaudeCallInfo {
  readonly step: LlmStep
  /** The model the request asked for. A different `response.model` means a fallback served it. */
  readonly requestedModel: string
}

/**
 * Records one Claude response: GenAI usage attributes and cost on the current span (the
 * orchestration span that wraps the SDK call, whose child is the SDK's `anthropic.messages.create`
 * span), plus the request, token and cost counters. Returns the cost, or none for an unpriced
 * model, so callers can add it up per investigation.
 */
export const recordClaudeResponse = Effect.fnUntraced(function* (
  info: ClaudeCallInfo,
  response: ResponseLike,
  options?: CostOptions,
) {
  const tokens = tokenBreakdown(response.usage)
  const cost = costUsd(response.model, response.usage, options)
  const fallbackUsed = response.model !== info.requestedModel
  const stopReason = response.stop_reason ?? "none"

  yield* Effect.annotateCurrentSpan({
    [Attr.llmStep]: info.step,
    [Attr.genAiRequestModel]: info.requestedModel,
    [Attr.genAiResponseModel]: response.model,
    [Attr.genAiFinishReasons]: [stopReason],
    [Attr.genAiInputTokens]: tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h,
    [Attr.genAiOutputTokens]: tokens.output,
    [Attr.genAiCacheReadTokens]: tokens.cacheRead,
    [Attr.genAiCacheWriteTokens]: tokens.cacheWrite5m + tokens.cacheWrite1h,
    [Attr.fallbackUsed]: fallbackUsed,
  })
  const ratio = cacheHitRatio(response.usage)
  if (Option.isSome(ratio)) yield* Effect.annotateCurrentSpan(Attr.cacheHitRatio, ratio.value)
  if (Option.isSome(cost)) {
    yield* Effect.annotateCurrentSpan(Attr.costUsd, cost.value)
  } else {
    yield* Effect.logWarning("No price for Claude model; cost not recorded").pipe(
      Effect.annotateLogs({ model: response.model }),
    )
  }

  const labels = { model: response.model, step: info.step }
  yield* Metric.update(
    Metric.withAttributes(Metrics.llmRequests, {
      ...labels,
      stop_reason: stopReason,
      fallback: String(fallbackUsed),
    }),
    1,
  )
  yield* Metric.update(Metric.withAttributes(Metrics.llmInputTokens, labels), tokens.input)
  yield* Metric.update(Metric.withAttributes(Metrics.llmOutputTokens, labels), tokens.output)
  yield* Metric.update(Metric.withAttributes(Metrics.llmCacheReadTokens, labels), tokens.cacheRead)
  yield* Metric.update(
    Metric.withAttributes(Metrics.llmCacheWriteTokens, { ...labels, ttl: "5m" }),
    tokens.cacheWrite5m,
  )
  yield* Metric.update(
    Metric.withAttributes(Metrics.llmCacheWriteTokens, { ...labels, ttl: "1h" }),
    tokens.cacheWrite1h,
  )
  if (Option.isSome(cost)) yield* Metric.update(Metric.withAttributes(Metrics.llmCostUsd, labels), cost.value)
  return cost
})

export interface InvestigationOutcome {
  /** Final `InvestigationStatus`, e.g. `completed`, `insufficient_information`, `failed`. */
  readonly status: string
  readonly costUsd: number
  readonly toolCalls: number
}

/** Records a finished investigation for the quality and cost panels. */
export const recordInvestigationOutcome = Effect.fnUntraced(function* (outcome: InvestigationOutcome) {
  yield* Effect.annotateCurrentSpan(Attr.costUsd, outcome.costUsd)
  yield* Metric.update(Metric.withAttributes(Metrics.investigations, { status: outcome.status }), 1)
  yield* Metric.update(Metrics.investigationCostUsd, outcome.costUsd)
  yield* Metric.update(Metrics.investigationToolCalls, outcome.toolCalls)
})

/** Records report feedback from the console. */
export const recordFeedback = (rating: "up" | "down"): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(Metrics.feedback, { rating }), 1)

/** Records the best rerank score of one retrieval and tags the current span with the index version. */
export const recordRetrieval = Effect.fnUntraced(function* (indexVersion: string, top1Score: number) {
  yield* Effect.annotateCurrentSpan(Attr.indexVersion, indexVersion)
  yield* Metric.update(Metric.withAttributes(Metrics.retrievalTop1Score, { index_version: indexVersion }), top1Score)
})

/**
 * Records a write attempt that `mcp-ops` rejected for a missing, expired, forged or mismatched
 * ApprovalToken. Any increase pages (alert `UnapprovedWriteAttempt`).
 */
export const recordUnapprovedWriteAttempt = (reason: string): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(Metrics.unapprovedWriteAttempts, { reason }), 1)
