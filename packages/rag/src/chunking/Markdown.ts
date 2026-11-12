import { Effect, Schema } from "effect"

/** A heading-delimited section of a Markdown document. */
export interface Section {
  /** Heading texts from the document title down to this section, for example ["checkout", "High error rate"]. */
  readonly headingPath: ReadonlyArray<string>
  readonly body: string
}

export interface ParsedMarkdown {
  readonly frontMatter: FrontMatter
  readonly title: string | undefined
  readonly sections: ReadonlyArray<Section>
}

/**
 * Optional front matter at the top of a corpus file. Only flat `key: value` lines are supported;
 * unknown keys are ignored. `alerts` is a comma-separated list of Alertmanager alert names.
 */
export const FrontMatter = Schema.Struct({
  service: Schema.optionalKey(Schema.NonEmptyString),
  alerts: Schema.optionalKey(Schema.String),
})
export type FrontMatter = typeof FrontMatter.Type

const decodeFrontMatter = Schema.decodeUnknownEffect(FrontMatter)

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/

const parseFrontMatter = (
  lines: ReadonlyArray<string>,
): Effect.Effect<{ frontMatter: FrontMatter; rest: ReadonlyArray<string> }, Schema.SchemaError> => {
  if (lines[0]?.trim() !== "---") return Effect.succeed({ frontMatter: {}, rest: lines })
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
  if (end === -1) return Effect.succeed({ frontMatter: {}, rest: lines })
  const raw: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) raw[match[1]] = match[2].trim()
  }
  return decodeFrontMatter(raw).pipe(Effect.map((frontMatter) => ({ frontMatter, rest: lines.slice(end + 1) })))
}

/** Splits the comma-separated `alerts` front matter value. */
export const parseAlerts = (frontMatter: FrontMatter): ReadonlyArray<string> =>
  (frontMatter.alerts ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/**
 * Splits Markdown into sections at headings up to `maxDepth` (H1 is the document title).
 * Headings inside fenced code blocks are ignored, so shell comments such as `# restart` stay in the body.
 * Deeper headings stay in the body of their parent section. Sections with an empty body are dropped,
 * but their heading still appears in the paths of their children.
 */
export const parseMarkdown = Effect.fnUntraced(function* (markdown: string, maxDepth: 2 | 3) {
  const { frontMatter, rest } = yield* parseFrontMatter(markdown.replace(/\r\n?/g, "\n").split("\n"))
  let title: string | undefined
  const sections: Array<Section> = []
  // stack[0] is the H2 heading, stack[1] the H3 heading.
  let stack: Array<string> = []
  let body: Array<string> = []
  let fence: string | undefined

  const flush = () => {
    const text = body.join("\n").trim()
    if (text.length > 0) sections.push({ headingPath: [...(title === undefined ? [] : [title]), ...stack], body: text })
    body = []
  }

  for (const line of rest) {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1]
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      body.push(line)
      continue
    }
    const heading = fence === undefined ? HEADING.exec(line) : null
    const level = heading?.[1]?.length
    const text = heading?.[2]?.trim()
    if (level === undefined || text === undefined || text.length === 0 || level > maxDepth) {
      body.push(line)
      continue
    }
    flush()
    if (level === 1) {
      title = text
      stack = []
    } else {
      stack = [...stack.slice(0, level - 2), text]
    }
  }
  flush()
  const parsed: ParsedMarkdown = { frontMatter, title, sections }
  return parsed
})
