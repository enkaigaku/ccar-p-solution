import { Config, Context, DateTime, Duration, Effect, Option, Redacted, Schema } from "effect"
import * as oidc from "openid-client"

/** The login or token exchange failed. The message never contains tokens, codes or the client secret. */
export class OidcError extends Schema.TaggedError<OidcError>()("OidcError", {
  step: Schema.Literals(["discovery", "exchange", "refresh"]),
  message: Schema.String,
}) {}

export interface Tokens {
  readonly accessToken: Redacted.Redacted<string>
  readonly refreshToken: Redacted.Redacted<string> | undefined
  /** Only kept as the `id_token_hint` for logout. */
  readonly idToken: Redacted.Redacted<string> | undefined
  readonly expiresAt: DateTime.Utc
}

/** What must be remembered between the redirect to the provider and its callback. */
export interface PendingLogin {
  readonly state: string
  readonly codeVerifier: Redacted.Redacted<string>
}

export const OidcConfig = Config.all({
  /** Unset means the console runs without login (the api then has to run with `AUTH_MODE=dev`). */
  issuer: Config.option(Config.String("OIDC_ISSUER")),
  clientId: Config.String("OIDC_CLIENT_ID").pipe(Config.withDefault("incident-web")),
  clientSecret: Config.option(Config.Redacted("OIDC_CLIENT_SECRET")),
  /**
   * The console's public origin. Redirect URIs are built from this, never from the request's Host header,
   * which the client controls.
   */
  origin: Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3001")),
})

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

// openid-client errors carry an OAuth error code or a short reason, not the request or response bodies.
const reason = (cause: unknown): string => {
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") return cause.code
  return cause instanceof Error ? cause.name : "unknown error"
}

const toTokens = (response: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>, now: DateTime.Utc): Tokens => ({
  accessToken: Redacted.make(response.access_token),
  refreshToken: response.refresh_token === undefined ? undefined : Redacted.make(response.refresh_token),
  idToken: response.id_token === undefined ? undefined : Redacted.make(response.id_token),
  // A provider that omits expires_in gets a short lifetime, so the token is refreshed rather than trusted forever.
  expiresAt: DateTime.addDuration(now, Duration.seconds(response.expiresIn() ?? 60)),
})

/**
 * The console as an OIDC relying party (authorization code flow with PKCE), a thin Effect wrapper around
 * `openid-client`. The web server is a confidential client: tokens stay on the server, the browser only
 * holds an opaque session cookie.
 */
export class OidcClient extends Context.Service<
  OidcClient,
  {
    readonly redirectUri: string
    /** Where to send the browser to sign in, and what to remember until it comes back. */
    beginLogin(): Effect.Effect<{ readonly url: URL; readonly pending: PendingLogin }, OidcError>
    /** Exchanges the callback's authorization code; fails when `state` or the PKCE verifier do not match. */
    exchange(callbackUrl: URL, pending: PendingLogin): Effect.Effect<Tokens, OidcError>
    refresh(refreshToken: Redacted.Redacted<string>): Effect.Effect<Tokens, OidcError>
    /** The provider's logout URL, or the console's own origin when the provider has no end-session endpoint. */
    endSessionUrl(idToken: Redacted.Redacted<string> | undefined): Effect.Effect<URL>
  }
>()("@incident/web/server/auth/OidcClient") {
  static readonly make = Effect.fnUntraced(function* (settings: {
    readonly issuer: string
    readonly clientId: string
    readonly clientSecret: Option.Option<Redacted.Redacted<string>>
    readonly origin: string
  }) {
    const issuer = new URL(settings.issuer)
    const redirectUri = new URL("/auth/callback", settings.origin).href
    // Discovery runs on first use and is retried after a failure, so the console starts before the provider does.
    const discover = Effect.tryPromise({
      try: () =>
        oidc.discovery(
          issuer,
          settings.clientId,
          undefined,
          Option.match(settings.clientSecret, {
            onNone: () => oidc.None(),
            onSome: (secret) => oidc.ClientSecretPost(Redacted.value(secret)),
          }),
          // Plain http is accepted only for a provider on this machine (local Keycloak).
          issuer.protocol === "http:" && LOOPBACK.has(issuer.hostname) ? { execute: [oidc.allowInsecureRequests] } : {},
        ),
      catch: (cause) => new OidcError({ step: "discovery", message: reason(cause) }),
    })
    const configuration = yield* Effect.cachedInvalidateWithTTL(discover, Duration.hours(1)).pipe(
      Effect.map(([cached, invalidate]) => cached.pipe(Effect.tapError(() => invalidate))),
    )

    return OidcClient.of({
      redirectUri,
      beginLogin: Effect.fn("OidcClient.beginLogin")(function* () {
        const config = yield* configuration
        const state = oidc.randomState()
        const codeVerifier = oidc.randomPKCECodeVerifier()
        const codeChallenge = yield* Effect.promise(() => oidc.calculatePKCECodeChallenge(codeVerifier))
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri,
          scope: "openid profile",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
        })
        return { url, pending: { state, codeVerifier: Redacted.make(codeVerifier) } }
      }),
      exchange: Effect.fn("OidcClient.exchange")(function* (callbackUrl, pending) {
        const config = yield* configuration
        // The provider compares redirect_uri with the one from the authorization request, so rebuild the
        // callback URL on the configured origin instead of whatever host the request arrived on.
        const current = new URL(redirectUri)
        current.search = callbackUrl.search
        const now = yield* DateTime.now
        const response = yield* Effect.tryPromise({
          try: () =>
            oidc.authorizationCodeGrant(config, current, {
              pkceCodeVerifier: Redacted.value(pending.codeVerifier),
              expectedState: pending.state,
            }),
          catch: (cause) => new OidcError({ step: "exchange", message: reason(cause) }),
        })
        return toTokens(response, now)
      }),
      refresh: Effect.fn("OidcClient.refresh")(function* (refreshToken) {
        const config = yield* configuration
        const now = yield* DateTime.now
        const response = yield* Effect.tryPromise({
          try: () => oidc.refreshTokenGrant(config, Redacted.value(refreshToken)),
          catch: (cause) => new OidcError({ step: "refresh", message: reason(cause) }),
        })
        const tokens = toTokens(response, now)
        // Providers without refresh token rotation do not send a new one: keep using the old.
        return tokens.refreshToken === undefined ? { ...tokens, refreshToken } : tokens
      }),
      endSessionUrl: (idToken) =>
        configuration.pipe(
          Effect.flatMap((config) =>
            Effect.try(() =>
              oidc.buildEndSessionUrl(config, {
                post_logout_redirect_uri: new URL("/", settings.origin).href,
                ...(idToken === undefined
                  ? { client_id: settings.clientId }
                  : { id_token_hint: Redacted.value(idToken) }),
              }),
            ),
          ),
          Effect.orElseSucceed(() => new URL("/", settings.origin)),
        ),
    })
  })

  /** `None` when `OIDC_ISSUER` is unset: the console then has no login and the proxy adds no token. */
  static readonly fromEnv: Effect.Effect<Option.Option<OidcClient["Service"]>, Config.ConfigError> = Effect.gen(
    function* () {
      const config = yield* OidcConfig
      if (Option.isNone(config.issuer)) {
        yield* Effect.logWarning(
          "OIDC_ISSUER is not set: the console has no login and forwards requests without a token",
        )
        return Option.none()
      }
      return Option.some(yield* OidcClient.make({ ...config, issuer: config.issuer.value }))
    },
  )
}
