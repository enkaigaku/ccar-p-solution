import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { BudgetGuard, decide, estimateUsd } from "../src/budget/Budget.ts"
import { costOf } from "../src/budget/pricing.ts"
import { measuredCost } from "../src/promptfoo/hooks.ts"

const month = (spentUsd: number, smoke = 0, full = 0) => ({ spentUsd, runs: { smoke, full } })

describe("budget rules", () => {
  it("free runs are always allowed", () => {
    assert.isTrue(decide("full", 0, month(499, 50, 8)).allow)
    assert.strictEqual(estimateUsd({ cases: 60, agent: "stub", judge: "keyword" }), 0)
  })

  it("estimates investigations and judge calls per case", () => {
    assert.closeTo(estimateUsd({ cases: 10, agent: "api", judge: "claude" }), 3.5, 1e-9)
    assert.closeTo(estimateUsd({ cases: 60, agent: "api", judge: "claude" }), 21, 1e-9)
  })

  it("above 80% of the month only smoke runs are allowed", () => {
    assert.isTrue(decide("full", 25, month(370)).allow)
    assert.isFalse(decide("full", 25, month(380)).allow)
    assert.isTrue(decide("smoke", 3, month(450)).allow)
  })

  it("nothing may exceed the monthly cap", () => {
    assert.isFalse(decide("smoke", 3, month(498)).allow)
  })

  it("enforces run counts per mode", () => {
    assert.isFalse(decide("full", 25, month(0, 0, 8)).allow)
    assert.isFalse(decide("smoke", 3, month(0, 50, 0)).allow)
    assert.isTrue(decide("smoke", 3, month(0, 49, 8)).allow)
  })

  it("prices Opus 5.5 usage including cache reads and writes", () => {
    const usd = costOf("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    })
    assert.closeTo(usd, 4 + 2 + 0.2 + 5, 1e-9)
  })

  it("sums provider and judge cost from promptfoo results", () => {
    const total = measuredCost([
      { cost: 0.3, gradingResult: { componentResults: [{ metadata: { judgeCostUsd: 0.05 } }, {}] } },
      { cost: 0.2, gradingResult: null },
      {},
    ])
    assert.closeTo(total, 0.55, 1e-9)
  })
})

const guardIn = (dir: string, extra: Record<string, string> = {}) =>
  BudgetGuard.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ EVAL_LEDGER_DIR: dir, ...extra }))),
  )

describe("BudgetGuard ledger", () => {
  it.effect("reserves, settles with the measured cost, and counts runs", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      yield* Effect.gen(function* () {
        const guard = yield* BudgetGuard
        yield* guard.reserve("smoke", 3.5, "smoke:a")
        yield* guard.settle("smoke:a", 2.1)
        yield* guard.reserve("full", 21, "full:b")
        yield* guard.reserve("smoke", 0, "smoke:free")
        const state = yield* guard.month
        assert.closeTo(state.spentUsd, 23.1, 1e-9)
        assert.deepStrictEqual(state.runs, { smoke: 1, full: 1 })
      }).pipe(Effect.provide(guardIn(dir)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("uses external month-to-date spend as a floor and refuses full runs above 80%", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          yield* (yield* BudgetGuard).reserve("full", 25, "full:c")
        }).pipe(Effect.provide(guardIn(dir, { EVAL_MONTH_SPEND_USD: "390" }))),
      )
      assert.strictEqual(error._tag, "BudgetExceeded")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
