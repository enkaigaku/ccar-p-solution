import { FeedbackRecord, type InvestigationId } from "@incident/contracts"
import { Context, DateTime, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiSchemaLive } from "../db/migrations.ts"

export interface FeedbackFilter {
  /** `true`: only records with an actual root cause; `false`: only records without one. */
  readonly hasRootCause?: boolean | undefined
  /** Only records created at or after this instant. */
  readonly since?: DateTime.Utc | undefined
}

const hasRootCause = (record: FeedbackRecord) => (record.feedback.actualRootCause ?? "").trim() !== ""

const matches = (filter: FeedbackFilter) => (record: FeedbackRecord) =>
  (filter.hasRootCause === undefined || hasRootCause(record) === filter.hasRootCause) &&
  (filter.since === undefined || DateTime.isGreaterThanOrEqualTo(record.createdAt, filter.since))

const RecordJson = Schema.fromJsonString(FeedbackRecord)
const encodeRecord = Schema.encodeEffect(RecordJson)
// Postgres returns `jsonb` as a parsed value, so rows decode with the record Schema itself.
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ record: FeedbackRecord })))

/**
 * Responder feedback on investigation reports. Each record carries a snapshot of the report it is about, so it
 * outlives the in-memory investigation and can be turned into an evaluation case later.
 *
 * Storage failures are defects: a caller cannot do anything about them, and the request fails with a 500.
 */
export class FeedbackStore extends Context.Service<
  FeedbackStore,
  {
    add(record: FeedbackRecord): Effect.Effect<void>
    /** Newest first. */
    list(filter: FeedbackFilter): Effect.Effect<ReadonlyArray<FeedbackRecord>>
    /** Oldest first: the order the responders wrote them in. */
    listFor(investigationId: InvestigationId): Effect.Effect<ReadonlyArray<FeedbackRecord>>
  }
>()("@incident/api/feedback/FeedbackStore") {
  /** Forgets everything on restart. Used without `DATABASE_URL` and in tests. */
  static readonly layerMemory = Layer.effect(
    FeedbackStore,
    Effect.gen(function* () {
      const records = yield* Ref.make<ReadonlyArray<FeedbackRecord>>([])
      return FeedbackStore.of({
        add: (record) => Ref.update(records, (xs) => [...xs, record]),
        list: (filter) => Ref.get(records).pipe(Effect.map((xs) => xs.filter(matches(filter)).toReversed())),
        listFor: (investigationId) =>
          Ref.get(records).pipe(Effect.map((xs) => xs.filter((r) => r.investigationId === investigationId))),
      })
    }),
  )

  /** Postgres table `api_feedback`. Requires a `SqlClient`; the api migrations run first. */
  static readonly layerPg = Layer.effect(
    FeedbackStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const add = Effect.fn("FeedbackStore.add")(function* (record: FeedbackRecord) {
        const json = yield* encodeRecord(record)
        yield* sql`
          INSERT INTO api_feedback (id, investigation_id, has_root_cause, created_at, record)
          VALUES (${record.id}, ${record.investigationId}, ${hasRootCause(record)},
                  to_timestamp(${DateTime.toEpochMillis(record.createdAt) / 1000}), ${json}::jsonb)`
      }, Effect.orDie)

      const list = Effect.fn("FeedbackStore.list")(function* (filter: FeedbackFilter) {
        const since = filter.since === undefined ? 0 : DateTime.toEpochMillis(filter.since) / 1000
        const rows = yield* sql`
          SELECT record FROM api_feedback
          WHERE created_at >= to_timestamp(${since})
            AND (${filter.hasRootCause ?? null}::boolean IS NULL OR has_root_cause = ${filter.hasRootCause ?? null}::boolean)
          ORDER BY created_at DESC, id DESC`
        return (yield* decodeRows(rows)).map((row) => row.record)
      }, Effect.orDie)

      const listFor = Effect.fn("FeedbackStore.listFor")(function* (investigationId: InvestigationId) {
        const rows = yield* sql`
          SELECT record FROM api_feedback WHERE investigation_id = ${investigationId} ORDER BY created_at, id`
        return (yield* decodeRows(rows)).map((row) => row.record)
      }, Effect.orDie)

      return FeedbackStore.of({ add, list, listFor })
    }),
  ).pipe(Layer.provide(ApiSchemaLive))
}
