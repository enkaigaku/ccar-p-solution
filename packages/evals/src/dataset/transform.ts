import { ReplaySnapshot } from "@incident/contracts"
import { DateTime } from "effect"
import type { AdversarialCase, Injection } from "./EvalCase.ts"

/**
 * Adversarial cases reuse a recorded fault snapshot and change what replay returns, so they need no extra recording.
 * The derived snapshot is written to a scratch REPLAY_DIR before the agent runs.
 */

/** Plants the payload as the newest error sample of every `query_logs` result for the injected service. */
export const injectIntoLogs = (snapshot: ReplaySnapshot, injection: Injection): ReplaySnapshot =>
  new ReplaySnapshot({
    ...snapshot,
    calls: snapshot.calls.map((call) => {
      if (call.tool !== "query_logs" || call.input.service !== injection.service) return call
      const planted = {
        ref: `${call.output.ref}#injected`,
        timestamp: DateTime.formatIso(snapshot.window.end),
        line: injection.payload,
      }
      return {
        ...call,
        output: {
          ...call.output,
          totalMatched: call.output.totalMatched + 1,
          samples: [planted, ...call.output.samples],
        },
      }
    }),
  })

const callService = (call: ReplaySnapshot["calls"][number]): string | undefined => {
  switch (call.tool) {
    case "query_logs":
    case "get_service_status":
    case "get_service_topology":
      return call.input.service
    case "query_metrics":
      return /service(?:_name)?="([^"]+)"/.exec(call.input.promql)?.[1]
    case "get_trace":
      return call.output.rootService
  }
}

/** Removes every recorded call about the given services, so the agent cannot see the fault's evidence. */
export const dropServices = (snapshot: ReplaySnapshot, services: ReadonlyArray<string>): ReplaySnapshot => {
  const dropped = new Set(services)
  return new ReplaySnapshot({
    ...snapshot,
    calls: snapshot.calls.filter((call) => {
      const service = callService(call)
      return service === undefined || !dropped.has(service)
    }),
  })
}

export const deriveSnapshot = (base: ReplaySnapshot, c: AdversarialCase): ReplaySnapshot => {
  let snapshot = new ReplaySnapshot({ ...base, caseId: c.id })
  if (c.dropServices !== undefined) snapshot = dropServices(snapshot, c.dropServices)
  if (c.injection !== undefined) snapshot = injectIntoLogs(snapshot, c.injection)
  return snapshot
}
