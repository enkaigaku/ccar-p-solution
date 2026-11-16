import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeGateResults, type GateResults, gate } from "../src/report/gate.ts"

type Row = GateResults["results"]["results"][number]

const row = (caseId: string, overrides: Partial<Row> = {}): Row => ({
  vars: { caseId },
  response: { output: "{}" },
  namedScores: { citation_validity: 1, safety: 1, root_cause: 0, root_cause_top1: 0, root_cause_top3: 0 },
  ...overrides,
})

const results = (...rows: ReadonlyArray<Row>): GateResults => ({ results: { results: rows } })

const hit = { citation_validity: 1, safety: 1, root_cause: 1, root_cause_top1: 1, root_cause_top3: 1 }

describe("evaluation gate", () => {
  it("passes a stub run whose root causes miss, as long as citations and safety hold", () => {
    const report = gate(results(row("fc-1"), row("fc-2", { namedScores: hit })), { minCases: 2 })
    assert.isTrue(report.pass)
    assert.include(report.lines, "citation_validity: 2/2")
    assert.include(report.lines, "root_cause top-3: 1/2 labelled (50.0%), not gated")
    assert.strictEqual(report.lines.at(-1), "gate: pass")
  })

  it("blocks on a safety or citation failure and names the case", () => {
    const report = gate(
      results(
        row("fc-1", { namedScores: { ...hit, safety: 0 } }),
        row("fc-2", { namedScores: { ...hit, citation_validity: 0.5 } }),
      ),
      { minCases: 1 },
    )
    assert.isFalse(report.pass)
    assert.include(report.lines, "  fail fc-1: safety 0")
    assert.include(report.lines, "  fail fc-2: citation_validity 0.5")
    assert.strictEqual(report.lines.at(-1), "gate: block")
  })

  it("blocks when a case has no output or an assertion did not report its score", () => {
    const report = gate(
      results(row("fc-1", { response: null, error: "connect ECONNREFUSED", namedScores: {} }), row("fc-2", {})),
      { minCases: 1 },
    )
    assert.isFalse(report.pass)
    assert.include(report.lines, "  fail fc-1: no output (connect ECONNREFUSED)")
    assert.include(report.lines, "  fail fc-1: safety missing")
  })

  it("blocks an empty or short run", () => {
    assert.isFalse(gate(results(), { minCases: 1 }).pass)
    const short = gate(results(row("fc-1")), { minCases: 10 })
    assert.include(short.lines, "  fail 1 cases ran, expected at least 10")
  })

  it("gates root-cause accuracy only when a threshold is given", () => {
    const rows = [row("fc-1", { namedScores: hit }), row("fc-2", { namedScores: hit }), row("fc-3")]
    assert.isTrue(gate(results(...rows), { minCases: 1, minTop3: 0.6 }).pass)
    const blocked = gate(results(...rows), { minCases: 1, minTop3: 0.85 })
    assert.isFalse(blocked.pass)
    assert.include(blocked.lines, "  fail root_cause top-3 66.7% is below 85.0%")
  })

  it("leaves cases without a labelled root cause out of the accuracy, and still requires a grade for the rest", () => {
    const ungraded = { citation_validity: 1, safety: 1 }
    const rows = [
      row("fc-1", { namedScores: hit }),
      row("fc-2", { namedScores: hit }),
      row("ad-1", { namedScores: ungraded }),
      row("ad-2", { namedScores: ungraded }),
    ]
    const report = gate(results(...rows), { minCases: 1, minTop3: 0.85, unlabelled: new Set(["ad-1", "ad-2"]) })
    assert.isTrue(report.pass)
    assert.include(report.lines, "root_cause top-3: 2/2 labelled (100.0%), required 85.0%")

    const missing = gate(results(...rows), { minCases: 1, unlabelled: new Set(["ad-1"]) })
    assert.isFalse(missing.pass)
    assert.include(missing.lines, "  fail ad-2: root_cause_top3 missing")
  })

  it.effect("reads a promptfoo output file and ignores the fields it does not need", () =>
    Effect.gen(function* () {
      const file = JSON.stringify({
        evalId: "x",
        results: {
          version: 3,
          stats: { errors: 0 },
          results: [
            { vars: { caseId: "fc-1" }, success: false, response: { output: "{}", cost: 0 }, namedScores: hit },
          ],
        },
      })
      assert.isTrue(gate(yield* decodeGateResults(file), { minCases: 1 }).pass)
    }),
  )

  it("reports feedback cases apart from the gated accuracy, and still holds them to the hard rules", () => {
    const rows = [row("fc-1", { namedScores: hit }), row("fc-2", { namedScores: hit }), row("fb-1"), row("fb-2")]
    const options = { minCases: 1, minTop3: 0.85, feedback: new Set(["fb-1", "fb-2"]) }
    const report = gate(results(...rows), options)
    assert.isTrue(report.pass)
    assert.include(report.lines, "root_cause top-3: 2/2 labelled (100.0%), required 85.0%")
    assert.include(report.lines, "feedback root_cause top-3: 0/2 (0.0%), not gated")
    // Without the set the same misses would block the gate.
    assert.isFalse(gate(results(...rows), { minCases: 1, minTop3: 0.85 }).pass)

    const unsafe = gate(results(...rows.slice(0, 3), row("fb-2", { namedScores: { ...hit, safety: 0 } })), options)
    assert.isFalse(unsafe.pass)
    assert.include(unsafe.lines, "  fail fb-2: safety 0")
  })
})
