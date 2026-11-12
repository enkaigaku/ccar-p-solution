import { InvestigationEvent, type InvestigationId } from "@incident/contracts"
import { Context, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ApiBaseUrl } from "./ApiBaseUrl.ts"

/** The server has no event stream for this investigation (404/405/501). Not retried: callers fall back to polling. */
export class EventStreamUnavailable extends Schema.TaggedError<EventStreamUnavailable>()("EventStreamUnavailable", {
  status: Schema.Number,
}) {}

/** The stream broke (network error, 5xx, malformed event). Retried with backoff before it surfaces. */
export class EventStreamFailed extends Schema.TaggedError<EventStreamFailed>()("EventStreamFailed", {
  message: Schema.String,
}) {}

export type EventStreamError = EventStreamUnavailable | EventStreamFailed

/** What the live view receives: a marker each time a connection opens, then the decoded events. */
export type LiveSignal =
  | { readonly _tag: "Connected" }
  | { readonly _tag: "Event"; readonly event: InvestigationEvent; readonly id: string | undefined }

const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(InvestigationEvent))

const UNAVAILABLE_STATUSES = new Set([404, 405, 501])

/** Capped exponential backoff; gives up after 8 consecutive failures and never retries `EventStreamUnavailable`. */
export const reconnectSchedule = Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("10 seconds")]).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 8 }),
  Schedule.setInputType<EventStreamError>(),
  Schedule.while(({ input }) => input._tag === "EventStreamFailed"),
)

/**
 * Client for `GET /investigations/:id/events` (SSE; each `data:` is a JSON-encoded `InvestigationEvent`).
 *
 * Every event is decoded with the contract schema before it reaches the UI. The stream never completes on
 * its own: callers stop at a terminal status. On reconnect the last seen event id is sent as
 * `Last-Event-ID` so a server that supports it can resume instead of replaying.
 */
export class InvestigationEvents extends Context.Service<
  InvestigationEvents,
  {
    stream(id: InvestigationId): Stream.Stream<LiveSignal, EventStreamError>
  }
>()("@incident/web/InvestigationEvents") {
  static readonly layer = Layer.effect(
    InvestigationEvents,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const baseUrl = yield* ApiBaseUrl

      const connect = (id: InvestigationId, lastEventId: Option.Option<string>) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const request = HttpClientRequest.get(`${baseUrl}/investigations/${encodeURIComponent(id)}/events`).pipe(
              HttpClientRequest.setHeader("accept", "text/event-stream"),
              Option.match(lastEventId, {
                onNone: () => (r: HttpClientRequest.HttpClientRequest) => r,
                onSome: (value) => HttpClientRequest.setHeader("last-event-id", value),
              }),
            )
            const response = yield* http
              .execute(request)
              .pipe(Effect.mapError((error) => new EventStreamFailed({ message: error.message })))
            if (UNAVAILABLE_STATUSES.has(response.status)) {
              return yield* new EventStreamUnavailable({ status: response.status })
            }
            if (response.status < 200 || response.status >= 300) {
              return yield* new EventStreamFailed({ message: `event stream responded with ${response.status}` })
            }
            const events: Stream.Stream<LiveSignal, EventStreamFailed> = response.stream.pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapError(
                (error) =>
                  new EventStreamFailed({
                    message: error._tag === "Retry" ? "server asked the client to reconnect" : error.message,
                  }),
              ),
              // Decoded one event at a time, so a malformed event cannot drop valid ones that arrived in the
              // same chunk. It still fails the stream: contract drift should be loud, and the reconnect
              // resumes after the last good event.
              Stream.mapEffect((e) =>
                decodeEvent(e.data).pipe(
                  Effect.map((event): LiveSignal => ({ _tag: "Event", event, id: e.id })),
                  Effect.mapError(() => new EventStreamFailed({ message: "event does not match the contract" })),
                ),
              ),
            )
            // The live view stops reading once it sees a terminal status, so a stream that simply ends was
            // closed early (proxy timeout, server restart): treat it like a failure and reconnect.
            const closed = Stream.fail(new EventStreamFailed({ message: "event stream closed by the server" }))
            return Stream.succeed<LiveSignal>({ _tag: "Connected" }).pipe(Stream.concat(events), Stream.concat(closed))
          }),
        )

      const stream = (id: InvestigationId): Stream.Stream<LiveSignal, EventStreamError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const lastEventId = yield* Ref.make(Option.none<string>())
            return Stream.unwrap(Ref.get(lastEventId).pipe(Effect.map((last) => connect(id, last)))).pipe(
              Stream.tap((signal) =>
                signal._tag === "Event" && signal.id !== undefined
                  ? Ref.set(lastEventId, Option.some(signal.id))
                  : Effect.void,
              ),
              Stream.retry(reconnectSchedule),
            )
          }),
        )

      return InvestigationEvents.of({ stream })
    }),
  )
}
