import { Effect, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"

export interface Recorded {
  readonly method: string
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

/**
 * An in-memory `HttpClient`: `respond` maps each request to a Web `Response`, every request is
 * recorded. No network is touched.
 */
export const fakeHttp = (respond: (request: HttpClientRequest.HttpClientRequest, url: URL) => Response) => {
  const requests: Array<Recorded> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        requests.push({
          method: request.method,
          url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
        })
        return HttpClientResponse.fromWeb(request, respond(request, url))
      }),
    ),
  )
  return { layer, requests }
}

export const sse = (frames: ReadonlyArray<string>, status = 200): Response =>
  new Response(frames.join(""), { status, headers: { "content-type": "text/event-stream" } })

export const json = (value: unknown, status = 200): Response => Response.json(value, { status })
