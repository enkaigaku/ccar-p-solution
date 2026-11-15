import { Context, Schema } from "effect"

/**
 * Console roles (design doc "认证与授权"). Each endpoint requires exactly one role; the identity provider
 * expresses the hierarchy by granting the lower roles together with the higher one.
 *
 * - `viewer`: read alerts, investigations and proposals
 * - `responder`: start investigations and give feedback
 * - `approver`: approve or reject proposed write actions
 */
export const Role = Schema.Literals(["viewer", "responder", "approver"])
export type Role = typeof Role.Type

/** The authenticated caller of one request, as established by the `Authentication` middleware. */
export class Principal extends Schema.Class<Principal>("@incident/contracts/Principal")({
  /** Stable identifier from the identity provider (the OIDC `sub` claim). Recorded in approval tokens and audit. */
  subject: Schema.NonEmptyString,
  /** Human-readable name for the console and for `ActionProposal.decidedBy`. */
  name: Schema.NonEmptyString,
  roles: Schema.Array(Role),
}) {}

/** Provided to handlers by the `Authentication` middleware. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "@incident/contracts/CurrentPrincipal",
) {}
