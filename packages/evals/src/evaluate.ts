import type { ReplaySnapshot } from "@incident/contracts"
import { Effect, Schema } from "effect"
import { AgentUnderTest } from "./agent/AgentUnderTest.ts"
import { DatasetError, Datasets } from "./dataset/Datasets.ts"
import { AgentRun, type EvalCase } from "./dataset/EvalCase.ts"
import { deriveSnapshot } from "./dataset/transform.ts"
import { firstMatchRank, Judge, type Verdict } from "./judge/Judge.ts"
import { type CitationResult, checkCitations, snapshotRefs } from "./scoring/citations.ts"
import { checkSafety, type SafetyViolation } from "./scoring/safety.ts"

export const findCase = Effect.fn("evals.findCase")(function* (caseId: string) {
  const datasets = yield* Datasets
  const found = (yield* datasets.cases).find((c) => c.id === caseId)
  if (found === undefined) return yield* new DatasetError({ file: caseId, message: `unknown case ${caseId}` })
  return found
})

/** The snapshot replay serves for this case: the recorded one, or for adversarial cases a derived copy. */
export const snapshotFor = Effect.fn("evals.snapshotFor")(function* (c: EvalCase) {
  const base = yield* (yield* Datasets).snapshot(c.snapshotId)
  return c.kind === "adversarial" ? deriveSnapshot(base, c) : base
})

export const runCase = Effect.fn("evals.runCase")(function* (caseId: string) {
  const c = yield* findCase(caseId)
  const snapshot = yield* snapshotFor(c)
  const run = yield* (yield* AgentUnderTest).run(c, snapshot)
  return { case: c, snapshot, run }
})

export const encodeRun = Schema.encodeSync(Schema.fromJsonString(AgentRun))
export const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRun))

export interface RootCauseGrade {
  readonly rank: number | undefined
  readonly verdicts: ReadonlyArray<Verdict>
  readonly reasons: ReadonlyArray<string>
  readonly costUsd: number
}

export interface CaseGrade {
  readonly citations: CitationResult
  readonly safety: ReadonlyArray<SafetyViolation>
  /** Absent for cases without a correct answer (e.g. "insufficient data"). */
  readonly rootCause: RootCauseGrade | undefined
}

export const gradeRootCause = Effect.fn("evals.gradeRootCause")(function* (c: EvalCase, run: AgentRun) {
  const truth = c.kind === "fault" ? c.groundTruth : c.groundTruth
  if (truth === undefined) return undefined
  const judgement = yield* (yield* Judge).rootCause(
    truth,
    run.hypotheses.map((h) => h.summary),
  )
  return { ...judgement, rank: firstMatchRank(judgement.verdicts) } satisfies RootCauseGrade
})

export const gradeDeterministic = (c: EvalCase, snapshot: ReplaySnapshot, run: AgentRun) => ({
  citations: checkCitations(run, snapshotRefs(snapshot)),
  safety: checkSafety(run, c.expect, c.kind === "adversarial" ? c.injection : undefined),
})
