import { fileURLToPath } from "node:url"
import { ApprovalToken, type OpsAction, OpsResult, type OpsToolName } from "@incident/contracts"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { connect, endpointFromConfig, type McpError, type McpSession, transportFor } from "./McpSession.ts"

const defaultEntry = fileURLToPath(new URL("../../../../packages/mcp-ops/src/main.ts", import.meta.url))

/** Variables a spawned `mcp-ops` needs, including the signing key it verifies tokens with. */
const PASS_ENV = [
  "APPROVAL_SIGNING_KEY",
  "OTEL_DEMO_DIR",
  "OTEL_DEMO_COMPOSE_PROJECT",
  "OTEL_DEMO_COMPOSE_FILES",
  "FLAGD_CONFIG_PATH",
  "OPS_STATE_DIR",
  "OPS_AUDIT_LOG",
  "OPS_DRY_RUN",
  "DOCKER_HOST",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SDK_DISABLED",
  "OTEL_RESOURCE_ATTRIBUTES",
]

/** `mcp-ops` refused or failed the action (bad token, execution error, malformed result). */
export class OpsExecutionFailed extends Schema.TaggedError<OpsExecutionFailed>()("OpsExecutionFailed", {
  tool: Schema.String,
  message: Schema.String,
}) {}

export type OpsOutcome = typeof OpsResult.Type

const encodeToken = Schema.encodeSync(ApprovalToken)
const decodeResult = Schema.decodeUnknownEffect(OpsResult)

/** The `mcp-ops` tool and arguments for an action. Exhaustive over `OpsAction`. */
export const opsCall = (
  action: OpsAction,
  token: ApprovalToken,
): { readonly tool: OpsToolName; readonly args: Record<string, unknown> } => {
  const approvalToken = encodeToken(token)
  switch (action._tag) {
    case "ToggleFlag":
      return { tool: "toggle_flag", args: { flag: action.flag, variant: action.variant, approvalToken } }
    case "RestartService":
      return { tool: "restart_service", args: { service: action.service, approvalToken } }
    case "RollbackService":
      return {
        tool: "rollback_service",
        args: { service: action.service, imageTag: action.imageTag, approvalToken },
      }
  }
}

/**
 * The write-capable MCP server. Only `ApprovalExecutor` uses this service, and only with a token signed after a
 * human approved the exact action; the investigation agent has no path to it (security rule 1).
 */
export class OpsGateway extends Context.Service<
  OpsGateway,
  {
    execute(action: OpsAction, token: ApprovalToken): Effect.Effect<OpsOutcome, OpsExecutionFailed | McpError>
  }
>()("@incident/api/mcp/OpsGateway") {
  static readonly fromSession = (open: Effect.Effect<McpSession, McpError, Scope.Scope>): OpsGateway["Service"] => {
    const execute = Effect.fn("OpsGateway.execute")(function* (action: OpsAction, token: ApprovalToken) {
      const { tool, args } = opsCall(action, token)
      const session = yield* open
      const result = yield* session.call(tool, args)
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      if (result.isError === true) return yield* new OpsExecutionFailed({ tool, message: text })
      const output = yield* decodeResult(result.structuredContent).pipe(
        Effect.mapError(() => new OpsExecutionFailed({ tool, message: "mcp-ops returned a malformed result" })),
      )
      if (!output.ok) return yield* new OpsExecutionFailed({ tool, message: output.message })
      return output
    }, Effect.scoped)
    return OpsGateway.of({ execute })
  }

  /** `OPS_MCP_URL` + `OPS_MCP_TOKEN` for Streamable HTTP, otherwise spawns `mcp-ops` over stdio per action. */
  static readonly layer = Layer.effect(
    OpsGateway,
    Effect.map(endpointFromConfig("OPS", defaultEntry, PASS_ENV), (endpoint) =>
      OpsGateway.fromSession(connect("mcp-ops", () => transportFor(endpoint), { callTimeout: "2 minutes" })),
    ),
  )
}
