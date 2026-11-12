---

service: frontend
alerts: HighLatency, HighErrorRate, TrafficSpike
---

# frontend

The frontend (Next.js) serves the web shop behind frontend-proxy (Envoy). It calls almost every backend
service, so its errors usually reflect a backend problem.

## Slow page loads

### Diagnosis

1. Separate server time from asset time. If HTML responses are fast but browser spans show slow image
   requests, the `imageSlowLoad` flag is delaying images served by image-provider through Envoy.
2. If server-side spans are slow, find the backend span with the largest share of the duration and
   follow that service's runbook.

### Mitigation

Propose turning `imageSlowLoad` off for the image case; otherwise mitigate the slow backend.

## Traffic spike on the home page

### Diagnosis

1. Request rate on `/` jumps far above normal and comes from the load generator user agent.
2. The `loadGeneratorFloodHomepage` flag makes the load generator flood the home page.
   Frontend CPU and latency rise; backends see more product-catalog and ad calls.

### Mitigation

Propose turning `loadGeneratorFloodHomepage` off. This is synthetic load, so do not scale up for it.

## High error rate

When frontend returns 5xx, group failed server spans by the backend they call. Product page errors usually
come from product-catalog or recommendation; cart page errors from cart; checkout errors from checkout.
