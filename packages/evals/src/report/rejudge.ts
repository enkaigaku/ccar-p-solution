import { Effect, Schema } from "effect"
import { decodeRun, findCase, gradeRootCause } from "../evaluate.ts"
import type { Verdict } from "../judge/Judge.ts"

/**
 * The part of a promptfoo `--output` file that grading needs: which case each row ran and what the agent returned.
 * Rows whose provider call failed have no output.
 */
export const PromptfooResults = Schema.Struct({
  results: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        vars: Schema.Struct({ caseId: Schema.String }),
        response: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ output: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  }),
})
export type PromptfooResults = typeof PromptfooResults.Type

export const decodeResults = Schema.decodeUnknownEffect(Schema.fromJsonString(PromptfooResults))

/** One case of a finished run, graded again by the current judge. */
export interface RejudgedRow {
  readonly caseId: string
  /** The agent's status, or "error" when the run left no output. */
  readonly status: string
  readonly fault: string
  readonly distractor: boolean
  /** A case curated from online feedback (ADR 011); summarized apart from the fault and adversarial sets. */
  readonly feedback: boolean
  /** False for cases without a labelled root cause; they stay out of the accuracy figures. */
  readonly graded: boolean
  readonly rank: number | undefined
  readonly verdicts: ReadonlyArray<Verdict>
  readonly latencyMs: number
  readonly agentCostUsd: number
  readonly judgeCostUsd: number
}

export interface Accuracy {
  readonly cases: number
  readonly top1: number
  readonly top3: number
}

export interface RejudgeSummary {
  readonly all: Accuracy
  readonly withDistractor: Accuracy
  readonly withoutDistractor: Accuracy
  /** Feedback cases only. Never part of `all`: the two sets are not comparable. */
  readonly feedback: Accuracy
  readonly statuses: Readonly<Record<string, number>>
  readonly latencyMs: { readonly mean: number; readonly p95: number }
  readonly agentCostUsd: number
  readonly judgeCostUsd: number
  /** Graded cases with no match in the top 3. */
  readonly misses: ReadonlyArray<RejudgedRow>
}

/** Grades the hypotheses a finished run produced with the current judge. The agent is not run again. */
export const rejudge = Effect.fn("evals.rejudge")(function* (results: PromptfooResults) {
  return yield* Effect.forEach(
    results.results.results,
    Effect.fn(function* (row) {
      const c = yield* findCase(row.vars.caseId)
      const truth = c.groundTruth
      const base = {
        caseId: c.id,
        // Feedback cases have no injected flag; they are listed by where they came from.
        fault: truth === undefined ? "" : "fault" in truth ? `${truth.fault.flag}=${truth.fault.variant}` : "feedback",
        distractor: truth !== undefined && "distractors" in truth && (truth.distractors ?? []).length > 0,
        feedback: c.kind === "feedback",
      }
      const output = row.response?.output
      if (output === undefined || output === null) {
        return {
          ...base,
          status: "error",
          graded: truth !== undefined,
          rank: undefined,
          verdicts: [],
          latencyMs: 0,
          agentCostUsd: 0,
          judgeCostUsd: 0,
        } satisfies RejudgedRow
      }
      const run = yield* decodeRun(output)
      const grade = yield* gradeRootCause(c, run)
      return {
        ...base,
        status: run.status,
        graded: grade !== undefined,
        rank: grade?.rank,
        verdicts: grade?.verdicts ?? [],
        latencyMs: run.latencyMs,
        agentCostUsd: run.usage.costUsd,
        judgeCostUsd: grade?.costUsd ?? 0,
      } satisfies RejudgedRow
    }),
    { concurrency: 4 },
  )
})

const accuracy = (rows: ReadonlyArray<RejudgedRow>): Accuracy => ({
  cases: rows.length,
  top1: rows.filter((r) => r.rank === 1).length,
  top3: rows.filter((r) => r.rank !== undefined && r.rank <= 3).length,
})

/** Nearest-rank percentile; 0 for an empty list. */
const percentile = (values: ReadonlyArray<number>, p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0
}

export const summarize = (rows: ReadonlyArray<RejudgedRow>): RejudgeSummary => {
  const labelled = rows.filter((r) => r.graded)
  const graded = labelled.filter((r) => !r.feedback)
  const ran = rows.filter((r) => r.status !== "error")
  const statuses: Record<string, number> = {}
  for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1
  const sum = (pick: (r: RejudgedRow) => number) => rows.reduce((total, r) => total + pick(r), 0)
  return {
    all: accuracy(graded),
    withDistractor: accuracy(graded.filter((r) => r.distractor)),
    withoutDistractor: accuracy(graded.filter((r) => !r.distractor)),
    feedback: accuracy(labelled.filter((r) => r.feedback)),
    statuses,
    latencyMs: {
      mean: ran.length === 0 ? 0 : ran.reduce((total, r) => total + r.latencyMs, 0) / ran.length,
      p95: percentile(
        ran.map((r) => r.latencyMs),
        0.95,
      ),
    },
    agentCostUsd: sum((r) => r.agentCostUsd),
    judgeCostUsd: sum((r) => r.judgeCostUsd),
    misses: labelled.filter((r) => r.rank === undefined || r.rank > 3),
  }
}

const share = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`)
const line = (label: string, a: Accuracy) =>
  `${label}: top-1 ${a.top1}/${a.cases} (${share(a.top1, a.cases)}), top-3 ${a.top3}/${a.cases} (${share(a.top3, a.cases)})`

export const renderSummary = (s: RejudgeSummary): ReadonlyArray<string> => [
  line("all cases", s.all),
  line("without distractor", s.withoutDistractor),
  line("with distractor", s.withDistractor),
  ...(s.feedback.cases === 0 ? [] : [line("feedback cases (not comparable with the above)", s.feedback)]),
  `statuses: ${Object.entries(s.statuses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${status} ${n}`)
    .join(", ")}`,
  `latency: mean ${(s.latencyMs.mean / 1000).toFixed(1)}s, p95 ${(s.latencyMs.p95 / 1000).toFixed(1)}s`,
  `cost: agent $${s.agentCostUsd.toFixed(2)} (as the run reported it), judge $${s.judgeCostUsd.toFixed(2)} (this rejudge)`,
  ...s.misses.map((r) => `  miss ${r.caseId} ${r.fault} [${r.status}] ${r.verdicts.join(", ") || "no hypotheses"}`),
]
