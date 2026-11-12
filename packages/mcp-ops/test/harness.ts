import { type ApprovalToken, type OpsAction, ProposalId, signApprovalToken } from "@incident/contracts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { DateTime, Duration, Effect, Layer, Redacted, Ref } from "effect"
import { ApprovalVerifier } from "../src/ApprovalVerifier.ts"
import { type AuditEntry, AuditLog } from "../src/AuditLog.ts"
import { OpsExecutor } from "../src/OpsExecutor.ts"
import { makeOpsServer } from "../src/OpsServer.ts"

export const secret = Redacted.make("unit-test-signing-secret-0123456789abcdef")

export interface Recorder {
  readonly executed: Ref.Ref<ReadonlyArray<string>>
  readonly audit: Ref.Ref<ReadonlyArray<Omit<AuditEntry, "at">>>
}

/** An `mcp-ops` server wired to fakes, plus a connected MCP client. */
export const connect = Effect.gen(function* () {
  const executed = yield* Ref.make<ReadonlyArray<string>>([])
  const audit = yield* Ref.make<ReadonlyArray<Omit<AuditEntry, "at">>>([])
  const record = (line: string) => Ref.update(executed, (xs) => [...xs, line]).pipe(Effect.as(line))

  const layer = Layer.mergeAll(
    Layer.effect(ApprovalVerifier, ApprovalVerifier.make(secret)),
    Layer.succeed(AuditLog, AuditLog.of({ append: (entry) => Ref.update(audit, (xs) => [...xs, entry]) })),
    Layer.succeed(
      OpsExecutor,
      OpsExecutor.of({
        toggleFlag: (flag, variant) => record(`toggle ${flag} ${variant}`),
        restartService: (service) => record(`restart ${service}`),
        rollbackService: (service, tag) => record(`rollback ${service} ${tag}`),
      }),
    ),
  )
  const server = yield* makeOpsServer.pipe(Effect.provide(layer))
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
  return { client, call, recorder: { executed, audit } satisfies Recorder }
})

export const sign = (action: OpsAction, options?: { readonly ttl?: Duration.Input; readonly proposalId?: string }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    return yield* signApprovalToken(secret, {
      proposalId: ProposalId.make(options?.proposalId ?? "prop-1"),
      action,
      approver: "alice",
      expiresAt: DateTime.addDuration(now, options?.ttl ?? Duration.minutes(5)),
    })
  })

/** The token as it travels over MCP (JSON). */
export const wire = (token: ApprovalToken) => ({
  proposalId: token.proposalId,
  actionHash: token.actionHash,
  approver: token.approver,
  expiresAt: DateTime.formatIso(token.expiresAt),
  signature: token.signature,
})

export const text = (result: CallToolResult): string =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("")
