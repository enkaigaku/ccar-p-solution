import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Redacted } from "effect"
import {
  ApprovalToken,
  actionHash,
  canonicalJson,
  ProposalId,
  RestartService,
  RollbackService,
  signApprovalToken,
  verifyApprovalSignature,
} from "../src/index.ts"

const secret = Redacted.make("test-signing-secret-at-least-32-bytes!")
const expiresAt = DateTime.makeUnsafe("2026-11-12T06:00:00Z")
const proposalId = ProposalId.make("prop-1")

describe("canonicalJson", () => {
  it("sorts keys recursively and keeps array order", () => {
    assert.strictEqual(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}')
  })
})

describe("actionHash", () => {
  it.effect("is stable and parameter-sensitive", () =>
    Effect.gen(function* () {
      const a = yield* actionHash(new RestartService({ service: "checkout" }))
      const b = yield* actionHash(new RestartService({ service: "checkout" }))
      const c = yield* actionHash(new RestartService({ service: "cart" }))
      assert.match(a, /^[0-9a-f]{64}$/)
      assert.strictEqual(a, b)
      assert.notStrictEqual(a, c)
    }),
  )

  it.effect("distinguishes action types with overlapping fields", () =>
    Effect.gen(function* () {
      const restart = yield* actionHash(new RestartService({ service: "checkout" }))
      const rollback = yield* actionHash(new RollbackService({ service: "checkout", imageTag: "2.0.1" }))
      assert.notStrictEqual(restart, rollback)
    }),
  )
})

describe("signApprovalToken / verifyApprovalSignature", () => {
  const sign = signApprovalToken(secret, {
    proposalId,
    action: new RestartService({ service: "checkout" }),
    approver: "alice",
    expiresAt,
  })

  it.effect("round-trips", () =>
    Effect.gen(function* () {
      const token = yield* sign
      assert.match(token.signature, /^[A-Za-z0-9_-]+$/)
      assert.isTrue(yield* verifyApprovalSignature(secret, token))
    }),
  )

  it.effect("rejects a wrong secret", () =>
    Effect.gen(function* () {
      const token = yield* sign
      assert.isFalse(yield* verifyApprovalSignature(Redacted.make("another-secret-another-secret-xx"), token))
    }),
  )

  it.effect("rejects any edited field", () =>
    Effect.gen(function* () {
      const token = yield* sign
      const edits: ReadonlyArray<Partial<ApprovalToken>> = [
        { approver: "mallory" },
        { proposalId: ProposalId.make("prop-2") },
        { actionHash: "0".repeat(64) },
        { expiresAt: DateTime.add(expiresAt, { hours: 1 }) },
        { signature: "not*base64" },
      ]
      for (const edit of edits) {
        assert.isFalse(yield* verifyApprovalSignature(secret, new ApprovalToken({ ...token, ...edit })))
      }
    }),
  )
})
