import { defineConfig } from "vitest/config"

// Kept separate from vite.config.ts so tests do not load the TanStack Start plugin.
export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
  },
})
