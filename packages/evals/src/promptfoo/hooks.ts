import { Config, DateTime, Effect } from "effect"
import { BudgetGuard, EvalMode, estimateUsd } from "../budget/Budget.ts"
import { EvalSettings, runtime } from "./runtime.ts"

/**
 * promptfoo extension hooks (`extensions: [file://src/promptfoo/hooks.ts:beforeAll, ...:afterAll]`).
 * `beforeAll` reserves the estimated cost and aborts the run when the budget rules forbid it, so the guard
 * also applies when someone runs `promptfoo eval` directly. `afterAll` replaces the estimate with what the run cost (see `settledCost`).
 */
interface SuiteContext {
  readonly suite: { readonly tests?: ReadonlyArray<unknown> }
}

export interface ResultLike {
  readonly cost?: number
  readonly gradingResult?: {
    readonly componentResults?: ReadonlyArray<{ readonly metadata?: { readonly judgeCostUsd?: unknown } }>
  } | null
}

let reservation: string | undefined

export const beforeAll = (context: SuiteContext): Promise<void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const mode = yield* Config.Literals(EvalMode.literals, "EVAL_MODE").pipe(Config.withDefault("smoke" as const))
      const settings = yield* EvalSettings
      const estimate = estimateUsd({ cases: context.suite.tests?.length ?? 0, ...settings })
      const label = `${mode}:${DateTime.formatIso(yield* DateTime.now)}`
      yield* (yield* BudgetGuard).reserve(mode, estimate, label)
      reservation = estimate > 0 ? label : undefined
      yield* Effect.logInfo(
        `budget: ${mode} run estimated at $${estimate.toFixed(2)} (agent=${settings.agent}, judge=${settings.judge})`,
      )
    }),
  )

/**
 * What a finished run cost. Judge cost is measured by the `rootCause` assertion. Investigation cost is measured only
 * when the provider reports it; the api agent does not yet (M2), so its share of the estimate is kept rather than
 * settling a paid run at $0.
 */
export const settledCost = (results: ReadonlyArray<ResultLike>, agent: "stub" | "api"): number => {
  const judge = results.reduce(
    (sum, result) =>
      sum +
      (result.gradingResult?.componentResults ?? []).reduce((acc, component) => {
        const cost = component.metadata?.judgeCostUsd
        return acc + (typeof cost === "number" ? cost : 0)
      }, 0),
    0,
  )
  const provider = results.reduce((sum, result) => sum + (result.cost ?? 0), 0)
  const investigation = provider > 0 ? provider : estimateUsd({ cases: results.length, agent, judge: "keyword" })
  return judge + investigation
}

export const afterAll = (context: { readonly results: ReadonlyArray<ResultLike> }): Promise<void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      if (reservation === undefined) return
      const { agent } = yield* EvalSettings
      const cost = settledCost(context.results, agent)
      yield* (yield* BudgetGuard).settle(reservation, cost)
      yield* Effect.logInfo(`budget: run cost $${cost.toFixed(2)}`)
    }),
  )
