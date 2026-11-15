import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  ActionProposal,
  AlertmanagerWebhook,
  Authentication,
  CurrentPrincipal,
  FeedbackRecord,
  IncidentApi,
  Investigation,
  InvestigationEvent,
  ObservabilityTools,
  OpsTools,
  PostmortemBody,
  PostmortemDraft,
  Principal,
  ReplaySnapshot,
  RetrievalQuery,
  Retriever,
  replayFallbackKey,
  replayKey,
  requireRole,
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

  it("decodes an investigation with and without retrieved chunks and usage", () => {
    const base = {
      id: "inv-1",
      alertId: "alert-1",
      status: "completed",
      hypotheses: [],
      promptVersion: "investigate@1",
      indexVersion: "idx-1",
      model: "m",
      createdAt: "2026-11-12T03:00:00Z",
      updatedAt: "2026-11-12T03:05:00Z",
    }
    const json = Schema.toCodecJson(Investigation)
    const old = Schema.decodeUnknownSync(json)(base)
    assert.isUndefined(old.retrievedChunkIds)
    const full = Schema.decodeUnknownSync(json)({
      ...base,
      retrievedChunkIds: ["runbook-1#0"],
      usage: { costUsd: 0.42, inputTokens: 1200, outputTokens: 300 },
    })
    assert.deepStrictEqual(full.retrievedChunkIds, ["runbook-1#0"])
    assert.strictEqual(full.usage?.outputTokens, 300)
    const negative = Schema.decodeUnknownResult(json)({
      ...base,
      usage: { costUsd: -1, inputTokens: 0, outputTokens: 0 },
    })
    assert.strictEqual(negative._tag, "Failure")
  })

  it("round-trips an SSE event through JSON", () => {
    const codec = Schema.toCodecJson(InvestigationEvent)
    const event = StatusChanged.make({ investigationId: "inv-1" as never, status: "running" })
    const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(event))))
    assert.strictEqual(decoded._tag, "StatusChanged")
  })
})

describe("authentication contract", () => {
  const responder = new Principal({ subject: "u-1", name: "alice", roles: ["viewer", "responder"] })

  it.effect("requireRole returns the principal when it holds the role and fails with Forbidden otherwise", () =>
    Effect.gen(function* () {
      const allowed = yield* requireRole("responder")
      assert.strictEqual(allowed.subject, "u-1")
      const denied = yield* requireRole("approver").pipe(Effect.flip)
      assert.strictEqual(denied._tag, "Forbidden")
      assert.strictEqual(denied.required, "approver")
    }).pipe(Effect.provideService(CurrentPrincipal, responder)),
  )

  it("rejects a principal with an unknown role or an empty subject", () => {
    const decode = Schema.decodeUnknownResult(Principal)
    assert.strictEqual(decode({ subject: "u-1", name: "alice", roles: ["admin"] })._tag, "Failure")
    assert.strictEqual(decode({ subject: "", name: "alice", roles: [] })._tag, "Failure")
  })

  it("every endpoint except health and the alert webhook requires authentication", () => {
    const open: Array<string> = []
    for (const group of Object.values(IncidentApi.groups)) {
      for (const [name, endpoint] of Object.entries(group.endpoints)) {
        if (!endpoint.middlewares.has(Authentication)) open.push(`${group.identifier}.${name}`)
      }
    }
    assert.deepStrictEqual(open.sort(), ["alerts.webhook", "system.health"])
  })

  it("decodes a proposal with and without decidedBy", () => {
    const base = {
      id: "p-1",
      investigationId: "inv-1",
      action: { _tag: "RestartService", service: "checkout" },
      rationale: "r",
      expectedEffect: "e",
      rollbackPlan: "b",
      status: "pending",
      createdAt: "2026-11-12T03:00:00Z",
    }
    const json = Schema.toCodecJson(ActionProposal)
    assert.isUndefined(Schema.decodeUnknownSync(json)(base).decidedBy)
    assert.strictEqual(
      Schema.decodeUnknownSync(json)({ ...base, status: "rejected", decidedBy: "alice" }).decidedBy,
      "alice",
    )
  })
})

describe("feedback loop contracts", () => {
  const alert = {
    id: "a1b2c3",
    fingerprint: "a1b2c3",
    name: "HighErrorRate",
    service: "checkout",
    severity: "critical",
    status: "firing",
    summary: "checkout 5xx above 5%",
    labels: { alertname: "HighErrorRate" },
    startsAt: "2026-11-12T03:00:00Z",
  }
  const record = {
    id: "fb-1",
    investigationId: "inv-1",
    feedback: { rating: "down", actualRootCause: "payment was unreachable" },
    submittedBy: { subject: "u-1", name: "alice" },
    report: {
      alert,
      status: "completed",
      hypotheses: [{ summary: "checkout is overloaded", confidence: 0.6, evidence: [] }],
      promptVersion: "investigation@3",
      indexVersion: "idx-1",
      model: "claude-opus-5-5",
    },
    createdAt: "2026-11-12T04:00:00Z",
  }

  it("round-trips a feedback record with its report snapshot through JSON", () => {
    const codec = Schema.fromJsonString(FeedbackRecord)
    const decoded = Schema.decodeUnknownSync(codec)(JSON.stringify(record))
    assert.strictEqual(decoded.report.alert.service, "checkout")
    assert.strictEqual(decoded.report.traceId, undefined)
    assert.deepStrictEqual(JSON.parse(Schema.encodeSync(codec)(decoded)).feedback, record.feedback)
  })

  it("a feedback record needs the report it refers to", () => {
    const { report: _report, ...withoutReport } = record
    assert.strictEqual(Schema.decodeUnknownResult(FeedbackRecord)(withoutReport)._tag, "Failure")
  })

  const body = {
    title: "Checkout failures caused by an unreachable payment service",
    summary: "Checkout returned 5xx for 20 minutes.",
    symptoms: "Checkout error rate rose to 40%.",
    rootCause: "The paymentUnreachable flag was on.",
    mitigation: "The flag was turned off.",
  }
  const draft = {
    id: "pm-1",
    investigationId: "inv-1",
    status: "draft",
    service: "checkout",
    body,
    model: "claude-sonnet-5-5",
    promptVersion: "postmortem@1",
    usage: { costUsd: 0.02, inputTokens: 3000, outputTokens: 600 },
    edited: false,
    createdAt: "2026-11-12T04:00:00Z",
    updatedAt: "2026-11-12T04:00:00Z",
  }

  it("decodes a postmortem as a draft and as a published document", () => {
    const decode = Schema.decodeUnknownSync(PostmortemDraft)
    assert.strictEqual(decode(draft).sourceId, undefined)
    const published = decode({
      ...draft,
      status: "published",
      reviewedBy: "bob",
      sourceId: "postmortems/generated/pm-1.md",
      indexVersion: "idx-2",
    })
    assert.strictEqual(published.reviewedBy, "bob")
  })

  it("rejects a postmortem with an empty section or an unknown status", () => {
    assert.strictEqual(Schema.decodeUnknownResult(PostmortemBody)({ ...body, rootCause: "" })._tag, "Failure")
    assert.strictEqual(Schema.decodeUnknownResult(PostmortemDraft)({ ...draft, status: "approved" })._tag, "Failure")
  })

  it("exposes the postmortem and feedback endpoints", () => {
    assert.deepStrictEqual(Object.keys(IncidentApi.groups.postmortems.endpoints).sort(), ["edit", "review"])
    assert.deepStrictEqual(Object.keys(IncidentApi.groups.feedback.endpoints), ["list"])
    const investigations = Object.keys(IncidentApi.groups.investigations.endpoints)
    assert.isTrue(investigations.includes("generatePostmortem") && investigations.includes("postmortem"))
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
    const metric = (promql: string) =>
      ({ tool: "query_metrics", input: { promql, start: "a", end: "b", stepSeconds: 15 } }) as const
    // Whitespace inside label values is significant.
    assert.notStrictEqual(replayKey(metric('x{m="charge  failed"}')), replayKey(metric('x{m="charge failed"}')))
    assert.strictEqual(replayKey(metric('x{m="a \\" b"}  ')), 'query_metrics|x{m="a \\" b"}')
    assert.strictEqual(replayKey(metric("sum(\n  rate(x[1m])\n)")), "query_metrics|sum( rate(x[1m]) )")
    assert.strictEqual(replayFallbackKey(a), undefined)
    const logs = { tool: "query_logs", input: { service: "payment", start: "a", end: "b", limit: 5 } } as const
    assert.strictEqual(replayKey(logs), "query_logs|payment||")
    assert.strictEqual(replayFallbackKey({ ...logs, input: { ...logs.input, contains: "x" } }), "query_logs|payment")
  })
})
