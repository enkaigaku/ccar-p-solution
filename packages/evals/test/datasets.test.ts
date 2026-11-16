import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { stubInvestigate } from "../src/agent/AgentUnderTest.ts"
import { Datasets, packageRoot } from "../src/dataset/Datasets.ts"
import { snapshotFor } from "../src/evaluate.ts"
import { MinSamples } from "../src/judge/calibration.ts"
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
        if (c.kind !== "adversarial") assert.strictEqual(snapshot.caseId, c.id, `${c.id} snapshot caseId`)
        // The answer must never be readable from what replay serves.
        if (c.kind === "fault" && !c.synthetic) {
          // Checked on the outputs: a scenario's own trigger query is an input and may name what it measures.
          const served = JSON.stringify(snapshot.calls.map((call) => call.output))
          for (const flag of [c.groundTruth.fault.flag, ...(c.groundTruth.distractors ?? []).map((d) => d.flag)]) {
            assert.notInclude(served, flag, `${c.id} serves the flag name ${flag}`)
          }
          assert.notMatch(served, /feature ?flag/i, `${c.id} serves a feature flag log line`)
        } else if (c.kind === "fault") {
          assert.notInclude(JSON.stringify(snapshot.calls), c.groundTruth.fault.flag)
        }
      }
      yield* datasets.retrieval
    }).pipe(Effect.provide(DatasetsLive)),
  )

  it.effect("every real adversarial case changes what the agent sees and can be scored", () =>
    Effect.gen(function* () {
      const datasets = yield* Datasets
      const cases = (yield* datasets.cases).flatMap((c) => (c.kind === "adversarial" && !c.synthetic ? [c] : []))
      // Design doc: about 20 adversarial cases across injection, unrelated alerts and insufficient data.
      assert.isAtLeast(cases.length, 18)
      for (const attack of ["log-injection", "alert-injection", "unrelated-alert", "insufficient-data"] as const) {
        assert.isAtLeast(cases.filter((c) => c.attack === attack).length, 2, attack)
      }
      const flags = new Set(
        (yield* datasets.cases).flatMap((c) =>
          c.kind === "fault" ? [c.groundTruth.fault.flag, ...(c.groundTruth.distractors ?? []).map((d) => d.flag)] : [],
        ),
      )
      const canaries = new Set<string>()
      for (const c of cases) {
        const base = yield* datasets.snapshot(c.snapshotId)
        const derived = yield* snapshotFor(c)
        const served = JSON.stringify([derived.alert, derived.calls])
        // A real recording, and never the flag name.
        assert.isTrue(/^fc-[0-9a-f]{8}$/.test(c.snapshotId) && !c.snapshotId.startsWith("fc-5e1d0a0"), c.id)
        for (const flag of flags) assert.notInclude(served, flag, `${c.id} serves the flag name ${flag}`)

        if (c.injection !== undefined) {
          const { canary, payload } = c.injection
          assert.include(payload, canary, `${c.id} payload must contain its canary`)
          // The canary only reaches the agent through the payload, so finding it in the output proves the attack worked.
          assert.notInclude(JSON.stringify([base.alert, base.calls]).toLowerCase(), canary.toLowerCase(), c.id)
          assert.isFalse(canaries.has(canary), `${c.id} reuses a canary`)
          canaries.add(canary)
          assert.include(served, JSON.stringify(payload).slice(1, -1), `${c.id} payload is not served`)
          // An injection case still has a correct answer the agent should reach.
          assert.isDefined(c.groundTruth, c.id)
          assert.isFalse(c.expect.insufficientInformation, c.id)
        } else {
          assert.isTrue(c.expect.insufficientInformation, c.id)
          assert.strictEqual(c.expect.forbiddenActions.length, 3, `${c.id} must forbid every action`)
          assert.isBelow(derived.calls.length, base.calls.length, `${c.id} drops nothing`)
        }
        if (c.attack === "unrelated-alert") {
          assert.isDefined(c.alert, c.id)
          const service = c.alert?.service ?? ""
          assert.notInclude(c.dropServices ?? [], service, `${c.id} drops the alerting service`)
          // The alerting service has recorded telemetry, and none of it is an error log.
          const logs = derived.calls.flatMap((call) =>
            call.tool === "query_logs" && call.input.service === service ? [call] : [],
          )
          assert.isAbove(logs.length, 0, `${c.id} has no logs for ${service}`)
          assert.isTrue(
            logs.every((call) => (call.output.countsByLevel.error ?? 0) === 0),
            `${c.id}: ${service} has error logs`,
          )
        }
      }
    }).pipe(Effect.provide(DatasetsLive)),
  )

  it.effect("the calibration set has enough samples of every verdict, each labelled against a committed case", () =>
    Effect.gen(function* () {
      const datasets = yield* Datasets
      const samples = yield* datasets.calibration
      assert.isAtLeast(samples.length, MinSamples)
      assert.strictEqual(new Set(samples.map((s) => s.id)).size, samples.length)
      for (const verdict of ["match", "partial", "miss"] as const) {
        assert.isAtLeast(samples.filter((s) => s.humanVerdict === verdict).length, 5, verdict)
      }
      const truths = new Set(
        (yield* datasets.cases).flatMap((c) =>
          c.kind === "fault"
            ? [`${c.groundTruth.fault.flag}=${c.groundTruth.fault.variant}:${c.groundTruth.rootCause}`]
            : [],
        ),
      )
      for (const s of samples) {
        const { fault, rootCause } = s.groundTruth
        assert.isTrue(truths.has(`${fault.flag}=${fault.variant}:${rootCause}`), `${s.id} matches no committed case`)
      }
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
