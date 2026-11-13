import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ReplaySnapshot } from "@incident/contracts"
import { DateTime, Duration, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { FaultCase } from "../src/dataset/EvalCase.ts"
import { allOff, Flagd, FlagdError, FlagdFile, setVariant } from "../src/record/Flagd.ts"
import { ObservabilityMcp } from "../src/record/ObservabilityMcp.ts"
import { opaqueId, recordBatch, recordScenario } from "../src/record/Recorder.ts"
import { findScenario, Scenarios } from "../src/record/scenarios.ts"

const flagdJson = {
  $schema: "https://flagd.dev/schema/v0/flags.json",
  flags: {
    paymentFailure: {
      description: "Fail payment service charge requests n%",
      state: "ENABLED",
      variants: { "100%": 1, "50%": 0.5, off: 0 },
      defaultVariant: "off",
    },
    adHighCpu: { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "on" },
  },
}

describe("flagd file", () => {
  const file = Schema.decodeUnknownSync(FlagdFile)(flagdJson)

  it("sets a variant after turning everything else off, keeping unknown keys", () => {
    const next = setVariant(allOff(file), "paymentFailure", "50%")
    assert(!(next instanceof FlagdError))
    const encoded = Schema.encodeSync(FlagdFile)(next)
    assert.deepStrictEqual(encoded, {
      ...flagdJson,
      flags: {
        paymentFailure: { ...flagdJson.flags.paymentFailure, defaultVariant: "50%" },
        adHighCpu: { ...flagdJson.flags.adHighCpu, defaultVariant: "off" },
      },
    })
  })

  it("rejects unknown flags and variants", () => {
    assert.instanceOf(setVariant(file, "nope", "on"), FlagdError)
    assert.instanceOf(setVariant(file, "paymentFailure", "37%"), FlagdError)
  })

  it.effect("rewrites the file on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const path = `${dir}/demo.flagd.json`
      yield* fs.writeFileString(path, JSON.stringify(flagdJson))
      yield* Effect.gen(function* () {
        const flagd = yield* Flagd
        yield* flagd.set("paymentFailure", "100%")
        const after = JSON.parse(yield* fs.readFileString(path))
        assert.strictEqual(after.flags.paymentFailure.defaultVariant, "100%")
        assert.strictEqual(after.flags.adHighCpu.defaultVariant, "off")
        assert.strictEqual(after.flags.paymentFailure.description, flagdJson.flags.paymentFailure.description)
        assert.isTrue(yield* flagd.reset)
        assert.strictEqual(JSON.parse(yield* fs.readFileString(path)).flags.paymentFailure.defaultVariant, "off")
        // Nothing left to clear.
        assert.isFalse(yield* flagd.reset)
      }).pipe(Effect.provide(Flagd.layerFile(path)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

describe("scenario catalog", () => {
  it("names are unique and every scenario has a trigger and a root cause", () => {
    assert.strictEqual(new Set(Scenarios.map((s) => s.name)).size, Scenarios.length)
    for (const s of Scenarios) {
      assert.isNotEmpty(s.trigger.promql, s.name)
      assert.isNotEmpty(s.rootCause.text, s.name)
    }
  })

  it("ids are opaque and stable", () => {
    const at = DateTime.makeUnsafe("2026-11-12T03:00:00Z")
    const id = opaqueId("fc", "paymentFailure-50", at)
    assert.match(id, /^fc-[0-9a-f]{8}$/)
    assert.strictEqual(id, opaqueId("fc", "paymentFailure-50", at))
    assert.notInclude(id, "payment")
  })
})

/** Fake live server: the trigger fires on the second poll, logs carry one trace id. */
const fakeMcp = (calls: Ref.Ref<Array<string>>) =>
  Layer.succeed(
    ObservabilityMcp,
    ObservabilityMcp.of({
      call: (tool, input) =>
        Effect.gen(function* () {
          const seen = yield* Ref.updateAndGet(calls, (all) => [...all, tool])
          const polls = seen.filter((t) => t === "query_metrics").length
          switch (tool) {
            case "query_metrics":
              return {
                ref: `m:${polls}`,
                series: [{ labels: {}, min: 0, max: 1, avg: 0.5, last: polls >= 2 ? 1 : 0, tail: [] }],
              }
            case "query_logs":
              return {
                ref: `l:${JSON.stringify(input)}`,
                totalMatched: 1,
                countsByLevel: { error: 1 },
                topMessages: [],
                samples: [
                  { ref: "s", timestamp: "t", line: "charge failed trace_id=0123456789abcdef0123456789abcdef" },
                ],
              }
            case "get_trace":
              return { ref: "t:1", rootService: "checkout", durationMs: 5, spans: [] }
            case "get_service_status":
              return { ref: "st", services: [] }
            case "get_service_topology":
              return { ref: "topo", edges: [{ from: "checkout", to: "payment", protocol: "grpc" }] }
          }
        }) as never,
    }),
  )

describe("recorder", () => {
  it.live("injects, waits for the trigger, records, clears the flag and writes a decodable case", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const flagFile = path.join(root, "demo.flagd.json")
      yield* fs.writeFileString(flagFile, JSON.stringify(flagdJson))
      yield* fs.makeDirectory(path.join(root, "datasets", "fault"), { recursive: true })
      const calls = yield* Ref.make<Array<string>>([])
      const scenario = findScenario("paymentFailure-50")
      assert(scenario !== undefined)

      const result = yield* recordScenario(scenario, {
        root,
        triggerTimeout: Duration.seconds(5),
        pollEvery: Duration.millis(1),
        afterTrigger: Duration.zero,
        lookback: Duration.minutes(15),
      }).pipe(Effect.provide(Layer.mergeAll(Flagd.layerFile(flagFile), fakeMcp(calls))))

      const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(ReplaySnapshot))(
        yield* fs.readFileString(path.join(root, "fixtures", "replay", result.id, "snapshot.json")),
      )
      assert.strictEqual(snapshot.caseId, result.id)
      assert.strictEqual(snapshot.alert.labels.service, "checkout")
      assert.isTrue(snapshot.calls.some((c) => c.tool === "get_trace"))
      assert.isTrue(snapshot.calls.some((c) => c.tool === "query_logs" && c.input.service === "payment"))

      const faultCase = Schema.decodeUnknownSync(Schema.fromJsonString(FaultCase))(
        yield* fs.readFileString(path.join(root, "datasets", "fault", `${result.id}.json`)),
      )
      assert.strictEqual(faultCase.groundTruth.service, "payment")
      assert.isFalse(faultCase.synthetic)
      // The snapshot the agent sees must not carry the answer.
      assert.notInclude(JSON.stringify(Schema.encodeSync(ReplaySnapshot)(snapshot)), "paymentFailure")

      const flags = JSON.parse(yield* fs.readFileString(flagFile))
      assert.strictEqual(flags.flags.paymentFailure.defaultVariant, "off")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("clears the flag when the trigger never fires", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const flagFile = `${root}/demo.flagd.json`
      yield* fs.writeFileString(flagFile, JSON.stringify(flagdJson))
      const never = Layer.succeed(
        ObservabilityMcp,
        ObservabilityMcp.of({ call: () => Effect.succeed({ ref: "m", series: [] }) as never }),
      )
      const scenario = findScenario("paymentFailure-50")
      assert(scenario !== undefined)
      const error = yield* Effect.flip(
        recordScenario(scenario, {
          root,
          triggerTimeout: Duration.millis(30),
          pollEvery: Duration.millis(5),
          afterTrigger: Duration.zero,
          lookback: Duration.minutes(15),
        }).pipe(Effect.provide(Layer.mergeAll(Flagd.layerFile(flagFile), never))),
      )
      assert.strictEqual(error._tag, "TriggerTimeout")
      assert.include(error.message, "baseline no data, highest seen no data")
      assert.strictEqual(JSON.parse(yield* fs.readFileString(flagFile)).flags.paymentFailure.defaultVariant, "off")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("measures the trigger against the baseline from before the fault, not against zero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const flagFile = `${root}/demo.flagd.json`
      yield* fs.writeFileString(flagFile, JSON.stringify(flagdJson))
      // A service that already has errors: the same level after the fault is not a trigger.
      const steady = Layer.succeed(
        ObservabilityMcp,
        ObservabilityMcp.of({
          call: () =>
            Effect.succeed({
              ref: "m",
              series: [{ labels: {}, min: 0.5, max: 0.5, avg: 0.5, last: 0.5, tail: [] }],
            }) as never,
        }),
      )
      const scenario = findScenario("paymentFailure-50")
      assert(scenario !== undefined)
      const error = yield* Effect.flip(
        recordScenario(scenario, {
          root,
          triggerTimeout: Duration.millis(30),
          pollEvery: Duration.millis(5),
          afterTrigger: Duration.zero,
          lookback: Duration.minutes(15),
        }).pipe(Effect.provide(Layer.mergeAll(Flagd.layerFile(flagFile), steady))),
      )
      assert.strictEqual(error._tag, "TriggerTimeout")
      assert.include(error.message, "baseline 0.5, highest seen 0.5")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it("queries the metric names Prometheus stores, over a window that holds several samples", () => {
    for (const s of Scenarios) {
      assert.notMatch(s.trigger.promql, /calls_total|duration_milliseconds/, s.name)
      assert.notMatch(s.trigger.promql, /\[1m\]/, s.name)
    }
  })

  /** Fake live server driven by the flag file: checkout errors appear only while paymentFailure is at 50%. */
  const flagDrivenMcp = (flagFile: string, seen: Ref.Ref<Array<string>>) =>
    Layer.effect(
      ObservabilityMcp,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return ObservabilityMcp.of({
          call: (tool) =>
            Effect.gen(function* () {
              const flags = JSON.parse(yield* Effect.orDie(fs.readFileString(flagFile))).flags
              const on = Object.entries(flags as Record<string, { defaultVariant: string }>)
                .filter(([, f]) => f.defaultVariant !== "off")
                .map(([name, f]) => `${name}=${f.defaultVariant}`)
              yield* Ref.update(seen, (all) => [...all, `${tool}:${on.join(",")}`])
              switch (tool) {
                case "query_metrics":
                  return {
                    ref: "m",
                    series: [
                      { labels: {}, min: 0, max: 1, avg: 0, last: on.includes("paymentFailure=50%") ? 1 : 0, tail: [] },
                    ],
                  }
                case "query_logs":
                  return { ref: "l", totalMatched: 0, countsByLevel: {}, topMessages: [], samples: [] }
                case "get_service_status":
                  return { ref: "st", services: [] }
                default:
                  return { ref: "topo", edges: [] }
              }
            }) as never,
        })
      }),
    )

  const batchOptions = (root: string) => ({
    root,
    triggerTimeout: Duration.millis(40),
    pollEvery: Duration.millis(5),
    afterTrigger: Duration.zero,
    lookback: Duration.minutes(15),
    cooldown: Duration.millis(10),
  })

  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
    const flagFile = `${root}/demo.flagd.json`
    // adHighCpu is still on in this file: a fault left over from an earlier run.
    yield* fs.writeFileString(flagFile, JSON.stringify(flagdJson))
    yield* fs.makeDirectory(`${root}/datasets/fault`, { recursive: true })
    const seen = yield* Ref.make<Array<string>>([])
    const layer = Layer.mergeAll(Flagd.layerFile(flagFile), flagDrivenMcp(flagFile, seen))
    return { root, flagFile, seen, layer }
  })

  const scenarios = (...names: ReadonlyArray<string>) =>
    names.map((name) => {
      const scenario = findScenario(name)
      assert(scenario !== undefined, name)
      return scenario
    })

  it.live("goes on after a scenario that never triggers, and clears a leftover fault before the first baseline", () =>
    Effect.gen(function* () {
      const { root, flagFile, seen, layer } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const result = yield* recordBatch(scenarios("paymentFailure-100", "paymentFailure-50"), batchOptions(root)).pipe(
        Effect.provide(layer),
      )
      assert.deepStrictEqual(result.failed, ["paymentFailure-100"])
      assert.deepStrictEqual(
        result.recorded.map((r) => r.scenario),
        ["paymentFailure-50"],
      )
      // The first baseline query runs with every fault off, not with the leftover adHighCpu.
      assert.strictEqual((yield* Ref.get(seen))[0], "query_metrics:")
      assert.strictEqual(JSON.parse(yield* fs.readFileString(flagFile)).flags.paymentFailure.defaultVariant, "off")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("stops the batch on an error other than a trigger timeout", () =>
    Effect.gen(function* () {
      const { root, seen, layer } = yield* setup
      // cartFailure is not in this flag file, so injecting it fails.
      const error = yield* Effect.flip(
        recordBatch(scenarios("cartFailure-50", "paymentFailure-50"), batchOptions(root)).pipe(Effect.provide(layer)),
      )
      assert.strictEqual(error._tag, "FlagdError")
      assert.isFalse((yield* Ref.get(seen)).some((call) => call.includes("paymentFailure=50%")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
