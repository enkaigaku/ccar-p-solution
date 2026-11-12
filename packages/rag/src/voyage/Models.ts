import { Context, type Effect, Schema } from "effect"

/** Failure from an embedding or rerank provider, already classified for retry. */
export class ModelProviderError extends Schema.TaggedError<ModelProviderError>()("ModelProviderError", {
  operation: Schema.Literals(["embed", "rerank"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  /** True for timeouts, transport failures, 429 and 5xx. */
  retryable: Schema.Boolean,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type EmbedInputType = "document" | "query"

/** Turns text into fixed-size vectors. */
export class Embedder extends Context.Service<
  Embedder,
  {
    /** Identifies the vector space. Stored with each index version; a change requires re-embedding. */
    readonly model: string
    readonly dimensions: number
    embed(
      texts: ReadonlyArray<string>,
      inputType: EmbedInputType,
    ): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, ModelProviderError>
  }
>()("@incident/rag/Embedder") {}

export interface RerankResult {
  /** Position of the document in the input list. */
  readonly index: number
  readonly score: number
}

/** Scores documents against a query with a cross-encoder. Results are sorted by score, best first. */
export class Reranker extends Context.Service<
  Reranker,
  {
    readonly model: string
    rerank(
      query: string,
      documents: ReadonlyArray<string>,
      topK: number,
    ): Effect.Effect<ReadonlyArray<RerankResult>, ModelProviderError>
  }
>()("@incident/rag/Reranker") {}
