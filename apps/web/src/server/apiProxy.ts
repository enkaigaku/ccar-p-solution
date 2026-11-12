import { Config, Effect, Schema } from "effect"
import { API_PREFIX } from "../lib/ApiBaseUrl.ts"

/** Where the web server forwards `/api/*`. Server-side only; the browser never sees this origin. */
export const ApiUrl = Config.String("API_URL").pipe(Config.withDefault("http://localhost:3000"))

export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>()("UpstreamUnavailable", {}) {}

/** Hop-by-hop headers plus the ones that must not cross the proxy in either direction. */
const DROPPED_REQUEST_HEADERS = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "cookie"]
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

/**
 * Forwards one request to the Incident API and streams the response back unchanged, which keeps SSE
 * (`text/event-stream`) working. Aborting the browser request aborts the upstream one.
 */
export const proxyToApi = (request: Request, apiUrl: string, fetchImpl: typeof fetch = fetch) =>
  Effect.gen(function* () {
    const hasBody = request.method !== "GET" && request.method !== "HEAD"
    const body = hasBody
      ? yield* Effect.tryPromise({ try: () => request.arrayBuffer(), catch: () => new UpstreamUnavailable() })
      : null
    const upstream = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(upstreamUrl(request.url, apiUrl), {
          method: request.method,
          headers: withoutHeaders(request.headers, DROPPED_REQUEST_HEADERS),
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

/** Entry point used by the `/api/$` server route. */
export const handleApiRequest = (request: Request): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const apiUrl = yield* ApiUrl
      return yield* proxyToApi(request, apiUrl)
    }).pipe(Effect.orDie),
  )
