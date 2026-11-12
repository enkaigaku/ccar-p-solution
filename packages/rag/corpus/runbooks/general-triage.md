# General triage

Applies to every service. Use it when no service-specific runbook matches the alert.

## First five minutes

1. Confirm the alert is real: open the dashboard behind it and check that the signal is still firing.
2. Check recent changes: feature flag changes in flagd, deployments and config changes in the last hour.
   In this environment most incidents follow a flag change.
3. Find the first failing service in the call chain: follow error spans from the edge (frontend-proxy)
   inward until the deepest service that fails on its own.

## Proposing actions

The copilot never changes the system directly. Every mitigation is proposed through `propose_action` and
needs an approver. Prefer reverting a recent flag change over restarts or rollbacks, because it is the
smallest change that removes the cause.

## When evidence is insufficient

If logs, metrics and traces do not point to a cause, say so and list what was checked. A guess presented
as a root cause is worse than an honest "not enough evidence".
