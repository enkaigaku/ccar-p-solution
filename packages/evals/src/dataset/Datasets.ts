import { ReplaySnapshot } from "@incident/contracts"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { CalibrationSample, EvalCase, RetrievalCase } from "./EvalCase.ts"

export class DatasetError extends Schema.TaggedError<DatasetError>()("DatasetError", {
  file: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Package root, so datasets resolve the same way from the CLI, promptfoo and tests. */
export const packageRoot = new URL("../../", import.meta.url).pathname

/**
 * Reads the JSON datasets under `datasets/` and replay snapshots under `fixtures/replay/`.
 * Every file is decoded with its Schema; a malformed file fails the whole load instead of being skipped.
 */
export class Datasets extends Context.Service<
  Datasets,
  {
    readonly cases: Effect.Effect<ReadonlyArray<EvalCase>, DatasetError>
    readonly retrieval: Effect.Effect<ReadonlyArray<RetrievalCase>, DatasetError>
    readonly calibration: Effect.Effect<ReadonlyArray<CalibrationSample>, DatasetError>
    snapshot(snapshotId: string): Effect.Effect<ReplaySnapshot, DatasetError>
    readonly replayRoot: string
  }
>()("@incident/evals/dataset/Datasets") {
  static readonly layerAt = (root: string) =>
    Layer.effect(
      Datasets,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const readJson = <S extends Schema.Top & { readonly DecodingServices: never }>(file: string, schema: S) =>
          fs.readFileString(file).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
            Effect.mapError((cause) => new DatasetError({ file, message: cause.message, cause })),
          )

        const readDir = <S extends Schema.Top & { readonly DecodingServices: never }>(dir: string, schema: S) =>
          Effect.gen(function* () {
            const full = path.join(root, dir)
            if (!(yield* fs.exists(full).pipe(Effect.orElseSucceed(() => false)))) return []
            const names = yield* fs
              .readDirectory(full)
              .pipe(Effect.mapError((cause) => new DatasetError({ file: full, message: cause.message, cause })))
            const files = names.filter((name) => name.endsWith(".json")).sort()
            return yield* Effect.forEach(files, (name) => readJson(path.join(full, name), schema))
          })

        const replayRoot = path.join(root, "fixtures", "replay")

        return Datasets.of({
          cases: Effect.map(
            Effect.all([readDir("datasets/fault", EvalCase), readDir("datasets/adversarial", EvalCase)]),
            ([fault, adversarial]) => [...fault, ...adversarial],
          ),
          retrieval: readDir("datasets/retrieval", RetrievalCase),
          calibration: readDir("datasets/calibration", CalibrationSample),
          snapshot: (snapshotId) => readJson(path.join(replayRoot, snapshotId, "snapshot.json"), ReplaySnapshot),
          replayRoot,
        })
      }),
    )
}
