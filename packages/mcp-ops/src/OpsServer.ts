import {
  type ApprovalToken,
  type OpsAction,
  OpsTools,
  RestartService,
  RollbackService,
  ToggleFlag,
} from "@incident/contracts"
import { DateTime, Effect } from "effect"
import { ApprovalVerifier } from "./ApprovalVerifier.ts"
import { AuditLog } from "./AuditLog.ts"
import { makeMcpServer, ToolError, tool } from "./McpToolServer.ts"
import { OpsExecutor } from "./OpsExecutor.ts"

const SERVER_VERSION = "0.1.0"

/**
 * Shared path for every write tool: verify the approval for exactly this action, audit, execute, audit.
 * Nothing reaches `OpsExecutor` unless `ApprovalVerifier.verify` succeeded.
 */
const guarded = Effect.fnUntraced(function* (
  toolName: string,
  action: OpsAction,
  params: Record<string, string>,
  token: ApprovalToken,
  execute: Effect.Effect<string, ToolError, OpsExecutor>,
) {
  const verifier = yield* ApprovalVerifier
  const audit = yield* AuditLog
  const base = { tool: toolName, params, proposalId: token.proposalId, approver: token.approver }

  yield* verifier.verify(action, token).pipe(
    Effect.tapError((rejected) => audit.append({ ...base, outcome: "rejected", detail: rejected.reason })),
    Effect.mapError((rejected) => new ToolError({ message: `Rejected: ${rejected.message}` })),
  )
  yield* audit.append({ ...base, actionHash: token.actionHash, outcome: "accepted", detail: "approval verified" })

  const message = yield* execute.pipe(
    Effect.tapError((error) =>
      audit.append({ ...base, actionHash: token.actionHash, outcome: "failed", detail: error.message }),
    ),
  )
  yield* audit.append({
    ...base,
    actionHash: token.actionHash,
    outcome: message.startsWith("[dry run]") ? "dry_run" : "executed",
    detail: message,
  })
  return { ok: true, message, executedAt: DateTime.formatIso(yield* DateTime.now) }
})

const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

export const opsTools = [
  tool({
    name: "toggle_flag",
    description:
      "Set the default variant of a flagd feature flag in the OpenTelemetry Demo. Requires an approval token bound to exactly this flag and variant.",
    ...OpsTools.toggle_flag,
    annotations: { title: "Toggle feature flag", ...destructive },
    handler: ({ flag, variant, approvalToken }) =>
      guarded(
        "toggle_flag",
        new ToggleFlag({ flag, variant }),
        { flag, variant },
        approvalToken,
        OpsExecutor.use((ops) => ops.toggleFlag(flag, variant)),
      ),
  }),
  tool({
    name: "restart_service",
    description:
      "Restart the containers of one docker compose service of the OpenTelemetry Demo. Requires an approval token bound to exactly this service.",
    ...OpsTools.restart_service,
    annotations: { title: "Restart service", ...destructive },
    handler: ({ service, approvalToken }) =>
      guarded(
        "restart_service",
        new RestartService({ service }),
        { service },
        approvalToken,
        OpsExecutor.use((ops) => ops.restartService(service)),
      ),
  }),
  tool({
    name: "rollback_service",
    description:
      "Redeploy one docker compose service of the OpenTelemetry Demo with an earlier image tag. Requires an approval token bound to exactly this service and tag.",
    ...OpsTools.rollback_service,
    annotations: { title: "Roll back service", ...destructive },
    handler: ({ service, imageTag, approvalToken }) =>
      guarded(
        "rollback_service",
        new RollbackService({ service, imageTag }),
        { service, imageTag },
        approvalToken,
        OpsExecutor.use((ops) => ops.rollbackService(service, imageTag)),
      ),
  }),
]

export const makeOpsServer = makeMcpServer(
  {
    name: "incident-mcp-ops",
    version: SERVER_VERSION,
    instructions:
      "Write operations on the OpenTelemetry Demo. Only the Incident Copilot approval executor may connect. Every call needs an ApprovalToken signed for exactly its parameters.",
  },
  opsTools,
)
