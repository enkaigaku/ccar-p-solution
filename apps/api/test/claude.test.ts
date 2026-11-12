import Anthropic from "@anthropic-ai/sdk"
import { assert, describe, it } from "@effect/vitest"
import { classifyError } from "../src/claude/ClaudeClient.ts"

const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error" }, "boom", new Headers())

describe("ClaudeClient.classifyError", () => {
  it("retries rate limits, overload, timeouts, 5xx and connection errors", () => {
    for (const status of [408, 429, 500, 503, 529]) {
      assert.strictEqual(classifyError(apiError(status))._tag, "ClaudeRetryableError", `status ${status}`)
    }
    assert.strictEqual(
      classifyError(new Anthropic.APIConnectionError({ message: "reset" }))._tag,
      "ClaudeRetryableError",
    )
  })

  it("does not retry bad requests, auth failures or unknown errors", () => {
    for (const status of [400, 401, 403, 404]) {
      assert.strictEqual(classifyError(apiError(status))._tag, "ClaudeError", `status ${status}`)
    }
    assert.strictEqual(classifyError(new Error("weird"))._tag, "ClaudeError")
  })
})
