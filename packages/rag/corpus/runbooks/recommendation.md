---

service: recommendation
alerts: HighErrorRate, MemoryGrowth
---

# recommendation

The recommendation service (Python) suggests products on the product page. It calls product-catalog and
keeps an in-process cache of product ids.

## Cache failure and memory growth

### Diagnosis

1. Recommendation memory grows steadily and requests get slower; spans carry `app.cache_hit = false`
   for almost every request.
2. The `recommendationCacheFailure` flag makes the cache miss and grow without bound, so every call goes
   to product-catalog and memory climbs until the container is OOM-killed.
3. Confirm with container restarts (`OOMKilled`) for recommendation.

### Mitigation

Propose turning `recommendationCacheFailure` off, then restarting recommendation to release memory.
