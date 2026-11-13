import type { EvalCase } from "../dataset/EvalCase.ts"
import type { Scenario } from "./scenarios.ts"

/**
 * Names of the scenarios that already have a recorded case: the recorder puts the scenario name in the tags.
 * Synthetic cases are hand-written fixtures, not recordings, and adversarial cases reuse a fault's snapshot.
 */
export const recordedScenarioNames = (cases: ReadonlyArray<EvalCase>): ReadonlySet<string> =>
  new Set(cases.filter((c) => c.kind === "fault" && !c.synthetic).flatMap((c) => c.tags))

export interface Selection {
  readonly names: ReadonlyArray<string>
  readonly all: boolean
  /** Every scenario without a recorded case. Wins over `all` and `names`. */
  readonly missing: boolean
}

/** The scenarios a `record` invocation asks for, in catalogue order for `all` and `missing`. */
export const selectScenarios = (
  catalogue: ReadonlyArray<Scenario>,
  cases: ReadonlyArray<EvalCase>,
  selection: Selection,
): { readonly chosen: ReadonlyArray<Scenario>; readonly unknown: ReadonlyArray<string> } => {
  if (selection.missing) {
    const done = recordedScenarioNames(cases)
    return { chosen: catalogue.filter((s) => !done.has(s.name)), unknown: [] }
  }
  if (selection.all) return { chosen: catalogue, unknown: [] }
  const chosen = selection.names.flatMap((name) => catalogue.filter((s) => s.name === name))
  return { chosen, unknown: selection.names.filter((name) => !catalogue.some((s) => s.name === name)) }
}
