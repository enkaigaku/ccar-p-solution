import { Principal, Role, Unauthorized } from "@incident/contracts"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose"

/** Signature algorithms accepted for access tokens. Symmetric ones (HS*) and `none` are never accepted. */
const ALGORITHMS = ["RS256", "PS256", "ES256"]

const UNAUTHORIZED = new Unauthorized({ message: "Missing, invalid or expired access token" })

/** The claims the api reads from a verified access token. Everything else is ignored. */
const Claims = Schema.Struct({
  sub: Schema.NonEmptyString,
  preferred_username: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
})
const decodeClaims = Schema.decodeUnknownEffect(Claims)
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/** Reads a dotted claim path such as `realm_access.roles` (Keycloak realm roles). */
const claimAt = (payload: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), payload)

/** Console roles among the token's roles. Other roles of the identity provider (`offline_access`, …) are dropped. */
export const rolesFrom = (payload: unknown, path: string): ReadonlyArray<Role> => {
  const value: unknown = claimAt(payload, path)
  if (!Array.isArray(value)) return []
  const granted = new Set<unknown>(value)
  return Role.literals.filter((role) => granted.has(role))
}

export interface OidcSettings {
  readonly issuer: string
  /** The `aud` an access token must carry. Tokens for other audiences, such as ID tokens, are refused. */
  readonly audience: string
  readonly rolesClaim: string
  /** Resolves the signing key for a token; `createRemoteJWKSet` in production, a local key set in tests. */
  readonly keys: JWTVerifyGetKey
}

/**
 * Turns a bearer credential into a `Principal`. The api is an OAuth resource server: it never sees passwords
 * or the login flow, only access tokens issued by the OIDC provider to the web console.
 */
export class TokenVerifier extends Context.Service<
  TokenVerifier,
  {
    verify(token: Redacted.Redacted<string>): Effect.Effect<Principal, Unauthorized>
  }
>()("@incident/api/auth/TokenVerifier") {
  /** Verifies signature, algorithm, issuer, audience and expiry, then maps the claims to a `Principal`. */
  static readonly makeOidc = (settings: OidcSettings) =>
    TokenVerifier.of({
      verify: Effect.fn("TokenVerifier.verify")(function* (token) {
        const jwt = Redacted.value(token)
        if (jwt === "") return yield* UNAUTHORIZED
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(jwt, settings.keys, {
              issuer: settings.issuer,
              audience: settings.audience,
              algorithms: ALGORITHMS,
              requiredClaims: ["exp", "sub"],
            }),
          // jose's error codes (ERR_JWT_EXPIRED, …) describe the failure without containing the token.
          catch: (cause) => (cause instanceof Error && "code" in cause ? String(cause.code) : "ERR_UNKNOWN"),
        }).pipe(
          Effect.tapError((code) => Effect.logDebug(`Access token refused: ${code}`)),
          Effect.mapError(() => UNAUTHORIZED),
        )
        const claims = yield* decodeClaims(payload).pipe(Effect.mapError(() => UNAUTHORIZED))
        return new Principal({
          subject: claims.sub,
          name: [claims.preferred_username, claims.name].find((v) => v !== undefined && v !== "") ?? claims.sub,
          roles: rolesFrom(payload, settings.rolesClaim),
        })
      }),
    })

  /** Accepts every request as `principal`, whatever the credential. Development and evaluation runs only. */
  static readonly makeUnauthenticated = (principal: Principal) =>
    TokenVerifier.of({ verify: () => Effect.succeed(principal) })

  /**
   * `OIDC_ISSUER` set: verify access tokens of that issuer (`OIDC_AUDIENCE`, default `incident-api`; signing keys
   * from `OIDC_JWKS_URL`, default Keycloak's `<issuer>/protocol/openid-connect/certs`; roles from
   * `OIDC_ROLES_CLAIM`, default `realm_access.roles`).
   *
   * Otherwise the api refuses to start unless `AUTH_MODE=dev` is set explicitly; then every request is the
   * `APPROVER_ID` operator with all roles. There is no silent fallback to "no authentication", and setting
   * both `AUTH_MODE=dev` and `OIDC_ISSUER` is an error.
   */
  static readonly layer = Layer.effect(
    TokenVerifier,
    Effect.gen(function* () {
      const issuer = yield* Config.option(Config.String("OIDC_ISSUER"))
      const mode = yield* Config.option(Config.Literals(["oidc", "dev"], "AUTH_MODE"))
      if (Option.isSome(mode) && mode.value === "dev") {
        // Never guess which one was meant: a deployment with an issuer must not lose authentication to a stray flag.
        if (Option.isSome(issuer)) {
          return yield* new AuthNotConfigured({
            message: "AUTH_MODE=dev and OIDC_ISSUER are both set; unset one of them",
          })
        }
        const operator = yield* Config.String("APPROVER_ID").pipe(Config.withDefault("console-operator"))
        yield* Effect.logWarning(
          `AUTH_MODE=dev: requests are NOT authenticated; every caller acts as "${operator}" with all roles`,
        )
        return TokenVerifier.makeUnauthenticated(
          new Principal({ subject: operator, name: operator, roles: ["viewer", "responder", "approver"] }),
        )
      }
      if (Option.isNone(issuer)) {
        return yield* new AuthNotConfigured({
          message: "Set OIDC_ISSUER to verify access tokens, or AUTH_MODE=dev to run without authentication",
        })
      }
      const base = issuer.value.replace(/\/$/, "")
      const jwksUrl = yield* Config.String("OIDC_JWKS_URL").pipe(
        Config.withDefault(`${base}/protocol/openid-connect/certs`),
      )
      const audience = yield* Config.String("OIDC_AUDIENCE").pipe(Config.withDefault("incident-api"))
      const rolesClaim = yield* Config.String("OIDC_ROLES_CLAIM").pipe(Config.withDefault("realm_access.roles"))
      yield* Effect.logInfo(`Verifying access tokens issued by ${issuer.value} for audience ${audience}`)
      return TokenVerifier.makeOidc({
        issuer: issuer.value,
        audience,
        rolesClaim,
        // Fetched on first use and cached; refetched (rate limited) when a token names an unknown key id.
        keys: createRemoteJWKSet(new URL(jwksUrl)),
      })
    }),
  )
}

export class AuthNotConfigured extends Schema.TaggedError<AuthNotConfigured>()("AuthNotConfigured", {
  message: Schema.String,
}) {}
