---

service: email
alerts: MemoryGrowth, HighLatency
---

# email

The email service (Ruby) sends the order confirmation after checkout succeeds.

## Memory leak

### Diagnosis

1. Email memory rises with each order and never drops; restarts reset it.
2. The `emailMemoryLeak` flag retains a copy of every rendered email. The leak rate scales with order
   volume, so it is faster under load-generator traffic.
3. Checkout `SendOrderConfirmation` spans slow down as email approaches its memory limit.

### Mitigation

Propose turning `emailMemoryLeak` off and restarting email. Confirmation emails are best effort; orders
are not lost while email is unhealthy.
