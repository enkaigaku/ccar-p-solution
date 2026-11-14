import { Context, Duration, Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

/**
 * The OTel Demo's flagd watches `src/flagd/demo.flagd.json` (mounted into the container), so changing a flag's
 * `defaultVariant` in that file injects or clears a fault within seconds. Unknown keys are preserved on rewrite.
 *
 * flagd can lose the file: its watcher has to re-open a file that was replaced by a rename, and when that fails it
 * stops following the file for good, while every later write looks successful from here. So the file is written in
 * place, and when a `ServedVariants` source is given, each write is checked against what flagd actually serves.
 */
const Flag = Schema.StructWithRest(
  Schema.Struct({ defaultVariant: Schema.String, variants: Schema.Record(Schema.String, Schema.Unknown) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export const FlagdFile = Schema.StructWithRest(Schema.Struct({ flags: Schema.Record(Schema.String, Flag) }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
export type FlagdFile = typeof FlagdFile.Type

export class FlagdError extends Schema.TaggedError<FlagdError>()("FlagdError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Pure update so the rules are testable: unknown flags and variants are errors, never silently ignored. */
export const setVariant = (file: FlagdFile, flag: string, variant: string): FlagdFile | FlagdError => {
  const current = file.flags[flag]
  if (current === undefined) return new FlagdError({ message: `unknown flag ${flag}` })
  if (!Object.hasOwn(current.variants, variant)) {
    return new FlagdError({ message: `flag ${flag} has no variant ${variant}` })
  }
  return { ...file, flags: { ...file.flags, [flag]: { ...current, defaultVariant: variant } } }
}

/** One flag set to one variant. A scenario injects one fault, or one fault plus unrelated distractors. */
export interface Fault {
  readonly flag: string
  readonly variant: string
}

/** Applies every fault in turn; the first unknown flag or variant is the result. */
export const setVariants = (file: FlagdFile, faults: ReadonlyArray<Fault>): FlagdFile | FlagdError =>
  faults.reduce<FlagdFile | FlagdError>(
    (acc, fault) => (acc instanceof FlagdError ? acc : setVariant(acc, fault.flag, fault.variant)),
    file,
  )

/** Turns every flag that has an `off` variant off. */
export const allOff = (file: FlagdFile): FlagdFile => ({
  ...file,
  flags: Object.fromEntries(
    Object.entries(file.flags).map(([name, flag]) => [
      name,
      Object.hasOwn(flag.variants, "off") ? { ...flag, defaultVariant: "off" } : flag,
    ]),
  ),
})

/** Variant flagd currently serves for each flag, by flag name. */
export type ServedVariants = Effect.Effect<Readonly<Record<string, string>>, FlagdError>

const ResolveAll = Schema.Struct({ flags: Schema.Record(Schema.String, Schema.Struct({ variant: Schema.String })) })

/**
 * Asks flagd's evaluation API (container port 8013; the host port is assigned by Docker and changes on restart, see
 * `docker port flagd 8013/tcp`) for every flag's variant.
 */
export const servedVariantsFrom = (baseUrl: string): Effect.Effect<ServedVariants, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (http) =>
    HttpClientRequest.post(`${baseUrl.replace(/\/$/, "")}/flagd.evaluation.v1.Service/ResolveAll`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ context: {} }),
      http.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ResolveAll)),
      Effect.map((body) => Object.fromEntries(Object.entries(body.flags).map(([name, f]) => [name, f.variant]))),
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) => new FlagdError({ message: `cannot ask flagd at ${baseUrl}: ${cause.message}`, cause }),
      ),
    ),
  )

/** Flags whose served variant differs from the file's, as `flag: file says X, flagd serves Y`. */
export const servedMismatches = (file: FlagdFile, served: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(file.flags).flatMap(([name, flag]) =>
    served[name] === flag.defaultVariant
      ? []
      : [`${name}: file says ${flag.defaultVariant}, flagd serves ${served[name] ?? "nothing"}`],
  )

export interface FlagdOptions {
  /** When given, every write waits until flagd serves the file's variants, and fails if it never does. */
  readonly served?: ServedVariants | undefined
  /** How long flagd gets to pick up a write. It normally takes a second or two. */
  readonly settle?: Duration.Duration | undefined
}

export class Flagd extends Context.Service<
  Flagd,
  {
    /** Turns every fault off, then these on, in one write. */
    set(faults: ReadonlyArray<Fault>): Effect.Effect<void, FlagdError>
    /** Fails when the flag file lacks one of these flags or variants. Writes nothing. */
    validate(faults: ReadonlyArray<Fault>): Effect.Effect<void, FlagdError>
    /** Turns every fault off. True when at least one flag was on, i.e. a fault was still being injected. */
    readonly reset: Effect.Effect<boolean, FlagdError>
  }
>()("@incident/evals/record/Flagd") {
  static readonly layerFile = (path: string, options: FlagdOptions = {}) =>
    Layer.effect(
      Flagd,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const codec = Schema.fromJsonString(FlagdFile)
        const wrap = (message: string) => (cause: unknown) => new FlagdError({ message, cause })

        const read = Effect.gen(function* () {
          const text = yield* fs.readFileString(path).pipe(Effect.mapError(wrap(`cannot read ${path}`)))
          return yield* Schema.decodeUnknownEffect(codec)(text).pipe(Effect.mapError(wrap("bad flagd file")))
        })

        const settle = options.settle ?? Duration.seconds(20)
        /** Polls flagd until it serves the file's variants; what still differs when the time is up. */
        const mismatchesAfterSettling = (file: FlagdFile) => {
          const served = options.served
          if (served === undefined) return Effect.succeed<ReadonlyArray<string>>([])
          return Effect.map(served, (variants) => servedMismatches(file, variants)).pipe(
            Effect.repeat({
              until: (mismatches: ReadonlyArray<string>) => mismatches.length === 0,
              schedule: Schedule.spaced(Duration.millis(Math.max(1, Duration.toMillis(settle) / 20))),
            }),
            Effect.timeoutOption(settle),
            Effect.flatMap((done) =>
              done._tag === "Some"
                ? Effect.succeed(done.value)
                : Effect.map(served, (variants) => servedMismatches(file, variants)),
            ),
          )
        }

        const update = (f: (file: FlagdFile) => FlagdFile | FlagdError) =>
          Effect.gen(function* () {
            const file = yield* read
            const next = f(file)
            if (next instanceof FlagdError) return yield* next
            const changed = Object.entries(next.flags).some(
              ([name, flag]) => file.flags[name]?.defaultVariant !== flag.defaultVariant,
            )
            const json = JSON.stringify(Schema.encodeSync(FlagdFile)(next), null, 2)
            const write = fs.writeFileString(path, `${json}\n`).pipe(Effect.mapError(wrap("cannot write flagd file")))
            yield* write
            // A read that catches the file half-written is rejected by flagd and followed by another one, so a second
            // write is tried before giving up on flagd.
            if ((yield* mismatchesAfterSettling(next)).length > 0) {
              yield* write
              const still = yield* mismatchesAfterSettling(next)
              if (still.length > 0) {
                return yield* new FlagdError({
                  message: `flagd does not follow ${path} (${still.join("; ")}). Restart flagd, then record again.`,
                })
              }
            }
            return changed
          })

        return Flagd.of({
          set: (faults) => update((file) => setVariants(allOff(file), faults)).pipe(Effect.asVoid),
          validate: (faults) =>
            Effect.flatMap(read, (file) => {
              const next = setVariants(file, faults)
              return next instanceof FlagdError ? Effect.fail(next) : Effect.void
            }),
          reset: update(allOff),
        })
      }),
    )
}
