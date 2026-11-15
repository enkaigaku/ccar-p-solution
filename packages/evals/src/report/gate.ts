import { Schema } from "effect"

/**
 * The part of a promptfoo `--output` file the gate reads: per case, whether the provider call failed and the
 * named scores the assertions reported.
 */
export const GateResults = Schema.Struct({
  results: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        vars: Schema.Struct({ caseId: Schema.String }),
        error: Schema.optionalKey(Schema.NullOr(Schema.String)),
        response: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ output: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
        ),
        namedScores: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
      }),
    ),
  }),
})
export type GateResults = typeof GateResults.Type

export const decodeGateResults = Schema.decodeUnknownEffect(Schema.fromJsonString(GateResults))

export class GateFailed extends Schema.TaggedError<GateFailed>()("GateFailed", {
  message: Schema.String,
}) {}

export interface GateOptions {
  /** Fewer cases than this means the run selected the wrong set, or none at all. */
  readonly minCases: number
  /** Share of cases whose root cause must be in the top 3. Leave out for stub runs: the stub is a heuristic. */
  readonly minTop3?: number | undefined
  /**
   * Ids of the cases that carry no labelled root cause (some adversarial cases). The judge does not grade them,
   * so they report no root-cause score and stay out of the accuracy denominator.
   */
  readonly unlabelled?: ReadonlySet<string> | undefined
  /**
   * Ids of the cases curated from online feedback (ADR 011). They must run and pass the hard rules like any case,
   * but their root-cause score is reported on its own line and never gated or mixed into the baseline accuracy.
   */
  readonly feedback?: ReadonlySet<string> | undefined
}

export interface GateReport {
  readonly pass: boolean
  readonly lines: ReadonlyArray<string>
}

/** Metrics that are deterministic rules with a 100% target (design doc "评估体系"), whoever the agent is. */
const HardMetrics = ["citation_validity", "safety"] as const

const share = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`)

/**
 * Decides whether a finished evaluation may pass CI. Always required: every case produced an output, and every
 * case passes the citation and safety rules, and every case with a labelled root cause was graded. Root-cause
 * accuracy is computed over the labelled cases, and gated only when `minTop3` is given, so a free stub run still
 * checks datasets, snapshots, scoring and the promptfoo wiring end to end.
 */
export const gate = (results: GateResults, options: GateOptions): GateReport => {
  const rows = results.results.results
  const failures: Array<string> = []

  if (rows.length < options.minCases) {
    failures.push(`${rows.length} cases ran, expected at least ${options.minCases}`)
  }
  const broken = rows.filter((r) => typeof r.response?.output !== "string")
  for (const r of broken) failures.push(`${r.vars.caseId}: no output (${r.error ?? "provider returned nothing"})`)

  const lines: Array<string> = [`${rows.length} cases, ${broken.length} without output`]
  for (const metric of HardMetrics) {
    const failed = rows.filter((r) => r.namedScores?.[metric] !== 1)
    lines.push(`${metric}: ${rows.length - failed.length}/${rows.length}`)
    // A missing score is a failure too: an assertion that did not run must not read as a pass.
    for (const r of failed) failures.push(`${r.vars.caseId}: ${metric} ${r.namedScores?.[metric] ?? "missing"}`)
  }

  const graded = rows.filter((r) => !(options.unlabelled?.has(r.vars.caseId) ?? false))
  const labelled = graded.filter((r) => !(options.feedback?.has(r.vars.caseId) ?? false))
  const fromFeedback = graded.filter((r) => options.feedback?.has(r.vars.caseId) ?? false)
  for (const r of graded) {
    if (r.namedScores?.root_cause_top3 === undefined) failures.push(`${r.vars.caseId}: root_cause_top3 missing`)
  }
  const top3 = labelled.filter((r) => r.namedScores?.root_cause_top3 === 1).length
  const required = options.minTop3 === undefined ? "not gated" : `required ${share(options.minTop3, 1)}`
  lines.push(`root_cause top-3: ${top3}/${labelled.length} labelled (${share(top3, labelled.length)}), ${required}`)
  if (fromFeedback.length > 0) {
    const hits = fromFeedback.filter((r) => r.namedScores?.root_cause_top3 === 1).length
    lines.push(
      `feedback root_cause top-3: ${hits}/${fromFeedback.length} (${share(hits, fromFeedback.length)}), not gated`,
    )
  }
  if (options.minTop3 !== undefined && (labelled.length === 0 || top3 / labelled.length < options.minTop3)) {
    failures.push(`root_cause top-3 ${share(top3, labelled.length)} is below ${share(options.minTop3, 1)}`)
  }

  return {
    pass: failures.length === 0,
    lines: [...lines, ...failures.map((f) => `  fail ${f}`), failures.length === 0 ? "gate: pass" : "gate: block"],
  }
}
