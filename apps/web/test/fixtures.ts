import {
  ActionProposal,
  AlertId,
  EvidenceRef,
  Hypothesis,
  Investigation,
  InvestigationId,
  ProposalId,
  ToggleFlag,
} from "@incident/contracts"
import { DateTime } from "effect"

export const t0 = DateTime.makeUnsafe("2026-11-12T03:00:00Z")
export const investigationId = InvestigationId.make("inv-1")

export const investigation = (overrides: Partial<ConstructorParameters<typeof Investigation>[0]> = {}) =>
  new Investigation({
    id: investigationId,
    alertId: AlertId.make("fp-checkout-1"),
    status: "running",
    hypotheses: [],
    promptVersion: "investigate@1",
    indexVersion: "idx-1",
    model: "claude-opus-5-5",
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  })

export const hypothesis = (summary: string, confidence: number) =>
  new Hypothesis({
    summary,
    confidence,
    evidence: [new EvidenceRef({ kind: "metric", ref: "prom:checkout_5xx_rate" })],
  })

export const proposal = (overrides: Partial<ConstructorParameters<typeof ActionProposal>[0]> = {}) =>
  new ActionProposal({
    id: ProposalId.make("p-1"),
    investigationId,
    action: ToggleFlag.make({ flag: "paymentFailure", variant: "off" }),
    rationale: "Flag enabled a failing code path",
    expectedEffect: "checkout error rate returns below 1%",
    rollbackPlan: "Set the flag back to its previous variant",
    status: "pending",
    createdAt: t0,
    ...overrides,
  })
