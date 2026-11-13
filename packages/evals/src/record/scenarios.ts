/**
 * Fault scenarios for the OpenTelemetry Demo 3.1.0 flagd flags (`src/flagd/demo.flagd.json`).
 * Each scenario says how to inject the fault, which signal means "the alert would fire now", the alert that
 * Alertmanager would send, and the labelled root cause. `emitRawPii`, `cartMetricCardinalityOverflow` and the
 * `ai*` flags are not failure scenarios for this project and are left out.
 */
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

const percent = (
  flag: string,
  variant: string,
  service: string,
  upstream: string,
  text: string,
  triggerOn: string = upstream,
): Scenario => ({
  name: `${flag}-${variant.replace("%", "")}`,
  flag,
  variant,
  trigger: { promql: errorRate(triggerOn), threshold: LOW_TRAFFIC_ERRORS },
  alert: { alertname: "HighErrorRate", service: upstream, summary: `${upstream} error rate is elevated` },
  rootCause: { service, text, alternatives: [] },
  focus: [service, upstream],
})

export const Scenarios: ReadonlyArray<Scenario> = [
  ...["10%", "50%", "100%"].map((v) =>
    percent(
      "paymentFailure",
      v,
      "payment",
      "checkout",
      `The payment service fails ${v} of charge requests, so checkout cannot place orders.`,
    ),
  ),
  ...["10%", "50%", "100%"].map((v) =>
    percent(
      "cartFailure",
      v,
      "cart",
      "frontend",
      `The cart service fails ${v} of EmptyCart requests, surfacing as frontend and checkout errors.`,
      // EmptyCart only runs at checkout, so the few failures drown in the frontend's own error noise.
      "cart",
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
  },
  {
    name: "adFailure",
    flag: "adFailure",
    variant: "on",
    trigger: { promql: errorRate("ad"), threshold: 0.02 },
    alert: { alertname: "HighErrorRate", service: "frontend", summary: "frontend dependency errors are elevated" },
    rootCause: { service: "ad", text: "The ad service fails GetAds requests.", alternatives: [] },
    focus: ["ad", "frontend"],
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
    }),
  ),
  ...["100x", "10000x"].map(
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
    }),
  ),
  ...["1sec", "5sec"].map(
    (v): Scenario => ({
      name: `kafkaQueueProblems-${v}`,
      flag: "kafkaQueueProblems",
      variant: v,
      trigger: { promql: 'sum(kafka_consumer_lag{topic="orders"})', threshold: 100 },
      alert: { alertname: "ConsumerLag", service: "fraud-detection", summary: "orders consumer lag is growing" },
      rootCause: {
        service: "fraud-detection",
        text: "The fraud-detection consumer is throttled, so lag on the orders topic climbs.",
        alternatives: ["slow Kafka consumer in fraud-detection"],
      },
      focus: ["fraud-detection", "accounting", "checkout", "kafka"],
    }),
  ),
  {
    name: "kafkaConsumerDead",
    flag: "kafkaConsumerDead",
    variant: "on",
    trigger: { promql: 'sum(kafka_consumer_lag{topic="orders"})', threshold: 100 },
    alert: { alertname: "ConsumerLag", service: "fraud-detection", summary: "orders consumer lag is growing" },
    rootCause: {
      service: "fraud-detection",
      text: "fraud-detection left the orders consumer group, so nothing consumes and lag climbs.",
      alternatives: ["the orders consumer group has zero members"],
    },
    focus: ["fraud-detection", "checkout", "kafka"],
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
  },
]

export const findScenario = (name: string) => Scenarios.find((s) => s.name === name)
