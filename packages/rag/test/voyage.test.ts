import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Redacted, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { EMBEDDING_DIMENSIONS, makeVoyage } from "../src/index.ts"

interface Recorded {
  readonly url: string
  readonly auth: string | undefined
  readonly body: unknown
}

/** HttpClient that records requests and answers from a script of (status, body) pairs; the last entry repeats. */
const scriptedClient = (script: ReadonlyArray<readonly [number, unknown]>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<Array<Recorded>>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const recorded = yield* Ref.updateAndGet(calls, (all) => [
          ...all,
          {
            url: request.url,
            auth: request.headers.authorization,
            body:
              request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
          },
        ])
        const [status, body] = script[Math.min(recorded.length - 1, script.length - 1)] ?? [500, {}]
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))
      }),
    )
    return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) }
  })

const config = {
  apiKey: Redacted.make("test-key"),
  baseUrl: "https://voyage.test/v1",
  embeddingModel: "voyage-4",
  rerankModel: "rerank-2.5",
  timeout: "5 seconds",
} as const

const vector = (x: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => x)

describe("Voyage client", () => {
  it.effect("embeds with the configured model, input type and dimension, in input order", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* scriptedClient([
        [
          200,
          {
            data: [
              { embedding: vector(2), index: 1 },
              { embedding: vector(1), index: 0 },
            ],
          },
        ],
      ])
      const { embedder } = yield* makeVoyage(config).pipe(Effect.provide(layer))
      const result = yield* embedder.embed(["a", "b"], "query")
      assert.deepStrictEqual(
        result.map((v) => v[0]),
        [1, 2],
      )
      const [call] = yield* Ref.get(calls)
      assert.strictEqual(call?.url, "https://voyage.test/v1/embeddings")
      assert.strictEqual(call?.auth, "Bearer test-key")
      assert.deepStrictEqual(call?.body, {
        model: "voyage-4",
        input: ["a", "b"],
        input_type: "query",
        output_dimension: EMBEDDING_DIMENSIONS,
      })
    }),
  )

  it.effect("splits large inputs into batches", () =>
    Effect.gen(function* () {
      const texts = Array.from({ length: 70 }, (_, i) => `t${i}`)
      const calls = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1)
          const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : {}
          const data = (body.input as Array<string>).map((_, index) => ({ embedding: vector(0.5), index }))
          return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ data })))
        }),
      )
      const { embedder } = yield* makeVoyage(config).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
      const result = yield* embedder.embed(texts, "document")
      assert.strictEqual(result.length, 70)
      assert.strictEqual(yield* Ref.get(calls), 2)
    }),
  )

  it.effect("retries 429 and 5xx, then succeeds", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* scriptedClient([
        [429, { detail: "rate limited" }],
        [503, { detail: "unavailable" }],
        [200, { data: [{ index: 0, relevance_score: 0.9 }] }],
      ])
      const { reranker } = yield* makeVoyage(config).pipe(Effect.provide(layer))
      const fiber = yield* Effect.forkChild(reranker.rerank("q", ["doc"], 8))
      yield* TestClock.adjust("10 seconds")
      const result = yield* Fiber.join(fiber)
      assert.deepStrictEqual(result, [{ index: 0, score: 0.9 }])
      assert.strictEqual((yield* Ref.get(calls)).length, 3)
    }),
  )

  it.effect("does not retry 401 and reports a non-retryable error without the key", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* scriptedClient([[401, { detail: "bad key" }]])
      const { reranker } = yield* makeVoyage(config).pipe(Effect.provide(layer))
      const error = yield* Effect.flip(reranker.rerank("q", ["doc"], 8))
      assert.strictEqual(error._tag, "ModelProviderError")
      assert.strictEqual(error.status, 401)
      assert.isFalse(error.retryable)
      assert.notInclude(error.message, "test-key")
      assert.strictEqual((yield* Ref.get(calls)).length, 1)
    }),
  )

  it.effect("rejects vectors with the wrong dimension", () =>
    Effect.gen(function* () {
      const { layer } = yield* scriptedClient([[200, { data: [{ embedding: [1, 2, 3], index: 0 }] }]])
      const { embedder } = yield* makeVoyage(config).pipe(Effect.provide(layer))
      const error = yield* Effect.flip(embedder.embed(["a"], "document"))
      assert.isFalse(error.retryable)
      assert.include(error.message, String(EMBEDDING_DIMENSIONS))
    }),
  )

  it.effect("rejects a malformed response body as non-retryable", () =>
    Effect.gen(function* () {
      const { layer } = yield* scriptedClient([[200, { data: [{ index: 0 }] }]])
      const { reranker } = yield* makeVoyage(config).pipe(Effect.provide(layer))
      const error = yield* Effect.flip(reranker.rerank("q", ["doc"], 8))
      assert.isFalse(error.retryable)
      assert.include(error.message, "unexpected response shape")
    }),
  )

  it.effect("sorts rerank results by score and skips the call for no documents", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* scriptedClient([
        [
          200,
          {
            data: [
              { index: 0, relevance_score: 0.1 },
              { index: 1, relevance_score: 0.8 },
            ],
          },
        ],
      ])
      const { reranker } = yield* makeVoyage(config).pipe(Effect.provide(layer))
      assert.deepStrictEqual(yield* reranker.rerank("q", [], 8), [])
      assert.strictEqual((yield* Ref.get(calls)).length, 0)
      const result = yield* reranker.rerank("q", ["a", "b"], 8)
      assert.deepStrictEqual(
        result.map((r) => r.index),
        [1, 0],
      )
      assert.deepStrictEqual((yield* Ref.get(calls))[0]?.body, {
        model: "rerank-2.5",
        query: "q",
        documents: ["a", "b"],
        top_k: 2,
        truncation: true,
      })
    }),
  )
})
