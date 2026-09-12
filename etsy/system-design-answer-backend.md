# Etsy Marketplace — Backend System Design

> “I would separate discovering a product from claiming its inventory. Search can be
> slightly stale. A purchase of the last vintage item needs one authoritative owner, and a
> payment timeout needs a durable state we can reconcile.”

This is a proposed 45-minute system design interview. The figures are sizing assumptions,
not real Etsy traffic or local benchmarks. I would begin with one transaction region and
expand the design only when a measured bottleneck requires it.

| Discussion | Minutes |
|------------|---------|
| Requirements and estimates | 5 |
| Architecture and data model | 7 |
| Deep dive: scarce inventory and basket holds | 9 |
| Deep dive: payment, retries, and seller orders | 10 |
| Deep dive: search as a maintained projection | 8 |
| Operations and scaling | 4 |
| Implementation boundary | 2 |

## 🎯 Requirements and Estimates — 5 minutes

“I will support seller listings, keyword search with filters, favorites, a persistent cart,
and one buyer purchase containing products from several shops. Sellers fulfill their own
orders independently.”

I would clarify whether every listing is unique. I assume some vintage items have one unit
and handmade products can have several. The stock model must handle both without making a
special branch for every unique product. Variants, auctions, personalized production, and
seller payouts are outside the first discussion.

A cart records intent and does not own inventory. Entering checkout creates a short,
versioned quote and attempts to hold all selected lines. If one line is unavailable, the
buyer chooses a revised basket before paying. We do not silently purchase only the remaining
products.

The system needs durable item/price snapshots, buyer order history, seller fulfillment
actions, and cancellation/refund reconciliation. A listing edit must not change the
historical record of what someone bought.

I would propose 99.9% monthly regional API availability, search p95 below 500 milliseconds,
and quote creation p95 below 500 milliseconds excluding provider payment time. These are
targets to validate. Under an inventory-authority outage, rejecting a new purchase is
preferable to accepting an unprovable claim on scarce stock.

| Sizing assumption | Implication |
|-------------------|-------------|
| 1 million daily active buyers, ten searches each | 10 million searches/day; about 116/s average and 1,160/s at 10× peak |
| 50,000 purchase attempts/day | About 0.58/s average and 5.8/s at 10× peak |
| Three lines and 1.5 shops per successful purchase | Up to 150,000 line claims and 75,000 seller orders/day if all attempts convert |
| 10 million listings, 2 KiB indexed source each | About 19 GiB before index structures and replication |
| Four 300 KiB image derivatives per listing | About 11.2 TiB before originals and retained versions |

Search and images dominate ordinary read load. Inventory contention is a different problem:
a promoted one-unit listing can receive thousands of attempts even when total checkout
traffic is small. I would size general services from aggregate traffic and separately
protect hot inventory keys.

## 🏗️ Architecture and Data Model — 7 minutes

“I would start with modular services backed by one transactional database. Separate
responsibilities do not require a separate database for each module on day one.”

```
┌──────────────────────┐      ┌──────────────────────┐
│ Clients / API gateway│─────▶│ Catalog and search   │
│ Session / rate limits│      │ Elasticsearch / cache│
└──────────┬───────────┘      └──────────────────────┘
           ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Cart / checkout      │─────▶│ PostgreSQL           │
│ Inventory / orders   │      │ State / receipts     │
└──────────────────────┘      │ Outbox               │
                              └──────────┬───────────┘
                                         ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Payment provider     │◀─────│ Durable workers      │
│ Webhook / status API │─────▶│ Payment / projections│
└──────────────────────┘      └──────────────────────┘
```

Catalog owns listing content, current seller eligibility, and listing versions. Checkout
coordinates the quote and stock hold. Orders preserve the buyer's purchase and per-seller
fulfillment records. Payment workers interact with a provider through stable operation
references. Search consumes committed catalog and availability changes.

PostgreSQL owns stock, purchases, and durable operation outcomes. Elasticsearch owns a
rebuildable discovery projection. Redis accelerates metadata and search reads and stores
sessions; it is not the sole record that prevents a second charge or a second stock claim.

Images go to object storage with derived public images behind a CDN. The API stores object
references and authorizes uploads. Serving originals from an API process would couple image
bandwidth and local disk persistence to checkout availability.

### Proposed data model

| Entity | Main fields / relationships | Important invariant |
|--------|-----------------------------|---------------------|
| User / shop | Buyer identity; shop owner and publication status | Seller actions require current ownership |
| Listing / stock | Shop, title, price, currency, sellable units, reserved units, version | No negative stock; committed reservations remain covered |
| Cart line | Buyer, listing, requested quantity, revision | Unique buyer/listing entry; no reservation implied |
| Purchase / quote | Buyer, accepted selection, totals, currency, expiry, state | Immutable accepted terms; one operation identity |
| Reservation line | Purchase, listing, quantity, state, expiry | Held, consumed, or released through guarded transitions |
| Seller order / item | Purchase, shop, fulfillment state, item/price snapshots | Each order belongs to one seller and the same purchase |
| Payment attempt | Purchase, provider reference, amount, status | Repeated requests refer to the same money operation |
| Operation receipt | Buyer, operation ID, request digest, state/result | Unique buyer/operation; conflicting payload reuse rejected |
| Outbox / effect receipt | Aggregate, version, event/effect ID, retry state | Committed work is replayable; effects are deduplicated |
| Favorite / review | Buyer and target; purchased line for review | One saved relation or eligible review per defined identity |

I would store payment amounts in integer minor units with explicit currency and agreed
rounding boundaries. Listing price changes advance a version. Quote acceptance binds to the
accepted amount rather than recalculating from whichever values happen to be cached at
payment time.

For ordinary reads, index listings by shop and category, orders by buyer/date and shop/date,
and pending work by state/due time. History queries need bounded pagination and stable
tie-breakers. I would avoid a per-order item query loop by fetching the page's item rows in
one batch.

### API boundaries

| Method | Proposed resource | Purpose |
|--------|-------------------|---------|
| GET | `/products/search` | Products, supported facets, applied filters, next cursor, degradation status |
| PUT | `/cart/lines/:id` | Change desired quantity against a cart revision |
| POST | `/checkouts` | Create versioned quote and all-line stock hold |
| POST | `/checkouts/:id/accept` | Accept quoted terms and initiate durable payment processing |
| GET | `/purchases/:id` | Recover payment and seller-order state |
| POST | `/orders/:id/cancel` | Guarded cancellation with visible refund progress |
| PUT | `/seller/listings/:id` | Ownership-checked, versioned listing/stock update |

These are proposed contracts, not an inventory of local routes. The key point is that
creating work, confirming payment, and fulfilling seller orders are distinct operations with
distinct responses.

## 📦 Deep Dive: Scarce Inventory and Basket Holds — 9 minutes

“I choose a short database reservation at checkout entry. I will not keep a database
transaction open while the buyer fills a form or while a payment provider responds.”

### The last-item race

Suppose a vintage lamp has one available unit. Two buyers read a search result showing one
unit and each save it. Both carts are valid intentions. At checkout, only one reservation
may succeed.

A read followed by a later unconditional decrement is insufficient, even if the decrement is
inside a transaction. Both buyers can read one before either writes. The database serializes
the writes, but subtracting one twice still produces negative stock unless the claim checks
current state.

I would obtain the selected stock rows in a consistent ID order inside a short transaction.
Validate listing/shop eligibility, current prices, requested positive quantities, and
unreserved availability. Record the quote, reservation lines, and stock counter changes
together. A failed line aborts the complete basket attempt.

The database enforces nonnegative counters, and the application checks that every expected
claim succeeded. Constraints catch invalid states; the guarded claim decides which buyer
wins. Seller inventory adjustments participate in the same rules and cannot reduce physical
stock below committed reservations.

### Hold lifecycle

```
┌──────────────────────┐      ┌──────────────────────┐
│ Quote / active hold  │─────▶│ Payment claimed      │
│ Expiry controlled    │      │ Reconcile if unknown │
└──────────┬───────────┘      └──────────┬───────────┘
           ▼                            ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Released / expired   │      │ Consumed / confirmed │
│ Stock restored once  │      │ Seller orders created│
└──────────────────────┘      └──────────────────────┘
```

The initial hold might last five minutes. An expiry worker claims eligible unpaid holds and
releases their quantities exactly once through a guarded transition. A timestamp by itself
is not a worker, and deleting a Redis key is not proof that stock was restored.

Payment acceptance transitions the hold into a processing state with a bounded
reconciliation policy. An expiry worker must not release it concurrently with payment
confirmation. A late worker must check the current state and ownership/version before
applying any effect.

If a provider result remains unknown, we cannot simply release and sell the item again while
still allowing a late success to confirm the old purchase. We continue reconciliation or
record an explicit compensation decision. If money eventually succeeded after the purchase
became unfulfillable, refund work is tracked; the system must not manufacture inventory to
finish the old order.

### Why not reserve on add-to-cart?

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Short checkout reservation | Protects a serious buyer during payment | Expiry, contention, abuse limits, and unknown-payment handling |
| ❌ Reserve all saved carts | Early reassurance | Abandoned carts and bots can remove unique goods from discovery |
| ❌ Cache check followed by decrement | Simple fast path | Stale readers can both pass and oversell |
| ❌ Provider call inside stock transaction | Straight-line application flow | Slow external calls retain locks and exhaust connections |

I give up the promise that a saved cart secures stock. In return, browsing cannot
indefinitely block inventory. The UI must explain this boundary and preserve the buyer's
input when a hold fails.

For unusually hot listings, I would cap concurrent checkout attempts and use admission
control. Queuing can smooth load, but the database claim still decides ownership.
Exponential retries without a bound can amplify a flash crowd after the stock is already
gone.

A single database makes all-line holds feasible initially. If inventory is later sharded by
seller, I must either coordinate reservations across shards with explicit
partial-acquisition cleanup or change the product contract with buyer consent. Sharding is
not a transparent performance tweak for this invariant.

## 💳 Deep Dive: Payment, Retries, and Seller Orders — 10 minutes

“I choose a durable purchase workflow with a stable payment identity. The difficult case is
not a clean decline; it is a timeout after the provider may already have succeeded.”

### Commit intent before asking for an external effect

After the buyer accepts a live quote, one transaction records the accepted purchase state
and a payment outbox event. A worker picks it up and calls the provider with the same
reference on every retry. Network I/O happens outside stock-locking transactions.

If the provider gives a definitive decline, a guarded failure transition releases the
reservation. If it gives success, a guarded confirmation transaction consumes the held
stock, creates the seller orders and immutable item snapshots, and records the durable
purchase result. The exact provider operation may be authorization followed by capture; that
adds explicit states rather than changing the ownership rules.

A request timeout leaves an unknown result. The worker queries the provider by the stable
reference or waits for a verified webhook and retries reconciliation. Webhooks can be
duplicated or arrive out of order. Their event identity and the current payment state decide
whether they advance the purchase.

If the database is unavailable after the provider succeeds, the payment remains reconcilable
because its identity was stored before the call. We do not create a fresh purchase or
provider reference merely because a worker restarted.

### Durable idempotency

The API scopes operation IDs to the authenticated buyer and a canonical digest of the
accepted quote/body. The receipt has a unique database identity. Two identical retries
converge on the same purchase; a different payload using the same key is a conflict.

The receipt and the business state change live in the same transactional authority. Redis
may cache the result, but cache eviction cannot make the operation eligible to execute
again. Retention must cover retry and reconciliation expectations, with a stable purchase
record available afterward.

A response cache written after commit has a dangerous gap: the database may succeed and the
process may die before caching the response. A sixty-second Redis processing lock also
cannot protect an operation that runs longer than sixty seconds. Lease ownership and durable
state matter more than the apparent speed of the key lookup.

At the provider boundary, the same principle applies using the provider's supported
operation identity. I would verify its retry and retention semantics during integration. I
would not claim “exactly-once delivery”; delivery is repeatable, and guarded, deduplicated
effects preserve the business invariant.

### One buyer purchase, multiple fulfillment orders

I would reserve all selected lines before payment and create seller-order snapshots only
from the accepted quote. The purchase records the combined amount and each seller
allocation. Shipping is explicit per seller's quoted policy, not guessed by summing
arbitrary browser values.

Once confirmed, one seller can ship while another is still processing. Each seller sees only
their own order and necessary delivery information. The buyer sees one purchase with several
fulfillment groups and any group-specific refunds.

Cancellation needs more than a valid status string. It checks the current fulfillment
state/version, records the cancellation decision, adjusts stock only when the policy permits
it, and schedules a uniquely identified refund effect. Two concurrent cancellation requests
must not both return the same unit to stock.

A shipping update racing cancellation requires one legal winner. The loser reloads the
authoritative state and returns a conflict or the already-completed result. Historical
payment and refund records remain separate from the mutable fulfillment label.

### Trade-off and recovery example

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Durable workflow, receipts, reconciliation | Survives lost responses and worker restarts | Intermediate states, expiry coordination, compensation, and operational ownership |
| ❌ One SQL transaction around all work | Familiar atomic-looking code | SQL rollback cannot reverse a remote charge |
| ❌ Redis-only response deduplication | Low-latency replay | Cache loss, expiry, and commit gaps can permit repeated effects |

For example, a buyer pays for a necklace and a lamp from two shops. Payment succeeds, but
the confirmation worker crashes. The replacement worker finds the same accepted purchase,
verifies the same payment, and confirms the two orders once. It does not re-read a changed
cart and charge a different basket.

The cost is that the buyer sometimes sees “payment being checked.” That is a useful,
recoverable state. Hiding it behind a generic error is simpler code but pushes an unresolved
distributed operation onto the buyer.

## 🔎 Deep Dive: Search as a Maintained Projection — 8 minutes

“I choose an inverted index for discovery and keep PostgreSQL authoritative for purchase
eligibility. This lets browsing scale independently, provided we treat index maintenance as
durable work.”

### Retrieval and ranking

The index contains listing text, category and attribute fields, price, stock/publication
eligibility, seller reputation features, and an aggregate version. The query combines
lexical retrieval with exact filters. Title matches should have more influence than
incidental description matches.

Synonyms and typo tolerance improve recall, but broad expansions can reduce precision. A
search for a choker should not automatically treat every necklace as equivalent. I would
evaluate representative queries and zero-result cases before increasing expansion strength.

Reputation and freshness can adjust ranking without overriding relevance. Unbounded
sales-count boosts favor established sellers indefinitely. I would cap or normalize those
signals and measure how often new, relevant shops receive exposure. Personalization can
follow later; it is not required to make basic search useful.

Facets and totals need a documented scope. A stable tie-breaker and cursor avoid arbitrary
duplicates between pages. Search results can be slightly stale, so product detail and quote
creation revalidate the fields that affect purchase eligibility.

### Reliable indexing and cache freshness

A listing transaction commits its version and an outbox event together. The indexer applies
newer versions and ignores delayed older events. Deleted or unpublished listings require
tombstones, not merely the absence of a future update.

Stock consumption, cancellation restock, seller eligibility, and review aggregates also
affect indexed fields. They need committed events or an explicitly bounded refresh process.
A product-created event alone cannot maintain those values for the lifetime of the listing.

To rebuild, load a snapshot into a new index, replay changes after the snapshot boundary,
compare representative results and counts, then switch an alias. This avoids leaving the
only serving index empty while a large rebuild runs. Queue lag and oldest unprocessed events
reveal freshness problems before buyers report them.

Metadata and popular searches can use short cache TTLs. Cache keys include all normalized
filters, sort, locale/currency when relevant, and a schema/version namespace. Invalidation
should target the keys actually written and occur after commit through reliable work.

For expensive cache misses, bounded request coalescing or a short owner-token lock can
reduce duplicate work. A lock must have a deadline and safe release; a failed cache should
not trigger unbounded recursion or a stampede against PostgreSQL. Such locks optimize reads
and never grant inventory ownership.

### Degradation without changing the question

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Durable search projection | Rich retrieval and independent read scaling | Index lag, repair, versioning, and rebuild operations |
| ❌ Synchronous best-effort dual write | Small amount of application code | SQL can commit while the index update is lost permanently |
| ❌ Unlimited SQL fallback on outage | Keeps trying to answer every query | Search traffic can overwhelm the database needed for checkout |

A bounded fallback may offer simpler text matching while preserving price, category, and
eligibility filters. The response discloses unsupported ranking/facet features. If a
selected filter cannot be honored, it must not silently return a different question's
results.

A cache TTL limits how long a cached response survives; it does not limit staleness in the
underlying index. If an inventory update never reaches Elasticsearch, expiring the search
cache simply reloads the same stale document. That distinction determines whether we need a
cache adjustment or an indexing repair.

## 🛠️ Operations and Scaling — 4 minutes

I would instrument the journeys that establish correctness: stock-claim conflicts, hold
expiry lag, purchases stuck in unknown payment state, duplicate effects prevented, refund
backlog, and discrepancies between stock counters and reservation records. Search latency,
projection lag, fallback rate, and filtered-out stale hits explain discovery quality.

Count completed orders from committed outcomes. Incrementing a counter midway through a
transaction can report sales that later rolled back. Seller revenue must distinguish paid,
refunded, and cancelled amounts; summing every order header is not a revenue model.

Structured logs use purchase and event IDs for correlation while excluding passwords,
session tokens, and unnecessary delivery data. Metrics use bounded labels; shop IDs and
search text belong in controlled logs or analytics, not unbounded time-series labels.

For failure tests, I would exercise two buyers claiming the last unit, a worker dying after
provider success, duplicate/out-of-order webhooks, expiry racing acceptance, two
cancellations of one order, and an indexer replaying an old listing version. Those tests
validate the invariants directly.

Read scaling starts with CDN images, bounded query caching, search replicas, and
independently scaled API processes. Database pools have a shared connection budget across
all processes. Order history can be partitioned and reported asynchronously without moving
live stock authority immediately.

Multi-region reads are comparatively straightforward. Active stock writes in several regions
require explicit ownership or consensus, and purchases spanning stock partitions require
coordination. I would keep one regional writer until the availability and latency
requirements justify that complexity.

## 🔭 Implementation Boundary — 2 minutes

“The core design keeps three authorities clear: the catalog describes goods, a database
reservation owns scarce stock, and a durable purchase workflow records the payment outcome.
Search and caches help buyers find goods without deciding who bought them.”

The local repository implements Express routes, PostgreSQL carts and seller orders, Redis
sessions/caches, Elasticsearch retrieval, and Opossum wrappers. It does not implement the
proposed quote, reservation ledger, durable purchase receipt, outbox, or payment
reconciliation. Its payment is simulated.

Fresh checkout references `orders.payment_transaction_id`, which the supplied schema does
not contain. Availability is checked before the transaction, and a compatible-schema path
still lacks a guarded stock claim. Optional idempotency keys are globally scoped in Redis
and are not sent by the frontend. These are documented limitations, not production
guarantees.

The [architecture document](./architecture.md#implementation-notes) contains the exact local
schema and source mapping. In an interview, I would use the remaining discussion to choose
between deeper contention handling and cross-seller sharding, based on the requirement the
interviewer wants to stress.
