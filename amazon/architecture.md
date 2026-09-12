# Amazon — Architecture

## System Overview

This learning project models an e-commerce storefront: discover products, maintain
a cart, submit an order and inspect its progress. Its main design problems are
allocating scarce inventory, recovering checkout after uncertain payment outcomes,
and serving useful search without making the index authoritative for a purchase.

The production sections propose a design for those requirements. The final
Implementation Notes trace the actual React/Express/PostgreSQL application. The
local code has reservation counters and transactions, but does not yet enforce the
inventory, idempotency and lifecycle guarantees proposed here. It is not a description
of Amazon's internal architecture.

## Requirements

### Functional requirements

- Browse a hierarchical catalog and search with category, price, rating and stock filters.
- Maintain account carts and clearly distinguish purchase intent from allocated stock.
- Validate a checkout quote, reserve specific stock and track payment outcomes.
- Show order history, fulfillment progress and eligible cancellation/refund actions.
- Let authorized sellers manage their own offers and administrators manage exceptions.
- Display reviews and item-to-item recommendations without blocking checkout on them.

Shipping integrations, tax services, fraud controls and payment providers are external
production dependencies. Their local substitutes are described separately below.

### Non-functional requirements

These are proposed targets, not benchmarks of this repository:

| Requirement | Target or invariant |
|-------------|---------------------|
| Browsing availability | 99.99% service target, with bounded stale reads |
| Checkout availability | 99.9%, while preserving stock and payment invariants |
| Search latency | p95 below 200 ms for a bounded query; separately measure browser latency |
| Checkout response | p95 below two seconds for initial acceptance or actionable result; external authentication may take longer |
| Inventory | Allocations cannot exceed the stock authority's available units |
| Order identity | Retrying one account's unchanged checkout attempt resolves to the same order |
| Payment recovery | Unknown outcomes are reconciled before treating payment as failed or retrying a new operation |
| Client feedback | Pending, failed, confirmed and stale states remain distinguishable |

## Capacity Estimation

Assume 100 million offers, ten million daily active buyers and one million orders/day.
Average order creation is about 11.6/second. A sale peak of 1,000/second is an explicit
burst assumption, not something derived directly from daily volume. Assume peak
search of 50,000 requests/second and cart mutations of 10,000/second.

At an assumed 5 KB of offer metadata, the catalog is roughly 500 GB before indexes
and replicas. At 3 KB per order including its lines, one million orders/day adds
about 3 GB/day, or 1.1 TB/year. Images live in object storage and dominate separate
bandwidth/storage budgets. Index size needs measurement against real mappings.

An average checkout rate does not predict hot-item contention. Ten thousand buyers
competing for one offer can serialize on a single stock authority while the rest of
the database is lightly used. Admission control and allocation design address that
case; adding arbitrary API instances does not remove the shared-stock invariant.

### Local Development Scale

Compose runs one PostgreSQL 16, one Valkey 7 and one Elasticsearch 8.11.0 node. The
SQL seed supplies twelve products across four warehouses; the optional TypeScript
seed adds up to twelve other products. Elasticsearch has one primary shard, zero
replicas and a 512 MB heap. No throughput or browser-performance measurements were
made during this documentation review.

## High-Level Architecture

```
┌──────────────────┐       ┌──────────────────────┐
│ Browser / mobile │──────▶│ CDN + storefront API │
│ Browse, checkout │       │ Auth, quotas, routing │
└──────────────────┘       └─────┬───────────┬────┘
                                 │           │
                     ┌───────────▼───┐  ┌────▼───────────────────┐
                     │ Catalog/search│  │ Cart + checkout        │
                     │ Read models   │  │ Quote and attempt state│
                     └───────┬───────┘  └────┬─────────────┬─────┘
                             │               │             │
                     ┌───────▼──────┐  ┌─────▼──────┐  ┌───▼─────────┐
                     │ Search index │  │ Stock/order│  │ Payment     │
                     │ Read caches  │  │ authority  │  │ coordinator │
                     └───────▲──────┘  └─────┬──────┘  └───┬─────────┘
                             │               │             ▼
                     ┌───────┴───────────────▼──────┐  ┌─────────────┐
                     │ Transactional outbox → events│  │ Provider API│
                     │ Index, recommendations, jobs │  │ and webhooks│
                     └──────────────────────────────┘  └─────────────┘
```

These are ownership boundaries. Cart, order and inventory can share one transactional
database initially; splitting them into services is justified by scale and ownership,
not by the number of boxes in a diagram. An inventory allocation has one authoritative
writer even when many regions serve its catalog description.

## Core Components / Request Flows

### Catalog and discovery

PostgreSQL is the catalog authority. A versioned outbox event accompanies each catalog
change; index workers project searchable fields, category ancestry and availability
summaries. Stock and rating updates also produce projection updates. A failed or
out-of-order delivery cannot overwrite a newer version.

The search response includes products, supported facets, pagination and a service
mode/freshness indication. Facet semantics must be explicit: counts can describe the
fully filtered result or omit their own dimension for broader drill-down. The UI
cannot silently mix the two interpretations.

Use a bounded PostgreSQL fallback for supported filters when Elasticsearch fails,
with separate concurrency and query-cost limits. A valid empty search is not itself
an outage. If the fallback cannot preserve a filter, return that limitation rather
than quietly broadening the query. Search availability must not exhaust checkout's
database connections.

### Cart, quote and stock allocation

In the proposed design, an ordinary cart stores intent without holding scarce stock.
At checkout, validate item availability, current prices, seller eligibility and a
versioned quote. A short allocation, initially five minutes subject to product testing,
protects the payment step. The current demo instead attempts holds on cart changes.

1. Accept the account's stable checkout-attempt key and validate its request fingerprint.
2. Lock the attempt and relevant allocation/inventory records in a consistent order.
3. Allocate each quantity to explicit warehouses; do not decrement every warehouse.
4. Check stock constraints and create the pending order, lines, allocations and outbox entry.
5. Commit before contacting the payment provider.
6. Return an order/attempt reference that survives a lost browser response.

Displayed price/stock is advisory until this authority accepts the quote and allocation.
A price change requires a revised quote and customer acceptance, not a hidden increase
behind the same “Place order” button.

### Payment and order lifecycle

A coordinator executes provider operations outside inventory transactions. Each
provider operation has a stable identity, separate from the user's overall checkout
attempt. A transport timeout means the result is unknown until queried or reconciled.

Payment authorization, capture and fulfillment are distinct events. The exact capture
point depends on the business model. State transitions consume the current version,
so a late payment callback cannot blindly confirm an already cancelled order.
If authorization succeeds after an allocation was released, the coordinator resolves
that conflict through a defined void/refund or a new allocation policy.

An outbox/job record makes pending work recoverable after an API crash. Webhooks,
workers and reconciliation scans can repeat; each effect has durable uniqueness.
“Payment queued” is meaningful only if recoverable work has actually been persisted.

### Reservation expiry and cancellation

Expiry is a state transition performed with the inventory release in one transaction.
It checks database time and the current reservation state/version. Cleanup latency
may delay stock becoming available, but checkout must not silently consume an expired
hold because cleanup has not run yet.

Cancellation checks eligibility and records intent once. It releases only allocations
that remain releasable and records any payment compensation work. Fulfillment progress
and provider state determine the allowed action; changing a status string alone does
not implement cancellation or refund.

### Recommendations and reviews

An initial recommendation batch counts eligible co-purchases over a defined window,
excludes cancelled/refunded activity as policy requires, and publishes a complete
versioned top-K set. It needs neither a GPU nor a new online model merely to serve
item-to-item lookups. Incremental updates become useful when freshness or batch cost
justifies them, not because all real-time recommendations require expensive ML.

Reviews enforce one intended contribution per buyer/product through a database key,
validate purchase evidence for the badge, and count helpful votes by voter identity.
Rating projections can be asynchronous. Missing recommendations or stale rating
summaries should not prevent the primary product and purchase controls from loading.

## Database Schema

The complete executable local schema, including indexes and foreign keys, is
[backend/src/db/init.sql](./backend/src/db/init.sql). It is the source of truth for
what runs locally; the following table identifies its boundaries and missing rules.

| Local table | Keys and contents | Important current constraint/limitation |
|-------------|-------------------|-----------------------------------------|
| `users` | Serial ID, unique email, password hash, role | Role value check; no seller onboarding workflow |
| `sellers` | ID, user reference, business details | No unique `user_id`; seed can create duplicates |
| `categories` | ID, unique slug, parent reference | Self-reference does not prevent cycles |
| `warehouses` | ID, address, active flag | No unique name; repeated seed adds rows |
| `products` | ID, seller/category, unique slug, decimal price, images, JSON attributes | No separate SKU/offer model or price version |
| `inventory` | Composite product/warehouse key, quantity/reserved counters | Counters are nullable and have no nonnegative/availability checks |
| `cart_items` | ID, unique user/product pair, positive quantity, expiry | No warehouse allocation identity or reservation state |
| `orders` | ID, owner, totals/addresses, order/payment/archive statuses | Status value checks only; `idempotency_key` has a nonunique index |
| `order_items` | Order/product references, title/price/quantity snapshot | Product may become null; no warehouse allocation |
| `reviews` | Product/user/order references, rating, helpful count | Rating check, but no unique buyer/product or voter table |
| `product_recommendations` | Product/recommended-product/type composite key | Upserts do not replace an entire recommendation generation |
| `idempotency_keys` | Global key PK, status, request/response JSON | No enforced account/payload binding or atomic order commit |
| `audit_logs` | Actor/resource/context and old/new JSON | Ordinary mutable table, not tamper-evident storage |
| `orders_archive` | Serial ID, order ID and JSON snapshot | No unique source-order key; same PostgreSQL instance |
| `sessions` | ID, owner, data and expiry | Unused by auth; actual sessions are in Valkey |
| `search_logs` | Query/filter/count/latency fields | Table and cleanup exist, but search does not insert records |

Product/category/seller and order/user/status indexes support local lookups. The
product GIN index covers the English text expression used by fallback search.
The inventory primary key starts with product ID; a warehouse-only workload may
need a separate index. A composite index is not equally efficient for every suffix.

### Proposed correctness additions

The production model needs explicit reservation and attempt records. An illustrative
schema for those additional concepts is below; it is **not applied by the local init
script** and requires integration with the existing write paths and data cleanup.

```sql
CREATE TABLE checkout_attempts (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  client_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  quote_version TEXT NOT NULL,
  order_id INTEGER UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, client_key)
);

CREATE TABLE stock_reservations (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES checkout_attempts(id),
  product_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('held', 'consumed', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  FOREIGN KEY (product_id, warehouse_id)
    REFERENCES inventory(product_id, warehouse_id),
  UNIQUE (attempt_id, product_id, warehouse_id)
);
CREATE INDEX stock_reservations_expiry
  ON stock_reservations(expires_at) WHERE status = 'held';

CREATE TABLE payment_operations (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES checkout_attempts(id),
  operation_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('authorize', 'capture', 'void', 'refund')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'unknown', 'succeeded', 'failed')),
  provider_reference TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_events_pending
  ON outbox_events(created_at) WHERE published_at IS NULL;
```

Also require nonnull counters and `0 <= reserved <= quantity` on inventory after
reconciling existing data. Allocation writes must check available units at the same
serialization point as their change. Constraints catch invalid state; they do not
assign warehouses or reconstruct the correct reservation owner automatically.

Use integer minor units plus currency, or a deliberate decimal-money representation,
for production calculations. The local code parses decimal prices into JavaScript
floating-point numbers and hardcodes tax/shipping; its totals are demo rules.

## API Design

The local API uses `/api`, not a versioned prefix. Proposed production contracts
add quote versions, stable attempt identity and structured recoverable errors.

| Method | Local endpoint | Current purpose |
|--------|----------------|-----------------|
| POST | `/api/auth/register`, `/login`, `/logout` under `/api/auth` | Account/session operations |
| GET | `/api/auth/me` | Current user |
| PUT | `/api/auth/profile` | Update name |
| GET | `/api/products`, `/api/products/:id` | List and detail |
| GET | `/api/products/:id/recommendations` | Co-purchase suggestions |
| POST / PUT / DELETE | `/api/products`, `/api/products/:id` | Seller/admin creation/update, admin deletion |
| PUT | `/api/products/:id/inventory` | Set a warehouse quantity |
| GET | `/api/categories`, `/api/categories/:slug` | Category tree/detail and breadcrumbs |
| POST / PUT / DELETE | `/api/categories`, `/api/categories/:id` | Admin category changes |
| GET | `/api/search`, `/api/search/suggestions` | Search and title suggestions |
| GET / POST / DELETE | `/api/cart` | Read, add a line, clear |
| PUT / DELETE | `/api/cart/:productId` | Change/remove a product quantity |
| GET / POST | `/api/orders` | History and checkout |
| GET / POST / PUT | `/api/orders/:id`, `/:id/cancel`, `/:id/status` under `/api/orders` | Detail, customer cancellation, admin status change |
| GET / POST | `/api/reviews/product/:productId`, `/api/reviews` | Read/create reviews |
| PUT / DELETE / POST | `/api/reviews/:id`, `/:id/helpful` under `/api/reviews` | Edit/delete or vote helpful |
| GET | `/api/admin/stats`, `/orders`, `/users`, `/inventory` under `/api/admin` | Administrative reports |
| PUT / POST | `/api/admin/users/:id/role`, `/api/admin/sync-elasticsearch` | Role change and manual indexing |

Example proposed checkout input includes an account-scoped attempt key, quote version,
shipping address and a provider payment reference. A stock/price conflict returns a
revised quote; an unresolved provider outcome returns the existing attempt and a
status lookup path. Neither response asks the client to silently submit a new purchase.

## Key Design Decisions

### Short checkout holds versus reserving every cart addition

Checkout holds protect a buyer during payment while allowing ordinary browsing and
abandonment without tying up inventory. Cart-time holds can be appropriate for a
product that explicitly promises a shopping window, but require quotas, expiry and
renewal rules. Otherwise bots or casual additions can withhold scarce stock from
ready buyers. The checkout-only choice gives up a guarantee that a cart item will
still be available when the user decides to buy; the UI must say so.

### Atomic stock authority versus read-then-write checks

An atomic conditional update or locked allocation transaction makes one contender
observe another's allocation before accepting the last unit. Reading a sum and
later decrementing it does not preserve that property under ordinary concurrent
transactions. Row locks cost contention and can deadlock across several items;
consistent lock ordering, bounded retries and admission control manage that cost.
Optimistic versions still serialize conflicting writes and can cause retry storms.

### Durable checkout state versus a cache-only duplicate guard

A database attempt record committed with its order lets a retry recover the durable
outcome. A separate Redis marker can disappear, suppress unfinished work, or report
processing forever after a crash. Redis remains useful for acceleration but cannot
replace account binding, request comparison and an atomic durable decision.
Payment requires another idempotency/reconciliation boundary at the provider.

### Bounded search degradation versus unlimited fallback

An index supports independent scaling and relevance tuning; PostgreSQL can also do
text search and aggregation. The choice is about workload isolation and cost, not
an assertion that SQL cannot compute facets. Routing a large ES outage into the same
unbounded database pool as checkout can turn one failure into two. A reduced fallback
with capacity limits trades search richness/availability for transaction protection.

## Consistency and Idempotency

The proposed system has several distinct guarantees:

- **Stock allocation:** one atomic decision at the authoritative warehouse/offer record.
- **Checkout identity:** one account/payload-bound attempt resolves to one order.
- **Payment operation:** provider idempotency plus reconciliation of unknown outcomes.
- **Event effects:** repeated delivery is safe through consumer-specific durable identities.
- **Read projections:** versioned, eventually consistent and never accepted as purchase authority.

Do not call the entire network “exactly once.” A response can be lost after commit,
a broker can redeliver, and a provider can complete after a timeout. State and identity
make those situations recoverable without claiming that messages never repeat.

## Security / Auth

The production proposal uses protected session cookies with server-side revocation,
CSRF defenses where needed, role and resource checks, and rate/admission limits for
login, catalog scraping and checkout. Seller role alone is insufficient: a mutation
must also target an offer that seller owns. Private order/attempt caches include
authorization context and cannot return another account's response by key alone.

The local session token instead lives in browser localStorage and is sent as a header.
It is readable by application JavaScript; there is no cookie-based auth or database
session fallback. Production payment details should be tokenized by the provider.
Retention periods require product/jurisdiction-specific review, not a universal
seven-year claim copied from a helper's comment.

## Observability

Measure allocation rejection separately from system errors, quote changes separately
from payment failures, and durable pending payments separately from confirmed sales.
Track unresolved-attempt age, outbox lag, replay failures, expiry backlog, search mode
and client-visible errors. A registered but unwritten counter proves nothing.

Logs use a consistent correlation identity across API, job and provider references,
with private addresses and payment material excluded. Critical audit events belong
in the same durable transaction as the state they describe, or a recoverable outbox.
An ordinary SQL audit table needs access controls and a tamper-evidence strategy if
that is a requirement; a filename or comment does not provide one.

## Failure Handling

| Failure | Proposed behavior |
|---------|-------------------|
| Last-unit contention | One allocation succeeds; others get a stock conflict without negative counters |
| Response lost after order commit | Retry/query the same attempt and recover the existing order |
| Provider timeout | Mark outcome unknown, reconcile using the same provider operation identity |
| Cancellation races with payment | Conditional transitions and compensation preserve both ledgers |
| Expiry worker repeats work | Release only a still-held reservation, once, with its stock update |
| Elasticsearch fails | Bound fallback work and expose supported degraded search behavior |
| Redis fails | Durable checkout identity remains available; auth/cache failure policy is explicit |
| Index worker receives old event | Ignore older versions or rebuild from authoritative current state |

Set deadlines for dependencies and bounded retry budgets. Retry only operations
whose durable outcome is understood; a connection reset during commit is ambiguous.
A circuit-breaker fallback must preserve the business contract, not fabricate a
success or claim that work was queued when no durable queue entry exists.

## Scalability Considerations

Separate catalog read capacity, checkout writes and background analytical work.
Cache public metadata with explicit freshness policies; validate volatile price and
stock at checkout. Pagination should have bounded depth and stable ordering. Search
snapshots/cursors become useful as offset costs and concurrent index changes grow.

For a hot offer, queue admission or serialize allocations through a single authority.
A queue controls contention but does not create stock or guarantee correctness on
its own. Partitioned inventory needs ownership/fencing during failover; multi-region
read replicas cannot independently allocate the same units.

As a multi-item checkout spans shards, coordinate reservations with durable progress
and compensation. Avoid introducing that distributed workflow while one database can
still handle the transaction. Warehouse allocations and order snapshots give a future
fulfillment service explicit records rather than reverse-engineering counter changes.

Recommendations can use incremental order events and bounded windows. Archive data
only with a tested retrieval and deletion policy; copying JSON into another table on
the same database does not inherently reduce hot rows or provide cold storage.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Hold timing | Short checkout allocation | Reserve all cart additions | Limit stock withheld by browsing/abandonment |
| Stock correctness | Atomic warehouse allocation | Unlocked aggregate check | Preserve last-unit invariant under contention |
| Checkout recovery | Durable attempt plus provider reconciliation | Cache-only duplicate flag | Recover unknown outcomes across failures |
| Search | Versioned index with bounded fallback | Unlimited primary-DB fallback | Isolate browsing load from purchase writes |
| Recommendations | Versioned co-purchase batch initially | Immediate per-event serving updates | Simple baseline with explicit freshness cost |

## Implementation Notes

### What actually runs

One Express process contains every route and starts every interval job. PostgreSQL
is the source of cart/order/catalog data; Valkey stores sessions, product/category
caches, recommendation IDs and idempotency records. Elasticsearch is optional at
startup. There is no broker, outbox, payment worker, fulfillment worker or load balancer.

[README.md](./README.md) gives both infrastructure alternatives and the required SQL
seed before optional product seeding. The SQL seed creates multiple warehouses,
so the allocation bug below affects the supplied model, not only a future extension.

### Inventory and checkout implementation

[cart.ts](./backend/src/routes/cart.ts) reads summed availability and the current
cart line without row locks, then increments `reserved` for every warehouse row of
the product. Adding an existing line compares available stock to the full new cart
quantity rather than just the additional units. Inputs lack a complete finite,
positive-integer validation contract.

[orders.ts](./backend/src/routes/orders.ts) locks cart rows with `FOR UPDATE OF ci`.
It reads summed physical quantity without locking stock or subtracting other holds,
then subtracts the full line quantity from every matching warehouse. No conditional
stock predicate or database nonnegative constraint closes that race. Two different
buyers can pass the check before either decrement; a transaction alone does not
prevent overselling. Warehouse-specific allocation records do not exist.

The order transaction inserts price/title snapshots, clears the cart and commits
before the 100 ms payment simulation. It does not validate reservation expiry, active
product state or an accepted quote version. Tax is 8%; shipping is $5.99 below a $50
subtotal and free at or above it. Calculations use JavaScript floating point.

The payment breaker is real wiring; its fallback returns `queued: true` without
persisting work. Pending/failed payments are not reconciled or automatically released.
Successful payment unconditionally sets the order to confirmed, allowing a race with
customer cancellation. Customer cancellation locks the eligible order and restores
quantity across all warehouses, marks payment refunded without a provider call, and
returns the old payment field in its response. Admin status updates allow any value
from the list, with no transition validation or inventory/payment side effects.

### Resilience patterns actually connected

[shared/idempotency.ts](./backend/src/shared/idempotency.ts) uses Redis `SET NX` as its
primary claim and best-effort SQL persistence. The frontend sends no key, so the
server generates a fresh random key for each submission. Supplied keys are global:
stored account/body information is not compared before returning a prior response.
The `orders.idempotency_key` index is not unique.

On Redis errors, lookup/claim functions allow processing. Completion updates Redis
before PostgreSQL and is separate from order commit. A failed record's retry ignores
an unsuccessful new claim, and a crash can leave an attempt processing without a
recovery path. These helpers do not provide durable exactly-once order/payment effects.

[shared/circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) is called only for
payment. Its options include:

```typescript
const paymentCircuitBreakerOptions = {
  timeout: 30000,
  errorThresholdPercentage: 30,
  resetTimeout: 60000,
  volumeThreshold: 3
};
```

This limits repeated calls to a failing dependency. It does not make the mock's
fallback a queue. Search/inventory breaker factories are unused; there is no connected
recommendation breaker. [shared/retry.ts](./backend/src/shared/retry.ts) wraps order
listing and the checkout database transaction, with three attempts and jitter for
selected SQL/network errors. Cart, cancellation and search are not wrapped by it.
Retrying a commit with an uncertain connection outcome still needs durable recovery.

### Search, caching and derived data

[services/elasticsearch.ts](./backend/src/services/elasticsearch.ts) uses a plain
boolean text/filter query, category/price/rating aggregations and offset pagination.
It has no brand facet, category-ancestor expansion, function-score ranking or breaker.
Errors become empty results. [routes/search.ts](./backend/src/routes/search.ts) falls
back only when that result is empty and `q` is nonempty, including valid empty searches.

The PostgreSQL fallback sorts by creation time by default, not text rank, drops the
rating filter, and places `HAVING` before `GROUP BY` when in-stock filtering is used.
Its count query omits stock filtering. No engine/degraded flag or `search_logs` insert
is returned/performed. These are limitations, not a guaranteed available search path.

Product creation/update attempts direct indexing; full synchronization is manual.
Updates lack joined category/seller/stock data and can overwrite indexed stock with
zero. Inventory/cart/order/rating writes do not reindex. Deactivation is not a search
filter, and bulk sync does not delete obsolete documents. Index helpers swallow
errors and bulk sync does not check per-item failures, so a success message is weak
evidence of a complete index.

Product detail caches for five minutes and categories for one hour. Cart data is
not cached in Redis. Product/category writes do not invalidate those caches; review
writes invalidate only the numeric product key, before asynchronous rating updates.
Redis errors can fail catalog reads rather than reliably falling back to PostgreSQL.

The detail query compares integer `p.id` and text `p.slug` to the same untyped `$1`,
creating a parameter-type conflict on the uncached path. PostgreSQL infers an omitted
parameter type from its first use; a numeric-ID/text-slug contract needs separate
handling. [PostgreSQL parameter typing](https://www.postgresql.org/docs/16/sql-prepare.html).

Recommendations run hourly, not nightly, after the first hour. They count all orders,
take ten peers, cache IDs/frequencies for 24 hours and upsert scores as frequency/100.
There is no eligibility/time window or removal of old peers. Cache hits still query
PostgreSQL for product data and do not preserve ranking explicitly. Neither path
filters inactive recommendations. Ratings aggregate at startup and every five minutes;
products with no remaining reviews are not reset to zero.

### Jobs, archival and diagnostics

[backgroundJobs.ts](./backend/src/services/backgroundJobs.ts) selects expired carts
outside each release transaction, every minute and at startup. It does not lock or
recheck expiry before deleting. Multiple APIs or a renewal/checkout race can release
another hold or delete a renewed line. The daily archival runner has a second cleanup
path that deletes cart lines before separate stock-release writes.

[shared/archival.ts](./backend/src/shared/archival.ts) runs every 24 hours from startup,
not at a fixed clock time. It attempts to set `shipping_address = NULL`, violating
the supplied schema's NOT NULL constraint and rolling back each archive transaction.
It would leave original order/items rows present even after that mismatch is fixed.
The unused retrieval helper also parses an already-decoded JSONB value again. Audit
archival only counts/logs eligible rows; there is no object-store archive. Seven-year
anonymization clears some fields but does not anonymize every linked copy/account.

Hourly idempotency cleanup and its initial five-second run are wired. Session cleanup
targets an unused SQL table. No leader election, interval-overlap control or job drain
is supplied; shutdown handlers call `process.exit` directly.

Pino request logs, HTTP metrics, order/payment audit calls and payment-breaker metrics
are connected. Request middleware generates two correlation IDs when none is supplied,
and runs before auth, so request logs do not automatically have the fresh user ID.
HTTP route labels omit router mount prefixes and can merge unrelated endpoints.
Cart/search/oversell/database-duration instruments are declared but not updated by
their business paths. Audit writes occur after business commits, swallow errors, and
are not immutable or transactionally guaranteed.

Readiness checks PostgreSQL and Valkey. Detailed health checks are sequential without
the documented two-second wrapper; ES exceptions do not degrade overall status, while
a red cluster does. The separately registered `/api/admin/retention-stats` route lacks
`requireAdmin` and is reachable before the guarded admin router.

### Frontend behavior and omitted production work

The frontend is a client-rendered React app with file routes, `useEffect`/fetch and
two Zustand stores. It has no TanStack Query, virtualized list, server rendering,
cart drawer, saved-address flow, XState, React Hook Form or offline persistence.
Search pages show twenty results; category pages show the first twenty and order
history the first ten without UI pagination.

[api.ts](./frontend/src/services/api.ts) serializes optional search fields without
omitting `undefined`, producing literal `category=undefined` and similar filters.
[search.tsx](./frontend/src/routes/search.tsx) writes min/max price through two separate
navigations from the same prior state. Results/suggestions are not guarded against
late responses; failures can leave old results or show a misleading empty state.

Cart mutations replace the complete local snapshot after the server response. There
is no cart version, mutation ordering or account-generation guard. Logout does not
clear the cart store, and checkout does not refresh its badge. Cart/checkout initially
render “empty” before reads finish; cart errors are stored but not displayed there.
The UI does not show reservation expiry, and stock counts exclude the buyer's own
hold when building quantity options.

Product loading waits for recommendations before committing primary data, then reads
reviews. Route changes do not reset image/quantity state or cancel older responses.
There is no review-authoring screen. Cancellation replaces the order with a response
without items and with stale payment status. Form labels, nested card controls and
suggestion keyboard behavior need accessibility work; no conformance audit is implied.

Real payments/refunds, fulfillment, tax calculation, rate limiting, seller resource
checks, safe stock allocation, durable payment recovery, outbox/CDC, scalable retention,
CDN/object storage, sharding and multi-region operation are omitted or incomplete.
This review checked source/configuration and a pure serialization example; it did
not start the stack, run application builds or establish passing runtime guarantees.
