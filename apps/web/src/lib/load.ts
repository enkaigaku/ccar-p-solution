import { Cause, type Effect, Exit, type ManagedRuntime, Predicate } from "effect"
import { describeError } from "./errors.ts"
import { runtime } from "./runtime.ts"

export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>

export type Loaded<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Failed"; readonly message: string; readonly notFound: boolean }

const NOT_FOUND_TAGS: ReadonlySet<unknown> = new Set(["InvestigationNotFound", "AlertNotFound", "ProposalNotFound"])

/**
 * Runs an effect from a route loader or an event handler and returns a value the UI can render.
 * It never rejects: a typed failure becomes `Failed` with a user-facing message.
 */
export const run = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<Loaded<A>> => {
  const exit = await runtime.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return { _tag: "Ok", value: exit.value }
  const error = Cause.squash(exit.cause)
  const notFound = Predicate.hasProperty(error, "_tag") && NOT_FOUND_TAGS.has(error._tag)
  return { _tag: "Failed", message: describeError(error), notFound }
}
