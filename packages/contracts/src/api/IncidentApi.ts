import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { Alert, AlertId, AlertmanagerWebhook } from "../domain/Alert.ts"
import { ActionProposal, Decision, ProposalId } from "../domain/Approval.ts"
import { Principal } from "../domain/Auth.ts"
import { FeedbackRecord } from "../domain/Feedback.ts"
import { Feedback, Investigation, InvestigationId, InvestigationStatus } from "../domain/Investigation.ts"
import { PostmortemBody, PostmortemDecision, PostmortemDraft, PostmortemId } from "../domain/Postmortem.ts"
import { Authentication, Forbidden } from "./Authentication.ts"

export class InvestigationNotFound extends Schema.TaggedError<InvestigationNotFound>()(
  "InvestigationNotFound",
  { id: InvestigationId },
  { httpApiStatus: 404 },
) {}

export class AlertNotFound extends Schema.TaggedError<AlertNotFound>()(
  "AlertNotFound",
  { id: AlertId },
  { httpApiStatus: 404 },
) {}

export class ProposalNotFound extends Schema.TaggedError<ProposalNotFound>()(
  "ProposalNotFound",
  { id: ProposalId },
  { httpApiStatus: 404 },
) {}

export class ProposalNotPending extends Schema.TaggedError<ProposalNotPending>()(
  "ProposalNotPending",
  { id: ProposalId, status: Schema.String },
  { httpApiStatus: 409 },
) {}

export class PostmortemNotFound extends Schema.TaggedError<PostmortemNotFound>()(
  "PostmortemNotFound",
  { investigationId: Schema.optionalKey(InvestigationId), id: Schema.optionalKey(PostmortemId) },
  { httpApiStatus: 404 },
) {}

/** A postmortem can only be written for an investigation that has finished with a report. */
export class InvestigationNotFinished extends Schema.TaggedError<InvestigationNotFinished>()(
  "InvestigationNotFinished",
  { id: InvestigationId, status: InvestigationStatus },
  { httpApiStatus: 409 },
) {}

/** Only a `draft` can be regenerated, edited or reviewed. */
export class PostmortemNotDraft extends Schema.TaggedError<PostmortemNotDraft>()(
  "PostmortemNotDraft",
  { id: PostmortemId, status: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * The model could not write the draft, or the knowledge base could not take it. `reason` is a fixed word and
 * `message` is written by the api; neither carries model output, prompt text or upstream error bodies.
 */
export class PostmortemUnavailable extends Schema.TaggedError<PostmortemUnavailable>()(
  "PostmortemUnavailable",
  { reason: Schema.Literals(["model", "refusal", "max_tokens", "output", "ingest"]), message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
) {}

/** Who the caller is, so the console can show the signed-in user and hide actions their roles do not allow. */
export class SessionApi extends HttpApiGroup.make("session")
  .add(HttpApiEndpoint.get("current", "/", { success: Principal }))
  .middleware(Authentication)
  .prefix("/session") {}

export class AlertsApi extends HttpApiGroup.make("alerts")
  .add(
    // Called by Alertmanager / Grafana, not by a console user, so it is outside `Authentication`.
    HttpApiEndpoint.post("webhook", "/webhook", {
      payload: AlertmanagerWebhook,
      success: Schema.Struct({ accepted: Schema.Array(AlertId) }),
    }),
    // viewer
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Alert), error: Forbidden }).middleware(Authentication),
  )
  .prefix("/alerts") {}

export class InvestigationsApi extends HttpApiGroup.make("investigations")
  .add(
    // responder
    HttpApiEndpoint.post("start", "/", {
      payload: Schema.Struct({ alertId: AlertId }),
      success: Investigation,
      error: [AlertNotFound, Forbidden],
    }),
    // viewer
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: InvestigationId },
      success: Investigation,
      error: [InvestigationNotFound, Forbidden],
    }),
    // viewer
    HttpApiEndpoint.get("proposals", "/:id/proposals", {
      params: { id: InvestigationId },
      success: Schema.Array(ActionProposal),
      error: [InvestigationNotFound, Forbidden],
    }),
    // responder
    HttpApiEndpoint.post("feedback", "/:id/feedback", {
      params: { id: InvestigationId },
      payload: Feedback,
      success: HttpApiSchema.NoContent,
      error: [InvestigationNotFound, Forbidden],
    }),
    // responder: asks the model for a postmortem draft; replaces an existing draft, never a reviewed one
    HttpApiEndpoint.post("generatePostmortem", "/:id/postmortem", {
      params: { id: InvestigationId },
      success: PostmortemDraft,
      error: [InvestigationNotFound, InvestigationNotFinished, PostmortemNotDraft, PostmortemUnavailable, Forbidden],
    }),
    // viewer
    HttpApiEndpoint.get("postmortem", "/:id/postmortem", {
      params: { id: InvestigationId },
      success: PostmortemDraft,
      error: [InvestigationNotFound, PostmortemNotFound, Forbidden],
    }),
  )
  .middleware(Authentication)
  .prefix("/investigations") {}

export class PostmortemsApi extends HttpApiGroup.make("postmortems")
  .add(
    // responder: a person corrects the model's text before review
    HttpApiEndpoint.put("edit", "/:id", {
      params: { id: PostmortemId },
      payload: PostmortemBody,
      success: PostmortemDraft,
      error: [PostmortemNotFound, PostmortemNotDraft, Forbidden],
    }),
    // approver: the only way a postmortem reaches the knowledge base the agent retrieves from
    HttpApiEndpoint.post("review", "/:id/review", {
      params: { id: PostmortemId },
      payload: Schema.Struct({ decision: PostmortemDecision }),
      success: PostmortemDraft,
      error: [PostmortemNotFound, PostmortemNotDraft, PostmortemUnavailable, Forbidden],
    }),
  )
  .middleware(Authentication)
  .prefix("/postmortems") {}

export class FeedbackApi extends HttpApiGroup.make("feedback")
  .add(
    // viewer: stored feedback, newest first, for curating evaluation cases
    HttpApiEndpoint.get("list", "/", {
      query: {
        /** `true`: only records that carry an actual root cause. */
        hasRootCause: Schema.optionalKey(Schema.Literals(["true", "false"])),
        /** Only records created at or after this instant. */
        since: Schema.optionalKey(Schema.DateTimeUtcFromString),
      },
      success: Schema.Array(FeedbackRecord),
      error: Forbidden,
    }),
  )
  .middleware(Authentication)
  .prefix("/feedback") {}

export class ProposalsApi extends HttpApiGroup.make("proposals")
  .add(
    // approver: the only endpoint that can lead to a write action
    HttpApiEndpoint.post("decide", "/:id/decision", {
      params: { id: ProposalId },
      payload: Schema.Struct({ decision: Decision, comment: Schema.optionalKey(Schema.String) }),
      success: ActionProposal,
      error: [ProposalNotFound, ProposalNotPending, Forbidden],
    }),
  )
  .middleware(Authentication)
  .prefix("/proposals") {}

/**
 * The HTTP contract between `apps/api` (implements) and `apps/web` (derives a client with `HttpApiClient`).
 *
 * The SSE stream `GET /investigations/:id/events` is served as a raw route next to this API,
 * because it is a stream rather than a request/response; its payloads are `InvestigationEvent`.
 * It takes the same bearer token and requires `viewer`.
 *
 * Roles are noted on each endpoint; handlers enforce them with `requireRole`.
 */
export class IncidentApi extends HttpApi.make("incident-api")
  .add(SystemApi)
  .add(SessionApi)
  .add(AlertsApi)
  .add(InvestigationsApi)
  .add(ProposalsApi)
  .add(PostmortemsApi)
  .add(FeedbackApi)
  .annotateMerge(OpenApi.annotations({ title: "Incident Copilot API" })) {}
