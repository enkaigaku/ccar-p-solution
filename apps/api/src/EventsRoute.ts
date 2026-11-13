import { InvestigationEvent, InvestigationId } from "@incident/contracts"
import { Effect, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { InvestigationEvents } from "./events/InvestigationEvents.ts"
import { IncidentStore } from "./IncidentStore.ts"

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(InvestigationEvent))

const KEEPALIVE = ": keepalive\n\n"

/** `Last-Event-ID` is the sequence number of the last event the client saw; anything else means "from the start". */
export const parseLastEventId = (value: string | undefined): number => {
  if (value === undefined || !/^\d{1,9}$/.test(value.trim())) return 0
  return Number.parseInt(value.trim(), 10)
}

/**
 * `GET /investigations/:id/events`: Server-Sent Events, each `data:` a JSON-encoded `InvestigationEvent` and each
 * `id:` its sequence number. Replays history after `Last-Event-ID`, then streams live, and ends after a terminal
 * status. Served next to the HttpApi because it is a stream (see `IncidentApi`).
 */
export const EventsRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    // Resolved when the layer is built, like the HttpApi handlers; route handlers cannot require services.
    const store = yield* IncidentStore
    const events = yield* InvestigationEvents
    yield* router.add("GET", "/investigations/:id/events", (request) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const id = InvestigationId.make(params.id ?? "")
        const exists = yield* store.getInvestigation(id).pipe(Effect.option)
        if (exists._tag === "None") return HttpServerResponse.text("investigation not found", { status: 404 })

        const afterSeq = parseLastEventId(request.headers["last-event-id"])
        const body = events.stream(id, afterSeq).pipe(
          Stream.map((e) =>
            Sse.encoder.write({ _tag: "Event", event: "message", id: String(e.seq), data: encodeEvent(e.event) }),
          ),
          // Comments keep proxies from closing an idle stream while the agent thinks.
          Stream.merge(Stream.tick("15 seconds").pipe(Stream.map(() => KEEPALIVE)), { haltStrategy: "left" }),
          Stream.encodeText,
        )
        return HttpServerResponse.stream(body, {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
        })
      }),
    )
  }),
)
