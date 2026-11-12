---

## service: product-catalog

# Product catalog lock contention slows checkout

## Summary

Checkout and product pages were slow for 35 minutes. The cause was lock contention in the product
catalog database, not in checkout.

## Symptoms

Checkout p99 rose from 400 ms to 6 s. Trace breakdown showed most of the time in
`ProductCatalogService/GetProduct`. Recommendation latency rose at the same time. Product-catalog CPU
was low while its database spans waited.

## Root cause

The `productCatalogLockContention` flag held long locks on catalog tables. The database showed many
sessions waiting on ungranted locks.

## Mitigation

The flag was turned off. Killing blocked sessions earlier had only helped for a minute.
