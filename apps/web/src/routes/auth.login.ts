import { createFileRoute } from "@tanstack/react-router"
import { handleAuthRequest } from "../server/apiProxy.ts"

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest("login", request),
    },
  },
})
