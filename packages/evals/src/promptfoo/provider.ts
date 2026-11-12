import { Effect } from "effect"
import { AgentUnderTest } from "../agent/AgentUnderTest.ts"
import { encodeRun, runCase } from "../evaluate.ts"
import { runtime } from "./runtime.ts"

/**
 * promptfoo custom provider. The "prompt" is ignored: each test names a case through `vars.caseId`, and the
 * provider runs the agent under test against that case's replay snapshot. The output is the encoded `AgentRun`.
 * Shapes follow promptfoo's `ApiProvider` / `ProviderResponse`; they are declared here to keep promptfoo's
 * types out of the package's typecheck.
 */
interface CallContext {
  readonly vars: Record<string, unknown>
}

export interface ProviderResponse {
  readonly output?: string
  readonly error?: string
  readonly cost?: number
  readonly latencyMs?: number
  readonly tokenUsage?: { readonly prompt: number; readonly completion: number; readonly total: number }
  readonly metadata?: Record<string, unknown>
}

export default class IncidentCopilotProvider {
  id(): string {
    return "incident-copilot"
  }

  callApi(_prompt: string, context?: CallContext): Promise<ProviderResponse> {
    const caseId = context?.vars.caseId
    if (typeof caseId !== "string") return Promise.resolve({ error: "test is missing vars.caseId" })
    return runtime.runPromise(
      Effect.gen(function* () {
        const agent = yield* AgentUnderTest
        const { run } = yield* runCase(caseId)
        return {
          output: encodeRun(run),
          cost: run.usage.costUsd,
          latencyMs: run.latencyMs,
          tokenUsage: {
            prompt: run.usage.inputTokens,
            completion: run.usage.outputTokens,
            total: run.usage.inputTokens + run.usage.outputTokens,
          },
          metadata: { agent: agent.name, model: run.model, promptVersion: run.promptVersion },
        } satisfies ProviderResponse
      }).pipe(Effect.catch((error) => Effect.succeed({ error: `${error._tag}: ${error.message}` }))),
    )
  }
}
