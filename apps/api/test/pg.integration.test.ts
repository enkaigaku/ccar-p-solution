/**
 * Runs the Postgres stores against a real database. Skipped unless API_TEST_DATABASE_URL is set, for example
 *   API_TEST_DATABASE_URL=postgres://incident:incident@localhost:5432/incident pnpm --filter @incident/api test
 * Each run creates a throwaway database (the user needs CREATEDB) and drops it afterwards.
 */
import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, layer } from "@effect/vitest"
import {
  Feedback,
  FeedbackId,
  FeedbackRecord,
  InvestigationId,
  InvestigationUsage,
  PostmortemBody,
  PostmortemDraft,
  PostmortemId,
  ReportSnapshot,
} from "@incident/contracts"
import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { FeedbackStore } from "../src/feedback/FeedbackStore.ts"
import { PostmortemStore } from "../src/postmortem/PostmortemStore.ts"
import { checkoutAlert } from "./fixtures.ts"

const url = process.env.API_TEST_DATABASE_URL
const database = `api_test_${randomUUID().replaceAll("-", "")}`

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

const StoresLive = Layer.mergeAll(FeedbackStore.layerPg, PostmortemStore.layerPg).pipe(Layer.provideMerge(PgLive))

const at = (iso: string) => DateTime.makeUnsafe(iso)

const feedback = (id: string, investigation: string, createdAt: string, actualRootCause?: string) =>
  new FeedbackRecord({
    id: FeedbackId.make(id),
    investigationId: InvestigationId.make(investigation),
    feedback: new Feedback({
      rating: actualRootCause === undefined ? "up" : "down",
      ...(actualRootCause === undefined ? {} : { actualRootCause }),
    }),
    submittedBy: { subject: "u-2", name: "bob" },
    report: new ReportSnapshot({
      alert: checkoutAlert,
      status: "completed",
      hypotheses: [{ summary: "payment rejects charges", confidence: 0.8, evidence: [] }],
      promptVersion: "investigation@3",
      indexVersion: "idx-1",
      model: "claude-opus-5-5",
      traceId: "trace-abc",
    }),
    createdAt: at(createdAt),
  })

const draft = (id: string, investigation: string, overrides?: Partial<PostmortemDraft>) =>
  new PostmortemDraft({
    id: PostmortemId.make(id),
    investigationId: InvestigationId.make(investigation),
    status: "draft",
    service: "checkout",
    body: new PostmortemBody({
      title: "Checkout failures",
      summary: "Checkout failed.",
      symptoms: "5xx.",
      rootCause: "It's a flag; quotes ' and \" and \\ survive.",
      mitigation: "Flag off.",
    }),
    model: "claude-sonnet-5-5",
    promptVersion: "postmortem@1",
    usage: new InvestigationUsage({ costUsd: 0.02, inputTokens: 3000, outputTokens: 600 }),
    edited: false,
    createdAt: at("2026-11-12T04:00:00Z"),
    updatedAt: at("2026-11-12T04:00:00Z"),
    ...overrides,
  })

describe.skipIf(url === undefined)("api stores (live Postgres)", () => {
  layer(StoresLive, { timeout: "60 seconds" })((it) => {
    it.effect("feedback round-trips through jsonb and filters by root cause, time and investigation", () =>
      Effect.gen(function* () {
        const store = yield* FeedbackStore
        const records = [
          feedback("fb-1", "inv-1", "2026-11-12T04:00:00Z"),
          feedback("fb-2", "inv-1", "2026-11-12T05:00:00Z", "paymentFailure flag was on"),
          feedback("fb-3", "inv-2", "2026-11-12T06:00:00Z", "  "),
        ]
        for (const record of records) yield* store.add(record)

        const all = yield* store.list({})
        assert.deepStrictEqual(
          all.map((r) => r.id),
          ["fb-3", "fb-2", "fb-1"],
        )
        assert.deepStrictEqual(all[1], records[1])
        const ids = (xs: ReadonlyArray<FeedbackRecord>) => xs.map((r) => r.id)
        assert.deepStrictEqual(ids(yield* store.list({ hasRootCause: true })), ["fb-2"])
        assert.deepStrictEqual(ids(yield* store.list({ hasRootCause: false })), ["fb-3", "fb-1"])
        assert.deepStrictEqual(ids(yield* store.list({ since: at("2026-11-12T05:00:00Z") })), ["fb-3", "fb-2"])
        assert.deepStrictEqual(ids(yield* store.listFor(InvestigationId.make("inv-1"))), ["fb-1", "fb-2"])
      }),
    )

    it.effect("keeps one postmortem per investigation and replaces it on put", () =>
      Effect.gen(function* () {
        const store = yield* PostmortemStore
        const investigation = InvestigationId.make("inv-1")
        assert.isTrue(Option.isNone(yield* store.getByInvestigation(investigation)))
        const first = draft("pm-1", "inv-1")
        yield* store.put(first)
        assert.deepStrictEqual(Option.getOrUndefined(yield* store.get(first.id)), first)

        // Regenerating: a new id for the same investigation replaces the old row.
        const second = draft("pm-2", "inv-1")
        yield* store.put(second)
        assert.isTrue(Option.isNone(yield* store.get(first.id)))

        const published = draft("pm-2", "inv-1", {
          status: "published",
          reviewedBy: "alice",
          sourceId: "postmortems/generated/2026-11-12-checkout-pm2.md",
          indexVersion: "idx-2",
          updatedAt: at("2026-11-12T05:00:00Z"),
        })
        yield* store.put(published)
        assert.deepStrictEqual(Option.getOrUndefined(yield* store.getByInvestigation(investigation)), published)
        yield* store.put(draft("pm-3", "inv-2"))
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ status: string }>`SELECT status FROM api_postmortems ORDER BY id`
        assert.deepStrictEqual(
          rows.map((r) => r.status),
          ["published", "draft"],
        )
      }),
    )
  })
})
