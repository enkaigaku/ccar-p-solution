import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  AlertmanagerWebhook,
  InvestigationEvent,
  ObservabilityTools,
  OpsTools,
  RetrievalQuery,
  Retriever,
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
