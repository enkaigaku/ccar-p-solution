---

service: payment
alerts: HighErrorRate, ServiceUnreachable
---

# payment

The payment service (Node.js) validates the card and charges it. It is called only by checkout.
Card numbers and CVV must never appear in logs; the collector redacts `demo.payment.card_number`.

## Charge failures

### Diagnosis

1. Check the error ratio of `oteldemo.PaymentService/Charge` spans. A steady fraction of failures (for
   example 10%, 50%, 100%) rather than a spike usually means the `paymentFailure` feature flag is on.
2. Look for the log line `Payment request failed. Invalid token. app.loyalty.level=gold` in payment logs;
   it is emitted when the flag forces a failure.
3. Check flagd for a recent change of `paymentFailure` and note the variant.

### Mitigation

Propose setting `paymentFailure` back to `off`. This needs approval like any write action.
Retrying from the client does not help: the flag fails requests randomly at the configured ratio.

## Service unreachable

### Diagnosis

1. Checkout spans show `UNAVAILABLE` or `connection refused` for payment, and payment emits no spans at all.
2. The `paymentUnreachable` flag makes checkout dial a wrong address, so payment itself looks healthy.
3. If the flag is off, check whether the payment container is running and passing its health check.

### Mitigation

Propose turning `paymentUnreachable` off, or restarting payment if the container is down.
