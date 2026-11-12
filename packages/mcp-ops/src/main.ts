import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Logger } from "effect"
import { ApprovalVerifier } from "./ApprovalVerifier.ts"
import { AuditLog } from "./AuditLog.ts"
import { CommandRunner } from "./CommandRunner.ts"
import { serveHttp, serveStdio } from "./McpToolServer.ts"
import { OpsConfig } from "./OpsConfig.ts"
import { OpsExecutor } from "./OpsExecutor.ts"
import { makeOpsServer } from "./OpsServer.ts"

/**
 * Entry point. `MCP_TRANSPORT=stdio` (default) for the approval executor spawning this process;
 * `MCP_TRANSPORT=http` serves Streamable HTTP on `MCP_HTTP_HOST:MCP_HTTP_PORT/mcp` behind `MCP_HTTP_TOKEN`.
 */
const ExecutorLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { dryRun } = yield* OpsConfig
    return dryRun ? OpsExecutor.layerDryRun : OpsExecutor.layer.pipe(Layer.provide(CommandRunner.layer))
  }),
)

const MainLayer = Layer.mergeAll(ApprovalVerifier.layer, AuditLog.layerFile, ExecutorLayer).pipe(
  Layer.provideMerge(OpsConfig.layer),
  Layer.provideMerge(NodeServices.layer),
  // stdout carries the MCP protocol in stdio mode, so every log line goes to stderr.
  Layer.provideMerge(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
)

const program = Effect.gen(function* () {
  const transport = yield* Config.Literals(["stdio", "http"], "MCP_TRANSPORT").pipe(Config.withDefault("stdio"))
  if (transport === "stdio") return yield* serveStdio(makeOpsServer)
  return yield* serveHttp(makeOpsServer, {
    host: yield* Config.String("MCP_HTTP_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: yield* Config.Port("MCP_HTTP_PORT").pipe(Config.withDefault(3102)),
    token: yield* Config.Redacted("MCP_HTTP_TOKEN"),
  })
})

program.pipe(Effect.provide(MainLayer), NodeRuntime.runMain)
