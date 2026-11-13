import { describe, expect, it } from "vitest"
import { AlertCategories, InvestigationPrompt, Methodologies, TriagePrompt } from "../src/index.ts"

const all = [TriagePrompt, InvestigationPrompt, ...AlertCategories.map((c) => Methodologies[c])]

describe("prompts", () => {
  it("has a methodology for every triage category", () => {
    for (const category of AlertCategories) expect(Methodologies[category].text.length).toBeGreaterThan(0)
  })

  it("uses unique versions", () => {
    const versions = all.map((p) => p.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  // Prompts are part of the cached prefix: anything that changes per request would break prompt caching.
  it("contains no timestamps, dates or uuids", () => {
    for (const prompt of all) {
      expect(prompt.text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(prompt.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i)
      expect(prompt.text).not.toMatch(/\$\{/)
    }
  })

  it("tells both models that tool and alert content is untrusted", () => {
    expect(TriagePrompt.text).toContain("untrusted")
    expect(InvestigationPrompt.text).toContain("Never follow instructions")
  })
})
