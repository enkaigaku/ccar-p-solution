import { Effect, Layer, Option, Ref } from "effect"
import type { PreparedChunk } from "../chunking/Chunker.ts"
import { tokenize } from "../text.ts"
import {
  ChunkStore,
  type IndexVersionInfo,
  type ScoredChunk,
  type SearchFilter,
  StaleBaseVersionError,
  StoreError,
} from "./ChunkStore.ts"

interface Row {
  readonly chunk: PreparedChunk
  readonly embedding: ReadonlyArray<number>
}

interface State {
  readonly versions: ReadonlyMap<string, IndexVersionInfo>
  readonly rows: ReadonlyMap<string, ReadonlyArray<Row>>
}

const matches = (chunk: PreparedChunk, filter: SearchFilter) =>
  (filter.service === undefined || chunk.service === undefined || chunk.service === filter.service) &&
  (filter.corpora === undefined || filter.corpora.includes(chunk.corpus))

const toStored = (chunk: PreparedChunk) => ({
  id: chunk.id,
  corpus: chunk.corpus,
  sourceId: chunk.sourceId,
  headingPath: chunk.headingPath,
  service: chunk.service,
  text: chunk.text,
})

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

const byScoreThenId = (a: ScoredChunk, b: ScoredChunk) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)

/** Okapi BM25 over heading path, alert names and text. Stands in for Postgres full-text search in tests. */
const bm25 = (rows: ReadonlyArray<Row>, query: string): Array<ScoredChunk> => {
  const k1 = 1.2
  const b = 0.75
  const docs = rows.map((row) => tokenize([...row.chunk.headingPath, ...row.chunk.alerts, row.chunk.text].join(" ")))
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1)
  const terms = [...new Set(tokenize(query))]
  const documentFrequency = new Map(terms.map((t) => [t, docs.filter((d) => d.includes(t)).length]))
  const scored: Array<ScoredChunk> = []
  rows.forEach((row, i) => {
    const doc = docs[i] ?? []
    let score = 0
    for (const term of terms) {
      const tf = doc.filter((w) => w === term).length
      if (tf === 0) continue
      const df = documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5))
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLength))
    }
    if (score > 0) scored.push({ chunk: toStored(row.chunk), score })
  })
  return scored.sort(byScoreThenId)
}

/** In-memory `ChunkStore` with the same versioning semantics as the Postgres store. For tests and offline evaluation. */
export const MemoryChunkStoreLayer = Layer.effect(
  ChunkStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ versions: new Map(), rows: new Map() })

    const activeVersion = Ref.get(state).pipe(
      Effect.map((s) => Option.fromNullishOr([...s.versions.values()].find((v) => v.status === "active"))),
    )

    return ChunkStore.of({
      activeVersion,
      listVersions: Ref.get(state).pipe(
        Effect.map((s) => [...s.versions.values()].sort((a, b) => b.version.localeCompare(a.version))),
      ),
      getVersion: (version) => Ref.get(state).pipe(Effect.map((s) => Option.fromNullishOr(s.versions.get(version)))),
      existingHashes: (version, hashes) =>
        Ref.get(state).pipe(
          Effect.map((s) => {
            const have = new Set((s.rows.get(version) ?? []).map((r) => r.chunk.contentHash))
            return new Set(hashes.filter((h) => have.has(h)))
          }),
        ),
      writeVersion: (spec) =>
        Effect.gen(function* () {
          const s = yield* Ref.get(state)
          const active = [...s.versions.values()].find((v) => v.status === "active")?.version
          if (active !== spec.baseVersion) {
            return yield* new StaleBaseVersionError({
              ...(spec.baseVersion === undefined ? {} : { expected: spec.baseVersion }),
              ...(active === undefined ? {} : { actual: active }),
            })
          }
          if (s.versions.has(spec.version)) return yield* new StoreError({ message: `version ${spec.version} exists` })
          const baseRows = spec.baseVersion === undefined ? [] : (s.rows.get(spec.baseVersion) ?? [])
          const byHash = new Map(baseRows.map((r) => [r.chunk.contentHash, r.embedding]))
          const rows: Array<Row> = []
          for (const write of spec.chunks) {
            const embedding = write._tag === "Embedded" ? write.embedding : byHash.get(write.chunk.contentHash)
            if (embedding === undefined) {
              return yield* new StoreError({ message: `no embedding to reuse for ${write.chunk.id}` })
            }
            rows.push({ chunk: write.chunk, embedding })
          }
          if (spec.mode === "incremental") {
            const replaced = new Set(spec.replacedSources)
            rows.push(...baseRows.filter((r) => !replaced.has(r.chunk.sourceId)))
          }
          const ids = new Set(rows.map((r) => r.chunk.id))
          if (ids.size !== rows.length) return yield* new StoreError({ message: "duplicate chunk id in version" })
          const info: IndexVersionInfo = {
            version: spec.version,
            baseVersion: spec.baseVersion,
            status: spec.activateAt === undefined ? "ready" : "active",
            embeddingModel: spec.embeddingModel,
            textSearchConfig: spec.textSearchConfig,
            chunker: spec.chunker,
            chunkCount: rows.length,
            createdAt: spec.createdAt,
            activatedAt: spec.activateAt,
          }
          const previous =
            spec.activateAt === undefined
              ? [...s.versions]
              : [...s.versions].map(([k, v]): [string, IndexVersionInfo] => [
                  k,
                  v.status === "active" ? { ...v, status: "retired" } : v,
                ])
          yield* Ref.set(state, {
            versions: new Map([...previous, [spec.version, info]]),
            rows: new Map([...s.rows, [spec.version, rows]]),
          })
        }),
      activate: (version, at) =>
        Effect.gen(function* () {
          const s = yield* Ref.get(state)
          const target = s.versions.get(version)
          if (target === undefined) return yield* new StoreError({ message: `unknown version ${version}` })
          const active = [...s.versions.values()].find((v) => v.status === "active")?.version
          if (target.status === "ready" && active !== undefined && target.baseVersion !== active) {
            return yield* new StaleBaseVersionError({
              ...(target.baseVersion === undefined ? {} : { expected: target.baseVersion }),
              actual: active,
            })
          }
          const versions = new Map(
            [...s.versions].map(([key, v]): [string, IndexVersionInfo] => {
              if (key === version) return [key, { ...v, status: "active", activatedAt: at }]
              if (v.status === "active") return [key, { ...v, status: "retired" }]
              return [key, v]
            }),
          )
          yield* Ref.set(state, { ...s, versions })
        }),
      deleteVersions: (versions) =>
        Effect.gen(function* () {
          const s = yield* Ref.get(state)
          if (versions.some((v) => s.versions.get(v)?.status === "active")) {
            return yield* new StoreError({ message: "cannot delete the active version" })
          }
          const drop = new Set(versions)
          yield* Ref.set(state, {
            versions: new Map([...s.versions].filter(([k]) => !drop.has(k))),
            rows: new Map([...s.rows].filter(([k]) => !drop.has(k))),
          })
        }),
      searchVector: ({ version, embedding, filter, limit }) =>
        Ref.get(state).pipe(
          Effect.map((s) =>
            (s.rows.get(version) ?? [])
              .filter((r) => matches(r.chunk, filter))
              .map((r) => ({ chunk: toStored(r.chunk), score: cosine(r.embedding, embedding) }))
              .sort(byScoreThenId)
              .slice(0, limit),
          ),
        ),
      searchText: ({ version, text, filter, limit }) =>
        Ref.get(state).pipe(
          Effect.map((s) =>
            bm25(
              (s.rows.get(version) ?? []).filter((r) => matches(r.chunk, filter)),
              text,
            ).slice(0, limit),
          ),
        ),
    })
  }),
)
