import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { proxyToApi, upstreamUrl } from "../src/server/apiProxy.ts"

describe("api proxy", () => {
  it("strips the /api prefix and keeps the query string", () => {
    expect(upstreamUrl("https://web.local/api/investigations/1?x=y", "http://api:3000").href).toBe(
      "http://api:3000/investigations/1?x=y",
    )
    expect(upstreamUrl("https://web.local/api", "http://api:3000/base/").href).toBe("http://api:3000/base/")
  })

  it.effect("forwards method, body and safe headers, and streams the response back", () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init })
      return new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "9" },
      })
    }
    const request = new Request("https://web.local/api/proposals/p-1/decision", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=secret" },
      body: JSON.stringify({ decision: "approved" }),
    })
    return Effect.gen(function* () {
      const response = yield* proxyToApi(request, "http://api:3000", fakeFetch)
      const forwarded = seen[0]
      expect(forwarded?.url).toBe("http://api:3000/proposals/p-1/decision")
      expect(forwarded?.init?.method).toBe("POST")
      const headers = new Headers(forwarded?.init?.headers)
      expect(headers.get("cookie")).toBeNull()
      expect(headers.get("content-type")).toBe("application/json")
      const body = forwarded?.init?.body
      expect(body instanceof ArrayBuffer ? new TextDecoder().decode(body) : body).toBe('{"decision":"approved"}')
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.headers.get("content-encoding")).toBeNull()
      expect(yield* Effect.promise(() => response.text())).toBe("data: {}\n\n")
    })
  })

  it.effect("answers 502 without leaking the upstream address when the API is down", () => {
    const failingFetch: typeof fetch = () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.7:3000"))
    return Effect.gen(function* () {
      const response = yield* proxyToApi(
        new Request("https://web.local/api/alerts/"),
        "http://10.0.0.7:3000",
        failingFetch,
      )
      expect(response.status).toBe(502)
      const body = yield* Effect.promise(() => response.text())
      expect(body).not.toContain("10.0.0.7")
    })
  })
})
