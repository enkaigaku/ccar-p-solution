import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { stubInvestigate } from "../src/agent/AgentUnderTest.ts"
import { Datasets, packageRoot } from "../src/dataset/Datasets.ts"
import { snapshotFor } from "../src/evaluate.ts"
import { citations, rootCause, safety } from "../src/promptfoo/assertions.ts"
import IncidentCopilotProvider from "../src/promptfoo/provider.ts"
import { snapshotFixture } from "./fixtures.ts"

const DatasetsLive = Datasets.layerAt(packageRoot).pipe(Layer.provide(NodeServices.layer))

describe("committed datasets", () => {
  it.effect("every case decodes, ids are unique and every snapshot exists and decodes", () =>
    Effect.gen(function* () {
      const datasets = yield* Datasets
      const cases = yield* datasets.cases
      assert.isAbove(cases.length, 0)
      assert.strictEqual(new Set(cases.map((c) => c.id)).size, cases.length)
      for (const c of cases) {
        const snapshot = yield* snapshotFor(c)
        if (c.kind === "fault") assert.strictEqual(snapshot.caseId, c.id, `${c.id} snapshot caseId`)
        // The answer must never be readable from what replay serves.
        if (c.kind === "fault") assert.notInclude(JSON.stringify(snapshot.calls), c.groundTruth.fault.flag)
      }
      yield* datasets.retrieval
      yield* datasets.calibration
    }).pipe(Effect.provide(DatasetsLive)),
  )
})

describe("stub agent", () => {
  it("blames the service with the most error logs and cites its log result", () => {
    const run = stubInvestigate(snapshotFixture())
    assert.strictEqual(run.status, "completed")
    assert.match(run.hypotheses[0]?.summary ?? "", /^payment/)
    assert.deepStrictEqual(run.hypotheses[0]?.evidence, [{ kind: "log", ref: "logs:t:payment" }])
  })
})

describe("promptfoo provider and assertions (stub agent, keyword judge)", () => {
  const provider = new IncidentCopilotProvider()

  it("grades a synthetic fault case end to end", async () => {
    const context = { vars: { caseId: "fc-5e1d0a01" } }
    const response = await provider.callApi("", context)
    assert.isUndefined(response.error)
    const output = response.output ?? ""
    const [c, s, r] = await Promise.all([
      citations(output, context),
      safety(output, context),
      rootCause(output, context),
    ])
    assert.isTrue(c.pass, c.reason)
    assert.isTrue(s.pass, s.reason)
    assert.isTrue(r.pass, r.reason)
    assert.deepStrictEqual(r.namedScores, { root_cause_top1: 1, root_cause_top3: 1 })
  })

  it("catches the stub guessing when evidence was removed", async () => {
    const context = { vars: { caseId: "ad-7a110002" } }
    const response = await provider.callApi("", context)
    const result = await safety(response.output ?? "", context)
    assert.isFalse(result.pass)
    assert.include(result.reason, "should-be-insufficient")
  })

  it("reports a missing or unknown case as an error, not a crash", async () => {
    assert.isDefined((await provider.callApi("", { vars: {} })).error)
    assert.include((await provider.callApi("", { vars: { caseId: "fc-ffffffff" } })).error ?? "", "unknown case")
  })
})
