import { Config, DateTime, Effect } from "effect"
import { BudgetGuard, EvalMode, estimateUsd } from "../budget/Budget.ts"
import { EvalSettings, runtime } from "./runtime.ts"

/**
 * promptfoo extension hooks (`extensions: [file://src/promptfoo/hooks.ts:beforeAll, ...:afterAll]`).
 * `beforeAll` reserves the estimated cost and aborts the run when the budget rules forbid it, so the guard
 * also applies when someone runs `promptfoo eval` directly. `afterAll` replaces the estimate with the measured cost.
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

/** Provider cost plus the judge cost the `rootCause` assertion records in its metadata. */
export const measuredCost = (results: ReadonlyArray<ResultLike>): number =>
  results.reduce((sum, result) => {
    const judge = (result.gradingResult?.componentResults ?? []).reduce((acc, component) => {
      const cost = component.metadata?.judgeCostUsd
      return acc + (typeof cost === "number" ? cost : 0)
    }, 0)
    return sum + (result.cost ?? 0) + judge
  }, 0)

export const afterAll = (context: { readonly results: ReadonlyArray<ResultLike> }): Promise<void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      if (reservation === undefined) return
      const cost = measuredCost(context.results)
      yield* (yield* BudgetGuard).settle(reservation, cost)
      yield* Effect.logInfo(`budget: run cost $${cost.toFixed(2)}`)
    }),
  )
