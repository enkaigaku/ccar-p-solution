import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { Alert, AlertId, AlertmanagerWebhook } from "../domain/Alert.ts"
import { ActionProposal, Decision, ProposalId } from "../domain/Approval.ts"
import { Principal } from "../domain/Auth.ts"
import { Feedback, Investigation, InvestigationId } from "../domain/Investigation.ts"
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
  )
  .middleware(Authentication)
  .prefix("/investigations") {}

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
  .annotateMerge(OpenApi.annotations({ title: "Incident Copilot API" })) {}
