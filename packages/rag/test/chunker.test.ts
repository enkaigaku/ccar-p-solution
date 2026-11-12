import { assert, describe, it } from "@effect/vitest"
import { SourceDocument } from "@incident/contracts"
import { Effect } from "effect"
import { chunkDocument, defaultChunkParams, estimateTokens, slugify, windowText } from "../src/index.ts"

const runbook = (markdown: string, sourceId = "runbooks/checkout.md") =>
  new SourceDocument({ sourceId, corpus: "runbook", markdown })

describe("chunkDocument", () => {
  it.effect("splits runbooks at H2/H3 and keeps the heading path", () =>
    Effect.gen(function* () {
      const chunks = yield* chunkDocument(
        runbook(`---
service: checkout
alerts: HighErrorRate, HighLatency
---
# checkout

Intro text.

## High error rate

### Diagnosis

Check payment first.

### Mitigation

Revert the flag.
`),
      )
      assert.deepStrictEqual(
        chunks.map((c) => c.id),
        [
          "runbooks/checkout.md#_intro",
          "runbooks/checkout.md#high-error-rate/diagnosis",
          "runbooks/checkout.md#high-error-rate/mitigation",
        ],
      )
      const diagnosis = chunks[1]
      assert.deepStrictEqual(diagnosis?.headingPath, ["checkout", "High error rate", "Diagnosis"])
      assert.strictEqual(diagnosis?.service, "checkout")
      assert.deepStrictEqual(diagnosis?.alerts, ["HighErrorRate", "HighLatency"])
      assert.strictEqual(diagnosis?.text, "Check payment first.")
      assert.include(diagnosis?.embedInput ?? "", "checkout > High error rate > Diagnosis")
      assert.include(diagnosis?.embedInput ?? "", "Alerts: HighErrorRate, HighLatency")
    }),
  )

  it.effect("ignores headings inside fenced code blocks", () =>
    Effect.gen(function* () {
      const chunks = yield* chunkDocument(
        runbook(`# cart

## Restart

\`\`\`bash
# this is a shell comment, not a heading

kubectl rollout restart deploy/cart
\`\`\`
`),
      )
      assert.strictEqual(chunks.length, 1)
      assert.include(chunks[0]?.text ?? "", "# this is a shell comment")
      assert.include(chunks[0]?.text ?? "", "kubectl rollout restart")
    }),
  )

  it.effect("postmortems split at H2 only and keep H3 detail in the section", () =>
    Effect.gen(function* () {
      const chunks = yield* chunkDocument(
        new SourceDocument({
          sourceId: "postmortems/x.md",
          corpus: "postmortem",
          service: "payment",
          markdown: "# Incident\n\n## Root cause\n\nA flag.\n\n### Timeline\n\n14:04 flag changed.\n",
        }),
      )
      assert.deepStrictEqual(
        chunks.map((c) => c.id),
        ["postmortems/x.md#root-cause"],
      )
      assert.include(chunks[0]?.text ?? "", "### Timeline")
      assert.strictEqual(chunks[0]?.service, "payment")
    }),
  )

  it.effect("uses the file name as title when there is no H1, and disambiguates repeated headings", () =>
    Effect.gen(function* () {
      const chunks = yield* chunkDocument(runbook("## Notes\n\nOne.\n\n## Notes\n\nTwo.\n", "runbooks/misc.md"))
      assert.deepStrictEqual(
        chunks.map((c) => [c.id, c.headingPath]),
        [
          ["runbooks/misc.md#notes", ["misc", "Notes"]],
          ["runbooks/misc.md#notes~2", ["misc", "Notes"]],
        ],
      )
    }),
  )

  it.effect("content hash changes with text and stays stable otherwise", () =>
    Effect.gen(function* () {
      const [a] = yield* chunkDocument(runbook("# s\n\n## A\n\nsame"))
      const [b] = yield* chunkDocument(runbook("# s\n\n## A\n\nsame"))
      const [c] = yield* chunkDocument(runbook("# s\n\n## A\n\nchanged"))
      assert.strictEqual(a?.contentHash, b?.contentHash)
      assert.notStrictEqual(a?.contentHash, c?.contentHash)
      assert.strictEqual(a?.id, c?.id)
    }),
  )

  it.effect("rejects invalid front matter with a ChunkingError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(chunkDocument(runbook("---\nservice: \n---\n# x\n\nbody")))
      assert.strictEqual(error._tag, "ChunkingError")
      assert.strictEqual(error.sourceId, "runbooks/checkout.md")
    }),
  )

  it.effect("an empty document yields no chunks", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* chunkDocument(runbook(""))).length, 0)
    }),
  )
})

describe("windowText", () => {
  const params = { ...defaultChunkParams.runbook, maxTokens: 50, overlapTokens: 15 }

  it("keeps short sections whole", () => {
    assert.deepStrictEqual(windowText("one\n\ntwo", params), ["one\n\ntwo"])
  })

  it("splits long sections within the budget and overlaps the previous window", () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${"word ".repeat(8)}`.trim())
    const windows = windowText(paragraphs.join("\n\n"), params)
    assert.isAbove(windows.length, 1)
    for (const w of windows) assert.isAtMost(estimateTokens(w), params.maxTokens)
    for (let i = 1; i < windows.length; i++) {
      const previousLast = windows[i - 1]?.split("\n\n").pop() ?? ""
      assert.isTrue(windows[i]?.startsWith(previousLast), `window ${i} should start with the previous tail`)
    }
    // Every paragraph appears somewhere.
    for (const p of paragraphs) assert.isTrue(windows.some((w) => w.includes(p)))
  })

  it("never splits inside a fenced code block that fits the budget", () => {
    const code = "```\nline a\n\nline b\n```"
    const windows = windowText(`${"intro ".repeat(30)}\n\n${code}`, params)
    assert.isTrue(windows.some((w) => w.includes(code)))
  })

  it("hard-splits a single oversized paragraph", () => {
    const windows = windowText("x".repeat(1000), params)
    assert.isAbove(windows.length, 1)
    for (const w of windows) assert.isAtMost(estimateTokens(w), params.maxTokens)
  })
})

describe("helpers", () => {
  it("estimates CJK at one token per character", () => {
    assert.strictEqual(estimateTokens("根因分析"), 4)
    assert.strictEqual(estimateTokens("abcd"), 1)
  })

  it("slugifies headings, keeping non-Latin letters", () => {
    assert.strictEqual(slugify("High error rate (5xx)!"), "high-error-rate-5xx")
    assert.strictEqual(slugify("根因 / Root cause"), "根因-root-cause")
  })
})
