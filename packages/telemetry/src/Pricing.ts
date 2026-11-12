import type Anthropic from "@anthropic-ai/sdk"
import { Option } from "effect"

/**
 * The usage fields cost depends on. Both `Anthropic.Messages.Usage` and the beta endpoint's usage
 * (needed for server-side `fallbacks`) satisfy it.
 */
export type UsageLike = Pick<
  Anthropic.Messages.Usage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
> & {
  readonly cache_creation?: Pick<
    Anthropic.Messages.CacheCreation,
    "ephemeral_5m_input_tokens" | "ephemeral_1h_input_tokens"
  > | null
}

/** USD per million tokens. */
export interface Rates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  /** Cache write with the default 5-minute TTL (1.25x input). */
  readonly cacheWrite5m: number
  /** Cache write with the 1-hour TTL (2x input). */
  readonly cacheWrite1h: number
}

export interface ModelPricing {
  readonly standard: Rates
  /** Rates once the prompt (input + cache read + cache write) exceeds `threshold` tokens. */
  readonly longContext?: { readonly threshold: number; readonly rates: Rates }
}

const rates = (input: number, output: number, cacheRead: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
})

/**
 * First-party Claude API list prices, checked 2026-11-12. Update together with ADR 006 when the
 * routing changes. Models that `fallbacks: "default"` can route to are included so a fallback
 * response is still priced.
 *
 * Haiku 5.5 cache-read price is not published separately; it is assumed to be the usual 0.1x of
 * input.
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-5-5": { standard: rates(4, 20, 0.2) },
  "claude-sonnet-5-5": { standard: rates(2, 10, 0.1) },
  "claude-haiku-5-5": {
    standard: rates(0.1, 0.5, 0.01),
    longContext: { threshold: 100_000, rates: rates(0.5, 2.5, 0.05) },
  },
  "claude-opus-5": { standard: rates(5, 25, 0.5) },
  "claude-opus-4-8": { standard: rates(5, 25, 0.5) },
  "claude-sonnet-5": { standard: rates(2, 10, 0.2) },
}

export interface CostOptions {
  /** Message Batches API requests are billed at 50%. */
  readonly batch?: boolean
}

export interface TokenBreakdown {
  /** Uncached input tokens (the API's `input_tokens`, which excludes cache reads and writes). */
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite5m: number
  readonly cacheWrite1h: number
}

const n = (value: number | null | undefined): number => value ?? 0

/**
 * Splits a usage block into the billed buckets. When the API omits the TTL breakdown, every cache
 * write is treated as a 5-minute write (the default TTL).
 */
export const tokenBreakdown = (usage: UsageLike): TokenBreakdown => {
  const cacheWrite = n(usage.cache_creation_input_tokens)
  const byTtl = usage.cache_creation
  const cacheWrite1h = byTtl ? n(byTtl.ephemeral_1h_input_tokens) : 0
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheWrite1h,
    cacheWrite5m: Math.max(cacheWrite - cacheWrite1h, 0),
  }
}

/** Total prompt size as the API counts it for long-context pricing and cache hit ratio. */
export const promptTokens = (t: TokenBreakdown): number => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

/**
 * Share of the prompt served from cache, or none for an empty prompt. This is the number behind the
 * `>= 70%` SLO and the `< 50% for 30 minutes` alert.
 */
export const cacheHitRatio = (usage: UsageLike): Option.Option<number> => {
  const t = tokenBreakdown(usage)
  const total = promptTokens(t)
  return total === 0 ? Option.none() : Option.some(t.cacheRead / total)
}

/**
 * Cost of one response in USD, or none when the model has no price entry. Price by the model that
 * served the response (`message.model`), which differs from the requested one after a fallback.
 */
export const costUsd = (model: string, usage: UsageLike, options?: CostOptions): Option.Option<number> => {
  const pricing = PRICING[model]
  if (pricing === undefined) return Option.none()
  const t = tokenBreakdown(usage)
  const r =
    pricing.longContext !== undefined && promptTokens(t) > pricing.longContext.threshold
      ? pricing.longContext.rates
      : pricing.standard
  const perMillion =
    t.input * r.input +
    t.output * r.output +
    t.cacheRead * r.cacheRead +
    t.cacheWrite5m * r.cacheWrite5m +
    t.cacheWrite1h * r.cacheWrite1h
  const discount = options?.batch === true ? 0.5 : 1
  return Option.some((perMillion / 1_000_000) * discount)
}
