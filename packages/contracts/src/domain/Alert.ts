import { Schema } from "effect"

export const AlertId = Schema.String.pipe(Schema.brand("AlertId"))
export type AlertId = typeof AlertId.Type

export const Severity = Schema.Literals(["critical", "warning", "info"])
export type Severity = typeof Severity.Type

/** An alert after triage normalised it. Raw Alertmanager payloads live in `AlertmanagerWebhook`. */
export class Alert extends Schema.Class<Alert>("@incident/contracts/Alert")({
  id: AlertId,
  fingerprint: Schema.String,
  name: Schema.String,
  service: Schema.String,
  severity: Severity,
  status: Schema.Literals(["firing", "resolved"]),
  summary: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  startsAt: Schema.DateTimeUtcFromString,
}) {}

/** Alertmanager webhook payload (version 4). Only the fields this project reads are declared. */
export const AlertmanagerAlert = Schema.Struct({
  status: Schema.Literals(["firing", "resolved"]),
  labels: Schema.Record(Schema.String, Schema.String),
  annotations: Schema.Record(Schema.String, Schema.String),
  startsAt: Schema.String,
  endsAt: Schema.String,
  fingerprint: Schema.String,
})

export const AlertmanagerWebhook = Schema.Struct({
  version: Schema.String,
  status: Schema.Literals(["firing", "resolved"]),
  receiver: Schema.String,
  alerts: Schema.Array(AlertmanagerAlert),
})
export type AlertmanagerWebhook = typeof AlertmanagerWebhook.Type
