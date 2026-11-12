import { Schema } from "effect"

export const ChunkId = Schema.String.pipe(Schema.brand("ChunkId"))
export type ChunkId = typeof ChunkId.Type

export const Corpus = Schema.Literals(["runbook", "postmortem", "public-postmortem"])
export type Corpus = typeof Corpus.Type

/** One retrievable piece of the knowledge base. `score` is set by retrieval and absent at ingest time. */
export class Chunk extends Schema.Class<Chunk>("@incident/contracts/Chunk")({
  id: ChunkId,
  corpus: Corpus,
  sourceId: Schema.String,
  /** Heading path inside the source document, for example ["checkout", "High latency", "Mitigation"]. */
  headingPath: Schema.Array(Schema.String),
  service: Schema.optionalKey(Schema.String),
  text: Schema.String,
  score: Schema.optionalKey(Schema.Number),
  /** Index version that produced this chunk. Written to retrieval spans. */
  indexVersion: Schema.String,
}) {}

export class RetrievalQuery extends Schema.Class<RetrievalQuery>("@incident/contracts/RetrievalQuery")({
  text: Schema.NonEmptyString,
  service: Schema.optionalKey(Schema.String),
  corpora: Schema.optionalKey(Schema.Array(Corpus)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
}) {}

/** A source document handed to the ingestor, before chunking. */
export class SourceDocument extends Schema.Class<SourceDocument>("@incident/contracts/SourceDocument")({
  sourceId: Schema.String,
  corpus: Corpus,
  service: Schema.optionalKey(Schema.String),
  markdown: Schema.String,
}) {}

export class IngestReport extends Schema.Class<IngestReport>("@incident/contracts/IngestReport")({
  indexVersion: Schema.String,
  chunksWritten: Schema.Int,
  chunksSkipped: Schema.Int,
}) {}
