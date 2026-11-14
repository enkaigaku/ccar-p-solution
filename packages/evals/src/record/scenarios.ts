/**
 * Fault scenarios for the OpenTelemetry Demo 3.1.0 flagd flags (`src/flagd/demo.flagd.json`).
 * Each scenario says how to inject the fault, which signal means "the alert would fire now", the alert that
 * Alertmanager would send, and the labelled root cause. `emitRawPii` and the `ai*` flags are not failure scenarios
 * for this project and are left out. A test checks every flag and variant against the 3.1.0 flag list.
 *
 * Three more flags are left out because they change nothing a recording could observe in the docker compose
 * deployment (checked against a live run): `productCatalogFailure` (no error spans anywhere), `kafkaQueueProblems`
 * (the core compose file runs no Kafka, fraud-detection or accounting) and `failedReadinessProbe` (nothing acts on
 * readiness probes outside Kubernetes).
 *
 * Two kinds: single-fault scenarios, and the same faults with a distractor, a second fault injected at the same time
 * on a path that cannot cause the alert. The labelled root cause of a distractor scenario is still the first fault.
 */
export interface Distractor {
  readonly flag: string
  readonly variant: string
  /** The service the distractor fault lives in. */
  readonly service: string
  /** The signal the distractor moves, recorded so the red herring is in the snapshot. */
  readonly promql: string
}

export interface Scenario {
  readonly name: string
  readonly flag: string
  readonly variant: string
  /**
   * PromQL that stands in for the alert rule: it fires once the value is more than `threshold` above the baseline
   * the recorder measures just before it injects the fault, so thresholds do not depend on a machine's traffic.
   */
  readonly trigger: { readonly promql: string; readonly threshold: number }
  readonly alert: { readonly alertname: string; readonly service: string; readonly summary: string }
  readonly rootCause: { readonly service: string; readonly text: string; readonly alternatives: ReadonlyArray<string> }
  /** Services whose logs and metrics the recorder captures in addition to the alerting service's neighbours. */
  readonly focus: ReadonlyArray<string>
  /** Unrelated faults that are on during the recording. Empty for single-fault scenarios. */
  readonly distractors: ReadonlyArray<Distractor>
}

// Metric names as Prometheus stores them here: the OTLP receiver is configured without unit or `_total` suffixes
// (infra/observability/prometheus/prometheus.yaml). The demo's span metrics reach Prometheus about once a minute,
// so rates use a 3 minute window; a 1 minute window often holds a single sample and returns nothing.
export const errorRate = (service: string) =>
  `sum(rate(traces_span_metrics_calls{service_name="${service}",status_code="STATUS_CODE_ERROR"}[3m]))`
export const requestRate = (service: string) => `sum(rate(traces_span_metrics_calls{service_name="${service}"}[3m]))`
export const p95 = (service: string) =>
  `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_bucket{service_name="${service}"}[3m])))`

/** p95 of one span. A slow span that is a small share of a service's calls does not move the service's p95. */
export const spanP95 = (service: string, span: string) =>
  `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_bucket{service_name="${service}",span_name="${span}"}[3m])))`

/**
 * Errors per second above the baseline that count as "the alert fires" for services with little traffic. The demo's
 * default load places an order every 30 to 60 seconds (checkout sees about 0.2 spans/s in total), so one failed order
 * within the window, about 0.005/s, has to be enough.
 */
const LOW_TRAFFIC_ERRORS = 0.004

const percent = (flag: string, variant: string, service: string, upstream: string, text: string): Scenario => ({
  name: `${flag}-${variant.replace("%", "")}`,
  flag,
  variant,
  trigger: { promql: errorRate(upstream), threshold: LOW_TRAFFIC_ERRORS },
  alert: { alertname: "HighErrorRate", service: upstream, summary: `${upstream} error rate is elevated` },
  rootCause: { service, text, alternatives: [] },
  focus: [service, upstream],
  distractors: [],
})

const FailureRates = ["10%", "25%", "50%", "75%", "90%", "100%"]

const SingleFaults: ReadonlyArray<Scenario> = [
  ...FailureRates.map((v) =>
    percent(
      "paymentFailure",
      v,
      "payment",
      "checkout",
      `The payment service fails ${v} of charge requests, so checkout cannot place orders.`,
    ),
  ),
  ...FailureRates.map((v) =>
    percent(
      "cartFailure",
      v,
      "cart",
      // EmptyCart only runs while checkout places an order. Checkout's error rate follows cart's one for one, and
      // the frontend's stays flat, so an alert on the frontend would point at a service that shows no errors.
      "checkout",
      `The cart service fails ${v} of EmptyCart requests, so checkout's PlaceOrder calls fail.`,
    ),
  ),
  {
    name: "paymentUnreachable",
    flag: "paymentUnreachable",
    variant: "on",
    trigger: { promql: errorRate("checkout"), threshold: LOW_TRAFFIC_ERRORS },
    alert: { alertname: "HighErrorRate", service: "checkout", summary: "checkout error rate is elevated" },
    rootCause: {
      service: "payment",
      text: "Checkout cannot reach the payment service (connection refused / unavailable).",
      alternatives: ["payment service is down or unreachable from checkout"],
    },
    focus: ["payment", "checkout"],
    distractors: [],
  },
  {
    name: "adFailure",
    flag: "adFailure",
    variant: "on",
    trigger: { promql: errorRate("ad"), threshold: 0.02 },
    alert: { alertname: "HighErrorRate", service: "frontend", summary: "frontend dependency errors are elevated" },
    rootCause: { service: "ad", text: "The ad service fails GetAds requests.", alternatives: [] },
    focus: ["ad", "frontend"],
    distractors: [],
  },
  {
    // The ad service's latency barely moves (GetAds p95 3 ms to 5 ms); the load shows in the JVM's CPU utilization,
    // which goes from about 0 to 0.45.
    name: "adHighCpu",
    flag: "adHighCpu",
    variant: "on",
    trigger: { promql: 'max(jvm_cpu_recent_utilization{service_name="ad"})', threshold: 0.2 },
    alert: { alertname: "HighCpu", service: "ad", summary: "ad CPU utilization is high" },
    rootCause: {
      service: "ad",
      text: "The ad service is CPU-saturated: something inside it burns CPU while request traffic is unchanged.",
      alternatives: ["high CPU load in the ad service"],
    },
    focus: ["ad", "frontend"],
    distractors: [],
  },
  {
    name: "adManualGc",
    flag: "adManualGc",
    variant: "on",
    trigger: { promql: p95("ad"), threshold: 500 },
    alert: { alertname: "HighLatency", service: "frontend", summary: "frontend p95 latency is elevated" },
    rootCause: {
      service: "ad",
      text: "Full manual garbage collections in the ad service pause it and raise latency.",
      alternatives: ["GC pauses in the ad service"],
    },
    focus: ["ad", "frontend"],
    distractors: [],
  },
  {
    name: "productCatalogLockContention",
    flag: "productCatalogLockContention",
    variant: "on",
    trigger: { promql: p95("product-catalog"), threshold: 300 },
    alert: { alertname: "HighLatency", service: "frontend", summary: "frontend p95 latency is elevated" },
    rootCause: {
      service: "product-catalog",
      text: "Lock contention on the product catalog database slows product-catalog requests.",
      alternatives: ["product-catalog database lock contention"],
    },
    focus: ["product-catalog", "frontend"],
    distractors: [],
  },
  {
    name: "recommendationCacheFailure",
    flag: "recommendationCacheFailure",
    variant: "on",
    trigger: { promql: p95("recommendation"), threshold: 300 },
    alert: { alertname: "HighLatency", service: "frontend", summary: "frontend p95 latency is elevated" },
    rootCause: {
      service: "recommendation",
      text: "The recommendation service cache fails, so it leaks memory and slows down.",
      alternatives: ["recommendation cache failure causing memory growth"],
    },
    focus: ["recommendation", "frontend"],
    distractors: [],
  },
  ...["5sec", "10sec"].map(
    (v): Scenario => ({
      // The delay is added in frontend-proxy on the image route: image-provider stays fast and gets fewer requests,
      // and the frontend's own p95 does not move.
      name: `imageSlowLoad-${v}`,
      flag: "imageSlowLoad",
      variant: v,
      trigger: { promql: spanP95("frontend-proxy", "GET"), threshold: 2000 },
      alert: { alertname: "HighLatency", service: "frontend-proxy", summary: "frontend-proxy p95 latency is elevated" },
      rootCause: {
        service: "frontend-proxy",
        text: `Product image requests through frontend-proxy are delayed by ${v}; image-provider itself stays fast.`,
        alternatives: ["slow loading of product images", "image requests are delayed before they reach image-provider"],
      },
      focus: ["frontend-proxy", "frontend-web", "image-provider", "frontend"],
      distractors: [],
    }),
  ),
  ...["5sec", "10sec"].map(
    (v): Scenario => ({
      // Ship-order calls are about 8% of shipping's calls, so shipping's p95 stays flat; the delay shows in checkout's
      // PlaceOrder, which waits for it.
      name: `intlShippingSlowdown-${v}`,
      flag: "intlShippingSlowdown",
      variant: v,
      trigger: { promql: spanP95("checkout", "oteldemo.CheckoutService/PlaceOrder"), threshold: 2000 },
      alert: { alertname: "HighLatency", service: "checkout", summary: "checkout p95 latency is elevated" },
      rootCause: {
        service: "shipping",
        text: `The shipping service's ship-order calls are delayed by ${v} (international shipping slowdown), so placing an order is slow.`,
        alternatives: ["slow ship-order requests in the shipping service"],
      },
      focus: ["shipping", "quote", "checkout"],
      distractors: [],
    }),
  ),
  // 100x is left out: its effect (p95 4 ms to 14 ms on average) is within noise.
  ...["1000x", "10000x"].map(
    (v): Scenario => ({
      name: `emailMemoryLeak-${v}`,
      flag: "emailMemoryLeak",
      variant: v,
      // Small in absolute terms: about 5 ms to 48 ms at 1000x and to a few hundred ms at 10000x.
      trigger: { promql: spanP95("email", "POST /send_order_confirmation"), threshold: 25 },
      alert: { alertname: "HighLatency", service: "email", summary: "email p95 latency is elevated" },
      rootCause: {
        service: "email",
        text: "The email service leaks memory and slows down or restarts.",
        // The recorded telemetry has no memory metric: slower confirmation requests and restarts are all that shows.
        alternatives: [
          "the email service is degraded: its order confirmation requests are slow",
          "the email service keeps restarting",
        ],
      },
      focus: ["email", "checkout"],
      distractors: [],
    }),
  ),
  {
    // Latency stays flat; the homepage's request rate goes from about 0.4/s to 20/s and more.
    name: "loadGeneratorFloodHomepage",
    flag: "loadGeneratorFloodHomepage",
    variant: "on",
    trigger: {
      promql: 'sum(rate(traces_span_metrics_calls{service_name="frontend",span_name="GET /"}[3m]))',
      threshold: 10,
    },
    alert: { alertname: "TrafficSpike", service: "frontend", summary: "frontend request rate is far above normal" },
    rootCause: {
      service: "load-generator",
      text: "The load generator floods the homepage with requests, multiplying the frontend's request rate.",
      alternatives: ["a traffic spike on the homepage"],
    },
    focus: ["frontend", "frontend-proxy", "load-generator"],
    distractors: [],
  },
]

/**
 * [fault, distractor]. The distractor must not move the fault's alert signal: error faults are paired with latency
 * faults or with errors on a path the alerting service does not call, and the other way round. For example, adFailure
 * is not paired with paymentFailure, because "frontend dependency errors" would then have two true causes.
 */
export const DistractorPairs: ReadonlyArray<readonly [fault: string, distractor: string]> = [
  ["paymentFailure-10", "adManualGc"],
  ["paymentFailure-25", "imageSlowLoad-5sec"],
  ["paymentFailure-50", "adHighCpu"],
  ["paymentFailure-75", "adFailure"],
  ["paymentFailure-90", "recommendationCacheFailure"],
  ["paymentFailure-100", "productCatalogLockContention"],
  ["paymentUnreachable", "adManualGc"],
  ["paymentUnreachable", "imageSlowLoad-10sec"],
  ["cartFailure-10", "imageSlowLoad-10sec"],
  ["cartFailure-25", "productCatalogLockContention"],
  ["cartFailure-50", "adFailure"],
  ["cartFailure-75", "adHighCpu"],
  ["cartFailure-90", "adManualGc"],
  ["cartFailure-100", "recommendationCacheFailure"],
  ["adFailure", "intlShippingSlowdown-5sec"],
  ["adHighCpu", "cartFailure-50"],
  ["adManualGc", "cartFailure-25"],
  ["productCatalogLockContention", "paymentFailure-50"],
  ["recommendationCacheFailure", "cartFailure-50"],
  ["intlShippingSlowdown-5sec", "adManualGc"],
  ["intlShippingSlowdown-10sec", "adFailure"],
  ["imageSlowLoad-5sec", "cartFailure-75"],
  ["imageSlowLoad-10sec", "paymentFailure-50"],
  ["emailMemoryLeak-1000x", "adManualGc"],
  ["emailMemoryLeak-10000x", "adFailure"],
  ["loadGeneratorFloodHomepage", "paymentFailure-50"],
]

const withDistractor = (fault: Scenario, distractor: Scenario): Scenario => ({
  ...fault,
  name: `${fault.name}+${distractor.name}`,
  focus: [...new Set([...fault.focus, ...distractor.focus])],
  distractors: [
    {
      flag: distractor.flag,
      variant: distractor.variant,
      service: distractor.rootCause.service,
      promql: distractor.trigger.promql,
    },
  ],
})

export const Scenarios: ReadonlyArray<Scenario> = [
  ...SingleFaults,
  // A pair that names an unknown scenario is dropped here; a test checks that none is.
  ...DistractorPairs.flatMap(([faultName, distractorName]) => {
    const fault = SingleFaults.find((s) => s.name === faultName)
    const distractor = SingleFaults.find((s) => s.name === distractorName)
    return fault === undefined || distractor === undefined ? [] : [withDistractor(fault, distractor)]
  }),
]

export const findScenario = (name: string) => Scenarios.find((s) => s.name === name)
