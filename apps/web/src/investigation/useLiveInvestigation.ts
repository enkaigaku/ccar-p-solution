import type { ActionProposal, Investigation, InvestigationId } from "@incident/contracts"
import { DateTime, Effect, Schedule, Stream } from "effect"
import { useEffect, useReducer, useState } from "react"
import { describeError } from "../lib/errors.ts"
import { IncidentClient } from "../lib/IncidentClient.ts"
import { InvestigationEvents } from "../lib/InvestigationEvents.ts"
import { runtime } from "../lib/runtime.ts"
import { initialState, isTerminal, type LiveAction, type LiveState, reduce } from "./live.ts"

/** Snapshot refresh interval when the API has no SSE route (the M1 in-memory api). */
const POLL_INTERVAL = "3 seconds"

/** Backoff for snapshot requests: 1 s doubling up to 30 s, about ten minutes in total before giving up. */
export const snapshotRetrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered, Schedule.upTo({ times: 20 }))

/**
 * Feeds the investigation page: SSE events when the API streams them, otherwise snapshot polling.
 * Both paths stop once the investigation reaches a terminal status. A finished investigation is still
 * connected once, so a server that replays past events can show how the conclusion was reached.
 */
export const liveInvestigation = (id: InvestigationId, dispatch: (action: LiveAction) => void) =>
  Effect.gen(function* () {
    const events = yield* InvestigationEvents
    const client = yield* IncidentClient

    const snapshot = Effect.all({
      investigation: client.investigations.get({ params: { id } }),
      proposals: client.investigations.proposals({ params: { id } }),
    }).pipe(
      Effect.tap((s) => Effect.sync(() => dispatch({ _tag: "Snapshot", ...s }))),
      // A transient network error or 5xx must not stop updates for good; only a missing investigation is final.
      Effect.retry(($) =>
        $(snapshotRetrySchedule).pipe(Schedule.while(({ input }) => input._tag !== "InvestigationNotFound")),
      ),
    )

    const poll = Effect.sync(() => dispatch({ _tag: "Connection", connection: "polling" })).pipe(
      Effect.andThen(
        snapshot.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(POLL_INTERVAL),
            until: (s) => isTerminal(s.investigation.status),
          }),
        ),
      ),
    )

    yield* events.stream(id).pipe(
      Stream.takeUntil(
        (signal) => signal._tag === "Event" && signal.event._tag === "StatusChanged" && isTerminal(signal.event.status),
      ),
      Stream.runForEach((signal) =>
        signal._tag === "Connected"
          ? Effect.sync(() => dispatch({ _tag: "Connection", connection: "live" }))
          : DateTime.now.pipe(
              Effect.flatMap((receivedAt) =>
                Effect.sync(() => dispatch({ _tag: "Event", event: signal.event, receivedAt })),
              ),
            ),
      ),
      // The stream closing normally may race with the final status; a snapshot settles it.
      Effect.andThen(snapshot),
      Effect.andThen(Effect.sync(() => dispatch({ _tag: "Connection", connection: "ended" }))),
      Effect.catchTag("EventStreamUnavailable", () => poll),
    )
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => dispatch({ _tag: "Connection", connection: "error", message: describeError(error) })),
    ),
  )

export const useLiveInvestigation = (
  investigation: Investigation,
  proposals: ReadonlyArray<ActionProposal>,
): readonly [LiveState, (action: LiveAction) => void, () => void] => {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState(investigation, proposals))

  const id = investigation.id
  // Bumped by `reconnect` so the user can restart the feed after it gave up.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (attempt > 0) dispatch({ _tag: "Connection", connection: "connecting" })
    const cancel = runtime.runCallback(liveInvestigation(id, dispatch))
    return () => cancel()
  }, [id, attempt])

  return [state, dispatch, () => setAttempt((n) => n + 1)]
}
