import { Corpus } from "@incident/contracts"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { Migrator, SqlClient, type SqlError, type Statement } from "effect/sql"
import type { PreparedChunk } from "../chunking/Chunker.ts"
import { toTsQueryText } from "../text.ts"
import { EMBEDDING_DIMENSIONS } from "../voyage/VoyageClient.ts"
import {
  ChunkStore,
  type ChunkWrite,
  type IndexVersionInfo,
  type SearchFilter,
  StaleBaseVersionError,
  StoreError,
} from "./ChunkStore.ts"

/** Migrations owned by this package, tracked in their own table so they never collide with other packages. */
export const ragMigrations = {
  "0001_rag_index": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE EXTENSION IF NOT EXISTS vector`
    yield* sql`
      CREATE TABLE rag_index_versions (
        version text PRIMARY KEY,
        base_version text,
        status text NOT NULL CHECK (status IN ('ready', 'active', 'retired')),
        embedding_model text NOT NULL,
        text_search_config text NOT NULL,
        chunker jsonb NOT NULL,
        chunk_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        activated_at timestamptz
      )`
    yield* sql`CREATE UNIQUE INDEX rag_index_versions_one_active ON rag_index_versions (status) WHERE status = 'active'`
    yield* sql.unsafe(`
      CREATE TABLE rag_chunks (
        index_version text NOT NULL REFERENCES rag_index_versions (version) ON DELETE CASCADE,
        chunk_id text NOT NULL,
        corpus text NOT NULL,
        source_id text NOT NULL,
        heading_path text[] NOT NULL,
        service text,
        alerts text[] NOT NULL,
        text text NOT NULL,
        content_hash text NOT NULL,
        embedding vector(${EMBEDDING_DIMENSIONS}) NOT NULL,
        tsv tsvector NOT NULL,
        PRIMARY KEY (index_version, chunk_id)
      )`)
    yield* sql`CREATE INDEX rag_chunks_embedding_hnsw ON rag_chunks USING hnsw (embedding vector_cosine_ops)`
    yield* sql`CREATE INDEX rag_chunks_tsv ON rag_chunks USING gin (tsv)`
    yield* sql`CREATE INDEX rag_chunks_version_hash ON rag_chunks (index_version, content_hash)`
    yield* sql`CREATE INDEX rag_chunks_version_source ON rag_chunks (index_version, source_id)`
  }),
}

const runMigrations = Migrator.make({})({
  loader: Migrator.fromRecord(ragMigrations),
  table: "rag_migrations",
})

const VersionRow = Schema.Struct({
  version: Schema.String,
  base_version: Schema.NullOr(Schema.String),
  status: Schema.Literals(["ready", "active", "retired"]),
  embedding_model: Schema.String,
  text_search_config: Schema.String,
  chunker: Schema.Unknown,
  chunk_count: Schema.Int,
  created_ms: Schema.Finite,
  activated_ms: Schema.NullOr(Schema.Finite),
})

const ChunkRow = Schema.Struct({
  chunk_id: Schema.String,
  corpus: Corpus,
  source_id: Schema.String,
  heading_path: Schema.Array(Schema.String),
  service: Schema.NullOr(Schema.String),
  text: Schema.String,
  score: Schema.Finite,
})

const decodeVersions = Schema.decodeUnknownEffect(Schema.Array(VersionRow))
const decodeChunks = Schema.decodeUnknownEffect(Schema.Array(ChunkRow))

const toVersionInfo = (row: typeof VersionRow.Type): IndexVersionInfo => ({
  version: row.version,
  baseVersion: row.base_version ?? undefined,
  status: row.status,
  embeddingModel: row.embedding_model,
  textSearchConfig: row.text_search_config,
  chunker: row.chunker,
  chunkCount: row.chunk_count,
  createdAt: DateTime.makeUnsafe(row.created_ms),
  activatedAt: row.activated_ms === null ? undefined : DateTime.makeUnsafe(row.activated_ms),
})

const toScored = (row: typeof ChunkRow.Type) => ({
  chunk: {
    id: row.chunk_id,
    corpus: row.corpus,
    sourceId: row.source_id,
    headingPath: row.heading_path,
    service: row.service ?? undefined,
    text: row.text,
  },
  score: row.score,
})

const storeError = (message: string) => (cause: SqlError.SqlError | Schema.SchemaError) =>
  new StoreError({ message: `${message}: ${cause.message}`, cause })

const vectorLiteral = (embedding: ReadonlyArray<number>) => `[${embedding.join(",")}]`

/** pgvector ≥ 0.8 can keep scanning the HNSW graph until enough rows pass the version/service filter. */
const supportsIterativeScan = (version: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > 0 || minor >= 8
}

const INSERT_BATCH = 200
const HNSW_EF_SEARCH = 200

/**
 * Postgres + pgvector `ChunkStore`. Requires a `SqlClient` connected to Postgres and runs this package's
 * migrations on construction.
 */
export const PgChunkStoreLayer = Layer.effect(
  ChunkStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* runMigrations
    const [ext] = yield* sql<{ extversion: string }>`SELECT extversion FROM pg_extension WHERE extname = 'vector'`
    const iterativeScan = supportsIterativeScan(ext?.extversion ?? "0")

    const lockIndex = sql`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('incident.rag.index'))) l`

    const selectVersions = (where: Statement.Fragment) =>
      sql`
        SELECT version, base_version, status, embedding_model, text_search_config, chunker, chunk_count,
               (extract(epoch FROM created_at) * 1000)::float8 AS created_ms,
               (extract(epoch FROM activated_at) * 1000)::float8 AS activated_ms
        FROM rag_index_versions ${where}
        ORDER BY created_at DESC, version DESC`.pipe(
        Effect.flatMap(decodeVersions),
        Effect.map((rows) => rows.map(toVersionInfo)),
      )

    const getVersion = (version: string) =>
      selectVersions(sql`WHERE version = ${version}`).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(storeError("read index version")),
      )

    const activeVersion = selectVersions(sql.literal("WHERE status = 'active'")).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(storeError("read active index version")),
    )

    const filterSql = (filter: SearchFilter) =>
      sql.and([
        filter.service === undefined ? "TRUE" : sql`(service IS NULL OR service = ${filter.service})`,
        filter.corpora === undefined ? "TRUE" : sql`corpus = ANY(${[...filter.corpora]}::text[])`,
      ])

    const insertChunks = (
      version: string,
      baseVersion: string | undefined,
      textSearchConfig: string,
      writes: ReadonlyArray<ChunkWrite>,
    ) => {
      const columns = (chunks: ReadonlyArray<PreparedChunk>) => ({
        ids: chunks.map((c) => c.id),
        corpora: chunks.map((c) => c.corpus),
        sources: chunks.map((c) => c.sourceId),
        headings: chunks.map((c) => JSON.stringify(c.headingPath)),
        // The driver cannot encode an array whose elements are all null, so absent values travel as ''.
        services: chunks.map((c) => c.service ?? ""),
        alerts: chunks.map((c) => JSON.stringify(c.alerts)),
        texts: chunks.map((c) => c.text),
        hashes: chunks.map((c) => c.contentHash),
      })
      const batches: Array<ReadonlyArray<ChunkWrite>> = []
      for (let i = 0; i < writes.length; i += INSERT_BATCH) batches.push(writes.slice(i, i + INSERT_BATCH))
      return Effect.forEach(
        batches,
        (batch) => {
          const c = columns(batch.map((w) => w.chunk))
          const embeddings = batch.map((w) => (w._tag === "Embedded" ? vectorLiteral(w.embedding) : ""))
          return sql`
            INSERT INTO rag_chunks
              (index_version, chunk_id, corpus, source_id, heading_path, service, alerts, text, content_hash, embedding, tsv)
            SELECT ${version}, u.id, u.corpus, u.source_id, h.path, NULLIF(u.service, ''), a.alerts, u.text, u.hash,
                   COALESCE(
                     NULLIF(u.embedding, '')::vector,
                     (SELECT b.embedding FROM rag_chunks b
                      WHERE b.index_version = ${baseVersion ?? null} AND b.content_hash = u.hash LIMIT 1)
                   ),
                   setweight(to_tsvector(${textSearchConfig}::regconfig, array_to_string(h.path || a.alerts, ' ')), 'A')
                     || setweight(to_tsvector(${textSearchConfig}::regconfig, u.text), 'B')
            FROM unnest(
              ${c.ids}::text[], ${c.corpora}::text[], ${c.sources}::text[], ${c.headings}::text[],
              ${c.services}::text[], ${c.alerts}::text[], ${c.texts}::text[], ${c.hashes}::text[],
              ${embeddings}::text[]
            ) AS u(id, corpus, source_id, heading_path, service, alerts, text, hash, embedding)
            CROSS JOIN LATERAL (SELECT ARRAY(SELECT jsonb_array_elements_text(u.heading_path::jsonb)) AS path) h
            CROSS JOIN LATERAL (SELECT ARRAY(SELECT jsonb_array_elements_text(u.alerts::jsonb)) AS alerts) a`
        },
        { discard: true },
      )
    }

    /** Caller must hold the index lock inside a transaction. */
    const activateLocked = Effect.fnUntraced(function* (version: string, at: DateTime.Utc) {
      const rows = yield* sql<{ version: string; status: string; base_version: string | null; active: string | null }>`
        SELECT version, status, base_version,
               (SELECT a.version FROM rag_index_versions a WHERE a.status = 'active') AS active
        FROM rag_index_versions WHERE version = ${version}`
      const target = rows[0]
      if (target === undefined) return yield* new StoreError({ message: `unknown index version ${version}` })
      if (target.status === "active") return
      if (target.status === "ready" && target.active !== null && target.base_version !== target.active) {
        return yield* new StaleBaseVersionError({
          ...(target.base_version === null ? {} : { expected: target.base_version }),
          actual: target.active,
        })
      }
      yield* sql`UPDATE rag_index_versions SET status = 'retired' WHERE status = 'active'`
      yield* sql`
        UPDATE rag_index_versions
        SET status = 'active', activated_at = to_timestamp(${DateTime.toEpochMillis(at) / 1000})
        WHERE version = ${version}`
    })

    return ChunkStore.of({
      activeVersion,
      listVersions: selectVersions(sql.literal("")).pipe(Effect.mapError(storeError("list index versions"))),
      getVersion,
      existingHashes: (version, hashes) =>
        sql<{ content_hash: string }>`
          SELECT DISTINCT content_hash FROM rag_chunks
          WHERE index_version = ${version} AND content_hash = ANY(${[...hashes]}::text[])`.pipe(
          Effect.map((rows) => new Set(rows.map((r) => r.content_hash))),
          Effect.mapError(storeError("read content hashes")),
        ),

      writeVersion: (spec) =>
        Effect.gen(function* () {
          yield* lockIndex
          const [active] = yield* sql<{ version: string }>`
            SELECT version FROM rag_index_versions WHERE status = 'active'`
          if (active?.version !== spec.baseVersion) {
            return yield* new StaleBaseVersionError({
              ...(spec.baseVersion === undefined ? {} : { expected: spec.baseVersion }),
              ...(active === undefined ? {} : { actual: active.version }),
            })
          }
          yield* sql`
            INSERT INTO rag_index_versions
              (version, base_version, status, embedding_model, text_search_config, chunker, created_at)
            VALUES (
              ${spec.version}, ${spec.baseVersion ?? null}, 'ready', ${spec.embeddingModel}, ${spec.textSearchConfig},
              ${JSON.stringify(spec.chunker)}::jsonb, to_timestamp(${DateTime.toEpochMillis(spec.createdAt) / 1000})
            )`
          yield* insertChunks(spec.version, spec.baseVersion, spec.textSearchConfig, spec.chunks)
          if (spec.mode === "incremental" && spec.baseVersion !== undefined) {
            yield* sql`
              INSERT INTO rag_chunks
                (index_version, chunk_id, corpus, source_id, heading_path, service, alerts, text, content_hash, embedding, tsv)
              SELECT ${spec.version}, chunk_id, corpus, source_id, heading_path, service, alerts, text, content_hash,
                     embedding,
                     setweight(to_tsvector(${spec.textSearchConfig}::regconfig,
                                           array_to_string(heading_path || alerts, ' ')), 'A')
                       || setweight(to_tsvector(${spec.textSearchConfig}::regconfig, text), 'B')
              FROM rag_chunks
              WHERE index_version = ${spec.baseVersion} AND NOT (source_id = ANY(${[...spec.replacedSources]}::text[]))`
          }
          yield* sql`
            UPDATE rag_index_versions
            SET chunk_count = (SELECT count(*) FROM rag_chunks WHERE index_version = ${spec.version})
            WHERE version = ${spec.version}`
          if (spec.activateAt !== undefined) yield* activateLocked(spec.version, spec.activateAt)
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", (e) => Effect.fail(storeError(`write index version ${spec.version}`)(e))),
        ),

      activate: (version, at) =>
        Effect.gen(function* () {
          yield* lockIndex
          yield* activateLocked(version, at)
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", (e) => Effect.fail(storeError(`activate ${version}`)(e))),
        ),

      deleteVersions: (versions) =>
        Effect.gen(function* () {
          yield* lockIndex
          const active = yield* sql<{ version: string }>`
            SELECT version FROM rag_index_versions WHERE status = 'active' AND version = ANY(${[...versions]}::text[])`
          if (active.length > 0) return yield* new StoreError({ message: "cannot delete the active version" })
          yield* sql`DELETE FROM rag_index_versions WHERE version = ANY(${[...versions]}::text[])`
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", (e) => Effect.fail(storeError("delete index versions")(e))),
        ),

      searchVector: ({ version, embedding, filter, limit }) =>
        Effect.gen(function* () {
          // set_config(..., true) is transaction-local, so the settings never leak to other pool users.
          yield* sql`SELECT set_config('hnsw.ef_search', ${String(HNSW_EF_SEARCH)}, true) AS v`
          if (iterativeScan) yield* sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true) AS v`
          const vector = vectorLiteral(embedding)
          const rows = yield* sql`
            SELECT chunk_id, corpus, source_id, heading_path, service, text,
                   -- Cosine distance is NaN when either vector has zero norm; score those as unrelated.
                   COALESCE(NULLIF(1 - (embedding <=> ${vector}::vector), 'NaN'), 0)::float8 AS score
            FROM rag_chunks
            WHERE index_version = ${version} AND ${filterSql(filter)}
            ORDER BY embedding <=> ${vector}::vector, chunk_id
            LIMIT ${limit}`
          return yield* decodeChunks(rows)
        }).pipe(
          sql.withTransaction,
          Effect.map((rows) => rows.map(toScored)),
          Effect.mapError(storeError("vector search")),
        ),

      searchText: ({ version, text, textSearchConfig, filter, limit }) => {
        const query = toTsQueryText(text)
        if (query === undefined) return Effect.succeed([])
        return sql`
          SELECT chunk_id, corpus, source_id, heading_path, service, text, ts_rank_cd(tsv, q)::float8 AS score
          FROM rag_chunks, to_tsquery(${textSearchConfig}::regconfig, ${query}) AS q
          WHERE index_version = ${version} AND tsv @@ q AND ${filterSql(filter)}
          ORDER BY score DESC, chunk_id
          LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeChunks),
          Effect.map((rows) => rows.map(toScored)),
          Effect.mapError(storeError("text search")),
        )
      },
    })
  }),
)
