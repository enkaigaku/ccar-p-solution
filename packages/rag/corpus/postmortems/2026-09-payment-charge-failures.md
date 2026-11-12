---

## service: payment

# Payment charge failures after a flag change

## Summary

For 42 minutes, half of all checkout attempts failed. A feature flag that forces payment charge failures
was set to 50% during a test and not reverted.

## Symptoms

Checkout `PlaceOrder` error rate rose from under 1% to about 50% at 14:05. Frontend showed "failed to
charge card" to users. Payment CPU, memory and latency were normal, which delayed the diagnosis: the team
first suspected the checkout deployment from the same morning.

## Root cause

The `paymentFailure` flag was changed from `off` to `50%` in flagd at 14:04. Payment logs contained
`Payment request failed. Invalid token.` for every failed charge. The failure ratio stayed flat at 50%,
which is typical of a flag rather than of a dependency outage.

## Mitigation

The flag was set back to `off` at 14:47 and the error rate returned to baseline within a minute.
Rolling back checkout, tried first, had no effect.

## Lessons

Check flag changes before deployments when an error ratio is flat. Flag changes now show up as annotations
on the checkout dashboard.
