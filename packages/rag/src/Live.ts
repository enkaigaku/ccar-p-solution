import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { defaultRagOptions, IngestorFromServices, RagIndexFromServices, RetrieverFromServices } from "./RagIndex.ts"
import { PgChunkStoreLayer } from "./store/PgChunkStore.ts"
import { VoyageLive } from "./voyage/VoyageClient.ts"

const RagOptionsFromEnv = Config.String("RAG_TEXT_SEARCH_CONFIG").pipe(
  Config.withDefault(defaultRagOptions.textSearchConfig),
  Config.map((textSearchConfig) => ({ ...defaultRagOptions, textSearchConfig })),
)

/**
 * Postgres store + Voyage models. Requires a Postgres `SqlClient` (for example `PgClient.layerConfig`
 * from `@effect/sql-pg`), shared with the rest of the app. Reads `VOYAGE_API_KEY` from the environment.
 * Layers are memoized by reference, so the three live layers below share one instance of this.
 */
export const RagServicesLive = Layer.mergeAll(PgChunkStoreLayer, VoyageLive.pipe(Layer.provide(FetchHttpClient.layer)))

/** `Retriever` from `@incident/contracts`, backed by Postgres + pgvector and Voyage. Requires a Postgres `SqlClient`. */
export const RetrieverLive = RetrieverFromServices.pipe(Layer.provide(RagServicesLive))

/** `Ingestor` from `@incident/contracts`, backed by Postgres + pgvector and Voyage. Requires a Postgres `SqlClient`. */
export const IngestorLive = Layer.unwrap(
  Effect.gen(function* () {
    return IngestorFromServices(yield* RagOptionsFromEnv)
  }),
).pipe(Layer.provide(RagServicesLive))

/** Index administration (rebuild, gate, activate, rollback, prune). Requires a Postgres `SqlClient`. */
export const RagIndexLive = Layer.unwrap(
  Effect.gen(function* () {
    return RagIndexFromServices(yield* RagOptionsFromEnv)
  }),
).pipe(Layer.provide(RagServicesLive))
