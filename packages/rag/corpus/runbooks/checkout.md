---

service: checkout
alerts: HighErrorRate, HighLatency
---

# checkout

The checkout service (Go) orchestrates an order: it reads the cart, converts currency, charges payment,
asks shipping for a quote and a tracking id, empties the cart, sends the confirmation email and publishes
an `orders` event to Kafka. Most checkout incidents are caused by one of these dependencies.

## High error rate

### Diagnosis

1. Open the checkout trace view and filter spans with `status = error` in the last 15 minutes.
2. Group failed spans by downstream call (`rpc.service`). A single dependency owning most errors is the cause:
   - `oteldemo.PaymentService/Charge` failing: go to the payment runbook.
   - `oteldemo.CartService/GetCart` or `EmptyCart` failing: go to the cart runbook.
   - `oteldemo.ProductCatalogService/GetProduct` failing: go to the product-catalog runbook.
3. If no dependency stands out, check checkout's own logs for panics or `context deadline exceeded`.

A failing payment call surfaces as checkout 5xx: `PlaceOrder` returns `failed to charge card`.

### Mitigation

- Do not restart checkout first: it is almost never the root cause and a restart drops in-flight orders.
- Fix or roll back the failing dependency. If a feature flag was changed recently, propose reverting it.
- If Kafka publishing fails, orders still complete; the impact is on accounting and fraud-detection only.

## High latency

### Diagnosis

1. Compare `PlaceOrder` p99 with the p99 of each downstream span. The dependency whose latency moved with
   checkout's is the cause.
2. `ShippingService/GetQuote` slow for international addresses points to the `intlShippingSlowdown` flag.
3. Slow `ProductCatalogService` calls during peaks point to database lock contention in product-catalog.

### Mitigation

Propose reverting the flag or scaling the slow dependency. Checkout timeouts are 5 seconds per call;
raising them hides the problem and is not a mitigation.
