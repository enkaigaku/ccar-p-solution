import { Context, DateTime, Duration, Effect, Layer, Option, type Redacted, Semaphore } from "effect"
import { OidcClient, OidcConfig } from "./OidcClient.ts"
import { SESSION_TTL, Sessions } from "./Sessions.ts"

export const SESSION_COOKIE = "incident_session"

/** Tokens are refreshed this long before they expire, so a request never carries one that is about to lapse. */
const REFRESH_MARGIN = Duration.seconds(30)

/** The session id from the `Cookie` header, if any. */
export const sessionIdFrom = (request: Request): string | undefined => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=")
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim()
  }
  return undefined
}

/**
 * Only same-site paths are accepted as the page to return to after login; anything else (absolute URLs,
 * `//host`, backslashes) becomes `/`, so the login flow cannot be used as an open redirect.
 */
export const safeReturnTo = (value: string | null): string =>
  value !== null && /^\/(?![/\\])[^\\\r\n]*$/.test(value) && !value.startsWith("/auth/") ? value : "/"

const redirect = (location: string, cookie?: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", ...(cookie === undefined ? {} : { "set-cookie": cookie }) },
  })

const message = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } })

/**
 * Login for the console (design doc "认证与授权"): the web server is the OIDC client and keeps the tokens;
 * the browser gets an opaque, HttpOnly session cookie; the `/api` proxy swaps the cookie for a bearer token.
 */
export class WebAuth extends Context.Service<
  WebAuth,
  {
    /** False when `OIDC_ISSUER` is unset: no login, and the proxy forwards requests without a token. */
    readonly enabled: boolean
    /** `GET /auth/login?returnTo=/path`: redirects to the provider. */
    login(request: Request): Effect.Effect<Response>
    /** `GET /auth/callback`: finishes the code flow, creates the session and returns to the page. */
    callback(request: Request): Effect.Effect<Response>
    /** `POST /auth/logout`: ends the session here and at the provider. */
    logout(request: Request): Effect.Effect<Response>
    /** A valid access token for the request's session, refreshed if needed. `None`: not signed in. */
    accessToken(request: Request): Effect.Effect<Option.Option<Redacted.Redacted<string>>>
  }
>()("@incident/web/server/auth/WebAuth") {
  static readonly disabled = WebAuth.of({
    enabled: false,
    login: () => Effect.succeed(message(404, "登录未配置（OIDC_ISSUER 未设置）")),
    callback: () => Effect.succeed(message(404, "登录未配置（OIDC_ISSUER 未设置）")),
    logout: () => Effect.succeed(redirect("/")),
    accessToken: () => Effect.succeed(Option.none()),
  })

  static readonly make = Effect.fnUntraced(function* (origin: string) {
    const oidc = yield* OidcClient
    const sessions = yield* Sessions
    const secure = new URL(origin).protocol === "https:"
    const cookie = (value: string, maxAgeSeconds: number) =>
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`
    const clearCookie = cookie("", 0)
    // One refresh at a time: parallel requests of a page would otherwise all redeem the same refresh token.
    const refreshing = yield* Semaphore.make(1)

    const refreshed = (sessionId: string) =>
      Effect.gen(function* () {
        // Re-read inside the lock: another request may have refreshed while this one waited.
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return Option.none<Redacted.Redacted<string>>()
        const { tokens } = session.value
        const now = yield* DateTime.now
        if (DateTime.isLessThan(DateTime.addDuration(now, REFRESH_MARGIN), tokens.expiresAt)) {
          return Option.some(tokens.accessToken)
        }
        if (tokens.refreshToken === undefined) {
          yield* sessions.remove(sessionId)
          return Option.none<Redacted.Redacted<string>>()
        }
        return yield* oidc.refresh(tokens.refreshToken).pipe(
          Effect.tap((next) => sessions.setTokens(sessionId, next)),
          Effect.map((next) => Option.some(next.accessToken)),
          // A refused refresh (revoked, expired, user disabled) ends the session.
          Effect.catch((error) =>
            Effect.logInfo(`Session ended: token refresh failed (${error.message})`).pipe(
              Effect.andThen(sessions.remove(sessionId)),
              Effect.as(Option.none<Redacted.Redacted<string>>()),
            ),
          ),
        )
      })

    return WebAuth.of({
      enabled: true,
      login: Effect.fn("WebAuth.login")(function* (request) {
        const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"))
        return yield* oidc.beginLogin().pipe(
          Effect.tap(({ pending }) => sessions.rememberLogin(pending, returnTo)),
          Effect.map(({ url }) => redirect(url.href)),
          Effect.catch((error) =>
            Effect.logWarning(`Login unavailable: ${error.step} failed (${error.message})`).pipe(
              Effect.as(message(502, "无法连接身份提供方，请稍后重试")),
            ),
          ),
        )
      }),
      callback: Effect.fn("WebAuth.callback")(function* (request) {
        const url = new URL(request.url)
        const pending = yield* sessions.takeLogin(url.searchParams.get("state") ?? "")
        // Unknown, expired or already used state: start over instead of trusting the callback.
        if (Option.isNone(pending)) return redirect("/auth/login")
        return yield* oidc.exchange(url, pending.value).pipe(
          Effect.flatMap((tokens) => sessions.create(tokens)),
          Effect.map((session) =>
            redirect(pending.value.returnTo, cookie(session.id, Duration.toSeconds(SESSION_TTL))),
          ),
          Effect.catch((error) =>
            Effect.logWarning(`Login failed: ${error.step} (${error.message})`).pipe(
              Effect.as(message(401, "登录失败，请重新登录")),
            ),
          ),
        )
      }),
      logout: Effect.fn("WebAuth.logout")(function* (request) {
        const id = sessionIdFrom(request)
        const session = id === undefined ? Option.none() : yield* sessions.remove(id)
        const idToken = Option.isSome(session) ? session.value.tokens.idToken : undefined
        const url = yield* oidc.endSessionUrl(idToken)
        return redirect(url.href, clearCookie)
      }),
      accessToken: (request) => {
        const id = sessionIdFrom(request)
        return id === undefined ? Effect.succeed(Option.none()) : refreshing.withPermits(1)(refreshed(id))
      },
    })
  })

  /** Login when `OIDC_ISSUER` is set, otherwise `disabled`. */
  static readonly layer = Layer.effect(
    WebAuth,
    Effect.gen(function* () {
      const client = yield* OidcClient.fromEnv
      if (Option.isNone(client)) return WebAuth.disabled
      const { origin } = yield* OidcConfig
      return yield* WebAuth.make(origin).pipe(Effect.provideService(OidcClient, client.value))
    }),
  ).pipe(Layer.provide(Sessions.layer))
}
