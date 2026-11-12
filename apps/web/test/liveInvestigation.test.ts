import { assert, describe, it } from "@effect/vitest"
import { ActionProposal, Investigation, StatusChanged } from "@incident/contracts"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { LiveAction } from "../src/investigation/live.ts"
import { liveInvestigation } from "../src/investigation/useLiveInvestigation.ts"
import { ApiBaseUrl } from "../src/lib/ApiBaseUrl.ts"
import { IncidentClient } from "../src/lib/IncidentClient.ts"
import { InvestigationEvents } from "../src/lib/InvestigationEvents.ts"
import { fakeHttp, json, sse } from "./fakeHttp.ts"
import { investigation, investigationId, proposal } from "./fixtures.ts"

const encodeInvestigation = Schema.encodeSync(Investigation)
const encodeProposal = Schema.encodeSync(ActionProposal)
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(StatusChanged))

const appLayer = (http: ReturnType<typeof fakeHttp>) =>
  Layer.mergeAll(IncidentClient.layer, InvestigationEvents.layer).pipe(
    Layer.provide(http.layer),
    Layer.provide(Layer.succeed(ApiBaseUrl, "http://web/api")),
  )

describe("liveInvestigation", () => {
  it.effect("falls back to polling snapshots when the API has no event stream, until a terminal status", () => {
    let polls = 0
    const http = fakeHttp((_, url) => {
      if (url.pathname.endsWith("/events")) return new Response(null, { status: 404 })
      if (url.pathname.endsWith("/proposals")) return json([encodeProposal(proposal())])
      polls += 1
      return json(encodeInvestigation(investigation({ status: polls < 3 ? "running" : "completed" })))
    })
    const actions: Array<LiveAction> = []
    return Effect.gen(function* () {
      const fiber = yield* liveInvestigation(investigationId, (a) => actions.push(a)).pipe(Effect.forkChild)
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)
      const tags = actions.map((a) => (a._tag === "Connection" ? `Connection:${a.connection}` : a._tag))
      assert.deepStrictEqual(tags, ["Connection:polling", "Snapshot", "Snapshot", "Snapshot"])
      const last = actions.at(-1)
      assert.strictEqual(last?._tag === "Snapshot" ? last.investigation.status : undefined, "completed")
      // Requests go through the typed client, prefixed with the proxy base URL.
      assert.ok(http.requests.every((r) => r.url.href.startsWith("http://web/api/investigations/inv-1")))
    }).pipe(Effect.provide(appLayer(http)))
  })

  it.effect("streams events and stops at a terminal status, then settles with a snapshot", () => {
    const http = fakeHttp((_, url) => {
      if (url.pathname.endsWith("/events")) {
        return sse([`data: ${encodeEvent(StatusChanged.make({ investigationId, status: "completed" }))}\n\n`])
      }
      if (url.pathname.endsWith("/proposals")) return json([])
      return json(encodeInvestigation(investigation({ status: "completed" })))
    })
    const actions: Array<LiveAction> = []
    return Effect.gen(function* () {
      yield* liveInvestigation(investigationId, (a) => actions.push(a))
      const tags = actions.map((a) => (a._tag === "Connection" ? `Connection:${a.connection}` : a._tag))
      assert.deepStrictEqual(tags, ["Connection:live", "Event", "Snapshot", "Connection:ended"])
    }).pipe(Effect.provide(appLayer(http)))
  })

  it.effect("reports a connection error with a readable message when the API is unreachable", () => {
    const http = fakeHttp(() => json({ _tag: "UpstreamUnavailable" }, 502))
    const actions: Array<LiveAction> = []
    return Effect.gen(function* () {
      const fiber = yield* liveInvestigation(investigationId, (a) => actions.push(a)).pipe(Effect.forkChild)
      yield* TestClock.adjust("5 minutes")
      yield* Fiber.join(fiber)
      const last = actions.at(-1)
      assert.strictEqual(last?._tag, "Connection")
      assert.strictEqual(last?._tag === "Connection" ? last.connection : undefined, "error")
      assert.strictEqual(last?._tag === "Connection" ? last.message : undefined, "实时事件流中断")
    }).pipe(Effect.provide(appLayer(http)))
  })
})
