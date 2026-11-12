import { createStart } from "@tanstack/react-start"

/**
 * Loaders run in the browser only. They return decoded contract classes (`DateTime`, branded ids,
 * `Schema.Class` instances) that the SSR payload serializer cannot carry, and the console sits behind
 * login, so server rendering buys little. The server still serves the shell and the `/api` proxy.
 */
export const startInstance = createStart(() => ({ defaultSsr: false }))
