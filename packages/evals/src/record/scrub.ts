import type { RecordedToolCall } from "@incident/contracts"
import { Scenarios } from "./scenarios.ts"

/**
 * The OTel Demo logs its own fault injection: "Feature Flag adManualGc enabled, performing a manual gc now",
 * "Delaying international shipment due to intlShippingSlowdown feature flag". Those lines name the flag, which is the
 * labelled answer, and no real incident has them. They are removed from recorded log results; lines that describe
 * what the service does without naming a flag ("Triggering a manual garbage collection") stay, they are evidence.
 */
const FlagNames = [...new Set(Scenarios.flatMap((s) => [s.flag, ...s.distractors.map((d) => d.flag)]))].map((flag) =>
  flag.toLowerCase(),
)
const GenericMarkers = ["feature flag", "featureflag", "feature_flag"]

/** True for log text that names a fault-injection flag or says a feature flag is at work. */
export const isInjectionMarker = (text: string): boolean => {
  const lower = text.toLowerCase()
  return GenericMarkers.some((marker) => lower.includes(marker)) || FlagNames.some((flag) => lower.includes(flag))
}

/**
 * Removes injection markers from a `query_logs` result and takes the removed messages out of the counts, so the
 * result reads as if the service had never logged them. Other tools' results are returned unchanged. Idempotent.
 */
export const scrubCall = (call: RecordedToolCall): RecordedToolCall => {
  if (call.tool !== "query_logs") return call
  const removed = call.output.topMessages.filter((m) => isInjectionMarker(m.pattern))
  const samples = call.output.samples.filter((s) => !isInjectionMarker(s.line))
  if (removed.length === 0 && samples.length === call.output.samples.length) return call
  const removedCount = removed.reduce((sum, m) => sum + m.count, 0)
  // The removed messages' levels are not recorded; with a single level in the result they can only be that one.
  const levels = Object.entries(call.output.countsByLevel)
  const countsByLevel =
    levels.length === 1
      ? Object.fromEntries(levels.map(([level, count]) => [level, Math.max(0, count - removedCount)]))
      : call.output.countsByLevel
  return {
    ...call,
    output: {
      ...call.output,
      totalMatched: Math.max(0, call.output.totalMatched - removedCount),
      countsByLevel,
      topMessages: call.output.topMessages.filter((m) => !isInjectionMarker(m.pattern)),
      samples,
    },
  }
}

export const scrubCalls = (calls: ReadonlyArray<RecordedToolCall>): Array<RecordedToolCall> => calls.map(scrubCall)
