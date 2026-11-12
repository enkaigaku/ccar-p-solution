/**
 * Runs the Postgres store against a real database. Skipped unless RAG_TEST_DATABASE_URL is set, for example
 *   RAG_TEST_DATABASE_URL=postgres://incident:incident@localhost:5432/incident pnpm --filter @incident/rag test
 * Each run creates a throwaway database (the user needs CREATEDB) and drops it afterwards.
 * Uses the offline hashing embedder, so no Voyage key is needed.
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, layer } from "@effect/vitest"
import { Ingestor, RetrievalQuery, Retriever, SourceDocument } from "@incident/contracts"
import { Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import {
  ChunkStore,
  decodeRetrievalSet,
  evaluateRetrieval,
  HashingEmbedderLayer,
  IdentityRerankerLayer,
  IngestorFromServices,
  loadCorpus,
  PgChunkStoreLayer,
  RagIndex,
  RagIndexFromServices,
  RetrieverFromServices,
} from "../src/index.ts"

const url = process.env.RAG_TEST_DATABASE_URL
const database = `rag_test_${randomUUID().replaceAll("-", "")}`

/** Creates the test database before the client connects to it, and drops it when the layer closes. */
const DatabaseLive = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE DATABASE "${database}"`)
    }),
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      }).pipe(Effect.orDie),
  ),
).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url ?? "") })))

const PgLive = Layer.unwrap(
  Effect.sync(() => {
    const target = new URL(url ?? "postgres://localhost")
    target.pathname = `/${database}`
    return PgClient.layer({ url: Redacted.make(target.toString()) })
  }),
).pipe(Layer.provide(DatabaseLive))

const RagTestLive = Layer.mergeAll(RetrieverFromServices, IngestorFromServices(), RagIndexFromServices()).pipe(
  Layer.provideMerge(Layer.mergeAll(PgChunkStoreLayer, HashingEmbedderLayer, IdentityRerankerLayer)),
  Layer.provide(PgLive),
)

const doc = (sourceId: string, markdown: string, service?: string) =>
  new SourceDocument({ sourceId, corpus: "runbook", markdown, ...(service === undefined ? {} : { service }) })

describe.skipIf(url === undefined)("PgChunkStore (live Postgres)", () => {
  layer(RagTestLive, { timeout: "60 seconds" })((it) => {
    it.effect("ingests, reuses embeddings and searches with filters", () =>
      Effect.gen(function* () {
        const ingestor = yield* Ingestor
        const retriever = yield* Retriever
        const store = yield* ChunkStore
        const first = yield* ingestor.ingest([
          doc("runbooks/cart.md", "# cart\n\n## Errors\n\nValkey connection refused.", "cart"),
          doc("runbooks/general.md", "# general\n\n## Errors\n\nCheck recent flag changes."),
          doc(
            "runbooks/pay.md",
            "---\nservice: payment\nalerts: HighErrorRate\n---\n# pay\n\n## Errors\n\nCharge failures.",
          ),
        ])
        assert.strictEqual(first.chunksWritten, 3)

        const second = yield* ingestor.ingest([
          doc(
            "runbooks/cart.md",
            "# cart\n\n## Errors\n\nValkey connection refused.\n\n## Ready\n\nProbe fails.",
            "cart",
          ),
        ])
        assert.deepStrictEqual([second.chunksWritten, second.chunksSkipped], [1, 1])
        const active = Option.getOrThrow(yield* store.activeVersion)
        assert.strictEqual(active.version, second.indexVersion)
        assert.strictEqual(active.chunkCount, 4)

        const cartOnly = yield* retriever.search(new RetrievalQuery({ text: "errors", service: "cart" }))
        assert.isTrue(cartOnly.every((c) => c.service === undefined || c.service === "cart"))
        assert.isTrue(cartOnly.some((c) => c.sourceId === "runbooks/general.md"))

        // Alert names from front matter are searchable through the tsvector.
        const byAlert = yield* retriever.search(new RetrievalQuery({ text: "HighErrorRate" }))
        assert.strictEqual(byAlert[0]?.sourceId, "runbooks/pay.md")
        assert.strictEqual(byAlert[0]?.service, "payment")
        assert.strictEqual(byAlert[0]?.indexVersion, second.indexVersion)
      }),
    )

    it.effect("refuses a stale candidate and allows rollback", () =>
      Effect.gen(function* () {
        const index = yield* RagIndex
        const ingestor = yield* Ingestor
        const before = Option.getOrThrow(yield* index.activeVersion)
        const candidate = yield* index.rebuild([doc("runbooks/only.md", "# only\n\n## A\n\ntext")])
        yield* ingestor.ingest([doc("runbooks/new.md", "# new\n\n## A\n\nnewer")])
        const error = yield* Effect.flip(index.activate(candidate.indexVersion))
        assert.include(error.message, "rebuild instead")
        yield* index.activate(before.version)
        assert.strictEqual(Option.getOrThrow(yield* index.activeVersion).version, before.version)
      }),
    )

    it.effect("concurrent ingests retry on a moved base and never lose each other's sources", () =>
      Effect.gen(function* () {
        const ingestor = yield* Ingestor
        const retriever = yield* Retriever
        yield* Effect.all(
          [1, 2, 3].map((i) => ingestor.ingest([doc(`runbooks/c${i}.md`, `# c${i}\n\n## A\n\nconcurrent marker${i}`)])),
          { concurrency: "unbounded" },
        )
        for (const i of [1, 2, 3]) {
          const hits = yield* retriever.search(new RetrievalQuery({ text: `marker${i}` }))
          assert.strictEqual(hits[0]?.sourceId, `runbooks/c${i}.md`)
        }
      }),
    )

    it.effect("the seed retrieval set passes the gate through the SQL path", () =>
      Effect.gen(function* () {
        const index = yield* RagIndex
        const set = yield* decodeRetrievalSet(
          yield* Effect.promise(() => readFile(new URL("../eval/retrieval-seed.json", import.meta.url), "utf8")),
        )
        const report = yield* index.rebuild(yield* loadCorpus(new URL("../corpus", import.meta.url).pathname))
        const metrics = yield* evaluateRetrieval(set.cases, (q) => index.searchIn(report.indexVersion, q))
        assert.isAtLeast(metrics.recallAtK, 0.85)
        const pruned = yield* index.prune(0)
        assert.isAbove(pruned.length, 0)
      }),
    )
  })
})
