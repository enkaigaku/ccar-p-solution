import { createFileRoute } from "@tanstack/react-router"
import { handleAuthRequest } from "../server/apiProxy.ts"

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest("callback", request),
    },
  },
})
