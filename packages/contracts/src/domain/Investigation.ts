import { Schema } from "effect"
import { AlertId } from "./Alert.ts"

export const InvestigationId = Schema.String.pipe(Schema.brand("InvestigationId"))
export type InvestigationId = typeof InvestigationId.Type

export const EvidenceKind = Schema.Literals(["metric", "log", "trace", "chunk", "service-status"])

/** A pointer to something a tool returned. Reports may only cite refs that appear in tool results. */
export class EvidenceRef extends Schema.Class<EvidenceRef>("@incident/contracts/EvidenceRef")({
  kind: EvidenceKind,
  ref: Schema.String,
  note: Schema.optionalKey(Schema.String),
}) {}

export class Hypothesis extends Schema.Class<Hypothesis>("@incident/contracts/Hypothesis")({
  summary: Schema.String,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidence: Schema.Array(EvidenceRef),
}) {}

export const InvestigationStatus = Schema.Literals([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "insufficient_information",
  "failed",
])
export type InvestigationStatus = typeof InvestigationStatus.Type

export class Investigation extends Schema.Class<Investigation>("@incident/contracts/Investigation")({
  id: InvestigationId,
  alertId: AlertId,
  status: InvestigationStatus,
  hypotheses: Schema.Array(Hypothesis),
  /** Versions recorded for every run so A/B results and regressions can be traced. */
  promptVersion: Schema.String,
  indexVersion: Schema.String,
  model: Schema.String,
  traceId: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
}) {}

export class Feedback extends Schema.Class<Feedback>("@incident/contracts/Feedback")({
  rating: Schema.Literals(["up", "down"]),
  actualRootCause: Schema.optionalKey(Schema.String),
  comment: Schema.optionalKey(Schema.String),
}) {}
