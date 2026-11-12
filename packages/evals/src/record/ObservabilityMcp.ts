import { type ObservabilityToolName, ObservabilityTools, type RecordedToolCall } from "@incident/contracts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Context, Effect, Layer, Schema } from "effect"

export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  tool: Schema.String,
  message: Schema.String,
  /** The tool ran and reported an error (e.g. trace not found), as opposed to a transport or decode failure. */
  toolError: Schema.Boolean,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type Input<T extends ObservabilityToolName> = (typeof ObservabilityTools)[T]["input"]["Type"]
type Output<T extends ObservabilityToolName> = (typeof ObservabilityTools)[T]["output"]["Type"]

/**
 * Thin Effect wrapper over the official MCP client, connected to a live `mcp-observability` over stdio.
 * The recorder uses it so every recorded output went through the server's own aggregation and PII redaction.
 */
export class ObservabilityMcp extends Context.Service<
  ObservabilityMcp,
  {
    call<T extends ObservabilityToolName>(tool: T, input: Input<T>): Effect.Effect<Output<T>, McpCallError>
  }
>()("@incident/evals/record/ObservabilityMcp") {
  static readonly layerStdio = (command: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
    Layer.effect(
      ObservabilityMcp,
      Effect.gen(function* () {
        const client = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const c = new Client({ name: "incident-evals-recorder", version: "0.0.0" })
              await c.connect(new StdioClientTransport({ command, args: [...args], env, stderr: "inherit" }))
              return c
            },
            catch: (cause) =>
              new McpCallError({ tool: "connect", message: `cannot start ${command}`, toolError: false, cause }),
          }),
          (c) => Effect.promise(() => c.close()),
        )

        const call = <T extends ObservabilityToolName>(tool: T, input: Input<T>) =>
          Effect.gen(function* () {
            const encodedInput = Schema.encodeSync(ObservabilityTools[tool].input as Schema.Codec<Input<T>, unknown>)(
              input,
            )
            const result = yield* Effect.tryPromise({
              try: () => client.callTool({ name: tool, arguments: encodedInput as Record<string, unknown> }),
              catch: (cause) => new McpCallError({ tool, message: String(cause), toolError: false, cause }),
            })
            if (result.isError === true) {
              return yield* new McpCallError({ tool, message: JSON.stringify(result.content), toolError: true })
            }
            return yield* Schema.decodeUnknownEffect(
              ObservabilityTools[tool].output as Schema.Codec<Output<T>, unknown>,
            )(result.structuredContent).pipe(
              Effect.mapError((cause) => new McpCallError({ tool, message: cause.message, toolError: false, cause })),
            )
          })

        return ObservabilityMcp.of({ call })
      }),
    )
}

/** Calls a tool and keeps the call in the shape the snapshot stores. */
export const recordCall = <T extends ObservabilityToolName>(tool: T, input: Input<T>) =>
  Effect.gen(function* () {
    const output = yield* (yield* ObservabilityMcp).call(tool, input)
    return { tool, input, output } as RecordedToolCall
  })
