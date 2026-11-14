/**
 * Flags and variants of the OpenTelemetry Demo 3.1.0 (`src/flagd/demo.flagd.json`), the version
 * `infra/scripts/otel-demo.sh` pins. Update it together with OTEL_DEMO_VERSION.
 */
export const OtelDemoFlags: Record<string, ReadonlyArray<string>> = {
  adFailure: ["off", "on"],
  adHighCpu: ["off", "on"],
  adManualGc: ["off", "on"],
  aiRunawayAgent: ["off", "on"],
  aiSlowResponse: ["10sec", "5sec", "off"],
  cartFailure: ["10%", "100%", "25%", "50%", "75%", "90%", "off"],
  emailMemoryLeak: ["10000x", "1000x", "100x", "10x", "1x", "off"],
  emitRawPii: ["off", "on"],
  failedReadinessProbe: ["off", "on"],
  imageSlowLoad: ["10sec", "5sec", "off"],
  intlShippingSlowdown: ["10sec", "5sec", "off"],
  kafkaQueueProblems: ["off", "on"],
  loadGeneratorFloodHomepage: ["off", "on"],
  paymentFailure: ["10%", "100%", "25%", "50%", "75%", "90%", "off"],
  paymentUnreachable: ["off", "on"],
  productCatalogFailure: ["off", "on"],
  productCatalogLockContention: ["off", "on"],
  recommendationCacheFailure: ["off", "on"],
}
