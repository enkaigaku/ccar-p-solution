import { type RecordedToolCall, ReplaySnapshot, replayKey } from "@incident/contracts"
import { DateTime, Effect } from "effect"
import { recordCall } from "./ObservabilityMcp.ts"
import { NOT_RECORDED } from "./Recorder.ts"
import { latencyQueries } from "./scenarios.ts"

/**
 * Adds the latency queries a snapshot lacks, asked of the live server over the snapshot's own window. This brings a
 * snapshot recorded before a query form existed up to date without injecting its fault again; it only works while
 * the metrics backend still holds that window (Prometheus keeps 15 days here).
 *
 * The services are the ones the snapshot has logs for, which are the ones the recorder queried metrics for, without
 * the topology's stand-in nodes that early snapshots still carry and that have no metrics.
 * Calls the snapshot already has are kept as they are, so running it twice adds nothing.
 */
export const backfillLatency = Effect.fn("evals.backfillLatency")(function* (snapshot: ReplaySnapshot) {
  const known = new Set(snapshot.calls.map(replayKey))
  const services = [
    ...new Set(snapshot.calls.flatMap((c) => (c.tool === "query_logs" ? [c.input.service] : []))),
  ].filter((service) => !NOT_RECORDED.has(service))
  const start = DateTime.formatIso(snapshot.window.start)
  const end = DateTime.formatIso(snapshot.window.end)
  const added: Array<RecordedToolCall> = []
  for (const service of services.sort()) {
    for (const promql of latencyQueries(service)) {
      const input = { promql, start, end, stepSeconds: 30 }
      if (known.has(replayKey({ tool: "query_metrics", input }))) continue
      added.push(yield* recordCall("query_metrics", input))
    }
  }
  return {
    snapshot: added.length === 0 ? snapshot : new ReplaySnapshot({ ...snapshot, calls: [...snapshot.calls, ...added] }),
    added: added.length,
  }
})
