import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  AlertmanagerWebhook,
  InvestigationEvent,
  ObservabilityTools,
  OpsTools,
  ReplaySnapshot,
  RetrievalQuery,
  Retriever,
  replayFallbackKey,
  replayKey,
  StatusChanged,
} from "../src/index.ts"

describe("MCP tool contracts", () => {
  it("every tool input compiles to an object JSON Schema for tools/list", () => {
    for (const [name, tool] of Object.entries({ ...ObservabilityTools, ...OpsTools })) {
      const doc = Schema.toJsonSchemaDocument(tool.input)
      assert.strictEqual(doc.schema.type, "object", `${name} input must be an object schema`)
    }
  })

  it("ops tools refuse input without an approval token", () => {
    const result = Schema.decodeUnknownResult(OpsTools.restart_service.input)({ service: "checkout" })
    assert.strictEqual(result._tag, "Failure")
  })
})

describe("HTTP and event contracts", () => {
  it("decodes an Alertmanager webhook payload", () => {
    const payload = Schema.decodeUnknownSync(AlertmanagerWebhook)({
      version: "4",
      status: "firing",
      receiver: "incident-copilot",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
          annotations: { summary: "checkout 5xx above 5%" },
          startsAt: "2026-11-12T03:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
          fingerprint: "a1b2c3",
        },
      ],
    })
    assert.strictEqual(payload.alerts.length, 1)
  })

  it("round-trips an SSE event through JSON", () => {
    const codec = Schema.toCodecJson(InvestigationEvent)
    const event = StatusChanged.make({ investigationId: "inv-1" as never, status: "running" })
    const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(event))))
    assert.strictEqual(decoded._tag, "StatusChanged")
  })
})

describe("Retriever stub", () => {
  it.effect("returns chunks filtered to the requested service", () =>
    Effect.gen(function* () {
      const retriever = yield* Retriever
      const chunks = yield* retriever.search(new RetrievalQuery({ text: "checkout errors", service: "checkout" }))
      assert.isTrue(chunks.length > 0)
      assert.strictEqual(chunks[0]?.service, "checkout")
    }).pipe(Effect.provide(Retriever.layerStub)),
  )
})

describe("replay snapshot contract", () => {
  const snapshot: typeof ReplaySnapshot.Encoded = {
    version: 1,
    caseId: "payment-failure-50",
    recordedAt: "2026-11-12T03:10:00Z",
    window: { start: "2026-11-12T02:55:00Z", end: "2026-11-12T03:10:00Z" },
    alert: {
      status: "firing",
      labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
      annotations: { summary: "checkout 5xx above 5%" },
      startsAt: "2026-11-12T03:05:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "a1b2c3",
    },
    calls: [
      {
        tool: "query_logs",
        input: { service: "payment", start: "2026-11-12T02:55:00Z", end: "2026-11-12T03:10:00Z", level: "error" },
        output: {
          ref: "logs:payment:1",
          totalMatched: 3,
          countsByLevel: { error: 3 },
          topMessages: [{ pattern: "charge failed", count: 3 }],
          samples: [{ ref: "logs:payment:1#0", timestamp: "2026-11-12T03:04:00Z", line: "charge failed" }],
        },
      },
    ],
  }

  it("round-trips through JSON", () => {
    const decoded = Schema.decodeUnknownSync(ReplaySnapshot)(snapshot)
    assert.strictEqual(decoded.calls[0]?.tool, "query_logs")
    const again = Schema.decodeUnknownSync(ReplaySnapshot)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ReplaySnapshot)(decoded))),
    )
    assert.deepStrictEqual(again, decoded)
  })

  it("rejects a call whose output does not match its tool", () => {
    const broken = { ...snapshot, calls: [{ ...snapshot.calls[0], tool: "get_trace" }] }
    assert.strictEqual(Schema.decodeUnknownResult(ReplaySnapshot)(broken)._tag, "Failure")
  })

  it("match keys ignore time ranges, limits and PromQL whitespace", () => {
    const a = {
      tool: "query_metrics",
      input: { promql: "rate(x[1m])", start: "a", end: "b", stepSeconds: 15 },
    } as const
    const b = {
      tool: "query_metrics",
      input: { promql: "  rate(x[1m]) ", start: "c", end: "d", stepSeconds: 60 },
    } as const
    assert.strictEqual(replayKey(a), replayKey(b))
    assert.strictEqual(replayFallbackKey(a), undefined)
    const logs = { tool: "query_logs", input: { service: "payment", start: "a", end: "b", limit: 5 } } as const
    assert.strictEqual(replayKey(logs), "query_logs|payment||")
    assert.strictEqual(replayFallbackKey({ ...logs, input: { ...logs.input, contains: "x" } }), "query_logs|payment")
  })
})
