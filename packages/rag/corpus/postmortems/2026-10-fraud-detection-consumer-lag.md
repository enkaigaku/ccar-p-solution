---

## service: fraud-detection

# Fraud detection consumer lag

## Summary

Orders were accepted normally but fraud checks ran up to 25 minutes late because the fraud-detection
consumer processed Kafka messages too slowly.

## Symptoms

Consumer lag for the `fraud-detection` group on the `orders` topic grew linearly for 40 minutes.
Accounting, which reads the same topic, had no lag. Checkout produce rate was flat. The consumer group
kept all its members, and the container was healthy.

## Root cause

The `kafkaQueueProblems` flag was enabled with a per-record delay of 200 ms, slower than the order rate.
Because only one consumer group lagged, the broker and producer were ruled out early.

## Mitigation

Turning the flag off let the backlog drain in about 6 minutes. No restart was needed.
