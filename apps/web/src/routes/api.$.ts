import { createFileRoute } from "@tanstack/react-router"
import { handleApiRequest } from "../server/apiProxy.ts"

/** Same-origin proxy to `apps/api`, so the browser needs no CORS and never learns the API origin. */
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: ({ request }) => handleApiRequest(request),
    },
  },
})
