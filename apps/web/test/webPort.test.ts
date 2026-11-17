import { describe, expect, it } from "vitest"
import { DEFAULT_WEB_PORT, webPort } from "../src/lib/WebPort.ts"

describe("webPort", () => {
  it("defaults when WEB_PORT is unset", () => {
    expect(webPort(undefined)).toBe(DEFAULT_WEB_PORT)
  })

  it("uses a valid port", () => {
    expect(webPort("3002")).toBe(3002)
  })

  it.each(["", "abc", "0", "65536", "3002.5", "-1", " 3002"])("falls back to the default for %j", (raw) => {
    expect(webPort(raw)).toBe(DEFAULT_WEB_PORT)
  })
})
