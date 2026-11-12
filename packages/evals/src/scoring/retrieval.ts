import { type RetrievalError, Retriever } from "@incident/contracts"
import { Effect } from "effect"
import type { RetrievalCase } from "../dataset/EvalCase.ts"

/** Gate from the design doc: block an index switch when recall@8 drops below this or by more than 5 points. */
export const RecallAt8Threshold = 0.85
export const MaxRecallRegression = 0.05

/** Fraction of relevant ids found in the first `k` results. */
export const recallAtK = (retrieved: ReadonlyArray<string>, relevant: ReadonlyArray<string>, k: number): number => {
  if (relevant.length === 0) return 1
  const top = new Set(retrieved.slice(0, k))
  return relevant.filter((id) => top.has(id)).length / relevant.length
}

/** 1 / rank of the first relevant result, 0 when none is retrieved. */
export const reciprocalRank = (retrieved: ReadonlyArray<string>, relevant: ReadonlyArray<string>): number => {
  const wanted = new Set(relevant)
  const index = retrieved.findIndex((id) => wanted.has(id))
  return index === -1 ? 0 : 1 / (index + 1)
}

export interface RetrievalCaseResult {
  readonly id: string
  readonly retrieved: ReadonlyArray<string>
  readonly recallAt8: number
  readonly reciprocalRank: number
}

export interface RetrievalReport {
  readonly cases: ReadonlyArray<RetrievalCaseResult>
  readonly recallAt8: number
  readonly mrr: number
  readonly indexVersions: ReadonlyArray<string>
}

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** Deterministic retrieval evaluation: no model calls, safe to run on every PR. */
export const evaluateRetrieval = Effect.fn("evals.evaluateRetrieval")(function* (
  cases: ReadonlyArray<RetrievalCase>,
): Effect.fn.Return<RetrievalReport, RetrievalError, Retriever> {
  const retriever = yield* Retriever
  const indexVersions = new Set<string>()
  const results = yield* Effect.forEach(
    cases,
    (c) =>
      retriever.search(c.query).pipe(
        Effect.map((chunks): RetrievalCaseResult => {
          for (const chunk of chunks) indexVersions.add(chunk.indexVersion)
          const retrieved = chunks.map((chunk) => chunk.id as string)
          return {
            id: c.id,
            retrieved,
            recallAt8: recallAtK(retrieved, c.relevant, 8),
            reciprocalRank: reciprocalRank(retrieved, c.relevant),
          }
        }),
      ),
    { concurrency: 4 },
  )
  return {
    cases: results,
    recallAt8: mean(results.map((r) => r.recallAt8)),
    mrr: mean(results.map((r) => r.reciprocalRank)),
    indexVersions: [...indexVersions].sort(),
  }
})

export type RetrievalGate = { readonly pass: true } | { readonly pass: false; readonly reason: string }

/** Whether a candidate index may replace the baseline. */
export const retrievalGate = (candidate: RetrievalReport, baseline?: RetrievalReport): RetrievalGate => {
  if (candidate.recallAt8 < RecallAt8Threshold) {
    return { pass: false, reason: `recall@8 ${candidate.recallAt8.toFixed(3)} < ${RecallAt8Threshold}` }
  }
  if (baseline !== undefined && baseline.recallAt8 - candidate.recallAt8 > MaxRecallRegression) {
    return {
      pass: false,
      reason: `recall@8 fell ${(baseline.recallAt8 - candidate.recallAt8).toFixed(3)} from baseline ${baseline.recallAt8.toFixed(3)}`,
    }
  }
  return { pass: true }
}
