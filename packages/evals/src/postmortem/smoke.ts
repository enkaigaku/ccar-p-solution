import { Feedback, IncidentApi, InvestigationId, type PostmortemDraft, type ReplaySnapshot } from "@incident/contracts"
import { Config, Context, Duration, Effect, FileSystem, flow, Layer, Path, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { BudgetPolicy } from "../budget/Budget.ts"
import type { EvalCase, JudgedTruth } from "../dataset/EvalCase.ts"
import { materializeSnapshot } from "../dataset/materialize.ts"
import { Judge, type Verdict } from "../judge/Judge.ts"

/** What one postmortem draft costs on top of the investigation it is written from (Sonnet, one short request). */
export const PostmortemDraftEstimateUsd = 0.05

/** Estimated spend of a smoke run: per case one investigation, one draft and one judge call. */
export const estimatePostmortemSmokeUsd = (cases: number): number =>
  cases * (BudgetPolicy.perCaseUsd.investigation + PostmortemDraftEstimateUsd + BudgetPolicy.perCaseUsd.judge)

export class PostmortemSmokeError extends Schema.TaggedError<PostmortemSmokeError>()("PostmortemSmokeError", {
  caseId: Schema.String,
  message: Schema.String,
}) {}

export interface DraftedPostmortem {
  readonly investigationStatus: string
  readonly investigationCostUsd: number
  readonly draft: PostmortemDraft
}

export interface PostmortemSmokeCase {
  readonly case: EvalCase
  readonly truth: JudgedTruth
  readonly snapshot: ReplaySnapshot
}

/**
 * Where a postmortem draft for a case comes from. `layerApi` drives the real api: it replays the case's snapshot
 * through an investigation, files the labelled root cause as the responder's feedback, and asks for the draft.
 */
export class PostmortemSource extends Context.Service<
  PostmortemSource,
  {
    draft(input: PostmortemSmokeCase): Effect.Effect<DraftedPostmortem, PostmortemSmokeError>
  }
>()("@incident/evals/postmortem/PostmortemSource") {
  static readonly layerApi = Layer.effect(
    PostmortemSource,
    Effect.gen(function* () {
      const baseUrl = yield* Config.String("EVAL_API_URL").pipe(Config.withDefault("http://localhost:3000"))
      const replayDir = yield* Config.String("EVAL_REPLAY_DIR").pipe(Config.withDefault(".replay"))
      const timeout = yield* Config.Duration("EVAL_INVESTIGATION_TIMEOUT").pipe(Config.withDefault(Duration.minutes(3)))
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const client = yield* HttpApiClient.make(IncidentApi, {
        transformClient: (c) =>
          c.pipe(
            HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(baseUrl))),
            HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 3 }),
          ),
      })

      const draft = Effect.fn("PostmortemSource.api.draft")(
        function* ({ case: c, truth, snapshot }: PostmortemSmokeCase) {
          // The api's mcp-observability must run with REPLAY_DIR=<EVAL_REPLAY_DIR> and serve this case.
          yield* materializeSnapshot(replayDir, snapshot).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
          const alert = { ...snapshot.alert, fingerprint: c.id }
          const { accepted } = yield* client.alerts.webhook({
            payload: { version: "4", status: "firing", receiver: "incident-copilot-evals", alerts: [alert] },
          })
          const alertId = accepted[0]
          if (alertId === undefined) {
            return yield* new PostmortemSmokeError({ caseId: c.id, message: "webhook accepted no alert" })
          }
          const started = yield* client.investigations.start({ payload: { alertId } })
          const id = InvestigationId.make(started.id)
          const done = yield* client.investigations.get({ params: { id } }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (inv) => inv.status !== "queued" && inv.status !== "running",
            }),
            Effect.timeout(timeout),
          )
          // The responder's correction. The draft has to take its root cause from here, whatever the agent found.
          yield* client.investigations.feedback({
            params: { id },
            payload: new Feedback({ rating: "down", actualRootCause: truth.rootCause }),
          })
          const written = yield* client.investigations.generatePostmortem({ params: { id } })
          return {
            investigationStatus: done.status,
            investigationCostUsd: done.usage?.costUsd ?? 0,
            draft: written,
          } satisfies DraftedPostmortem
        },
        (effect, input) =>
          Effect.mapError(effect, (cause) =>
            cause instanceof PostmortemSmokeError
              ? cause
              : new PostmortemSmokeError({ caseId: input.case.id, message: String(cause) }),
          ),
      )

      return PostmortemSource.of({ draft })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

export interface PostmortemSmokeRow {
  readonly caseId: string
  /** "error" when no draft was produced. */
  readonly investigationStatus: string
  /** The judge's verdict on the draft's root-cause section against the responder's root cause. */
  readonly rootCause: Verdict | "error"
  readonly error?: string
  readonly draft?: PostmortemDraft
  readonly costUsd: number
}

/**
 * Runs the postmortem smoke: one draft per case, graded on the one thing the prompt must not get wrong, that the
 * root cause is the one the responder stated. The drafts are kept in the rows so a person can read the rest
 * (invented mitigation steps, tone); there is no calibrated judge for those.
 */
export const runPostmortemSmoke = Effect.fn("evals.postmortemSmoke")(function* (
  cases: ReadonlyArray<PostmortemSmokeCase>,
) {
  const source = yield* PostmortemSource
  const judge = yield* Judge
  return yield* Effect.forEach(
    cases,
    (input) =>
      Effect.gen(function* () {
        const drafted = yield* source.draft(input)
        const judged = yield* judge
          .rootCause(input.truth, [drafted.draft.body.rootCause])
          .pipe(Effect.mapError((error) => new PostmortemSmokeError({ caseId: input.case.id, message: error.message })))
        const row: PostmortemSmokeRow = {
          caseId: input.case.id,
          investigationStatus: drafted.investigationStatus,
          rootCause: judged.verdicts[0] ?? "error",
          draft: drafted.draft,
          costUsd: drafted.investigationCostUsd + drafted.draft.usage.costUsd + judged.costUsd,
        }
        return row
      }).pipe(
        Effect.catch((error) => {
          const row: PostmortemSmokeRow = {
            caseId: input.case.id,
            investigationStatus: "error",
            rootCause: "error",
            error: error.message,
            costUsd: 0,
          }
          return Effect.succeed(row)
        }),
      ),
    { concurrency: 1 },
  )
})

export interface PostmortemSmokeReport {
  readonly pass: boolean
  readonly lines: ReadonlyArray<string>
}

/** Passes only when every case produced a draft whose root cause matches the responder's. */
export const reportPostmortemSmoke = (rows: ReadonlyArray<PostmortemSmokeRow>): PostmortemSmokeReport => {
  const matched = rows.filter((r) => r.rootCause === "match").length
  const cost = rows.reduce((sum, r) => sum + r.costUsd, 0)
  const first = rows.find((r) => r.draft !== undefined)?.draft
  const pass = rows.length > 0 && matched === rows.length
  return {
    pass,
    lines: [
      `${first?.promptVersion ?? "no draft"}, ${first?.model ?? "no model"}`,
      `drafts that state the responder's root cause: ${matched}/${rows.length}`,
      ...rows.map((r) =>
        r.error === undefined
          ? `  ${r.caseId} [${r.investigationStatus}] root cause: ${r.rootCause}`
          : `  ${r.caseId} failed: ${r.error}`,
      ),
      `cost as reported by the api and the judge: $${cost.toFixed(2)}`,
      pass ? "postmortem smoke: pass" : "postmortem smoke: fail",
    ],
  }
}
