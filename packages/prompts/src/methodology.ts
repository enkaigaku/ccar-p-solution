import type { Prompt } from "./Prompt.ts"
import type { AlertCategory } from "./triage.ts"

/**
 * Investigation methodologies ("Skills" in the design doc), one per alert category. Only the one matching the
 * triage category is loaded into an investigation, instead of putting every playbook into the system prompt.
 */
export const Methodologies: Readonly<Record<AlertCategory, Prompt>> = {
  latency: {
    version: "method-latency@1",
    text: `Methodology: elevated latency.
1. Confirm the symptom with a latency metric for the alerting service and find when it started.
2. Walk the dependency graph downstream from the alerting service. Latency usually originates in a callee:
   compare the latency of each direct dependency over the same window.
3. Look for saturation in the slowest component: CPU, memory, garbage collection, restarts.
4. Fetch a slow trace when you have a trace id and identify the span that dominates the duration.
5. Check whether a feature flag, deployment or restart lines up with the start of the symptom.`,
  },
  "error-rate": {
    version: "method-error-rate@1",
    text: `Methodology: error-rate spike.
1. Confirm the symptom with an error-rate metric for the alerting service and find when it started.
2. Read the alerting service's error logs: the most frequent message usually names the failing call.
3. Follow that call to the dependency it names and read that service's error logs too. The service that
   originates the error is the root cause; services that only propagate it are symptoms.
4. Check container status of the suspected service (restarts, image tag) and whether a feature flag or
   deployment lines up with the start of the errors.
5. Distinguish a partial failure (a fraction of requests) from a total outage; say which one the data shows.`,
  },
  saturation: {
    version: "method-saturation@1",
    text: `Methodology: resource saturation.
1. Identify the saturated resource (CPU, memory, GC, queue lag, connections) and confirm it with a metric.
2. Determine whether load increased (request rate up) or capacity decreased (same load, more resource per request).
3. Check restarts and OOM kills in container status, and memory or GC related messages in logs.
4. For queue or consumer lag, compare producer and consumer rates and read the consumer's logs.
5. Check whether a feature flag or deployment lines up with the start of the saturation.`,
  },
  availability: {
    version: "method-availability@1",
    text: `Methodology: service unavailable.
1. Check container status of the alerting service and its direct dependencies: state, restarts, image tag.
2. Read the service's most recent error logs, including startup and readiness messages.
3. Determine whether the service itself is down or a dependency it needs at startup is unavailable.
4. Check whether a feature flag, deployment or rollback lines up with the start of the outage.`,
  },
  other: {
    version: "method-general@1",
    text: `Methodology: general triage.
1. Restate what the alert measures and confirm it with the matching metric.
2. Check logs and container status of the alerting service, then of its direct dependencies.
3. Look for a change (feature flag, deployment, restart) that lines up with the start of the symptom.
4. If the data does not point to a cause, conclude with insufficient information instead of guessing.`,
  },
}
