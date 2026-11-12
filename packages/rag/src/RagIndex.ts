import {
  type Chunk,
  IngestError,
  Ingestor,
  IngestReport,
  RetrievalError,
  type RetrievalQuery,
  Retriever,
  type SourceDocument,
} from "@incident/contracts"
import { Context, DateTime, Effect, Layer, Option, Random } from "effect"
import { CHUNKER_ALGORITHM, type ChunkParams, chunkDocument, defaultChunkParams } from "./chunking/Chunker.ts"
import { hybridSearch } from "./HybridSearch.ts"
import { ChunkStore, type ChunkWrite, type IndexVersionInfo } from "./store/ChunkStore.ts"
import { Embedder, type Reranker } from "./voyage/Models.ts"

export interface RagOptions {
  /** Postgres text search configuration for new versions. */
  readonly textSearchConfig: string
  readonly chunkParams: typeof defaultChunkParams
}

export const defaultRagOptions: RagOptions = { textSearchConfig: "english", chunkParams: defaultChunkParams }

/**
 * Index administration beyond the `Ingestor` / `Retriever` contracts: full rebuilds that wait for an
 * evaluation gate before activation, version listing, activation, rollback and pruning.
 * Used by this package's scripts; other packages go through the contracts.
 */
export class RagIndex extends Context.Service<
  RagIndex,
  {
    /** Builds a new version holding exactly `docs` (sources not listed are dropped). It is left `ready`, not active. */
    rebuild(docs: ReadonlyArray<SourceDocument>): Effect.Effect<IngestReport, IngestError>
    readonly activeVersion: Effect.Effect<Option.Option<IndexVersionInfo>, RetrievalError>
    readonly listVersions: Effect.Effect<ReadonlyArray<IndexVersionInfo>, RetrievalError>
    /** Activates a `ready` or `retired` version. Also the rollback path. */
    activate(version: string): Effect.Effect<void, RetrievalError>
    /** Searches a specific version, active or not. Used to evaluate a candidate before activation. */
    searchIn(version: string, query: RetrievalQuery): Effect.Effect<ReadonlyArray<Chunk>, RetrievalError>
    /** Deletes all but the newest `keep` non-active versions. Returns the deleted versions. */
    prune(keep: number): Effect.Effect<ReadonlyArray<string>, RetrievalError>
  }
>()("@incident/rag/RagIndex") {}

const newVersionId = Effect.gen(function* () {
  const now = yield* DateTime.now
  const suffix = yield* Random.nextIntBetween(0, 0xffffff)
  const stamp = DateTime.formatIso(now)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  return { version: `idx-${stamp}-${suffix.toString(16).padStart(6, "0")}`, createdAt: now }
})

const chunkerRecord = (params: Readonly<Record<string, ChunkParams>>) => ({ algorithm: CHUNKER_ALGORITHM, params })

/**
 * Shared ingest path. `incremental` replaces only the given sources on top of the active version;
 * `snapshot` builds a version that holds exactly `docs`. Unchanged chunks reuse the active version's
 * embedding (matched by content hash) instead of calling the embedding API again.
 */
const buildVersion = Effect.fn("rag.ingest")(function* (
  docs: ReadonlyArray<SourceDocument>,
  mode: "incremental" | "snapshot",
  activate: boolean,
  options: RagOptions,
) {
  const store = yield* ChunkStore
  const embedder = yield* Embedder
  const toIngestError =
    (sourceId: string) =>
    (error: { readonly message: string }): IngestError =>
      new IngestError({ sourceId, message: error.message, cause: error })

  const seen = new Set<string>()
  for (const doc of docs) {
    if (seen.has(doc.sourceId)) {
      return yield* new IngestError({ sourceId: doc.sourceId, message: "source listed twice in one ingest" })
    }
    seen.add(doc.sourceId)
  }

  const chunks = (yield* Effect.forEach(docs, (doc) =>
    chunkDocument(doc, options.chunkParams).pipe(Effect.mapError(toIngestError(doc.sourceId))),
  )).flat()

  const active = yield* store.activeVersion.pipe(Effect.mapError(toIngestError("*")))
  const sameModel = Option.exists(active, (v) => v.embeddingModel === embedder.model)
  if (mode === "incremental" && Option.isSome(active) && !sameModel) {
    return yield* new IngestError({
      sourceId: "*",
      message: `active index uses ${active.value.embeddingModel} but the embedder is ${embedder.model}; run a full rebuild`,
    })
  }
  const baseVersion = Option.getOrUndefined(Option.map(active, (v) => v.version))

  const reusable =
    baseVersion !== undefined && sameModel
      ? yield* store
          .existingHashes(
            baseVersion,
            chunks.map((c) => c.contentHash),
          )
          .pipe(Effect.mapError(toIngestError("*")))
      : new Set<string>()

  // Embed each distinct new text once, even if several chunks share it.
  const toEmbed = [
    ...new Map(chunks.filter((c) => !reusable.has(c.contentHash)).map((c) => [c.contentHash, c])).values(),
  ]
  const vectors = yield* embedder
    .embed(
      toEmbed.map((c) => c.embedInput),
      "document",
    )
    .pipe(Effect.mapError(toIngestError("*")))
  const byHash = new Map(toEmbed.map((c, i) => [c.contentHash, vectors[i] ?? []]))

  const writes: Array<ChunkWrite> = chunks.map((chunk) => {
    const embedding = byHash.get(chunk.contentHash)
    return embedding === undefined ? { _tag: "Reused", chunk } : { _tag: "Embedded", chunk, embedding }
  })

  const { version, createdAt } = yield* newVersionId
  yield* store
    .writeVersion({
      version,
      baseVersion,
      embeddingModel: embedder.model,
      textSearchConfig: options.textSearchConfig,
      chunker: chunkerRecord(options.chunkParams),
      createdAt,
      mode,
      replacedSources: docs.map((d) => d.sourceId),
      chunks: writes,
      activateAt: activate ? createdAt : undefined,
    })
    .pipe(Effect.catchTag("StoreError", (error) => Effect.fail(toIngestError("*")(error))))

  const written = writes.filter((w) => w._tag === "Embedded").length
  yield* Effect.annotateCurrentSpan({
    "rag.index_version": version,
    "rag.ingest.mode": mode,
    "rag.ingest.documents": docs.length,
    "rag.ingest.chunks_embedded": written,
    "rag.ingest.chunks_reused": writes.length - written,
  })
  return new IngestReport({ indexVersion: version, chunksWritten: written, chunksSkipped: writes.length - written })
})

const staleIngest = () =>
  Effect.fail(new IngestError({ sourceId: "*", message: "the active index kept changing during ingest; retry later" }))

const toRetrievalError = (error: { readonly message: string }) =>
  new RetrievalError({ message: error.message, cause: error })

const makeRagIndex = (options: RagOptions) =>
  Effect.gen(function* () {
    const store = yield* ChunkStore
    const context = yield* Effect.context<ChunkStore | Embedder | Reranker>()

    const versionInfo = (version: string) =>
      store.getVersion(version).pipe(
        Effect.mapError(toRetrievalError),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new RetrievalError({ message: `unknown index version ${version}` })),
            onSome: Effect.succeed,
          }),
        ),
      )

    return RagIndex.of({
      rebuild: (docs) =>
        buildVersion(docs, "snapshot", false, options).pipe(
          Effect.catchTag("StaleBaseVersionError", staleIngest),
          Effect.provideContext(context),
        ),
      activeVersion: store.activeVersion.pipe(Effect.mapError(toRetrievalError)),
      listVersions: store.listVersions.pipe(Effect.mapError(toRetrievalError)),
      activate: (version) =>
        Effect.gen(function* () {
          yield* versionInfo(version)
          const now = yield* DateTime.now
          yield* store.activate(version, now).pipe(
            Effect.catchTag("StaleBaseVersionError", (e) =>
              Effect.fail(
                new RetrievalError({
                  message: `${version} was built from ${e.expected ?? "an empty index"} but ${e.actual ?? "nothing"} is active now; rebuild instead`,
                }),
              ),
            ),
            Effect.mapError(toRetrievalError),
          )
        }),
      searchIn: (version, query) =>
        versionInfo(version).pipe(
          Effect.flatMap((info) => hybridSearch(info, query)),
          Effect.provideContext(context),
        ),
      prune: (keep) =>
        Effect.gen(function* () {
          const versions = yield* store.listVersions.pipe(Effect.mapError(toRetrievalError))
          const stale = versions
            .filter((v) => v.status !== "active")
            .slice(Math.max(keep, 0))
            .map((v) => v.version)
          if (stale.length > 0) yield* store.deleteVersions(stale).pipe(Effect.mapError(toRetrievalError))
          return stale
        }),
    })
  })

/** `RagIndex` over the internal services. */
export const RagIndexFromServices = (options: RagOptions = defaultRagOptions) =>
  Layer.effect(RagIndex, makeRagIndex(options))

/** `Retriever` over the internal services: searches the active index version. */
export const RetrieverFromServices = Layer.effect(
  Retriever,
  Effect.gen(function* () {
    const store = yield* ChunkStore
    const context = yield* Effect.context<ChunkStore | Embedder | Reranker>()
    return Retriever.of({
      search: (query) =>
        store.activeVersion.pipe(
          Effect.mapError(toRetrievalError),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new RetrievalError({ message: "no active index version; run an ingest first" })),
              onSome: (version) => hybridSearch(version, query),
            }),
          ),
          Effect.provideContext(context),
        ),
    })
  }),
)

/**
 * `Ingestor` over the internal services. Each call upserts the given sources on top of the active
 * version and activates the result, so a reviewed postmortem is searchable right away. Pass a document
 * with empty markdown to remove a source. Full rebuilds go through `RagIndex.rebuild` and the eval gate.
 */
export const IngestorFromServices = (options: RagOptions = defaultRagOptions) =>
  Layer.effect(
    Ingestor,
    Effect.gen(function* () {
      const context = yield* Effect.context<ChunkStore | Embedder>()
      return Ingestor.of({
        ingest: (docs) =>
          buildVersion(docs, "incremental", true, options).pipe(
            // Another ingest activated a version between our read and write: rebuild on top of it.
            Effect.retry({ times: 3, while: (e) => e._tag === "StaleBaseVersionError" }),
            Effect.catchTag("StaleBaseVersionError", staleIngest),
            Effect.provideContext(context),
          ),
      })
    }),
  )
