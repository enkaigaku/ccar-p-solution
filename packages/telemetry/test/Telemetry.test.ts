import Anthropic from "@anthropic-ai/sdk"
import { assert, describe, it } from "@effect/vitest"
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect, Metric, Option } from "effect"
import { Attr, SpanName } from "../src/Conventions.ts"
import { annotatePrompt, recordClaudeResponse, sha256Hex } from "../src/GenAi.ts"
import * as Metrics from "../src/Metrics.ts"
import { layerFromProcessors } from "../src/Telemetry.ts"

const PROMPT = "Triage this alert: checkout 5xx above 5%"

const message = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "checkout / error-rate / critical" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  },
}

/** A client that never leaves the process: the fetch below answers every request. */
const fakeClient = (seen: Array<Headers>) =>
  new Anthropic({
    apiKey: "test-key-not-a-secret",
    maxRetries: 0,
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers))
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" },
      })
    },
  })

// InMemorySpanExporter clears its spans on shutdown, so assertions run before the layer is released.
const testLayer = (exporter: InMemorySpanExporter) =>
  layerFromProcessors({ serviceName: "telemetry-test" }, { spanProcessor: new SimpleSpanProcessor(exporter) })

const byName = (spans: ReadonlyArray<ReadableSpan>, name: string) => {
  const span = spans.find((s) => s.name === name)
  assert.isDefined(span, `span ${name}`)
  return span as ReadableSpan
}

describe("TelemetryLive wiring", () => {
  it.effect("nests the Anthropic SDK span under the Effect span and records GenAI attributes", () => {
    const exporter = new InMemorySpanExporter()
    const seen: Array<Headers> = []
    return Effect.gen(function* () {
      const client = fakeClient(seen)
      const cost = yield* Effect.gen(function* () {
        yield* annotatePrompt({ step: "triage", promptVersion: "triage@v1", renderedPrompt: PROMPT })
        const response = yield* Effect.promise(() =>
          client.messages.create({
            model: "claude-haiku-5-5",
            max_tokens: 256,
            output_config: { effort: "low" },
            messages: [{ role: "user", content: PROMPT }],
          }),
        )
        return yield* recordClaudeResponse({ step: "triage", requestedModel: "claude-haiku-5-5" }, response)
      }).pipe(Effect.withSpan(SpanName.triage))

      // (100 * 0.1 + 900 * 0.01 + 20 * 0.5) / 1e6
      assert.closeTo(Option.getOrThrow(cost), 29e-6, 1e-12)

      const requests = yield* Metric.value(
        Metric.withAttributes(Metrics.llmRequests, {
          model: "claude-haiku-5-5",
          step: "triage",
          stop_reason: "end_turn",
          fallback: "false",
        }),
      )
      assert.strictEqual(requests.count, 1)
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const spans = exporter.getFinishedSpans()
          const parent = byName(spans, SpanName.triage)
          const sdk = byName(spans, "anthropic.messages.create")

          assert.strictEqual(sdk.spanContext().traceId, parent.spanContext().traceId)
          assert.strictEqual(sdk.parentSpanContext?.spanId, parent.spanContext().spanId)
          assert.strictEqual(sdk.attributes["gen_ai.provider.name"], "anthropic")

          // The SDK forwards the trace context to the API (needed for Claude API server-side spans).
          const traceparent = seen[0]?.get("traceparent") ?? ""
          assert.include(traceparent, sdk.spanContext().traceId)

          assert.strictEqual(parent.attributes[Attr.promptVersion], "triage@v1")
          assert.strictEqual(parent.attributes[Attr.promptSha256], sha256Hex(PROMPT))
          assert.strictEqual(parent.attributes[Attr.genAiInputTokens], 1000)
          assert.strictEqual(parent.attributes[Attr.cacheHitRatio], 0.9)
          assert.strictEqual(parent.attributes[Attr.fallbackUsed], false)
          assert.strictEqual(parent.resource.attributes["service.namespace"], "incident-copilot")

          // Security rule 5: no prompt text on any span.
          for (const span of spans) {
            for (const value of Object.values(span.attributes)) {
              assert.notInclude(String(value), PROMPT)
            }
          }
        }),
      ),
      Effect.provide(testLayer(exporter)),
    )
  })

  it.effect("flags a response served by a fallback model", () => {
    const exporter = new InMemorySpanExporter()
    return recordClaudeResponse(
      { step: "investigate", requestedModel: "claude-opus-5-5" },
      { ...message, model: "claude-opus-5" },
    ).pipe(
      Effect.withSpan(SpanName.investigation),
      Effect.tap(() =>
        Effect.sync(() => {
          const span = byName(exporter.getFinishedSpans(), SpanName.investigation)
          assert.strictEqual(span.attributes[Attr.fallbackUsed], true)
          assert.strictEqual(span.attributes[Attr.genAiResponseModel], "claude-opus-5")
        }),
      ),
      Effect.provide(testLayer(exporter)),
    )
  })
})
