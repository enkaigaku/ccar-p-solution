import Anthropic from "@anthropic-ai/sdk"
import { Config, Context, Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"

export type MessageParams = Anthropic.Beta.MessageCreateParamsNonStreaming
export type Message = Anthropic.Beta.BetaMessage

/** Rate limits, overload, 5xx, timeouts and network errors. Retried with backoff inside `create`. */
export class ClaudeRetryableError extends Schema.TaggedError<ClaudeRetryableError>()("ClaudeRetryableError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

/** Bad request, authentication, permission, missing key. Never retried. */
export class ClaudeError extends Schema.TaggedError<ClaudeError>()("ClaudeError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

/**
 * Thin Effect wrapper over the official SDK (ADR 003): Promise to Effect, typed SDK exceptions to retryable /
 * non-retryable errors. Requests use the beta endpoint because server-side `fallbacks` lives there.
 * Callers must check `stop_reason` before reading `content`.
 */
export class ClaudeClient extends Context.Service<
  ClaudeClient,
  {
    create(params: MessageParams): Effect.Effect<Message, ClaudeError | ClaudeRetryableError>
  }
>()("@incident/api/claude/ClaudeClient") {
  /** Retries are done here, so the SDK client must be built with `maxRetries: 0`. Tests pass a fake `fetch`. */
  static readonly make = (
    client: Anthropic,
    options?: { readonly timeout?: Duration.Input },
  ): ClaudeClient["Service"] => {
    const timeout = options?.timeout ?? Duration.minutes(5)
    const create = Effect.fn("ClaudeClient.create")(function* (params: MessageParams) {
      return yield* Effect.tryPromise({
        try: (signal) => client.beta.messages.create(params, { signal }),
        catch: classifyError,
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new ClaudeRetryableError({ message: "Claude request timed out" })),
        }),
        Effect.retry({
          while: (error) => error._tag === "ClaudeRetryableError",
          schedule: Schedule.exponential("2 seconds").pipe(Schedule.jittered),
          times: 3,
        }),
      )
    })
    return ClaudeClient.of({ create })
  }

  /**
   * Reads `ANTHROPIC_API_KEY`. Without it the api still starts (the console and the stub flows work), and every
   * Claude call fails with a non-retryable `ClaudeError`.
   */
  static readonly layer = Layer.effect(
    ClaudeClient,
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.Redacted("ANTHROPIC_API_KEY"))
      if (Option.isNone(apiKey)) {
        yield* Effect.logWarning("ANTHROPIC_API_KEY is not set; investigations will fail")
        return ClaudeClient.of({
          create: () => Effect.fail(new ClaudeError({ message: "ANTHROPIC_API_KEY is not set" })),
        })
      }
      return ClaudeClient.make(new Anthropic({ apiKey: Redacted.value(apiKey.value), maxRetries: 0 }))
    }),
  )
}

/** Most specific first; 408 and 529 (overloaded) are retryable even though they are not 5xx/429 subclasses. */
export const classifyError = (error: unknown): ClaudeError | ClaudeRetryableError => {
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
    return new ClaudeRetryableError({ message: error.message, status: error.status })
  }
  if (error instanceof Anthropic.APIConnectionError) return new ClaudeRetryableError({ message: error.message })
  if (error instanceof Anthropic.APIError) {
    return error.status === 408 || error.status === 529
      ? new ClaudeRetryableError({ message: error.message, status: error.status })
      : new ClaudeError({ message: error.message, ...(error.status === undefined ? {} : { status: error.status }) })
  }
  return new ClaudeError({ message: error instanceof Error ? error.message : String(error) })
}

/** Text of the response, joined. Only call after checking `stop_reason`. */
export const responseText = (message: Message): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
