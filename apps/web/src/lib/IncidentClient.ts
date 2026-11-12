import { IncidentApi } from "@incident/contracts"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { ApiBaseUrl } from "./ApiBaseUrl.ts"

/**
 * Type-safe client derived from the shared `IncidentApi` contract. Request and response types,
 * and the typed errors each endpoint can fail with, all come from `@incident/contracts`.
 */
export class IncidentClient extends Context.Service<IncidentClient, HttpApiClient.ForApi<typeof IncidentApi>>()(
  "@incident/web/IncidentClient",
) {
  /** Requires an `HttpClient`; the app provides `FetchHttpClient.layer`, tests provide a fake. */
  static readonly layer = Layer.effect(
    IncidentClient,
    Effect.gen(function* () {
      const baseUrl = yield* ApiBaseUrl
      return yield* HttpApiClient.make(IncidentApi, {
        transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
      })
    }),
  )
}
