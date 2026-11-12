import { Schema } from "effect"
import { ApprovalToken } from "../domain/Approval.ts"

/**
 * Tool contract of the write-capable `mcp-ops` server.
 * Only the api's approval executor connects to this server; it is never exposed to the agent.
 * Every input carries an ApprovalToken bound to the exact parameters.
 */

export const ToggleFlagInput = Schema.Struct({
  flag: Schema.NonEmptyString,
  variant: Schema.NonEmptyString,
  approvalToken: ApprovalToken,
})

export const RestartServiceInput = Schema.Struct({
  service: Schema.NonEmptyString,
  approvalToken: ApprovalToken,
})

export const RollbackServiceInput = Schema.Struct({
  service: Schema.NonEmptyString,
  imageTag: Schema.NonEmptyString,
  approvalToken: ApprovalToken,
})

export const OpsResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  executedAt: Schema.String,
})

export const OpsTools = {
  toggle_flag: { input: ToggleFlagInput, output: OpsResult },
  restart_service: { input: RestartServiceInput, output: OpsResult },
  rollback_service: { input: RollbackServiceInput, output: OpsResult },
} as const
export type OpsToolName = keyof typeof OpsTools
