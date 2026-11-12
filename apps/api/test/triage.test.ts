import { assert, describe, it } from "@effect/vitest"
import { Alert, AlertId } from "@incident/contracts"
import { Effect, Layer } from "effect"
import { AuditLog } from "../src/audit/AuditLog.ts"
import { fallbackTriage, Triage } from "../src/triage/Triage.ts"
import { checkoutAlert } from "./fixtures.ts"
import { type FakeReply, fakeAnthropic, jsonText, reply } from "./harness.ts"

const paymentAlert = new Alert({
  ...checkoutAlert,
  id: AlertId.make("fp-payment-1"),
  fingerprint: "fp-payment-1",
  name: "PaymentErrors",
  service: "payment",
})

const run = (replies: Array<FakeReply>) =>
  Effect.gen(function* () {
    const claude = fakeAnthropic(replies)
    const triage = yield* Triage.pipe(
      Effect.provide(Triage.layer.pipe(Layer.provide(Layer.mergeAll(claude.layer, AuditLog.layerMemory)))),
    )
    const result = yield* triage.triage(checkoutAlert, [checkoutAlert, paymentAlert])
    return { result, requests: claude.requests }
  })

describe("Triage", () => {
  it.effect("classifies with Haiku at low effort and keeps only known related alerts", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* run([
        reply(
          "end_turn",
          [
            jsonText({
              category: "error-rate",
              service: "checkout",
              severity: "critical",
              summary: "checkout requests fail",
              retrievalQuery: "checkout HighErrorRate",
              relatedAlertIds: ["fp-payment-1", "fp-unknown", "fp-checkout-1"],
            }),
          ],
          { model: "claude-haiku-5-5" },
        ),
      ])
      assert.strictEqual(result.source, "model")
      assert.strictEqual(result.category, "error-rate")
      assert.deepStrictEqual([...result.relatedAlertIds], ["fp-payment-1"])
      const request = requests[0] ?? {}
      assert.strictEqual(request.model, "claude-haiku-5-5")
      assert.deepStrictEqual((request.output_config as { effort: string }).effort, "low")
      // The alert reaches the model as declared data.
      assert.include(JSON.stringify(request.messages), "untrusted-data")
    }),
  )

  it.effect("falls back to label heuristics on a refusal, an API error or malformed output", () =>
    Effect.gen(function* () {
      for (const bad of [
        reply("refusal", []),
        { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } },
        reply("end_turn", [jsonText({ category: "nonsense" })]),
      ]) {
        const { result } = yield* run([bad])
        assert.strictEqual(result.source, "fallback")
        assert.strictEqual(result.category, "error-rate")
        assert.strictEqual(result.service, "checkout")
      }
    }),
  )

  it("maps alert names to categories", () => {
    const cases = [
      ["HighLatencyP99", "latency"],
      ["KafkaConsumerLag", "saturation"],
      ["ServiceDown", "availability"],
      ["SomethingOdd", "other"],
    ] as const
    for (const [name, category] of cases) {
      assert.strictEqual(fallbackTriage(new Alert({ ...checkoutAlert, name, summary: "" })).category, category)
    }
  })
})
