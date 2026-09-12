# Amazon — Full-Stack System Design

*A 45-minute discussion of discovery, stock allocation and a purchase that survives retries.*

This answer proposes a production storefront. The local project has a simpler React/
Express implementation and simulated payments; [architecture.md](./architecture.md)
separates its actual behavior from the guarantees discussed here.

## 📋 Define what the shopper can rely on — 4 minutes

> “I would follow one shopper from finding headphones to placing an order. At each
> step I would ask what the screen is promising and which backend record makes
> that promise true.”

The main journey includes search/category browsing, product details, cart, checkout
and order status. Reviews and recommendations help discovery. Seller/admin operations
maintain the catalog and handle order exceptions, with permissions enforced by the API.

I would clarify stock policy first. In this proposal, adding to cart saves intent;
a short hold begins at checkout. That means a cart item can become unavailable before
purchase, and the interface needs to communicate that possibility.

If the business instead promises a cart-time hold, we can support it, but it changes
expiry, renewal and abuse-control requirements. I would not infer that promise from
the presence of a `reserved` counter in a database.

Assume one hundred million offers, ten million daily active buyers and one million
orders/day. Average order creation is about twelve/second; a 1,000/second sale peak
and 50,000 searches/second are separate planning assumptions.

The primary non-functional requirements are fast discovery, no allocation beyond
available stock, and a recoverable purchase outcome after a lost response. Proposed
availability targets are 99.99% for browsing and 99.9% for checkout.

I would exclude a full shipping network, tax engine and new payment gateway from
this interview. We define their contracts and show where their status enters the
customer journey. The demo substitutes simple rules and a payment simulation.

## 🏗️ Draw a small end-to-end architecture — 5 minutes

```
┌───────────────────────────────────────────────────────────────────┐
│ Storefront: discovery → product → cart → checkout → order status  │
│ URL state     public results    private snapshot    attempt ID    │
└───────────────┬──────────────────────┬────────────────────────────┘
                │                      │
        ┌───────▼────────┐     ┌───────▼──────────┐
        │ Catalog/search │     │ Cart/checkout API │
        │ Public caching │     │ Quote and recovery│
        └───────┬────────┘     └───────┬──────────┘
                ▼                      ▼
        ┌────────────────┐     ┌──────────────────┐
        │ Search index   │◀────│ Catalog/stock/   │
        │ and read cache │     │ order DB + outbox│
        └────────────────┘     └───────┬──────────┘
                                        │ Durable jobs/events
                               ┌────────▼─────────┐
                               │ Payment worker   │────▶ Provider
                               │ Index / recs     │
                               └──────────────────┘
```

The browser owns interaction state and rendering. The purchase API owns accepted
quotes, stock allocation and order identity. The search index is a read projection,
so its price and availability can lag without becoming authoritative for a purchase.

I would begin with a modular backend sharing a transactional database for cart, stock
and order records. Splitting every noun into a service immediately would create
cross-service transactions before scale requires them.

An outbox persists follow-up work alongside committed business state. Workers can
update the search index, compute recommendations and coordinate payment without
holding inventory row locks during external calls.

For public product pages, server rendering and edge caching can improve direct
navigation and indexability. Private cart/account state loads through a separately
scoped path and must not enter a shared HTML cache.

On the client, a query layer manages server results and a small UI store coordinates
shell state. Local forms retain drafts. Giving each kind of state one owner avoids
two independently calculated carts or a stale user object deciding authorization.

## 💾 Define shared contracts before components — 4 minutes

| Concept | Backend record | Frontend meaning |
|---------|----------------|------------------|
| Product result | Versioned catalog projection | Discoverable offer with potentially stale price/stock |
| Cart | Buyer lines and version | Confirmed saved intent plus any pending edits |
| Quote | Validated items, prices, currency, shipping and tax | Amount and terms the shopper reviews |
| Reservation | Attempt, warehouse allocation, units, expiry/state | A time-bounded hold only after server acceptance |
| Checkout attempt | Buyer-scoped key and request fingerprint | Recoverable submission identity |
| Payment operation | Provider reference and known/unknown state | Pending, action required, confirmed or failed outcome |
| Order | Item/price snapshots and lifecycle version | Durable history and supported actions |

The API returns structured conflicts, not just arbitrary text. A revised quote,
insufficient stock, expired hold and unresolved provider outcome require different
screen behavior even if all occur after pressing the same button.

| Operation | Contract |
|-----------|----------|
| Search | Normalized filters, bounded page and explicit facet semantics |
| Set cart quantity | Desired quantity plus expected cart version |
| Obtain checkout quote | Authoritative totals and current availability |
| Submit attempt | Stable identity tied to the accepted quote and account |
| Read attempt/order | Recover outcome after reload, timeout or notification |
| Cancel | Conditional transition with payment/stock compensation progress |

A browser TypeScript interface cannot guarantee that the server response has this
meaning. Both sides need runtime validation and a shared behavioral contract.
For example, absent search filters must be omitted, not serialized as the word
“undefined” because an object was cast to a string map.

## 🔧 Deep dive 1: Connect the cart to a real stock allocation — 8 minutes

### Decision: fast pending feedback, authoritative short checkout holds

> “When the shopper clicks Add, I can acknowledge the interaction immediately.
> I should not say the last pair of headphones is theirs until the stock authority
> has allocated it. Those are different product states.”

The cart records the selected offer and desired quantity. Mutations return a cart
version and confirmed snapshot. A local pending quantity can make the UI responsive,
while the confirmed totals remain tied to what the server accepted.

At checkout, the server validates the quote and obtains a short allocation, initially
five minutes subject to product testing. The reservation records exactly which
warehouse supplies each quantity. The client displays the accepted hold and expiry.

### Two buyers, one unit

Suppose both buyers saw “In stock” from a cached product page. That is acceptable
if the UI treats it as availability information rather than a purchase guarantee.
Only one checkout can allocate the remaining unit at the stock authority.

The backend uses an atomic conditional write or a short transaction locking the
relevant inventory records. It evaluates availability at that same serialization
point and records the allocation with the pending order/attempt.

Locking each buyer's cart does not solve this race: those are different rows. Reading
a stock sum before an unconditional decrement also fails, even if each request uses
a transaction. The actual shared resource must enforce the invariant.

When the second buyer loses the race, the response identifies the unavailable line.
The UI preserves the other cart choices and offers a revised checkout, instead of
clearing everything or displaying a generic payment error.

### More than one warehouse

A total stock count is useful for discovery, but checkout needs an allocation plan.
If two warehouses each have five units and the order needs three, subtracting three
from each would consume six. The order must consume and release the exact recorded
allocation, including during cancellation.

Warehouse allocation can later account for delivery promises and shipment cost.
For this interview, I would keep that policy simple while preserving explicit records
so fulfillment does not have to infer where the units came from.

### Why not reserve every cart addition?

That can provide a stronger shopping-window promise, but casual browsing and abandoned
carts then withhold stock from ready buyers. Scarce launches become vulnerable to
many long-lived holds unless quotas and renewal rules constrain them.

Checkout-only holds give up guaranteed cart availability in exchange for keeping
inventory available longer. A clear product message and useful conflict resolution
make that trade-off understandable. If requirements demand cart-time holds, accept
the operational cost instead of claiming a counter makes it free.

### Expiry is shared state, not a browser timer

The countdown helps the shopper, but the backend decides expiry using authoritative
time and reservation state. Cleanup and checkout compete through a conditional
transition; only one can release or consume a still-held allocation.

A delayed cleanup job may delay release, but cannot extend a contractual hold silently.
A repeated cleanup delivery must not release someone else's units. Reservation state
and the counter change commit together.

The UI revalidates after a long background period or reconnect. It does not show
“reserved” merely because an old local timestamp is still present. If the hold expired,
preserve the form and request a new allocation/quote according to the product policy.

### Concurrent client edits

Whole-cart snapshot rollback can undo a later successful edit. I would serialize
conflicting mutations or rebase pending operations over the newest server version.
Older responses never replace a newer confirmed snapshot.

The same private state is scoped to the account. Logout clears it and pending work;
late responses from a previous account cannot repopulate the next shopper's cart.
After order acceptance, reconcile the header badge with the consumed cart version.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned cart plus short authoritative allocation | Responsive intent editing and correct last-unit decision | Stock conflicts and reservation-state coordination |
| ❌ Treat a cart badge or cached count as ownership | Easy optimistic demo | Promises inventory that was never allocated |

## 🔧 Deep dive 2: Recover one purchase after an uncertain response — 8 minutes

### Decision: one durable attempt shared by browser and backend

> “The shopper presses Place Order, the network drops, and they reload. I want the
> page to discover the outcome of that purchase, not ask them to gamble on whether
> another click will create a second order.”

Before submission, the shopper reviews the authoritative quote. The client submits
a stable attempt key associated with that accepted intent. The backend binds it to
the account and a request fingerprint, and commits the attempt/order relationship
with the allocation and durable follow-up work.

A repeated request returns the same attempt/order or its pending status. The key
must survive the browser recovery path. A random key created on each HTTP request
cannot deduplicate retries, even if the backend has a table called idempotency keys.

### Why not rely on a disabled button and Redis flag?

Button disabling limits one page's immediate clicks. It does not handle another tab,
a reload, a proxy retry or a response lost after the server committed.

A Redis flag written separately from the order can strand processing work or disappear
after an order exists. It is an optimization around durable state, not the purchase
identity authority. Database uniqueness and a transaction close the local commit gap.

Supplied keys also need account and payload binding. A global key lookup must not
return another buyer's private response, and the same key must not silently represent
a changed cart, address or amount.

### Payment has a separate boundary

The payment coordinator calls the provider after the order transaction commits.
It records each authorization/capture/refund operation with its own stable provider
identity. Holding database locks during that call would increase contention without
making the provider part of a PostgreSQL transaction.

A timeout can mean the provider completed before the connection failed. The correct
state is unknown until queried or reconciled. An authenticated callback or periodic
reconciliation scan updates the same operation and order state.

Persisting pending work matters. A fallback function that merely returns “queued”
does not create a worker or guarantee future progress. After a process restart, the
coordinator must be able to enumerate and resume unfinished operations.

### Reflect uncertainty without confusing the shopper

The checkout UI distinguishes local form steps from server business state. Completing
the address form does not authorize payment. An accepted order may still need
provider authentication or confirmation.

After a lost response, show that the app is checking the existing attempt. Offer a
status link and preserve the reference. Do not encourage a fresh independent purchase
while the original outcome is unresolved.

If payment fails definitively, follow the server's supported retry/change-method flow.
If the quote changes, show the revised amount for acceptance. A new purchase intent
is a deliberate transition, not an automatic result of a transient network error.

The cost is a pending-state experience, status APIs and reconciliation jobs. That
complexity is justified by an answer the shopper and support team can both trust.

### Cancellation races with payment and fulfillment

A customer can cancel while authorization is in flight. The backend conditionally
records cancellation and compensation work. A late success checks that lifecycle
state rather than blindly setting the order to confirmed.

If inventory was released, either follow a deliberate reallocation policy or void/
refund the provider operation. The interface can show cancellation accepted with
refund pending when that is the actual state.

Admin actions use the same domain transitions. Changing a status dropdown cannot
bypass stock restoration or payment compensation. The server returns supported
actions so the UI does not reconstruct eligibility from a partial status list.

### Durable history and independent effects

Order lines snapshot the accepted title, price and quantity. A later catalog edit
must not rewrite what was purchased. Account authorization applies to recovery URLs
and status lookups just as it does to order-history pages.

Outbox events let fulfillment, notifications and indexing proceed independently.
Each consumer deduplicates its own effects. One consumer's success cannot suppress
another consumer's work through a single shared “seen” flag.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Durable attempt and provider reconciliation | Safe recovery after reloads, retries and late outcomes | Pending states and compensation workflows |
| ❌ Fresh submission after every apparent failure | Simple form handler | Cannot distinguish request failure from completed purchase |

## 🔧 Deep dive 3: Keep discovery fast without making stale data authoritative — 8 minutes

### Decision: a versioned search projection and a navigable frontend

> “I would allow the product list to be a little stale so browsing can scale
> independently. I would make that safe by checking the purchase at checkout and
> preserving the meaning of filters and errors on the search page.”

Catalog, stock and rating changes create versioned events. Index workers project
searchable fields and handle out-of-order delivery. A deletion/deactivation removes
or hides the old document; a bulk refresh must reconcile obsolete documents too.

The search index supports text matching and facets. PostgreSQL remains the catalog
and purchase authority. SQL can do text search and aggregation; the dedicated index
is chosen for workload isolation and relevance needs, not a universal speed claim.

### What the URL means

The URL contains committed query, filters, sort and pagination. Local input state
holds typing before commit. The browser Back button restores the search choices,
and opening a product should preserve a useful result position for returning.

I would start with bounded pages rather than a huge in-memory result list. If product
research favors infinite scrolling, retain a recoverable cursor/scroll anchor and
virtualize long lists carefully, including keyboard and screen-reader behavior.

Changing a price range is one transition containing both bounds and a pagination
reset. The API sends stable values and labels; the frontend should not reverse-engineer
numeric ranges from translated display text.

### Stale responses and stale projections are different

A stale projection is a server freshness issue: the index may not yet reflect a price
change. A stale response is a client ordering issue: the old query finishes after the
new one. Both need explicit handling, but a short cache TTL fixes neither by itself.

Key requests by normalized filters, cancel obsolete work and apply responses only
to the matching query identity. Debouncing autocomplete controls request volume;
it does not prevent out-of-order completion.

A product page can load primary details independently of reviews/recommendations.
Defer optional sections and below-the-fold media, while prioritizing the main image
and reserving its dimensions to avoid shifting the purchase controls during load.

### Why not fall back to PostgreSQL for every empty result?

Zero products can be a legitimate answer. Treating it as an outage switches engines
without evidence and may change filter semantics or pagination between requests.
The backend should distinguish empty, degraded and failed states.

During a real ES outage, a bounded fallback can serve supported text/basic filters.
It needs a separate concurrency budget and deadline so browsing load does not consume
all checkout connections. A fallback is not a promise of unlimited availability.

The response identifies unsupported facets or reduced freshness. The UI keeps selected
filters visible and explains limitations. Quietly omitting a minimum rating or stock
filter changes the shopper's request and can produce misleading results.

If retrieval fails, retain any prior list as visibly outdated or show a retry state.
Do not present “No products found” as if the query completed successfully. Similar
care applies to initial cart loading and order recovery.

### Recommendations and caching

An item-to-item co-purchase batch is a reasonable initial recommender. Define eligible
orders and a time window, then publish complete top-K generations so obsolete peers
do not remain forever. Cache ranking and hydrate active products without losing order.

The batch trades freshness for simpler operations. Incremental event processing can
improve freshness if needed; it does not inherently require GPUs or a complex model.
A missing recommendation remains a secondary-page issue, not a purchase outage.

Public caches include locale/currency and relevant offer context. Private account data
never shares those keys. Changes need invalidation/version handling, including older
cache fills that complete after an invalidation.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned projections and explicit search states | Fast browsing with recoverable navigation and honest results | Index maintenance, query identity and fallback budgets |
| ❌ Uncoordinated caches plus hidden fallback | Easy happy-path loading | Stale stock, changed filters and misleading empty results |

## ♿ Operate and degrade around the customer — 4 minutes

The most useful operational metrics follow promises: allocation conflicts, unresolved
payment age, index lag, fallback saturation and failed customer journeys. A healthy
HTTP process or an unused oversell counter cannot establish purchase correctness.

Use consistent correlation IDs for request, attempt and provider work. Keep addresses
and payment material out of routine analytics. Audit important transitions durably;
admin access and seller ownership checks remain mandatory even without dedicated UI.

For accessibility, use separate product links and Add buttons, labelled forms and
quantity controls, meaningful focus after errors and restrained status announcements.
Search suggestions need keyboard support, and filters need a usable narrow-screen
presentation. A desktop page-shell screenshot does not verify those flows.

If the network fails, keep safe drafts and show what is outdated. Offline intent is
possible; offline stock allocation or payment confirmation is not established by a
local cache. Clear private state on account changes and preserve only intentional
recovery references within the relevant account boundary.

## ✅ Validate the whole journey — 4 minutes

I would test the cases where two individually reasonable components can disagree:

1. A cached product says in stock while another buyer wins the last-unit allocation.
2. A checkout hold expires as payment or cancellation completes.
3. Concurrent cart edits return out of order or cross an account switch.
4. The order commits, its response is lost, and the shopper reloads.
5. A provider success arrives after timeout or cancellation.
6. Search fails under load, while the fallback preserves filters and checkout capacity.
7. A product is edited/deactivated while older index events and cache fills are pending.

Checks must inspect durable state and visible behavior together: one allocation/order,
recoverable payment state and a screen that communicates the same outcome. Separate
field performance and accessibility testing verifies that correctness remains usable
on slower devices and assistive technology.

The local project is useful for exploring these seams, but it currently uses unlocked
stock checks, unscoped cache-based idempotency, no payment recovery worker and simple
client fetching. Its documentation should explain those gaps rather than treat the
production proposal as an implemented guarantee.

> “The full-stack design connects each screen promise to a durable backend fact.
> Discovery can be cached, cart edits can feel immediate, and payment can take time,
> as long as the system preserves identity, checks allocation and tells the shopper
> what actually happened.”
