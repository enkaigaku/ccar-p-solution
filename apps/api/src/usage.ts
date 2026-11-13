import { InvestigationUsage } from "@incident/contracts"
import { tokenBreakdown, type UsageLike } from "@incident/telemetry"
import { Option } from "effect"

export const emptyUsage = new InvestigationUsage({ costUsd: 0, inputTokens: 0, outputTokens: 0 })

/** Adds one response to a running total. Input counts cached tokens too, as on the GenAI span. */
export const addUsage = (total: InvestigationUsage, usage: UsageLike, cost: Option.Option<number>) => {
  const t = tokenBreakdown(usage)
  return new InvestigationUsage({
    costUsd: total.costUsd + Option.getOrElse(cost, () => 0),
    inputTokens: total.inputTokens + t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h,
    outputTokens: total.outputTokens + t.output,
  })
}

export const sumUsage = (a: InvestigationUsage, b: InvestigationUsage) =>
  new InvestigationUsage({
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  })
