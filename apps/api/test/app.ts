import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import {
  Authentication,
  IncidentApi,
  IngestError,
  Ingestor,
  IngestReport,
  type Investigation,
  type InvestigationId,
  Principal,
  Retriever,
  type SourceDocument,
} from "@incident/contracts"
import { Duration, Effect, Layer, Ref, Schedule } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { Investigator } from "../src/agent/Investigator.ts"
import { ApprovalExecutor } from "../src/approval/ApprovalExecutor.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"
import { InvestigationEvents } from "../src/events/InvestigationEvents.ts"
import { FeedbackStore } from "../src/feedback/FeedbackStore.ts"
import { HandlersLayer } from "../src/Http.ts"
import { IncidentStore } from "../src/IncidentStore.ts"
import { InvestigationRunner } from "../src/InvestigationRunner.ts"
import { ObservabilityGateway } from "../src/mcp/ObservabilityGateway.ts"
import { OpsGateway } from "../src/mcp/OpsGateway.ts"
import { PostmortemStore } from "../src/postmortem/PostmortemStore.ts"
import { Postmortems } from "../src/postmortem/Postmortems.ts"
import { Triage } from "../src/triage/Triage.ts"
import {
  type FakeReply,
  fakeAnthropic,
  jsonText,
  observabilitySession,
  opsServer,
  reply,
  signingKey,
} from "./harness.ts"

export const makeClient = HttpApiTest.groups(IncidentApi, [
  "system",
  "session",
  "alerts",
  "investigations",
  "proposals",
  "postmortems",
  "feedback",
])

export const operator = new Principal({ subject: "u-1", name: "operator", roles: ["viewer", "responder", "approver"] })

/** An `Ingestor` that records what it was given; `failing` makes every ingest fail. */
const recordingIngestor = (failing: boolean) =>
  Effect.gen(function* () {
    const ingested = yield* Ref.make<ReadonlyArray<SourceDocument>>([])
    const service = Ingestor.of({
      ingest: (docs) =>
        failing
          ? Effect.fail(new IngestError({ sourceId: "*", message: "embedding service is down" }))
          : Ref.update(ingested, (xs) => [...xs, ...docs]).pipe(
              Effect.as(new IngestReport({ indexVersion: "idx-test-2", chunksWritten: 4, chunksSkipped: 0 })),
            ),
    })
    return { layer: Layer.succeed(Ingestor, service), ingested: Ref.get(ingested) }
  })

/**
 * The whole api behind the HTTP handlers, with fake Claude replies, in-process MCP servers, the stub retriever,
 * in-memory stores and a recording ingestor. Published postmortems are written under `corpusDir` (a temp dir).
 */
export const testApp = (
  replies: Array<FakeReply>,
  principal: Principal = operator,
  options?: { readonly ingestFails?: boolean },
) =>
  Effect.gen(function* () {
    const claude = fakeAnthropic(replies)
    const ops = yield* opsServer
    const audit = yield* AuditLog.makeMemory
    const ingestor = yield* recordingIngestor(options?.ingestFails ?? false)
    const corpusDir = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "incident-api-corpus-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    )
    const services = Layer.mergeAll(
      IncidentStore.layerMemory,
      FeedbackStore.layerMemory,
      PostmortemStore.layerMemory,
      InvestigationEvents.layer,
      claude.layer,
      Layer.succeed(AuditLog, audit.service),
      Retriever.layerStub,
      ingestor.layer,
      ObservabilityGateway.layerFrom(observabilitySession),
      Layer.succeed(OpsGateway, OpsGateway.fromSession(ops.open)),
      NodeServices.layer,
    )
    const app = InvestigationRunner.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Triage.layer,
          Layer.effect(Investigator, Investigator.make({ maxTurns: 10, maxCostUsd: 5 })),
          Layer.effect(ApprovalExecutor, ApprovalExecutor.make(signingKey)),
          Layer.effect(Postmortems, Postmortems.make({ corpusDir })),
        ),
      ),
      Layer.provideMerge(services),
    )
    const layer = Layer.mergeAll(
      HandlersLayer.pipe(Layer.provideMerge(app), Layer.provideMerge(Authentication.layerStub(principal))),
      HttpServer.layerServices,
    )
    return {
      layer,
      requests: claude.requests,
      executed: ops.executed,
      audit: audit.records,
      ingested: ingestor.ingested,
      corpusDir,
    }
  })

export const triageReply = reply(
  "end_turn",
  [
    jsonText({
      category: "error-rate",
      service: "checkout",
      severity: "critical",
      summary: "checkout requests fail",
      retrievalQuery: "checkout HighErrorRate errors",
      relatedAlertIds: [],
    }),
  ],
  { model: "claude-haiku-5-5" },
)

export const settled = (client: Effect.Success<typeof makeClient>, id: InvestigationId) =>
  client.investigations.get({ params: { id } }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (inv: Investigation) => inv.status !== "queued" && inv.status !== "running",
    }),
    Effect.timeout(Duration.seconds(10)),
  )
