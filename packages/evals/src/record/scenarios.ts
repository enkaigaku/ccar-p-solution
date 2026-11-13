/**
 * Fault scenarios for the OpenTelemetry Demo 3.1.0 flagd flags (`src/flagd/demo.flagd.json`).
 * Each scenario says how to inject the fault, which signal means "the alert would fire now", the alert that
 * Alertmanager would send, and the labelled root cause. `emitRawPii` and the `ai*` flags are not failure scenarios
 * for this project and are left out. A test checks every flag and variant against the 3.1.0 flag list.
 *
 * Two kinds: single-fault scenarios, and the same faults with a distractor, a second fault injected at the same time
 * on a path that cannot cause the alert. The labelled root cause of a distractor scenario is still the first fault.
 */
export interface Distractor {
  readonly flag: string
  readonly variant: string
  /** The service the distractor fault lives in. */
  readonly service: string
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
    name: "adHighCpu",
    flag: "adHighCpu",
    variant: "on",
    trigger: { promql: p95("ad"), threshold: 500 },
    alert: { alertname: "HighLatency", service: "frontend", summary: "frontend p95 latency is elevated" },
    rootCause: {
      service: "ad",
      text: "The ad service is CPU-saturated, slowing pages that wait on ads.",
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
    name: "productCatalogFailure",
    flag: "productCatalogFailure",
    variant: "on",
    trigger: { promql: errorRate("product-catalog"), threshold: 0.05 },
    alert: { alertname: "HighErrorRate", service: "frontend", summary: "frontend error rate is elevated" },
    rootCause: {
      service: "product-catalog",
      text: "The product catalog service fails requests for one specific product.",
      alternatives: ["product-catalog returns errors for a single product id"],
    },
    focus: ["product-catalog", "frontend"],
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
      name: `imageSlowLoad-${v}`,
      flag: "imageSlowLoad",
      variant: v,
      trigger: { promql: p95("frontend"), threshold: 2000 },
      alert: { alertname: "HighLatency", service: "frontend", summary: "frontend p95 latency is elevated" },
      rootCause: {
        service: "frontend",
        text: `Product images load ${v} slower (image provider delay).`,
        alternatives: [],
      },
      focus: ["frontend"],
      distractors: [],
    }),
  ),
  ...["5sec", "10sec"].map(
    (v): Scenario => ({
      name: `intlShippingSlowdown-${v}`,
      flag: "intlShippingSlowdown",
      variant: v,
      trigger: { promql: p95("shipping"), threshold: 2000 },
      alert: { alertname: "HighLatency", service: "checkout", summary: "checkout p95 latency is elevated" },
      rootCause: { service: "shipping", text: `International shipping quotes are delayed by ${v}.`, alternatives: [] },
      focus: ["shipping", "quote", "checkout"],
      distractors: [],
    }),
  ),
  ...["100x", "1000x", "10000x"].map(
    (v): Scenario => ({
      name: `emailMemoryLeak-${v}`,
      flag: "emailMemoryLeak",
      variant: v,
      trigger: { promql: p95("email"), threshold: 500 },
      alert: { alertname: "HighLatency", service: "checkout", summary: "checkout p95 latency is elevated" },
      rootCause: {
        service: "email",
        text: "The email service leaks memory and slows down or restarts.",
        alternatives: [],
      },
      focus: ["email", "checkout"],
      distractors: [],
    }),
  ),
  {
    // 3.1.0 has one strength ("on") and no kafkaConsumerDead flag. Checkout sends a burst of extra messages for each
    // order while the consumers sleep before each message.
    name: "kafkaQueueProblems",
    flag: "kafkaQueueProblems",
    variant: "on",
    trigger: { promql: 'sum(kafka_consumer_lag{topic="orders"})', threshold: 100 },
    alert: { alertname: "ConsumerLag", service: "fraud-detection", summary: "orders consumer lag is growing" },
    rootCause: {
      service: "fraud-detection",
      text: "Checkout floods the orders Kafka topic with extra messages while the fraud-detection consumer is slowed down, so consumer lag on the orders topic spikes.",
      alternatives: ["checkout overproduces messages to the orders topic", "slow Kafka consumer in fraud-detection"],
    },
    focus: ["fraud-detection", "accounting", "checkout", "kafka"],
    distractors: [],
  },
  {
    name: "failedReadinessProbe",
    flag: "failedReadinessProbe",
    variant: "on",
    trigger: { promql: errorRate("frontend"), threshold: 0.1 },
    alert: { alertname: "HighErrorRate", service: "frontend", summary: "frontend error rate is elevated" },
    rootCause: {
      service: "cart",
      text: "The cart service fails its readiness probe and is taken out of rotation.",
      alternatives: ["cart readiness probe failures"],
    },
    focus: ["cart", "frontend"],
    distractors: [],
  },
  {
    name: "loadGeneratorFloodHomepage",
    flag: "loadGeneratorFloodHomepage",
    variant: "on",
    trigger: { promql: p95("frontend"), threshold: 1000 },
    alert: { alertname: "HighLatency", service: "frontend", summary: "frontend p95 latency is elevated" },
    rootCause: {
      service: "load-generator",
      text: "The load generator floods the homepage with requests, overloading the frontend.",
      alternatives: ["a traffic spike on the homepage"],
    },
    focus: ["frontend", "load-generator"],
    distractors: [],
  },
]

/**
 * [fault, distractor]. The distractor must not move the fault's alert signal: error faults are paired with latency
 * faults or with errors on a path the alerting service does not call, and the other way round. For example, adFailure
 * is not paired with paymentFailure, because "frontend dependency errors" would then have two true causes.
 */
export const DistractorPairs: ReadonlyArray<readonly [fault: string, distractor: string]> = [
  ["paymentFailure-25", "imageSlowLoad-5sec"],
  ["paymentFailure-50", "adHighCpu"],
  ["paymentFailure-75", "adFailure"],
  ["paymentFailure-90", "recommendationCacheFailure"],
  ["paymentFailure-100", "productCatalogLockContention"],
  ["paymentUnreachable", "adManualGc"],
  ["paymentUnreachable", "imageSlowLoad-10sec"],
  ["cartFailure-25", "productCatalogLockContention"],
  ["cartFailure-50", "adFailure"],
  ["cartFailure-75", "adHighCpu"],
  ["cartFailure-100", "recommendationCacheFailure"],
  ["adFailure", "intlShippingSlowdown-5sec"],
  ["adHighCpu", "cartFailure-50"],
  ["productCatalogFailure", "adHighCpu"],
  ["productCatalogLockContention", "paymentFailure-50"],
  ["recommendationCacheFailure", "cartFailure-50"],
  ["intlShippingSlowdown-10sec", "adFailure"],
  ["imageSlowLoad-10sec", "paymentFailure-50"],
  ["emailMemoryLeak-1000x", "adManualGc"],
  ["kafkaQueueProblems", "adHighCpu"],
  ["failedReadinessProbe", "intlShippingSlowdown-5sec"],
]

const withDistractor = (fault: Scenario, distractor: Scenario): Scenario => ({
  ...fault,
  name: `${fault.name}+${distractor.name}`,
  focus: [...new Set([...fault.focus, ...distractor.focus])],
  distractors: [{ flag: distractor.flag, variant: distractor.variant, service: distractor.rootCause.service }],
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
