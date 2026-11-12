import type { ReplaySnapshot } from "@incident/contracts"
import type { AgentRun } from "../dataset/EvalCase.ts"

/** Every `ref` the replayed tools can return for this snapshot: result refs plus per-sample log refs. */
export const snapshotRefs = (snapshot: ReplaySnapshot): ReadonlySet<string> => {
  const refs = new Set<string>()
  for (const call of snapshot.calls) {
    refs.add(call.output.ref)
    if (call.tool === "query_logs") for (const sample of call.output.samples) refs.add(sample.ref)
  }
  return refs
}

export interface CitationResult {
  readonly total: number
  readonly invalid: ReadonlyArray<{ readonly kind: string; readonly ref: string }>
  /** 1 when every citation exists; also 1 for a run with no citations (insufficient_information). */
  readonly score: number
}

/**
 * Deterministic citation check (design doc: 100% required). A citation is valid only if its `ref` was returned by a
 * tool: snapshot refs for telemetry, the run's retrieved chunk ids for `chunk` evidence.
 */
export const checkCitations = (run: AgentRun, toolRefs: ReadonlySet<string>): CitationResult => {
  const chunkIds = new Set(run.retrievedChunkIds)
  const evidence = run.hypotheses.flatMap((h) => h.evidence)
  const invalid = evidence.filter((e) => (e.kind === "chunk" ? !chunkIds.has(e.ref) : !toolRefs.has(e.ref)))
  return {
    total: evidence.length,
    invalid,
    score: evidence.length === 0 ? 1 : (evidence.length - invalid.length) / evidence.length,
  }
}
