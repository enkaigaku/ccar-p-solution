import type { Corpus } from "@incident/contracts"
import { Context, type DateTime, type Effect, type Option, Schema } from "effect"
import type { PreparedChunk } from "../chunking/Chunker.ts"

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** The active index changed between reading the base version and writing the new one. Safe to retry. */
export class StaleBaseVersionError extends Schema.TaggedError<StaleBaseVersionError>()("StaleBaseVersionError", {
  expected: Schema.optionalKey(Schema.String),
  actual: Schema.optionalKey(Schema.String),
}) {}

export type VersionStatus = "ready" | "active" | "retired"

export interface IndexVersionInfo {
  readonly version: string
  readonly baseVersion: string | undefined
  readonly status: VersionStatus
  readonly embeddingModel: string
  /** Postgres text search configuration used for this version's tsvectors and queries. */
  readonly textSearchConfig: string
  /** Chunker algorithm and parameters, as JSON. */
  readonly chunker: unknown
  readonly chunkCount: number
  readonly createdAt: DateTime.Utc
  readonly activatedAt: DateTime.Utc | undefined
}

/** A chunk for the new version: either freshly embedded, or reusing the base version's embedding for its hash. */
export type ChunkWrite =
  | { readonly _tag: "Embedded"; readonly chunk: PreparedChunk; readonly embedding: ReadonlyArray<number> }
  | { readonly _tag: "Reused"; readonly chunk: PreparedChunk }

export interface NewVersion {
  readonly version: string
  /** Version the reused embeddings and carried-over chunks come from; must still be the active version. */
  readonly baseVersion: string | undefined
  readonly embeddingModel: string
  readonly textSearchConfig: string
  readonly chunker: unknown
  readonly createdAt: DateTime.Utc
  /**
   * `incremental`: chunks of base sources not in `replacedSources` are copied over.
   * `snapshot`: the new version holds exactly `chunks`.
   */
  readonly mode: "incremental" | "snapshot"
  readonly replacedSources: ReadonlyArray<string>
  readonly chunks: ReadonlyArray<ChunkWrite>
  /** When set, the new version becomes active in the same transaction, at this time. */
  readonly activateAt: DateTime.Utc | undefined
}

export interface SearchFilter {
  readonly service: string | undefined
  readonly corpora: ReadonlyArray<Corpus> | undefined
}

export interface StoredChunk {
  readonly id: string
  readonly corpus: Corpus
  readonly sourceId: string
  readonly headingPath: ReadonlyArray<string>
  readonly service: string | undefined
  readonly text: string
}

export interface ScoredChunk {
  readonly chunk: StoredChunk
  readonly score: number
}

/** Persistence for versioned chunk indexes. Internal to this package. */
export class ChunkStore extends Context.Service<
  ChunkStore,
  {
    readonly activeVersion: Effect.Effect<Option.Option<IndexVersionInfo>, StoreError>
    readonly listVersions: Effect.Effect<ReadonlyArray<IndexVersionInfo>, StoreError>
    getVersion(version: string): Effect.Effect<Option.Option<IndexVersionInfo>, StoreError>
    /** Which of `hashes` already have an embedding in `version`. */
    existingHashes(version: string, hashes: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>, StoreError>
    /**
     * Atomically creates a version (`ready`, or `active` when `activateAt` is set).
     * Fails if `baseVersion` is no longer the active version.
     */
    writeVersion(spec: NewVersion): Effect.Effect<void, StoreError | StaleBaseVersionError>
    /**
     * Makes `version` active and retires the previous active version. A `ready` version can only be
     * activated while the version it was built from is still active, so activating a stale candidate
     * cannot silently drop newer ingests. A `retired` version can always be re-activated (rollback).
     */
    activate(version: string, at: DateTime.Utc): Effect.Effect<void, StoreError | StaleBaseVersionError>
    /** Deletes the given versions and their chunks. Refuses to delete the active version. */
    deleteVersions(versions: ReadonlyArray<string>): Effect.Effect<void, StoreError>
    searchVector(params: {
      readonly version: string
      readonly embedding: ReadonlyArray<number>
      readonly filter: SearchFilter
      readonly limit: number
    }): Effect.Effect<ReadonlyArray<ScoredChunk>, StoreError>
    searchText(params: {
      readonly version: string
      readonly text: string
      readonly textSearchConfig: string
      readonly filter: SearchFilter
      readonly limit: number
    }): Effect.Effect<ReadonlyArray<ScoredChunk>, StoreError>
  }
>()("@incident/rag/ChunkStore") {}
