import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { type Corpus, IngestError, SourceDocument } from "@incident/contracts"
import { Effect } from "effect"

/** Top-level directory name → corpus. Files elsewhere are ignored. */
const CORPUS_DIRS: Readonly<Record<string, Corpus>> = {
  runbooks: "runbook",
  postmortems: "postmortem",
  "public-postmortems": "public-postmortem",
}

const listMarkdown = async (dir: string): Promise<Array<string>> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? listMarkdown(join(dir, e.name))
        : Promise.resolve(/\.md$/i.test(e.name) ? [join(dir, e.name)] : []),
    ),
  )
  return nested.flat().sort()
}

/**
 * Reads a corpus directory (`runbooks/`, `postmortems/`, `public-postmortems/`) into source documents.
 * The source id is the path relative to `root` with forward slashes, for example `runbooks/checkout.md`.
 */
export const loadCorpus = (root: string): Effect.Effect<ReadonlyArray<SourceDocument>, IngestError> =>
  Effect.tryPromise({
    try: async () => {
      const files = await listMarkdown(root)
      const docs: Array<SourceDocument> = []
      for (const file of files) {
        const sourceId = relative(root, file).split(sep).join("/")
        const corpus = CORPUS_DIRS[sourceId.split("/")[0] ?? ""]
        if (corpus === undefined) continue
        docs.push(new SourceDocument({ sourceId, corpus, markdown: await readFile(file, "utf8") }))
      }
      return docs
    },
    catch: (cause) => new IngestError({ sourceId: root, message: "failed to read corpus directory", cause }),
  })
