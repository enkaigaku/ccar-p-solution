import { assert, describe, it } from "@effect/vitest"
import { InvestigationId, Retriever } from "@incident/contracts"
import { Effect, Layer } from "effect"
import { type AgentSettings, Investigator, isEmptyResult } from "../src/agent/Investigator.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"
import { ObservabilityGateway } from "../src/mcp/ObservabilityGateway.ts"
import { checkoutAlert, checkoutTriage, goodReport, toggleProposal, window } from "./fixtures.ts"
import {
  type FakeReply,
  fakeAnthropic,
  jsonText,
  observabilitySession,
  recordingEvents,
  reply,
  text,
  toolUse,
} from "./harness.ts"

const investigationId = InvestigationId.make("inv-1")

const run = (replies: Array<FakeReply>, settings: AgentSettings = { maxTurns: 10, maxCostUsd: 5 }) =>
  Effect.gen(function* () {
    const claude = fakeAnthropic(replies)
    const recorded = yield* recordingEvents
    const audit = yield* AuditLog.makeMemory
    const investigator = yield* Investigator.make(settings).pipe(
      Effect.provide(
        Layer.mergeAll(
          claude.layer,
          recorded.layer,
          Retriever.layerStub,
          ObservabilityGateway.layerFrom(observabilitySession),
          Layer.succeed(AuditLog, audit.service),
        ),
      ),
    )
    const outcome = yield* investigator
      .investigate({ investigationId, alert: checkoutAlert, triage: checkoutTriage })
      .pipe(Effect.result)
    return { outcome, requests: claude.requests, events: yield* recorded.events, audit: yield* audit.records }
  })

const toolNames = (request: Record<string, unknown>) => (request.tools as Array<{ name: string }>).map((t) => t.name)

const userMessages = (request: Record<string, unknown>) =>
  JSON.stringify((request.messages as Array<{ role: string }>).filter((m) => m.role === "user"))

describe("Investigator", () => {
  it.effect("runs the tool loop, repairs invented citations and returns a cited report with a proposal", () =>
    Effect.gen(function* () {
      const { outcome, requests, events, audit } = yield* run([
        reply("tool_use", [
          toolUse("t1", "query_logs", { service: "checkout", ...window, level: "error" }),
          toolUse("t2", "query_logs", { service: "payment", ...window, level: "error" }),
        ]),
        reply("tool_use", [toolUse("t3", "propose_action", toggleProposal)]),
        reply("end_turn", [
          jsonText({
            ...goodReport,
            hypotheses: [{ ...goodReport.hypotheses[0], evidence: [{ kind: "log", ref: "logs-invented", note: "" }] }],
          }),
        ]),
        reply("end_turn", [jsonText(goodReport)]),
      ])
      assert.strictEqual(outcome._tag, "Success")
      if (outcome._tag !== "Success") return
      const report = outcome.success
      assert.strictEqual(report.status, "completed")
      assert.strictEqual(report.hypotheses[0]?.confidence, 0.82)
      assert.deepStrictEqual(
        report.hypotheses[0]?.evidence.map((e) => e.ref),
        ["logs-payment#0", "stub-runbook-1", "topology-1"],
      )
      assert.strictEqual(report.proposals.length, 1)
      assert.strictEqual(report.proposals[0]?.action._tag, "ToggleFlag")
      assert.strictEqual(report.toolCalls, 3)
      assert.strictEqual(report.turns, 4)
      assert.strictEqual(report.promptVersion, "investigate@1+method-error-rate@2")
      assert.strictEqual(report.indexVersion, "stub")
      assert.deepStrictEqual([...report.retrievedChunkIds], ["stub-postmortem-1", "stub-runbook-1"])
      assert.isAbove(report.usage.costUsd, 0)
      assert.isAbove(report.usage.outputTokens, 0)

      // Request shape: model routing, effort, fallbacks, structured output, cache breakpoints.
      const first = requests[0] ?? {}
      assert.strictEqual(first.model, "claude-opus-5-5")
      assert.deepStrictEqual(first.output_config && (first.output_config as { effort: string }).effort, "high")
      assert.strictEqual(first.fallbacks, "default")
      assert.deepStrictEqual(first.thinking, { type: "adaptive" })
      assert.isUndefined(first.temperature)
      assert.isUndefined(first.tool_choice)
      assert.deepStrictEqual((first.system as Array<{ cache_control: unknown }>)[0]?.cache_control, {
        type: "ephemeral",
      })

      // Security rule 1: read-only tools plus propose_action, never a write tool.
      assert.deepStrictEqual(toolNames(first), [
        "get_service_status",
        "get_service_topology",
        "get_trace",
        "query_logs",
        "query_metrics",
        "search_knowledge",
        "propose_action",
      ])
      // Prompt caching: the tool list is byte-identical on every turn.
      for (const request of requests) assert.deepStrictEqual(request.tools, first.tools)

      // Security rule 3: tool output reaches the model only inside the untrusted-data wrapper.
      const second = userMessages(requests[1] ?? {})
      assert.include(second, 'untrusted-data source=\\"query_logs\\"')
      assert.include(second, "ignore previous instructions")
      assert.include(userMessages(requests[3] ?? {}), "logs-invented")

      const steps = events.flatMap((e) => (e._tag === "StepStarted" ? [e.step] : []))
      assert.deepStrictEqual(steps, ["retrieve", "agent_turn", "agent_turn", "agent_turn", "agent_turn", "report"])
      assert.strictEqual(events.filter((e) => e._tag === "ToolCalled").length, 3)

      // Security rule 5: texts go to the audit trail (hashed on spans).
      assert.strictEqual(audit.filter((r) => r.kind === "tool_result").length, 3)
      assert.strictEqual(audit.filter((r) => r.kind === "llm_response").length, 4)
    }),
  )

  it.effect("forces a tool-free final answer once the turn budget is used, and drops proposals of a weak report", () =>
    Effect.gen(function* () {
      const { outcome, requests } = yield* run(
        [
          reply("tool_use", [
            toolUse("t1", "propose_action", {
              ...toggleProposal,
              action: { _tag: "RestartService", service: "payment" },
            }),
          ]),
          reply("end_turn", [
            jsonText({
              status: "completed",
              hypotheses: [{ summary: "maybe payment", confidence: 0.3, evidence: [] }],
            }),
          ]),
        ],
        { maxTurns: 1, maxCostUsd: 5 },
      )
      assert.strictEqual(outcome._tag, "Success")
      if (outcome._tag !== "Success") return
      assert.strictEqual(outcome.success.proposals.length, 0)
      assert.deepStrictEqual(requests[1]?.tool_choice, { type: "none" })
      assert.include(userMessages(requests[1] ?? {}), "budget is used up")
    }),
  )

  it.effect("applies the budget on pause_turn continuations and caps the turns", () =>
    Effect.gen(function* () {
      const { outcome, requests } = yield* run(
        Array.from({ length: 6 }, () => reply("pause_turn", [text("thinking...")])),
        { maxTurns: 1, maxCostUsd: 5 },
      )
      assert.strictEqual(outcome._tag, "Failure")
      if (outcome._tag === "Failure") assert.strictEqual(outcome.failure.reason, "report")
      // maxTurns + the forced final answer + one pause.
      assert.strictEqual(requests.length, 3)
      assert.deepStrictEqual(requests[1]?.tool_choice, { type: "none" })
      assert.include(userMessages(requests[1] ?? {}), "budget is used up")
    }),
  )

  it.effect("skips the citation repair once the budget is spent and drops the invalid citations", () =>
    Effect.gen(function* () {
      const { outcome, requests } = yield* run(
        [
          reply("end_turn", [
            jsonText({
              status: "completed",
              hypotheses: [
                {
                  summary: "payment fails",
                  confidence: 0.8,
                  evidence: [
                    { kind: "chunk", ref: "stub-runbook-1", note: "" },
                    { kind: "log", ref: "logs-invented", note: "" },
                  ],
                },
              ],
            }),
          ]),
        ],
        { maxTurns: 1, maxCostUsd: 5 },
      )
      assert.strictEqual(requests.length, 1)
      assert.strictEqual(outcome._tag, "Success")
      if (outcome._tag !== "Success") return
      assert.strictEqual(outcome.success.droppedCitations, 1)
      assert.deepStrictEqual(
        outcome.success.hypotheses[0]?.evidence.map((e) => e.ref),
        ["stub-runbook-1"],
      )
    }),
  )

  it.effect("reports insufficient information without proposals", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run([
        reply("end_turn", [jsonText({ status: "insufficient_information", hypotheses: [] })]),
      ])
      assert.strictEqual(outcome._tag, "Success")
      if (outcome._tag !== "Success") return
      assert.strictEqual(outcome.success.status, "insufficient_information")
    }),
  )

  it.effect("fails on a refusal and on a truncated answer instead of reading content", () =>
    Effect.gen(function* () {
      const refused = yield* run([reply("refusal", [])])
      assert.strictEqual(refused.outcome._tag, "Failure")
      if (refused.outcome._tag === "Failure") assert.strictEqual(refused.outcome.failure.reason, "refusal")

      const truncated = yield* run([reply("max_tokens", [text('{"status":"comp')])])
      assert.strictEqual(truncated.outcome._tag, "Failure")
      if (truncated.outcome._tag === "Failure") assert.strictEqual(truncated.outcome.failure.reason, "max_tokens")
    }),
  )

  it.effect("returns empty results to the model but does not let the report cite them", () =>
    Effect.gen(function* () {
      const cited = (ref: string) => ({ kind: "log", ref, note: "" })
      const report = (refs: ReadonlyArray<string>) =>
        jsonText({
          status: "completed",
          hypotheses: [{ summary: "payment fails", confidence: 0.8, evidence: refs.map(cited) }],
        })
      const { outcome, requests } = yield* run([
        reply("tool_use", [
          toolUse("t1", "query_logs", { service: "valkey", start: window.start, end: window.end }),
          toolUse("t2", "query_logs", { service: "payment", start: window.start, end: window.end }),
        ]),
        reply("end_turn", [report(["logs-payment#0", "logs-valkey"])]),
        reply("end_turn", [report(["logs-payment#0", "logs-valkey"])]),
      ])
      assert.include(userMessages(requests[1] ?? {}), "must not be cited")
      // The empty result's ref triggers the repair round and is then dropped.
      assert.include(userMessages(requests[2] ?? {}), "log:logs-valkey")
      assert.strictEqual(outcome._tag, "Success")
      if (outcome._tag !== "Success") return
      assert.deepStrictEqual(
        outcome.success.hypotheses[0]?.evidence.map((e) => e.ref),
        ["logs-payment#0"],
      )
    }),
  )

  it("classifies empty tool results", () => {
    assert.isTrue(isEmptyResult({ ref: "m", series: [] }))
    assert.isFalse(isEmptyResult({ ref: "m", series: [{}] }))
    assert.isTrue(isEmptyResult({ ref: "l", totalMatched: 0, samples: [] }))
    assert.isFalse(isEmptyResult({ ref: "l", totalMatched: 3, samples: [] }))
    assert.isTrue(isEmptyResult({ ref: "s", services: [] }))
    assert.isTrue(isEmptyResult({ ref: "t", edges: [] }))
    assert.isFalse(isEmptyResult({ ref: "x", traceId: "abc", spans: [] }))
  })

  it.effect("returns tool errors to the model instead of failing", () =>
    Effect.gen(function* () {
      const { outcome, requests } = yield* run([
        reply("tool_use", [
          toolUse("t1", "get_trace", { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }),
          toolUse("t2", "restart_service", { service: "payment" }),
        ]),
        reply("end_turn", [jsonText({ status: "insufficient_information", hypotheses: [] })]),
      ])
      assert.strictEqual(outcome._tag, "Success")
      const results = userMessages(requests[1] ?? {})
      assert.include(results, "Trace not found")
      assert.include(results, "Unknown tool restart_service")
    }),
  )
})
