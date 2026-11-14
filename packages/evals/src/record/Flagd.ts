import { Context, Effect, FileSystem, Layer, Schema } from "effect"

/**
 * The OTel Demo's flagd watches `src/flagd/demo.flagd.json` (mounted into the container), so changing a flag's
 * `defaultVariant` in that file injects or clears a fault within seconds. Unknown keys are preserved on rewrite.
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
  static readonly layerFile = (path: string) =>
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

        const update = (f: (file: FlagdFile) => FlagdFile | FlagdError) =>
          Effect.gen(function* () {
            const file = yield* read
            const next = f(file)
            if (next instanceof FlagdError) return yield* next
            const changed = Object.entries(next.flags).some(
              ([name, flag]) => file.flags[name]?.defaultVariant !== flag.defaultVariant,
            )
            const json = JSON.stringify(Schema.encodeSync(FlagdFile)(next), null, 2)
            // Write then rename so flagd never reads a half-written file.
            yield* fs.writeFileString(`${path}.tmp`, `${json}\n`).pipe(Effect.mapError(wrap("cannot write flagd file")))
            yield* fs.rename(`${path}.tmp`, path).pipe(Effect.mapError(wrap("cannot replace flagd file")))
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
