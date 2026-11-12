import { Schema } from "effect"
import { InvestigationId } from "./Investigation.ts"

export const ProposalId = Schema.String.pipe(Schema.brand("ProposalId"))
export type ProposalId = typeof ProposalId.Type

export class ToggleFlag extends Schema.TaggedClass<ToggleFlag>()("ToggleFlag", {
  flag: Schema.String,
  variant: Schema.String,
}) {}

export class RestartService extends Schema.TaggedClass<RestartService>()("RestartService", {
  service: Schema.String,
}) {}

export class RollbackService extends Schema.TaggedClass<RollbackService>()("RollbackService", {
  service: Schema.String,
  imageTag: Schema.String,
}) {}

/** Every state-changing action the system can take. Adding one is a contract change. */
export const OpsAction = Schema.Union([ToggleFlag, RestartService, RollbackService])
export type OpsAction = typeof OpsAction.Type

/** Created by the agent's `propose_action` tool. Never executed without an Approval. */
export class ActionProposal extends Schema.Class<ActionProposal>("@incident/contracts/ActionProposal")({
  id: ProposalId,
  investigationId: InvestigationId,
  action: OpsAction,
  rationale: Schema.String,
  expectedEffect: Schema.String,
  rollbackPlan: Schema.String,
  status: Schema.Literals(["pending", "approved", "rejected", "expired", "executed", "failed"]),
  createdAt: Schema.DateTimeUtcFromString,
}) {}

export const Decision = Schema.Literals(["approved", "rejected"])
export type Decision = typeof Decision.Type

export class Approval extends Schema.Class<Approval>("@incident/contracts/Approval")({
  proposalId: ProposalId,
  approver: Schema.String,
  decision: Decision,
  comment: Schema.optionalKey(Schema.String),
  decidedAt: Schema.DateTimeUtcFromString,
}) {}

/**
 * Proof that a human approved one exact action. `mcp-ops` rejects any call without a valid token.
 * `actionHash` binds the token to the action's parameters; changing a parameter invalidates it.
 */
export class ApprovalToken extends Schema.Class<ApprovalToken>("@incident/contracts/ApprovalToken")({
  proposalId: ProposalId,
  actionHash: Schema.String,
  approver: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  signature: Schema.String,
}) {}
