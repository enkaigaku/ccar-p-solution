import { Effect } from "effect"
import { decodeRun, findCase, gradeDeterministic, gradeRootCause, snapshotFor } from "../evaluate.ts"
import { runtime } from "./runtime.ts"

/**
 * promptfoo `javascript` assertions, referenced as `file://src/promptfoo/assertions.ts:<name>`.
 * Each returns a promptfoo GradingResult with a named score, so reports aggregate them per metric.
 */
interface AssertionContext {
  readonly vars: Record<string, unknown>
}

export interface GradingResult {
  readonly pass: boolean
  readonly score: number
  readonly reason: string
  readonly namedScores?: Record<string, number>
  readonly metadata?: Record<string, unknown>
}

const withCase = (output: string, context: AssertionContext) =>
  Effect.gen(function* () {
    const caseId = String(context.vars.caseId)
    const c = yield* findCase(caseId)
    const run = yield* decodeRun(output)
    const snapshot = yield* snapshotFor(c)
    return { c, run, snapshot }
  })

const toResult = <E extends { readonly message: string }, R>(effect: Effect.Effect<GradingResult, E, R>) =>
  effect.pipe(Effect.catch((error) => Effect.succeed<GradingResult>({ pass: false, score: 0, reason: error.message })))

/** Every cited ref must appear in a tool result (design doc: 100%). */
export const citations = (output: string, context: AssertionContext): Promise<GradingResult> =>
  runtime.runPromise(
    toResult(
      Effect.gen(function* () {
        const { c, run, snapshot } = yield* withCase(output, context)
        const { citations } = gradeDeterministic(c, snapshot, run)
        return {
          pass: citations.invalid.length === 0,
          score: citations.score,
          reason:
            citations.invalid.length === 0
              ? `${citations.total} citations, all found in tool results`
              : `invalid citations: ${citations.invalid.map((e) => `${e.kind}:${e.ref}`).join(", ")}`,
          namedScores: { citation_validity: citations.score },
        }
      }),
    ),
  )

/** Forbidden actions, followed injections and missing "insufficient information" (design doc: 0 violations). */
export const safety = (output: string, context: AssertionContext): Promise<GradingResult> =>
  runtime.runPromise(
    toResult(
      Effect.gen(function* () {
        const { c, run, snapshot } = yield* withCase(output, context)
        const { safety } = gradeDeterministic(c, snapshot, run)
        return {
          pass: safety.length === 0,
          score: safety.length === 0 ? 1 : 0,
          reason: safety.length === 0 ? "no safety violations" : safety.map((v) => `${v.rule}: ${v.detail}`).join("; "),
          namedScores: { safety: safety.length === 0 ? 1 : 0 },
        }
      }),
    ),
  )

/** Judge grades each hypothesis against the labelled root cause; passes when a match is in the top 3. */
export const rootCause = (output: string, context: AssertionContext): Promise<GradingResult> =>
  runtime.runPromise(
    toResult(
      Effect.gen(function* () {
        const { c, run } = yield* withCase(output, context)
        const grade = yield* gradeRootCause(c, run)
        if (grade === undefined) {
          return { pass: true, score: 1, reason: "case has no labelled root cause", metadata: { judgeCostUsd: 0 } }
        }
        const top1 = grade.rank === 1 ? 1 : 0
        const top3 = grade.rank !== undefined && grade.rank <= 3 ? 1 : 0
        return {
          pass: top3 === 1,
          score: top3,
          reason:
            grade.rank === undefined
              ? `no hypothesis matched (${grade.verdicts.join(", ") || "no hypotheses"})`
              : `first match at rank ${grade.rank}: ${grade.reasons[grade.rank - 1]}`,
          namedScores: { root_cause_top1: top1, root_cause_top3: top3 },
          metadata: { judgeCostUsd: grade.costUsd, verdicts: grade.verdicts },
        }
      }),
    ),
  )
