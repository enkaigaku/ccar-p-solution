const WORD = /[\p{L}\p{N}]+/gu

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "then",
  "this",
  "to",
  "was",
  "when",
  "with",
  "what",
  "why",
  "how",
])

const stem = (word: string): string => {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

/** Lowercased, lightly stemmed words without stopwords. Used by the offline embedder and the in-memory store. */
export const tokenize = (text: string): Array<string> =>
  (text.toLowerCase().match(WORD) ?? []).filter((w) => !STOPWORDS.has(w)).map(stem)

/**
 * Builds a `to_tsquery` input that ORs the query's words. Only letters and digits survive, so the
 * result cannot carry tsquery operators from the caller. Postgres applies its own stemming and stopwords.
 * Returns undefined when the text has no words.
 */
export const toTsQueryText = (text: string, maxTerms = 64): string | undefined => {
  const words = [...new Set(text.toLowerCase().match(WORD) ?? [])].slice(0, maxTerms)
  return words.length === 0 ? undefined : words.join(" | ")
}
