import { assert, layer } from "@effect/vitest"
import { ActionProposal, IncidentApi, InvestigationId, ProposalId, ToggleFlag } from "@incident/contracts"
import { DateTime, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { HandlersLayer } from "../src/Http.ts"
import { IncidentStore } from "../src/IncidentStore.ts"

const makeClient = HttpApiTest.groups(IncidentApi, ["system", "alerts", "investigations", "proposals"])

const webhook = {
  version: "4",
  status: "firing" as const,
  receiver: "incident-copilot",
  alerts: [
    {
      status: "firing" as const,
      labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
      annotations: { summary: "checkout 5xx above 5%" },
      startsAt: "2026-11-12T03:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "fp-checkout-1",
    },
  ],
}

layer(Layer.mergeAll(HandlersLayer.pipe(Layer.provideMerge(IncidentStore.layerMemory)), HttpServer.layerServices))(
  "IncidentApi (in-memory)",
  (it) => {
    it.effect("accepts an Alertmanager webhook and starts an investigation", () =>
      Effect.gen(function* () {
        const client = yield* makeClient
        yield* client.health()
        const { accepted } = yield* client.alerts.webhook({ payload: webhook })
        assert.deepStrictEqual([...accepted], ["fp-checkout-1"] as Array<string>)

        const alerts = yield* client.alerts.list()
        assert.strictEqual(alerts[0]?.severity, "critical")

        const started = yield* client.investigations.start({ payload: { alertId: accepted[0]! } })
        assert.strictEqual(started.status, "queued")
        const fetched = yield* client.investigations.get({ params: { id: started.id } })
        assert.strictEqual(fetched.id, started.id)
      }),
    )

    it.effect("returns InvestigationNotFound for an unknown id", () =>
      Effect.gen(function* () {
        const client = yield* makeClient
        const error = yield* client.investigations
          .get({ params: { id: InvestigationId.make("missing") } })
          .pipe(Effect.flip)
        assert.strictEqual(error._tag, "InvestigationNotFound")
      }),
    )

    it.effect("decides a pending proposal exactly once", () =>
      Effect.gen(function* () {
        const client = yield* makeClient
        const store = yield* IncidentStore
        const { accepted } = yield* client.alerts.webhook({ payload: webhook })
        const investigation = yield* client.investigations.start({ payload: { alertId: accepted[0]! } })
        const proposalId = ProposalId.make("p-1")
        yield* store.addProposal(
          new ActionProposal({
            id: proposalId,
            investigationId: investigation.id,
            action: ToggleFlag.make({ flag: "paymentFailure", variant: "off" }),
            rationale: "Flag enabled a failing code path",
            expectedEffect: "checkout error rate returns below 1%",
            rollbackPlan: "Set the flag back to its previous variant",
            status: "pending",
            createdAt: yield* DateTime.now,
          }),
        )
        const approved = yield* client.proposals.decide({
          params: { id: proposalId },
          payload: { decision: "approved" },
        })
        assert.strictEqual(approved.status, "approved")

        const again = yield* client.proposals
          .decide({ params: { id: proposalId }, payload: { decision: "rejected" } })
          .pipe(Effect.flip)
        assert.strictEqual(again._tag, "ProposalNotPending")
      }),
    )
  },
)
