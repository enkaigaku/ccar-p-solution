import { Authentication, CurrentPrincipal } from "@incident/contracts"
import { Effect, Layer } from "effect"
import { TokenVerifier } from "./TokenVerifier.ts"

/** The server side of the contract's `Authentication` middleware: bearer token -> `CurrentPrincipal`. */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const verifier = yield* TokenVerifier
    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        Effect.flatMap(verifier.verify(credential), (principal) =>
          // The subject is an opaque id from the identity provider; names and tokens stay out of spans.
          Effect.annotateCurrentSpan("enduser.id", principal.subject).pipe(
            Effect.andThen(Effect.provideService(httpEffect, CurrentPrincipal, principal)),
          ),
        ),
    })
  }),
)
