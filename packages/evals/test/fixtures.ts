import { ReplaySnapshot } from "@incident/contracts"
import { Schema } from "effect"

const W0 = "2026-11-12T02:50:00.000Z"
const W1 = "2026-11-12T03:05:00.000Z"

const logs = (service: string, errors: number, pattern: string) => ({
  tool: "query_logs" as const,
  input: { service, start: W0, end: W1, level: "error" as const },
  output: {
    ref: `logs:t:${service}`,
    totalMatched: errors,
    countsByLevel: errors > 0 ? { error: errors } : {},
    topMessages: errors > 0 ? [{ pattern, count: errors }] : [],
    samples: errors > 0 ? [{ ref: `logs:t:${service}#0`, timestamp: W1, line: pattern }] : [],
  },
})

/** Small snapshot: checkout alerts, payment has the most errors. */
export const snapshotFixture = () =>
  Schema.decodeUnknownSync(ReplaySnapshot)({
    version: 1,
    caseId: "fc-00000001",
    recordedAt: W1,
    window: { start: W0, end: W1 },
    alert: {
      status: "firing",
      labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
      annotations: { summary: "checkout errors" },
      startsAt: W1,
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "00000001",
    },
    calls: [
      {
        tool: "get_service_topology",
        input: {},
        output: { ref: "topology:t", edges: [{ from: "checkout", to: "payment", protocol: "grpc" }] },
      },
      logs("checkout", 10, "failed to charge card"),
      logs("payment", 20, "Payment request failed. Invalid token."),
      logs("cart", 0, ""),
      {
        tool: "query_metrics",
        input: {
          promql: 'sum(rate(traces_span_metrics_calls_total{service_name="payment"}[1m]))',
          start: W0,
          end: W1,
          stepSeconds: 60,
        },
        output: {
          ref: "metrics:t:payment",
          series: [{ labels: {}, min: 0, max: 2, avg: 1, last: 2, tail: [[W1, 2]] }],
        },
      },
    ],
  })
