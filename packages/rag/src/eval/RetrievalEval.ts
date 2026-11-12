import { type Chunk, Corpus, RetrievalQuery } from "@incident/contracts"
import { Effect, Schema } from "effect"

/** One labelled retrieval case: a query and the chunk ids that should come back. */
export const RetrievalCase = Schema.Struct({
  id: Schema.NonEmptyString,
  query: Schema.NonEmptyString,
  service: Schema.optionalKey(Schema.String),
  corpora: Schema.optionalKey(Schema.Array(Corpus)),
  relevant: Schema.NonEmptyArray(Schema.NonEmptyString),
})
export type RetrievalCase = typeof RetrievalCase.Type

export const RetrievalSet = Schema.Struct({
  description: Schema.String,
  cases: Schema.Array(RetrievalCase),
})
export type RetrievalSet = typeof RetrievalSet.Type

export const decodeRetrievalSet = Schema.decodeUnknownEffect(Schema.fromJsonString(RetrievalSet))

export interface CaseResult {
  readonly id: string
  readonly recall: number
  readonly reciprocalRank: number
  readonly retrieved: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
}

export interface RetrievalMetrics {
  readonly k: number
  readonly recallAtK: number
  readonly mrr: number
  readonly cases: ReadonlyArray<CaseResult>
}

/** Fraction of relevant ids found in the first `k` retrieved ids. */
export const recallAtK = (retrieved: ReadonlyArray<string>, relevant: ReadonlyArray<string>, k: number): number => {
  const top = new Set(retrieved.slice(0, k))
  return relevant.length === 0 ? 0 : relevant.filter((id) => top.has(id)).length / relevant.length
}

/** 1 / rank of the first relevant id within the first `k`, or 0 if none appears. */
export const reciprocalRank = (
  retrieved: ReadonlyArray<string>,
  relevant: ReadonlyArray<string>,
  k: number,
): number => {
  const wanted = new Set(relevant)
  const index = retrieved.slice(0, k).findIndex((id) => wanted.has(id))
  return index === -1 ? 0 : 1 / (index + 1)
}

/** Runs every case through `search` and averages recall@k and MRR over cases. */
export const evaluateRetrieval = <E, R>(
  cases: ReadonlyArray<RetrievalCase>,
  search: (query: RetrievalQuery) => Effect.Effect<ReadonlyArray<Chunk>, E, R>,
  k = 8,
): Effect.Effect<RetrievalMetrics, E, R> =>
  Effect.forEach(
    cases,
    (c) =>
      search(
        new RetrievalQuery({
          text: c.query,
          limit: k,
          ...(c.service === undefined ? {} : { service: c.service }),
          ...(c.corpora === undefined ? {} : { corpora: c.corpora }),
        }),
      ).pipe(
        Effect.map((chunks): CaseResult => {
          const retrieved = chunks.map((chunk): string => chunk.id)
          const top = new Set(retrieved.slice(0, k))
          return {
            id: c.id,
            recall: recallAtK(retrieved, c.relevant, k),
            reciprocalRank: reciprocalRank(retrieved, c.relevant, k),
            retrieved,
            missing: c.relevant.filter((id) => !top.has(id)),
          }
        }),
      ),
    { concurrency: 4 },
  ).pipe(
    Effect.map((results) => {
      const mean = (f: (r: CaseResult) => number) =>
        results.length === 0 ? 0 : results.reduce((sum, r) => sum + f(r), 0) / results.length
      return { k, recallAtK: mean((r) => r.recall), mrr: mean((r) => r.reciprocalRank), cases: results }
    }),
  )

export interface GateDecision {
  readonly activate: boolean
  readonly reason: string
}

/**
 * Activation gate from the design doc: block a new index when recall@k drops more than `maxDrop`
 * (absolute, 0.05 = 5 points) below the active index, or falls under the absolute floor.
 */
export const gateDecision = (params: {
  readonly candidate: RetrievalMetrics
  readonly baseline: RetrievalMetrics | undefined
  readonly maxDrop?: number
  readonly minRecall?: number
}): GateDecision => {
  const maxDrop = params.maxDrop ?? 0.05
  const minRecall = params.minRecall ?? 0.85
  const candidate = params.candidate.recallAtK
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  if (candidate < minRecall) {
    return {
      activate: false,
      reason: `recall@${params.candidate.k} ${pct(candidate)} is below the ${pct(minRecall)} floor`,
    }
  }
  if (params.baseline !== undefined && params.baseline.recallAtK - candidate > maxDrop) {
    return {
      activate: false,
      reason: `recall@${params.candidate.k} dropped from ${pct(params.baseline.recallAtK)} to ${pct(candidate)} (more than ${pct(maxDrop)})`,
    }
  }
  return {
    activate: true,
    reason:
      params.baseline === undefined
        ? `recall@${params.candidate.k} ${pct(candidate)}, no active index to compare`
        : `recall@${params.candidate.k} ${pct(params.baseline.recallAtK)} → ${pct(candidate)}`,
  }
}
