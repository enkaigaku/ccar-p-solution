import { assert, describe, it } from "@effect/vitest"
import { ProposalNotFound } from "@incident/contracts"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from "jose"
import { AuthenticationLive } from "../src/auth/Authentication.ts"
import { rolesFrom, TokenVerifier } from "../src/auth/TokenVerifier.ts"
import { ApiRoutes } from "../src/Http.ts"
import { IncidentStore } from "../src/IncidentStore.ts"
import { InvestigationRunner } from "../src/InvestigationRunner.ts"

const ISSUER = "http://idp.test/realms/incident"
const AUDIENCE = "incident-api"

/** A local key pair stands in for the identity provider, so no test touches the network. */
const idp = Effect.promise(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const other = await generateKeyPair("RS256")
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }
  const sign = (
    claims: JWTPayload,
    options?: {
      readonly key?: CryptoKey
      readonly expiresIn?: string
      readonly issuer?: string
      readonly audience?: string
    },
  ) =>
    new SignJWT({
      preferred_username: "alice",
      realm_access: { roles: ["approver", "viewer", "offline_access"] },
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("f3b1c0de-0000-4000-8000-000000000001")
      .setIssuer(options?.issuer ?? ISSUER)
      .setAudience(options?.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options?.expiresIn ?? "5m")
      .sign(options?.key ?? privateKey)
  const verifier = TokenVerifier.makeOidc({
    issuer: ISSUER,
    audience: AUDIENCE,
    rolesClaim: "realm_access.roles",
    keys: createLocalJWKSet({ keys: [jwk] }),
  })
  return { sign, verifier, otherKey: other.privateKey }
})

const refused = (verifier: TokenVerifier["Service"], token: string) =>
  verifier.verify(Redacted.make(token)).pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  )

describe("TokenVerifier (OIDC)", () => {
  it.effect("maps a valid access token to a principal with its console roles", () =>
    Effect.gen(function* () {
      const { sign, verifier } = yield* idp
      const principal = yield* verifier.verify(Redacted.make(yield* Effect.promise(() => sign({}))))
      assert.strictEqual(principal.subject, "f3b1c0de-0000-4000-8000-000000000001")
      assert.strictEqual(principal.name, "alice")
      // Contract order, and roles the console does not know are dropped.
      assert.deepStrictEqual(principal.roles, ["viewer", "approver"])
    }),
  )

  it.effect("a token without role claims authenticates with no roles", () =>
    Effect.gen(function* () {
      const { sign, verifier } = yield* idp
      const token = yield* Effect.promise(() => sign({ realm_access: undefined, preferred_username: undefined }))
      const principal = yield* verifier.verify(Redacted.make(token))
      assert.deepStrictEqual(principal.roles, [])
      assert.strictEqual(principal.name, principal.subject)
    }),
  )

  it.effect("refuses expired tokens, other issuers, other audiences and other keys", () =>
    Effect.gen(function* () {
      const { sign, verifier, otherKey } = yield* idp
      const tokens = yield* Effect.promise(() =>
        Promise.all([
          sign({}, { expiresIn: "-1m" }),
          sign({}, { issuer: "http://evil.test/realms/incident" }),
          // An ID token is issued to the web client, not to the api.
          sign({}, { audience: "incident-web" }),
          sign({}, { key: otherKey }),
        ]),
      )
      for (const token of tokens) assert.strictEqual(yield* refused(verifier, token), "Unauthorized")
    }),
  )

  it.effect("refuses unsigned tokens, HMAC tokens signed with the public key, and garbage", () =>
    Effect.gen(function* () {
      const { verifier } = yield* idp
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
      const claims = {
        sub: "attacker",
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        realm_access: { roles: ["approver"] },
      }
      const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`
      const hmac = yield* Effect.promise(() =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "HS256", kid: "k1" })
          .sign(new TextEncoder().encode("public-key-bytes")),
      )
      for (const token of [unsigned, hmac, "", "not-a-jwt", "a.b.c"]) {
        assert.strictEqual(yield* refused(verifier, token), "Unauthorized")
      }
    }),
  )

  it("reads roles from a dotted claim path and ignores malformed claims", () => {
    assert.deepStrictEqual(
      rolesFrom({ resource_access: { web: { roles: ["responder"] } } }, "resource_access.web.roles"),
      ["responder"],
    )
    assert.deepStrictEqual(rolesFrom({ realm_access: { roles: "approver" } }, "realm_access.roles"), [])
    assert.deepStrictEqual(rolesFrom({ realm_access: null }, "realm_access.roles"), [])
    assert.deepStrictEqual(rolesFrom({ roles: [{ name: "approver" }, 1, "admin"] }, "roles"), [])
  })
})

describe("Authentication middleware over HTTP", () => {
  it.effect("answers 401 without a valid bearer token, 403 without the role, and serves the principal otherwise", () =>
    Effect.gen(function* () {
      const { sign, verifier } = yield* idp
      const runner = InvestigationRunner.of({
        start: () => Effect.die("not used"),
        decide: (id) => Effect.fail(new ProposalNotFound({ id })),
      })
      const { handler, dispose } = HttpRouter.toWebHandler(
        ApiRoutes.pipe(
          Layer.provide(AuthenticationLive),
          Layer.provide(Layer.succeed(TokenVerifier, verifier)),
          Layer.provide(Layer.succeed(InvestigationRunner, runner)),
          Layer.provide(IncidentStore.layerMemory),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      )
      const call = (path: string, token?: string, init?: RequestInit) =>
        Effect.promise(() =>
          handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: {
                "content-type": "application/json",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
              },
            }),
          ),
        )
      const approver = yield* Effect.promise(() => sign({}))
      const viewer = yield* Effect.promise(() =>
        sign({ realm_access: { roles: ["viewer"] }, preferred_username: "carol" }),
      )
      const expired = yield* Effect.promise(() => sign({}, { expiresIn: "-1m" }))

      const session = yield* call("/session", approver)
      assert.strictEqual(session.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => session.json()), {
        subject: "f3b1c0de-0000-4000-8000-000000000001",
        name: "alice",
        roles: ["viewer", "approver"],
      })
      for (const path of ["/session", "/alerts", "/investigations/inv-1", "/investigations/inv-1/proposals"]) {
        assert.strictEqual((yield* call(path)).status, 401, path)
        assert.strictEqual((yield* call(path, expired)).status, 401, path)
      }
      const decision = { method: "POST", body: JSON.stringify({ decision: "approved" }) }
      assert.strictEqual((yield* call("/proposals/p-1/decision", undefined, decision)).status, 401)
      // A viewer is authenticated but may not decide; the approver gets past authorization (the proposal is unknown).
      assert.strictEqual((yield* call("/proposals/p-1/decision", viewer, decision)).status, 403)
      assert.strictEqual((yield* call("/proposals/p-1/decision", approver, decision)).status, 404)
      // Health and the alert webhook stay open: they are called by probes and by Alertmanager.
      assert.strictEqual((yield* call("/health")).status, 204)
      yield* Effect.promise(dispose)
    }),
  )
})

describe("TokenVerifier.layer", () => {
  const build = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const verifier = yield* TokenVerifier
      return yield* verifier.verify(Redacted.make("anything"))
    }).pipe(Effect.provide(TokenVerifier.layer), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))

  it.effect("refuses to start without an issuer unless AUTH_MODE=dev is explicit", () =>
    Effect.gen(function* () {
      const error = yield* build({}).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AuthNotConfigured")
      const operator = yield* build({ AUTH_MODE: "dev", APPROVER_ID: "dev-operator" })
      assert.strictEqual(operator.subject, "dev-operator")
      assert.deepStrictEqual(operator.roles, ["viewer", "responder", "approver"])
      const both = yield* build({ AUTH_MODE: "dev", OIDC_ISSUER: ISSUER }).pipe(Effect.flip)
      assert.strictEqual(both._tag, "AuthNotConfigured")
    }),
  )

  it.effect("with an issuer it verifies tokens, even when AUTH_MODE is unset", () =>
    Effect.gen(function* () {
      const error = yield* build({ OIDC_ISSUER: ISSUER }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "Unauthorized")
    }),
  )
})
