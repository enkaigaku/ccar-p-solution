import { fileURLToPath } from "node:url"
import { sha256Hex } from "@incident/telemetry"
import { Config, Context, DateTime, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"

const defaultAuditLog = fileURLToPath(new URL("../../../../infra/.api-state/audit.jsonl", import.meta.url))

export const AuditKind = Schema.Literals(["llm_request", "llm_response", "tool_result", "approval", "ops_result"])
export type AuditKind = typeof AuditKind.Type

/**
 * One append-only audit record. This is where prompt and tool-result text goes (security rule 5): spans carry
 * only `sha256`, and `traceId` joins the two. Secrets and approval signatures are never written here.
 */
export const AuditRecord = Schema.Struct({
  at: Schema.String,
  kind: AuditKind,
  investigationId: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  /** Tool name, model or proposal id, depending on `kind`. */
  subject: Schema.String,
  sha256: Schema.String,
  payload: Schema.String,
})
export type AuditRecord = typeof AuditRecord.Type
export type AuditInput = Omit<AuditRecord, "at" | "traceId" | "sha256">

const encodeLine = Schema.encodeSync(Schema.fromJsonString(AuditRecord))

/**
 * Audit trail of model calls, tool results and approval actions. JSONL for now (the same shape as `mcp-ops`'s
 * audit log); the Postgres audit table replaces the file layer behind the same interface.
 */
export class AuditLog extends Context.Service<
  AuditLog,
  {
    append(record: AuditInput): Effect.Effect<void>
  }
>()("@incident/api/audit/AuditLog") {
  /** `API_AUDIT_LOG`, default `infra/.api-state/audit.jsonl` (git-ignored). */
  static readonly layerFile = Layer.effect(
    AuditLog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = yield* Config.String("API_AUDIT_LOG").pipe(Config.withDefault(defaultAuditLog))
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      const append = Effect.fn("AuditLog.append")(function* (record: AuditInput) {
        const at = DateTime.formatIso(yield* DateTime.now)
        const line = encodeLine({ ...record, ...(yield* currentTrace), sha256: sha256Hex(record.payload), at })
        yield* fs.writeFileString(file, `${line}\n`, { flag: "a" })
      }, Effect.orDie)
      return AuditLog.of({ append })
    }),
  )

  /** Keeps records in memory; tests read them back through `records`. */
  static readonly makeMemory = Effect.gen(function* () {
    const records = yield* Ref.make<ReadonlyArray<AuditRecord>>([])
    const service = AuditLog.of({
      append: (record) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now)
          const trace = yield* currentTrace
          yield* Ref.update(records, (xs) => [...xs, { ...record, ...trace, sha256: sha256Hex(record.payload), at }])
        }),
    })
    return { service, records: Ref.get(records) }
  })

  static readonly layerMemory = Layer.effect(
    AuditLog,
    Effect.map(AuditLog.makeMemory, (m) => m.service),
  )
}

const currentTrace: Effect.Effect<{ readonly traceId?: string }> = Effect.currentParentSpan.pipe(
  Effect.map((span) => ({ traceId: span.traceId })),
  Effect.orElseSucceed(() => ({})),
)
