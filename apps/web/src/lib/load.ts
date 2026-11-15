import { Cause, type Effect, Exit, type ManagedRuntime, Predicate } from "effect"
import { describeError } from "./errors.ts"
import { runtime } from "./runtime.ts"
import { loginUrl } from "./session.ts"

export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>

export type Loaded<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Failed"; readonly message: string; readonly notFound: boolean }

const NOT_FOUND_TAGS: ReadonlySet<unknown> = new Set(["InvestigationNotFound", "AlertNotFound", "ProposalNotFound"])

const LOGIN_REDIRECT_KEY = "incident.sentToLogin"

const storage = (use: (s: Storage) => void): void => {
  try {
    if (typeof sessionStorage !== "undefined") use(sessionStorage)
  } catch {
    // Storage can be unavailable (private mode); the login redirect then simply has no loop guard.
  }
}

/**
 * True in a browser, unless it was already sent to the login page and no request has succeeded since. When a
 * fresh login is still answered with 401 (for example a token the api refuses), redirecting again would loop
 * through the provider forever; the page then shows the error instead.
 */
const shouldRedirectToLogin = (): boolean => {
  if (typeof location === "undefined") return false
  let alreadySent = false
  storage((s) => {
    alreadySent = s.getItem(LOGIN_REDIRECT_KEY) !== null
    s.setItem(LOGIN_REDIRECT_KEY, "1")
  })
  return !alreadySent
}

/**
 * Runs an effect from a route loader or an event handler and returns a value the UI can render.
 * It never rejects: a typed failure becomes `Failed` with a user-facing message.
 */
export const run = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<Loaded<A>> => {
  const exit = await runtime.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    storage((s) => s.removeItem(LOGIN_REDIRECT_KEY))
    return { _tag: "Ok", value: exit.value }
  }
  const error = Cause.squash(exit.cause)
  // No session, or it ended: sign in again and come back to this page.
  if (Predicate.hasProperty(error, "_tag") && error._tag === "Unauthorized" && shouldRedirectToLogin()) {
    location.assign(loginUrl(`${location.pathname}${location.search}`))
  }
  const notFound = Predicate.hasProperty(error, "_tag") && NOT_FOUND_TAGS.has(error._tag)
  return { _tag: "Failed", message: describeError(error), notFound }
}
