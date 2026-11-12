import { createHash } from "node:crypto"
import { Chunk, ChunkId, RetrievalError, type RetrievalQuery } from "@incident/contracts"
import { Effect, Option } from "effect"
import { ChunkStore, type IndexVersionInfo, type ScoredChunk, type SearchFilter } from "./store/ChunkStore.ts"
import { Embedder, Reranker } from "./voyage/Models.ts"

export const DEFAULT_LIMIT = 8
/** Candidates taken from each retriever before fusion (design doc: vector top 30 + BM25 top 30). */
export const CANDIDATES_PER_RETRIEVER = 30
/** Standard RRF constant from Cormack et al. */
export const RRF_K = 60

export interface FusedCandidate {
  readonly chunk: ScoredChunk["chunk"]
  readonly score: number
}

/**
 * Reciprocal rank fusion: each list contributes 1 / (k + rank) for every chunk it ranks.
 * Ties are broken by chunk id so results are deterministic.
 */
export const reciprocalRankFusion = (
  lists: ReadonlyArray<ReadonlyArray<ScoredChunk>>,
  k = RRF_K,
): Array<FusedCandidate> => {
  const fused = new Map<string, { chunk: ScoredChunk["chunk"]; score: number }>()
  for (const list of lists) {
    list.forEach((item, i) => {
      const entry = fused.get(item.chunk.id) ?? { chunk: item.chunk, score: 0 }
      entry.score += 1 / (k + i + 1)
      fused.set(item.chunk.id, entry)
    })
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
}

/** Text sent to the reranker: the heading path gives a short chunk the context of its section. */
export const rerankDocument = (chunk: ScoredChunk["chunk"]) => `${chunk.headingPath.join(" > ")}\n${chunk.text}`

const queryHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

/**
 * Hybrid retrieval against one index version: vector and full-text search in parallel, RRF fusion,
 * then rerank. Embedding or rerank failures degrade (full-text only / fused order) instead of failing,
 * and the span records which path ran. Raw query text never goes into the span, only its hash.
 *
 * With `strict`, any degradation fails with `RetrievalError` instead. Evaluation uses it so that a
 * rate-limited or misconfigured model can never pass the gate on full-text results alone.
 */
export const hybridSearch = Effect.fn("rag.search")(function* (
  version: IndexVersionInfo,
  query: RetrievalQuery,
  options: { readonly strict?: boolean } = {},
) {
  const strict = options.strict === true
  const strictFailure = (reason: string, error?: { readonly message: string }) =>
    new RetrievalError({
      message: `search degraded (${reason})${error === undefined ? "" : `: ${error.message}`}; strict mode refuses partial results`,
      ...(error === undefined ? {} : { cause: error }),
    })
  const store = yield* ChunkStore
  const embedder = yield* Embedder
  const reranker = yield* Reranker
  const limit = query.limit ?? DEFAULT_LIMIT
  const filter: SearchFilter = { service: query.service, corpora: query.corpora }
  const degraded: Array<string> = []

  yield* Effect.annotateCurrentSpan({
    "rag.index_version": version.version,
    "rag.embedding_model": version.embeddingModel,
    "rag.query_hash": queryHash(query.text),
    "rag.limit": limit,
    ...(query.service === undefined ? {} : { "rag.filter.service": query.service }),
    ...(query.corpora === undefined ? {} : { "rag.filter.corpora": query.corpora.join(",") }),
  })

  const queryEmbedding: Option.Option<ReadonlyArray<number>> =
    embedder.model !== version.embeddingModel
      ? strict
        ? yield* strictFailure(`embedding_model_mismatch: index ${version.embeddingModel}, embedder ${embedder.model}`)
        : yield* Effect.logError("query embedder does not match the index; vector search skipped").pipe(
            Effect.annotateLogs({ indexModel: version.embeddingModel, embedderModel: embedder.model }),
            Effect.tap(() => Effect.sync(() => degraded.push("embedding_model_mismatch"))),
            Effect.as(Option.none()),
          )
      : yield* embedder.embed([query.text], "query").pipe(
          Effect.map((vectors) => Option.fromNullishOr(vectors[0])),
          Effect.catchTag("ModelProviderError", (error) =>
            strict
              ? Effect.fail(strictFailure("embedding_unavailable", error))
              : Effect.logWarning("query embedding failed; falling back to full-text search").pipe(
                  Effect.annotateLogs({ error: error.message, retryable: error.retryable }),
                  Effect.tap(() => Effect.sync(() => degraded.push("embedding_unavailable"))),
                  Effect.as(Option.none()),
                ),
          ),
        )

  const [vectorHits, textHits] = yield* Effect.all(
    [
      Option.match(queryEmbedding, {
        onNone: () => Effect.succeed<ReadonlyArray<ScoredChunk>>([]),
        onSome: (embedding) =>
          store.searchVector({ version: version.version, embedding, filter, limit: CANDIDATES_PER_RETRIEVER }),
      }),
      store.searchText({
        version: version.version,
        text: query.text,
        textSearchConfig: version.textSearchConfig,
        filter,
        limit: CANDIDATES_PER_RETRIEVER,
      }),
    ],
    { concurrency: 2 },
  ).pipe(Effect.mapError((error) => new RetrievalError({ message: error.message, cause: error })))

  const fused = reciprocalRankFusion([vectorHits, textHits])
  yield* Effect.annotateCurrentSpan({
    "rag.candidates.vector": vectorHits.length,
    "rag.candidates.text": textHits.length,
    "rag.candidates.fused": fused.length,
  })

  const ranked: ReadonlyArray<FusedCandidate> =
    fused.length === 0
      ? []
      : yield* reranker
          .rerank(
            query.text,
            fused.map((c) => rerankDocument(c.chunk)),
            limit,
          )
          .pipe(
            Effect.map((results) =>
              results.flatMap((r) => {
                const candidate = fused[r.index]
                return candidate === undefined ? [] : [{ chunk: candidate.chunk, score: r.score }]
              }),
            ),
            Effect.catchTag("ModelProviderError", (error) =>
              strict
                ? Effect.fail(strictFailure("rerank_unavailable", error))
                : Effect.logWarning("rerank failed; returning fused order").pipe(
                    Effect.annotateLogs({ error: error.message, retryable: error.retryable }),
                    Effect.tap(() => Effect.sync(() => degraded.push("rerank_unavailable"))),
                    Effect.as(fused.slice(0, limit)),
                  ),
            ),
          )

  yield* Effect.annotateCurrentSpan({
    "rag.results": ranked.length,
    "rag.degraded": degraded.length > 0 ? degraded.join(",") : "none",
    ...(ranked[0] === undefined ? {} : { "rag.top1_score": ranked[0].score }),
  })

  return ranked.map(
    ({ chunk, score }) =>
      new Chunk({
        id: ChunkId.make(chunk.id),
        corpus: chunk.corpus,
        sourceId: chunk.sourceId,
        headingPath: [...chunk.headingPath],
        ...(chunk.service === undefined ? {} : { service: chunk.service }),
        text: chunk.text,
        score,
        indexVersion: version.version,
      }),
  )
})
