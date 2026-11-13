import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ReplaySnapshot } from "@incident/contracts"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { ReplaySourceLayer } from "../src/ReplaySource.ts"
import { TelemetrySource } from "../src/TelemetrySource.ts"

const recordedWindow = { start: "2026-11-12T05:00:00Z", end: "2026-11-12T05:15:00Z" }
const agentWindow = { start: "2026-11-12T05:02:00Z", end: "2026-11-12T05:12:00Z" }

const snapshot: typeof ReplaySnapshot.Encoded = {
  version: 1,
  caseId: "payment-failure-01",
  recordedAt: "2026-11-12T05:16:00Z",
  window: recordedWindow,
  alert: {
    status: "firing",
    labels: { alertname: "HighErrorRate", service: "payment" },
    annotations: {},
    startsAt: "2026-11-12T05:05:00Z",
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint: "f1",
  },
  calls: [
    {
      tool: "query_metrics",
      input: {
        promql: 'sum(rate(http_server_errors_total{service="payment"}[1m]))',
        ...recordedWindow,
        stepSeconds: 30,
      },
      output: {
        ref: "metrics-recorded",
        series: [{ labels: {}, min: 0, max: 4, avg: 2, last: 4, tail: [["2026-11-12T05:15:00.000Z", 4]] }],
      },
    },
    {
      tool: "query_logs",
      input: { service: "payment", ...recordedWindow, level: "error" },
      output: {
        ref: "logs-recorded",
        totalMatched: 42,
        countsByLevel: { error: 42 },
        topMessages: [{ pattern: "charge failed", count: 42 }],
        samples: [0, 1, 2].map((i) => ({
          ref: `logs-recorded#${i}`,
          timestamp: "2026-11-12T05:10:00.000Z",
          line: `charge failed for alice@example.com (${i})`,
        })),
      },
    },
    {
      tool: "get_service_status",
      input: {},
      output: {
        ref: "status-recorded",
        services: [{ name: "payment", state: "running", restarts: 2, imageTag: "2.1.3-payment" }],
      },
    },
  ],
}

const withSnapshot = (layout: "direct" | "case") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    const caseDir = layout === "direct" ? dir : `${dir}/${snapshot.caseId}`
    yield* fs.makeDirectory(caseDir, { recursive: true })
    yield* fs.writeFileString(`${caseDir}/snapshot.json`, JSON.stringify(snapshot))
    const layer = ReplaySourceLayer({ dir, caseId: layout === "direct" ? undefined : snapshot.caseId })
    return yield* TelemetrySource.pipe(Effect.provide(layer))
  })

describe("ReplaySource", () => {
  it.effect("matches on the query and ignores the time window and step", () =>
    Effect.gen(function* () {
      const source = yield* withSnapshot("direct")
      const out = yield* source.queryMetrics({
        promql: '  sum(rate(http_server_errors_total{service="payment"}[1m]))\n',
        ...agentWindow,
        stepSeconds: 60,
      })
      assert.strictEqual(out.ref, "metrics-recorded")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("falls back to tool + service for logs, keeping the recorded ref", () =>
    Effect.gen(function* () {
      const source = yield* withSnapshot("case")
      const out = yield* source.queryLogs({ service: "payment", ...agentWindow, contains: "charge" })
      assert.strictEqual(out.ref, "logs-recorded")
      assert.strictEqual(out.totalMatched, 42)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("answers an unrecorded per-service status from the recorded unfiltered call", () =>
    Effect.gen(function* () {
      const source = yield* withSnapshot("direct")
      const payment = yield* source.getServiceStatus({ service: "payment" })
      assert.strictEqual(payment.ref, "status-recorded")
      assert.deepStrictEqual(
        payment.services.map((s) => s.name),
        ["payment"],
      )
      const cart = yield* source.getServiceStatus({ service: "cart" })
      assert.strictEqual(cart.ref, "status-recorded")
      assert.deepStrictEqual(cart.services, [])
      // Nothing recorded for topology at all: still an empty miss.
      const topology = yield* source.getServiceTopology({ service: "payment" })
      assert.match(topology.ref, /^topology-[0-9a-f]{12}$/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("returns empty results on a miss, and an error for an unknown trace", () =>
    Effect.gen(function* () {
      const source = yield* withSnapshot("direct")
      const metrics = yield* source.queryMetrics({ promql: "up", ...agentWindow, stepSeconds: 60 })
      assert.deepStrictEqual(metrics.series, [])
      assert.match(metrics.ref, /^metrics-[0-9a-f]{12}$/)
      const logs = yield* source.queryLogs({ service: "cart", ...agentWindow })
      assert.strictEqual(logs.totalMatched, 0)
      const trace = yield* Effect.flip(source.getTrace({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }))
      assert.strictEqual(trace.message, "Trace not found")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("fails to start on a malformed snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/snapshot.json`, JSON.stringify({ ...snapshot, version: 2 }))
      const exit = yield* Effect.exit(Layer.build(ReplaySourceLayer({ dir, caseId: undefined })))
      assert.strictEqual(exit._tag, "Failure")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it("snapshot fixture matches the schema", () => {
    assert.doesNotThrow(() => Schema.decodeUnknownSync(ReplaySnapshot)(snapshot))
  })
})
