import type Anthropic from "@anthropic-ai/sdk"
import { type ObservabilityToolName, ObservabilityTools } from "@incident/contracts"
import type { McpToolDefinition } from "../mcp/McpSession.ts"

export const SEARCH_KNOWLEDGE = "search_knowledge"
export const PROPOSE_ACTION = "propose_action"

/** Only the read-only contract tools are ever offered to the agent, whatever the MCP server lists. */
export const isObservabilityTool = (name: string): name is ObservabilityToolName =>
  Object.hasOwn(ObservabilityTools, name)

/** Recursively sorted keys, so tool definitions serialise identically on every request (prompt caching). */
export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

const searchKnowledge: Anthropic.Beta.BetaTool = {
  name: SEARCH_KNOWLEDGE,
  description:
    'Search the runbooks and past incident postmortems (hybrid keyword + semantic search, reranked). Returns up to 8 document chunks with their chunk ids; cite a chunk with evidence kind "chunk" and its chunk id.',
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "What to look for: service, symptom, error message or alert name." },
      service: { type: "string", description: "Only documents about this service (plus general ones)." },
      corpus: {
        type: "string",
        enum: ["runbook", "postmortem", "public-postmortem"],
        description: "Only this kind of document.",
      },
    },
  },
}

const opsActionVariant = (tag: string, fields: Readonly<Record<string, string>>) => ({
  type: "object",
  additionalProperties: false,
  required: ["_tag", ...Object.keys(fields)],
  properties: {
    _tag: { type: "string", const: tag },
    ...Object.fromEntries(Object.entries(fields).map(([k, description]) => [k, { type: "string", description }])),
  },
})

/**
 * The agent's only route to a state change: it records a proposal that a human must approve. There is no tool
 * that executes anything (security rule 1).
 */
const proposeAction: Anthropic.Beta.BetaTool = {
  name: PROPOSE_ACTION,
  description:
    "Propose a remediation for a human approver. Nothing is executed by this tool; an approved proposal is carried out later by a separate system. Use only when you are confident in the root cause.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "rationale", "expected_effect", "rollback_plan"],
    properties: {
      action: {
        anyOf: [
          opsActionVariant("ToggleFlag", { flag: "flagd flag key", variant: "variant to set, e.g. off" }),
          opsActionVariant("RestartService", { service: "docker compose service name" }),
          opsActionVariant("RollbackService", {
            service: "docker compose service name",
            imageTag: "image tag to roll back to",
          }),
        ],
      },
      rationale: { type: "string", description: "Why this action addresses the root cause, citing evidence refs." },
      expected_effect: { type: "string", description: "What should change after the action, and how to verify it." },
      rollback_plan: { type: "string", description: "How to undo the action if it makes things worse." },
    },
  },
}

/** Tool list in a fixed order: MCP read-only tools sorted by name, then the two api-side tools. */
export const agentTools = (mcpTools: ReadonlyArray<McpToolDefinition>): Array<Anthropic.Beta.BetaTool> => [
  ...mcpTools
    .filter((t) => isObservabilityTool(t.name))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(
      (t): Anthropic.Beta.BetaTool => ({
        name: t.name,
        description: t.description,
        input_schema: sortKeys(t.inputSchema) as Anthropic.Beta.BetaTool.InputSchema,
      }),
    ),
  sortKeys(searchKnowledge) as Anthropic.Beta.BetaTool,
  sortKeys(proposeAction) as Anthropic.Beta.BetaTool,
]

/** Structured-output schema of the final report. No numeric bounds: structured outputs do not support them. */
export const ReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "hypotheses"],
  properties: {
    status: { type: "string", enum: ["completed", "insufficient_information"] },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "confidence", "evidence"],
        properties: {
          summary: { type: "string" },
          confidence: { type: "number" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "ref", "note"],
              properties: {
                kind: { type: "string", enum: ["metric", "log", "trace", "chunk", "service-status"] },
                ref: { type: "string" },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const
