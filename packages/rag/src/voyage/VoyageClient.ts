import { Cause, Config, Duration, Effect, flow, Layer, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Embedder, ModelProviderError, Reranker } from "./Models.ts"

/** The pgvector column is `vector(1024)`, so the embedding dimension is fixed for the schema. */
export const EMBEDDING_DIMENSIONS = 1024

export interface VoyageConfig {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl: string
  readonly embeddingModel: string
  readonly rerankModel: string
  readonly timeout: Duration.Input
}

/** Reads `VOYAGE_API_KEY` and optional overrides from the environment. */
export const VoyageConfigFromEnv = Config.all({
  apiKey: Config.Redacted("VOYAGE_API_KEY"),
  baseUrl: Config.String("VOYAGE_BASE_URL").pipe(Config.withDefault("https://api.voyageai.com/v1")),
  embeddingModel: Config.String("RAG_EMBEDDING_MODEL").pipe(Config.withDefault("voyage-4")),
  rerankModel: Config.String("RAG_RERANK_MODEL").pipe(Config.withDefault("rerank-2.5")),
  timeout: Config.Duration("VOYAGE_TIMEOUT").pipe(Config.withDefault(Duration.seconds(20))),
})

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ embedding: Schema.Array(Schema.Finite), index: Schema.Int })),
})

const RerankResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Int, relevance_score: Schema.Finite })),
})

/** Voyage accepts up to 1000 inputs per embeddings request; smaller batches keep each request well under its token cap. */
const EMBED_BATCH_SIZE = 64

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500

/** Maps every failure of one call to a classified error. The API key never appears in the message. */
const classify =
  (operation: "embed" | "rerank") =>
  (error: unknown): ModelProviderError => {
    if (Cause.isTimeoutError(error)) {
      return new ModelProviderError({ operation, message: "request timed out", retryable: true })
    }
    if (HttpClientError.isHttpClientError(error)) {
      const reason = error.reason
      switch (reason._tag) {
        case "StatusCodeError":
          return new ModelProviderError({
            operation,
            message: `Voyage returned HTTP ${reason.response.status}`,
            status: reason.response.status,
            retryable: isRetryableStatus(reason.response.status),
          })
        case "TransportError":
          return new ModelProviderError({ operation, message: "transport failure", retryable: true, cause: error })
        default:
          return new ModelProviderError({ operation, message: reason._tag, retryable: false, cause: error })
      }
    }
    if (Schema.isSchemaError(error)) {
      return new ModelProviderError({
        operation,
        message: `unexpected response shape: ${error.message}`,
        retryable: false,
      })
    }
    return new ModelProviderError({ operation, message: "unexpected failure", retryable: false, cause: error })
  }

const retryPolicy = {
  schedule: Schedule.exponential("250 millis").pipe(Schedule.jittered),
  times: 3,
  while: (error: ModelProviderError) => error.retryable,
}

/** Builds Voyage-backed `Embedder` and `Reranker` from an explicit config. Requires an `HttpClient`. */
export const makeVoyage = Effect.fnUntraced(function* (config: VoyageConfig) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl(config.baseUrl),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
      ),
    ),
    HttpClient.filterStatusOk,
  )

  const post = <S extends Schema.Top>(
    operation: "embed" | "rerank",
    path: string,
    body: Record<string, unknown>,
    response: S,
  ) =>
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(client.execute),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(response)),
      Effect.timeout(config.timeout),
      Effect.mapError(classify(operation)),
      Effect.retry(retryPolicy),
    )

  const embedBatch = (texts: ReadonlyArray<string>, inputType: "document" | "query") =>
    post(
      "embed",
      "/embeddings",
      {
        model: config.embeddingModel,
        input: texts,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSIONS,
      },
      EmbeddingResponse,
    ).pipe(
      Effect.flatMap((res) => {
        const ordered = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
        const bad = ordered.length !== texts.length || ordered.some((v) => v.length !== EMBEDDING_DIMENSIONS)
        return bad
          ? Effect.fail(
              new ModelProviderError({
                operation: "embed",
                message: `expected ${texts.length} vectors of ${EMBEDDING_DIMENSIONS} dimensions`,
                retryable: false,
              }),
            )
          : Effect.succeed(ordered)
      }),
    )

  const embedder = Embedder.of({
    model: config.embeddingModel,
    dimensions: EMBEDDING_DIMENSIONS,
    embed: Effect.fn("Voyage.embed")(function* (texts, inputType) {
      yield* Effect.annotateCurrentSpan({ "rag.embed.model": config.embeddingModel, "rag.embed.inputs": texts.length })
      const batches: Array<ReadonlyArray<string>> = []
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) batches.push(texts.slice(i, i + EMBED_BATCH_SIZE))
      const results = yield* Effect.forEach(batches, (batch) => embedBatch(batch, inputType), { concurrency: 2 })
      return results.flat()
    }),
  })

  const reranker = Reranker.of({
    model: config.rerankModel,
    rerank: Effect.fn("Voyage.rerank")(function* (query, documents, topK) {
      yield* Effect.annotateCurrentSpan({
        "rag.rerank.model": config.rerankModel,
        "rag.rerank.documents": documents.length,
      })
      if (documents.length === 0) return []
      const res = yield* post(
        "rerank",
        "/rerank",
        { model: config.rerankModel, query, documents, top_k: Math.min(topK, documents.length), truncation: true },
        RerankResponse,
      )
      const results = res.data
        .filter((d) => d.index >= 0 && d.index < documents.length)
        .map((d) => ({ index: d.index, score: d.relevance_score }))
        .sort((a, b) => b.score - a.score)
      return results
    }),
  })

  return { embedder, reranker }
})

/** `Embedder` + `Reranker` backed by Voyage, configured from the environment. Requires an `HttpClient`. */
export const VoyageLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* VoyageConfigFromEnv
    const { embedder, reranker } = yield* makeVoyage(config)
    return Layer.mergeAll(Layer.succeed(Embedder, embedder), Layer.succeed(Reranker, reranker))
  }),
)
