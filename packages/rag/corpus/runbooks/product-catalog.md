---

service: product-catalog
alerts: HighErrorRate, HighLatency
---

# product-catalog

The product catalog service (Go) serves product listings and details to frontend, checkout and
recommendation. It reads products from its database.

## Errors for one product

### Diagnosis

1. `oteldemo.ProductCatalogService/GetProduct` fails only for a single product id (`OLJCESPC7Z`),
   while listing works. Group failed spans by `app.product.id` to confirm.
2. This pattern is caused by the `productCatalogFailure` flag. Checkout fails for orders containing
   that product, so it can look like a checkout outage.

### Mitigation

Propose turning `productCatalogFailure` off.

## Slow queries and lock contention

### Diagnosis

1. GetProduct and ListProducts p99 rise together; database spans show long waits.
2. The `productCatalogLockContention` flag holds locks on the catalog database, so queries queue.
   Check the database for waiting locks (`pg_locks` with `granted = false`).
3. Downstream, checkout and recommendation latency rise because they call product-catalog.

### Mitigation

Propose turning `productCatalogLockContention` off. Killing individual sessions only helps briefly.
