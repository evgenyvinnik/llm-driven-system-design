# Amazon — Backend System Design

*A 45-minute discussion of inventory allocation, recoverable checkout and search projections.*

This is a proposed production design. The local implementation uses one Express
process, PostgreSQL, Valkey and Elasticsearch, with simulated payment and incomplete
correctness guarantees; see [architecture.md](./architecture.md).

## 📋 Establish the purchase contract — 4 minutes

> “I would separate the browsing promise from the purchase promise. Search may show
> a slightly old price or stock estimate, but accepting an order requires an
> authoritative allocation and a recoverable payment decision.”

The core flows are product discovery, cart management, checkout, order history and
cancellation. Sellers update their own offers; administrators handle exceptions.
Reviews and recommendations enrich discovery but should not block purchasing.

I would clarify when inventory is held. For this proposal, an ordinary cart is intent;
a short hold begins at checkout. If the product specifically promises cart-time
reservations, the same allocation machinery applies with different expiry and abuse
controls, but that promise must be explicit.

Assume one hundred million offers, ten million daily active buyers and one million
orders/day. That averages about 11.6 orders/second. I would plan for a hypothetical
1,000/second sale peak and 50,000 searches/second, then validate those assumptions.

At roughly 3 KB per order with lines, order data grows about 3 GB/day before indexes
and replicas. Catalog metadata at 5 KB per offer is around 500 GB. Images belong in
object storage and have a separate capacity budget.

These averages conceal the hard case: thousands of buyers competing for one offer.
The design must handle that concentrated contention even if overall write throughput
looks modest.

Proposed targets are 99.99% browsing availability, 99.9% checkout availability and
bounded search below 200 ms at p95. External payment authentication may take longer
than an API response budget; acceptance and final confirmation are separate outcomes.

## 🏗️ Draw ownership boundaries — 5 minutes

```
┌──────────────────┐       ┌──────────────────┐
│ Storefront/API GW│──────▶│ Catalog/search   │────▶ Search index
│ Auth, admission  │       │ Read projections │────▶ Read cache
└─────────┬────────┘       └────────▲─────────┘
          │                        │
          ▼                        │ Versioned events
┌──────────────────┐       ┌───────┴──────────┐
│ Cart + checkout  │──────▶│ Stock/order DB   │
│ Quote, attempt ID│       │ Attempts, outbox │
└─────────┬────────┘       └────────┬─────────┘
          │                        │ Durable work
          ▼                        ▼
┌──────────────────┐       ┌──────────────────┐
│ Payment workflow │◀─────▶│ Workers / replay │
│ Provider calls   │       │ Index / recs     │
└─────────┬────────┘       └──────────────────┘
          ▼
┌──────────────────┐
│ Payment provider │
│ API + callbacks  │
└──────────────────┘
```

Initially, cart, stock and order modules can share a PostgreSQL transaction boundary.
I would not introduce a distributed reservation saga merely to make the service
diagram look larger. The ownership boundaries allow that evolution when necessary.

Each warehouse/offer allocation has one authoritative writer. Read replicas and
search indexes can serve observations of stock, but cannot independently sell the
same units during a partition.

A transactional outbox records work with the state change that created it. Workers
publish/index/notify independently, using replay and idempotent effects. This closes
the gap between a committed order and a process crash before its event is sent.

A payment coordinator calls the provider outside the database transaction. The order
and provider cannot be made atomic by keeping a row lock open during a network call.

## 💾 Data model and API — 4 minutes

| Record | Key contents and invariants |
|--------|-----------------------------|
| Offer | Product, seller, price/currency, catalog version and active state |
| Inventory | Offer/warehouse key, remaining quantity and held quantity; nonnegative available stock |
| Cart | Buyer, lines and version; purchase intent, not an allocation |
| Quote | Item/price/shipping/tax snapshot, version and validity policy |
| Checkout attempt | Buyer-scoped client key, request fingerprint, quote and resulting order |
| Reservation | Attempt, offer, warehouse, units, expiry, state and version |
| Order and lines | Buyer, price/title snapshots, fulfillment and payment references |
| Payment operation | Stable operation key, kind, provider reference and known/unknown outcome |
| Outbox event | Event identity, aggregate/version and delivery progress |

Indexes follow access patterns: buyer/time for history, offer/warehouse for allocation,
expiry for held reservations, and pending-work time for outbox processing. A stock
index starting with offer ID does not automatically optimize warehouse-only reports.

| Method | Proposed operation | Important contract |
|--------|--------------------|--------------------|
| GET | Product/search results | Bounded pagination and explicit filter/freshness semantics |
| PUT | Cart line | Absolute desired quantity plus cart version |
| POST | Checkout quote | Authoritative price and availability validation |
| POST | Checkout attempt | Stable buyer-scoped key and accepted quote |
| GET | Attempt/order status | Recover outcome after a timeout or reload |
| POST | Cancellation | Conditional lifecycle transition and durable compensation |

I would avoid designing an endpoint for every internal table. The useful public
contract is what a caller can safely retry and how it discovers the current outcome.

## 🔧 Deep dive 1: Allocate the last unit correctly — 8 minutes

### Decision: explicit warehouse allocations at one serialization point

> “The invariant is that accepted allocations never exceed available stock. A
> reservation column is useful bookkeeping, but the guarantee comes from how every
> writer changes it, including expiry, cancellation and admin adjustments.”

For a single warehouse, an atomic conditional update can reserve units only when
sufficient availability remains. For several lines/warehouses, use a short transaction
that locks the needed records in a stable order, checks the invariant and records
which units were allocated where.

A reservation record identifies the attempt, offer, warehouse, quantity and state.
The counters summarize those records; they should be reconcilable. A negative counter
or mismatch is an error to investigate, not something to hide by clamping it to zero.

### Why not read total stock and then decrement it?

Two buyers can both read one remaining unit before either writes. Their individual
cart locks do not conflict because they belong to different accounts. Later updates
may serialize, but an unconditional decrement still lets both transactions succeed.

The stock condition must be evaluated at the serialization point. Database constraints
provide another defense, but they do not choose the right warehouse or tell us which
reservation should own the units.

If two warehouses each hold five units and an order needs three, subtracting three
from both warehouses consumes six. Summing availability does not define an allocation
plan. Record the chosen distribution and use it again for consumption/release.

### Expiry competes with checkout

A checkout hold expires according to server/database time. Cleanup claims a still-held,
expired reservation and releases its units in the same transaction as the state change.
Repeating cleanup then sees it already released and does not decrement again.

Checkout competes through the same state/version rule. An expired hold cannot be
consumed merely because the cleanup worker has not reached it. We either obtain a
new valid allocation or return a stock conflict.

A worker selecting expired carts outside a transaction and deleting them later can
remove a renewed line or release units after another path consumed them. The selection
is only a candidate list; the transition must re-check authoritative current state.

### Why hold at checkout rather than every cart addition?

A short checkout hold protects the payment interaction while reducing stock withheld
by casual browsing and abandonment. Cart-time holds can create artificial shortages
when many shoppers add an item they never intend to purchase.

The cost is that a shopper may lose availability between adding to cart and checking
out. I would communicate that and keep the checkout conflict useful: identify the
unavailable line and preserve the rest of the shopper's intent.

If a product requires a cart reservation promise, enforce per-account limits, renewal
rules and an expiry window. A long TTL does not fix contention; it increases the
amount of time stock can be unavailable to ready buyers.

### Contention and scaling costs

Row locks serialize hot writes, so requests need deadlines and bounded admission.
Consistent lock ordering reduces deadlocks for multi-item carts. Retry genuine
transaction aborts with jitter, but do not retry indefinitely under a flash-sale storm.

Optimistic versions are a valid alternative at lower conflict rates. They still
serialize conflicting commits and may cause many failed attempts on the last unit.
The choice is about measured contention and retry cost, not “optimistic always faster.”

At higher scale, a per-offer allocation queue can control demand. It must preserve
stable identities and durable outcomes; the queue itself does not enforce inventory.
Partitioning a hot offer needs allocated quotas or another single authority, not
independent copies of the same available balance.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Atomic allocation with explicit warehouse records | Preserves stock and makes release/reconciliation explainable | Contention, ordering and allocation-state complexity |
| ❌ Unlocked aggregate read then unconditional updates | Simple sequential demo | Overselling and incorrect multi-warehouse accounting |

## 🔧 Deep dive 2: Recover checkout across the database/provider boundary — 8 minutes

### Decision: durable attempt identity and payment reconciliation

> “I would promise that one unchanged checkout attempt resolves to one order, and
> that each provider operation is recovered safely. I would not promise that a
> distributed request is delivered exactly once.”

The client supplies a stable key for the accepted intent. The server scopes it to
the buyer and compares a request fingerprint, including the quote and relevant
purchase details. The same key with different contents is a conflict.

Within the order transaction, create or lock that attempt, reserve stock, snapshot
the order and persist work for the payment coordinator. A duplicate returns the
existing attempt/order or its pending state. A crash after commit does not erase
the relationship between the key and the order.

Keep prices in a deliberate money representation with currency and rounding rules.
A quote change needs customer acceptance; the retry key must not silently cover a
new amount that was never reviewed.

### Why not make Redis the primary duplicate guard?

If Redis marks processing before the order commits, a crash can strand an unfinished
attempt. If the order commits first, a crash before the cache update can allow another
attempt. Independent writes do not become atomic because their normal latency is low.

A cache hit also needs account and payload binding. Returning a response solely by a
global caller-supplied key risks exposing another buyer's order or applying the wrong
intent. Fast lookup is useful only after the contract is correct.

Redis can accelerate durable lookup, but database uniqueness/transactions establish
the invariant. The cost is a persistent attempt table, retention policy and recovery
logic. For purchases, those are fundamental records rather than optional optimization.

### Provider calls happen outside stock transactions

Create a stable provider operation identity before the network call. Authorization,
capture, void and refund are different operations with separate progress. The exact
capture point is a business decision; it is not implied by receiving an order request.

If the provider times out, its outcome is unknown. Query the provider or process its
authenticated callback using the same operation reference. Do not immediately create
a new charge or assume that rollback of PostgreSQL would undo external payment.

The coordinator can retry safe operations within the provider's contract. After a
process restart, durable pending/unknown records identify work to reconcile. A
periodic scan backs up event delivery so a missed callback does not strand the order.

### Payment and cancellation can race

Suppose an owner cancels while payment authorization is in flight. Cancellation
records a conditional transition and any compensation required. A late success must
check that state before confirming the order.

If stock was released, the system cannot blindly confirm against the old allocation.
It either follows an explicit reallocation policy or voids/refunds the authorization.
The frontend sees the current state, including compensation pending when necessary.

Similarly, fulfillment transitions need eligibility rules. An admin accepting any
status string can reopen a cancelled order without restoring its payment/allocation
history. Administrative exceptions still require domain operations and an audit trail.

### Events and audit share the durability boundary

Write an outbox event with each committed business change. Publication can repeat;
consumers deduplicate by event and effect identity, and reject obsolete versions.
A notification consumer and a fulfillment consumer do not share one global “seen”
flag that lets the first consumer suppress the other.

Critical audit records should be transactional or recoverable through that outbox.
Best-effort logging after commit is useful diagnostics, but may miss the very event
we need to explain an incident. Tamper evidence requires more than a table name.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Durable attempt plus provider-operation recovery | Handles duplicate delivery and ambiguous results | Pending states, reconciliation and compensation |
| ❌ Cache flag plus synchronous payment assumption | Short happy-path checkout | Crash windows and no reliable answer after a timeout |

## 🔧 Deep dive 3: Search is a projection with a failure budget — 8 minutes

### Decision: versioned indexing and bounded degraded search

> “I would let search be eventually consistent because discovery tolerates a little
> delay. I would never let an old search document authorize a price or stock sale.
> That separation makes independent read scaling possible.”

The authoritative catalog emits versioned changes through the outbox. Index workers
project product text, categories, price, rating and stock summaries. Inventory and
rating changes need projection updates too; indexing only product edits leaves
important fields stale indefinitely.

Workers handle retries and out-of-order events. A product version or authoritative
re-read prevents an older event from replacing newer data. Deletion/deactivation has
a defined tombstone/removal path, including during full index rebuilds.

### Why not query the transactional database for every search?

PostgreSQL can perform text search and aggregations. At large search volume, separate
index capacity gives us workload isolation and specialized relevance tuning without
competing directly with allocation transactions.

The price is another data model and a synchronization pipeline. We need lag metrics,
rebuild tooling and parity tests for filters, not just a script that logs how many
products it attempted to send.

A bulk indexing response may contain individual failures. Check those results and
retry/reconcile them. A top-level successful HTTP call is not proof that every document
was accepted. A rebuild must also remove obsolete documents, not only upsert survivors.

### Search and facets form one contract

Normalize filters and bound request cost, pagination depth and aggregation sizes.
Use stable ordering; large offset pages eventually need a cursor/search snapshot
strategy if deep browsing is a real requirement.

Decide whether each facet count includes its own selected filter. The frontend needs
that meaning and explicit range values, not labels it must parse back into query
parameters. Results and counts should describe the same filtering contract.

A category hierarchy also needs a decision: exact-category matching or descendant
expansion. A parent category's count cannot silently mean something different from
the product list shown when the user selects it.

### Why not fall back whenever search returns zero products?

An empty result can be correct, including an out-of-range page. Treating emptiness as
an outage mixes relevance engines and can change results, counts and filters between
pages. Failures and valid empty results need distinct response states.

On an Elasticsearch failure, a limited PostgreSQL fallback can preserve supported
text and basic filters. It needs its own concurrency budget and query deadline.
At tens of thousands of searches per second, unrestricted fallback can overload the
same database whose checkout availability we intended to protect.

If capacity is exhausted, return a useful temporary search limitation or cached
public result where appropriate. Availability is bounded by real resources; a fallback
does not guarantee that search can never fail.

### Cache and recommendation boundaries

Cache public product descriptions longer than volatile stock. Invalidate/version the
relevant entries when catalog changes commit, and account for old fills arriving after
invalidation. A TTL limits some staleness but is not a complete synchronization protocol.

Start recommendations with a co-purchase batch over eligible orders and a defined
window. Publish a complete versioned top-K set so old peers disappear when no longer
eligible. Cache IDs/ranking, then hydrate only active products without losing order.

A batch trades freshness for operational simplicity. Incremental updates can improve
freshness without requiring GPUs or a complex online model. Choose them when the
batch window or product needs justify the extra event/state machinery.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned index and bounded fallback | Independent read scale with controlled degradation | Projection maintenance and explicit consistency limits |
| ❌ Manual copies and unlimited fallback | Easy initial setup | Stale fields, obsolete documents and cascading database load |

## 📈 Operations, security and scale — 4 minutes

Protect APIs with session validation, resource ownership and admission controls.
Seller role is not authorization to update every seller's offer. Private attempt and
order lookups bind to the authenticated buyer; administrative diagnostics also need
an explicit access policy.

Measure stock conflicts separately from server faults. Track held/consumed/released
balance, unresolved payment age, outbox/index lag and fallback saturation. Declared
counters that no business path updates do not establish that overselling never occurred.

Partition when measured pressure requires it. Multi-item checkout across independent
stock shards introduces durable coordination and compensation; keep the single-database
transaction while it is sufficient. Failover must fence old stock writers before
another writer allocates the same balance.

Retention needs a tested lifecycle: eligibility, archive write, retrieval, removal and
all relevant copies. A JSON archive table in the same PostgreSQL instance is not
inherently cold storage or a smaller hot table. Requirements depend on the data and
applicable obligations; there is no universal retention duration for every storefront.

## ✅ Verify the invariants — 4 minutes

I would prioritize adversarial sequences rather than only happy-path route tests:

1. Two buyers compete for the last unit and across several warehouses.
2. A hold expires while checkout, renewal or cancellation tries to change it.
3. Multiple workers repeat expiry and event delivery.
4. The API loses its connection during commit, then receives the same attempt again.
5. The provider succeeds before a timeout, or sends success after cancellation.
6. Index events arrive out of order and a bulk response contains partial failures.
7. Elasticsearch fails under load while checkout still needs database capacity.

Also test account/payload binding for idempotency keys, seller ownership, quote changes,
and restoration of archived orders. Verify invariants in the durable records, not
only the HTTP status returned by the first request.

The local repository exposes these learning points clearly: cart and stock checks
are not atomic, the order key is not unique, payment fallback has no worker, and
search bypasses the breaker helper. Those gaps are documented as current behavior,
not hidden behind the production diagram.

> “The design scales by separating read projections from purchase authority. Its
> correctness comes from explicit allocation records, durable attempt identity and
> recoverable external effects. That gives us a clear answer when a buyer asks what
> happened after an ordinary network failure.”
