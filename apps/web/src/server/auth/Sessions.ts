import { Context, DateTime, Duration, Effect, Layer, Option, Ref } from "effect"
import type { PendingLogin, Tokens } from "./OidcClient.ts"

/** A signed-in browser. The id is the cookie value; everything else never leaves the server. */
export interface Session {
  readonly id: string
  readonly tokens: Tokens
  /** Absolute end of the session, whatever the provider's refresh token would still allow. */
  readonly endsAt: DateTime.Utc
}

interface Pending extends PendingLogin {
  readonly returnTo: string
  readonly expiresAt: DateTime.Utc
}

/** How long a login may take between the redirect and the callback. */
export const LOGIN_TTL = Duration.minutes(10)
/** A working day; after that the user signs in again. */
export const SESSION_TTL = Duration.hours(8)
/** Unfinished logins kept at most. Anyone can start one, so the map must not grow without bound. */
const MAX_PENDING = 1000

/** 256 random bits, URL-safe: unguessable session ids. */
const randomId = Effect.sync(() => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))

interface State {
  readonly sessions: ReadonlyMap<string, Session>
  readonly pending: ReadonlyMap<string, Pending>
}

/**
 * Server-side session store. In memory: sessions end when the web server restarts, which is acceptable for
 * a console and keeps tokens out of cookies and out of any database.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    create(tokens: Tokens): Effect.Effect<Session>
    /** The session, unless it is unknown or past its absolute lifetime. */
    get(id: string): Effect.Effect<Option.Option<Session>>
    /** Stores refreshed tokens; a session deleted in the meantime stays deleted. */
    setTokens(id: string, tokens: Tokens): Effect.Effect<void>
    remove(id: string): Effect.Effect<Option.Option<Session>>
    rememberLogin(pending: PendingLogin, returnTo: string): Effect.Effect<void>
    /** Returns a pending login exactly once: a callback cannot be replayed. */
    takeLogin(state: string): Effect.Effect<Option.Option<PendingLogin & { readonly returnTo: string }>>
  }
>()("@incident/web/server/auth/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const ref = yield* Ref.make<State>({ sessions: new Map(), pending: new Map() })
      const live = <A extends { readonly expiresAt: DateTime.Utc } | { readonly endsAt: DateTime.Utc }>(
        now: DateTime.Utc,
        value: A,
      ) => DateTime.isLessThan(now, "endsAt" in value ? value.endsAt : value.expiresAt)

      return Sessions.of({
        create: Effect.fnUntraced(function* (tokens) {
          const now = yield* DateTime.now
          const session: Session = { id: yield* randomId, tokens, endsAt: DateTime.addDuration(now, SESSION_TTL) }
          yield* Ref.update(ref, (s) => ({
            ...s,
            // Expired sessions are dropped whenever a new one is created.
            sessions: new Map([...[...s.sessions].filter(([, v]) => live(now, v)), [session.id, session]]),
          }))
          return session
        }),
        get: Effect.fnUntraced(function* (id) {
          const now = yield* DateTime.now
          const session = (yield* Ref.get(ref)).sessions.get(id)
          return session !== undefined && live(now, session) ? Option.some(session) : Option.none()
        }),
        setTokens: (id, tokens) =>
          Ref.update(ref, (s) => {
            const session = s.sessions.get(id)
            return session === undefined
              ? s
              : { ...s, sessions: new Map([...s.sessions, [id, { ...session, tokens }]]) }
          }),
        remove: (id) =>
          Ref.modify(ref, (s) => {
            const sessions = new Map(s.sessions)
            const session = sessions.get(id)
            sessions.delete(id)
            return [Option.fromNullishOr(session), { ...s, sessions }]
          }),
        rememberLogin: Effect.fnUntraced(function* (pending, returnTo) {
          const now = yield* DateTime.now
          const entry: Pending = { ...pending, returnTo, expiresAt: DateTime.addDuration(now, LOGIN_TTL) }
          yield* Ref.update(ref, (s) => {
            const kept = [...s.pending].filter(([, v]) => live(now, v)).slice(-(MAX_PENDING - 1))
            return { ...s, pending: new Map([...kept, [pending.state, entry]]) }
          })
        }),
        takeLogin: Effect.fnUntraced(function* (state) {
          const now = yield* DateTime.now
          const entry = yield* Ref.modify(ref, (s) => {
            const pending = new Map(s.pending)
            const found = pending.get(state)
            pending.delete(state)
            return [found, { ...s, pending }]
          })
          return entry !== undefined && live(now, entry) ? Option.some(entry) : Option.none()
        }),
      })
    }),
  )
}
