import { ReplaySnapshot } from "@incident/contracts"
import { Effect, FileSystem, Path, Schema } from "effect"

/**
 * Writes the snapshot where `mcp-observability` replay mode reads it: `<dir>/<caseId>/snapshot.json`,
 * so the api's MCP server runs with `REPLAY_DIR=<dir>` and `REPLAY_CASE=<caseId>`.
 */
export const materializeSnapshot = Effect.fn("evals.materializeSnapshot")(function* (
  dir: string,
  snapshot: ReplaySnapshot,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const caseDir = path.join(dir, snapshot.caseId)
  yield* fs.makeDirectory(caseDir, { recursive: true })
  const json = yield* Schema.encodeEffect(Schema.fromJsonString(ReplaySnapshot))(snapshot)
  yield* fs.writeFileString(path.join(caseDir, "snapshot.json"), json)
  return caseDir
})
