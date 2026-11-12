---

service: ad
alerts: HighErrorRate, HighCpu, HighGcPause
---

# ad

The ad service (Java) returns contextual ads to the frontend. Ads are optional: when ad fails, the page
still renders without the ad banner.

## High error rate

### Diagnosis

1. `oteldemo.AdService/GetAds` spans fail with `RESOURCE_EXHAUSTED` or a generic error.
2. The `adFailure` flag makes GetAds fail on a share of requests. Check flagd for a recent change.

### Mitigation

Propose turning `adFailure` off. Because ads are optional, this is low severity unless the error rate
also affects frontend latency.

## High CPU

### Diagnosis

1. Container CPU for ad near its limit, GetAds p99 rising, and no rise in request rate.
2. The `adHighCpu` flag starts a busy loop in the service. JVM metrics show high
   `process.cpu.utilization` with normal heap usage.

### Mitigation

Propose turning `adHighCpu` off. Scaling ad hides the symptom and costs capacity.

## Long garbage collection pauses

### Diagnosis

1. `jvm.gc.duration` shows frequent full collections and request latency spikes line up with them.
2. The `adManualGc` flag triggers manual full GCs. Heap is not actually exhausted, unlike a memory leak.

### Mitigation

Propose turning `adManualGc` off. Do not raise the heap size: it makes each full GC longer.
