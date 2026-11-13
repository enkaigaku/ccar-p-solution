import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { CommandRunner } from "../src/CommandRunner.ts"
import { ObsConfig } from "../src/ObsConfig.ts"
import { makeObservabilityServer } from "../src/ObservabilityServer.ts"
import type { TelemetrySource } from "../src/TelemetrySource.ts"

/** Connect an MCP client to the observability server built on `source`. */
export const connect = (source: Layer.Layer<TelemetrySource>) =>
  Effect.gen(function* () {
    const server = yield* makeObservabilityServer.pipe(Effect.provide(source))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "0.0.0" })
    yield* Effect.acquireRelease(
      Effect.promise(() => Promise.all([server.connect(serverTransport), client.connect(clientTransport)])),
      () => Effect.promise(() => client.close()),
    )
    const call = (name: string, args: Record<string, unknown>) =>
      Effect.promise(() => client.callTool({ name, arguments: args })).pipe(
        Effect.map((result): CallToolResult => CallToolResultSchema.parse(result)),
      )
    return { client, call }
  })

export const text = (result: CallToolResult): string =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("")

/** A fake HTTP backend: maps the request URL (path + query) to a JSON body and status. */
export const fakeHttp = (route: (url: URL) => { readonly status?: number; readonly body: unknown }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const { status = 200, body } = route(url)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    }),
  )

export const fakeDocker = (route: (args: ReadonlyArray<string>) => string) =>
  Layer.succeed(CommandRunner, CommandRunner.of({ run: (_cmd, args) => Effect.succeed(route(args)) }))

export const testConfig = (overrides: Partial<ObsConfig["Service"]> = {}) =>
  Layer.succeed(
    ObsConfig,
    ObsConfig.of({
      prometheusUrl: "http://prometheus",
      lokiUrl: "http://loki",
      tempoUrl: "http://tempo",
      lokiServiceLabel: "service_name",
      lokiLevelLabel: "detected_level",
      serviceGraphMetric: "traces_service_graph_request_total",
      topologyFile: new URL("../src/topology/otel-demo.json", import.meta.url).pathname,
      composeProject: "otel-demo",
      ...overrides,
    }),
  )
