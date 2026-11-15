import { Context, DateTime, Duration, Effect, Layer, Option, type Redacted, Semaphore } from "effect"
import { OidcClient, OidcConfig } from "./OidcClient.ts"
import { LOGIN_TTL, SESSION_TTL, Sessions } from "./Sessions.ts"

export const SESSION_COOKIE = "incident_session"
/**
 * Ties a login to the browser that started it. Without it, a callback URL obtained in one browser could be
 * opened in another, which would then be signed in as someone else (login CSRF).
 */
export const LOGIN_COOKIE = "incident_login"

/** Tokens are refreshed this long before they expire, so a request never carries one that is about to lapse. */
const REFRESH_MARGIN = Duration.seconds(30)

const cookieFrom = (request: Request, name: string): string | undefined => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=")
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

/** The session id from the `Cookie` header, if any. */
export const sessionIdFrom = (request: Request): string | undefined => cookieFrom(request, SESSION_COOKIE)

/** Only used to resolve a path the way a browser would; never appears in a response. */
const RETURN_BASE = "http://console.invalid"

/** C0 controls, DEL and backslash: browsers drop or rewrite these while parsing a URL, so they are refused outright. */
const hasUnsafeCharacter = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}

/**
 * Only same-site paths are accepted as the page to return to after login; anything else becomes `/`, so the
 * login flow cannot be used as an open redirect. The value is resolved like a browser would resolve the
 * `Location` header and the normalized path is returned, so what is checked is what the browser will follow.
 */
export const safeReturnTo = (value: string | null): string => {
  if (value === null || !value.startsWith("/") || hasUnsafeCharacter(value)) return "/"
  if (!URL.canParse(value, RETURN_BASE)) return "/"
  const url = new URL(value, RETURN_BASE)
  if (url.origin !== RETURN_BASE) return "/"
  const path = `${url.pathname}${url.search}${url.hash}`
  return path.startsWith("//") || path.startsWith("/auth/") ? "/" : path
}

const redirect = (location: string, ...cookies: ReadonlyArray<string>): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" })
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  return new Response(null, { status: 303, headers })
}

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
    // Scoped to `/auth`: only the callback needs it. Lax, so it is sent on the provider's redirect back.
    const loginCookie = (value: string, maxAgeSeconds: number) =>
      `${LOGIN_COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`
    const clearLoginCookie = loginCookie("", 0)
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
          Effect.map(({ url, pending }) =>
            redirect(url.href, loginCookie(pending.state, Duration.toSeconds(LOGIN_TTL))),
          ),
          Effect.catch((error) =>
            Effect.logWarning(`Login unavailable: ${error.step} failed (${error.message})`).pipe(
              Effect.as(message(502, "无法连接身份提供方，请稍后重试")),
            ),
          ),
        )
      }),
      callback: Effect.fn("WebAuth.callback")(function* (request) {
        const url = new URL(request.url)
        const state = url.searchParams.get("state") ?? ""
        // The callback must arrive in the browser that started this login; checked before the pending login
        // is consumed, so a callback opened elsewhere neither signs that browser in nor cancels the login.
        if (state === "" || cookieFrom(request, LOGIN_COOKIE) !== state) return redirect("/auth/login")
        const pending = yield* sessions.takeLogin(state)
        // Unknown, expired or already used state: start over instead of trusting the callback.
        if (Option.isNone(pending)) return redirect("/auth/login", clearLoginCookie)
        return yield* oidc.exchange(url, pending.value).pipe(
          Effect.flatMap((tokens) => sessions.create(tokens)),
          Effect.map((session) =>
            redirect(pending.value.returnTo, cookie(session.id, Duration.toSeconds(SESSION_TTL)), clearLoginCookie),
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
