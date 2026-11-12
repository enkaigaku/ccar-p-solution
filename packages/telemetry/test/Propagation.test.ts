import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { currentTraceMeta, formatTraceparent, parseTraceparent, withTraceMeta } from "../src/Propagation.ts"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const SPAN_ID = "00f067aa0ba902b7"

describe("traceparent", () => {
  it("round-trips a sampled context", () => {
    const parsed = Option.getOrThrow(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`))
    assert.strictEqual(parsed.traceId, TRACE_ID)
    assert.strictEqual(parsed.spanId, SPAN_ID)
    assert.isTrue(parsed.sampled)
    assert.strictEqual(formatTraceparent(parsed), `00-${TRACE_ID}-${SPAN_ID}-01`)
  })

  it("reads the sampled flag", () => {
    assert.isFalse(Option.getOrThrow(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)).sampled)
  })

  it("rejects malformed and all-zero values", () => {
    for (const value of ["", "garbage", `01-${TRACE_ID}-${SPAN_ID}-01`, `00-${"0".repeat(32)}-${SPAN_ID}-01`]) {
      assert.isTrue(Option.isNone(parseTraceparent(value)), value)
    }
  })

  it.effect("is empty outside a span", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* currentTraceMeta, {})
    }),
  )

  it.effect("carries the current span across an MCP hop", () =>
    Effect.gen(function* () {
      const meta = yield* currentTraceMeta.pipe(Effect.withSpan("client"))
      assert.isString(meta.traceparent)
      const clientTraceId = meta.traceparent?.split("-")[1]

      // Server side: spans started under withTraceMeta join the client's trace.
      const serverSpan = yield* Effect.currentSpan.pipe(Effect.withSpan("server"), withTraceMeta(meta))
      assert.strictEqual(serverSpan.traceId, clientTraceId)
    }),
  )

  it.effect("starts a new trace when _meta has no valid traceparent", () =>
    Effect.gen(function* () {
      const valid = yield* Effect.currentSpan.pipe(
        Effect.withSpan("server"),
        withTraceMeta({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` }),
      )
      assert.strictEqual(valid.traceId, TRACE_ID)
      const invalid = yield* Effect.currentSpan.pipe(Effect.withSpan("server"), withTraceMeta({ traceparent: "bad" }))
      assert.notStrictEqual(invalid.traceId, TRACE_ID)
    }),
  )
})
