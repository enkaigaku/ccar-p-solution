import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Ingestor, Retriever } from "@incident/contracts"
import { IngestorLive, RetrieverLive } from "@incident/rag"
import { Config, Effect, Layer, Option } from "effect"
import { Investigator } from "./agent/Investigator.ts"
import { ApprovalExecutor } from "./approval/ApprovalExecutor.ts"
import { AuditLog } from "./audit/AuditLog.ts"
import { ClaudeClient } from "./claude/ClaudeClient.ts"
import { InvestigationEvents } from "./events/InvestigationEvents.ts"
import { FeedbackStore } from "./feedback/FeedbackStore.ts"
import { IncidentStore } from "./IncidentStore.ts"
import { InvestigationRunner } from "./InvestigationRunner.ts"
import { ObservabilityGateway } from "./mcp/ObservabilityGateway.ts"
import { OpsGateway } from "./mcp/OpsGateway.ts"
import { PostmortemStore } from "./postmortem/PostmortemStore.ts"
import { Postmortems } from "./postmortem/Postmortems.ts"
import { Triage } from "./triage/Triage.ts"

/**
 * Everything that lives in Postgres. With `DATABASE_URL`: `Retriever` and `Ingestor` from `@incident/rag`, and
 * the feedback and postmortem tables, all on one connection pool. Without it the api still starts for console
 * development: contract stubs for the knowledge base, and stores that forget everything on restart.
 */
export const PersistenceFromEnv = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))
    if (Option.isNone(url)) {
      yield* Effect.logWarning(
        "DATABASE_URL is not set; using the stub retriever and ingestor, feedback and postmortems are kept in memory",
      )
      return Layer.mergeAll(
        Retriever.layerStub,
        Ingestor.layerStub,
        FeedbackStore.layerMemory,
        PostmortemStore.layerMemory,
      )
    }
    return Layer.mergeAll(RetrieverLive, IngestorLive, FeedbackStore.layerPg, PostmortemStore.layerPg).pipe(
      Layer.provide(PgClient.layer({ url: url.value })),
    )
  }),
)

/** Everything behind the HTTP handlers: store, events, triage, agent, approvals, postmortems, with live dependencies. */
export const AppLive = InvestigationRunner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Triage.layer, Investigator.layer, ApprovalExecutor.layer, Postmortems.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      IncidentStore.layerMemory,
      InvestigationEvents.layer,
      ClaudeClient.layer,
      ObservabilityGateway.layer,
      OpsGateway.layer,
      PersistenceFromEnv,
      AuditLog.layerFile,
    ),
  ),
  Layer.provide(NodeServices.layer),
)
