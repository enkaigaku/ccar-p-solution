import { Context, Effect, Layer, Schema } from "effect"
import { Chunk, ChunkId, IngestReport, type RetrievalQuery, type SourceDocument } from "../domain/Chunk.ts"

export class RetrievalError extends Schema.TaggedError<RetrievalError>()("RetrievalError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class IngestError extends Schema.TaggedError<IngestError>()("IngestError", {
  sourceId: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Hybrid retrieval over the knowledge base. Implemented by `@incident/rag`. */
export class Retriever extends Context.Service<
  Retriever,
  {
    search(query: RetrievalQuery): Effect.Effect<ReadonlyArray<Chunk>, RetrievalError>
  }
>()("@incident/contracts/services/Retriever") {
  /** Returns two fixed chunks so callers can be built before `@incident/rag` exists. */
  static readonly layerStub = Layer.succeed(
    Retriever,
    Retriever.of({
      search: (query) =>
        Effect.succeed([
          new Chunk({
            id: ChunkId.make("stub-runbook-1"),
            corpus: "runbook",
            sourceId: "runbooks/checkout.md",
            headingPath: ["checkout", "High error rate", "Diagnosis"],
            ...(query.service === undefined ? {} : { service: query.service }),
            text: "Check the payment dependency first: a failing payment call surfaces as checkout 5xx.",
            score: 0.92,
            indexVersion: "stub",
          }),
          new Chunk({
            id: ChunkId.make("stub-postmortem-1"),
            corpus: "postmortem",
            sourceId: "postmortems/2026-10-payment-timeout.md",
            headingPath: ["Payment timeout", "Root cause"],
            text: "A feature flag enabled a slow code path in payment, raising p99 latency to 4s.",
            score: 0.81,
            indexVersion: "stub",
          }),
        ]),
    }),
  )
}

/** Chunks, embeds and indexes source documents. Implemented by `@incident/rag`. */
export class Ingestor extends Context.Service<
  Ingestor,
  {
    ingest(docs: ReadonlyArray<SourceDocument>): Effect.Effect<IngestReport, IngestError>
  }
>()("@incident/contracts/services/Ingestor") {
  static readonly layerStub = Layer.succeed(
    Ingestor,
    Ingestor.of({
      ingest: (docs) =>
        Effect.succeed(new IngestReport({ indexVersion: "stub", chunksWritten: docs.length, chunksSkipped: 0 })),
    }),
  )
}
