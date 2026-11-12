---

## service: ad

# Ad service latency spikes from full GC

## Summary

Frontend product pages had periodic 2-second stalls caused by the ad service. Users were not blocked,
but page latency SLO burn alerted.

## Symptoms

GetAds p99 spiked every few seconds while average latency stayed low. JVM metrics showed frequent full
garbage collections, yet heap usage after each collection was low. CPU was normal.

## Root cause

The `adManualGc` flag was on, triggering explicit full GCs. A memory leak was ruled out because heap
after GC stayed flat. The on-call first raised the heap size, which made each pause longer.

## Mitigation

Turning `adManualGc` off removed the spikes. The heap change was reverted.
