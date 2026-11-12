import { readFile } from "node:fs/promises"
import { assert, describe, it } from "@effect/vitest"
import { Ingestor, RetrievalQuery, Retriever, SourceDocument } from "@incident/contracts"
import { Effect, Layer, Option } from "effect"
import {
  ChunkStore,
  chunkDocument,
  decodeRetrievalSet,
  Embedder,
  evaluateRetrieval,
  HashingEmbedderLayer,
  IdentityRerankerLayer,
  IngestorFromServices,
  loadCorpus,
  MemoryChunkStoreLayer,
  ModelProviderError,
  RagIndex,
  RagIndexFromServices,
  Reranker,
  RetrieverFromServices,
} from "../src/index.ts"

const corpusDir = new URL("../corpus", import.meta.url).pathname
const seedSet = new URL("../eval/retrieval-seed.json", import.meta.url).pathname

const withModels = (models: Layer.Layer<Embedder | Reranker>) => {
  const services = Layer.mergeAll(MemoryChunkStoreLayer, models)
  return Layer.mergeAll(RetrieverFromServices, IngestorFromServices(), RagIndexFromServices()).pipe(
    Layer.provideMerge(services),
  )
}

const offline = withModels(Layer.mergeAll(HashingEmbedderLayer, IdentityRerankerLayer))

const failingEmbedder = Layer.succeed(
  Embedder,
  Embedder.of({
    model: "hashing-v1",
    dimensions: 1024,
    embed: () => Effect.fail(new ModelProviderError({ operation: "embed", message: "down", retryable: true })),
  }),
)

const failingReranker = Layer.succeed(
  Reranker,
  Reranker.of({
    model: "x",
    rerank: () => Effect.fail(new ModelProviderError({ operation: "rerank", message: "down", retryable: true })),
  }),
)

const doc = (sourceId: string, markdown: string, service?: string) =>
  new SourceDocument({ sourceId, corpus: "runbook", markdown, ...(service === undefined ? {} : { service }) })

const checkout = doc(
  "runbooks/checkout.md",
  "# checkout\n\n## Errors\n\nPayment failing surfaces as checkout 5xx.\n\n## Latency\n\nShipping quote slow.",
  "checkout",
)
const cart = doc("runbooks/cart.md", "# cart\n\n## Errors\n\nValkey connection refused.", "cart")

describe("ingest", () => {
  it.effect("embeds new chunks, skips unchanged ones and carries over other sources", () =>
    Effect.gen(function* () {
      const ingestor = yield* Ingestor
      const store = yield* ChunkStore
      const first = yield* ingestor.ingest([checkout, cart])
      assert.strictEqual(first.chunksWritten, 3)
      assert.strictEqual(first.chunksSkipped, 0)

      const edited = doc(
        "runbooks/checkout.md",
        "# checkout\n\n## Errors\n\nPayment failing surfaces as checkout 5xx.\n\n## Latency\n\nShipping quote is slow for international orders.",
        "checkout",
      )
      const second = yield* ingestor.ingest([edited])
      assert.strictEqual(second.chunksWritten, 1)
      assert.strictEqual(second.chunksSkipped, 1)
      assert.notStrictEqual(second.indexVersion, first.indexVersion)

      const active = yield* store.activeVersion
      assert.strictEqual(Option.getOrUndefined(active)?.version, second.indexVersion)
      // cart was not part of the second ingest but is still in the new version.
      assert.strictEqual(Option.getOrUndefined(active)?.chunkCount, 3)
      assert.strictEqual(Option.getOrUndefined(active)?.baseVersion, first.indexVersion)
    }).pipe(Effect.provide(offline)),
  )

  it.effect("an empty document removes its source", () =>
    Effect.gen(function* () {
      const ingestor = yield* Ingestor
      yield* ingestor.ingest([checkout, cart])
      yield* ingestor.ingest([doc("runbooks/cart.md", "")])
      const results = yield* (yield* Retriever).search(new RetrievalQuery({ text: "valkey connection refused" }))
      assert.isFalse(results.some((c) => c.sourceId === "runbooks/cart.md"))
    }).pipe(Effect.provide(offline)),
  )

  it.effect("rejects a source listed twice", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Ingestor).ingest([cart, cart]))
      assert.strictEqual(error.sourceId, "runbooks/cart.md")
    }).pipe(Effect.provide(offline)),
  )

  it.effect("surfaces embedding failures as IngestError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Ingestor).ingest([cart]))
      assert.strictEqual(error._tag, "IngestError")
      assert.include(error.message, "down")
    }).pipe(Effect.provide(withModels(Layer.mergeAll(failingEmbedder, IdentityRerankerLayer)))),
  )
})

describe("rebuild and activation", () => {
  it.effect("rebuild leaves the candidate inactive until activated, and drops missing sources", () =>
    Effect.gen(function* () {
      const index = yield* RagIndex
      const first = yield* (yield* Ingestor).ingest([checkout, cart])
      const rebuilt = yield* index.rebuild([checkout])
      assert.strictEqual(rebuilt.chunksSkipped, 2, "unchanged chunks reuse embeddings")
      const active = yield* index.activeVersion
      assert.strictEqual(Option.getOrUndefined(active)?.version, first.indexVersion)

      const candidate = yield* index.searchIn(rebuilt.indexVersion, new RetrievalQuery({ text: "valkey" }))
      assert.isFalse(candidate.some((c) => c.sourceId === "runbooks/cart.md"))
      assert.isTrue(candidate.every((c) => c.indexVersion === rebuilt.indexVersion))

      yield* index.activate(rebuilt.indexVersion)
      const now = yield* index.activeVersion
      assert.strictEqual(Option.getOrUndefined(now)?.version, rebuilt.indexVersion)

      // Rollback to the retired version is allowed.
      yield* index.activate(first.indexVersion)
      assert.strictEqual(Option.getOrUndefined(yield* index.activeVersion)?.version, first.indexVersion)
    }).pipe(Effect.provide(offline)),
  )

  it.effect("refuses to activate a candidate built from a version that is no longer active", () =>
    Effect.gen(function* () {
      const index = yield* RagIndex
      const ingestor = yield* Ingestor
      yield* ingestor.ingest([checkout])
      const candidate = yield* index.rebuild([checkout, cart])
      yield* ingestor.ingest([cart]) // a newer ingest moves the active version on
      const error = yield* Effect.flip(index.activate(candidate.indexVersion))
      assert.include(error.message, "rebuild instead")
    }).pipe(Effect.provide(offline)),
  )

  it.effect("prune keeps the active version and the newest inactive ones", () =>
    Effect.gen(function* () {
      const index = yield* RagIndex
      const ingestor = yield* Ingestor
      for (let i = 0; i < 4; i++) yield* ingestor.ingest([doc("runbooks/x.md", `# x\n\n## A\n\nrev ${i}`)])
      const deleted = yield* index.prune(1)
      assert.strictEqual(deleted.length, 2)
      const versions = yield* index.listVersions
      assert.strictEqual(versions.length, 2)
      assert.isTrue(versions.some((v) => v.status === "active"))
    }).pipe(Effect.provide(offline)),
  )
})

describe("search", () => {
  it.effect("fails clearly when nothing has been ingested", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Retriever).search(new RetrievalQuery({ text: "anything" })))
      assert.include(error.message, "no active index")
    }).pipe(Effect.provide(offline)),
  )

  it.effect("filters by service but keeps chunks without a service", () =>
    Effect.gen(function* () {
      yield* (yield* Ingestor).ingest([
        checkout,
        cart,
        doc("runbooks/general.md", "# general\n\n## Errors\n\nCheck flags."),
      ])
      const results = yield* (yield* Retriever).search(new RetrievalQuery({ text: "errors", service: "cart" }))
      assert.isAbove(results.length, 0)
      assert.isTrue(results.every((c) => c.service === undefined || c.service === "cart"))
      assert.isTrue(results.some((c) => c.sourceId === "runbooks/general.md"))
    }).pipe(Effect.provide(offline)),
  )

  it.effect("filters by corpus and honours the limit", () =>
    Effect.gen(function* () {
      yield* (yield* Ingestor).ingest([
        checkout,
        new SourceDocument({
          sourceId: "postmortems/p.md",
          corpus: "postmortem",
          markdown: "# p\n\n## Root cause\n\nPayment flag.\n\n## Mitigation\n\nFlag off.",
        }),
      ])
      const results = yield* (yield* Retriever).search(
        new RetrievalQuery({ text: "payment", corpora: ["postmortem"], limit: 1 }),
      )
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0]?.corpus, "postmortem")
    }).pipe(Effect.provide(offline)),
  )

  it.effect("falls back to full-text search when query embedding fails", () =>
    Effect.gen(function* () {
      yield* (yield* Ingestor).ingest([checkout, cart])
      const results = yield* (yield* Retriever).search(new RetrievalQuery({ text: "valkey connection" }))
      assert.strictEqual(results[0]?.sourceId, "runbooks/cart.md")
    }).pipe(
      // Ingest with a working embedder; search through one that fails. Both share one store.
      Effect.provide(
        Layer.mergeAll(
          IngestorFromServices().pipe(Layer.provide(HashingEmbedderLayer)),
          RetrieverFromServices.pipe(Layer.provide(Layer.mergeAll(failingEmbedder, IdentityRerankerLayer))),
        ).pipe(Layer.provideMerge(MemoryChunkStoreLayer)),
      ),
    ),
  )

  it.effect("falls back to fused order when rerank fails", () =>
    Effect.gen(function* () {
      yield* (yield* Ingestor).ingest([checkout, cart])
      const results = yield* (yield* Retriever).search(new RetrievalQuery({ text: "valkey connection refused" }))
      assert.strictEqual(results[0]?.sourceId, "runbooks/cart.md")
      assert.isBelow(results[0]?.score ?? 1, 0.1, "RRF scores, not rerank scores")
    }).pipe(Effect.provide(withModels(Layer.mergeAll(HashingEmbedderLayer, failingReranker)))),
  )

  it.effect("returns contract chunks stamped with the index version", () =>
    Effect.gen(function* () {
      const report = yield* (yield* Ingestor).ingest([checkout])
      const [top] = yield* (yield* Retriever).search(new RetrievalQuery({ text: "payment 5xx" }))
      assert.strictEqual(top?.id, "runbooks/checkout.md#errors")
      assert.deepStrictEqual(top?.headingPath, ["checkout", "Errors"])
      assert.strictEqual(top?.indexVersion, report.indexVersion)
      assert.strictEqual(top?.service, "checkout")
    }).pipe(Effect.provide(offline)),
  )
})

describe("seed retrieval set (offline models)", () => {
  it.effect("every labelled chunk id exists in the bundled corpus", () =>
    Effect.gen(function* () {
      const set = yield* decodeRetrievalSet(yield* Effect.promise(() => readFile(seedSet, "utf8")))
      const docs = yield* loadCorpus(corpusDir)
      const ids = new Set((yield* Effect.forEach(docs, (d) => chunkDocument(d))).flat().map((c) => c.id))
      const unknown = set.cases.flatMap((c) => c.relevant.filter((id) => !ids.has(id)))
      assert.deepStrictEqual(unknown, [])
      assert.isAtLeast(set.cases.length, 40)
    }),
  )

  it.effect("hashing embedder + BM25 + RRF stays above the regression floor", () =>
    Effect.gen(function* () {
      const set = yield* decodeRetrievalSet(yield* Effect.promise(() => readFile(seedSet, "utf8")))
      const index = yield* RagIndex
      const report = yield* index.rebuild(yield* loadCorpus(corpusDir))
      yield* index.activate(report.indexVersion)
      const metrics = yield* evaluateRetrieval(set.cases, (q) => index.searchIn(report.indexVersion, q))
      // Offline models only measure lexical overlap; the 0.85 G1 target applies to Voyage (scripts/eval.ts).
      assert.isAtLeast(
        metrics.recallAtK,
        0.8,
        JSON.stringify(
          metrics.cases.filter((c) => c.recall < 1),
          null,
          2,
        ),
      )
      assert.isAtLeast(metrics.mrr, 0.6)
    }).pipe(Effect.provide(offline)),
  )
})
