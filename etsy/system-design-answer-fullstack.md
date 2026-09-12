# Etsy Marketplace — Full-Stack System Design

> “I would build a marketplace where discovery can be eventually consistent, but purchasing
> has a durable, authoritative outcome. The hardest work is making the browser, stock
> service, and payment workflow agree on what the buyer actually accepted.”

This is a proposed 45-minute interview answer. I would use a small whiteboard architecture
and follow one buyer from search to a multi-shop purchase. The production proposal is
intentionally more complete than the local teaching implementation.

| Discussion | Minutes |
|------------|---------|
| Scope and requirements | 4 |
| Architecture and sizing | 5 |
| State and API contracts | 5 |
| Deep dive: search with honest freshness | 8 |
| Deep dive: cart, quote, and scarce inventory | 9 |
| Deep dive: recovering payment across shops | 9 |
| Verification and scaling | 3 |
| Implementation boundary | 2 |

## 🎯 Scope and Requirements — 4 minutes

“I will support browsing handmade and vintage products, shops and favorites, a cart across
devices, and purchasing from multiple sellers. Sellers can manage listings and fulfill
orders. Some goods have one unit; others have a small batch.”

I would clarify customization, variants, shipping rules, and currency. For this discussion,
assume fixed-price products, a single currency per checkout, and a quoted delivery charge
per seller. Personalized manufacturing, promotions, international taxes, and seller payouts
can be separate extensions.

A buyer should be able to explore search results, open several products, and return to the
same filters. The product page shows current information, but adding to cart does not
guarantee ownership. Starting checkout attempts to obtain a short hold and a quote for the
selected basket.

If an item is unavailable, the buyer decides whether to proceed with a revised selection. We
do not silently charge for the remaining shops. After the accepted purchase is confirmed,
each seller can fulfill independently and the buyer sees separate shipment and cancellation
states.

The first reliability requirement is that two buyers cannot both obtain the last unit. The
second is that a lost payment response does not cause a second purchase. The third is that
the browser makes uncertainty visible rather than translating every failure into an empty
page or every successful HTTP response into a completed payment.

I would target 99.9% regional API availability, server-side search p95 below 500
milliseconds, and a mobile p75 largest contentful paint below 2.5 seconds on a defined
device/network profile. These are proposed targets. During an outage of the authoritative
stock database, accepting new purchases is not a useful form of availability.

## 🏗️ Architecture and Sizing — 5 minutes

I would draw the browser, API, transaction store, discovery projection, and durable workers.
The responsibilities can begin in a modular application; separate boxes do not imply an
immediate fleet of microservices.

```
┌──────────────────────┐      ┌──────────────────────┐
│ Browser              │─────▶│ CDN / product images │
│ Routes / request data│      └──────────────────────┘
└──────────┬───────────┘
           ▼
┌──────────────────────┐      ┌──────────────────────┐
│ API / session        │─────▶│ Search / Redis cache │
│ Catalog / cart       │      │ Elasticsearch        │
└──────────┬───────────┘      └──────────────────────┘
           ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Checkout / orders    │─────▶│ PostgreSQL           │
│ Inventory authority  │      │ Purchases / outbox   │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Payment provider     │◀─────│ Durable workers      │
│ Status / webhooks    │─────▶│ Payment / indexing   │
└──────────────────────┘      └──────────────────────┘
```

React and TanStack Router handle the interactive experience. Public product/shop pages can
render initial content on the server and hydrate on the client. Images use appropriately
sized derivatives through the CDN. Private cart, purchase, and seller pages cannot enter a
shared public response cache.

A request cache owns server data; a small Zustand store can coordinate UI concerns.
PostgreSQL owns listings, stock, carts, purchases, receipts, and seller orders.
Elasticsearch is a maintained discovery projection. Redis is useful for sessions and read
caches, but losing it must not permit another purchase effect.

For sizing, suppose one million buyers make ten searches daily: roughly 116 searches per
second on average and 1,160 at a tenfold peak. Suppose there are 50,000 purchase attempts
per day: about 0.58 per second average and 5.8 at that peak. These are exercise assumptions,
not observed Etsy traffic.

With ten million listings and 2 KiB of indexed source each, source documents occupy about 19
GiB before index overhead and replicas. Four 300 KiB image derivatives per listing occupy
about 11.2 TiB before originals. Images and search dominate routine load, while a single
popular one-unit listing can dominate stock contention.

This suggests independent read scaling and focused protection for hot checkout claims. It
does not suggest sharding every seller's inventory before the basic purchase invariant
works.

## 🧭 State and API Contracts — 5 minutes

“I would define the contracts before deciding which browser store calls which endpoint. The
browser must know whether it is showing an observation, a saved intention, or an accepted
offer.”

| Concept | Server authority | Browser representation |
|---------|------------------|------------------------|
| Discovery result | Search projection and its version/freshness | Query-keyed cards, facets, and degradation state |
| Listing detail | Catalog version | Current content plus separate user favorite state |
| Cart | Buyer-owned lines and revision | Shop groups with pending edits and availability warnings |
| Quote / hold | Accepted prices, quantities, expiry, stock claim | Delivery summary and server-derived timer |
| Purchase | Durable operation and payment state | Recoverable status page |
| Seller order | Immutable items plus fulfillment state/version | Shop-specific allowed actions and shipment status |

The URL owns submitted search query, filters, sort, and cursor. Local state owns a draft
search field, open filter sheet, and image selection. Server data is keyed by resource,
query, and account identity. On logout, private data and in-flight requests are invalidated
so late responses cannot repopulate another account's view.

Session hydration has an explicit loading state. Protected routes wait for it; they do not
infer that a user is anonymous because a network request has not finished. Login and session
refresh return a consistent user/shop shape, including the shops available to the seller
workspace.

### Proposed API surface

| Method | Resource | Contract |
|--------|----------|----------|
| GET | `/products/search` | Applied filters, products, facets/total semantics, cursor, capability limits |
| GET | `/products/:id` | Product and listing version; separate personalized state where needed |
| PUT | `/cart/lines/:id` | Desired quantity against cart revision; authoritative updated cart |
| POST | `/checkouts` | Selected lines, versions, delivery details; quote/hold or exact conflicts |
| POST | `/checkouts/:id/accept` | Stable operation ID and accepted quote revision |
| GET | `/purchases/:id` | Processing, confirmed, declined, or attention state with seller orders |
| POST | `/orders/:id/cancel` | Expected state/version and observable cancellation/refund result |

These are proposed contracts. Money uses integer minor units and currency at the interface
boundary; the browser formats rather than reconstructs the payable amount. Error responses
distinguish invalid input, stock conflict, changed quote, forbidden action, and uncertain
payment.

The proposed storage model adds purchases, quote/reservation lines, durable operation
receipts, payment attempts, and an outbox alongside ordinary users, shops, listings, carts,
and seller orders. A receipt is unique by buyer and operation ID; the stored request digest
prevents using the same identity for a different basket.

## 🔎 Deep Dive: Search with Honest Freshness — 8 minutes

“I choose Elasticsearch for retrieval and a versioned indexing pipeline for maintenance. The
UI accepts slight freshness delay, but it never treats a search result as an inventory
lock.”

### Follow a listing update to a buyer's screen

A seller revises a listing with an expected version. The API verifies ownership and
publication eligibility, commits the new version, and records an outbox event in the same
transaction. The indexer applies that version and ignores delayed older events.

Stock consumption, cancellation restock, shop eligibility, and rating changes also affect
discovery. They need explicit event or refresh paths. Updating the index only when a seller
edits a title leaves other fields stale indefinitely.

For retrieval, lexical relevance on title and description produces candidates, exact filters
enforce category/price/attributes, and bounded seller reputation/freshness signals adjust
the ranking. Synonyms and typo tolerance require relevance evaluation: related product names
are not always interchangeable buyer intent.

I would initially keep personalization out of the critical path. A well-filtered search and
reasonable exposure for new sellers are easier to explain and validate than a vague
recommendation system based on a few stored views.

### Preserve navigation and response identity

The browser commits a normalized search URL. A query cache uses that complete identity, and
filter changes reset pagination. Back navigation restores the URL-driven controls and scroll
position once the relevant results are available.

If query A is slow and query B finishes first, A cannot overwrite B. I would cancel obsolete
requests and reject any response whose query generation is no longer current. Cancellation
is an optimization; checking identity protects correctness even if cancellation arrives too
late.

The previous results can stay visible while updating, provided they retain their old
identity and loading treatment. Search errors need an explicit error state. A generic browse
list is an optional separate action, not a silent replacement for the requested filtered
search.

The server reports the filters it actually applied and whether totals/facets are approximate
or unavailable. If a fallback cannot honor “free shipping” or a price bound, the buyer
should see that limitation before choosing to relax the filter.

### Cache and index are different freshness boundaries

A short search cache reduces repeated work. Its key includes normalized filters, sort,
pagination, and relevant locale/currency. Product detail can also be cached briefly, with
quote creation reading authoritative stock and prices.

Cache invalidation runs after a committed change and targets the real key structure. A lock
to coalesce expensive misses has bounded waiting and safe owner-based release. Cache
failures should not cause an unbounded recursion or send unlimited fallback searches to
PostgreSQL.

An expired cache reloads from the index. If the index missed an update, a two-minute TTL
does not make that update arrive. The system needs durable indexing retries, projection lag
metrics, tombstones, and a rebuild path that loads a snapshot and catches up newer events
before switching an alias.

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Versioned discovery projection | Rich retrieval without burdening stock transactions | Index lag, repair, and rebuild responsibilities |
| ❌ Best-effort SQL/index dual write | Easy initial integration | One commit can succeed while the other update is lost |
| ❌ Hide failures with general products | Avoids an empty-looking page | Discards buyer intent and masks filter failures |

The alternative of SQL-based search can be sensible for a smaller catalog. I would choose it
if the retrieval requirements were simple enough. At the assumed scale and linguistic/facet
requirements, the projection's operational cost is justified, but that cost must be
acknowledged rather than hidden behind a library call.

## 🛒 Deep Dive: Cart, Quote, and Scarce Inventory — 9 minutes

“I choose short checkout holds over reserving every saved cart. The frontend communicates
the difference, and the database enforces it.”

Imagine a buyer adds a one-unit vintage vase and a necklace from a second shop. The cart
persists across devices and groups the lines by shop. It displays current observations and
estimated shipping, but it has not reserved either product.

When checkout starts, the API validates the selected cart revision, quantities, listing
versions, seller eligibility, and delivery inputs. It obtains stock rows in a consistent
order and attempts all claims in a short database transaction. It commits the quote and
reservation lines together or returns the specific conflict without partially charging
anything.

Checking availability before the transaction is not enough. Two buyers can both read one
available unit; an unconditional decrement in each later transaction can still subtract
twice. The claim must verify current unreserved stock under concurrency and check that all
requested updates succeeded.

The database also enforces positive requested quantities, nonnegative stock, and valid money
values. Seller updates cannot reduce stock below active commitments. Request validation
improves error messages; constraints and guarded writes protect the invariant.

### Quote state and visible consent

```
┌──────────────────────┐      ┌──────────────────────┐
│ Saved multi-shop cart│─────▶│ Request quote / hold │
│ No stock promise     │      │ All selected lines   │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Conflict / re-select │◀─────│ Current availability │
│ Preserve form input  │      │ and accepted terms   │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
                              ┌──────────────────────┐
                              │ Held quote / expiry  │
                              │ Buyer accepts totals │
                              └──────────────────────┘
```

The quote includes prices, quantities, seller shipping allocations, total, currency,
version, and server-side expiry. The browser shows those values exactly. If a price changed
since the product page, it highlights the difference and obtains fresh consent.

The initial hold might last five minutes. The UI derives its countdown from server expiry
and refreshes status after a long background pause. The server decides whether payment can
still start; setting a client timer to zero cannot release inventory on its own.

An expiry worker releases only eligible unpaid holds through a guarded state transition.
Accepting payment changes the hold into a processing state and protects it during bounded
reconciliation. Expiry and payment confirmation cannot both apply stock effects from the
same stale state.

If the vase is unavailable, the buyer can explicitly remove it and accept a new quote for
the necklace. This is different from silently submitting whatever lines happen to remain
active in a database query. The accepted selection is part of the purchase identity.

### The trade-off

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Short all-line checkout hold | Clear payment window and buyer consent | Hold expiry, abuse limits, and contention handling |
| ❌ Reserve on every cart add | Early reassurance | Abandoned carts can hoard the most scarce listings |
| ❌ Charge before authoritative claim | Less pre-payment coordination | Money can succeed after stock has already gone elsewhere |

We give up a guarantee that a saved cart secures an item. The interface compensates with
clear copy and recoverable line-level conflicts, not a misleading real-time badge. Push
availability updates could improve discovery, but only the database claim establishes
ownership.

I would initially keep stock and holds in one regional database. That makes the all-basket
transaction feasible. Sharding by seller later changes this operation into distributed
reservation coordination and needs cleanup for partial acquisition; it cannot preserve the
same guarantee through ordinary independent writes.

## 💳 Deep Dive: Recovering Payment Across Shops — 9 minutes

“I choose one durable buyer purchase with multiple seller orders. The UI and backend both
need to recognize that payment processing is a state, not a momentary button spinner.”

### Stable identity through an ambiguous failure

On quote acceptance, the client reuses a stable operation ID and exact accepted quote
revision. The server scopes that ID to the authenticated buyer, checks its request digest,
and stores the receipt with the state transition. A changed basket requires a new operation;
a lost response uses the existing one.

The transaction commits payment work into an outbox. A worker calls the provider using a
stable payment reference outside database locks. A definite success advances the durable
purchase, while a definite decline releases the appropriate hold. A timeout remains unknown
until status lookup or a verified webhook resolves it.

The worker can restart after provider success but before recording confirmation. Because the
purchase and provider reference existed first, the replacement worker reconciles the same
effect. It does not create a new charge or rebuild the purchase from the user's now-changed
cart.

The browser receives either a confirmed result or a durable processing reference. It can
navigate to a purchase status page, poll with backoff, pause while hidden, and resume on
reload. An error in the transport does not prove the purchase failed.

### Why the response cache is insufficient

A Redis idempotency response stored after the SQL commit leaves a gap if the process dies
between those operations. A processing key can expire while work is still running. An
unscoped key can even return one buyer's result to another buyer who happens to use the same
key.

The proposed SQL receipt binds buyer, operation, digest, and result. The provider and
consumers also use stable effect identities. Events may arrive more than once; guarded state
changes and unique effect records prevent business effects from being applied twice.

This is not a claim of exactly-once network delivery. It is a design for repeatable delivery
with controlled effects. Its guarantees depend on the provider's supported operation/status
contract, which would be verified during integration.

### Confirming and fulfilling the accepted purchase

Once payment is confirmed, one database transaction consumes the held stock, creates
per-seller order/item snapshots, records the purchase result, and emits downstream work.
Item titles, amounts, and delivery terms are historical records rather than live references
to editable product text.

The response identifies which selected cart lines and quantities were consumed. The browser
updates or invalidates its cart from that result. It does not send a second whole-cart
deletion: another tab may have added an unrelated product while payment was in progress.

The confirmation page separates payment status from fulfillment status. One shop may have
shipped while another is preparing the order. A queued or unknown payment cannot be shown
with the same final-success message as a confirmed purchase.

Seller transitions are validated against current state/version and ownership. A cancellation
records its decision, applies an inventory effect once if appropriate, and creates a tracked
refund effect. A shipping request racing cancellation must have one legal winner. Repeating
the request returns the existing result or a conflict, not another restock.

The buyer sees which seller order was cancelled and whether the refund is pending or
complete. Summing order totals across all statuses is not a reliable revenue figure, and
changing a status label is not proof that money was returned.

### Trade-off and example

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Durable purchase workflow and status recovery | Handles lost responses, retries, and independent fulfillment | Intermediate states, reconciliation, and compensation work |
| ❌ One SQL transaction around provider calls | Straight-line code resembles an atomic operation | Remote payment cannot be rolled back with database writes |
| ❌ Declare failure on every timeout | Simple UI and handler | Buyer may retry after a successful payment and create another operation |

For the vase and necklace example, suppose payment succeeds and the worker crashes. On
recovery, the system confirms the same purchase and creates the two seller orders once. If
the payment cannot be established yet, the buyer sees “payment being checked” and can leave
and return safely.

If the hold can no longer be honored after an unresolved payment, the server must record
compensation rather than confirm a now-unfulfillable order. A late provider success leads to
a tracked refund path. This costs operational complexity, but it gives the uncertainty an
owner instead of handing it to the buyer.

## 🛠️ Verification and Scaling — 3 minutes

I would verify boundaries with a small set of high-value scenarios. Race two buyers for one
unit; race expiry against acceptance; lose the response after payment success; replay a
webhook; cancel the same order twice; and add a cart line from another tab during payment.
Each scenario has an observable invariant, not just an expected status code.

On the frontend, test out-of-order search responses, back navigation, session hydration,
account switching, and keyboard completion of checkout. Preserve image dimensions to avoid
layout shifts, load appropriate derivatives, and use bounded result pages before adding
virtualization for measured long-list rendering costs.

Production monitoring should connect search latency and projection lag with quote conflicts
and checkout completion. Track unknown-payment age, expired-hold lag, duplicate effects
prevented, refund backlog, and stock reconciliation errors. Business counters should reflect
committed outcomes, with bounded metric labels and private data removed from logs.

Scale images and search independently first. Bound database connections across API replicas,
shed excessive hot-listing attempts, and rate-limit degraded search so it cannot take down
the stock database. Order history and seller analytics can move to read projections while
live purchase authority stays regional.

Multi-region stock writers and inventory sharding deserve a new consistency discussion.
Adding more API replicas improves capacity only when every replica uses the same guarded
authoritative operations.

## 🔭 Implementation Boundary — 2 minutes

“The proposal ties the product promise to the system state: search helps discover, a quote
secures a short opportunity to buy, and a durable purchase records what happened. The UI can
stay responsive while being honest about each boundary.”

The local application has React routes, in-memory Zustand stores, PostgreSQL carts/orders,
Redis sessions and caches, and Elasticsearch search. It simulates payment and lacks the
proposed hold ledger, quote versions, purchase parent, outbox, durable receipt, and client
retry identity.

Fresh checkout inserts a payment column absent from the supplied schema. Cart expiry
timestamps are not enforced, inventory checks precede the transaction, and search fallback
does not preserve every filter. Session and request-state handling also have gaps. The
[architecture document](./architecture.md#implementation-notes) records the actual behavior
and source evidence.

If asked to extend the design, I would pick either custom-made product variations or
cross-seller sharding. Each changes a core contract: what the buyer accepts, or how the
system can atomically hold the accepted basket.
