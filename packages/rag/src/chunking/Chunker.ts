import { createHash } from "node:crypto"
import type { Corpus, SourceDocument } from "@incident/contracts"
import { Effect, Schema } from "effect"
import { parseAlerts, parseMarkdown } from "./Markdown.ts"

/** Chunking parameters for one corpus. Recorded with every index version. */
export interface ChunkParams {
  /** Deepest heading level that starts a new chunk (H1 is the title). */
  readonly splitDepth: 2 | 3
  readonly maxTokens: number
  readonly overlapTokens: number
}

export const CHUNKER_ALGORITHM = "heading-window-v1"

/**
 * Runbooks split at H2/H3 so each alert's diagnosis and mitigation are separate chunks.
 * Postmortems split at H2 (symptoms / root cause / mitigation) and keep H3 detail in the section.
 */
export const defaultChunkParams: Readonly<Record<Corpus, ChunkParams>> = {
  runbook: { splitDepth: 3, maxTokens: 512, overlapTokens: 64 },
  postmortem: { splitDepth: 2, maxTokens: 512, overlapTokens: 64 },
  "public-postmortem": { splitDepth: 2, maxTokens: 512, overlapTokens: 64 },
}

/** A chunk ready to embed and store. `embedInput` is what gets embedded; `text` is what callers cite. */
export interface PreparedChunk {
  readonly id: string
  readonly corpus: Corpus
  readonly sourceId: string
  readonly headingPath: ReadonlyArray<string>
  readonly service: string | undefined
  readonly alerts: ReadonlyArray<string>
  readonly text: string
  readonly embedInput: string
  /** SHA-256 of `embedInput`. Unchanged hash means the stored embedding can be reused. */
  readonly contentHash: string
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/gu

/**
 * Cheap token estimate: one token per CJK character, one per four other characters.
 * Only used to size chunks; the embedding API truncates anything that is still too long.
 */
export const estimateTokens = (text: string): number => {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** Splits a section body into blocks at blank lines, keeping fenced code blocks whole. */
const splitBlocks = (body: string): Array<string> => {
  const blocks: Array<string> = []
  let current: Array<string> = []
  let fence: string | undefined
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    }
    if (fence === undefined && marker === undefined && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"))
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"))
  return blocks
}

/** A piece of a section body plus the original text that separated it from the previous piece. */
interface Unit {
  readonly text: string
  readonly sep: string
}

/**
 * Sentence ends: Latin punctuation only when followed by whitespace (so URLs, decimals and dotted keys
 * stay intact), CJK punctuation anywhere. The captured whitespace is kept to rebuild the original text.
 */
const SENTENCE_END = /(?<=[.!?;:])(\s+)|(?<=[。！？；])(\s*)/u

const splitSentences = (text: string): Array<Unit> => {
  const units: Array<Unit> = []
  let rest = text
  let sep = ""
  for (;;) {
    const match = SENTENCE_END.exec(rest)
    if (match === null || match.index + match[0].length >= rest.length) break
    const head = rest.slice(0, match.index)
    if (head.length === 0) break
    units.push({ text: head, sep })
    sep = match[0]
    rest = rest.slice(match.index + match[0].length)
  }
  units.push({ text: rest, sep })
  return units
}

/** Splits at the last character that keeps `text` within `budget` tokens, preferring a whitespace boundary. */
const splitHard = (text: string, budget: number): Array<Unit> => {
  const units: Array<Unit> = []
  let rest = text
  while (estimateTokens(rest) > budget) {
    let end = 0
    let tokens = 0
    for (const char of rest) {
      const next = tokens + estimateTokens(char)
      if (next > budget) break
      tokens = next
      end += char.length
    }
    const space = rest.lastIndexOf(" ", end)
    const cut = space > end / 2 ? space + 1 : Math.max(end, 1)
    units.push({ text: rest.slice(0, cut), sep: "" })
    rest = rest.slice(cut)
  }
  if (rest.length > 0) units.push({ text: rest, sep: "" })
  return units
}

/** Breaks a unit that alone exceeds `budget`: first at sentence ends, then at a hard limit. */
const splitOversized = (unit: Unit, budget: number): Array<Unit> => {
  if (estimateTokens(unit.text) <= budget) return [unit]
  const sentences = splitSentences(unit.text)
  const pieces =
    sentences.length > 1 ? sentences.flatMap((s) => splitOversized(s, budget)) : splitHard(unit.text, budget)
  // The first piece inherits the separator that preceded the whole unit.
  return pieces.map((p, i) => (i === 0 ? { ...p, sep: unit.sep } : p))
}

/** The end of `text` worth at most `budget` tokens, starting at a word boundary when there is one. */
const tailWithin = (text: string, budget: number): string => {
  let start = text.length
  let tokens = 0
  while (start > 0) {
    const next = tokens + estimateTokens(text[start - 1] ?? "")
    if (next > budget) break
    tokens = next
    start--
  }
  if (start === 0) return text
  const space = text.indexOf(" ", start)
  return space !== -1 && space < text.length - 1 ? text.slice(space + 1) : text.slice(start)
}

const joinUnits = (units: ReadonlyArray<Unit>) => units.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join("")

/**
 * Packs units greedily into windows of at most `maxTokens`. Each new window starts with up to
 * `overlapTokens` from the end of the previous window (whole units, then the tail of a longer one),
 * so a step that straddles a boundary appears whole in at least one window. Units are first split to
 * at most `maxTokens - overlapTokens`, which always leaves room for the overlap.
 */
export const windowText = (body: string, params: ChunkParams): Array<string> => {
  const budget = Math.max(params.maxTokens - params.overlapTokens, 1)
  const units = splitBlocks(body).flatMap((block, i) =>
    splitOversized({ text: block, sep: i === 0 ? "" : "\n\n" }, budget),
  )
  const windows: Array<string> = []
  let current: Array<Unit> = []
  let tokens = 0
  let fresh = 0
  for (const unit of units) {
    const size = estimateTokens(unit.text)
    if (fresh > 0 && tokens + size > params.maxTokens) {
      windows.push(joinUnits(current))
      const overlap: Array<Unit> = []
      let overlapTokens = 0
      for (let i = current.length - 1; i >= 0 && overlapTokens < params.overlapTokens; i--) {
        const candidate = current[i]
        if (candidate === undefined) break
        const candidateTokens = estimateTokens(candidate.text)
        if (overlapTokens + candidateTokens <= params.overlapTokens) {
          overlap.unshift(candidate)
          overlapTokens += candidateTokens
          continue
        }
        const tail = tailWithin(candidate.text, params.overlapTokens - overlapTokens)
        if (tail.length > 0 && tail.length < candidate.text.length) {
          overlap.unshift({ text: tail, sep: candidate.sep })
          overlapTokens += estimateTokens(tail)
        }
        break
      }
      current = overlap
      tokens = overlapTokens
      fresh = 0
    }
    current.push(unit)
    tokens += size
    fresh++
  }
  if (fresh > 0) windows.push(joinUnits(current))
  return windows
}

export const slugify = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

const fallbackTitle = (sourceId: string): string => (sourceId.split("/").pop() ?? sourceId).replace(/\.mdx?$/i, "")

/**
 * Chunk ids are `<sourceId>#<slug of headings below the title>`, with `.2`, `.3`… for the extra windows
 * of a long section. They stay stable when text changes, so labelled retrieval sets and citations
 * survive edits; only renaming a heading changes an id.
 */
const chunkIdFor = (sourceId: string, headingPath: ReadonlyArray<string>, used: Map<string, number>): string => {
  const slug = headingPath
    .slice(1)
    .map(slugify)
    .filter((s) => s.length > 0)
    .join("/")
  const base = `${sourceId}#${slug.length > 0 ? slug : "_intro"}`
  const seen = used.get(base) ?? 0
  used.set(base, seen + 1)
  return seen === 0 ? base : `${base}~${seen + 1}`
}

export class ChunkingError extends Schema.TaggedError<ChunkingError>()("ChunkingError", {
  sourceId: Schema.String,
  message: Schema.String,
}) {}

/** Turns one source document into prepared chunks. An empty document yields no chunks. */
export const chunkDocument = Effect.fnUntraced(function* (
  doc: SourceDocument,
  params: Readonly<Record<Corpus, ChunkParams>> = defaultChunkParams,
) {
  const corpusParams = params[doc.corpus]
  const parsed = yield* parseMarkdown(doc.markdown, corpusParams.splitDepth).pipe(
    Effect.mapError(
      (error) => new ChunkingError({ sourceId: doc.sourceId, message: `invalid front matter: ${error.message}` }),
    ),
  )
  const service = doc.service ?? parsed.frontMatter.service
  const alerts = parseAlerts(parsed.frontMatter)
  const used = new Map<string, number>()
  const chunks: Array<PreparedChunk> = []
  for (const section of parsed.sections) {
    const headingPath =
      parsed.title === undefined ? [fallbackTitle(doc.sourceId), ...section.headingPath] : section.headingPath
    const sectionId = chunkIdFor(doc.sourceId, headingPath, used)
    const windows = windowText(section.body, corpusParams)
    windows.forEach((text, i) => {
      const id = i === 0 ? sectionId : `${sectionId}.${i + 1}`
      // The heading path and alert names give the embedding the context a bare paragraph lacks.
      const context = [headingPath.join(" > "), ...(alerts.length > 0 ? [`Alerts: ${alerts.join(", ")}`] : [])]
      const embedInput = `${context.join("\n")}\n\n${text}`
      chunks.push({
        id,
        corpus: doc.corpus,
        sourceId: doc.sourceId,
        headingPath,
        service,
        alerts,
        text,
        embedInput,
        contentHash: sha256(embedInput),
      })
    })
  }
  return chunks
})
