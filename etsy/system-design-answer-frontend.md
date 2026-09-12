# Etsy Marketplace — Frontend System Design

> “I would design the shopping experience around a simple distinction: finding a listing,
> saving it in a cart, and owning a checkout reservation are three different states. The
> interface should make those states clear, especially when the item is unique.”

This is a proposed 45-minute interview design, not a description of every feature in the
local application. I would draw one architecture and two small state diagrams, then spend
most of the discussion on search navigation, scarce inventory, and recovering a purchase
after an uncertain response.

| Discussion | Minutes |
|------------|---------|
| Requirements and user journeys | 4 |
| UI architecture and rendering | 5 |
| State ownership and contracts | 5 |
| Deep dive: search people can navigate | 8 |
| Deep dive: honest inventory feedback | 8 |
| Deep dive: recoverable multi-shop checkout | 8 |
| Performance, accessibility, and verification | 5 |
| Scope boundary and next decisions | 2 |

## 🎯 Requirements and User Journeys — 4 minutes

“I will focus on a buyer finding a handmade or vintage item, comparing shops, saving a
basket, and buying from several sellers. I will also include the seller's listing and
fulfillment workflow because the buyer sees the consequences of those edits.”

A listing can be unique, but handmade goods can have several units. The interface must
support both. I would ask whether variants, personalized engraving, international tax, and
seller messaging are required. For this discussion, I assume fixed-price listings, one
currency per purchase, and no customization workflow.

The main buyer journey is search to product detail to cart to checkout. Search needs
meaningful filters, useful images, seller context, and back navigation that preserves the
exploration. The cart groups items by shop because shipping terms and fulfillment differ
even when payment is combined.

The seller needs to create and revise listings, set stock, and move their orders through
allowed fulfillment states. A seller with multiple shops needs an explicit shop selector.
Buyer and seller views should use the same authoritative listing and order versions, even if
they render different information.

I would propose a mobile-first experience with a p75 largest contentful paint target below
2.5 seconds on a representative mobile connection, a responsive interaction budget, and
accessible keyboard completion of the purchase. These are design targets to measure, not
results from the repository.

Correctness is part of the experience: a sold item must not look purchased merely because a
button was clicked. A timeout must not prompt the buyer into a second charge. A price change
must be presented for consent before proceeding.

“I am comfortable showing a slightly stale discovery card. I am not comfortable using that
card as permission to charge someone.”

## 🏗️ UI Architecture and Rendering — 5 minutes

I would draw a small architecture with separate public discovery and authenticated purchase
responsibilities.

```
┌──────────────────────┐      ┌──────────────────────┐
│ Browser              │─────▶│ CDN / image variants │
│ Routes and UI state  │      └──────────────────────┘
└──────────┬───────────┘
           ▼
┌──────────────────────┐      ┌──────────────────────┐
│ API / session        │─────▶│ Catalog and search   │
│ Typed client adapter │      │ Public projections   │
└──────────┬───────────┘      └──────────────────────┘
           ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Cart / checkout      │─────▶│ Orders and payment   │
│ Authoritative quote  │      │ Durable status       │
└──────────────────────┘      └──────────────────────┘
```

Public product and shop pages benefit from server-rendered initial content, discoverable
metadata, and cached image derivatives. Search can hydrate the initial result page and then
navigate interactively. Cart, checkout, and seller pages depend on private session state and
must not be shared through a public page cache.

I would begin with route boundaries for home, search, product, shop, favorites, cart,
checkout, purchase status, and seller workspace. Product cards, price display, shop
identity, and line-level availability messages should be shared components. A checkout page
should compose delivery, shop groups, totals, and purchase status instead of becoming one
large stateful component.

A typed client adapter converts the API's money and date representation once. It handles
credentials, cancellation, response validation, and error classification. TypeScript types
alone cannot validate a server response or turn a decimal string into a number.

For public caching, I would separate anonymous listing data from personalized favorite
state. Otherwise a shared product response can accidentally carry one buyer's saved status
to another. Private requests include the current account in their cache identity and are
discarded on logout.

The API remains responsible for authorization. Hiding a seller action is useful navigation,
but it cannot establish shop ownership. The UI needs a clear forbidden state when access
changes while an edit form is open.

## 🧭 State Ownership and Contracts — 5 minutes

“I would avoid making one global store the owner of everything. Search identity, server
data, and unsaved form state have different lifetimes.”

| State | Owner | Reason |
|-------|-------|--------|
| Search query, filters, sort, cursor | Router URL | Reload, links, and back navigation reproduce the search |
| Products, shops, cart, orders | Request cache keyed by resource and account | Server remains authoritative; refetch and stale state are explicit |
| Current authenticated user | Session resource | Hydration, logout, and access changes have defined states |
| Open filter sheet or navigation panel | Local state or small UI store | Temporary presentation state |
| Image selection and unsaved listing edits | Component/form state | Avoid cross-product leakage |
| Purchase operation identity | Durable purchase reference plus recoverable client record | Reload must reconnect to the same operation |

TanStack Router can own navigation, a server-state library can manage queries, and Zustand
can coordinate small cross-route UI concerns. These choices are replaceable; the ownership
rules matter more than the library list.

I would make session state loading, authenticated, or anonymous. A protected route waits for
loading to settle before redirecting. Login and session refresh should return the same
user/shop shape, and a successful login should preserve the intended destination.

Cart responses include line IDs, quantities, current prices, shop groups, totals,
availability warnings, and a cart revision. A quote response adds accepted totals, listing
versions, a server expiry, and a checkout ID. The cart is a saved intention; the quote is
the service's current offer under a hold.

A favorite can be predicted optimistically because a failed save is reversible. I would
track the latest desired state per item, serialize or supersede conflicting requests, and
roll back only the mutation that failed. Replacing an entire favorite list from an old
closure can undo a newer change.

Cart quantities need a more cautious approach. The UI may acknowledge that an edit is
pending, but server validation decides whether the requested amount is available. A failed
cart fetch should show a retryable error, not an empty-cart illustration.

## 🔎 Deep Dive: Search People Can Navigate — 8 minutes

“I choose the URL as the canonical identity of a submitted search. If a buyer explores
several products and presses Back, the same query and filters should return with a sensible
scroll position.”

### Query changes and request ordering

The search field can hold a local draft while the person types. Submitting the query commits
a normalized URL. On desktop, inexpensive filter changes can update it immediately; on
mobile, a filter sheet can collect draft changes and apply them together. This is a
deliberate interaction policy rather than accidental behavior from unrelated state
variables.

Every committed search creates a request identity from query, category, price range,
attributes, sort, and pagination. Changing filters resets the cursor. Back navigation
reconstructs the controls from the URL rather than leaving them at their previous local
values.

I would cancel obsolete requests and also reject results whose identity no longer matches
the visible search. Cancellation alone is insufficient: a response may already have
completed, or a cache layer may deliver it after navigation.

While loading, the existing results can remain visible with a clear updating state. The
count and applied-filter summary should identify which result set is on screen. An old
result must not be silently relabeled with the new query.

### Filters and degradation

The server returns applied filters and capabilities along with products. If Elasticsearch is
unavailable and a fallback cannot support a filter, I would preserve the buyer's selection
and explain the limitation. I would not quietly turn “vintage, under $50, free shipping”
into an unrestricted product list.

A bounded SQL fallback may support exact category and price filters while offering simpler
text matching. The response can say that relevance or facet counts are temporarily limited.
If a required filter cannot be honored, the interface should offer an explicit retry or a
clearly separate browse option.

Facet counts must have a defined interpretation. I would use counts within the currently
applied filter set initially. If product wants counts that preview removing a category
filter, that is a different aggregation contract and should not be invented by the browser.

The result total may be approximate or limited by the search engine. Displaying “10,000+
results” is more honest than presenting a lower bound as an exact count. Pagination needs a
stable sort tie-breaker and a bounded cursor lifetime; a dynamically changing catalog cannot
promise an eternal frozen result set.

### Why this choice is worth its cost

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Canonical URL plus query-keyed data | Shareable, restorable navigation and clear response identity | Requires normalization and explicit draft-versus-applied state |
| ❌ Independent local filter state | Quick first implementation | Back/reload can disagree with visible controls or cached results |
| ❌ Replace failed search with general products | Keeps the page visually populated | Misrepresents buyer intent and hides an outage |

For a marketplace, exploration often spans many product pages. Losing the search context
adds work precisely when a buyer is comparing similar items. I accept more careful routing
and caching to preserve that context.

I would restore scroll after the relevant page data and image dimensions are available. If
the listing disappeared, keep the surrounding results and explain the missing item. The goal
is to preserve the buyer's place without pretending the catalog never changes.

## 🛍️ Deep Dive: Honest Inventory Feedback — 8 minutes

“I choose a short reservation when checkout starts, not when someone saves a product to
their cart. The frontend must explain that distinction instead of implying that a cart item
is already secured.”

A product card can show “Only one available” as a recent observation. The detail page
refreshes availability when opened and when the tab regains focus, with a bounded refresh
policy. A push update could improve freshness later, but it is still advisory: another buyer
may win immediately after the latest notification.

Adding to cart stores the buyer's requested quantity. The interface says “Added to cart,”
not “Reserved.” If quantity changes before checkout, the cart retains the line with an
actionable warning so the buyer can remove it or choose an acceptable quantity.

### Making the hold visible

At checkout entry, the server attempts to hold all selected lines in one short transaction.
If a line is unavailable, the interface shows which item failed and preserves delivery
input. The buyer explicitly chooses a revised basket before another attempt.

Once a quote is returned, the UI shows accepted totals and the hold's expiry. The timer is
computed from server time/expiry and corrected on status refresh; the browser clock is not
the authority. When the timer appears to expire, disable new payment initiation and ask the
server for the current state.

```
┌──────────────────────┐
│ Cart: saved intention│
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Request current quote│
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Held until expiry    │
│ Buyer accepts totals │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Payment being checked│
│ Server owns outcome  │
└──────────────────────┘
```

Entering payment processing changes the server's hold policy. The client should not
automatically release a hold because its original five-minute timer elapsed while payment is
being reconciled. It displays the current purchase state and offers status recovery instead.

If a price or shipping term changes before quote acceptance, show the old and new totals and
require a fresh acceptance. Product detail caches may be useful for browsing, but the quote
amount drives the payment summary.

### Alternative and trade-off

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Short checkout hold | Clear payment window for a serious buyer | Expiry, abuse controls, and payment reconciliation states |
| ❌ Reserve every cart addition | Reassuring immediately after saving | Abandoned carts can hide unique stock for hours |
| ❌ Validate only after charging | Minimal pre-payment workflow | Buyer may pay for inventory another buyer already obtained |

The chosen approach gives up the promise that a saved item will remain available. I would
make that cost visible in copy and cart warnings. It avoids giving casual browsing the power
to indefinitely block scarce goods.

Seller stock changes use expected versions and distinguish total stock from reserved stock.
If a seller tries to reduce stock below active commitments, the edit receives a conflict
with the current quantities. The seller must not be allowed to erase a buyer's valid hold
through an ordinary form save.

## 💳 Deep Dive: Recoverable Multi-Shop Checkout — 8 minutes

“I would represent one buyer purchase and several seller orders. The buyer needs one payment
outcome, while sellers need independent fulfillment responsibilities.”

The order summary groups lines by shop and makes each shipping charge visible. A combined
total does not mean combined shipping or one delivery date. The backend returns the amount
and currency; the browser formats them rather than independently reconstructing a payable
total.

Before payment submission, the client creates or receives a stable operation identity bound
to the accepted quote. Double clicks, network retries, and status recovery reuse that
identity and payload. A new basket or changed quote is a new operation, not an edit to an
in-flight payment request.

### Handling an uncertain response

Suppose the buyer presses Pay, the provider succeeds, and the response is lost. The browser
must not infer failure. It navigates to or remains on a durable purchase status view and
requests the same operation's state.

```
┌──────────────────────┐      ┌──────────────────────┐
│ Submit accepted quote│─────▶│ Processing / unknown │
│ Stable operation ID  │      │ Poll durable status  │
└──────────────────────┘      └──────────┬───────────┘
                                         ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Explicit failure     │◀─────│ Authoritative result │
│ Re-quote if needed   │      │ Confirmed or declined│
└──────────────────────┘      └──────────────────────┘
```

A status endpoint distinguishes still processing, confirmed, definitively declined, expired
before payment, and requiring attention. Polling can start quickly and back off, pausing
when the page is hidden. Reopening the purchase resumes status retrieval. A push
notification can reduce latency but does not replace the durable read.

The backend must scope operation identity to the buyer and request digest. A Redis response
cache alone is not enough if it disappears after the database commits. Frontend retry
behavior depends on that contract; disabling a button cannot provide it.

### Cart and seller-order updates

On confirmation, the server consumes only the cart lines/quantities covered by the purchase
revision. The client replaces or invalidates the cart using the authoritative result. It
must not send an extra “delete my whole cart” request: another tab may have added something
while payment was pending.

The confirmation screen lists the seller orders and their delivery expectations. A payment
pending response says payment is pending; it does not use the same success presentation as a
confirmed purchase. If one seller later cancels, the purchase page shows the corresponding
refund and remaining seller orders.

Cancellation UI uses server-provided allowed actions and the current order version. It
explains whether cancellation is requested, stock has been released, or a refund is still
processing. The client does not synthesize “refunded” from an order status label.

| Approach | Benefit | Cost / failure mode |
|----------|---------|---------------------|
| ✅ Durable purchase status and stable retries | Reload and timeout recovery without a new purchase | More visible intermediate states and a status endpoint |
| ❌ Treat any timeout as failure | Simple error handler | Encourages a second operation after the first may have succeeded |
| ❌ Confirm each successful seller silently | Can salvage part of a basket | Changes the accepted purchase without explicit buyer consent |

I choose explicit all-basket consent at checkout entry. Later fulfillment can differ by
seller, but that does not justify silently changing which lines were purchased. The
trade-off is that one unavailable line requires the buyer to revise the basket before
proceeding.

## ⚡ Performance, Accessibility, and Verification — 5 minutes

Images are likely to dominate page weight. I would generate several derivatives, reserve
aspect-ratio space, load the main product image promptly, and lazy-load images outside the
viewport. Loading every original image in a search grid wastes bandwidth and delays the
useful content.

Start with bounded result pages and incremental loading. If long feeds become a measured
rendering bottleneck, use row-based virtualization with stable item identity and preserve
keyboard focus and scroll restoration. Virtualization does not solve large image downloads
or expensive search requests by itself.

Seller forms and checkout should split by route and load optional heavy features when
needed. Prefetching a likely next product can help, but broad prefetching on every pointer
movement can flood the API and distort view counters. Record a product view as an
intentional event rather than treating every fetch as engagement.

For accessibility, I would test labeled inputs, keyboard-operable filter dialogs, focus
restoration, announced availability changes, and an error summary linked to invalid delivery
fields. Hover-only account menus and icon-only controls need accessible alternatives. A
color change alone cannot convey that a hold expired.

My highest-value checks are behavioral:

- Search A returns after search B; the page still shows B and its filters.
- Back navigation restores query, controls, pagination, and scroll context.
- A valid session is loading; a protected route waits instead of redirecting.
- Two buyers try a unique item; the losing buyer keeps their form and sees the exact conflict.
- Payment succeeds but the response is lost; retry reads the original purchase.
- Another tab adds a cart item during payment; confirmation preserves that addition.
- Logout/login switches accounts while requests are in flight; old private data is discarded.

I would collect page performance, failed search transitions, quote conflicts, abandoned
checkout states, and time spent waiting for payment resolution. A fast success screen is not
a useful metric if it sometimes confirms an uncompleted purchase.

## 🔭 Scope Boundary and Next Decisions — 2 minutes

“The design gives buyers a stable exploration history, honest availability, and a purchase
they can recover after a network failure. I would implement those contracts before adding
personalized recommendations or real-time inventory animation.”

The local project currently uses client-rendered React, TanStack Router, Zustand, SQL carts,
and JSON API calls. It has no server-state query library, durable quote/hold workflow,
client idempotency key, or purchase-status recovery. Session hydration and stale-response
handling have gaps. Fresh checkout also inserts a payment column missing from its supplied
schema.

Those are implementation boundaries, not features I would claim to have built. The
[architecture document](./architecture.md#implementation-notes) maps them to source; this
interview answer describes the proposed product behavior.

If the interviewer wants to extend the design, I would choose either custom-order variations
or cross-currency multi-shop checkout. Both change the accepted quote and consent model, so
they deserve a clear contract before more components are added to the whiteboard.
