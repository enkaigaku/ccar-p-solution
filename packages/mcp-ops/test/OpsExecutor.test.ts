import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Ref } from "effect"
import { CommandRunner } from "../src/CommandRunner.ts"
import { OpsConfig } from "../src/OpsConfig.ts"
import { imageRepository, OpsExecutor } from "../src/OpsExecutor.ts"

const flagdFile = {
  $schema: "https://flagd.dev/schema/v0/flags.json",
  flags: {
    paymentFailure: {
      description: "Fail payment service charge requests n%",
      state: "ENABLED",
      variants: { "100%": 1, "50%": 0.5, off: 0 },
      defaultVariant: "off",
    },
  },
}

/** Executor wired to a temp state dir and a fake `docker` that records its arguments. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  const flagdConfigPath = `${dir}/demo.flagd.json`
  yield* fs.writeFileString(flagdConfigPath, JSON.stringify(flagdFile))
  yield* fs.writeFileString(`${dir}/compose.yaml`, "services: {}\n")
  const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
  const runner = CommandRunner.of({
    run: (_command, args) =>
      Ref.update(calls, (xs) => [...xs, args]).pipe(
        Effect.as(
          args[0] === "ps" ? "c0ffee\n" : args[0] === "inspect" ? '"ghcr.io/open-telemetry/demo:2.1.3-checkout"\n' : "",
        ),
      ),
  })
  const executor = yield* OpsExecutor.pipe(
    Effect.provide(
      OpsExecutor.layer.pipe(
        Layer.provide(Layer.succeed(CommandRunner, runner)),
        Layer.provide(
          Layer.succeed(
            OpsConfig,
            OpsConfig.of({
              composeProject: "otel-demo",
              demoDir: dir,
              composeFiles: ["compose.yaml", "compose.extras.yaml"],
              flagdConfigPath,
              stateDir: dir,
              auditLogPath: `${dir}/audit.jsonl`,
              dryRun: false,
            }),
          ),
        ),
      ),
    ),
  )
  return { fs, dir, flagdConfigPath, calls, executor }
})

describe("OpsExecutor", () => {
  it.effect("toggleFlag rewrites defaultVariant and keeps every other field", () =>
    Effect.gen(function* () {
      const { fs, flagdConfigPath, executor } = yield* setup
      yield* executor.toggleFlag("paymentFailure", "50%")
      const written = JSON.parse(yield* fs.readFileString(flagdConfigPath))
      assert.deepStrictEqual(written, {
        ...flagdFile,
        flags: { paymentFailure: { ...flagdFile.flags.paymentFailure, defaultVariant: "50%" } },
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("toggleFlag refuses unknown flags and variants", () =>
    Effect.gen(function* () {
      const { executor } = yield* setup
      const unknownFlag = yield* Effect.flip(executor.toggleFlag("nope", "off"))
      assert.match(unknownFlag.message, /Unknown flag/)
      const unknownVariant = yield* Effect.flip(executor.toggleFlag("paymentFailure", "75%"))
      assert.match(unknownVariant.message, /no variant/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("restartService restarts the compose service's containers", () =>
    Effect.gen(function* () {
      const { calls, executor } = yield* setup
      yield* executor.restartService("checkout")
      const [ps, restart] = yield* Ref.get(calls)
      assert.isTrue(ps?.includes("label=com.docker.compose.service=checkout"))
      assert.isTrue(ps?.includes("label=com.docker.compose.project=otel-demo"))
      assert.deepStrictEqual(restart, ["restart", "c0ffee"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("rollbackService writes an override and redeploys only that service", () =>
    Effect.gen(function* () {
      const { fs, dir, calls, executor } = yield* setup
      const message = yield* executor.rollbackService("checkout", "2.1.2-checkout")
      assert.match(message, /ghcr.io\/open-telemetry\/demo:2.1.2-checkout/)
      const override = JSON.parse(yield* fs.readFileString(`${dir}/rollback.override.yaml`))
      assert.deepStrictEqual(override, {
        services: { checkout: { image: "ghcr.io/open-telemetry/demo:2.1.2-checkout" } },
      })
      const up = (yield* Ref.get(calls)).at(-1) ?? []
      assert.deepStrictEqual(up.slice(0, 9), [
        "compose",
        "--project-name",
        "otel-demo",
        "--project-directory",
        dir,
        "--file",
        `${dir}/compose.yaml`,
        "--file",
        `${dir}/rollback.override.yaml`,
      ])
      assert.deepStrictEqual(up.slice(-5), ["up", "--detach", "--no-deps", "--", "checkout"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("refuses service names and tags that could be read as CLI options", () =>
    Effect.gen(function* () {
      const { calls, executor } = yield* setup
      assert.match((yield* Effect.flip(executor.restartService("--all"))).message, /Invalid service/)
      assert.match((yield* Effect.flip(executor.rollbackService("checkout", "-x"))).message, /Invalid imageTag/)
      assert.deepStrictEqual(yield* Ref.get(calls), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

describe("imageRepository", () => {
  it("strips the tag but keeps a registry port", () => {
    assert.strictEqual(imageRepository("ghcr.io/open-telemetry/demo:2.1.3-checkout"), "ghcr.io/open-telemetry/demo")
    assert.strictEqual(imageRepository("localhost:5000/demo:1.0"), "localhost:5000/demo")
    assert.strictEqual(imageRepository("localhost:5000/demo"), "localhost:5000/demo")
    assert.strictEqual(imageRepository("demo@sha256:abc"), "demo")
  })
})
