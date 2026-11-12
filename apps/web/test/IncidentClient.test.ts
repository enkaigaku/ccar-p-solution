import { assert, describe, it } from "@effect/vitest"
import { Alert, AlertId, Feedback, ProposalId } from "@incident/contracts"
import { DateTime, Effect, Layer, Schema } from "effect"
import { ApiBaseUrl } from "../src/lib/ApiBaseUrl.ts"
import { IncidentClient } from "../src/lib/IncidentClient.ts"
import { fakeHttp, json } from "./fakeHttp.ts"
import { investigationId, t0 } from "./fixtures.ts"

const alert = new Alert({
  id: AlertId.make("fp-1"),
  fingerprint: "fp-1",
  name: "HighErrorRate",
  service: "checkout",
  severity: "critical",
  status: "firing",
  summary: "checkout 5xx above 5%",
  labels: { service: "checkout" },
  startsAt: t0,
})

const layerWith = (http: ReturnType<typeof fakeHttp>) =>
  IncidentClient.layer.pipe(Layer.provide(http.layer), Layer.provide(Layer.succeed(ApiBaseUrl, "http://web/api")))

describe("IncidentClient", () => {
  it.effect("prefixes the proxy base URL and decodes responses with the contract schemas", () => {
    const http = fakeHttp(() => json([Schema.encodeSync(Alert)(alert)]))
    return Effect.gen(function* () {
      const client = yield* IncidentClient
      const [decoded] = yield* client.alerts.list()
      assert.strictEqual(http.requests[0]?.url.href, "http://web/api/alerts")
      assert.ok(decoded !== undefined && DateTime.isDateTime(decoded.startsAt))
      assert.strictEqual(decoded?.severity, "critical")
    }).pipe(Effect.provide(layerWith(http)))
  })

  it.effect("surfaces typed contract errors such as ProposalNotPending", () => {
    const http = fakeHttp(() => json({ _tag: "ProposalNotPending", id: "p-1", status: "approved" }, 409))
    return Effect.gen(function* () {
      const client = yield* IncidentClient
      const error = yield* client.proposals
        .decide({ params: { id: ProposalId.make("p-1") }, payload: { decision: "rejected" } })
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "ProposalNotPending")
      assert.deepStrictEqual(http.requests[0]?.body, { decision: "rejected" })
    }).pipe(Effect.provide(layerWith(http)))
  })

  it.effect("encodes feedback without the optional fields that were left empty", () => {
    const http = fakeHttp(() => new Response(null, { status: 204 }))
    return Effect.gen(function* () {
      const client = yield* IncidentClient
      yield* client.investigations.feedback({
        params: { id: investigationId },
        payload: new Feedback({ rating: "up" }),
      })
      assert.strictEqual(http.requests[0]?.method, "POST")
      assert.strictEqual(http.requests[0]?.url.pathname, "/api/investigations/inv-1/feedback")
      assert.deepStrictEqual(http.requests[0]?.body, { rating: "up" })
    }).pipe(Effect.provide(layerWith(http)))
  })
})
