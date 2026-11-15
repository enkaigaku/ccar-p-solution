import { Effect, Layer } from "effect"
import { Migrator, SqlClient } from "effect/sql"

/**
 * Migrations owned by the api, tracked in their own table (`api_migrations`) so they never collide with
 * `@incident/rag`'s. Records are stored as the JSON encoding of their contract Schema, next to the few columns
 * queries filter on; the Schema stays the single definition of the shape.
 */
export const apiMigrations = {
  "0001_feedback_loop": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE api_feedback (
        id text PRIMARY KEY,
        investigation_id text NOT NULL,
        has_root_cause boolean NOT NULL,
        created_at timestamptz NOT NULL,
        record jsonb NOT NULL
      )`
    yield* sql`CREATE INDEX api_feedback_created ON api_feedback (created_at DESC)`
    yield* sql`CREATE INDEX api_feedback_investigation ON api_feedback (investigation_id)`
    yield* sql`
      CREATE TABLE api_postmortems (
        id text PRIMARY KEY,
        investigation_id text NOT NULL UNIQUE,
        status text NOT NULL CHECK (status IN ('draft', 'published', 'rejected')),
        updated_at timestamptz NOT NULL,
        record jsonb NOT NULL
      )`
  }),
}

const runApiMigrations = Migrator.make({})({
  loader: Migrator.fromRecord(apiMigrations),
  table: "api_migrations",
})

/** Brings the api's tables up to date. One layer shared by every Postgres store, so migrations run once. */
export const ApiSchemaLive = Layer.effectDiscard(runApiMigrations.pipe(Effect.orDie))
