import { Predicate } from "effect"

/**
 * PII and secret redaction applied inside this server, before any log text can reach a model.
 *
 * Two layers:
 * 1. Field allowlist: when a log line is a JSON object, only allowlisted keys keep their string values;
 *    every other string value becomes `[REDACTED]`. Numbers, booleans and null are kept.
 * 2. Pattern rules: run on all remaining text (plain-text lines and allowlisted values).
 *
 * The rules are deliberately conservative: a false positive costs a little context, a false negative leaks data.
 * Redaction is idempotent, so replayed snapshots that were already redacted can safely pass through again.
 */

export const REDACTED = "[REDACTED]"

/** JSON log keys whose values are operational, not personal. Compared case-insensitively. */
export const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "level",
  "severity",
  "severity_text",
  "msg",
  "message",
  "body",
  "error",
  "err",
  "error.message",
  "error.type",
  "exception",
  "exception.message",
  "exception.type",
  "stack",
  "stacktrace",
  "logger",
  "caller",
  "component",
  "service",
  "service.name",
  "service_name",
  "trace_id",
  "traceid",
  "span_id",
  "spanid",
  "timestamp",
  "time",
  "ts",
  "event",
  "kind",
  "name",
  "code",
  "reason",
  "status",
  "status_code",
  "method",
  "route",
  "path",
  "http.method",
  "http.request.method",
  "http.route",
  "http.status_code",
  "http.response.status_code",
  "url.path",
  "rpc.method",
  "rpc.service",
  "rpc.grpc.status_code",
  "duration",
  "duration_ms",
  "latency",
  "latency_ms",
  "product_id",
  "productid",
  "order_id",
  "orderid",
  "currency",
  "currency_code",
])

interface Rule {
  readonly name: string
  readonly pattern: RegExp
  readonly replace: (match: string, ...groups: Array<string>) => string
}

const luhnValid = (digits: string): boolean => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"
const HEX4 = "[0-9a-fA-F]{1,4}"

/** Order matters: secrets and long digit runs first, so later, looser rules do not split them. */
export const RULES: ReadonlyArray<Rule> = [
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replace: () => "[TOKEN]",
  },
  {
    name: "auth-header",
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme) => `${scheme} [TOKEN]`,
  },
  {
    name: "secret-assignment",
    pattern:
      /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|session[_-]?id|cookie|set-cookie)(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s"'&,;}]+)/gi,
    // A quoted value is replaced whole, spaces included, keeping its quotes; an unterminated quote runs to the end.
    replace: (_m, key, sep, value) => {
      const open = value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : ""
      const close = open !== "" && value.length > 1 && value.endsWith(open) ? open : ""
      return `${key}${sep}${open}${REDACTED}${close}`
    },
  },
  {
    name: "api-key",
    pattern:
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    replace: () => "[TOKEN]",
  },
  {
    name: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: () => "[EMAIL]",
  },
  {
    name: "card",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    replace: (match) => (luhnValid(match.replace(/[ -]/g, "")) ? "[CARD]" : match),
  },
  {
    name: "ipv6",
    pattern: new RegExp(
      `\\b(?:(?:${HEX4}:){7}${HEX4}|(?:${HEX4}:){1,6}:(?:${HEX4}(?::${HEX4})*)?)(?![0-9a-fA-F:])`,
      "g",
    ),
    replace: () => "[IP]",
  },
  {
    name: "ipv4",
    pattern: new RegExp(`\\b${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}\\b`, "g"),
    replace: () => "[IP]",
  },
  {
    name: "phone-international",
    pattern: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b/g,
    replace: () => "[PHONE]",
  },
  {
    name: "phone-cn-mobile",
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    replace: () => "[PHONE]",
  },
  {
    name: "phone-nanp",
    pattern: /(?<![\d-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d-])/g,
    replace: () => "[PHONE]",
  },
]

/** Apply the pattern rules to free text. */
export const redactText = (text: string): string =>
  RULES.reduce(
    (acc, rule) => acc.replace(rule.pattern, rule.replace as (m: string, ...g: Array<string>) => string),
    text,
  )

const redactJsonValue = (key: string | undefined, value: unknown): unknown => {
  const allowed = key === undefined || ALLOWED_FIELDS.has(key.toLowerCase())
  if (Predicate.isString(value)) return allowed ? redactText(value) : REDACTED
  // Numbers can carry PII too (a phone or card number encoded as a JSON number): only allowlisted
  // fields keep them, and only when the pattern rules find nothing in their digits.
  if (Predicate.isNumber(value) || Predicate.isBigInt(value)) {
    return allowed && redactText(String(value)) === String(value) ? value : REDACTED
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(key, item))
  if (Predicate.isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJsonValue(k, v)]))
  }
  return value
}

const parseJsonObject = (line: string): Record<string, unknown> | undefined => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Predicate.isObject(parsed) && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Redact one log line: field allowlist for JSON lines, pattern rules for everything. */
export const redactLogLine = (line: string): string => {
  const json = parseJsonObject(line)
  if (json === undefined) return redactText(line)
  // Top-level keys are fields; a string at the root has no key and is free text.
  return JSON.stringify(redactJsonValue(undefined, json))
}
