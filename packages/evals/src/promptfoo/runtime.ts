import { NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, ManagedRuntime } from "effect"
import { AgentUnderTest } from "../agent/AgentUnderTest.ts"
import { BudgetGuard } from "../budget/Budget.ts"
import { Datasets, packageRoot } from "../dataset/Datasets.ts"
import { Judge } from "../judge/Judge.ts"

/**
 * Which agent and judge a promptfoo run uses. Both default to the free implementations, so a bare
 * `promptfoo eval` never spends money; `EVAL_AGENT=api` / `EVAL_JUDGE=claude` opt in to real calls.
 */
export const EvalSettings = Config.all({
  agent: Config.Literals(["stub", "api"], "EVAL_AGENT").pipe(Config.withDefault("stub" as const)),
  judge: Config.Literals(["keyword", "claude"], "EVAL_JUDGE").pipe(Config.withDefault("keyword" as const)),
})

const AppLayer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* EvalSettings
    return Layer.mergeAll(
      settings.agent === "api" ? AgentUnderTest.layerApi : AgentUnderTest.layerStub,
      settings.judge === "claude" ? Judge.layerClaude : Judge.layerKeyword,
      Datasets.layerAt(packageRoot),
      BudgetGuard.layer,
    )
  }),
).pipe(Layer.provideMerge(NodeServices.layer))

/** One runtime per promptfoo process, shared by the provider, assertions and hooks. */
export const runtime = ManagedRuntime.make(AppLayer)
