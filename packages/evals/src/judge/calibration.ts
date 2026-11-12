import { Effect } from "effect"
import type { CalibrationSample } from "../dataset/EvalCase.ts"
import { Judge, type Verdict } from "./Judge.ts"

/** Design doc: judge scores count only when agreement with human scores is at least 90% on 30 samples. */
export const MinAgreement = 0.9
export const MinSamples = 30

export interface CalibrationReport {
  readonly samples: number
  readonly agreement: number
  readonly disagreements: ReadonlyArray<{ readonly id: string; readonly human: Verdict; readonly judge: Verdict }>
  readonly costUsd: number
  readonly trusted: boolean
}

export const agreementOf = (pairs: ReadonlyArray<{ readonly human: Verdict; readonly judge: Verdict }>) =>
  pairs.length === 0 ? 0 : pairs.filter((p) => p.human === p.judge).length / pairs.length

export const calibrate = Effect.fn("evals.calibrate")(function* (samples: ReadonlyArray<CalibrationSample>) {
  const judge = yield* Judge
  const graded = yield* Effect.forEach(
    samples,
    (s) =>
      judge
        .rootCause(s.groundTruth, [s.hypothesis])
        .pipe(
          Effect.map((j) => ({ id: s.id, human: s.humanVerdict, judge: j.verdicts[0] ?? "miss", costUsd: j.costUsd })),
        ),
    { concurrency: 4 },
  )
  const agreement = agreementOf(graded)
  return {
    samples: graded.length,
    agreement,
    disagreements: graded.filter((g) => g.human !== g.judge).map(({ id, human, judge }) => ({ id, human, judge })),
    costUsd: graded.reduce((sum, g) => sum + g.costUsd, 0),
    trusted: graded.length >= MinSamples && agreement >= MinAgreement,
  } satisfies CalibrationReport
})
