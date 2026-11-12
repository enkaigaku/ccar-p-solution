import { assert, describe, it } from "@effect/vitest"
import { RestartService, RollbackService, ToggleFlag } from "@incident/contracts"
import { DateTime, Duration, Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { connect, sign, text, wire } from "./harness.ts"

describe("mcp-ops tools/list", () => {
  it.effect("lists exactly the three write tools, each requiring an approval token", () =>
    Effect.gen(function* () {
      const { client } = yield* connect
      const { tools } = yield* Effect.promise(() => client.listTools())
      assert.deepStrictEqual(tools.map((t) => t.name).sort(), ["restart_service", "rollback_service", "toggle_flag"])
      for (const t of tools) {
        assert.strictEqual(t.inputSchema.type, "object")
        assert.include(t.inputSchema.required ?? [], "approvalToken")
        assert.strictEqual(t.annotations?.readOnlyHint, false)
      }
    }).pipe(Effect.scoped),
  )
})

describe("mcp-ops approval enforcement", () => {
  it.effect("rejects a call without a token and executes nothing", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const result = yield* call("restart_service", { service: "checkout" })
      assert.isTrue(result.isError)
      assert.match(text(result), /Invalid input/)
      assert.deepStrictEqual(yield* Ref.get(recorder.executed), [])
    }).pipe(Effect.scoped),
  )

  it.effect("rejects an expired token", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const token = yield* sign(new RestartService({ service: "checkout" }), { ttl: Duration.minutes(5) })
      yield* TestClock.adjust(Duration.minutes(6))
      const result = yield* call("restart_service", { service: "checkout", approvalToken: wire(token) })
      assert.isTrue(result.isError)
      assert.match(text(result), /expired/)
      assert.deepStrictEqual(yield* Ref.get(recorder.executed), [])
      const audit = yield* Ref.get(recorder.audit)
      assert.deepStrictEqual(
        audit.map((e) => [e.outcome, e.detail]),
        [["rejected", "expired"]],
      )
    }).pipe(Effect.scoped),
  )

  it.effect("rejects a token whose parameters were tampered with", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const token = yield* sign(new RestartService({ service: "checkout" }))
      const result = yield* call("restart_service", { service: "payment", approvalToken: wire(token) })
      assert.isTrue(result.isError)
      assert.match(text(result), /different action parameters/)
      assert.deepStrictEqual(yield* Ref.get(recorder.executed), [])
    }).pipe(Effect.scoped),
  )

  it.effect("rejects a token issued for a different tool with overlapping parameters", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const token = yield* sign(new RestartService({ service: "checkout" }))
      const result = yield* call("rollback_service", {
        service: "checkout",
        imageTag: "2.0.1-checkout",
        approvalToken: wire(token),
      })
      assert.isTrue(result.isError)
      assert.deepStrictEqual(yield* Ref.get(recorder.executed), [])
    }).pipe(Effect.scoped),
  )

  it.effect("rejects a forged signature and an edited approver", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const token = yield* sign(new RestartService({ service: "checkout" }))
      for (const forged of [
        { ...wire(token), signature: "AAAA" },
        { ...wire(token), approver: "mallory" },
      ]) {
        const result = yield* call("restart_service", { service: "checkout", approvalToken: forged })
        assert.isTrue(result.isError)
        assert.match(text(result), /signature is invalid/)
      }
      assert.deepStrictEqual(yield* Ref.get(recorder.executed), [])
    }).pipe(Effect.scoped),
  )

  it.effect("rejects a token valid for longer than 10 minutes", () =>
    Effect.gen(function* () {
      const { call } = yield* connect
      const token = yield* sign(new RestartService({ service: "checkout" }), { ttl: Duration.hours(1) })
      const result = yield* call("restart_service", { service: "checkout", approvalToken: wire(token) })
      assert.isTrue(result.isError)
      assert.match(text(result), /exceeds 10 minutes/)
    }).pipe(Effect.scoped),
  )

  it.effect("executes a valid approval exactly once", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const token = yield* sign(new ToggleFlag({ flag: "paymentFailure", variant: "off" }))
      const args = { flag: "paymentFailure", variant: "off", approvalToken: wire(token) }

      const first = yield* call("toggle_flag", args)
      assert.isUndefined(first.isError)
      assert.strictEqual(first.structuredContent?.ok, true)
      assert.strictEqual(first.structuredContent?.executedAt, DateTime.formatIso(yield* DateTime.now))

      const replay = yield* call("toggle_flag", args)
      assert.isTrue(replay.isError)
      assert.match(text(replay), /already been used/)

      assert.deepStrictEqual(yield* Ref.get(recorder.executed), ["toggle paymentFailure off"])
      const audit = yield* Ref.get(recorder.audit)
      assert.deepStrictEqual(
        audit.map((e) => e.outcome),
        ["accepted", "executed", "rejected"],
      )
      assert.notInclude(JSON.stringify(audit), token.signature)
    }).pipe(Effect.scoped),
  )

  it.effect("a rejected call does not burn a valid token", () =>
    Effect.gen(function* () {
      const { call, recorder } = yield* connect
      const token = yield* sign(new RollbackService({ service: "cart", imageTag: "2.0.1-cart" }))
      const tampered = yield* call("rollback_service", {
        service: "cart",
        imageTag: "latest",
        approvalToken: wire(token),
      })
      assert.isTrue(tampered.isError)
      const ok = yield* call("rollback_service", {
        service: "cart",
        imageTag: "2.0.1-cart",
        approvalToken: wire(token),
      })
      assert.isUndefined(ok.isError)
      assert.deepStrictEqual(yield* Ref.get(recorder.executed), ["rollback cart 2.0.1-cart"])
    }).pipe(Effect.scoped),
  )
})
