import { Config, Effect, ManagedRuntime, Option, Redacted, Schema } from "effect"
import { API_PREFIX } from "../lib/ApiBaseUrl.ts"
import { WebAuth } from "./auth/WebAuth.ts"

/** Where the web server forwards `/api/*`. Server-side only; the browser never sees this origin. */
export const ApiUrl = Config.String("API_URL").pipe(Config.withDefault("http://localhost:3000"))

export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>()("UpstreamUnavailable", {}) {}

/** Hop-by-hop headers plus the ones that must not cross the proxy in either direction. */
const DROPPED_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "cookie",
  // Only the proxy decides which credential the api sees; a browser-supplied one is never forwarded.
  "authorization",
]
// fetch has already decoded the body, so the upstream encoding and length no longer describe it.
const DROPPED_RESPONSE_HEADERS = ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]

const withoutHeaders = (headers: Headers, names: ReadonlyArray<string>): Headers => {
  const copy = new Headers(headers)
  for (const name of names) copy.delete(name)
  return copy
}

/** Maps `https://web/api/investigations/1?x=y` to `${apiUrl}/investigations/1?x=y`. */
export const upstreamUrl = (requestUrl: string, apiUrl: string): URL => {
  const incoming = new URL(requestUrl)
  const path = incoming.pathname.startsWith(API_PREFIX) ? incoming.pathname.slice(API_PREFIX.length) : incoming.pathname
  const target = new URL(apiUrl)
  target.pathname = `${target.pathname.replace(/\/$/, "")}${path === "" ? "/" : path}`
  target.search = incoming.search
  return target
}

const forwardedHeaders = (headers: Headers, accessToken: Redacted.Redacted<string> | undefined): Headers => {
  const forwarded = withoutHeaders(headers, DROPPED_REQUEST_HEADERS)
  if (accessToken !== undefined) forwarded.set("authorization", `Bearer ${Redacted.value(accessToken)}`)
  return forwarded
}

/**
 * Forwards one request to the Incident API and streams the response back unchanged, which keeps SSE
 * (`text/event-stream`) working. Aborting the browser request aborts the upstream one.
 */
export const proxyToApi = (
  request: Request,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  accessToken?: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const hasBody = request.method !== "GET" && request.method !== "HEAD"
    const body = hasBody
      ? yield* Effect.tryPromise({ try: () => request.arrayBuffer(), catch: () => new UpstreamUnavailable() })
      : null
    const upstream = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(upstreamUrl(request.url, apiUrl), {
          method: request.method,
          headers: forwardedHeaders(request.headers, accessToken),
          body,
          signal: request.signal,
          redirect: "manual",
        }),
      catch: () => new UpstreamUnavailable(),
    })
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: withoutHeaders(upstream.headers, DROPPED_RESPONSE_HEADERS),
    })
  }).pipe(
    // Do not echo the upstream address or the fetch error: both describe internal infrastructure.
    Effect.catchTag("UpstreamUnavailable", () =>
      Effect.succeed(
        Response.json({ _tag: "UpstreamUnavailable", message: "Incident API is unreachable" }, { status: 502 }),
      ),
    ),
  )

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

/**
 * A state-changing request must come from the console's own pages. The session cookie is `SameSite=Lax`, which
 * already keeps it off cross-site POSTs; refusing a foreign `Origin` covers browsers and setups where that fails.
 */
export const isCrossSiteWrite = (request: Request): boolean => {
  if (request.method === "GET" || request.method === "HEAD") return false
  const origin = request.headers.get("origin")
  return origin !== null && origin !== new URL(request.url).origin
}

/**
 * The `/api` proxy with login: swaps the session cookie for the user's access token. Without a session it
 * answers 401 in the contract's `Unauthorized` shape, so the typed client sees the same error as from the api.
 */
export const proxyWithSession = (request: Request, apiUrl: string, fetchImpl: typeof fetch = fetch) =>
  Effect.gen(function* () {
    const auth = yield* WebAuth
    if (isCrossSiteWrite(request)) return json(403, { _tag: "CrossSiteRequest", message: "Cross-site request refused" })
    if (!auth.enabled) return yield* proxyToApi(request, apiUrl, fetchImpl)
    const token = yield* auth.accessToken(request)
    if (Option.isNone(token)) return json(401, { _tag: "Unauthorized", message: "Sign in required" })
    return yield* proxyToApi(request, apiUrl, fetchImpl, token.value)
  })

/** Server-side services of the console (login and sessions). One instance per web server process. */
export const serverRuntime = ManagedRuntime.make(WebAuth.layer)

/** Entry point used by the `/api/$` server route. */
export const handleApiRequest = (request: Request): Promise<Response> =>
  serverRuntime.runPromise(
    Effect.gen(function* () {
      const apiUrl = yield* ApiUrl
      return yield* proxyWithSession(request, apiUrl)
    }).pipe(Effect.orDie),
  )

/** Entry point used by the `/auth/*` server routes. */
export const handleAuthRequest = (action: "login" | "callback" | "logout", request: Request): Promise<Response> =>
  serverRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* WebAuth
      return yield* auth[action](request)
    }),
  )
