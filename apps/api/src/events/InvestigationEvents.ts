import type { InvestigationEvent, InvestigationId, InvestigationStatus } from "@incident/contracts"
import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect"

/** An event with its position in the investigation's history; the SSE `id`, used for `Last-Event-ID`. */
export interface SequencedEvent {
  readonly seq: number
  readonly event: InvestigationEvent
}

const TERMINAL: ReadonlySet<InvestigationStatus> = new Set(["completed", "insufficient_information", "failed"])

export const isTerminalEvent = (event: InvestigationEvent): boolean =>
  event._tag === "StatusChanged" && TERMINAL.has(event.status)

/**
 * In-process event log per investigation plus live fan-out. A subscriber first receives the history after
 * `afterSeq` (so a page opened mid-investigation, or a reconnect, catches up), then live events. The stream
 * completes after a terminal `StatusChanged`.
 */
export class InvestigationEvents extends Context.Service<
  InvestigationEvents,
  {
    publish(event: InvestigationEvent): Effect.Effect<void>
    stream(id: InvestigationId, afterSeq?: number): Stream.Stream<SequencedEvent>
  }
>()("@incident/api/events/InvestigationEvents") {
  static readonly layer = Layer.effect(
    InvestigationEvents,
    Effect.gen(function* () {
      const history = yield* Ref.make(new Map<InvestigationId, ReadonlyArray<SequencedEvent>>())
      const pubsub = yield* PubSub.unbounded<SequencedEvent>()
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

      const publish = (event: InvestigationEvent) =>
        Ref.modify(history, (map) => {
          const previous = map.get(event.investigationId) ?? []
          const sequenced: SequencedEvent = { seq: previous.length + 1, event }
          return [sequenced, new Map(map).set(event.investigationId, [...previous, sequenced])]
        }).pipe(
          Effect.flatMap((sequenced) => PubSub.publish(pubsub, sequenced)),
          Effect.asVoid,
        )

      const stream = (id: InvestigationId, afterSeq = 0): Stream.Stream<SequencedEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the history: an event published in between shows up in both and is
            // dropped from the live part by its sequence number, so nothing is lost or duplicated.
            const subscription = yield* PubSub.subscribe(pubsub)
            const past = ((yield* Ref.get(history)).get(id) ?? []).filter((e) => e.seq > afterSeq)
            const last = past.at(-1)?.seq ?? afterSeq
            if (past.some((e) => isTerminalEvent(e.event))) {
              return Stream.fromIterable(past).pipe(Stream.takeUntil((e) => isTerminalEvent(e.event)))
            }
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter((e) => e.event.investigationId === id && e.seq > last),
            )
            return Stream.fromIterable(past).pipe(
              Stream.concat(live),
              Stream.takeUntil((e) => isTerminalEvent(e.event)),
            )
          }),
        )

      return InvestigationEvents.of({ publish, stream })
    }),
  )
}
