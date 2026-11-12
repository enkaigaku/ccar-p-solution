import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LiveSourceLayer, messagePattern, summariseSeries, summariseTrace } from "../src/LiveSource.ts"
import { TelemetrySource } from "../src/TelemetrySource.ts"
import { fakeDocker, fakeHttp, testConfig } from "./harness.ts"

const window = { start: "2026-11-12T05:00:00Z", end: "2026-11-12T05:15:00Z" }

const live = (http: ReturnType<typeof fakeHttp>, docker = fakeDocker(() => "")) =>
  TelemetrySource.pipe(
    Effect.provide(LiveSourceLayer.pipe(Layer.provide([testConfig(), http, docker, NodeServices.layer]))),
  )

const ns = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`

describe("summariseSeries", () => {
  it("summarises finite values and keeps an evenly spaced tail ending at the last point", () => {
    const values = Array.from({ length: 30 }, (_, i) => [1_700_000_000 + i * 60, String(i)] as const)
    const out = summariseSeries({ job: "x" }, [...values, [1_700_002_000, "NaN"]], 5)
    assert.deepStrictEqual([out?.min, out?.max, out?.avg, out?.last], [0, 29, 14.5, 29])
    assert.strictEqual(out?.tail.length, 5)
    assert.strictEqual(out?.tail.at(-1)?.[1], 29)
  })

  it("drops series without finite values", () => {
    assert.isUndefined(summariseSeries({}, [[1, "NaN"]]))
  })
})

describe("summariseTrace", () => {
  it("finds the root, total duration, errors and parents", () => {
    const out = summariseTrace({
      batches: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "frontend" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "a",
                  name: "GET /cart",
                  startTimeUnixNano: ns("2026-11-12T05:00:00.000Z"),
                  endTimeUnixNano: ns("2026-11-12T05:00:00.250Z"),
                },
              ],
            },
          ],
        },
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "cart" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "b",
                  parentSpanId: "a",
                  name: "GetCart",
                  startTimeUnixNano: ns("2026-11-12T05:00:00.010Z"),
                  endTimeUnixNano: ns("2026-11-12T05:00:00.210Z"),
                  status: { code: 2 },
                },
              ],
            },
          ],
        },
      ],
    })
    assert.strictEqual(out?.rootService, "frontend")
    assert.strictEqual(out?.durationMs, 250)
    assert.deepStrictEqual(out?.spans[1], {
      service: "cart",
      name: "GetCart",
      durationMs: 200,
      isError: true,
      parent: "frontend/GET /cart",
    })
  })
})

describe("messagePattern", () => {
  it("groups lines that differ only in numbers and ids", () => {
    assert.strictEqual(
      messagePattern("order 123 failed after 2.5s trace 4bf92f3577b34da6"),
      messagePattern("order 987 failed after 10.1s trace 00f067aa0ba902b7"),
    )
  })
})

describe("LiveSource", () => {
  it.effect("query_metrics calls Prometheus query_range and summarises", () =>
    Effect.gen(function* () {
      const seen: Array<URL> = []
      const source = yield* live(
        fakeHttp((url) => {
          seen.push(url)
          return {
            body: {
              status: "success",
              data: {
                resultType: "matrix",
                result: [
                  {
                    metric: { service: "a" },
                    values: [
                      [1_762_923_600, "1"],
                      [1_762_923_660, "3"],
                    ],
                  },
                  { metric: { service: "b" }, values: [[1_762_923_600, "7"]] },
                ],
              },
            },
          }
        }),
      )
      const input = { promql: "rate(x[1m])", ...window, stepSeconds: 60 }
      const out = yield* source.queryMetrics(input)
      assert.strictEqual(seen[0]?.pathname, "/api/v1/query_range")
      assert.strictEqual(seen[0]?.searchParams.get("step"), "60s")
      assert.deepStrictEqual(
        out.series.map((s) => [s.labels.service, s.max]),
        [
          ["b", 7],
          ["a", 3],
        ],
      )
      assert.strictEqual(out.ref, (yield* source.queryMetrics(input)).ref)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("query_metrics surfaces PromQL errors as tool errors", () =>
    Effect.gen(function* () {
      const source = yield* live(
        fakeHttp(() => ({
          status: 400,
          body: { status: "error", errorType: "bad_data", error: "parse error at char 5" },
        })),
      )
      const error = yield* Effect.flip(source.queryMetrics({ promql: "rate(", ...window, stepSeconds: 60 }))
      assert.strictEqual(error.message, "Prometheus returned 400: parse error at char 5")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("query_logs builds LogQL, counts by level and redacts samples", () =>
    Effect.gen(function* () {
      const queries: Array<string> = []
      const source = yield* live(
        fakeHttp((url) => {
          queries.push(url.searchParams.get("query") ?? "")
          return url.pathname.endsWith("/query")
            ? {
                body: {
                  status: "success",
                  data: { result: [{ metric: { detected_level: "error" }, value: [1_762_924_500, "7"] }] },
                },
              }
            : {
                body: {
                  status: "success",
                  data: {
                    result: [
                      {
                        stream: { service_name: "payment" },
                        values: [
                          [ns("2026-11-12T05:10:00Z"), "charge failed for bob@example.com card 4111111111111111"],
                          [ns("2026-11-12T05:11:00Z"), "charge failed for eve@example.com card 4111111111111111"],
                        ],
                      },
                    ],
                  },
                },
              }
        }),
      )
      const out = yield* source.queryLogs({ service: "payment", ...window, contains: 'charge "x"', level: "error" })
      assert.deepStrictEqual(queries, [
        'sum by (detected_level) (count_over_time({service_name="payment"} |= "charge \\"x\\"" | detected_level="error" [900s]))',
        '{service_name="payment"} |= "charge \\"x\\"" | detected_level="error"',
      ])
      assert.strictEqual(out.totalMatched, 7)
      assert.deepStrictEqual(out.topMessages, [{ pattern: "charge failed for [EMAIL] card [CARD]", count: 2 }])
      assert.strictEqual(out.samples[0]?.timestamp, "2026-11-12T05:11:00.000Z")
      assert.strictEqual(out.samples[0]?.ref, `${out.ref}#0`)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("query_logs rejects a service name that could inject LogQL", () =>
    Effect.gen(function* () {
      const source = yield* live(fakeHttp(() => ({ body: {} })))
      const error = yield* Effect.flip(source.queryLogs({ service: 'x"} or {a="b', ...window }))
      assert.match(error.message, /Invalid service/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("get_trace maps a Tempo 404 to 'Trace not found'", () =>
    Effect.gen(function* () {
      const source = yield* live(fakeHttp(() => ({ status: 404, body: "trace not found" })))
      const error = yield* Effect.flip(source.getTrace({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }))
      assert.strictEqual(error.message, "Trace not found")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("get_service_status reads compose containers via docker inspect", () =>
    Effect.gen(function* () {
      const source = yield* live(
        fakeHttp(() => ({ body: {} })),
        fakeDocker((args) =>
          args[0] === "ps"
            ? "id1\nid2\n"
            : JSON.stringify([
                {
                  Name: "/payment",
                  RestartCount: 3,
                  State: { Status: "restarting" },
                  Config: {
                    Image: "ghcr.io/open-telemetry/demo:2.1.3-payment",
                    Labels: { "com.docker.compose.service": "payment" },
                  },
                },
                {
                  Name: "/ad",
                  RestartCount: 0,
                  State: { Status: "running" },
                  Config: { Image: "ghcr.io/open-telemetry/demo:2.1.3-ad", Labels: null },
                },
              ]),
        ),
      )
      const out = yield* source.getServiceStatus({})
      assert.deepStrictEqual(out.services, [
        { name: "ad", state: "running", restarts: 0, imageTag: "2.1.3-ad" },
        { name: "payment", state: "restarting", restarts: 3, imageTag: "2.1.3-payment" },
      ])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("get_service_topology prefers the live service graph", () =>
    Effect.gen(function* () {
      const source = yield* live(
        fakeHttp(() => ({
          body: {
            status: "success",
            data: {
              result: [
                { metric: { client: "frontend", server: "cart", connection_type: "" }, value: [1, "10"] },
                { metric: { client: "cart", server: "valkey-cart", connection_type: "database" }, value: [1, "5"] },
              ],
            },
          },
        })),
      )
      const out = yield* source.getServiceTopology({ service: "valkey-cart" })
      assert.deepStrictEqual(out.edges, [{ from: "cart", to: "valkey-cart", protocol: "database" }])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("get_service_topology falls back to the bundled static topology", () =>
    Effect.gen(function* () {
      const source = yield* live(fakeHttp(() => ({ body: { status: "success", data: { result: [] } } })))
      const out = yield* source.getServiceTopology({ service: "shipping" })
      assert.deepStrictEqual(
        out.edges.map((e) => `${e.from}->${e.to}`),
        ["checkout->shipping", "frontend->shipping", "shipping->quote"],
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
