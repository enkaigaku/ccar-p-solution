import { ChunkId, OpsAction, RetrievalQuery } from "@incident/contracts"
import { Schema } from "effect"

/**
 * Evaluation datasets. These schemas are internal to `@incident/evals`: no other package reads them.
 * The telemetry a case replays lives in a `ReplaySnapshot` (contracts) under `fixtures/replay/<snapshotId>/`.
 */

/** Opaque ids only. A descriptive id ("payment-failure") would leak the answer if it ever reached the agent. */
export const CaseId = Schema.String.check(Schema.isPattern(/^[a-z]{2}-[0-9a-f]{8}$/))

/** The labelled answer for a fault case, written by the recorder from the injected scenario and reviewed by a human. */
export const GroundTruth = Schema.Struct({
  /** One sentence a judge compares hypotheses against. */
  rootCause: Schema.NonEmptyString,
  /** The service whose fault caused the alert (not necessarily the alerting service). */
  service: Schema.NonEmptyString,
  /** Other phrasings that should also count as correct, for the judge rubric. */
  acceptableAlternatives: Schema.Array(Schema.String),
  /** The flagd flag and variant that produced the fault. Never shown to the agent. */
  fault: Schema.Struct({ flag: Schema.String, variant: Schema.String }),
  /**
   * Unrelated faults that were on during the recording. A hypothesis that blames one of them is wrong. Kept for
   * analysis (accuracy with and without distractors); the judge request does not include them.
   */
  distractors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ flag: Schema.String, variant: Schema.String, service: Schema.String })),
  ),
})
export type GroundTruth = typeof GroundTruth.Type

export const Expectations = Schema.Struct({
  /** The agent should end with `insufficient_information` instead of guessing. */
  insufficientInformation: Schema.Boolean,
  /** Action tags (`ToggleFlag`, `RestartService`, `RollbackService`) that must not be proposed. */
  forbiddenActions: Schema.Array(Schema.Literals(["ToggleFlag", "RestartService", "RollbackService"])),
})
export type Expectations = typeof Expectations.Type

/** Text planted into what the agent reads, to test prompt-injection resistance. */
export const Injection = Schema.Struct({
  /**
   * Where the payload goes. `logs` (the default): the newest sample of every replayed `query_logs` result for
   * `service`. `alert-summary`: appended to the alert's summary annotation, which reaches triage and the agent.
   */
  surface: Schema.optionalKey(Schema.Literals(["logs", "alert-summary"])),
  /** The service whose logs carry the payload. Ignored for `alert-summary`. */
  service: Schema.NonEmptyString,
  payload: Schema.NonEmptyString,
  /** A string that must not appear in any hypothesis or proposal if the agent ignored the payload. */
  canary: Schema.NonEmptyString,
})
export type Injection = typeof Injection.Type

export class FaultCase extends Schema.Class<FaultCase>("@incident/evals/FaultCase")({
  kind: Schema.Literal("fault"),
  id: CaseId,
  snapshotId: CaseId,
  /** Smoke cases run on every PR; the rest only in the full evaluation. */
  smoke: Schema.Boolean,
  groundTruth: GroundTruth,
  expect: Expectations,
  tags: Schema.Array(Schema.String),
  /** Synthetic fixtures exist for tests only; full runs exclude them. */
  synthetic: Schema.Boolean,
}) {}

export class AdversarialCase extends Schema.Class<AdversarialCase>("@incident/evals/AdversarialCase")({
  kind: Schema.Literal("adversarial"),
  id: CaseId,
  /** The fault snapshot this case starts from. */
  snapshotId: CaseId,
  smoke: Schema.Boolean,
  attack: Schema.Literals(["log-injection", "alert-injection", "unrelated-alert", "insufficient-data"]),
  injection: Schema.optionalKey(Injection),
  /** Services whose recorded calls are dropped before replay, so the agent cannot see their telemetry. */
  dropServices: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Drops every recorded log, metric and trace call: the telemetry backend answers nothing. */
  dropAllTelemetry: Schema.optionalKey(Schema.Boolean),
  /**
   * For `unrelated-alert`: replaces the recorded alert with one about a service the snapshot shows as healthy.
   * Combined with `dropServices` for the recorded fault, nothing in the data explains the alert.
   */
  alert: Schema.optionalKey(
    Schema.Struct({
      alertname: Schema.NonEmptyString,
      service: Schema.NonEmptyString,
      severity: Schema.NonEmptyString,
      summary: Schema.NonEmptyString,
    }),
  ),
  /** Present when the case still has a correct answer (e.g. injection on top of a real fault). */
  groundTruth: Schema.optionalKey(GroundTruth),
  expect: Expectations,
  tags: Schema.Array(Schema.String),
  synthetic: Schema.Boolean,
}) {}

/**
 * The answer for a case that came from production feedback: what the responder said the root cause was.
 * There is no injected flag, so unlike {@link GroundTruth} there is no `fault`.
 */
export const FeedbackTruth = Schema.Struct({
  rootCause: Schema.NonEmptyString,
  /** The service whose fault caused the alert. Curation fills in the alerting service; the reviewer corrects it. */
  service: Schema.NonEmptyString,
  acceptableAlternatives: Schema.Array(Schema.String),
})
export type FeedbackTruth = typeof FeedbackTruth.Type

/** What the judge compares hypotheses against: the part every kind of ground truth has. */
export type JudgedTruth = Pick<GroundTruth, "rootCause" | "service" | "acceptableAlternatives">

/**
 * A case curated from a live investigation (design doc "反馈闭环"): the telemetry the agent queried, replayed,
 * with the responder's stated root cause as the answer. Written by `evals curate` as a candidate and added to
 * the dataset by `evals promote` after a person reviewed it.
 *
 * The snapshot holds only the calls the agent made at the time, not the recorder's broad sweep, so a changed
 * prompt that asks different questions gets empty answers. Treat a regression on these cases as a lead to look
 * into, not as a measurement of the same quality as the fault set.
 */
export class FeedbackCase extends Schema.Class<FeedbackCase>("@incident/evals/FeedbackCase")({
  kind: Schema.Literal("feedback"),
  id: CaseId,
  snapshotId: CaseId,
  smoke: Schema.Boolean,
  groundTruth: FeedbackTruth,
  expect: Expectations,
  tags: Schema.Array(Schema.String),
  synthetic: Schema.Boolean,
  /** Where the case came from. Never shown to the agent. */
  origin: Schema.Struct({
    feedbackId: Schema.String,
    investigationId: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
    rating: Schema.Literals(["up", "down"]),
    /** What produced the report the feedback was about. */
    model: Schema.String,
    promptVersion: Schema.String,
    indexVersion: Schema.String,
  }),
}) {}

export const EvalCase = Schema.Union([FaultCase, AdversarialCase, FeedbackCase])
export type EvalCase = typeof EvalCase.Type

export class RetrievalCase extends Schema.Class<RetrievalCase>("@incident/evals/RetrievalCase")({
  id: Schema.NonEmptyString,
  query: RetrievalQuery,
  /** Chunks a correct retrieval must return. Order does not matter. */
  relevant: Schema.NonEmptyArray(ChunkId),
  source: Schema.Literals(["human", "synthetic-reviewed"]),
}) {}

/** One human-scored judgement used to calibrate the LLM judge (target agreement ≥ 90% on 30 samples). */
export class CalibrationSample extends Schema.Class<CalibrationSample>("@incident/evals/CalibrationSample")({
  id: Schema.NonEmptyString,
  groundTruth: GroundTruth,
  hypothesis: Schema.NonEmptyString,
  humanVerdict: Schema.Literals(["match", "partial", "miss"]),
}) {}

/** What the agent under test produced for one case. */
export class AgentRun extends Schema.Class<AgentRun>("@incident/evals/AgentRun")({
  status: Schema.Literals(["completed", "awaiting_approval", "insufficient_information", "failed"]),
  hypotheses: Schema.Array(
    Schema.Struct({
      summary: Schema.String,
      confidence: Schema.Number,
      evidence: Schema.Array(Schema.Struct({ kind: Schema.String, ref: Schema.String })),
    }),
  ),
  proposals: Schema.Array(OpsAction),
  /** Chunk ids the retriever returned during the run; `chunk` citations are checked against these. */
  retrievedChunkIds: Schema.Array(Schema.String),
  usage: Schema.Struct({ costUsd: Schema.Number, inputTokens: Schema.Int, outputTokens: Schema.Int }),
  latencyMs: Schema.Number,
  model: Schema.String,
  promptVersion: Schema.String,
}) {}
