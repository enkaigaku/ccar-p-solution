import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { FeedbackRecord, ReplaySnapshot, replayKey } from "@incident/contracts"
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Datasets } from "../src/dataset/Datasets.ts"
import { CaseId } from "../src/dataset/EvalCase.ts"
import { runCurate, runPromote } from "../src/feedback/commands.ts"
import { auditedCalls, curate, feedbackCaseId } from "../src/feedback/curate.ts"
import { selectCases } from "../src/promptfoo/tests.ts"

const record = (id: string, investigationId: string, createdAt: string, actualRootCause?: string) =>
  Schema.decodeUnknownSync(FeedbackRecord)({
    id,
    investigationId,
    feedback: { rating: "down", ...(actualRootCause === undefined ? {} : { actualRootCause }) },
    submittedBy: { subject: "u-2", name: "bob" },
    report: {
      alert: {
        id: "fp-checkout-1",
        fingerprint: "fp-checkout-1",
        name: "HighErrorRate",
        service: "checkout",
        severity: "critical",
        status: "firing",
        summary: "checkout 5xx above 5%",
        labels: { alertname: "HighErrorRate", service: "checkout" },
        startsAt: "2026-11-12T03:00:00Z",
      },
      status: "completed",
      hypotheses: [{ summary: "checkout is overloaded", confidence: 0.6, evidence: [] }],
      promptVersion: "investigation@3",
      indexVersion: "idx-1",
      model: "claude-opus-5-5",
      traceId: "trace-abc",
    },
    createdAt,
  })

const window = { start: "2026-11-12T02:45:00Z", end: "2026-11-12T03:05:00Z" }
const logs = (service: string, totalMatched: number) => ({
  tool: "query_logs",
  input: { service, ...window, level: "error" },
  output: {
    ref: `logs-${service}`,
    totalMatched,
    countsByLevel: { error: totalMatched },
    topMessages: [{ pattern: "charge failed: invalid token", count: totalMatched }],
    samples: [],
  },
})
const line = (kind: string, investigationId: string, at: string, payload: unknown) =>
  JSON.stringify({ at, kind, investigationId, subject: "x", sha256: "0", payload: JSON.stringify(payload) })

const auditLog = [
  line("llm_request", "inv-1", "2026-11-12T03:01:00Z", { system: "..." }),
  line("tool_call", "inv-1", "2026-11-12T03:01:10Z", {
    tool: "get_service_topology",
    input: {},
    output: { ref: "topology-1", edges: [{ from: "checkout", to: "payment", protocol: "grpc" }] },
  }),
  line("tool_call", "inv-1", "2026-11-12T03:01:20Z", logs("payment", 3)),
  // The same query again: the later answer is the one the agent concluded on.
  line("tool_call", "inv-1", "2026-11-12T03:02:30Z", logs("payment", 40)),
  line("tool_call", "inv-1", "2026-11-12T03:02:00Z", logs("checkout", 12)),
  line("tool_call", "inv-1", "2026-11-12T03:02:10Z", { tool: "query_logs", input: {}, output: "not a result" }),
  line("tool_result", "inv-1", "2026-11-12T03:02:11Z", "<untrusted-data>...</untrusted-data>"),
  "not json at all",
  line("tool_call", "inv-other", "2026-11-12T09:00:00Z", logs("cart", 1)),
  "",
].join("\n")

describe("auditedCalls", () => {
  it("reads tool_call records per investigation and counts the unreadable ones", () => {
    const audit = auditedCalls(auditLog)
    assert.strictEqual(audit.byInvestigation.get("inv-1")?.length, 4)
    assert.strictEqual(audit.byInvestigation.get("inv-other")?.length, 1)
    assert.strictEqual(audit.invalid, 1)
  })
})

describe("curate", () => {
  const audit = auditedCalls(auditLog)

  it("builds one replayable candidate per investigation from the newest stated root cause", () => {
    const { candidates, skipped } = curate(
      [
        record("fb-a", "inv-1", "2026-11-12T04:00:00Z", "payment was slow"),
        record("fb-b", "inv-1", "2026-11-12T05:00:00Z", "  The paymentFailure flag was on.  "),
        record("fb-c", "inv-1", "2026-11-12T06:00:00Z"),
      ],
      audit,
      new Set(),
    )
    assert.deepStrictEqual(skipped, [])
    assert.strictEqual(candidates.length, 1)
    const [candidate] = candidates
    const id = feedbackCaseId("inv-1")
    assert.isTrue(Option.isSome(Schema.decodeUnknownOption(CaseId)(id)))
    // The id is derived from the investigation, never from anything that describes the fault.
    assert.notInclude(id, "payment")
    assert.strictEqual(candidate?.case.id, id)
    assert.strictEqual(candidate?.case.snapshotId, id)
    assert.deepStrictEqual(candidate?.case.groundTruth, {
      rootCause: "The paymentFailure flag was on.",
      service: "checkout",
      acceptableAlternatives: [],
    })
    assert.deepStrictEqual(candidate?.case.origin, {
      feedbackId: "fb-b",
      investigationId: "inv-1",
      traceId: "trace-abc",
      rating: "down",
      model: "claude-opus-5-5",
      promptVersion: "investigation@3",
      indexVersion: "idx-1",
    })
    assert.isFalse(candidate?.case.smoke)

    const snapshot = candidate?.snapshot
    assert.strictEqual(snapshot?.caseId, id)
    assert.strictEqual(snapshot?.alert.fingerprint, id)
    assert.deepStrictEqual(snapshot?.alert.annotations, { summary: "checkout 5xx above 5%" })
    // One answer per replay key; the repeated payment query keeps its last answer.
    assert.strictEqual(snapshot?.calls.length, 3)
    assert.strictEqual(new Set(snapshot?.calls.map(replayKey)).size, 3)
    const payment = snapshot?.calls.find((c) => c.tool === "query_logs" && c.input.service === "payment")
    assert.strictEqual(payment?.tool === "query_logs" ? payment.output.totalMatched : undefined, 40)
    // The agent is told the window's end as the current time: the last call of the live investigation.
    assert.strictEqual(DateTime.formatIso(snapshot?.window.end ?? DateTime.makeUnsafe(0)), "2026-11-12T03:02:30.000Z")
    // The root cause never enters what the agent will read.
    assert.isDefined(snapshot)
    if (snapshot !== undefined) {
      assert.notInclude(JSON.stringify(Schema.encodeSync(ReplaySnapshot)(snapshot)), "paymentFailure")
    }
  })

  it("skips what is already curated and what has no audited telemetry, and says why", () => {
    const { candidates, skipped } = curate(
      [
        record("fb-a", "inv-1", "2026-11-12T04:00:00Z", "payment flag"),
        record("fb-d", "inv-2", "2026-11-12T04:00:00Z", "cart cache was full"),
      ],
      audit,
      new Set([feedbackCaseId("inv-1")]),
    )
    assert.deepStrictEqual(candidates, [])
    assert.deepStrictEqual(
      skipped.map((s) => [s.feedbackId, s.reason.split(" (")[0]]),
      [
        ["fb-a", "already curated"],
        ["fb-d", "no audited tool calls for this investigation"],
      ],
    )
  })
})

describe("curate and promote commands", () => {
  const withTempRoot = <A, E>(
    use: (dirs: {
      root: string
      out: string
      feedback: string
      audit: string
    }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Datasets>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const feedback = path.join(root, "feedback.json")
      const audit = path.join(root, "audit.jsonl")
      const records = [record("fb-b", "inv-1", "2026-11-12T05:00:00Z", "The paymentFailure flag was on.")]
      yield* fs.writeFileString(feedback, JSON.stringify(Schema.encodeSync(Schema.Array(FeedbackRecord))(records)))
      yield* fs.writeFileString(audit, auditLog)
      return yield* use({ root, out: path.join(root, "candidates"), feedback, audit }).pipe(
        Effect.provide(Datasets.layerAt(root)),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

  it.effect("writes a candidate, promotes it into the dataset once, and curating again finds nothing new", () =>
    withTempRoot(({ root, out, feedback, audit }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const options = { feedback: Option.some(feedback), audit, out }
        const first = yield* runCurate(options)
        const id = first.candidates[0]?.case.id ?? ""
        assert.isTrue(yield* fs.exists(path.join(out, id, "case.json")))
        assert.isTrue(yield* fs.exists(path.join(out, id, "snapshot.json")))
        // Not part of the dataset until someone promotes it.
        assert.deepStrictEqual(yield* (yield* Datasets).cases, [])
        assert.strictEqual((yield* runCurate(options)).candidates.length, 0)

        // The reviewer corrects the guessed service before promoting.
        const caseFile = path.join(out, id, "case.json")
        const edited = JSON.parse(yield* fs.readFileString(caseFile))
        edited.groundTruth.service = "payment"
        yield* fs.writeFileString(caseFile, JSON.stringify(edited))

        const promoted = yield* runPromote({ id, from: out, root })
        assert.strictEqual(promoted.groundTruth.service, "payment")
        const datasets = yield* Datasets
        const cases = yield* datasets.cases
        assert.deepStrictEqual(
          cases.map((c) => [c.id, c.kind]),
          [[id, "feedback"]],
        )
        assert.strictEqual((yield* datasets.snapshot(id)).calls.length, 3)
        assert.isFalse(yield* fs.exists(path.join(out, id)))
        // A promoted case is evaluated as a set of its own; the baseline runs never pick it up.
        assert.deepStrictEqual(yield* selectCases("full"), [])
        assert.deepStrictEqual(yield* selectCases("smoke"), [])
        assert.deepStrictEqual(
          (yield* selectCases("feedback")).map((c) => c.id),
          [id],
        )

        const again = yield* runCurate(options)
        assert.strictEqual(again.candidates.length, 0)
        assert.strictEqual(again.skipped[0]?.reason, "already curated")
        const twice = yield* runPromote({ id, from: out, root }).pipe(Effect.flip)
        assert.strictEqual(twice._tag, "CurationError")
      }),
    ),
  )

  it.effect("refuses to promote a candidate whose hand-edit broke it", () =>
    withTempRoot(({ root, out, feedback, audit }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { candidates } = yield* runCurate({ feedback: Option.some(feedback), audit, out })
        const id = candidates[0]?.case.id ?? ""
        const caseFile = path.join(out, id, "case.json")
        const edited = JSON.parse(yield* fs.readFileString(caseFile))
        edited.groundTruth.rootCause = ""
        yield* fs.writeFileString(caseFile, JSON.stringify(edited))
        const error = yield* runPromote({ id, from: out, root }).pipe(Effect.flip)
        assert.strictEqual(error._tag, "CurationError")
        assert.isFalse(yield* fs.exists(path.join(root, "datasets", "feedback", `${id}.json`)))
      }),
    ),
  )
})
