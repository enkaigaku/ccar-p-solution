---

service: cart
alerts: HighErrorRate, PodNotReady
---

# cart

The cart service (.NET) stores carts in Valkey. Frontend and checkout call it.

## High error rate

### Diagnosis

1. Failed `oteldemo.CartService/EmptyCart` spans with the event `Can't access cart storage` mean the
   `cartFailure` flag is on: the service points to a bad Valkey connection for a share of requests.
2. Check Valkey itself: `valkey-cli ping` from inside the network, memory usage and evictions.
3. If Valkey is healthy and the flag is off, look at cart logs for `RedisConnectionException`.

### Mitigation

Propose turning `cartFailure` off. If Valkey is down, restart Valkey before cart: cart reconnects on its own.

## Pod not ready

### Diagnosis

The `failedReadinessProbe` flag makes cart fail its readiness probe, so it is removed from load balancing
while the process keeps running. Symptoms: frontend `add to cart` errors, cart has no incoming spans,
container status shows unhealthy.

### Mitigation

Propose turning `failedReadinessProbe` off. Restarting does not help while the flag is on.

## Metric cardinality overflow

When `cartMetricCardinalityOverflow` is on, the trace id is added as an attribute to
`demo.cart.get_cart.latency`. The SDK hits its cardinality limit and starts reporting the
`otel.metric.overflow` series. This is an observability problem, not an outage; turn the flag off.
