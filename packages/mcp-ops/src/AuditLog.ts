import { Context, DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { OpsConfig } from "./OpsConfig.ts"

export const AuditOutcome = Schema.Literals(["rejected", "accepted", "executed", "failed", "dry_run"])

/** One line of the append-only audit log. Never contains the token signature. */
export const AuditEntry = Schema.Struct({
  at: Schema.String,
  tool: Schema.String,
  outcome: AuditOutcome,
  detail: Schema.String,
  params: Schema.Record(Schema.String, Schema.String),
  proposalId: Schema.optionalKey(Schema.String),
  approver: Schema.optionalKey(Schema.String),
  actionHash: Schema.optionalKey(Schema.String),
})
export type AuditEntry = typeof AuditEntry.Type

const encodeLine = Schema.encodeSync(Schema.fromJsonString(AuditEntry))

/**
 * Append-only JSONL audit of every `mcp-ops` call, accepted or not.
 * M2 mirrors these entries into the Postgres audit table owned by the api.
 */
export class AuditLog extends Context.Service<
  AuditLog,
  {
    append(entry: Omit<AuditEntry, "at">): Effect.Effect<void>
  }
>()("@incident/mcp-ops/AuditLog") {
  static readonly layerFile = Layer.effect(
    AuditLog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { auditLogPath } = yield* OpsConfig
      yield* fs.makeDirectory(path.dirname(auditLogPath), { recursive: true })
      const append = Effect.fn("AuditLog.append")(function* (entry: Omit<AuditEntry, "at">) {
        const at = DateTime.formatIso(yield* DateTime.now)
        yield* fs.writeFileString(auditLogPath, `${encodeLine({ at, ...entry })}\n`, { flag: "a" })
      }, Effect.orDie)
      return AuditLog.of({ append })
    }),
  )
}
