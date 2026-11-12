/**
 * A versioned prompt. Callers record `version` on spans and on `Investigation.promptVersion`.
 * `text` must be a stable prefix: no timestamps, ids or other per-request values (prompt caching).
 */
export interface Prompt {
  readonly version: string
  readonly text: string
}
