import type {
  ActionProposal,
  Hypothesis,
  Investigation,
  InvestigationEvent,
  InvestigationStatus,
} from "@incident/contracts"
import type { DateTime } from "effect"

/** Below this confidence the top hypothesis is flagged as low confidence in the UI. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5

const TERMINAL_STATUSES: ReadonlySet<InvestigationStatus> = new Set(["completed", "insufficient_information", "failed"])

export const isTerminal = (status: InvestigationStatus): boolean => TERMINAL_STATUSES.has(status)

/**
 * How the live view is currently fed.
 * - `connecting`: opening the SSE stream
 * - `live`: SSE connected
 * - `polling`: the API has no SSE route for this investigation, refreshing snapshots instead
 * - `ended`: the investigation reached a terminal status, or the stream closed
 * - `error`: reconnecting gave up; the page shows the last known state
 */
export type Connection = "connecting" | "live" | "polling" | "ended" | "error"

export type TimelineEntry =
  | { readonly _tag: "Step"; readonly step: string; readonly turn: number | undefined }
  | { readonly _tag: "Tool"; readonly tool: string; readonly durationMs: number; readonly isError: boolean }
  | { readonly _tag: "Hypotheses"; readonly count: number; readonly topConfidence: number | undefined }
  | { readonly _tag: "Proposal"; readonly proposal: ActionProposal }
  | { readonly _tag: "Status"; readonly status: InvestigationStatus }

export interface TimelineItem {
  readonly seq: number
  readonly receivedAt: DateTime.Utc
  readonly entry: TimelineEntry
}

export interface LiveState {
  readonly investigation: Investigation
  readonly status: InvestigationStatus
  readonly hypotheses: ReadonlyArray<Hypothesis>
  readonly proposals: ReadonlyArray<ActionProposal>
  readonly timeline: ReadonlyArray<TimelineItem>
  readonly connection: Connection
  readonly connectionMessage: string | undefined
}

export type LiveAction =
  | {
      readonly _tag: "Snapshot"
      readonly investigation: Investigation
      readonly proposals: ReadonlyArray<ActionProposal>
    }
  | { readonly _tag: "Event"; readonly event: InvestigationEvent; readonly receivedAt: DateTime.Utc }
  | { readonly _tag: "Connection"; readonly connection: Connection; readonly message?: string }
  | { readonly _tag: "ProposalUpdated"; readonly proposal: ActionProposal }

export const initialState = (investigation: Investigation, proposals: ReadonlyArray<ActionProposal>): LiveState => ({
  investigation,
  status: investigation.status,
  hypotheses: investigation.hypotheses,
  proposals,
  timeline: [],
  connection: "connecting",
  connectionMessage: undefined,
})

const upsertProposal = (
  proposals: ReadonlyArray<ActionProposal>,
  proposal: ActionProposal,
): ReadonlyArray<ActionProposal> =>
  proposals.some((p) => p.id === proposal.id)
    ? proposals.map((p) => (p.id === proposal.id ? proposal : p))
    : [...proposals, proposal]

/** Sorted by confidence, highest first, so the UI and the low-confidence check agree on "top". */
export const rankHypotheses = (hypotheses: ReadonlyArray<Hypothesis>): ReadonlyArray<Hypothesis> =>
  [...hypotheses].sort((a, b) => b.confidence - a.confidence)

export const isLowConfidence = (status: InvestigationStatus, hypotheses: ReadonlyArray<Hypothesis>): boolean => {
  if (status === "insufficient_information") return true
  const top = rankHypotheses(hypotheses)[0]
  return top !== undefined && top.confidence < LOW_CONFIDENCE_THRESHOLD
}

const toEntry = (event: InvestigationEvent): TimelineEntry => {
  switch (event._tag) {
    case "StepStarted":
      return { _tag: "Step", step: event.step, turn: event.turn }
    case "ToolCalled":
      return { _tag: "Tool", tool: event.tool, durationMs: event.durationMs, isError: event.isError }
    case "HypothesisUpdated":
      return {
        _tag: "Hypotheses",
        count: event.hypotheses.length,
        topConfidence: rankHypotheses(event.hypotheses)[0]?.confidence,
      }
    case "ProposalCreated":
      return { _tag: "Proposal", proposal: event.proposal }
    case "StatusChanged":
      return { _tag: "Status", status: event.status }
  }
}

const applyEvent = (state: LiveState, event: InvestigationEvent, receivedAt: DateTime.Utc): LiveState => {
  // The stream is per investigation; anything else is a server bug and must not leak into this view.
  if (event.investigationId !== state.investigation.id) return state
  const timeline = [...state.timeline, { seq: state.timeline.length, receivedAt, entry: toEntry(event) }]
  switch (event._tag) {
    case "StepStarted":
    case "ToolCalled":
      return { ...state, timeline }
    case "HypothesisUpdated":
      return { ...state, timeline, hypotheses: event.hypotheses }
    case "ProposalCreated":
      return { ...state, timeline, proposals: upsertProposal(state.proposals, event.proposal) }
    case "StatusChanged":
      return {
        ...state,
        timeline,
        status: event.status,
        connection: isTerminal(event.status) ? "ended" : state.connection,
      }
  }
}

export const reduce = (state: LiveState, action: LiveAction): LiveState => {
  switch (action._tag) {
    case "Snapshot": {
      const proposals = action.proposals.reduce(upsertProposal, state.proposals)
      return {
        ...state,
        investigation: action.investigation,
        status: action.investigation.status,
        hypotheses: action.investigation.hypotheses,
        proposals,
        connection: isTerminal(action.investigation.status) ? "ended" : state.connection,
      }
    }
    case "Event":
      return applyEvent(state, action.event, action.receivedAt)
    case "Connection":
      // Once terminal, late connection noise (stream close, retries) does not change what the user sees.
      if (state.connection === "ended" && action.connection !== "ended") return state
      return { ...state, connection: action.connection, connectionMessage: action.message }
    case "ProposalUpdated":
      return { ...state, proposals: upsertProposal(state.proposals, action.proposal) }
  }
}
