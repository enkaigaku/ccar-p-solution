import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { cacheHitRatio, costUsd, PRICING, tokenBreakdown } from "../src/Pricing.ts"

const usage = (u: { input?: number; output?: number; read?: number; write?: number; write1h?: number }) => ({
  input_tokens: u.input ?? 0,
  output_tokens: u.output ?? 0,
  cache_read_input_tokens: u.read ?? null,
  cache_creation_input_tokens: u.write ?? null,
  cache_creation:
    u.write === undefined
      ? null
      : { ephemeral_5m_input_tokens: u.write - (u.write1h ?? 0), ephemeral_1h_input_tokens: u.write1h ?? 0 },
})

const close = (actual: Option.Option<number>, expected: number) => {
  assert.isTrue(Option.isSome(actual))
  assert.closeTo(Option.getOrThrow(actual), expected, 1e-12)
}

describe("costUsd", () => {
  it("prices every token bucket for Opus 5.5", () => {
    // 1000*4 + 500*20 + 2000*0.2 + 1000*5 (5m write = 1.25x) = 19_400 per million
    close(costUsd("claude-opus-5-5", usage({ input: 1000, output: 500, read: 2000, write: 1000 })), 0.0194)
  })

  it("charges 1-hour cache writes at 2x input", () => {
    // Sonnet 5.5: 600 * 2.5 (5m) + 400 * 4 (1h) = 3_100 per million
    close(costUsd("claude-sonnet-5-5", usage({ write: 1000, write1h: 400 })), 0.0031)
  })

  it("treats cache writes without a TTL breakdown as 5-minute writes", () => {
    const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 }
    assert.deepStrictEqual(tokenBreakdown(u), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 1000,
      cacheWrite1h: 0,
    })
    close(costUsd("claude-opus-5-5", u), 0.005)
  })

  it("switches Haiku 5.5 to long-context rates above 100K prompt tokens", () => {
    close(costUsd("claude-haiku-5-5", usage({ input: 100_000, output: 1000 })), (100_000 * 0.1 + 1000 * 0.5) / 1e6)
    // 60K uncached + 50K cache read = 110K prompt tokens -> 0.5 / 2.5 / 0.05
    close(
      costUsd("claude-haiku-5-5", usage({ input: 60_000, read: 50_000, output: 1000 })),
      (60_000 * 0.5 + 50_000 * 0.05 + 1000 * 2.5) / 1e6,
    )
  })

  it("halves batch requests", () => {
    close(costUsd("claude-opus-5-5", usage({ input: 1_000_000 }), { batch: true }), 2)
  })

  it("returns none for an unpriced model", () => {
    assert.isTrue(Option.isNone(costUsd("claude-unknown-1", usage({ input: 10 }))))
  })

  it("prices the three routed models", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      assert.isDefined(PRICING[model], model)
    }
  })
})

describe("cacheHitRatio", () => {
  it("is cache reads over the whole prompt", () => {
    close(cacheHitRatio(usage({ input: 100, read: 700, write: 200 })), 0.7)
  })

  it("is none for an empty prompt", () => {
    assert.isTrue(Option.isNone(cacheHitRatio(usage({}))))
  })
})
