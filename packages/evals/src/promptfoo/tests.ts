import { Config, Effect } from "effect"
import { Datasets } from "../dataset/Datasets.ts"
import type { EvalCase } from "../dataset/EvalCase.ts"
import { runtime } from "./runtime.ts"

/** Design doc: each PR runs the retrieval set plus 10 smoke cases. */
export const SmokeCaseLimit = 10

export interface TestCase {
  readonly description: string
  readonly vars: { readonly caseId: string }
  readonly metadata: Record<string, string | boolean>
}

const toTest = (c: EvalCase): TestCase => ({
  // Descriptions appear in reports only, never in what the agent sees, so they may name the attack and tags.
  description: `${c.id} ${c.kind}${c.kind === "adversarial" ? `/${c.attack}` : ""} [${c.tags.join(", ")}]`,
  vars: { caseId: c.id },
  metadata: { kind: c.kind, smoke: c.smoke, synthetic: c.synthetic },
})

export const selectCases = (mode: "smoke" | "full") =>
  Effect.gen(function* () {
    const includeSynthetic = yield* Config.Boolean("EVAL_INCLUDE_SYNTHETIC").pipe(Config.withDefault(false))
    const cases = (yield* (yield* Datasets).cases).filter((c) => includeSynthetic || !c.synthetic)
    return mode === "smoke" ? cases.filter((c) => c.smoke).slice(0, SmokeCaseLimit) : cases
  })

/** `tests: file://src/promptfoo/tests.ts:smoke` */
export const smoke = (): Promise<ReadonlyArray<TestCase>> =>
  runtime.runPromise(Effect.map(selectCases("smoke"), (cases) => cases.map(toTest)))

/** `tests: file://src/promptfoo/tests.ts:full` */
export const full = (): Promise<ReadonlyArray<TestCase>> =>
  runtime.runPromise(Effect.map(selectCases("full"), (cases) => cases.map(toTest)))
