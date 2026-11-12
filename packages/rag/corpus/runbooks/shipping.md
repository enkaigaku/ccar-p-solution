---

service: shipping
alerts: HighLatency
---

# shipping

The shipping service (Rust) returns quotes and tracking ids. It calls the quote service for prices.

## Slow international quotes

### Diagnosis

1. `GetQuote` latency is high only for non-US addresses; domestic quotes are fast.
2. The `intlShippingSlowdown` flag delays international responses to simulate overseas shipping delay.
3. Checkout latency rises for international orders because checkout waits for the quote.

### Mitigation

Propose turning `intlShippingSlowdown` off.
