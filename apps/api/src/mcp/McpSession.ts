import { currentTraceMeta } from "@incident/telemetry"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Config, Duration, Effect, Option, Redacted, Schema, type Scope } from "effect"

/** Transport or protocol failure talking to an MCP server (not a tool reporting `isError`). */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  server: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** One connected MCP client. Every call carries the current trace context in `_meta.traceparent`. */
export interface McpSession {
  readonly server: string
  readonly tools: ReadonlyArray<McpToolDefinition>
  call(name: string, args: Readonly<Record<string, unknown>>): Effect.Effect<CallToolResult, McpError>
}

/** How to reach a server: spawn it over stdio, or connect to a Streamable HTTP endpoint with a bearer token. */
export type McpEndpoint =
  | {
      readonly _tag: "stdio"
      readonly command: string
      readonly args: ReadonlyArray<string>
      /** Only these variables reach the child, on top of the SDK's safe defaults (PATH, HOME, ...). */
      readonly env: Readonly<Record<string, string>>
    }
  | { readonly _tag: "http"; readonly url: string; readonly token: Redacted.Redacted<string> }

export const transportFor = (endpoint: McpEndpoint): Transport =>
  endpoint._tag === "stdio"
    ? new StdioClientTransport({
        command: endpoint.command,
        args: [...endpoint.args],
        env: { ...getDefaultEnvironment(), ...endpoint.env },
        stderr: "inherit",
      })
    : new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { authorization: `Bearer ${Redacted.value(endpoint.token)}` } },
      })

/** Connects an MCP client over `makeTransport` for the lifetime of the scope. */
export const connect = (
  server: string,
  makeTransport: () => Transport,
  options?: { readonly callTimeout?: Duration.Input },
): Effect.Effect<McpSession, McpError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const c = new Client({ name: "incident-api", version: "0.1.0" })
          await c.connect(makeTransport())
          return c
        },
        catch: (cause) => new McpError({ server, message: `cannot connect to ${server}`, cause }),
      }),
      (c) => Effect.promise(() => c.close()).pipe(Effect.ignore),
    )
    return yield* fromClient(server, client, options)
  })

/** Wraps an already connected client (tests connect one over an in-memory transport). */
export const fromClient = Effect.fnUntraced(function* (
  server: string,
  client: Client,
  options?: { readonly callTimeout?: Duration.Input },
) {
  const callTimeout = options?.callTimeout ?? Duration.seconds(30)
  const listed = yield* Effect.tryPromise({
    try: () => client.listTools(),
    catch: (cause) => new McpError({ server, message: "tools/list failed", cause }),
  })
  const tools: ReadonlyArray<McpToolDefinition> = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }))

  const call = (name: string, args: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const meta = yield* currentTraceMeta
      const raw = yield* Effect.tryPromise({
        try: (signal) =>
          client.callTool({ name, arguments: { ...args }, _meta: { ...meta } }, CallToolResultSchema, { signal }),
        catch: (cause) => new McpError({ server, message: `${name} call failed`, cause }),
      })
      return CallToolResultSchema.parse(raw)
    }).pipe(
      Effect.timeoutOrElse({
        duration: callTimeout,
        orElse: () => Effect.fail(new McpError({ server, message: `${name} timed out` })),
      }),
    )

  return { server, tools, call } satisfies McpSession
})

/**
 * Reads an endpoint from the environment: `<PREFIX>_MCP_URL` + `<PREFIX>_MCP_TOKEN` for Streamable HTTP,
 * otherwise stdio with `node <defaultEntry>`. `passEnv` names the variables forwarded to a spawned server.
 */
export const endpointFromConfig = (prefix: string, defaultEntry: string, passEnv: ReadonlyArray<string>) =>
  Effect.gen(function* (): Effect.fn.Return<McpEndpoint, Config.ConfigError> {
    const url = yield* Config.option(Config.String(`${prefix}_MCP_URL`))
    if (Option.isSome(url)) {
      const token = yield* Config.Redacted(`${prefix}_MCP_TOKEN`)
      return { _tag: "http", url: url.value, token }
    }
    const entry = yield* Config.String(`${prefix}_MCP_ENTRY`).pipe(Config.withDefault(defaultEntry))
    const env: Record<string, string> = {}
    for (const name of passEnv) {
      const value = yield* Config.option(Config.String(name))
      if (Option.isSome(value)) env[name] = value.value
    }
    return { _tag: "stdio", command: process.execPath, args: [entry], env }
  })
