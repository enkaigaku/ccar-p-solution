import { assert, describe, it } from "@effect/vitest"
import { gateDecision, type RetrievalMetrics, recallAtK, reciprocalRank, reciprocalRankFusion } from "../src/index.ts"

const scored = (...ids: Array<string>) =>
  ids.map((id, i) => ({
    chunk: { id, corpus: "runbook" as const, sourceId: "s", headingPath: [], service: undefined, text: id },
    score: 1 - i / 10,
  }))

describe("reciprocalRankFusion", () => {
  it("rewards chunks that both retrievers rank", () => {
    const fused = reciprocalRankFusion([scored("a", "b", "c"), scored("c", "d")])
    assert.strictEqual(fused[0]?.chunk.id, "c")
    assert.closeTo(fused[0]?.score ?? 0, 1 / 63 + 1 / 61, 1e-12)
    assert.deepStrictEqual(
      fused.map((f) => f.chunk.id),
      ["c", "a", "b", "d"],
    )
  })

  it("breaks ties by id so output is deterministic", () => {
    const fused = reciprocalRankFusion([scored("b"), scored("a")])
    assert.deepStrictEqual(
      fused.map((f) => f.chunk.id),
      ["a", "b"],
    )
  })

  it("handles an empty list", () => {
    assert.deepStrictEqual(
      reciprocalRankFusion([[], scored("a")]).map((f) => f.chunk.id),
      ["a"],
    )
  })
})

describe("retrieval metrics", () => {
  it("recall@k counts relevant ids within the cutoff", () => {
    assert.strictEqual(recallAtK(["a", "b", "c"], ["a", "c"], 2), 0.5)
    assert.strictEqual(recallAtK(["a", "b", "c"], ["a", "c"], 3), 1)
    assert.strictEqual(recallAtK([], ["a"], 8), 0)
  })

  it("reciprocal rank uses the first relevant hit", () => {
    assert.strictEqual(reciprocalRank(["x", "a", "b"], ["b", "a"], 8), 0.5)
    assert.strictEqual(reciprocalRank(["x", "y"], ["a"], 8), 0)
    assert.strictEqual(reciprocalRank(["x", "a"], ["a"], 1), 0)
  })
})

describe("gateDecision", () => {
  const metrics = (recall: number): RetrievalMetrics => ({ k: 8, recallAtK: recall, mrr: 0, cases: [] })

  it("allows the first index above the floor", () => {
    assert.isTrue(gateDecision({ candidate: metrics(0.9), baseline: undefined }).activate)
  })

  it("blocks below the absolute floor", () => {
    assert.isFalse(gateDecision({ candidate: metrics(0.8), baseline: undefined }).activate)
  })

  it("blocks a drop of more than five points", () => {
    const decision = gateDecision({ candidate: metrics(0.88), baseline: metrics(0.95) })
    assert.isFalse(decision.activate)
    assert.include(decision.reason, "dropped")
  })

  it("allows a drop within five points", () => {
    assert.isTrue(gateDecision({ candidate: metrics(0.91), baseline: metrics(0.95) }).activate)
  })
})
