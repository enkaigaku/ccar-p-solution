---

## service: recommendation

# Recommendation service out-of-memory restarts

## Summary

The recommendation service was OOM-killed every 20 to 30 minutes for three hours. Product pages loaded
without recommendations during each restart.

## Symptoms

Recommendation memory grew steadily after each restart. Nearly all spans had `app.cache_hit = false`,
and product-catalog received ten times its normal ListProducts traffic from recommendation.

## Root cause

The `recommendationCacheFailure` flag was on. It makes the in-process cache miss on every lookup while
still growing, so memory climbs until the container limit is reached.

## Mitigation

The flag was turned off and recommendation was restarted once to release memory. Product-catalog traffic
returned to normal immediately.
