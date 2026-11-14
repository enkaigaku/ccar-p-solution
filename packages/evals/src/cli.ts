import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, DateTime, Duration, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { BudgetGuard, BudgetPolicy } from "./budget/Budget.ts"
import { Datasets, packageRoot } from "./dataset/Datasets.ts"
import { calibrate } from "./judge/calibration.ts"
import { Judge } from "./judge/Judge.ts"
import { Flagd } from "./record/Flagd.ts"
import { ObservabilityMcp } from "./record/ObservabilityMcp.ts"
import { faultsOf, recordBatch } from "./record/Recorder.ts"
import { Scenarios } from "./record/scenarios.ts"
import { recordedScenarioNames, selectScenarios } from "./record/selection.ts"

const repoRoot = new URL("../../../", import.meta.url).pathname

const budget = Command.make(
  "budget",
  {},
  Effect.fn(function* () {
    const month = yield* (yield* BudgetGuard).month
    yield* Console.log(
      `spent $${month.spentUsd.toFixed(2)} of $${BudgetPolicy.monthlyUsd}; ` +
        `smoke runs ${month.runs.smoke}/${BudgetPolicy.maxRuns.smoke}, full runs ${month.runs.full}/${BudgetPolicy.maxRuns.full}`,
    )
  }),
).pipe(Command.withDescription("Show this month's evaluation spend"), Command.provide(BudgetGuard.layer))

const scenarios = Command.make(
  "scenarios",
  {},
  Effect.fn(function* () {
    const done = recordedScenarioNames(yield* (yield* Datasets).cases)
    for (const s of Scenarios) {
      const flags = faultsOf(s)
        .map((f) => `${f.flag}=${f.variant}`)
        .join(" + ")
      yield* Console.log(`${done.has(s.name) ? "✓" : " "} ${s.name.padEnd(48)} ${flags} → ${s.rootCause.service}`)
    }
    yield* Console.log(`${Scenarios.filter((s) => done.has(s.name)).length} of ${Scenarios.length} recorded (✓)`)
  }),
).pipe(
  Command.withDescription("List the fault scenarios the recorder knows and which ones have a recorded case"),
  Command.provide(Datasets.layerAt(packageRoot)),
)

const record = Command.make(
  "record",
  {
    names: Argument.String("scenario").pipe(
      Argument.variadic(),
      Argument.withDescription("Scenario names, see `scenarios`"),
    ),
    all: Flag.Boolean("all").pipe(Flag.withDescription("Record every scenario"), Flag.withDefault(false)),
    missing: Flag.Boolean("missing").pipe(
      Flag.withDescription("Record every scenario that has no recorded case yet (resumes an interrupted --all)"),
      Flag.withDefault(false),
    ),
    flagdFile: Flag.String("flagd-file").pipe(
      Flag.withDescription("The OTel Demo flag file that flagd watches"),
      Flag.withDefault(`${repoRoot}infra/.otel-demo/src/flagd/demo.flagd.json`),
    ),
    mcp: Flag.String("mcp").pipe(
      Flag.withDescription("Command that starts mcp-observability over stdio (live mode, REPLAY_DIR unset)"),
      Flag.withDefault(`node ${repoRoot}packages/mcp-observability/src/main.ts`),
    ),
    flagdUrl: Flag.String("flagd-url").pipe(
      Flag.withDescription(
        "flagd's evaluation API, e.g. http://localhost:$(docker port flagd 8013/tcp | cut -d: -f2). " +
          "When given, every injection is checked against what flagd serves",
      ),
      Flag.optional,
    ),
    cooldownMinutes: Flag.Int("cooldown-minutes").pipe(
      Flag.withDescription("Wait between scenarios so the previous fault drains out of the window"),
      Flag.withDefault(10),
    ),
  },
  Effect.fn(function* ({ names, all, missing, flagdFile, flagdUrl, mcp, cooldownMinutes }) {
    const cases = missing ? yield* (yield* Datasets).cases : []
    const { chosen, unknown } = selectScenarios(Scenarios, cases, { names, all, missing })
    if (unknown.length > 0) return yield* Console.error(`unknown scenarios: ${unknown.join(", ")}`)
    if (chosen.length === 0) {
      return yield* missing
        ? Console.log("every scenario has a recorded case")
        : Console.error("name at least one scenario, or pass --all or --missing")
    }
    // Per scenario: the cooldown, up to 10 minutes for the trigger, 2 minutes with the fault on.
    yield* Console.log(
      `${chosen.length} scenarios, at most ${(((cooldownMinutes + 12) * chosen.length) / 60).toFixed(1)} hours`,
    )

    const [command = "node", ...args] = mcp.split(" ").filter((part) => part !== "")
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== "REPLAY_DIR"),
    )
    if (Option.isNone(flagdUrl)) {
      yield* Console.error(
        "no --flagd-url: injections are not checked against flagd, a dead file watcher goes unnoticed",
      )
    }
    const flagd = Option.isSome(flagdUrl)
      ? Flagd.layerVerified(flagdFile, flagdUrl.value).pipe(Layer.provide(NodeHttpClient.layerUndici))
      : Flagd.layerFile(flagdFile)
    const layer = Layer.mergeAll(flagd, ObservabilityMcp.layerStdio(command, args, env))

    const { recorded, failed } = yield* recordBatch(chosen, {
      root: packageRoot,
      triggerTimeout: Duration.minutes(10),
      pollEvery: Duration.seconds(15),
      afterTrigger: Duration.minutes(2),
      lookback: Duration.minutes(15),
      cooldown: Duration.minutes(cooldownMinutes),
    }).pipe(Effect.provide(layer))
    for (const r of recorded) yield* Console.log(`${r.scenario} → ${r.id} (${r.calls} calls)`)
    if (failed.length > 0) {
      yield* Console.error(`not recorded: ${failed.join(", ")}`)
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }
  }),
).pipe(
  Command.withDescription("Inject faults into the local OTel Demo and record replay snapshots"),
  Command.provide(Datasets.layerAt(packageRoot)),
)

const calibrateCommand = Command.make(
  "calibrate",
  { yes: Flag.Boolean("yes").pipe(Flag.withDescription("Confirm the Claude API spend"), Flag.withDefault(false)) },
  Effect.fn(function* ({ yes }) {
    const samples = yield* (yield* Datasets).calibration
    const estimate = samples.length * BudgetPolicy.perCaseUsd.judge
    if (!yes) return yield* Console.log(`${samples.length} samples, about $${estimate.toFixed(2)}; rerun with --yes`)
    const guard = yield* BudgetGuard
    // Unique per execution, shared by this run's reserve and settle.
    const label = `calibrate:${DateTime.formatIso(yield* DateTime.now)}:${samples.length}`
    yield* guard.reserve("smoke", estimate, label)
    const report = yield* calibrate(samples).pipe(Effect.provide(Judge.layerClaude))
    yield* guard.settle(label, report.costUsd)
    yield* Console.log(
      `agreement ${(report.agreement * 100).toFixed(1)}% on ${report.samples} samples ` +
        `(${report.trusted ? "trusted" : "NOT trusted"}), cost $${report.costUsd.toFixed(2)}`,
    )
    for (const d of report.disagreements) yield* Console.log(`  ${d.id}: human=${d.human} judge=${d.judge}`)
  }),
).pipe(
  Command.withDescription("Measure judge agreement with human scores (calls Claude)"),
  Command.provide(Layer.mergeAll(BudgetGuard.layer, Datasets.layerAt(packageRoot))),
)

Command.make("evals").pipe(
  Command.withSubcommands([budget, scenarios, record, calibrateCommand]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
