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
    set(flag: string, variant: string): Effect.Effect<void, FlagdError>
    readonly reset: Effect.Effect<void, FlagdError>
  }
>()("@incident/evals/record/Flagd") {
  static readonly layerFile = (path: string) =>
    Layer.effect(
      Flagd,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const codec = Schema.fromJsonString(FlagdFile)
        const wrap = (message: string) => (cause: unknown) => new FlagdError({ message, cause })

        const update = (f: (file: FlagdFile) => FlagdFile | FlagdError) =>
          Effect.gen(function* () {
            const text = yield* fs.readFileString(path).pipe(Effect.mapError(wrap(`cannot read ${path}`)))
            const file = yield* Schema.decodeUnknownEffect(codec)(text).pipe(Effect.mapError(wrap("bad flagd file")))
            const next = f(file)
            if (next instanceof FlagdError) return yield* next
            const json = JSON.stringify(Schema.encodeSync(FlagdFile)(next), null, 2)
            // Write then rename so flagd never reads a half-written file.
            yield* fs.writeFileString(`${path}.tmp`, `${json}\n`).pipe(Effect.mapError(wrap("cannot write flagd file")))
            yield* fs.rename(`${path}.tmp`, path).pipe(Effect.mapError(wrap("cannot replace flagd file")))
          })

        return Flagd.of({
          set: (flag, variant) => update((file) => setVariant(allOff(file), flag, variant)),
          reset: update(allOff),
        })
      }),
    )
}
