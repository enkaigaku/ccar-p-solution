import { assert, describe, it } from "@effect/vitest"
import { REDACTED, redactLogLine, redactText } from "../src/Redaction.ts"

describe("redactText", () => {
  it.each([
    ["email", "user alice.smith+test@example.co.jp signed in", "user [EMAIL] signed in"],
    ["ipv4", "connection from 192.168.10.42 refused", "connection from [IP] refused"],
    ["ipv6 full", "peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 closed", "peer [IP] closed"],
    ["ipv6 compressed", "peer fe80::1ff:fe23:4567:890a closed", "peer [IP] closed"],
    ["card (Luhn)", "charge card 4111 1111 1111 1111 declined", "charge card [CARD] declined"],
    ["card without spaces", "card=4111111111111111", "card=[CARD]"],
    ["international phone", "call +81 90-1234-5678 now", "call [PHONE] now"],
    ["cn mobile", "手机 13812345678 已验证", "手机 [PHONE] 已验证"],
    ["nanp phone", "contact (415) 555-0132 please", "contact [PHONE] please"],
    ["bearer", "Authorization: Bearer abcdef1234567890", "Authorization: [REDACTED] [TOKEN]"],
    ["bearer alone", "sent Bearer abcdef1234567890xyz", "sent Bearer [TOKEN]"],
    [
      "jwt",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "token [TOKEN]",
    ],
    ["password", "login failed password=hunter2 user=bob", `login failed password=${REDACTED} user=bob`],
    ["api key json-ish", '"api_key": "abc123secret"', `"api_key": "${REDACTED}"`],
    ["quoted secret with spaces", 'login password="hello world" ok', `login password="${REDACTED}" ok`],
    ["single-quoted secret", "token: 'a b c' next", `token: '${REDACTED}' next`],
    ["escaped quote inside secret", 'secret="a \\" b" end', `secret="${REDACTED}" end`],
    ["unterminated quoted secret", 'password="hello world', `password="${REDACTED}`],
    ["anthropic key", "using sk-ant-api03-abcdefghijklmnopqrstuv", "using [TOKEN]"],
    ["aws key", "AKIAIOSFODNN7EXAMPLE leaked", "[TOKEN] leaked"],
  ])("redacts %s", (_name, input, expected) => {
    assert.strictEqual(redactText(input), expected)
  })

  it.each([
    ["timestamps", "2026-11-12T05:34:21.123Z request took 12:34:56"],
    ["non-Luhn digit runs", "order 1234567890123 shipped"],
    ["durations and counts", "processed 1500 items in 2.35s, 3 retries"],
    ["trace ids", "trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span_id=00f067aa0ba902b7"],
    ["versions", "running image 2.1.3-checkout on node v22.18.0"],
    ["http routes", "GET /api/products/OLJCESPC7Z 200"],
  ])("keeps %s", (_name, input) => {
    assert.strictEqual(redactText(input), input)
  })

  it("is idempotent", () => {
    const once = redactText("mail bob@example.com from 10.0.0.1 with password=x")
    assert.strictEqual(redactText(once), once)
  })
})

describe("redactLogLine", () => {
  it("applies the field allowlist to JSON lines", () => {
    const line = JSON.stringify({
      level: "error",
      message: "payment failed for bob@example.com",
      user_name: "Bob Smith",
      address: { street: "1 Main St", zip: 12345 },
      http: { status_code: 502 },
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    })
    assert.deepStrictEqual(JSON.parse(redactLogLine(line)), {
      level: "error",
      message: "payment failed for [EMAIL]",
      user_name: REDACTED,
      address: { street: REDACTED, zip: REDACTED },
      http: { status_code: 502 },
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    })
  })

  it("redacts numbers outside the allowlist and PII-shaped numbers inside it", () => {
    const line = JSON.stringify({
      phone: 13812345678,
      credit_card: 4111111111111111,
      code: 4111111111111111,
      status: 500,
    })
    assert.deepStrictEqual(JSON.parse(redactLogLine(line)), {
      phone: REDACTED,
      credit_card: REDACTED,
      code: REDACTED,
      status: 500,
    })
  })

  it("redacts a quoted secret inside an allowlisted message", () => {
    const line = JSON.stringify({ message: 'auth failed password="hello world"' })
    assert.deepStrictEqual(JSON.parse(redactLogLine(line)), { message: `auth failed password="${REDACTED}"` })
  })

  it("falls back to pattern rules for plain text and malformed JSON", () => {
    assert.strictEqual(redactLogLine("user 10.1.2.3 logged in"), "user [IP] logged in")
    assert.strictEqual(redactLogLine('{"message": "bob@example.com"'), '{"message": "[EMAIL]"')
  })

  it("is idempotent on JSON lines", () => {
    const once = redactLogLine(JSON.stringify({ message: "x@y.io", customer: "Alice" }))
    assert.strictEqual(redactLogLine(once), once)
  })
})
