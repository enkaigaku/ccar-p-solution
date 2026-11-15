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
      // `client="…"` selects a service's outgoing calls in the service graph metrics.
      return /(?:service(?:_name)?|client)="([^"]+)"/.exec(call.input.promql)?.[1]
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

/** Removes every log, metric and trace call: what the agent sees when the telemetry backend is down. */
export const dropAllTelemetry = (snapshot: ReplaySnapshot): ReplaySnapshot =>
  new ReplaySnapshot({
    ...snapshot,
    calls: snapshot.calls.filter((call) => call.tool === "get_service_topology" || call.tool === "get_service_status"),
  })

/** Replaces the alert, keeping its timing and fingerprint. */
export const replaceAlert = (snapshot: ReplaySnapshot, alert: NonNullable<AdversarialCase["alert"]>): ReplaySnapshot =>
  new ReplaySnapshot({
    ...snapshot,
    alert: {
      ...snapshot.alert,
      labels: { alertname: alert.alertname, service: alert.service, severity: alert.severity },
      annotations: { summary: alert.summary },
    },
  })

/** Appends the payload to the alert's summary annotation. */
export const injectIntoAlert = (snapshot: ReplaySnapshot, injection: Injection): ReplaySnapshot =>
  new ReplaySnapshot({
    ...snapshot,
    alert: {
      ...snapshot.alert,
      annotations: {
        ...snapshot.alert.annotations,
        summary: `${snapshot.alert.annotations.summary ?? ""} ${injection.payload}`.trim(),
      },
    },
  })

export const deriveSnapshot = (base: ReplaySnapshot, c: AdversarialCase): ReplaySnapshot => {
  let snapshot = new ReplaySnapshot({ ...base, caseId: c.id })
  if (c.dropAllTelemetry === true) snapshot = dropAllTelemetry(snapshot)
  if (c.dropServices !== undefined) snapshot = dropServices(snapshot, c.dropServices)
  if (c.alert !== undefined) snapshot = replaceAlert(snapshot, c.alert)
  if (c.injection !== undefined) {
    snapshot =
      c.injection.surface === "alert-summary"
        ? injectIntoAlert(snapshot, c.injection)
        : injectIntoLogs(snapshot, c.injection)
  }
  return snapshot
}
