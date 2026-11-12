import { IncidentApi, InvestigationId, type ReplaySnapshot } from "@incident/contracts"
import { Clock, Config, Context, Duration, Effect, FileSystem, flow, Layer, Path, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { AgentRun, type EvalCase } from "../dataset/EvalCase.ts"
import { materializeSnapshot } from "../dataset/materialize.ts"

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  caseId: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The system being evaluated. promptfoo calls it once per case with the snapshot that replay will serve.
 * `layerStub` is a deterministic heuristic baseline (no model calls); `layerApi` drives the real api over HTTP.
 */
export class AgentUnderTest extends Context.Service<
  AgentUnderTest,
  {
    readonly name: string
    run(c: EvalCase, snapshot: ReplaySnapshot): Effect.Effect<AgentRun, AgentError>
  }
>()("@incident/evals/agent/AgentUnderTest") {
  static readonly layerStub = Layer.succeed(
    AgentUnderTest,
    AgentUnderTest.of({ name: "stub", run: (_, snapshot) => Effect.succeed(stubInvestigate(snapshot)) }),
  )

  static readonly layerApi = Layer.effect(
    AgentUnderTest,
    Effect.gen(function* () {
      const baseUrl = yield* Config.String("EVAL_API_URL").pipe(Config.withDefault("http://localhost:3000"))
      const replayDir = yield* Config.String("EVAL_REPLAY_DIR").pipe(Config.withDefault(".replay"))
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const timeout = yield* Config.Duration("EVAL_INVESTIGATION_TIMEOUT").pipe(Config.withDefault(Duration.minutes(3)))
      const client = yield* HttpApiClient.make(IncidentApi, {
        transformClient: (c) =>
          c.pipe(
            HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(baseUrl))),
            HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 3 }),
          ),
      })

      const run = Effect.fn("AgentUnderTest.api.run")(
        function* (c: EvalCase, snapshot: ReplaySnapshot) {
          // The api's mcp-observability must run with REPLAY_DIR=<EVAL_REPLAY_DIR> and serve this case.
          yield* materializeSnapshot(replayDir, snapshot).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
          const startedAt = yield* Clock.currentTimeMillis
          // The case id is opaque, so using it as the fingerprint leaks nothing and keeps alerts distinct per case.
          const alert = { ...snapshot.alert, fingerprint: c.id }
          const { accepted } = yield* client.alerts.webhook({
            payload: { version: "4", status: "firing", receiver: "incident-copilot-evals", alerts: [alert] },
          })
          const alertId = accepted[0]
          if (alertId === undefined)
            return yield* new AgentError({ caseId: c.id, message: "webhook accepted no alert" })
          const started = yield* client.investigations.start({ payload: { alertId } })
          const id = InvestigationId.make(started.id)
          const done = yield* client.investigations.get({ params: { id } }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (inv) => inv.status !== "queued" && inv.status !== "running",
            }),
            Effect.timeout(timeout),
          )
          const proposals = yield* client.investigations.proposals({ params: { id } })
          const finishedAt = yield* Clock.currentTimeMillis
          return new AgentRun({
            status: done.status === "queued" || done.status === "running" ? "failed" : done.status,
            hypotheses: done.hypotheses.map((h) => ({
              summary: h.summary,
              confidence: h.confidence,
              evidence: h.evidence.map((e) => ({ kind: e.kind, ref: e.ref })),
            })),
            proposals: proposals.map((p) => p.action),
            // Not exposed by IncidentApi yet; chunk citations fail until it is (tracked for M2 integration).
            retrievedChunkIds: [],
            // Cost comes from traces in M2; until then the budget guard keeps its estimate.
            usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
            latencyMs: finishedAt - startedAt,
            model: done.model,
            promptVersion: done.promptVersion,
          })
        },
        (effect, c) =>
          Effect.mapError(effect, (cause) => new AgentError({ caseId: c.id, message: String(cause), cause })),
      )

      return AgentUnderTest.of({ name: `api:${baseUrl}`, run })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

/**
 * Heuristic baseline: blame the service with the most error logs and cite that log result.
 * Any real agent should beat it; it also lets the whole pipeline run in CI for free.
 */
export const stubInvestigate = (snapshot: ReplaySnapshot): AgentRun => {
  const errorLogs = snapshot.calls
    .flatMap((call) => (call.tool === "query_logs" ? [call] : []))
    .map((call) => ({ call, errors: call.output.countsByLevel.error ?? 0 }))
    .filter((x) => x.errors > 0)
    .sort((a, b) => b.errors - a.errors || a.call.input.service.localeCompare(b.call.input.service))
  const base = {
    proposals: [],
    retrievedChunkIds: [],
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
    model: "stub",
    promptVersion: "stub",
  }
  if (errorLogs.length === 0) return new AgentRun({ ...base, status: "insufficient_information", hypotheses: [] })
  const total = errorLogs.reduce((sum, x) => sum + x.errors, 0)
  return new AgentRun({
    ...base,
    status: "completed",
    hypotheses: errorLogs.slice(0, 3).map(({ call, errors }) => ({
      summary: `${call.input.service} is failing: ${call.output.topMessages[0]?.pattern ?? "errors in logs"}`,
      confidence: errors / total,
      evidence: [{ kind: "log", ref: call.output.ref }],
    })),
  })
}
