import { createFileRoute } from "@tanstack/react-router"
import { handleAuthRequest } from "../server/apiProxy.ts"

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      POST: ({ request }) => handleAuthRequest("logout", request),
    },
  },
})
