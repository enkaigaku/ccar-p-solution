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

/** Breaks a unit that alone exceeds the budget: first at sentence ends, then at a hard character limit. */
const splitOversized = (unit: string, maxTokens: number): Array<string> => {
  if (estimateTokens(unit) <= maxTokens) return [unit]
  const sentences = unit.split(/(?<=[.!?。！？；;])\s*/u).filter((s) => s.trim().length > 0)
  if (sentences.length > 1) return sentences.flatMap((s) => splitOversized(s, maxTokens))
  const pieces: Array<string> = []
  let piece = ""
  for (const char of unit) {
    if (estimateTokens(piece + char) > maxTokens) {
      pieces.push(piece)
      piece = ""
    }
    piece += char
  }
  if (piece.length > 0) pieces.push(piece)
  return pieces
}

/**
 * Packs blocks greedily into windows of at most `maxTokens`. Each new window starts with the trailing
 * units of the previous one, up to `overlapTokens`, so a step split across windows keeps its context.
 */
export const windowText = (body: string, params: ChunkParams): Array<string> => {
  const units = splitBlocks(body).flatMap((block) => splitOversized(block, params.maxTokens))
  const windows: Array<Array<string>> = []
  let current: Array<string> = []
  let tokens = 0
  let fresh = 0
  for (const unit of units) {
    const size = estimateTokens(unit)
    if (fresh > 0 && tokens + size > params.maxTokens) {
      windows.push(current)
      const overlap: Array<string> = []
      let overlapTokens = 0
      for (let i = current.length - 1; i >= 0; i--) {
        const candidate = current[i] ?? ""
        const candidateTokens = estimateTokens(candidate)
        if (
          overlapTokens + candidateTokens > params.overlapTokens ||
          overlapTokens + candidateTokens + size > params.maxTokens
        )
          break
        overlap.unshift(candidate)
        overlapTokens += candidateTokens
      }
      current = overlap
      tokens = overlapTokens
      fresh = 0
    }
    current.push(unit)
    tokens += size
    fresh++
  }
  if (fresh > 0) windows.push(current)
  return windows.map((w) => w.join("\n\n"))
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
