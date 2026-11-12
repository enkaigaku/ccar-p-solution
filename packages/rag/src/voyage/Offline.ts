import { Effect, Layer } from "effect"
import { tokenize } from "../text.ts"
import { Embedder, Reranker } from "./Models.ts"
import { EMBEDDING_DIMENSIONS } from "./VoyageClient.ts"

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic feature-hashing embedding over words and character trigrams.
 * Captures lexical overlap only. For tests and offline runs, never for a production index.
 */
export const hashingEmbedding = (text: string, dimensions = EMBEDDING_DIMENSIONS): Array<number> => {
  const vector = new Array<number>(dimensions).fill(0)
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature)
    vector[h % dimensions] = (vector[h % dimensions] ?? 0) + (h & 0x80000000 ? -weight : weight)
  }
  for (const word of tokenize(text)) {
    add(`w:${word}`, 1)
    const padded = `^${word}$`
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.3)
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? vector : vector.map((x) => x / norm)
}

/** Offline `Embedder` using {@link hashingEmbedding}. */
export const HashingEmbedderLayer = Layer.succeed(
  Embedder,
  Embedder.of({
    model: "hashing-v1",
    dimensions: EMBEDDING_DIMENSIONS,
    embed: (texts) => Effect.succeed(texts.map((t) => hashingEmbedding(t))),
  }),
)

/** Offline `Reranker` that keeps the incoming order. Scores decrease from 1 so the top result reads as most relevant. */
export const IdentityRerankerLayer = Layer.succeed(
  Reranker,
  Reranker.of({
    model: "identity",
    rerank: (_query, documents, topK) =>
      Effect.succeed(documents.slice(0, topK).map((_, index) => ({ index, score: 1 / (index + 1) }))),
  }),
)
