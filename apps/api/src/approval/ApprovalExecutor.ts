import { type ActionProposal, signApprovalToken } from "@incident/contracts"
import { SpanName } from "@incident/telemetry"
import { Config, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { AuditLog } from "../audit/AuditLog.ts"
import type { McpError } from "../mcp/McpSession.ts"
import { OpsExecutionFailed, OpsGateway, type OpsOutcome } from "../mcp/OpsGateway.ts"

/** How long a signed token stays valid. It is used immediately; `mcp-ops` refuses anything above 10 minutes. */
const TOKEN_TTL = Duration.minutes(2)

export class InvalidSigningKey extends Schema.TaggedError<InvalidSigningKey>()("InvalidSigningKey", {
  message: Schema.String,
}) {}

/**
 * Executes a proposal after a human approved it: signs an `ApprovalToken` bound to the exact action and calls
 * `mcp-ops`, which verifies signature, expiry, action hash and single use before doing anything.
 * This is the only code path in the api that reaches a write tool.
 */
export class ApprovalExecutor extends Context.Service<
  ApprovalExecutor,
  {
    execute(proposal: ActionProposal, approver: string): Effect.Effect<OpsOutcome, OpsExecutionFailed | McpError>
  }
>()("@incident/api/approval/ApprovalExecutor") {
  static readonly make = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>) {
    const ops = yield* OpsGateway
    const audit = yield* AuditLog

    const execute = Effect.fn("ApprovalExecutor.execute")(
      function* (proposal: ActionProposal, approver: string) {
        if (proposal.status !== "approved") {
          return yield* Effect.die(new Error(`proposal ${proposal.id} is ${proposal.status}, not approved`))
        }
        const token = yield* signApprovalToken(secret, {
          proposalId: proposal.id,
          action: proposal.action,
          approver,
          expiresAt: DateTime.addDuration(yield* DateTime.now, TOKEN_TTL),
        })
        yield* audit.append({
          kind: "approval",
          investigationId: proposal.investigationId,
          subject: proposal.id,
          // The signature is never written to the audit trail.
          payload: JSON.stringify({ action: proposal.action, approver, actionHash: token.actionHash }),
        })
        return yield* ops.execute(proposal.action, token).pipe(
          Effect.tap((result) =>
            audit.append({
              kind: "ops_result",
              investigationId: proposal.investigationId,
              subject: proposal.id,
              payload: JSON.stringify(result),
            }),
          ),
          Effect.tapError((error) =>
            audit.append({
              kind: "ops_result",
              investigationId: proposal.investigationId,
              subject: proposal.id,
              payload: JSON.stringify({ ok: false, error: error._tag, message: error.message }),
            }),
          ),
        )
      },
      (effect, proposal) =>
        effect.pipe(
          Effect.withSpan(SpanName.opsExecute, {
            attributes: { "approval.proposal_id": proposal.id, "ops.action": proposal.action._tag },
          }),
        ),
    )
    return ApprovalExecutor.of({ execute })
  })

  /**
   * `APPROVAL_SIGNING_KEY` (at least 32 characters), shared with `mcp-ops`. Without it the api still starts and
   * every approved proposal fails to execute; a key that is too short stops startup.
   */
  static readonly layer = Layer.effect(
    ApprovalExecutor,
    Effect.gen(function* () {
      const configured = yield* Config.option(Config.Redacted("APPROVAL_SIGNING_KEY"))
      if (Option.isNone(configured)) {
        yield* Effect.logWarning("APPROVAL_SIGNING_KEY is not set; approved proposals cannot be executed")
        return ApprovalExecutor.of({
          execute: () =>
            Effect.fail(new OpsExecutionFailed({ tool: "none", message: "APPROVAL_SIGNING_KEY is not set" })),
        })
      }
      const secret = configured.value
      if (Redacted.value(secret).length < 32) {
        return yield* new InvalidSigningKey({ message: "APPROVAL_SIGNING_KEY must be at least 32 characters" })
      }
      return yield* ApprovalExecutor.make(secret)
    }),
  )
}
