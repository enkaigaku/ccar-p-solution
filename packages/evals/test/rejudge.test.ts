import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { stubInvestigate } from "../src/agent/AgentUnderTest.ts"
import { Datasets, packageRoot } from "../src/dataset/Datasets.ts"
import { encodeRun } from "../src/evaluate.ts"
import { Judge } from "../src/judge/Judge.ts"
import { decodeResults, type RejudgedRow, rejudge, renderSummary, summarize } from "../src/report/rejudge.ts"

const TestLayer = Layer.mergeAll(
  Datasets.layerAt(packageRoot).pipe(Layer.provide(NodeServices.layer)),
  Judge.layerKeyword,
)

const row = (overrides: Partial<RejudgedRow>): RejudgedRow => ({
  caseId: "fc-00000000",
  status: "completed",
  fault: "paymentFailure=50%",
  distractor: false,
  feedback: false,
  graded: true,
  rank: 1,
  verdicts: ["match"],
  latencyMs: 1000,
  agentCostUsd: 0.2,
  judgeCostUsd: 0.01,
  ...overrides,
})

describe("rejudge", () => {
  it.effect("grades the stored hypotheses of a promptfoo result file with the current judge", () =>
    Effect.gen(function* () {
      const datasets = yield* Datasets
      // fc-5e1d0a01 is the synthetic payment case: the stub blames payment, the keyword judge matches on the service.
      const run = stubInvestigate(yield* datasets.snapshot("fc-5e1d0a01"))
      const file = JSON.stringify({
        evalId: "ignored",
        results: {
          version: 3,
          results: [
            { vars: { caseId: "fc-5e1d0a01" }, response: { output: encodeRun(run), cost: 0 }, success: false },
            { vars: { caseId: "fc-5e1d0a02" }, response: null, error: "AgentError: timeout" },
            { vars: { caseId: "fc-5e1d0a03" } },
          ],
        },
      })
      const rows = yield* rejudge(yield* decodeResults(file))
      assert.deepStrictEqual(
        rows.map((r) => [r.caseId, r.status, r.rank]),
        [
          ["fc-5e1d0a01", "completed", 1],
          ["fc-5e1d0a02", "error", undefined],
          ["fc-5e1d0a03", "error", undefined],
        ],
      )
      assert.strictEqual(rows[0]?.fault, "paymentFailure=50%")
      const summary = summarize(rows)
      assert.deepStrictEqual(summary.all, { cases: 3, top1: 1, top3: 1 })
      assert.deepStrictEqual(summary.statuses, { completed: 1, error: 2 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fails on a case id that is not in the datasets", () =>
    Effect.gen(function* () {
      const file = JSON.stringify({ results: { results: [{ vars: { caseId: "fc-ffffffff" } }] } })
      const error = yield* Effect.flip(rejudge(yield* decodeResults(file)))
      assert.include(error.message, "fc-ffffffff")
    }).pipe(Effect.provide(TestLayer)),
  )

  it("summarizes accuracy with and without distractors, statuses, latency and cost", () => {
    const summary = summarize([
      row({ caseId: "fc-00000001", rank: 1, latencyMs: 1000 }),
      row({ caseId: "fc-00000002", rank: 3, latencyMs: 2000, distractor: true }),
      row({ caseId: "fc-00000003", rank: undefined, verdicts: ["partial"], latencyMs: 3000, distractor: true }),
      row({ caseId: "fc-00000004", rank: undefined, verdicts: [], status: "insufficient_information" }),
      // Not graded (no labelled root cause) and never ran: outside accuracy and latency.
      row({ caseId: "ad-00000005", graded: false, rank: undefined, status: "error", latencyMs: 0, agentCostUsd: 0 }),
    ])
    assert.deepStrictEqual(summary.all, { cases: 4, top1: 1, top3: 2 })
    assert.deepStrictEqual(summary.withoutDistractor, { cases: 2, top1: 1, top3: 1 })
    assert.deepStrictEqual(summary.withDistractor, { cases: 2, top1: 0, top3: 1 })
    assert.deepStrictEqual(summary.statuses, { completed: 3, insufficient_information: 1, error: 1 })
    assert.strictEqual(summary.latencyMs.mean, 1750)
    assert.strictEqual(summary.latencyMs.p95, 3000)
    assert.closeTo(summary.agentCostUsd, 0.8, 1e-9)
    assert.deepStrictEqual(
      summary.misses.map((r) => r.caseId),
      ["fc-00000003", "fc-00000004"],
    )
    const text = renderSummary(summary).join("\n")
    assert.include(text, "all cases: top-1 1/4 (25.0%), top-3 2/4 (50.0%)")
    assert.include(text, "miss fc-00000004 paymentFailure=50% [insufficient_information] no hypotheses")
  })

  it("keeps feedback cases out of the baseline accuracy and reports them on their own line", () => {
    const baseline = [row({ caseId: "fc-00000001", rank: 1 }), row({ caseId: "fc-00000002", rank: 2 })]
    const summary = summarize([
      ...baseline,
      row({ caseId: "fb-00000001", fault: "feedback", feedback: true, rank: undefined, verdicts: [] }),
      row({ caseId: "fb-00000002", fault: "feedback", feedback: true, rank: 1 }),
    ])
    // Promoting feedback must not move the figures the fault set is compared by.
    assert.deepStrictEqual(summary.all, summarize(baseline).all)
    assert.deepStrictEqual(summary.withoutDistractor, { cases: 2, top1: 1, top3: 2 })
    assert.deepStrictEqual(summary.feedback, { cases: 2, top1: 1, top3: 1 })
    assert.deepStrictEqual(
      summary.misses.map((r) => r.caseId),
      ["fb-00000001"],
    )
    const text = renderSummary(summary).join("\n")
    assert.include(text, "all cases: top-1 1/2 (50.0%), top-3 2/2 (100.0%)")
    assert.include(text, "feedback cases (not comparable with the above): top-1 1/2 (50.0%), top-3 1/2 (50.0%)")
    assert.notInclude(renderSummary(summarize(baseline)).join("\n"), "feedback cases")
  })

  it("an empty run summarizes to zeros", () => {
    const summary = summarize([])
    assert.deepStrictEqual(summary.all, { cases: 0, top1: 0, top3: 0 })
    assert.strictEqual(summary.latencyMs.p95, 0)
    assert.include(renderSummary(summary).join("\n"), "n/a")
  })
})
