import { fileURLToPath } from "node:url"
import { Config, Context, Effect, Layer } from "effect"

const defaultDemoDir = fileURLToPath(new URL("../../../infra/.otel-demo", import.meta.url))
const defaultStateDir = fileURLToPath(new URL("../../../infra/.ops-state", import.meta.url))

/** Where the operated system lives and where this server keeps its own state. */
export class OpsConfig extends Context.Service<
  OpsConfig,
  {
    /** Docker Compose project name of the OpenTelemetry Demo. */
    readonly composeProject: string
    /** Checkout of the OpenTelemetry Demo (see `infra/scripts/otel-demo.sh`). */
    readonly demoDir: string
    /**
     * Compose files of the demo, relative to `demoDir`, matching how `infra/scripts/otel-demo.sh` starts it.
     * Missing files are skipped. Rollbacks layer an override on top of them.
     */
    readonly composeFiles: ReadonlyArray<string>
    /** flagd flag definitions file that flagd watches. */
    readonly flagdConfigPath: string
    /** Holds the rollback override compose file and the audit log. */
    readonly stateDir: string
    readonly auditLogPath: string
    /** When true, validated actions are audited but not executed. */
    readonly dryRun: boolean
  }
>()("@incident/mcp-ops/OpsConfig") {
  static readonly layer = Layer.effect(
    OpsConfig,
    Effect.gen(function* () {
      const demoDir = yield* Config.String("OTEL_DEMO_DIR").pipe(Config.withDefault(defaultDemoDir))
      const stateDir = yield* Config.String("OPS_STATE_DIR").pipe(Config.withDefault(defaultStateDir))
      return OpsConfig.of({
        composeProject: yield* Config.String("OTEL_DEMO_COMPOSE_PROJECT").pipe(Config.withDefault("otel-demo")),
        demoDir,
        composeFiles: yield* Config.String("OTEL_DEMO_COMPOSE_FILES").pipe(
          Config.withDefault("compose.yaml,compose.extras.yaml"),
          Config.map((value) =>
            value
              .split(",")
              .map((file) => file.trim())
              .filter((file) => file !== ""),
          ),
        ),
        flagdConfigPath: yield* Config.String("FLAGD_CONFIG_PATH").pipe(
          Config.withDefault(`${demoDir}/src/flagd/demo.flagd.json`),
        ),
        stateDir,
        auditLogPath: yield* Config.String("OPS_AUDIT_LOG").pipe(Config.withDefault(`${stateDir}/audit.jsonl`)),
        dryRun: yield* Config.Boolean("OPS_DRY_RUN").pipe(Config.withDefault(false)),
      })
    }),
  )
}
