import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, DateTime, Effect, FileSystem, Layer, Option } from "effect"
import { ObservabilityGateway } from "../src/mcp/ObservabilityGateway.ts"
import { webhook } from "./fixtures.ts"

const snapshot = {
  version: 1,
  caseId: "fc-1",
  recordedAt: "2026-11-12T03:06:30Z",
  window: { start: "2026-11-12T02:56:00Z", end: "2026-11-12T03:06:00Z" },
  alert: webhook.alerts[0],
  calls: [],
}

const gateway = (env: Record<string, string>) =>
  ObservabilityGateway.pipe(
    Effect.provide(
      ObservabilityGateway.layer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        Layer.provide(NodeServices.layer),
      ),
    ),
  )

describe("ObservabilityGateway.asOf", () => {
  it.effect("is the end of the recorded window in replay mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${dir}/fc-1`)
      yield* fs.writeFileString(`${dir}/fc-1/snapshot.json`, JSON.stringify(snapshot))
      const replay = yield* gateway({ OBS_REPLAY_DIR: dir })

      const asOf = yield* replay.asOf({ replayCase: "fc-1" })
      assert.strictEqual(Option.map(asOf, DateTime.formatIso).pipe(Option.getOrNull), "2026-11-12T03:06:00.000Z")
      // No snapshot for the case, or an id that is not a case id: `open` reports it, the time falls back to now.
      assert.isTrue(Option.isNone(yield* replay.asOf({ replayCase: "fc-missing" })))
      assert.isTrue(Option.isNone(yield* replay.asOf({ replayCase: "../fc-1" })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("is none for live telemetry", () =>
    Effect.gen(function* () {
      const live = yield* gateway({})
      assert.isTrue(Option.isNone(yield* live.asOf({ replayCase: "fc-1" })))
    }),
  )
})
