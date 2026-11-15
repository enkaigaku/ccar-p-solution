import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Layer, Option, Redacted, Ref } from "effect"
import { TestClock } from "effect/testing"
import { isCrossSiteWrite, proxyWithSession } from "../src/server/apiProxy.ts"
import { OidcClient, OidcError, type Tokens } from "../src/server/auth/OidcClient.ts"
import { Sessions } from "../src/server/auth/Sessions.ts"
import { LOGIN_COOKIE, SESSION_COOKIE, safeReturnTo, sessionIdFrom, WebAuth } from "../src/server/auth/WebAuth.ts"

const ORIGIN = "http://localhost:3001"

/** A provider that issues `access-N` tokens valid for five minutes and counts what it was asked to do. */
const fakeProvider = Effect.gen(function* () {
  const issued = yield* Ref.make(0)
  const refreshes = yield* Ref.make(0)
  const refreshWorks = yield* Ref.make(true)
  const tokens = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(issued, (x) => x + 1)
    return {
      accessToken: Redacted.make(`access-${n}`),
      refreshToken: Redacted.make(`refresh-${n}`),
      idToken: Redacted.make("id-token"),
      expiresAt: DateTime.addDuration(yield* DateTime.now, Duration.minutes(5)),
    } satisfies Tokens
  })
  const client = OidcClient.of({
    redirectUri: `${ORIGIN}/auth/callback`,
    beginLogin: () =>
      Effect.succeed({
        url: new URL("http://idp.test/authorize?state=state-1"),
        pending: { state: "state-1", codeVerifier: Redacted.make("verifier-1") },
      }),
    exchange: (url, pending) =>
      url.searchParams.get("code") === "good" && Redacted.value(pending.codeVerifier) === "verifier-1"
        ? tokens
        : Effect.fail(new OidcError({ step: "exchange", message: "invalid_grant" })),
    refresh: () =>
      Effect.gen(function* () {
        yield* Ref.update(refreshes, (x) => x + 1)
        if (!(yield* Ref.get(refreshWorks))) return yield* new OidcError({ step: "refresh", message: "invalid_grant" })
        return yield* tokens
      }),
    endSessionUrl: (idToken) =>
      Effect.succeed(new URL(`http://idp.test/logout?hint=${idToken === undefined ? "none" : "id-token"}`)),
  })
  const auth = yield* WebAuth.make(ORIGIN).pipe(
    Effect.provideService(OidcClient, client),
    Effect.provide(Sessions.layer),
  )
  return { auth, refreshes: Ref.get(refreshes), breakRefresh: Ref.set(refreshWorks, false) }
})

const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } })

/** Runs the login flow and returns the `name=value` pair of the session cookie. */
const signIn = (auth: WebAuth["Service"], returnTo = "/investigations/inv-1") =>
  Effect.gen(function* () {
    const login = yield* auth.login(get(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`))
    assert.strictEqual(login.status, 303)
    assert.strictEqual(login.headers.get("location"), "http://idp.test/authorize?state=state-1")
    const callback = yield* auth.callback(get("/auth/callback?code=good&state=state-1", LOGIN))
    return { callback, cookie: (sessionCookie(callback) ?? "").split(";")[0] ?? "" }
  })

/** The login cookie a browser holds after `/auth/login` with the fake provider. */
const LOGIN = `${LOGIN_COOKIE}=state-1`

const sessionCookie = (response: Response): string | undefined =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))

const tokenOf = (auth: WebAuth["Service"], cookie: string) =>
  auth
    .accessToken(get("/api/alerts", cookie))
    .pipe(Effect.map(Option.map(Redacted.value)), Effect.map(Option.getOrNull))

describe("WebAuth", () => {
  it.effect("signs in with the code flow, sets a hardened cookie and returns to the requested page", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      const { callback, cookie } = yield* signIn(auth)
      assert.strictEqual(callback.status, 303)
      assert.strictEqual(callback.headers.get("location"), "/investigations/inv-1")
      const setCookie = sessionCookie(callback) ?? ""
      assert.match(
        setCookie,
        new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800$`),
      )
      // The cookie is an opaque id: no token is ever sent to the browser.
      assert.notInclude(setCookie, "access-")
      assert.strictEqual(yield* tokenOf(auth, cookie), "access-1")
    }),
  )

  it.effect("a callback cannot be replayed, and an unknown state or a refused code creates no session", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      yield* signIn(auth)
      const replay = yield* auth.callback(get("/auth/callback?code=good&state=state-1", LOGIN))
      assert.strictEqual(replay.headers.get("location"), "/auth/login")
      assert.isUndefined(sessionCookie(replay))
      const forged = yield* auth.callback(get("/auth/callback?code=good&state=other", `${LOGIN_COOKIE}=other`))
      assert.isUndefined(sessionCookie(forged))

      yield* auth.login(get("/auth/login"))
      const refused = yield* auth.callback(get("/auth/callback?code=bad&state=state-1", LOGIN))
      assert.strictEqual(refused.status, 401)
      assert.isUndefined(sessionCookie(refused))
    }),
  )

  it.effect("a callback only completes in the browser that started the login", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      const login = yield* auth.login(get("/auth/login"))
      assert.strictEqual(
        login.headers.get("set-cookie"),
        `${LOGIN_COOKIE}=state-1; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`,
      )
      // Another browser opens the callback URL: no login cookie, or one from a login of its own.
      for (const cookie of [undefined, `${LOGIN_COOKIE}=state-2`, `${SESSION_COOKIE}=state-1`]) {
        const elsewhere = yield* auth.callback(get("/auth/callback?code=good&state=state-1", cookie))
        assert.strictEqual(elsewhere.headers.get("location"), "/auth/login")
        assert.isUndefined(sessionCookie(elsewhere))
      }
      const empty = yield* auth.callback(get("/auth/callback?code=good", `${LOGIN_COOKIE}=`))
      assert.isUndefined(sessionCookie(empty))
      // The login itself is untouched and still completes where it started, which also clears the cookie.
      const callback = yield* auth.callback(get("/auth/callback?code=good&state=state-1", LOGIN))
      assert.isDefined(sessionCookie(callback))
      assert.include(callback.headers.getSetCookie(), `${LOGIN_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`)
    }),
  )

  it.effect("a login that takes longer than ten minutes is not completed", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      yield* auth.login(get("/auth/login"))
      yield* TestClock.adjust("11 minutes")
      const late = yield* auth.callback(get("/auth/callback?code=good&state=state-1", LOGIN))
      assert.isUndefined(sessionCookie(late))
    }),
  )

  it.effect("refreshes an expiring token once for parallel requests and keeps the session", () =>
    Effect.gen(function* () {
      const { auth, refreshes } = yield* fakeProvider
      const { cookie } = yield* signIn(auth)
      yield* TestClock.adjust("285 seconds")
      const tokens = yield* Effect.all([tokenOf(auth, cookie), tokenOf(auth, cookie), tokenOf(auth, cookie)], {
        concurrency: "unbounded",
      })
      assert.deepStrictEqual(tokens, ["access-2", "access-2", "access-2"])
      assert.strictEqual(yield* refreshes, 1)
    }),
  )

  it.effect("ends the session when the refresh is refused, after eight hours, and on logout", () =>
    Effect.gen(function* () {
      const provider = yield* fakeProvider
      const { cookie } = yield* signIn(provider.auth)
      yield* provider.breakRefresh
      yield* TestClock.adjust("6 minutes")
      assert.isNull(yield* tokenOf(provider.auth, cookie))
      // The session is gone, not just this request: no second refresh attempt.
      assert.isNull(yield* tokenOf(provider.auth, cookie))
      assert.strictEqual(yield* provider.refreshes, 1)

      const second = yield* fakeProvider
      const long = yield* signIn(second.auth)
      yield* TestClock.adjust("481 minutes")
      assert.isNull(yield* tokenOf(second.auth, long.cookie))

      const third = yield* fakeProvider
      const active = yield* signIn(third.auth)
      const logout = yield* third.auth.logout(
        new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie: active.cookie } }),
      )
      assert.strictEqual(logout.headers.get("location"), "http://idp.test/logout?hint=id-token")
      assert.match(logout.headers.get("set-cookie") ?? "", /^incident_session=; .*Max-Age=0/)
      assert.isNull(yield* tokenOf(third.auth, active.cookie))
    }),
  )

  it("accepts only same-site paths as the return target", () => {
    assert.strictEqual(safeReturnTo("/investigations/inv-1?x=1"), "/investigations/inv-1?x=1")
    for (const bad of [
      null,
      "",
      "https://evil.test/",
      "//evil.test",
      "/\\evil.test",
      "javascript:alert(1)",
      "/auth/login",
      "/a\nb",
      // Browsers strip tabs and newlines while parsing, which would turn these into `//evil.test`.
      "/\t/evil.test",
      "/\r/evil.test",
      "/\n/evil.test",
      "/\u0000/evil.test",
      "/ /evil.test",
      // Dot segments that normalize to a protocol-relative URL or to the login routes.
      "/.//evil.test",
      "/x/..//evil.test",
      "/x/../auth/login",
    ]) {
      assert.strictEqual(safeReturnTo(bad), "/", JSON.stringify(bad))
      // Whatever is returned must stay on the console when a browser follows it.
      assert.strictEqual(new URL(safeReturnTo(bad), ORIGIN).origin, ORIGIN)
    }
    assert.strictEqual(safeReturnTo("/a/../investigations/inv-1#top"), "/investigations/inv-1#top")
    assert.strictEqual(safeReturnTo("/?q=%09"), "/?q=%09")
  })

  it("reads the session id from the cookie header", () => {
    assert.strictEqual(sessionIdFrom(get("/", `a=1; ${SESSION_COOKIE}=abc; b=2`)), "abc")
    assert.isUndefined(sessionIdFrom(get("/", `x${SESSION_COOKIE}=abc`)))
    assert.isUndefined(sessionIdFrom(get("/")))
  })
})

describe("api proxy with login", () => {
  const upstream = () => {
    const seen: Array<Headers> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers))
      return Response.json([])
    }
    return { seen, fetchImpl }
  }

  it.effect("answers 401 in the contract's shape without a session and never reaches the api", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      const { seen, fetchImpl } = upstream()
      const response = yield* proxyWithSession(get("/api/alerts"), "http://api:3000", fetchImpl).pipe(
        Effect.provideService(WebAuth, auth),
      )
      assert.strictEqual(response.status, 401)
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        _tag: "Unauthorized",
        message: "Sign in required",
      })
      assert.strictEqual(seen.length, 0)
    }),
  )

  it.effect("forwards the session's access token and drops any credential the browser sent", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      const { cookie } = yield* signIn(auth)
      const { seen, fetchImpl } = upstream()
      const request = new Request(`${ORIGIN}/api/alerts`, { headers: { cookie, authorization: "Bearer forged" } })
      const response = yield* proxyWithSession(request, "http://api:3000", fetchImpl).pipe(
        Effect.provideService(WebAuth, auth),
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual(seen[0]?.get("authorization"), "Bearer access-1")
      assert.isNull(seen[0]?.get("cookie") ?? null)
    }),
  )

  it.effect("refuses state-changing requests from another origin, signed in or not", () =>
    Effect.gen(function* () {
      const { auth } = yield* fakeProvider
      const { cookie } = yield* signIn(auth)
      const { seen, fetchImpl } = upstream()
      const post = (origin: string) =>
        new Request(`${ORIGIN}/api/proposals/p-1/decision`, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        })
      const run = (request: Request) =>
        proxyWithSession(request, "http://api:3000", fetchImpl).pipe(Effect.provideService(WebAuth, auth))
      assert.strictEqual((yield* run(post("https://evil.test"))).status, 403)
      assert.strictEqual(seen.length, 0)
      assert.strictEqual((yield* run(post(ORIGIN))).status, 200)
      assert.isTrue(isCrossSiteWrite(post("null")))
      assert.isFalse(isCrossSiteWrite(get("/api/alerts")))
    }),
  )

  it.effect("without OIDC configured it forwards requests unchanged and adds no credential", () =>
    Effect.gen(function* () {
      const { seen, fetchImpl } = upstream()
      const request = new Request(`${ORIGIN}/api/alerts`, { headers: { authorization: "Bearer forged" } })
      const response = yield* proxyWithSession(request, "http://api:3000", fetchImpl).pipe(
        Effect.provide(Layer.succeed(WebAuth, WebAuth.disabled)),
      )
      assert.strictEqual(response.status, 200)
      assert.isNull(seen[0]?.get("authorization") ?? null)
    }),
  )
})
