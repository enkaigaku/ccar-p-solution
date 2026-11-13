import { createHash } from "node:crypto"
import { type RecordedToolCall, ReplaySnapshot } from "@incident/contracts"
import { DateTime, Duration, Effect, FileSystem, Path, Schedule, Schema } from "effect"
import { FaultCase } from "../dataset/EvalCase.ts"
import { materializeSnapshot } from "../dataset/materialize.ts"
import { type Fault, Flagd } from "./Flagd.ts"
import { type McpCallError, ObservabilityMcp, recordCall } from "./ObservabilityMcp.ts"
import { errorRate, p95, requestRate, type Scenario } from "./scenarios.ts"

export interface RecordOptions {
  /** Package root: snapshots go to `fixtures/replay/`, cases to `datasets/fault/`. */
  readonly root: string
  readonly triggerTimeout: Duration.Duration
  readonly pollEvery: Duration.Duration
  /** How long to keep the fault on after the trigger fires, so post-alert telemetry is captured too. */
  readonly afterTrigger: Duration.Duration
  /** Telemetry before the trigger to include in the window. */
  readonly lookback: Duration.Duration
}

export class TriggerTimeout extends Schema.TaggedError<TriggerTimeout>()("TriggerTimeout", {
  scenario: Schema.String,
  promql: Schema.String,
  /** What the recorder saw, so a threshold can be tuned from the error alone. */
  message: Schema.String,
}) {}

/** Healthy telemetry kept before the injection, so the agent can compare before and after. */
export const PRE_FAULT = Duration.minutes(4)

const iso = (dt: DateTime.Utc) => DateTime.formatIso(dt)

/** Opaque, stable id: same scenario at the same trigger time gives the same id, and the name reveals nothing. */
export const opaqueId = (prefix: "fc", scenario: string, at: DateTime.Utc) =>
  `${prefix}-${createHash("sha256")
    .update(`${scenario}@${iso(at)}`)
    .digest("hex")
    .slice(0, 8)}`

const TraceIdPattern = /\b[0-9a-f]{32}\b/g

/** Every flag a scenario turns on: its fault first, then the distractors. */
export const faultsOf = (scenario: Scenario): ReadonlyArray<Fault> => [
  { flag: scenario.flag, variant: scenario.variant },
  ...scenario.distractors.map((d) => ({ flag: d.flag, variant: d.variant })),
]

/** The trigger query's current value: the largest `last` across its series, or undefined without data. */
const triggerValue = (scenario: Scenario) =>
  Effect.gen(function* () {
    const mcp = yield* ObservabilityMcp
    const now = yield* DateTime.now
    const result = yield* mcp.call("query_metrics", {
      promql: scenario.trigger.promql,
      start: iso(DateTime.subtractDuration(now, Duration.minutes(3))),
      end: iso(now),
      stepSeconds: 15,
    })
    const values = result.series.map((s) => s.last).filter((v) => Number.isFinite(v))
    return values.length === 0 ? undefined : Math.max(...values)
  })

const show = (value: number | undefined) => (value === undefined ? "no data" : String(value))

/**
 * Polls the trigger query until it is more than the threshold above `baseline` (its value before the fault was
 * injected; no data counts as 0), standing in for the alert rule.
 */
const waitForTrigger = (scenario: Scenario, baseline: number | undefined, options: RecordOptions) =>
  Effect.gen(function* () {
    const limit = (baseline ?? 0) + scenario.trigger.threshold
    let highest: number | undefined
    const check = triggerValue(scenario).pipe(
      Effect.map((value) => {
        if (value !== undefined && (highest === undefined || value > highest)) highest = value
        return value !== undefined && value > limit
      }),
    )
    const fired = yield* check.pipe(
      Effect.repeat({ until: (fired: boolean) => fired, schedule: Schedule.spaced(options.pollEvery) }),
      Effect.timeoutOption(options.triggerTimeout),
    )
    if (fired._tag === "None") {
      return yield* new TriggerTimeout({
        scenario: scenario.name,
        promql: scenario.trigger.promql,
        message: `${scenario.name}: trigger stayed at or below ${limit} (baseline ${show(baseline)}, highest seen ${show(highest)}) for ${scenario.trigger.promql}`,
      })
    }
    return yield* DateTime.now
  })

/** The fixed battery of tool calls recorded for every scenario. Missing traces are skipped, other errors fail. */
const battery = (scenario: Scenario, start: string, end: string) =>
  Effect.gen(function* () {
    const mcp = yield* ObservabilityMcp
    const topology = yield* mcp.call("get_service_topology", {})
    const neighbours = topology.edges
      .filter((e) => e.from === scenario.alert.service || e.to === scenario.alert.service)
      .flatMap((e) => [e.from, e.to])
    const services = [...new Set([scenario.alert.service, ...scenario.focus, ...neighbours])].sort()

    const calls: Array<RecordedToolCall> = [
      { tool: "get_service_topology", input: {}, output: topology },
      yield* recordCall("get_service_topology", { service: scenario.alert.service }),
      yield* recordCall("get_service_status", {}),
      yield* recordCall("query_metrics", { promql: scenario.trigger.promql, start, end, stepSeconds: 30 }),
    ]
    for (const service of services) {
      for (const promql of [errorRate(service), requestRate(service), p95(service)]) {
        calls.push(yield* recordCall("query_metrics", { promql, start, end, stepSeconds: 30 }))
      }
      // `level` is an exact filter, and services log failures at either level; the unfiltered call answers a query
      // that names no level.
      for (const level of ["error", "warn"] as const) {
        calls.push(yield* recordCall("query_logs", { service, start, end, level, limit: 20 }))
      }
      calls.push(yield* recordCall("query_logs", { service, start, end, limit: 20 }))
    }

    const traceIds = new Set<string>()
    for (const call of calls) {
      if (call.tool !== "query_logs") continue
      for (const sample of call.output.samples)
        for (const id of sample.line.match(TraceIdPattern) ?? []) traceIds.add(id)
    }
    for (const traceId of [...traceIds].slice(0, 5)) {
      const trace = yield* recordCall("get_trace", { traceId }).pipe(
        Effect.map((call): RecordedToolCall | undefined => call),
        Effect.catchIf(
          (e): e is McpCallError => e._tag === "McpCallError" && e.toolError,
          () => Effect.succeed(undefined),
        ),
      )
      if (trace !== undefined) calls.push(trace)
    }
    return calls
  })

/**
 * Records one scenario: inject → wait for trigger → keep the fault on briefly → record → clear the flag.
 * The flag is cleared even when recording fails.
 */
export const recordScenario = Effect.fn("evals.recordScenario")(function* (scenario: Scenario, options: RecordOptions) {
  const flagd = yield* Flagd
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const recorded = yield* Effect.gen(function* () {
    const baseline = yield* triggerValue(scenario)
    const injectedAt = yield* DateTime.now
    const faults = faultsOf(scenario)
    yield* flagd.set(faults)
    yield* Effect.logInfo(
      `${scenario.name}: ${faults.map((f) => `${f.flag}=${f.variant}`).join(", ")}, waiting for trigger (baseline ${show(baseline)})`,
    )
    const firedAt = yield* waitForTrigger(scenario, baseline, options)
    yield* Effect.sleep(options.afterTrigger)
    const end = yield* DateTime.now
    // The window must not reach back into the previous scenario's fault: it starts at most PRE_FAULT before this
    // injection, and the cooldown before a scenario has to cover PRE_FAULT plus the rate windows (see BatchOptions).
    const start = DateTime.max(
      DateTime.subtractDuration(firedAt, options.lookback),
      DateTime.subtractDuration(injectedAt, PRE_FAULT),
    )
    const calls = yield* battery(scenario, iso(start), iso(end))
    return { firedAt, start, end, calls }
  }).pipe(Effect.ensuring(Effect.ignore(flagd.reset)))

  const id = opaqueId("fc", scenario.name, recorded.firedAt)
  const snapshot = new ReplaySnapshot({
    version: 1,
    caseId: id,
    recordedAt: recorded.end,
    window: { start: recorded.start, end: recorded.end },
    alert: {
      status: "firing",
      labels: { alertname: scenario.alert.alertname, service: scenario.alert.service, severity: "critical" },
      annotations: { summary: scenario.alert.summary },
      startsAt: iso(recorded.firedAt),
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: id.slice(3),
    },
    calls: recorded.calls,
  })
  yield* materializeSnapshot(path.join(options.root, "fixtures", "replay"), snapshot)

  const faultCase = new FaultCase({
    kind: "fault",
    id,
    snapshotId: id,
    smoke: false,
    groundTruth: {
      rootCause: scenario.rootCause.text,
      service: scenario.rootCause.service,
      acceptableAlternatives: scenario.rootCause.alternatives,
      fault: { flag: scenario.flag, variant: scenario.variant },
      ...(scenario.distractors.length > 0 ? { distractors: scenario.distractors } : {}),
    },
    expect: { insufficientInformation: false, forbiddenActions: [] },
    tags: [scenario.name, scenario.rootCause.service, ...(scenario.distractors.length > 0 ? ["distractor"] : [])],
    synthetic: false,
  })
  const caseFile = path.join(options.root, "datasets", "fault", `${id}.json`)
  const json = yield* Schema.encodeEffect(Schema.fromJsonString(FaultCase))(faultCase)
  yield* fs.writeFileString(caseFile, `${JSON.stringify(JSON.parse(json), null, 2)}\n`)
  yield* Effect.logInfo(`${scenario.name}: recorded ${recorded.calls.length} calls as ${id}`)
  return { id, calls: recorded.calls.length }
})

export interface BatchOptions extends RecordOptions {
  /**
   * Wait between scenarios, and after clearing a leftover fault. It has to be longer than PRE_FAULT plus the 3 minute
   * rate window plus about a minute of metric delay, or a snapshot contains the previous scenario's fault.
   */
  readonly cooldown: Duration.Duration
}

/** A batch gives up after this many scenarios in a row fail on the observability backends. */
export const MAX_CONSECUTIVE_BACKEND_FAILURES = 3

/**
 * Records scenarios one after another, for hours when the whole catalogue is recorded. Before anything is injected,
 * every flag and variant is checked against the flag file. A scenario whose trigger never fires is reported and
 * skipped, so it does not cost the recordings after it. So is one that fails on a tool call (a backend hiccup), but
 * MAX_CONSECUTIVE_BACKEND_FAILURES of those in a row stop the batch: the backends are down. Any other error stops
 * the batch. Baselines are only measured on a clean system: a fault left on by a manual injection or a killed run is
 * cleared first and given the cooldown to drain.
 */
export const recordBatch = Effect.fn("evals.recordBatch")(function* (
  scenarios: ReadonlyArray<Scenario>,
  options: BatchOptions,
) {
  const flagd = yield* Flagd
  yield* flagd.validate(scenarios.flatMap(faultsOf))
  const recorded: Array<{ readonly scenario: string; readonly id: string; readonly calls: number }> = []
  const failed: Array<string> = []
  let backendFailures = 0
  for (const [i, scenario] of scenarios.entries()) {
    if (i === 0) {
      if (yield* flagd.reset) {
        yield* Effect.logWarning("A fault was still on; cleared it and waiting for its telemetry to drain")
        yield* Effect.sleep(options.cooldown)
      }
    } else {
      yield* Effect.sleep(options.cooldown)
    }
    yield* Effect.logInfo(`[${i + 1}/${scenarios.length}] ${scenario.name}`)
    const result = yield* recordScenario(scenario, options).pipe(
      Effect.catchTag("TriggerTimeout", (error) => Effect.logError(error.message).pipe(Effect.as(undefined))),
      // A recording or a trigger timeout both mean the backends answered, so only failures in a row count.
      Effect.tap(() =>
        Effect.sync(() => {
          backendFailures = 0
        }),
      ),
      Effect.catchTag("McpCallError", (error) => {
        backendFailures += 1
        return backendFailures >= MAX_CONSECUTIVE_BACKEND_FAILURES
          ? Effect.fail(error)
          : Effect.logError(`${scenario.name}: ${error.tool} failed: ${error.message}`).pipe(Effect.as(undefined))
      }),
    )
    if (result === undefined) failed.push(scenario.name)
    else recorded.push({ scenario: scenario.name, ...result })
  }
  return { recorded, failed }
})
