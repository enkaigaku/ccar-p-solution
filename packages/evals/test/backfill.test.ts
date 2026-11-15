import { assert, describe, it } from "@effect/vitest"
import { type RecordedToolCall, ReplaySnapshot } from "@incident/contracts"
import { DateTime, Effect, Layer, Ref } from "effect"
import { backfillLatency } from "../src/record/backfill.ts"
import { ObservabilityMcp } from "../src/record/ObservabilityMcp.ts"
import { latencyQueries, p95, p95ByOperation, serverP95 } from "../src/record/scenarios.ts"

const logs = (service: string): RecordedToolCall => ({
  tool: "query_logs",
  input: { service, start: "s", end: "e", limit: 20 },
  output: { ref: `logs:${service}`, totalMatched: 0, countsByLevel: {}, topMessages: [], samples: [] },
})

const metrics = (promql: string): RecordedToolCall => ({
  tool: "query_metrics",
  input: { promql, start: "s", end: "e", stepSeconds: 30 },
  output: { ref: "recorded", series: [] },
})

const snapshot = (calls: ReadonlyArray<RecordedToolCall>) =>
  new ReplaySnapshot({
    version: 1,
    caseId: "fc-00000001",
    recordedAt: DateTime.makeUnsafe("2026-11-14T05:39:18.690Z"),
    window: {
      start: DateTime.makeUnsafe("2026-11-14T05:32:18.638Z"),
      end: DateTime.makeUnsafe("2026-11-14T05:39:18.690Z"),
    },
    alert: {
      status: "firing",
      labels: { alertname: "HighLatency", service: "checkout", severity: "critical" },
      annotations: { summary: "checkout p95 latency is elevated" },
      startsAt: "2026-11-14T05:37:00.000Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "00000001",
    },
    calls,
  })

/** Fake live server: answers every metric query and remembers what it was asked. */
const fakeMcp = (asked: Ref.Ref<Array<{ promql: string; start: string; end: string }>>) =>
  Layer.succeed(
    ObservabilityMcp,
    ObservabilityMcp.of({
      call: ((_tool: string, input: { promql: string; start: string; end: string }) =>
        Ref.update(asked, (all) => [...all, { promql: input.promql, start: input.start, end: input.end }]).pipe(
          Effect.as({ ref: `live:${input.promql}`, series: [] }),
        )) as never,
    }),
  )

describe("backfillLatency", () => {
  it.effect("adds the latency queries for every service the snapshot has logs for, over its window", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<Array<{ promql: string; start: string; end: string }>>([])
      // `user` is a stand-in node of the service graph: it has no metrics and gets no queries.
      const before = snapshot([
        logs("shipping"),
        logs("checkout"),
        logs("checkout"),
        logs("user"),
        metrics(p95("checkout")),
      ])
      const { snapshot: after, added } = yield* backfillLatency(before).pipe(Effect.provide(fakeMcp(asked)))

      assert.strictEqual(added, 4)
      assert.deepStrictEqual(
        (yield* Ref.get(asked)).map((q) => q.promql),
        [...latencyQueries("checkout"), ...latencyQueries("shipping")],
      )
      for (const q of yield* Ref.get(asked)) {
        assert.strictEqual(q.start, "2026-11-14T05:32:18.638Z")
        assert.strictEqual(q.end, "2026-11-14T05:39:18.690Z")
      }
      // The recorded calls stay in place, in order; the new ones follow.
      assert.deepStrictEqual(after.calls.slice(0, before.calls.length), before.calls)
      assert.strictEqual(after.calls.length, before.calls.length + 4)
      assert.strictEqual(after.caseId, before.caseId)
    }),
  )

  it.effect("asks nothing for queries the snapshot already has", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<Array<{ promql: string; start: string; end: string }>>([])
      const before = snapshot([logs("payment"), metrics(serverP95("payment"))])
      const once = yield* backfillLatency(before).pipe(Effect.provide(fakeMcp(asked)))
      assert.strictEqual(once.added, 1)
      assert.deepStrictEqual(
        (yield* Ref.get(asked)).map((q) => q.promql),
        [p95ByOperation("payment")],
      )
      const twice = yield* backfillLatency(once.snapshot).pipe(Effect.provide(fakeMcp(asked)))
      assert.strictEqual(twice.added, 0)
      assert.strictEqual(twice.snapshot, once.snapshot)
      assert.strictEqual((yield* Ref.get(asked)).length, 1)
    }),
  )
})
