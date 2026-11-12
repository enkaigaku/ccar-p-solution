/**
 * Index maintenance CLI. Needs DATABASE_URL, and VOYAGE_API_KEY unless --offline is given.
 *
 *   node scripts/rag.ts ingest [--offline] [--corpus DIR] [--set FILE] [--force]
 *       Rebuild from the corpus, evaluate the candidate and the active index on the retrieval set,
 *       and activate the candidate only if the gate passes (recall@8 ≥ 0.85, drop ≤ 5 points).
 *   node scripts/rag.ts eval [--offline] [--set FILE]     Evaluate the active index.
 *   node scripts/rag.ts versions                          List index versions.
 *   node scripts/rag.ts activate VERSION                  Activate (or roll back to) a version.
 *   node scripts/rag.ts prune [KEEP]                      Delete all but the newest KEEP inactive versions (default 3).
 *
 * --offline uses the hashing embedder and identity reranker: it exercises the SQL path without Voyage,
 * but its recall says nothing about production quality.
 */
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { PgClient } from "@effect/sql-pg"
import { Config, Console, Effect, Layer, Option } from "effect"
import {
  decodeRetrievalSet,
  evaluateRetrieval,
  gateDecision,
  HashingEmbedderLayer,
  IdentityRerankerLayer,
  loadCorpus,
  PgChunkStoreLayer,
  RagIndex,
  RagIndexFromServices,
  RagIndexLive,
  type RetrievalMetrics,
} from "../src/index.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    offline: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    corpus: { type: "string", default: new URL("../corpus", import.meta.url).pathname },
    set: { type: "string", default: new URL("../eval/retrieval-seed.json", import.meta.url).pathname },
  },
})

const PgLive = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })

const OfflineIndex = RagIndexFromServices().pipe(
  Layer.provide(Layer.mergeAll(PgChunkStoreLayer, HashingEmbedderLayer, IdentityRerankerLayer)),
)

/** Commands that search or embed need the real models unless --offline; the rest never call a model. */
const needsModels = (command: string | undefined) => command === "ingest" || command === "eval"

const IndexLayer = (needsModels(positionals[0]) && !values.offline ? RagIndexLive : OfflineIndex).pipe(
  Layer.provide(PgLive),
)

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

const printMetrics = (label: string, m: RetrievalMetrics) =>
  Effect.gen(function* () {
    yield* Console.log(
      `${label}: recall@${m.k} ${pct(m.recallAtK)}  MRR ${m.mrr.toFixed(3)}  (${m.cases.length} cases)`,
    )
    for (const c of m.cases.filter((c) => c.recall < 1)) {
      yield* Console.log(`  miss ${c.id}: ${c.missing.join(", ")}`)
    }
  })

const loadSet = Effect.promise(() => readFile(values.set, "utf8")).pipe(Effect.flatMap(decodeRetrievalSet))

const evaluateVersion = (version: string) =>
  Effect.gen(function* () {
    const index = yield* RagIndex
    const set = yield* loadSet
    return yield* evaluateRetrieval(set.cases, (q) => index.searchIn(version, q))
  })

const ingest = Effect.gen(function* () {
  const index = yield* RagIndex
  const docs = yield* loadCorpus(values.corpus)
  const active = yield* index.activeVersion
  const report = yield* index.rebuild(docs)
  yield* Console.log(
    `built ${report.indexVersion}: ${report.chunksWritten} embedded, ${report.chunksSkipped} reused, from ${docs.length} documents`,
  )
  const candidate = yield* evaluateVersion(report.indexVersion)
  yield* printMetrics("candidate", candidate)
  let baseline: RetrievalMetrics | undefined
  if (Option.isSome(active)) {
    baseline = yield* evaluateVersion(active.value.version)
    yield* printMetrics(`active ${active.value.version}`, baseline)
  }
  const decision = gateDecision({ candidate, baseline })
  yield* Console.log(`gate: ${decision.activate ? "pass" : "block"}, ${decision.reason}`)
  if (decision.activate || values.force) {
    yield* index.activate(report.indexVersion)
    yield* Console.log(`activated ${report.indexVersion}${decision.activate ? "" : " (forced)"}`)
  } else {
    yield* Console.log(`left ${report.indexVersion} inactive; rerun with --force to override`)
    process.exitCode = 1
  }
})

const evalActive = Effect.gen(function* () {
  const active = yield* (yield* RagIndex).activeVersion
  if (Option.isNone(active)) return yield* Console.log("no active index; run ingest first")
  yield* printMetrics(`active ${active.value.version}`, yield* evaluateVersion(active.value.version))
})

const versions = Effect.gen(function* () {
  for (const v of yield* (yield* RagIndex).listVersions) {
    yield* Console.log(
      `${v.version}  ${v.status.padEnd(7)}  ${String(v.chunkCount).padStart(5)} chunks  ${v.embeddingModel}`,
    )
  }
})

const commands: Record<string, Effect.Effect<unknown, unknown, RagIndex>> = {
  ingest,
  eval: evalActive,
  versions,
  activate: Effect.suspend(() => {
    const version = positionals[1]
    return version === undefined
      ? Console.error("usage: activate VERSION")
      : RagIndex.use((index) => index.activate(version)).pipe(Effect.andThen(Console.log(`activated ${version}`)))
  }),
  prune: RagIndex.use((index) => index.prune(Number(positionals[1] ?? 3))).pipe(
    Effect.flatMap((deleted) => Console.log(`deleted ${deleted.length} versions`)),
  ),
}

const command = commands[positionals[0] ?? ""]
if (command === undefined) {
  console.error(`usage: rag.ts <${Object.keys(commands).join("|")}> [options]`)
  process.exitCode = 2
} else {
  Effect.runPromise(command.pipe(Effect.provide(IndexLayer))).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
