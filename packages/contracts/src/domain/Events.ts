import { Schema } from "effect"
import { ActionProposal } from "./Approval.ts"
import { Hypothesis, InvestigationId, InvestigationStatus } from "./Investigation.ts"

/** Events streamed to the web console over SSE (`GET /investigations/:id/events`). */
export class StepStarted extends Schema.TaggedClass<StepStarted>()("StepStarted", {
  investigationId: InvestigationId,
  step: Schema.Literals(["triage", "retrieve", "agent_turn", "report"]),
  turn: Schema.optionalKey(Schema.Int),
}) {}

export class ToolCalled extends Schema.TaggedClass<ToolCalled>()("ToolCalled", {
  investigationId: InvestigationId,
  tool: Schema.String,
  durationMs: Schema.Number,
  isError: Schema.Boolean,
}) {}

export class HypothesisUpdated extends Schema.TaggedClass<HypothesisUpdated>()("HypothesisUpdated", {
  investigationId: InvestigationId,
  hypotheses: Schema.Array(Hypothesis),
}) {}

export class ProposalCreated extends Schema.TaggedClass<ProposalCreated>()("ProposalCreated", {
  investigationId: InvestigationId,
  proposal: ActionProposal,
}) {}

export class StatusChanged extends Schema.TaggedClass<StatusChanged>()("StatusChanged", {
  investigationId: InvestigationId,
  status: InvestigationStatus,
}) {}

export const InvestigationEvent = Schema.Union([
  StepStarted,
  ToolCalled,
  HypothesisUpdated,
  ProposalCreated,
  StatusChanged,
])
export type InvestigationEvent = typeof InvestigationEvent.Type
