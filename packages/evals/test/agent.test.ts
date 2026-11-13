import { assert, describe, it } from "@effect/vitest"
import { AlertId, Investigation, InvestigationId } from "@incident/contracts"
import { DateTime } from "effect"
import { toAgentRun } from "../src/agent/AgentUnderTest.ts"
import { checkCitations } from "../src/scoring/citations.ts"

const at = DateTime.makeUnsafe("2026-11-12T03:00:00Z")

const investigation = (extra: Partial<Investigation> = {}) =>
  new Investigation({
    id: InvestigationId.make("inv-1"),
    alertId: AlertId.make("alert-1"),
    status: "awaiting_approval",
    hypotheses: [
      {
        summary: "payment rejects charges",
        confidence: 0.8,
        evidence: [
          { kind: "log", ref: "logs-abc#0" },
          { kind: "chunk", ref: "runbook-payment#2" },
        ],
      },
    ],
    promptVersion: "investigate@1",
    indexVersion: "idx-1",
    model: "claude-opus-5-5",
    createdAt: at,
    updatedAt: at,
    ...extra,
  })

describe("api agent run", () => {
  it("carries the api's retrieved chunks and usage, so chunk citations and cost are graded", () => {
    const run = toAgentRun(
      investigation({
        retrievedChunkIds: ["runbook-payment#2"],
        usage: { costUsd: 0.31, inputTokens: 40_000, outputTokens: 3_000 },
      }),
      [],
      1200,
    )
    assert.deepStrictEqual(run.retrievedChunkIds, ["runbook-payment#2"])
    assert.strictEqual(run.usage.costUsd, 0.31)
    assert.deepStrictEqual(checkCitations(run, new Set(["logs-abc#0"])).invalid, [])
  })

  it("falls back to no chunks and zero usage for an api that does not report them", () => {
    const run = toAgentRun(investigation(), [], 1200)
    assert.deepStrictEqual(run.retrievedChunkIds, [])
    assert.strictEqual(run.usage.costUsd, 0)
    assert.strictEqual(checkCitations(run, new Set(["logs-abc#0"])).invalid.length, 1)
  })
})
