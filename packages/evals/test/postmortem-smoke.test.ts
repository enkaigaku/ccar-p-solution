import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { InvestigationId, InvestigationUsage, PostmortemBody, PostmortemDraft, PostmortemId } from "@incident/contracts"
import { DateTime, Effect, Layer } from "effect"
import { Datasets, packageRoot } from "../src/dataset/Datasets.ts"
import { Judge } from "../src/judge/Judge.ts"
import {
  estimatePostmortemSmokeUsd,
  type PostmortemSmokeCase,
  PostmortemSmokeError,
  PostmortemSource,
  reportPostmortemSmoke,
  runPostmortemSmoke,
} from "../src/postmortem/smoke.ts"

const at = DateTime.makeUnsafe("2026-11-12T03:00:00.000Z")

const draft = (rootCause: string) =>
  new PostmortemDraft({
    id: PostmortemId.make("pm-1"),
    investigationId: InvestigationId.make("inv-1"),
    status: "draft",
    service: "checkout",
    body: new PostmortemBody({
      title: "Checkout failures",
      summary: "Checkout returned errors.",
      symptoms: "HighErrorRate fired.",
      rootCause,
      mitigation: "None recorded.",
    }),
    model: "claude-sonnet-5-5",
    promptVersion: "postmortem@1",
    usage: new InvestigationUsage({ costUsd: 0.03, inputTokens: 3000, outputTokens: 600 }),
    edited: false,
    createdAt: at,
    updatedAt: at,
  })

/** Writes what `write` returns for the case; records the root cause it was handed as the responder's. */
const source = (write: (input: PostmortemSmokeCase) => string | PostmortemSmokeError) =>
  Layer.succeed(
    PostmortemSource,
    PostmortemSource.of({
      draft: (input) => {
        const written = write(input)
        return typeof written === "string"
          ? Effect.succeed({ investigationStatus: "completed", investigationCostUsd: 0.3, draft: draft(written) })
          : Effect.fail(written)
      },
    }),
  )

const inputs = Effect.gen(function* () {
  const datasets = yield* Datasets
  const cases = (yield* datasets.cases).flatMap((c) => (c.kind === "fault" && c.smoke ? [c] : [])).slice(0, 2)
  return yield* Effect.forEach(cases, (c) =>
    Effect.map(datasets.snapshot(c.snapshotId), (snapshot) => ({ case: c, truth: c.groundTruth, snapshot })),
  )
}).pipe(Effect.provide(Datasets.layerAt(packageRoot).pipe(Layer.provide(NodeServices.layer))))

describe("postmortem smoke", () => {
  it.effect("passes when every draft states the responder's root cause", () =>
    Effect.gen(function* () {
      const cases = yield* inputs
      assert.strictEqual(cases.length, 2)
      const rows = yield* runPostmortemSmoke(cases).pipe(
        // The keyword judge matches a text that names the faulty service.
        Effect.provide(source((input) => `The ${input.truth.service} service failed.`)),
      )
      assert.deepStrictEqual(
        rows.map((r) => r.rootCause),
        ["match", "match"],
      )
      assert.closeTo(rows[0]?.costUsd ?? 0, 0.33, 1e-9)
      const report = reportPostmortemSmoke(rows)
      assert.isTrue(report.pass)
      assert.strictEqual(report.lines[0], "postmortem@1, claude-sonnet-5-5")
      assert.include(report.lines, "drafts that state the responder's root cause: 2/2")
      assert.strictEqual(report.lines.at(-1), "postmortem smoke: pass")
    }).pipe(Effect.provide(Judge.layerKeyword)),
  )

  it.effect("fails on a draft with another root cause, and on a case that produced no draft", () =>
    Effect.gen(function* () {
      const cases = yield* inputs
      const second = cases[1]?.case.id ?? ""
      const rows = yield* runPostmortemSmoke(cases).pipe(
        Effect.provide(
          source((input) =>
            input.case.id === second
              ? new PostmortemSmokeError({ caseId: second, message: "PostmortemUnavailable" })
              : "An unrelated network partition.",
          ),
        ),
      )
      assert.deepStrictEqual(
        rows.map((r) => [r.rootCause, r.investigationStatus]),
        [
          ["miss", "completed"],
          ["error", "error"],
        ],
      )
      const report = reportPostmortemSmoke(rows)
      assert.isFalse(report.pass)
      assert.include(report.lines, `  ${second} failed: PostmortemUnavailable`)
      assert.strictEqual(report.lines.at(-1), "postmortem smoke: fail")
    }).pipe(Effect.provide(Judge.layerKeyword)),
  )

  it("an empty run does not pass, and the estimate covers investigation, draft and judge", () => {
    assert.isFalse(reportPostmortemSmoke([]).pass)
    assert.closeTo(estimatePostmortemSmokeUsd(3), 3 * (0.3 + 0.05 + 0.05), 1e-9)
  })
})
