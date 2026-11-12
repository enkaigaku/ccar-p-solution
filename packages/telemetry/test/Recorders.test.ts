import { assert, describe, it } from "@effect/vitest"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect, Metric } from "effect"
import { Attr, SpanName } from "../src/Conventions.ts"
import {
  recordFeedback,
  recordInvestigationOutcome,
  recordRetrieval,
  recordUnapprovedWriteAttempt,
} from "../src/GenAi.ts"
import * as Metrics from "../src/Metrics.ts"
import { layerFromProcessors } from "../src/Telemetry.ts"

// Metric state is process-global, so each assertion compares before and after the call.
const counterValue = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.map((s) => s.count))

const histogramValue = (metric: Metric.Histogram<number>, attributes?: Record<string, string>) =>
  Metric.value(attributes === undefined ? metric : Metric.withAttributes(metric, attributes))

const spanAttributes = (exporter: InMemorySpanExporter, name: string) => {
  const span = exporter.getFinishedSpans().find((s) => s.name === name)
  assert.isDefined(span, `span ${name}`)
  return span?.attributes ?? {}
}

const testLayer = (exporter: InMemorySpanExporter) =>
  layerFromProcessors({ serviceName: "telemetry-test" }, { spanProcessor: new SimpleSpanProcessor(exporter) })

describe("recorders", () => {
  it.effect("recordInvestigationOutcome counts by status and observes cost and tool calls", () => {
    const exporter = new InMemorySpanExporter()
    return Effect.gen(function* () {
      const countBefore = yield* counterValue(Metrics.investigations, { status: "insufficient_information" })
      const costBefore = yield* histogramValue(Metrics.investigationCostUsd)
      const toolsBefore = yield* histogramValue(Metrics.investigationToolCalls)

      yield* recordInvestigationOutcome({ status: "insufficient_information", costUsd: 0.12, toolCalls: 7 }).pipe(
        Effect.withSpan(SpanName.investigation),
      )

      assert.strictEqual(
        yield* counterValue(Metrics.investigations, { status: "insufficient_information" }),
        countBefore + 1,
      )
      const cost = yield* histogramValue(Metrics.investigationCostUsd)
      assert.strictEqual(cost.count, costBefore.count + 1)
      assert.closeTo(cost.sum - costBefore.sum, 0.12, 1e-12)
      const tools = yield* histogramValue(Metrics.investigationToolCalls)
      assert.strictEqual(tools.count, toolsBefore.count + 1)
      assert.strictEqual(tools.sum - toolsBefore.sum, 7)

      assert.strictEqual(spanAttributes(exporter, SpanName.investigation)[Attr.costUsd], 0.12)
    }).pipe(Effect.provide(testLayer(exporter)))
  })

  it.effect("recordFeedback counts by rating", () =>
    Effect.gen(function* () {
      const up = yield* counterValue(Metrics.feedback, { rating: "up" })
      const down = yield* counterValue(Metrics.feedback, { rating: "down" })
      yield* recordFeedback("up")
      yield* recordFeedback("up")
      yield* recordFeedback("down")
      assert.strictEqual(yield* counterValue(Metrics.feedback, { rating: "up" }), up + 2)
      assert.strictEqual(yield* counterValue(Metrics.feedback, { rating: "down" }), down + 1)
    }),
  )

  it.effect("recordRetrieval observes the top-1 score per index version and tags the span", () => {
    const exporter = new InMemorySpanExporter()
    return Effect.gen(function* () {
      const labels = { index_version: "idx-2026-11-12" }
      const before = yield* histogramValue(Metrics.retrievalTop1Score, labels)

      yield* recordRetrieval("idx-2026-11-12", 0.83).pipe(Effect.withSpan(SpanName.retrieve))

      const after = yield* histogramValue(Metrics.retrievalTop1Score, labels)
      assert.strictEqual(after.count, before.count + 1)
      assert.closeTo(after.sum - before.sum, 0.83, 1e-12)
      // Another index version's series is untouched.
      const other = yield* histogramValue(Metrics.retrievalTop1Score, { index_version: "idx-other" })
      assert.strictEqual(other.count, 0)

      assert.strictEqual(spanAttributes(exporter, SpanName.retrieve)[Attr.indexVersion], "idx-2026-11-12")
    }).pipe(Effect.provide(testLayer(exporter)))
  })

  it.effect("recordUnapprovedWriteAttempt counts by reason", () =>
    Effect.gen(function* () {
      const expired = yield* counterValue(Metrics.unapprovedWriteAttempts, { reason: "expired" })
      const mismatch = yield* counterValue(Metrics.unapprovedWriteAttempts, { reason: "action_hash_mismatch" })
      yield* recordUnapprovedWriteAttempt("expired")
      assert.strictEqual(yield* counterValue(Metrics.unapprovedWriteAttempts, { reason: "expired" }), expired + 1)
      assert.strictEqual(
        yield* counterValue(Metrics.unapprovedWriteAttempts, { reason: "action_hash_mismatch" }),
        mismatch,
      )
    }),
  )
})
