import { Effect, Layer, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { CurrentPrincipal, type Principal, Role } from "../domain/Auth.ts"

/** No valid credential. The message never says why a token was refused. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** Authenticated, but the caller lacks the role the endpoint requires. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { required: Role },
  { httpApiStatus: 403 },
) {}

/**
 * Bearer authentication for the console endpoints: an OAuth 2.1 access token issued by the OIDC provider.
 * The api implements it (signature, issuer, audience, expiry, role claims); the web server attaches the
 * signed-in user's token when it proxies a request, so the browser never holds one.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal; requires: never }
>()("@incident/contracts/Authentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {
  /**
   * Ignores the credential and treats every request as `principal`. For tests and for running the api without
   * an identity provider; never a production layer.
   */
  static readonly layerStub = (principal: Principal) =>
    Layer.succeed(
      Authentication,
      Authentication.of({
        bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentPrincipal, principal),
      }),
    )
}

/** Fails with `Forbidden` unless the current principal holds `role`; returns the principal otherwise. */
export const requireRole = Effect.fnUntraced(function* (role: Role) {
  const principal = yield* CurrentPrincipal
  if (!principal.roles.includes(role)) return yield* new Forbidden({ required: role })
  return principal
})
