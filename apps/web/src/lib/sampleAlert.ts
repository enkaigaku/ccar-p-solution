import type { AlertmanagerWebhook } from "@incident/contracts"
import { DateTime, Effect } from "effect"

/** A canned Alertmanager payload for local development, shaped like an OTel Demo checkout alert. */
export const sampleWebhook: Effect.Effect<AlertmanagerWebhook> = Effect.map(DateTime.now, (now) => ({
  version: "4",
  status: "firing",
  receiver: "incident-copilot",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
      annotations: { summary: "checkout 5xx 错误率超过 5%" },
      startsAt: DateTime.formatIso(now),
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: `dev-${DateTime.toEpochMillis(now)}`,
    },
  ],
}))
