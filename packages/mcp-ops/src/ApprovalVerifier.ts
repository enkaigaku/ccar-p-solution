import {
  APPROVAL_TOKEN_MAX_TTL_MINUTES,
  type ApprovalToken,
  actionHash,
  type OpsAction,
  type ProposalId,
  verifyApprovalSignature,
} from "@incident/contracts"
import { Config, Context, DateTime, Duration, Effect, Layer, Redacted, Ref, Schema } from "effect"

export const RejectionReason = Schema.Literals([
  "invalid_signature",
  "expired",
  "ttl_too_long",
  "action_mismatch",
  "already_used",
])
export type RejectionReason = typeof RejectionReason.Type

export class ApprovalRejected extends Schema.TaggedError<ApprovalRejected>()("ApprovalRejected", {
  reason: RejectionReason,
  message: Schema.String,
}) {}

/**
 * Checks that an `ApprovalToken` authorises exactly `action`, now, and only once.
 *
 * Order: signature, expiry, maximum validity window, action binding, single use.
 * The token is consumed only after every other check passes, so a rejected call never burns a valid token.
 */
export class ApprovalVerifier extends Context.Service<
  ApprovalVerifier,
  {
    verify(action: OpsAction, token: ApprovalToken): Effect.Effect<void, ApprovalRejected>
  }
>()("@incident/mcp-ops/ApprovalVerifier") {
  static readonly make = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>) {
    // Proposal ids whose token was accepted. In memory: tokens live at most 10 minutes, so a restart
    // inside that window is the only replay gap. M2 moves this to the audit table.
    const consumed = yield* Ref.make(new Set<ProposalId>())
    const maxTtl = Duration.minutes(APPROVAL_TOKEN_MAX_TTL_MINUTES)

    const verify = Effect.fn("ApprovalVerifier.verify")(function* (action: OpsAction, token: ApprovalToken) {
      yield* Effect.annotateCurrentSpan({ "approval.proposal_id": token.proposalId, "ops.action": action._tag })

      if (!(yield* verifyApprovalSignature(secret, token))) {
        return yield* new ApprovalRejected({ reason: "invalid_signature", message: "Approval signature is invalid" })
      }

      const now = yield* DateTime.now
      if (!DateTime.isLessThan(now, token.expiresAt)) {
        return yield* new ApprovalRejected({ reason: "expired", message: "Approval has expired" })
      }
      if (DateTime.isGreaterThan(token.expiresAt, DateTime.addDuration(now, maxTtl))) {
        return yield* new ApprovalRejected({
          reason: "ttl_too_long",
          message: `Approval validity exceeds ${APPROVAL_TOKEN_MAX_TTL_MINUTES} minutes`,
        })
      }

      if ((yield* actionHash(action)) !== token.actionHash) {
        return yield* new ApprovalRejected({
          reason: "action_mismatch",
          message: "Approval was issued for different action parameters",
        })
      }

      const fresh = yield* Ref.modify(consumed, (set) =>
        set.has(token.proposalId) ? [false, set] : [true, new Set(set).add(token.proposalId)],
      )
      if (!fresh) {
        return yield* new ApprovalRejected({ reason: "already_used", message: "Approval has already been used" })
      }
    })

    return ApprovalVerifier.of({ verify })
  })

  /** Reads the HMAC secret from `APPROVAL_SIGNING_KEY` (at least 32 characters). */
  static readonly layer = Layer.effect(
    ApprovalVerifier,
    Effect.gen(function* () {
      const secret = yield* Config.Redacted("APPROVAL_SIGNING_KEY")
      if (Redacted.value(secret).length < 32) {
        return yield* new InvalidSigningKey({ message: "APPROVAL_SIGNING_KEY must be at least 32 characters" })
      }
      return yield* ApprovalVerifier.make(secret)
    }),
  )
}

export class InvalidSigningKey extends Schema.TaggedError<InvalidSigningKey>()("InvalidSigningKey", {
  message: Schema.String,
}) {}
