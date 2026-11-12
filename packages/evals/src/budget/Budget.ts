import { Config, Context, DateTime, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"

/**
 * Budget rules from the design doc: $500/month for the whole API key, of which full evaluations get 8 runs
 * (~$25 each) and PR smoke evaluations 50 runs (~$3 each). Above 80% of the month's budget only smoke runs.
 */
export const BudgetPolicy = {
  monthlyUsd: 500,
  smokeOnlyAbove: 0.8,
  maxRuns: { smoke: 50, full: 8 },
  /** Per-case estimates: one Opus 5.5 investigation (≤ $0.30 SLO) plus one judge call. */
  perCaseUsd: { investigation: 0.3, judge: 0.05 },
} as const

export const EvalMode = Schema.Literals(["smoke", "full"])
export type EvalMode = typeof EvalMode.Type

export class LedgerEntry extends Schema.Class<LedgerEntry>("@incident/evals/LedgerEntry")({
  at: Schema.DateTimeUtcFromString,
  mode: EvalMode,
  /** Estimated before the run; replaced by the measured cost when the run reports it. */
  usd: Schema.Number,
  measured: Schema.Boolean,
  label: Schema.String,
}) {}

export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("BudgetExceeded", {
  mode: EvalMode,
  reason: Schema.String,
  spentUsd: Schema.Number,
  estimateUsd: Schema.Number,
}) {}

export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface Estimate {
  readonly cases: number
  readonly agent: "stub" | "api"
  readonly judge: "keyword" | "claude"
}

export const estimateUsd = ({ cases, agent, judge }: Estimate): number =>
  cases *
  ((agent === "api" ? BudgetPolicy.perCaseUsd.investigation : 0) +
    (judge === "claude" ? BudgetPolicy.perCaseUsd.judge : 0))

export interface MonthState {
  readonly spentUsd: number
  readonly runs: { readonly smoke: number; readonly full: number }
}

export type BudgetDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string }

/** Pure decision so every rule is unit-tested. Free runs (stub agent, keyword judge) are always allowed. */
export const decide = (mode: EvalMode, estimate: number, month: MonthState): BudgetDecision => {
  if (estimate === 0) return { allow: true }
  const { monthlyUsd, smokeOnlyAbove, maxRuns } = BudgetPolicy
  const after = month.spentUsd + estimate
  if (after > monthlyUsd) {
    return { allow: false, reason: `would reach $${after.toFixed(2)} of the $${monthlyUsd} monthly budget` }
  }
  if (mode === "full" && after > monthlyUsd * smokeOnlyAbove) {
    return {
      allow: false,
      reason: `would pass ${smokeOnlyAbove * 100}% of the monthly budget ($${after.toFixed(2)}); only smoke runs are allowed`,
    }
  }
  if (month.runs[mode] >= maxRuns[mode]) {
    return { allow: false, reason: `${mode} runs this month: ${month.runs[mode]}/${maxRuns[mode]}` }
  }
  return { allow: true }
}

/**
 * Month-to-date spend. The local ledger only sees evaluation runs, so `EVAL_MONTH_SPEND_USD` (for example the
 * organisation's cost report, set in CI) is added as a floor: the guard uses whichever is higher.
 */
export class BudgetGuard extends Context.Service<
  BudgetGuard,
  {
    readonly month: Effect.Effect<MonthState, LedgerError>
    /** Checks the budget and, when allowed, records the estimate before any money is spent. */
    reserve(mode: EvalMode, estimate: number, label: string): Effect.Effect<void, BudgetExceeded | LedgerError>
    /** Records what a run actually cost, replacing its estimate. */
    settle(label: string, measuredUsd: number): Effect.Effect<void, LedgerError>
  }
>()("@incident/evals/budget/BudgetGuard") {
  static readonly layer = Layer.effect(
    BudgetGuard,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* Config.String("EVAL_LEDGER_DIR").pipe(Config.withDefault(".ledger"))
      const externalSpend = yield* Config.Number("EVAL_MONTH_SPEND_USD").pipe(Config.option)

      const ledgerFile = Effect.map(DateTime.now, (now) =>
        path.join(dir, `${DateTime.formatIso(now).slice(0, 7)}.jsonl`),
      )
      const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerEntry))
      const encodeLine = Schema.encodeEffect(Schema.fromJsonString(LedgerEntry))
      const wrap = (message: string) => (cause: unknown) => new LedgerError({ message, cause })

      const read = Effect.gen(function* () {
        const file = yield* ledgerFile
        if (!(yield* fs.exists(file).pipe(Effect.mapError(wrap("cannot stat ledger"))))) return []
        const text = yield* fs.readFileString(file).pipe(Effect.mapError(wrap("cannot read ledger")))
        const lines = text.split("\n").filter((line) => line.trim() !== "")
        return yield* Effect.forEach(lines, (line) => decodeLine(line).pipe(Effect.mapError(wrap("bad ledger line"))))
      })

      const append = (entry: LedgerEntry) =>
        Effect.gen(function* () {
          const file = yield* ledgerFile
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(wrap("cannot create ledger dir")))
          const line = yield* encodeLine(entry).pipe(Effect.mapError(wrap("cannot encode ledger entry")))
          yield* fs.writeFileString(file, `${line}\n`, { flag: "a" }).pipe(Effect.mapError(wrap("cannot write ledger")))
        })

      const month = Effect.map(read, (entries): MonthState => {
        // A settled run appears twice (estimate, then measurement): the last entry per label is its cost, and the
        // first (the reservation) counts the run, so settling a run at $0 never un-counts it.
        const latest = new Map(entries.map((e) => [e.label, e]))
        const reserved = new Map<string, LedgerEntry>()
        for (const e of entries) if (!reserved.has(e.label)) reserved.set(e.label, e)
        const ledgerSpend = [...latest.values()].reduce((sum, e) => sum + e.usd, 0)
        const count = (mode: EvalMode) => [...reserved.values()].filter((e) => e.mode === mode && e.usd > 0).length
        return {
          spentUsd: Math.max(
            ledgerSpend,
            Option.getOrElse(externalSpend, () => 0),
          ),
          runs: { smoke: count("smoke"), full: count("full") },
        }
      })

      const reserve = Effect.fn("BudgetGuard.reserve")(function* (mode: EvalMode, estimate: number, label: string) {
        const state = yield* month
        const decision = decide(mode, estimate, state)
        if (!decision.allow) {
          return yield* new BudgetExceeded({
            mode,
            reason: decision.reason,
            spentUsd: state.spentUsd,
            estimateUsd: estimate,
          })
        }
        if (estimate > 0) {
          yield* append(new LedgerEntry({ at: yield* DateTime.now, mode, usd: estimate, measured: false, label }))
        }
      })

      const settle = Effect.fn("BudgetGuard.settle")(function* (label: string, measuredUsd: number) {
        const previous = (yield* read).findLast((e) => e.label === label)
        if (previous === undefined) return
        yield* append(
          new LedgerEntry({ at: yield* DateTime.now, mode: previous.mode, usd: measuredUsd, measured: true, label }),
        )
      })

      return BudgetGuard.of({ month, reserve, settle })
    }),
  )
}
