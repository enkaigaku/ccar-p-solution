/** Port the console listens on when `WEB_PORT` is unset. Grafana's local port is the same; see `infra/README.md`. */
export const DEFAULT_WEB_PORT = 3001

/**
 * The console's port from the raw `WEB_PORT` value. Anything that is not a valid TCP port falls back to the
 * default, so the dev server and the server-side API base URL always agree on one port.
 */
export const webPort = (raw: string | undefined): number => {
  const port = raw === undefined || !/^\d+$/.test(raw) ? Number.NaN : Number(raw)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_WEB_PORT
}
