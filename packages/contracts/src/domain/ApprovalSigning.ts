import { DateTime, Effect, Redacted, Schema } from "effect"
import { ApprovalToken, OpsAction, type ProposalId } from "./Approval.ts"

/**
 * How an `ApprovalToken` is bound to one exact action and signed.
 * The api's approval executor signs; `mcp-ops` verifies. Both must use these functions.
 *
 * - `actionHash` = lowercase hex SHA-256 of the canonical JSON of the encoded `OpsAction` (including `_tag`).
 * - `signature`  = base64url HMAC-SHA256, keyed with the shared signing secret, over the canonical JSON of
 *   `{ actionHash, approver, expiresAt, proposalId }` with `expiresAt` as an ISO-8601 UTC string.
 *
 * Uses Web Crypto so the module also loads in the browser bundle (no `node:crypto`).
 */

/** Tokens may not be valid for longer than this (design doc: approvals expire after 10 minutes). */
export const APPROVAL_TOKEN_MAX_TTL_MINUTES = 10

/** JSON with object keys sorted recursively and no whitespace; array order is preserved. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value))

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

const encoder = new TextEncoder()

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

const encodeAction = Schema.encodeSync(OpsAction)

/** Hash that binds an approval to the action's exact parameters. */
export const actionHash = (action: OpsAction): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(encodeAction(action))))).pipe(
    Effect.map(toHex),
  )

export interface ApprovalTokenFields {
  readonly proposalId: ProposalId
  readonly actionHash: string
  readonly approver: string
  readonly expiresAt: DateTime.Utc
}

/** The exact bytes that are signed. */
export const signingPayload = (fields: ApprovalTokenFields): string =>
  canonicalJson({
    actionHash: fields.actionHash,
    approver: fields.approver,
    expiresAt: DateTime.formatIso(fields.expiresAt),
    proposalId: fields.proposalId,
  })

const importKey = (secret: Redacted.Redacted<string>, usage: "sign" | "verify") =>
  Effect.promise(() =>
    crypto.subtle.importKey("raw", encoder.encode(Redacted.value(secret)), { name: "HMAC", hash: "SHA-256" }, false, [
      usage,
    ]),
  )

/** Sign an approval for `action`. Called by the api's approval executor after a human approves. */
export const signApprovalToken = Effect.fnUntraced(function* (
  secret: Redacted.Redacted<string>,
  input: {
    readonly proposalId: ProposalId
    readonly action: OpsAction
    readonly approver: string
    readonly expiresAt: DateTime.Utc
  },
) {
  const fields: ApprovalTokenFields = {
    proposalId: input.proposalId,
    actionHash: yield* actionHash(input.action),
    approver: input.approver,
    expiresAt: input.expiresAt,
  }
  const key = yield* importKey(secret, "sign")
  const mac = yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, encoder.encode(signingPayload(fields))))
  return new ApprovalToken({ ...fields, signature: toBase64Url(mac) })
})

/** Constant-time check that `token.signature` was produced with `secret`. Does not check expiry or the action. */
export const verifyApprovalSignature = Effect.fnUntraced(function* (
  secret: Redacted.Redacted<string>,
  token: ApprovalToken,
) {
  const signature = fromBase64Url(token.signature)
  if (signature === undefined) return false
  const key = yield* importKey(secret, "verify")
  return yield* Effect.promise(() =>
    crypto.subtle.verify("HMAC", key, signature, encoder.encode(signingPayload(token))),
  )
})
