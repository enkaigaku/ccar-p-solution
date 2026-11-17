import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { webPort } from "./src/lib/WebPort.ts"

// WEB_PORT moves the console off its default port (Grafana's local port is the same); keep WEB_ORIGIN in step.
const port = webPort(process.env.WEB_PORT)

export default defineConfig({
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  plugins: [tanstackStart(), viteReact()],
})
