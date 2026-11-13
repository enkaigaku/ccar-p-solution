import { type Alert, type InvestigationUsage, Severity } from "@incident/contracts"
import { AlertCategories, type AlertCategory, TriagePrompt } from "@incident/prompts"
import { annotatePrompt, recordClaudeResponse, SpanName } from "@incident/telemetry"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { AuditLog } from "../audit/AuditLog.ts"
import { ClaudeClient, responseText } from "../claude/ClaudeClient.ts"
import { canonicalJson, untrusted } from "../prompting.ts"
import { addUsage, emptyUsage } from "../usage.ts"

export const TriageModel = "claude-haiku-5-5"

export const TriageOutput = Schema.Struct({
  category: Schema.Literals(AlertCategories),
  service: Schema.String,
  severity: Severity,
  summary: Schema.String,
  retrievalQuery: Schema.String,
  relatedAlertIds: Schema.Array(Schema.String),
})
export type TriageOutput = typeof TriageOutput.Type

/** Structured-output schema (hand-written: structured outputs need `additionalProperties: false`). */
export const TriageOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "service", "severity", "summary", "retrievalQuery", "relatedAlertIds"],
  properties: {
    category: { type: "string", enum: [...AlertCategories] },
    service: { type: "string" },
    severity: { type: "string", enum: ["critical", "warning", "info"] },
    summary: { type: "string" },
    retrievalQuery: { type: "string" },
    relatedAlertIds: { type: "array", items: { type: "string" } },
  },
} as const

export interface TriageResult extends TriageOutput {
  /** `model` when Haiku classified the alert, `fallback` when the label-based heuristic did. */
  readonly source: "model" | "fallback"
  readonly promptVersion: string
  /** Model usage of the triage call; also set when the call succeeded but its answer was unusable. */
  readonly usage: InvestigationUsage
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(TriageOutput))

class TriageFailed extends Schema.TaggedError<TriageFailed>()("TriageFailed", { message: Schema.String }) {}

const KEYWORDS: ReadonlyArray<readonly [AlertCategory, RegExp]> = [
  ["latency", /latenc|slow|duration|p9[59]|timeout/i],
  ["error-rate", /error|5xx|fail|exception/i],
  ["saturation", /cpu|memory|mem|gc|lag|saturat|oom|queue/i],
  ["availability", /down|unavailable|restart|ready|crash/i],
]

/** Deterministic triage from the alert's own labels. Used when the model call fails, so investigations still run. */
export const fallbackTriage = (alert: Alert): TriageResult => {
  const text = `${alert.name} ${alert.summary}`
  const category = KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other"
  return {
    category,
    service: alert.service,
    severity: alert.severity,
    summary: alert.summary === "" ? alert.name : alert.summary,
    retrievalQuery: `${alert.service} ${alert.name} ${alert.summary}`.trim(),
    relatedAlertIds: [],
    source: "fallback",
    promptVersion: "triage-fallback",
    usage: emptyUsage,
  }
}

const alertView = (alert: Alert) => ({
  id: alert.id,
  name: alert.name,
  service: alert.service,
  severity: alert.severity,
  status: alert.status,
  summary: alert.summary,
  labels: alert.labels,
})

export const renderTriageRequest = (alert: Alert, firing: ReadonlyArray<Alert>): string =>
  [
    untrusted("alert", canonicalJson(alertView(alert))),
    untrusted(
      "firing-alerts",
      canonicalJson(
        firing.filter((a) => a.id !== alert.id).map((a) => ({ id: a.id, name: a.name, service: a.service })),
      ),
    ),
  ].join("\n\n")

/**
 * Alert triage as a fixed workflow (ADR 001): one Haiku 5.5 call at low effort with structured output.
 * Never fails: any model, refusal or decoding problem falls back to the label heuristic and is logged.
 */
export class Triage extends Context.Service<
  Triage,
  {
    triage(alert: Alert, firing: ReadonlyArray<Alert>): Effect.Effect<TriageResult>
  }
>()("@incident/api/triage/Triage") {
  static readonly layer = Layer.effect(
    Triage,
    Effect.gen(function* () {
      const claude = yield* ClaudeClient
      const audit = yield* AuditLog

      const viaModel = Effect.fnUntraced(function* (
        alert: Alert,
        firing: ReadonlyArray<Alert>,
        spent: Ref.Ref<InvestigationUsage>,
      ) {
        const user = renderTriageRequest(alert, firing)
        yield* annotatePrompt({ step: "triage", promptVersion: TriagePrompt.version, renderedPrompt: user })
        yield* audit.append({ kind: "llm_request", subject: TriageModel, payload: user })
        const response = yield* claude.create({
          model: TriageModel,
          max_tokens: 4096,
          // Haiku 5.5 has no server-side refusal fallback; a refusal falls back to the heuristic below.
          output_config: { effort: "low", format: { type: "json_schema", schema: TriageOutputJsonSchema } },
          system: [{ type: "text", text: TriagePrompt.text, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: user }],
        })
        const cost = yield* recordClaudeResponse({ step: "triage", requestedModel: TriageModel }, response)
        yield* Ref.update(spent, (total) => addUsage(total, response.usage, cost))
        if (response.stop_reason !== "end_turn") {
          return yield* new TriageFailed({ message: `triage stopped with ${response.stop_reason}` })
        }
        const text = responseText(response)
        yield* audit.append({ kind: "llm_response", subject: response.model, payload: text })
        const output = yield* decode(text)
        const known = new Set(firing.map((a) => a.id as string))
        return {
          ...output,
          relatedAlertIds: output.relatedAlertIds.filter((id) => id !== alert.id && known.has(id)),
          source: "model",
          promptVersion: TriagePrompt.version,
          usage: yield* Ref.get(spent),
        } satisfies TriageResult
      })

      const triage = (alert: Alert, firing: ReadonlyArray<Alert>) =>
        Effect.gen(function* () {
          const spent = yield* Ref.make(emptyUsage)
          return yield* viaModel(alert, firing, spent).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Triage fell back to label heuristics").pipe(
                Effect.annotateLogs({ reason: error._tag }),
                Effect.andThen(Ref.get(spent)),
                Effect.map((usage) => ({ ...fallbackTriage(alert), usage })),
              ),
            ),
          )
        }).pipe(
          Effect.tap((result) =>
            Effect.annotateCurrentSpan({
              "incident.triage.category": result.category,
              "incident.triage.source": result.source,
            }),
          ),
          Effect.withSpan(SpanName.triage, { attributes: { "incident.alert.id": alert.id } }),
        )

      return Triage.of({ triage })
    }),
  )
}
