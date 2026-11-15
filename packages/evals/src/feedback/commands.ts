import { FeedbackRecord, IncidentApi, ReplaySnapshot } from "@incident/contracts"
import { Config, Console, Effect, FileSystem, flow, Option, Path, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Datasets, packageRoot } from "../dataset/Datasets.ts"
import { FeedbackCase } from "../dataset/EvalCase.ts"
import { auditedCalls, curate } from "./curate.ts"

export class CurationError extends Schema.TaggedError<CurationError>()("CurationError", {
  message: Schema.String,
}) {}

/** Candidates wait here for review: `<dir>/<caseId>/case.json` and `snapshot.json`. Git-ignored. */
export const defaultCandidatesDir = `${packageRoot}candidates`

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const decodeRecords = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(FeedbackRecord)))

/**
 * Stored feedback that carries an actual root cause: from a file saved from `GET /feedback`, or from the api at
 * `EVAL_API_URL` (with `EVAL_API_TOKEN` as the bearer token when the api is not in `AUTH_MODE=dev`).
 */
const loadFeedback = Effect.fn("evals.loadFeedback")(function* (file: Option.Option<string>) {
  if (Option.isSome(file)) {
    const text = yield* (yield* FileSystem.FileSystem).readFileString(file.value)
    return yield* decodeRecords(text)
  }
  const baseUrl = yield* Config.String("EVAL_API_URL").pipe(Config.withDefault("http://localhost:3000"))
  const token = yield* Config.option(Config.Redacted("EVAL_API_TOKEN"))
  const client = yield* HttpApiClient.make(IncidentApi, {
    transformClient: (c) =>
      c.pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(baseUrl),
            Option.isSome(token) ? HttpClientRequest.bearerToken(Redacted.value(token.value)) : (request) => request,
          ),
        ),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer))
  return yield* client.feedback.list({ query: { hasRootCause: "true" } })
})

export const runCurate = Effect.fn("evals.curate")(function* (options: {
  readonly feedback: Option.Option<string>
  readonly audit: string
  readonly out: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const records = yield* loadFeedback(options.feedback).pipe(
    Effect.mapError((cause) => new CurationError({ message: `could not load feedback: ${String(cause)}` })),
  )
  const audit = auditedCalls(
    yield* fs
      .readFileString(options.audit)
      .pipe(Effect.mapError(() => new CurationError({ message: `could not read the audit log ${options.audit}` }))),
  )
  const inDataset = (yield* (yield* Datasets).cases).map((c) => c.id)
  const waiting = (yield* fs.exists(options.out)) ? yield* fs.readDirectory(options.out) : []
  const result = curate(records, audit, new Set([...inDataset, ...waiting]))

  for (const candidate of result.candidates) {
    const dir = path.join(options.out, candidate.case.id)
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.writeFileString(
      path.join(dir, "case.json"),
      pretty(yield* Schema.encodeEffect(FeedbackCase)(candidate.case)),
    )
    yield* fs.writeFileString(
      path.join(dir, "snapshot.json"),
      pretty(yield* Schema.encodeEffect(ReplaySnapshot)(candidate.snapshot)),
    )
    yield* Console.log(
      `candidate ${candidate.case.id}: ${candidate.snapshot.calls.length} tool calls, service ${candidate.case.groundTruth.service}`,
    )
  }
  for (const s of result.skipped) yield* Console.log(`skipped ${s.caseId} (feedback ${s.feedbackId}): ${s.reason}`)
  if (audit.invalid > 0)
    yield* Console.log(`${audit.invalid} tool_call audit records could not be read and were left out`)
  yield* Console.log(
    `${records.length} feedback records with a root cause, ${result.candidates.length} new candidates in ${options.out}`,
  )
  if (result.candidates.length > 0) {
    yield* Console.log(
      "Review each case.json before promoting: correct groundTruth.service, tighten rootCause to one sentence, " +
        "add acceptableAlternatives, and check that nothing in it or in snapshot.json should stay out of git. " +
        "Then run `evals promote <id>`.",
    )
  }
  return result
})

/**
 * Moves a reviewed candidate into the dataset: `datasets/feedback/<id>.json` and `fixtures/replay/<id>/`.
 * Both files are decoded again first, so a hand-edit that broke the schema is caught here, not in an eval run.
 */
export const runPromote = Effect.fn("evals.promote")(function* (options: {
  readonly id: string
  readonly from: string
  readonly root: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(options.from, options.id)
  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(name: string, schema: S) =>
    fs.readFileString(path.join(dir, name)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.mapError((cause) => new CurationError({ message: `${path.join(dir, name)}: ${cause.message}` })),
    )
  const c = yield* read("case.json", FeedbackCase)
  const snapshot = yield* read("snapshot.json", ReplaySnapshot)
  if (c.id !== options.id || c.snapshotId !== options.id || snapshot.caseId !== options.id) {
    return yield* new CurationError({ message: `${dir}: the case and snapshot ids must both be ${options.id}` })
  }
  if (snapshot.calls.length === 0) {
    return yield* new CurationError({ message: `${dir}: the snapshot has no tool calls to replay` })
  }
  const caseFile = path.join(options.root, "datasets", "feedback", `${options.id}.json`)
  const snapshotDir = path.join(options.root, "fixtures", "replay", options.id)
  if ((yield* fs.exists(caseFile)) || (yield* fs.exists(snapshotDir))) {
    return yield* new CurationError({ message: `${options.id} is already in the dataset` })
  }
  yield* fs.makeDirectory(path.dirname(caseFile), { recursive: true })
  yield* fs.makeDirectory(snapshotDir, { recursive: true })
  yield* fs.writeFileString(
    path.join(snapshotDir, "snapshot.json"),
    pretty(yield* Schema.encodeEffect(ReplaySnapshot)(snapshot)),
  )
  yield* fs.writeFileString(caseFile, pretty(yield* Schema.encodeEffect(FeedbackCase)(c)))
  yield* fs.remove(dir, { recursive: true })
  yield* Console.log(`promoted ${options.id}: ${caseFile}`)
  return c
})
