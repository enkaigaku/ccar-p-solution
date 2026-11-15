import { Schema } from "effect"
import { Alert } from "./Alert.ts"
import { Feedback, Hypothesis, InvestigationId, InvestigationStatus } from "./Investigation.ts"

export const FeedbackId = Schema.String.pipe(Schema.brand("FeedbackId"))
export type FeedbackId = typeof FeedbackId.Type

/**
 * The report a piece of feedback is about, copied at submission time. A stored feedback record stays usable for
 * evaluation after the investigation itself is gone, and is not changed by a later run of the same alert.
 */
export class ReportSnapshot extends Schema.Class<ReportSnapshot>("@incident/contracts/ReportSnapshot")({
  alert: Alert,
  status: InvestigationStatus,
  hypotheses: Schema.Array(Hypothesis),
  promptVersion: Schema.String,
  indexVersion: Schema.String,
  model: Schema.String,
  /** Joins the feedback to the investigation's trace and audit records. */
  traceId: Schema.optionalKey(Schema.String),
}) {}

/**
 * Feedback as persisted: what the responder submitted, who submitted it and the report it refers to.
 * `actualRootCause` and `comment` are free text typed by a person: never written to spans or logs.
 */
export class FeedbackRecord extends Schema.Class<FeedbackRecord>("@incident/contracts/FeedbackRecord")({
  id: FeedbackId,
  investigationId: InvestigationId,
  feedback: Feedback,
  /** `Principal.subject` and `Principal.name` of the responder. */
  submittedBy: Schema.Struct({ subject: Schema.String, name: Schema.String }),
  report: ReportSnapshot,
  createdAt: Schema.DateTimeUtcFromString,
}) {}
