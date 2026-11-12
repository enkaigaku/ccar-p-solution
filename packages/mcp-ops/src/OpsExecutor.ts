import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect"
import { CommandRunner } from "./CommandRunner.ts"
import { ToolError } from "./McpToolServer.ts"
import { OpsConfig } from "./OpsConfig.ts"

/**
 * Performs state-changing actions on the OpenTelemetry Demo running under docker compose.
 * Callers must have verified an approval first; this service does no authorisation of its own.
 */
export class OpsExecutor extends Context.Service<
  OpsExecutor,
  {
    toggleFlag(flag: string, variant: string): Effect.Effect<string, ToolError>
    restartService(service: string): Effect.Effect<string, ToolError>
    rollbackService(service: string, imageTag: string): Effect.Effect<string, ToolError>
  }
>()("@incident/mcp-ops/OpsExecutor") {
  static readonly layer = Layer.effect(
    OpsExecutor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runner = yield* CommandRunner
      const config = yield* OpsConfig

      const docker = (args: ReadonlyArray<string>) =>
        runner.run("docker", args).pipe(Effect.mapError((e) => new ToolError({ message: e.message })))

      const findContainers = Effect.fnUntraced(function* (service: string) {
        yield* requireFormat("service", service, SERVICE_NAME)
        const out = yield* docker([
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${config.composeProject}`,
          "--filter",
          `label=com.docker.compose.service=${service}`,
        ])
        const ids = out.split("\n").filter((line) => line.trim() !== "")
        if (ids.length === 0) {
          return yield* new ToolError({ message: `No container for service "${service}" in ${config.composeProject}` })
        }
        return ids
      })

      const toggleFlag = Effect.fn("OpsExecutor.toggleFlag")(function* (flag: string, variant: string) {
        const raw = yield* fs.readFileString(config.flagdConfigPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FlagdFile))),
          Effect.mapError(() => new ToolError({ message: "flagd config file is missing or malformed" })),
        )
        const current = raw.flags[flag]
        if (current === undefined) return yield* new ToolError({ message: `Unknown flag "${flag}"` })
        const variants = Predicate.isObject(current.variants) ? Object.keys(current.variants) : []
        if (!variants.includes(variant)) {
          return yield* new ToolError({ message: `Flag "${flag}" has no variant "${variant}"` })
        }
        const updated = { ...raw, flags: { ...raw.flags, [flag]: { ...current, defaultVariant: variant } } }
        // Written in place, like flagd-ui does, so flagd's file watcher on the bind mount picks it up.
        yield* fs
          .writeFileString(config.flagdConfigPath, `${JSON.stringify(updated, null, 2)}\n`)
          .pipe(Effect.mapError(() => new ToolError({ message: "Failed to write flagd config file" })))
        return `Flag "${flag}" default variant set to "${variant}"`
      })

      const restartService = Effect.fn("OpsExecutor.restartService")(function* (service: string) {
        const ids = yield* findContainers(service)
        yield* docker(["restart", ...ids])
        return `Restarted ${ids.length} container(s) of "${service}"`
      })

      const rollbackService = Effect.fn("OpsExecutor.rollbackService")(function* (service: string, imageTag: string) {
        yield* requireFormat("imageTag", imageTag, IMAGE_TAG)
        const [id] = yield* findContainers(service)
        const inspected = yield* docker(["inspect", "--format", "{{json .Config.Image}}", id ?? ""]).pipe(
          Effect.flatMap((out) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))(out.trim()).pipe(
              Effect.mapError(() => new ToolError({ message: "Could not read the current image" })),
            ),
          ),
        )
        const image = `${imageRepository(inspected)}:${imageTag}`

        // Rollbacks accumulate in one override file layered on top of the demo's compose file.
        const overridePath = path.join(config.stateDir, "rollback.override.yaml")
        const existing = yield* fs.readFileString(overridePath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RollbackOverride))),
          Effect.orElseSucceed(() => ({ services: {} })),
        )
        const override = { services: { ...existing.services, [service]: { image } } }
        yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(
          // JSON is valid YAML, so compose reads it directly.
          Effect.andThen(fs.writeFileString(overridePath, `${JSON.stringify(override, null, 2)}\n`)),
          Effect.mapError(() => new ToolError({ message: "Failed to write rollback override file" })),
        )

        const composeFiles = yield* Effect.filter(
          config.composeFiles.map((file) => path.resolve(config.demoDir, file)),
          (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
        )
        yield* docker([
          "compose",
          "--project-name",
          config.composeProject,
          "--project-directory",
          config.demoDir,
          ...composeFiles.flatMap((file) => ["--file", file]),
          "--file",
          overridePath,
          "up",
          "--detach",
          "--no-deps",
          "--",
          service,
        ])
        return `Rolled back "${service}" to ${image}`
      })

      return OpsExecutor.of({ toggleFlag, restartService, rollbackService })
    }),
  )

  /** Validates and audits but never touches the operated system. */
  static readonly layerDryRun = Layer.succeed(
    OpsExecutor,
    OpsExecutor.of({
      toggleFlag: (flag, variant) => Effect.succeed(`[dry run] would set flag "${flag}" to "${variant}"`),
      restartService: (service) => Effect.succeed(`[dry run] would restart "${service}"`),
      rollbackService: (service, imageTag) => Effect.succeed(`[dry run] would roll back "${service}" to ${imageTag}`),
    }),
  )
}

/** Compose service names; also guarantees the value cannot be parsed as a CLI option. */
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
/** Docker tag grammar. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

const requireFormat = (field: string, value: string, pattern: RegExp) =>
  pattern.test(value) ? Effect.void : Effect.fail(new ToolError({ message: `Invalid ${field}: "${value}"` }))

/** The flagd file is rewritten whole, so unknown fields must survive the round trip. */
const FlagdFile = Schema.Struct({
  flags: Schema.Record(
    Schema.String,
    Schema.StructWithRest(Schema.Struct({ variants: Schema.Unknown, defaultVariant: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
}).pipe((s) => Schema.StructWithRest(s, [Schema.Record(Schema.String, Schema.Unknown)]))

const RollbackOverride = Schema.Struct({
  services: Schema.Record(Schema.String, Schema.Struct({ image: Schema.String })),
})

/** `ghcr.io/org/demo:2.1.3-checkout` → `ghcr.io/org/demo`; keeps a registry port such as `host:5000/x`. */
export const imageRepository = (image: string): string => {
  const withoutDigest = image.split("@")[0] ?? image
  const lastColon = withoutDigest.lastIndexOf(":")
  return lastColon > withoutDigest.lastIndexOf("/") ? withoutDigest.slice(0, lastColon) : withoutDigest
}
