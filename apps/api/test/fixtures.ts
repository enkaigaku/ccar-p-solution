import { Alert, AlertId } from "@incident/contracts"
import { DateTime } from "effect"
import type { TriageResult } from "../src/triage/Triage.ts"
import { emptyUsage } from "../src/usage.ts"

export const window = { start: "2026-11-12T02:45:00Z", end: "2026-11-12T03:05:00Z" }

export const checkoutAlert = new Alert({
  id: AlertId.make("fp-checkout-1"),
  fingerprint: "fp-checkout-1",
  name: "HighErrorRate",
  service: "checkout",
  severity: "critical",
  status: "firing",
  summary: "checkout 5xx above 5%",
  labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
  startsAt: DateTime.makeUnsafe("2026-11-12T03:00:00Z"),
})

export const checkoutTriage: TriageResult = {
  category: "error-rate",
  service: "checkout",
  severity: "critical",
  summary: "checkout is returning errors",
  retrievalQuery: "checkout HighErrorRate errors",
  relatedAlertIds: [],
  source: "model",
  promptVersion: "triage@1",
  usage: emptyUsage,
}

export const webhook = {
  version: "4",
  status: "firing" as const,
  receiver: "incident-copilot",
  alerts: [
    {
      status: "firing" as const,
      labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
      annotations: { summary: "checkout 5xx above 5%" },
      startsAt: "2026-11-12T03:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "fp-checkout-1",
    },
  ],
}

/** A report citing refs the fake telemetry returns plus the stub retriever's runbook chunk. */
export const goodReport = {
  status: "completed",
  hypotheses: [
    {
      summary: "payment rejects charges with an invalid-token error, so checkout fails to place orders",
      confidence: 0.82,
      evidence: [
        { kind: "log", ref: "logs-payment#0", note: "invalid token errors" },
        { kind: "chunk", ref: "stub-runbook-1", note: "runbook: check payment first" },
        { kind: "service-status", ref: "topology-1", note: "" },
      ],
    },
    {
      summary: "checkout itself is misconfigured",
      confidence: 0.1,
      evidence: [{ kind: "log", ref: "logs-checkout", note: "" }],
    },
  ],
}

export const toggleProposal = {
  action: { _tag: "ToggleFlag", flag: "paymentFailure", variant: "off" },
  rationale: "The paymentFailure flag makes payment reject charges (logs-payment#0).",
  expected_effect: "checkout error rate returns below 1% within 2 minutes",
  rollback_plan: "Set paymentFailure back to its previous variant",
}
