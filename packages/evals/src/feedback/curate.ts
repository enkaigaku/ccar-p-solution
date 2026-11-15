import { createHash } from "node:crypto"
import { type FeedbackRecord, RecordedToolCall, ReplaySnapshot, replayKey } from "@incident/contracts"
import { DateTime, Duration, Option, Schema } from "effect"
import { FeedbackCase } from "../dataset/EvalCase.ts"

/**
 * Turning production feedback into evaluation cases (design doc "反馈闭环").
 *
 * Inputs are the api's stored feedback (`GET /feedback`) and its audit log. For every observability tool call
 * of an investigation the api appends a `tool_call` audit record whose payload is a `RecordedToolCall`: the same
 * shape a recorded snapshot holds, already PII-redacted by `mcp-observability`. Those calls become the case's
 * replay snapshot and the responder's `actualRootCause` becomes its ground truth.
 */

/** The fields of an api audit record this module reads. Other fields and other kinds are ignored. */
const AuditLine = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    kind: Schema.String,
    investigationId: Schema.optionalKey(Schema.String),
    payload: Schema.String,
  }),
)
const decodeLine = Schema.decodeUnknownOption(AuditLine)
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(RecordedToolCall))

export interface AuditedCall {
  readonly at: DateTime.Utc
  readonly call: RecordedToolCall
}

export interface AuditedCalls {
  readonly byInvestigation: ReadonlyMap<string, ReadonlyArray<AuditedCall>>
  /** `tool_call` records that did not decode: written by another version, or damaged. They are left out. */
  readonly invalid: number
}

/** Collects the `tool_call` records of an audit log (JSONL), in file order, per investigation. */
export const auditedCalls = (jsonl: string): AuditedCalls => {
  const byInvestigation = new Map<string, Array<AuditedCall>>()
  let invalid = 0
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    const record = Option.getOrUndefined(decodeLine(line))
    if (record === undefined || record.kind !== "tool_call") continue
    const call = Option.getOrUndefined(decodeCall(record.payload))
    const at = Option.getOrUndefined(DateTime.make(record.at))
    if (call === undefined || at === undefined || record.investigationId === undefined) {
      invalid++
      continue
    }
    const calls = byInvestigation.get(record.investigationId) ?? []
    calls.push({ at: DateTime.toUtc(at), call })
    byInvestigation.set(record.investigationId, calls)
  }
  return { byInvestigation, invalid }
}

/** Opaque and stable: the same investigation always maps to the same case id, and the id says nothing about it. */
export const feedbackCaseId = (investigationId: string): string =>
  `fb-${createHash("sha256").update(investigationId, "utf8").digest("hex").slice(0, 8)}`

export interface Candidate {
  readonly case: FeedbackCase
  readonly snapshot: ReplaySnapshot
}

export interface Curation {
  readonly candidates: ReadonlyArray<Candidate>
  readonly skipped: ReadonlyArray<{ readonly feedbackId: string; readonly caseId: string; readonly reason: string }>
}

const hasRootCause = (record: FeedbackRecord) => (record.feedback.actualRootCause ?? "").trim() !== ""

/** How far before the alert the snapshot's window starts. Replay ignores times; this is for the reader. */
const LOOKBACK = Duration.minutes(15)

/**
 * One candidate per investigation that has feedback with an actual root cause and audited tool calls.
 * `known` are case ids already in the dataset or already written as candidates; those are skipped, so the
 * command can be run every week over the same inputs.
 */
export const curate = (
  records: ReadonlyArray<FeedbackRecord>,
  audit: AuditedCalls,
  known: ReadonlySet<string>,
): Curation => {
  const candidates: Array<Candidate> = []
  const skipped: Array<Curation["skipped"][number]> = []
  const seen = new Set<string>()
  // Newest first, so the latest statement of the root cause wins when responders corrected themselves.
  const newestFirst = records.filter(hasRootCause).toSorted((a, b) => DateTime.Order(b.createdAt, a.createdAt))
  for (const record of newestFirst) {
    const caseId = feedbackCaseId(record.investigationId)
    if (seen.has(caseId)) continue
    seen.add(caseId)
    const skip = (reason: string) => skipped.push({ feedbackId: record.id, caseId, reason })
    if (known.has(caseId)) {
      skip("already curated")
      continue
    }
    const audited = audit.byInvestigation.get(record.investigationId) ?? []
    if (audited.length === 0) {
      skip("no audited tool calls for this investigation (other audit file, or run before tool calls were audited)")
      continue
    }
    // The agent may repeat a query; replay serves one answer per key, and the last one is what it concluded on.
    const calls = [...new Map(audited.map((a) => [replayKey(a.call), a.call])).values()]
    const lastCallAt = audited.reduce((max, a) => DateTime.max(max, a.at), audited[0]?.at ?? record.createdAt)
    const { alert } = record.report
    const snapshot = new ReplaySnapshot({
      version: 1,
      caseId,
      recordedAt: record.createdAt,
      // The end is what the agent is told the current time is: the moment of the live investigation.
      window: { start: DateTime.subtractDuration(alert.startsAt, LOOKBACK), end: lastCallAt },
      alert: {
        status: "firing",
        labels: alert.labels,
        annotations: alert.summary === "" ? {} : { summary: alert.summary },
        startsAt: DateTime.formatIso(alert.startsAt),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: caseId,
      },
      calls,
    })
    const service = alert.service.trim() === "" ? "unknown" : alert.service
    candidates.push({
      snapshot,
      case: new FeedbackCase({
        kind: "feedback",
        id: caseId,
        snapshotId: caseId,
        smoke: false,
        groundTruth: {
          rootCause: (record.feedback.actualRootCause ?? "").trim(),
          // A guess: the alerting service. The reviewer changes it when the fault was upstream.
          service,
          acceptableAlternatives: [],
        },
        expect: { insufficientInformation: false, forbiddenActions: [] },
        tags: ["feedback", service],
        synthetic: false,
        origin: {
          feedbackId: record.id,
          investigationId: record.investigationId,
          ...(record.report.traceId === undefined ? {} : { traceId: record.report.traceId }),
          rating: record.feedback.rating,
          model: record.report.model,
          promptVersion: record.report.promptVersion,
          indexVersion: record.report.indexVersion,
        },
      }),
    })
  }
  return { candidates, skipped }
}
