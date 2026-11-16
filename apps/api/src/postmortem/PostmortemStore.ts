import { type InvestigationId, PostmortemDraft, type PostmortemId } from "@incident/contracts"
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiSchemaLive } from "../db/migrations.ts"

const encodeDraft = Schema.encodeEffect(Schema.fromJsonString(PostmortemDraft))
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ record: PostmortemDraft })))

/**
 * Postmortem drafts, at most one per investigation: generating again replaces the stored draft. The rules about
 * which status may change into which live in `Postmortems`; this is storage only.
 *
 * Storage failures are defects, as in `FeedbackStore`.
 */
export class PostmortemStore extends Context.Service<
  PostmortemStore,
  {
    get(id: PostmortemId): Effect.Effect<Option.Option<PostmortemDraft>>
    getByInvestigation(investigationId: InvestigationId): Effect.Effect<Option.Option<PostmortemDraft>>
    /** Inserts, or replaces the postmortem of the same investigation. */
    put(draft: PostmortemDraft): Effect.Effect<void>
  }
>()("@incident/api/postmortem/PostmortemStore") {
  static readonly layerMemory = Layer.effect(
    PostmortemStore,
    Effect.gen(function* () {
      const drafts = yield* Ref.make<ReadonlyMap<InvestigationId, PostmortemDraft>>(new Map())
      return PostmortemStore.of({
        get: (id) =>
          Ref.get(drafts).pipe(Effect.map((m) => Option.fromUndefinedOr([...m.values()].find((d) => d.id === id)))),
        getByInvestigation: (investigationId) =>
          Ref.get(drafts).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(investigationId)))),
        put: (draft) => Ref.update(drafts, (m) => new Map([...m, [draft.investigationId, draft]])),
      })
    }),
  )

  /** Postgres table `api_postmortems`. Requires a `SqlClient`; the api migrations run first. */
  static readonly layerPg = Layer.effect(
    PostmortemStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const first = (rows: ReadonlyArray<unknown>) =>
        decodeRows(rows).pipe(Effect.map((decoded) => Option.fromUndefinedOr(decoded[0]?.record)))

      const put = Effect.fn("PostmortemStore.put")(function* (draft: PostmortemDraft) {
        const json = yield* encodeDraft(draft)
        const updatedAt = DateTime.toEpochMillis(draft.updatedAt) / 1000
        yield* sql`
          INSERT INTO api_postmortems (id, investigation_id, status, updated_at, record)
          VALUES (${draft.id}, ${draft.investigationId}, ${draft.status}, to_timestamp(${updatedAt}), ${json}::jsonb)
          ON CONFLICT (investigation_id) DO UPDATE
            SET id = EXCLUDED.id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, record = EXCLUDED.record`
      }, Effect.orDie)

      return PostmortemStore.of({
        get: (id) => sql`SELECT record FROM api_postmortems WHERE id = ${id}`.pipe(Effect.flatMap(first), Effect.orDie),
        getByInvestigation: (investigationId) =>
          sql`SELECT record FROM api_postmortems WHERE investigation_id = ${investigationId}`.pipe(
            Effect.flatMap(first),
            Effect.orDie,
          ),
        put,
      })
    }),
  ).pipe(Layer.provide(ApiSchemaLive))
}
