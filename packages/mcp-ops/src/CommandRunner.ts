import { Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  message: Schema.String,
}) {}

/** Runs an executable with an argument array (never through a shell) and returns its stdout. */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    run(command: string, args: ReadonlyArray<string>): Effect.Effect<string, CommandFailed>
  }
>()("@incident/mcp-ops/CommandRunner") {
  static readonly layer = Layer.effect(
    CommandRunner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = Effect.fn("CommandRunner.run")(function* (command: string, args: ReadonlyArray<string>) {
        const label = [command, ...args].join(" ")
        yield* Effect.annotateCurrentSpan({ "process.command": command })
        const fail = (message: string) => new CommandFailed({ command: label, message })
        return yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make(command, [...args]))
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          if (exitCode !== 0) return yield* fail(`exit code ${exitCode}: ${stderr.trim().slice(0, 500)}`)
          return stdout
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({ duration: Duration.minutes(3), orElse: () => Effect.fail(fail("timed out")) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(fail(error.message))),
        )
      })
      return CommandRunner.of({ run })
    }),
  )
}
