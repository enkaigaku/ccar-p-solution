import { assert, describe, it } from "@effect/vitest"
import { InvestigationEvent, StatusChanged, StepStarted } from "@incident/contracts"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ApiBaseUrl } from "../src/lib/ApiBaseUrl.ts"
import { InvestigationEvents } from "../src/lib/InvestigationEvents.ts"
import { fakeHttp, sse } from "./fakeHttp.ts"
import { investigationId } from "./fixtures.ts"

const encode = Schema.encodeSync(Schema.fromJsonString(InvestigationEvent))
const frame = (event: InvestigationEvent, id?: string) =>
  `${id === undefined ? "" : `id: ${id}\n`}data: ${encode(event)}\n\n`

const step = StepStarted.make({ investigationId, step: "triage" })
const done = StatusChanged.make({ investigationId, status: "completed" })

const layerWith = (http: ReturnType<typeof fakeHttp>) =>
  InvestigationEvents.layer.pipe(Layer.provide(http.layer), Layer.provide(Layer.succeed(ApiBaseUrl, "http://web/api")))

describe("InvestigationEvents", () => {
  it.effect("decodes SSE frames into contract events after a Connected marker", () => {
    const http = fakeHttp(() => sse([": keep-alive\n\n", frame(step, "1"), frame(done, "2")]))
    return Effect.gen(function* () {
      const events = yield* InvestigationEvents
      const signals = yield* Stream.runCollect(events.stream(investigationId).pipe(Stream.take(3)))
      assert.deepStrictEqual(
        signals.map((s) => (s._tag === "Event" ? s.event._tag : s._tag)),
        ["Connected", "StepStarted", "StatusChanged"],
      )
      const request = http.requests[0]
      assert.strictEqual(request?.url.href, "http://web/api/investigations/inv-1/events")
      assert.strictEqual(request?.headers.accept, "text/event-stream")
    }).pipe(Effect.provide(layerWith(http)))
  })

  it.effect("reconnects when the server closes the stream before a terminal status", () => {
    const http = fakeHttp(() => sse([frame(step)]))
    return Effect.gen(function* () {
      const events = yield* InvestigationEvents
      const fiber = yield* Stream.runCollect(events.stream(investigationId).pipe(Stream.take(4))).pipe(Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      const signals = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        signals.map((s) => s._tag),
        ["Connected", "Event", "Connected", "Event"],
      )
    }).pipe(Effect.provide(layerWith(http)))
  })

  it.effect("fails with EventStreamUnavailable without retrying when the API has no stream", () => {
    const http = fakeHttp(() => new Response("not found", { status: 404 }))
    return Effect.gen(function* () {
      const events = yield* InvestigationEvents
      const error = yield* Stream.runCollect(events.stream(investigationId)).pipe(Effect.flip)
      assert.strictEqual(error._tag, "EventStreamUnavailable")
      assert.strictEqual(http.requests.length, 1)
    }).pipe(Effect.provide(layerWith(http)))
  })

  it.effect("reconnects after a broken stream and resumes with Last-Event-ID", () => {
    let call = 0
    const http = fakeHttp(() => {
      call += 1
      // First connection: one event, then a frame that does not match the contract.
      return call === 1 ? sse([frame(step, "7"), 'data: {"_tag":"Bogus"}\n\n']) : sse([frame(done, "8")])
    })
    return Effect.gen(function* () {
      const events = yield* InvestigationEvents
      const fiber = yield* Stream.runCollect(events.stream(investigationId).pipe(Stream.take(4))).pipe(Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      const signals = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        signals.map((s) => (s._tag === "Event" ? s.event._tag : s._tag)),
        ["Connected", "StepStarted", "Connected", "StatusChanged"],
      )
      assert.strictEqual(http.requests.length, 2)
      assert.strictEqual(http.requests[0]?.headers["last-event-id"], undefined)
      assert.strictEqual(http.requests[1]?.headers["last-event-id"], "7")
    }).pipe(Effect.provide(layerWith(http)))
  })
})
