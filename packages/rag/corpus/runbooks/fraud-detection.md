---

service: fraud-detection
alerts: ConsumerLag, ConsumerGroupEmpty
---

# fraud-detection

Fraud detection (Kotlin) consumes the `orders` topic from Kafka. Accounting consumes the same topic.
Checkout produces one message per order.

## Consumer lag rising

### Diagnosis

1. Kafka consumer lag for group `fraud-detection` rises while checkout produce rate is normal.
2. If the group still has members, the consumer is too slow: the `kafkaQueueProblems` flag adds a delay
   per consumed record (the flag value is the delay in milliseconds).
3. Compare with the accounting group: if only fraud-detection lags, the problem is in that consumer.

### Mitigation

Propose turning `kafkaQueueProblems` off. Lag drains on its own afterwards; no restart is needed.

## Consumer group empty

### Diagnosis

1. The `fraud-detection` consumer group has zero members and lag climbs without bound.
2. The `kafkaConsumerDead` flag makes the service leave the group and stop polling while the process
   stays up, so container health looks fine.

### Mitigation

Propose turning `kafkaConsumerDead` off. If members do not rejoin within a minute, restart fraud-detection.
