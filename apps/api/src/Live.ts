import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Retriever } from "@incident/contracts"
import { RetrieverLive } from "@incident/rag"
import { Config, Effect, Layer, Option } from "effect"
import { Investigator } from "./agent/Investigator.ts"
import { ApprovalExecutor } from "./approval/ApprovalExecutor.ts"
import { AuditLog } from "./audit/AuditLog.ts"
import { ClaudeClient } from "./claude/ClaudeClient.ts"
import { InvestigationEvents } from "./events/InvestigationEvents.ts"
import { IncidentStore } from "./IncidentStore.ts"
import { InvestigationRunner } from "./InvestigationRunner.ts"
import { ObservabilityGateway } from "./mcp/ObservabilityGateway.ts"
import { OpsGateway } from "./mcp/OpsGateway.ts"
import { Triage } from "./triage/Triage.ts"

/**
 * `Retriever` from `@incident/rag` over Postgres when `DATABASE_URL` is set; otherwise the contracts stub, so the
 * api still starts for console development without a database.
 */
export const RetrieverFromEnv = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))
    if (Option.isNone(url)) {
      yield* Effect.logWarning("DATABASE_URL is not set; using the stub retriever")
      return Retriever.layerStub
    }
    return RetrieverLive.pipe(Layer.provide(PgClient.layer({ url: url.value })))
  }),
)

/** Everything behind the HTTP handlers: store, events, triage, agent, approvals, with live dependencies. */
export const AppLive = InvestigationRunner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Triage.layer, Investigator.layer, ApprovalExecutor.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      IncidentStore.layerMemory,
      InvestigationEvents.layer,
      ClaudeClient.layer,
      ObservabilityGateway.layer,
      OpsGateway.layer,
      RetrieverFromEnv,
      AuditLog.layerFile,
    ),
  ),
  Layer.provide(NodeServices.layer),
)
