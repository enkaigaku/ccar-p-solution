import { Context } from "effect"

/** Path prefix under which the web server proxies the Incident API (see `src/routes/api.$.ts`). */
export const API_PREFIX = "/api"

/**
 * Base URL every browser-side API call is prefixed with.
 *
 * The browser never talks to `apps/api` directly: it calls the same-origin `/api` proxy, so the API
 * origin, CORS and (later) the OIDC session stay on the web server. Tests override this reference.
 */
export const ApiBaseUrl = Context.Reference<string>("@incident/web/ApiBaseUrl", {
  defaultValue: () =>
    typeof location === "undefined" ? `http://localhost:3001${API_PREFIX}` : `${location.origin}${API_PREFIX}`,
})
