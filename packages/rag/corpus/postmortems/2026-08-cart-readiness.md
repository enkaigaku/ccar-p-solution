---

## service: cart

# Cart removed from load balancing by a failing readiness probe

## Summary

Adding items to the cart failed for 18 minutes while the cart process was running and its logs looked
normal.

## Symptoms

Frontend add-to-cart calls failed with `UNAVAILABLE`. Cart emitted no server spans. The container was
running but marked unhealthy, and Valkey was healthy.

## Root cause

The `failedReadinessProbe` flag made cart fail its readiness probe, so it was removed from load balancing.
Restarting cart did not help because the flag was still on.

## Mitigation

The flag was turned off and cart became ready within one probe interval.
