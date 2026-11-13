import { assert, describe, it } from "@effect/vitest"
import { InvestigationId, StatusChanged, StepStarted } from "@incident/contracts"
import { Effect, Fiber, Layer, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { EventsRoute, parseLastEventId } from "../src/EventsRoute.ts"
import { InvestigationEvents } from "../src/events/InvestigationEvents.ts"
import { IncidentStore } from "../src/IncidentStore.ts"
import { webhook } from "./fixtures.ts"

const a = InvestigationId.make("inv-a")
const b = InvestigationId.make("inv-b")

describe("InvestigationEvents", () => {
  it.effect("replays history after a sequence number, then streams live events until a terminal status", () =>
    Effect.gen(function* () {
      const events = yield* InvestigationEvents
      yield* events.publish(new StatusChanged({ investigationId: a, status: "running" }))
      yield* events.publish(new StepStarted({ investigationId: b, step: "triage" }))
      yield* events.publish(new StepStarted({ investigationId: a, step: "triage" }))

      const fiber = yield* events.stream(a, 1).pipe(Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* events.publish(new StepStarted({ investigationId: a, step: "retrieve" }))
      yield* events.publish(new StatusChanged({ investigationId: a, status: "completed" }))
      yield* events.publish(new StepStarted({ investigationId: a, step: "report" }))
      const seen = yield* Fiber.join(fiber)

      assert.deepStrictEqual(
        seen.map((e) => e.seq),
        [2, 3, 4],
      )
      assert.deepStrictEqual(
        seen.map((e) => e.event._tag),
        ["StepStarted", "StepStarted", "StatusChanged"],
      )
      // A late subscriber of a finished investigation gets the history and an ended stream.
      const late = yield* events.stream(a).pipe(Stream.runCollect)
      assert.strictEqual(late.length, 4)
      // Resuming after the terminal event ends at once instead of waiting forever.
      const resumed = yield* events.stream(a, 4).pipe(Stream.runCollect)
      assert.strictEqual(resumed.length, 0)
      const beforeEnd = yield* events.stream(a, 3).pipe(Stream.runCollect)
      assert.deepStrictEqual(
        beforeEnd.map((e) => e.seq),
        [4],
      )
    }).pipe(Effect.provide(InvestigationEvents.layer)),
  )

  it("parses Last-Event-ID defensively", () => {
    assert.strictEqual(parseLastEventId("12"), 12)
    assert.strictEqual(parseLastEventId(undefined), 0)
    assert.strictEqual(parseLastEventId("abc"), 0)
    assert.strictEqual(parseLastEventId("-1"), 0)
  })
})

describe("GET /investigations/:id/events", () => {
  it.effect("serves SSE with sequence ids and 404 for unknown investigations", () =>
    Effect.gen(function* () {
      const store = yield* IncidentStore
      const events = yield* InvestigationEvents
      const [alertId] = yield* store.ingestWebhook(webhook)
      const investigation = yield* store.startInvestigation(alertId!)
      yield* events.publish(new StatusChanged({ investigationId: investigation.id, status: "running" }))
      yield* events.publish(new StatusChanged({ investigationId: investigation.id, status: "failed" }))

      const { handler, dispose } = HttpRouter.toWebHandler(
        EventsRoute.pipe(
          Layer.provide(Layer.succeed(IncidentStore, store)),
          Layer.provide(Layer.succeed(InvestigationEvents, events)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      )
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`http://localhost/investigations/${investigation.id}/events`, {
            headers: { "last-event-id": "1" },
          }),
        ),
      )
      assert.strictEqual(response.status, 200)
      assert.include(response.headers.get("content-type") ?? "", "text/event-stream")
      const body = yield* Effect.promise(() => response.text())
      assert.include(body, "id: 2")
      assert.notInclude(body, "id: 1\n")
      assert.include(body, '"status":"failed"')

      const missing = yield* Effect.promise(() => handler(new Request("http://localhost/investigations/nope/events")))
      assert.strictEqual(missing.status, 404)
      yield* Effect.promise(dispose)
    }).pipe(Effect.provide(Layer.mergeAll(IncidentStore.layerMemory, InvestigationEvents.layer))),
  )
})
