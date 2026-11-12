/**
 * USD per million tokens, first-party Claude API rates (checked 2026-11-12).
 * Cache writes are billed at 1.25× input for the 5-minute TTL.
 */
export const Pricing = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
} as const
export type PricedModel = keyof typeof Pricing

export interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number | null | undefined
  readonly cache_creation_input_tokens?: number | null | undefined
}

const isPriced = (model: string): model is PricedModel => Object.hasOwn(Pricing, model)

/** Cost of one response. Unknown models are priced as Opus 5.5 so estimates err on the expensive side. */
export const costOf = (model: string, usage: Usage): number => {
  const price = isPriced(model) ? Pricing[model] : Pricing["claude-opus-5-5"]
  const perToken = (rate: number) => rate / 1_000_000
  return (
    usage.input_tokens * perToken(price.input) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(price.input * 1.25) +
    (usage.cache_read_input_tokens ?? 0) * perToken(price.cacheRead) +
    usage.output_tokens * perToken(price.output)
  )
}
