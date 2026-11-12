import { InvestigationId } from "@incident/contracts"
import { Option, Schema } from "effect"

const KEY = "incident-copilot:recent-investigations"
const MAX = 10

const Recent = Schema.Array(Schema.Struct({ id: InvestigationId, alertName: Schema.String }))
export type Recent = typeof Recent.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Recent))

/**
 * Investigations this browser opened, newest first. The API has no "list investigations" endpoint yet,
 * so this is a per-viewer convenience only; storage may be unavailable and is never relied on.
 */
export const readRecent = (): Recent => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? [] : Option.getOrElse(decode(raw), () => [])
  } catch {
    return []
  }
}

export const rememberInvestigation = (id: InvestigationId, alertName: string): void => {
  try {
    const next = [{ id, alertName }, ...readRecent().filter((r) => r.id !== id)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Private mode or blocked storage: the list simply stays empty.
  }
}
