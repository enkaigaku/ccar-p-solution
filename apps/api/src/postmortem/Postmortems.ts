import { fileURLToPath } from "node:url"
import {
  type ActionProposal,
  type Alert,
  type FeedbackRecord,
  Ingestor,
  type Investigation,
  type InvestigationId,
  InvestigationNotFinished,
  type InvestigationNotFound,
  PostmortemBody,
  type PostmortemDecision,
  PostmortemDraft,
  PostmortemId,
  PostmortemNotDraft,
  PostmortemNotFound,
  PostmortemUnavailable,
  type Principal,
  SourceDocument,
} from "@incident/contracts"
import { PostmortemPrompt } from "@incident/prompts"
import { annotatePrompt, recordClaudeResponse, SpanName } from "@incident/telemetry"
import { Config, Context, DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"
import { AuditLog } from "../audit/AuditLog.ts"
import { ClaudeClient, responseText } from "../claude/ClaudeClient.ts"
import { FeedbackStore } from "../feedback/FeedbackStore.ts"
import { IncidentStore } from "../IncidentStore.ts"
import { canonicalJson, untrusted } from "../prompting.ts"
import { addUsage, emptyUsage } from "../usage.ts"
import { PostmortemStore } from "./PostmortemStore.ts"

export const PostmortemModel = "claude-sonnet-5-5"
const PostmortemEffort = "medium"
const FALLBACK_BETA = "server-side-fallback-2026-07-01"

const defaultCorpusDir = fileURLToPath(new URL("../../../../infra/.api-state/corpus", import.meta.url))

/** Structured-output schema (hand-written: structured outputs need `additionalProperties: false`). */
export const PostmortemBodyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "symptoms", "rootCause", "mitigation"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    symptoms: { type: "string" },
    rootCause: { type: "string" },
    mitigation: { type: "string" },
  },
} as const

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(PostmortemBody))

/** An investigation has a report worth writing up once it reached one of these. */
const FINISHED: ReadonlySet<Investigation["status"]> = new Set(["completed", "insufficient_information"])

export interface PostmortemMaterial {
  readonly alert: Alert
  readonly investigation: Investigation
  readonly proposals: ReadonlyArray<ActionProposal>
  readonly feedback: ReadonlyArray<FeedbackRecord>
}

/**
 * The volatile part of the request. Everything here is untrusted: alert text comes from monitoring, hypotheses
 * and rationales were written by a model that read untrusted telemetry, and feedback is free text. Names of
 * people (who decided, who gave feedback) are left out: the postmortem is blameless and ends up in the index.
 */
export const renderPostmortemRequest = (material: PostmortemMaterial): string => {
  const { alert, investigation, proposals, feedback } = material
  return [
    untrusted(
      "alertmanager",
      canonicalJson({
        labels: alert.labels,
        name: alert.name,
        service: alert.service,
        severity: alert.severity,
        startsAt: DateTime.formatIso(alert.startsAt),
        summary: alert.summary,
      }),
    ),
    untrusted(
      "investigation",
      canonicalJson({
        status: investigation.status,
        hypotheses: investigation.hypotheses.map((h) => ({
          summary: h.summary,
          confidence: h.confidence,
          evidence: h.evidence.map((e) => ({ kind: e.kind, ref: e.ref, ...(e.note ? { note: e.note } : {}) })),
        })),
      }),
    ),
    untrusted(
      "proposed-actions",
      canonicalJson(
        proposals.map((p) => ({
          action: p.action,
          rationale: p.rationale,
          expectedEffect: p.expectedEffect,
          outcome: p.status,
        })),
      ),
    ),
    untrusted(
      "responder-feedback",
      canonicalJson(
        feedback.map((f) => ({
          rating: f.feedback.rating,
          ...(f.feedback.actualRootCause ? { actualRootCause: f.feedback.actualRootCause } : {}),
          ...(f.feedback.comment ? { comment: f.feedback.comment } : {}),
        })),
      ),
    ),
    "Write the postmortem draft for this incident.",
  ].join("\n\n")
}

/** Service names become front matter and part of a file name; anything else is left out rather than escaped. */
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** One line, so a field can never open a front matter block or a heading of its own. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * The Markdown document that goes into the knowledge base. The four H2 sections are what the postmortem chunker
 * splits on, and match the hand-written postmortems in `packages/rag/corpus/postmortems`.
 */
export const renderPostmortemMarkdown = (draft: Pick<PostmortemDraft, "service" | "body">): string =>
  [
    ...(SAFE_SERVICE.test(draft.service) ? ["---", `service: ${draft.service}`, "---", ""] : []),
    `# ${oneLine(draft.body.title)}`,
    "",
    "## Summary",
    "",
    draft.body.summary.trim(),
    "",
    "## Symptoms",
    "",
    draft.body.symptoms.trim(),
    "",
    "## Root cause",
    "",
    draft.body.rootCause.trim(),
    "",
    "## Mitigation",
    "",
    draft.body.mitigation.trim(),
    "",
  ].join("\n")

/** `postmortems/generated/<date>-<service>-<id>.md`: under the `postmortems` corpus, apart from hand-written files. */
export const postmortemSourceId = (draft: Pick<PostmortemDraft, "id" | "service" | "createdAt">): string => {
  const date = DateTime.formatIso(draft.createdAt).slice(0, 10)
  const service = SAFE_SERVICE.test(draft.service) ? draft.service : "unknown"
  const id = draft.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)
  return `postmortems/generated/${date}-${service}-${id}.md`
}

/**
 * The feedback loop's write path into the knowledge base (design doc "复盘草稿"): Sonnet drafts a postmortem of
 * a finished investigation, a responder may correct it, and only an approver's `publish` ingests it. A draft the
 * model wrote is never searchable before a person accepted it, because the investigation agent would read it
 * back as reference material.
 */
export class Postmortems extends Context.Service<
  Postmortems,
  {
    generate(
      investigationId: InvestigationId,
    ): Effect.Effect<
      PostmortemDraft,
      InvestigationNotFound | InvestigationNotFinished | PostmortemNotDraft | PostmortemUnavailable
    >
    get(investigationId: InvestigationId): Effect.Effect<PostmortemDraft, InvestigationNotFound | PostmortemNotFound>
    edit(
      id: PostmortemId,
      body: PostmortemBody,
    ): Effect.Effect<PostmortemDraft, PostmortemNotFound | PostmortemNotDraft>
    /** The caller must already have checked that `reviewer` holds the `approver` role. */
    review(
      id: PostmortemId,
      decision: PostmortemDecision,
      reviewer: Principal,
    ): Effect.Effect<PostmortemDraft, PostmortemNotFound | PostmortemNotDraft | PostmortemUnavailable>
  }
>()("@incident/api/postmortem/Postmortems") {
  static readonly make = (settings: { readonly corpusDir: string }) =>
    Effect.gen(function* () {
      const incidents = yield* IncidentStore
      const feedbackStore = yield* FeedbackStore
      const store = yield* PostmortemStore
      const claude = yield* ClaudeClient
      const audit = yield* AuditLog
      const ingestor = yield* Ingestor
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { corpusDir } = settings
      // Generate, edit and review read a draft and write it back; one at a time keeps a published postmortem
      // from being overwritten by a request that read it as a draft. The api is a single instance (handoff doc).
      const lock = yield* Semaphore.make(1)

      const requireDraft = Effect.fnUntraced(function* (id: PostmortemId) {
        const found = yield* store.get(id)
        if (Option.isNone(found)) return yield* new PostmortemNotFound({ id })
        if (found.value.status !== "draft") return yield* new PostmortemNotDraft({ id, status: found.value.status })
        return found.value
      })

      const write = Effect.fnUntraced(function* (investigation: Investigation, material: PostmortemMaterial) {
        const user = renderPostmortemRequest(material)
        yield* annotatePrompt({ step: "postmortem", promptVersion: PostmortemPrompt.version, renderedPrompt: user })
        yield* audit.append({
          kind: "llm_request",
          investigationId: investigation.id,
          subject: PostmortemModel,
          payload: user,
        })
        const response = yield* claude
          .create({
            model: PostmortemModel,
            max_tokens: 16_000,
            // A refusal is retried server-side on the fallback model before it reaches us.
            betas: [FALLBACK_BETA],
            fallbacks: "default",
            thinking: { type: "adaptive" },
            output_config: {
              effort: PostmortemEffort,
              format: { type: "json_schema", schema: PostmortemBodyJsonSchema },
            },
            system: [{ type: "text", text: PostmortemPrompt.text, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: user }],
          })
          .pipe(
            Effect.tapError((error) => Effect.logWarning("Postmortem model call failed", error.message)),
            Effect.mapError(() => new PostmortemUnavailable({ reason: "model", message: "the model request failed" })),
          )
        const cost = yield* recordClaudeResponse({ step: "postmortem", requestedModel: PostmortemModel }, response)
        const usage = addUsage(emptyUsage, response.usage, cost)
        switch (response.stop_reason) {
          case "end_turn":
            break
          case "refusal":
            return yield* new PostmortemUnavailable({
              reason: "refusal",
              message: "the model declined, also after fallbacks",
            })
          case "max_tokens":
          case "model_context_window_exceeded":
            return yield* new PostmortemUnavailable({ reason: "max_tokens", message: "the draft was cut off" })
          default:
            return yield* new PostmortemUnavailable({ reason: "output", message: "the model stopped unexpectedly" })
        }
        const text = responseText(response)
        yield* audit.append({
          kind: "llm_response",
          investigationId: investigation.id,
          subject: response.model,
          payload: text,
        })
        const body = yield* decodeBody(text).pipe(
          Effect.mapError(
            () => new PostmortemUnavailable({ reason: "output", message: "the draft did not match its schema" }),
          ),
        )
        return { body, model: response.model, usage }
      })

      const generate = Effect.fn(SpanName.postmortem)(function* (investigationId: InvestigationId) {
        yield* Effect.annotateCurrentSpan({ "incident.investigation.id": investigationId })
        const investigation = yield* incidents.getInvestigation(investigationId)
        if (!FINISHED.has(investigation.status)) {
          return yield* new InvestigationNotFinished({ id: investigationId, status: investigation.status })
        }
        const existing = yield* store.getByInvestigation(investigationId)
        if (Option.isSome(existing) && existing.value.status !== "draft") {
          return yield* new PostmortemNotDraft({ id: existing.value.id, status: existing.value.status })
        }
        // The alert of a stored investigation always exists; the store never deletes alerts.
        const alert = yield* incidents.getAlert(investigation.alertId).pipe(Effect.orDie)
        const material: PostmortemMaterial = {
          alert,
          investigation,
          proposals: yield* incidents.listProposals(investigationId),
          feedback: yield* feedbackStore.listFor(investigationId),
        }
        const written = yield* write(investigation, material)
        const now = yield* DateTime.now
        const draft = new PostmortemDraft({
          id: PostmortemId.make(crypto.randomUUID()),
          investigationId,
          status: "draft",
          service: alert.service,
          body: written.body,
          model: written.model,
          promptVersion: PostmortemPrompt.version,
          usage: written.usage,
          edited: false,
          createdAt: now,
          updatedAt: now,
        })
        yield* store.put(draft)
        return draft
      }, lock.withPermits(1))

      const get = Effect.fn("Postmortems.get")(function* (investigationId: InvestigationId) {
        yield* incidents.getInvestigation(investigationId)
        const found = yield* store.getByInvestigation(investigationId)
        if (Option.isNone(found)) return yield* new PostmortemNotFound({ investigationId })
        return found.value
      })

      const edit = Effect.fn("Postmortems.edit")(function* (id: PostmortemId, body: PostmortemBody) {
        const draft = yield* requireDraft(id)
        // An id names one revision of the text. An edit gets a new one, so a review sent from a page that still
        // shows the old text finds no such draft instead of publishing words the approver never read.
        const edited = new PostmortemDraft({
          ...draft,
          id: PostmortemId.make(crypto.randomUUID()),
          body,
          edited: true,
          updatedAt: yield* DateTime.now,
        })
        yield* store.put(edited)
        return edited
      }, lock.withPermits(1))

      const publish = Effect.fnUntraced(function* (draft: PostmortemDraft) {
        const sourceId = postmortemSourceId(draft)
        const markdown = renderPostmortemMarkdown(draft)
        const unavailable = (step: string) => (error: { readonly message: string }) =>
          Effect.logWarning(`Postmortem publish failed: ${step}`, error.message).pipe(
            Effect.andThen(
              Effect.fail(
                new PostmortemUnavailable({ reason: "ingest", message: `could not ${step}; the draft is unchanged` }),
              ),
            ),
          )
        // The file first, so there is never an indexed document without the file a full rebuild reads. The corpus
        // directory must hold published postmortems only (`rag ingest --also` reads every file in it), so a failed
        // ingest takes the file away again: the draft may still be edited, regenerated or rejected.
        const file = path.join(corpusDir, ...sourceId.split("/"))
        yield* fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(file, markdown)),
            Effect.catch(unavailable("write the postmortem file")),
          )
        const report = yield* ingestor
          .ingest([
            new SourceDocument({
              sourceId,
              corpus: "postmortem",
              markdown,
              ...(SAFE_SERVICE.test(draft.service) ? { service: draft.service } : {}),
            }),
          ])
          .pipe(
            Effect.tapError(() =>
              fs.remove(file, { force: true }).pipe(
                Effect.catch((error) =>
                  Effect.logError("Unpublished postmortem file could not be removed; delete it by hand", {
                    sourceId,
                    error: error.message,
                  }),
                ),
              ),
            ),
            Effect.catch(unavailable("add the postmortem to the knowledge base")),
          )
        return { sourceId, indexVersion: report.indexVersion }
      })

      const review = Effect.fn("Postmortems.review")(function* (
        id: PostmortemId,
        decision: PostmortemDecision,
        reviewer: Principal,
      ) {
        const draft = yield* requireDraft(id)
        const published = decision === "publish" ? yield* publish(draft) : undefined
        const reviewed = new PostmortemDraft({
          ...draft,
          status: decision === "publish" ? "published" : "rejected",
          reviewedBy: reviewer.name,
          ...(published ?? {}),
          updatedAt: yield* DateTime.now,
        })
        yield* store.put(reviewed)
        // What entered the knowledge base, and on whose decision. The text is hashed like every audit payload.
        yield* audit.append({
          kind: "postmortem_review",
          investigationId: draft.investigationId,
          subject: id,
          payload: canonicalJson({
            decision,
            reviewer: { subject: reviewer.subject, name: reviewer.name },
            ...(published ?? {}),
            ...(published === undefined ? {} : { markdown: renderPostmortemMarkdown(draft) }),
          }),
        })
        yield* Effect.annotateCurrentSpan({
          "incident.investigation.id": draft.investigationId,
          "incident.postmortem.decision": decision,
          ...(published === undefined ? {} : { "incident.index.version": published.indexVersion }),
        })
        return reviewed
      }, lock.withPermits(1))

      return Postmortems.of({ generate, get, edit, review })
    })

  /** `POSTMORTEM_CORPUS_DIR`, default `infra/.api-state/corpus` (git-ignored). */
  static readonly layer = Layer.effect(
    Postmortems,
    Config.String("POSTMORTEM_CORPUS_DIR").pipe(
      Config.withDefault(defaultCorpusDir),
      Effect.flatMap((corpusDir) => Postmortems.make({ corpusDir })),
    ),
  )
}
