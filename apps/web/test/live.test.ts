import { describe, expect, it } from "@effect/vitest"
import {
  HypothesisUpdated,
  InvestigationId,
  ProposalCreated,
  StatusChanged,
  StepStarted,
  ToolCalled,
} from "@incident/contracts"
import { DateTime } from "effect"
import { initialState, isLowConfidence, type LiveAction, type LiveState, reduce } from "../src/investigation/live.ts"
import { hypothesis, investigation, investigationId, proposal, t0 } from "./fixtures.ts"

const at = (seconds: number) => DateTime.add(t0, { seconds })
const event = (e: Extract<LiveAction, { _tag: "Event" }>["event"], seconds = 0): LiveAction => ({
  _tag: "Event",
  event: e,
  receivedAt: at(seconds),
})
const apply = (state: LiveState, ...actions: ReadonlyArray<LiveAction>) => actions.reduce(reduce, state)

describe("live investigation reducer", () => {
  it("builds the timeline in arrival order and tracks hypotheses, proposals and status", () => {
    const state = apply(
      initialState(investigation(), []),
      { _tag: "Connection", connection: "live" },
      event(StepStarted.make({ investigationId, step: "agent_turn", turn: 1 }), 1),
      event(ToolCalled.make({ investigationId, tool: "query_metrics", durationMs: 420, isError: false }), 2),
      event(HypothesisUpdated.make({ investigationId, hypotheses: [hypothesis("flag", 0.8)] }), 3),
      event(ProposalCreated.make({ investigationId, proposal: proposal() }), 4),
      event(StatusChanged.make({ investigationId, status: "awaiting_approval" }), 5),
    )
    expect(state.timeline.map((i) => i.entry._tag)).toEqual(["Step", "Tool", "Hypotheses", "Proposal", "Status"])
    expect(state.timeline.map((i) => i.seq)).toEqual([0, 1, 2, 3, 4])
    expect(state.hypotheses[0]?.summary).toBe("flag")
    expect(state.proposals.map((p) => p.id)).toEqual(["p-1"])
    expect(state.status).toBe("awaiting_approval")
    expect(state.connection).toBe("live")
  })

  it("ignores events that belong to another investigation", () => {
    const other = InvestigationId.make("inv-other")
    const state = apply(
      initialState(investigation(), []),
      event(StatusChanged.make({ investigationId: other, status: "failed" })),
    )
    expect(state.timeline).toEqual([])
    expect(state.status).toBe("running")
  })

  it("ends the connection on a terminal status and ignores later connection noise", () => {
    const state = apply(
      initialState(investigation(), []),
      { _tag: "Connection", connection: "live" },
      event(StatusChanged.make({ investigationId, status: "completed" })),
      { _tag: "Connection", connection: "error", message: "stream closed" },
    )
    expect(state.connection).toBe("ended")
    expect(state.connectionMessage).toBeUndefined()
  })

  it("upserts proposals from events, snapshots and decisions without duplicating them", () => {
    const pending = proposal()
    const state = apply(
      initialState(investigation(), [pending]),
      event(ProposalCreated.make({ investigationId, proposal: pending })),
      { _tag: "ProposalUpdated", proposal: proposal({ status: "approved" }) },
      { _tag: "Snapshot", investigation: investigation({ status: "awaiting_approval" }), proposals: [pending] },
    )
    expect(state.proposals).toHaveLength(1)
    expect(state.proposals[0]?.status).toBe("pending")
    expect(state.status).toBe("awaiting_approval")
  })

  it("flags low confidence for insufficient information or a weak top hypothesis", () => {
    expect(isLowConfidence("insufficient_information", [hypothesis("a", 0.9)])).toBe(true)
    expect(isLowConfidence("completed", [hypothesis("a", 0.3), hypothesis("b", 0.45)])).toBe(true)
    expect(isLowConfidence("completed", [hypothesis("a", 0.3), hypothesis("b", 0.7)])).toBe(false)
    expect(isLowConfidence("running", [])).toBe(false)
  })
})
