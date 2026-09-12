# Amazon — Frontend System Design

*A 45-minute discussion of product discovery, trustworthy cart state and checkout recovery.*

This answer proposes a production storefront. The repository currently uses a
client-rendered React application with simpler fetching and simulated payment;
[architecture.md](./architecture.md) records the actual implementation.

## 📋 Start with the shopper's decisions — 4 minutes

> “I would design around three questions: can I find the right product, can I trust
> the price and availability shown, and can I tell whether my purchase succeeded?
> Those questions matter more than selecting a state library at the start.”

The main journey is search or category browsing, product details, cart, checkout and
order confirmation. I would include reviews and item-to-item recommendations, but
keep their failures separate from the core purchase path.

The interviewer may also want a seller/admin experience. I would clarify that scope,
then keep this discussion on the shopper while ensuring backend permissions remain
independent of which controls the storefront happens to display.

Assume a large catalog, substantial mobile traffic and many anonymous visitors.
Users arrive directly on product/search URLs, switch networks, open several tabs,
and sometimes reload after submitting payment. Those are normal design inputs.

I would target the 75th percentile of field experience at LCP no more than 2.5 seconds,
INP no more than 200 ms and CLS no more than 0.1, measured separately for mobile and
desktop. These are performance goals, not measured properties of this demo.
[Core Web Vitals guidance](https://web.dev/articles/vitals?hl=en).

For correctness, displayed inventory is a recent observation, not an allocation.
Putting an item in a cart does not necessarily reserve it. The interface should
explain the product's actual hold policy instead of implying a promise from a badge.

I would exclude real payment-field implementation and tax rules from the whiteboard.
We integrate a provider's payment component/reference and a server-calculated quote.
The storefront does not need to receive raw card details to orchestrate checkout.

## 🏗️ Draw the page and data boundaries — 5 minutes

```
┌──────────────────────────────────────────────────────────────────┐
│ Storefront shell: navigation, account state, cart summary          │
├──────────────────────┬──────────────────────┬────────────────────┤
│ Discovery            │ Purchase             │ After purchase     │
│ Search / product     │ Cart / checkout      │ Order status       │
│ Public cached data   │ Private current data │ Recoverable result │
└───────────┬──────────┴──────────┬───────────┴─────────┬──────────┘
            │                     │                     │
┌───────────▼─────────────────────▼─────────────────────▼──────────┐
│ Data layer: query identity, cancellation, errors, mutation status │
└───────────┬─────────────────────┬─────────────────────┬──────────┘
            ▼                     ▼                     ▼
┌────────────────────┐  ┌───────────────────┐  ┌──────────────────┐
│ Catalog/search API │  │ Cart/quote API    │  │ Checkout/status  │
│ Stale reads allowed│  │ Versioned snapshot│  │ Stable attempt ID│
└────────────────────┘  └───────────────────┘  └──────────────────┘
```

Public product metadata can be rendered and cached close to the visitor. I would
use server rendering with selective revalidation for indexable product/category
pages rather than rebuild the entire catalog whenever one offer changes.

A large catalog does not rule out static output; it rules out eagerly rebuilding
every page for every update. On-demand generation or caching can serve popular pages,
while long-tail pages render when requested. The choice needs cache-key discipline.

Cart, account and checkout data are private and have a different freshness policy.
They must not leak into a shared HTML cache. Public rendering can provide a stable
shell while the authenticated cart summary loads independently.

Within React, I would separate the route shell, discovery modules and purchase modules.
The cart summary and checkout share a server snapshot, not two independently calculated
versions of what the shopper intends to buy.

The backend owns stock allocation, price calculation and payment state. The frontend
owns interaction state, useful pending feedback and reconciliation with those answers.
A fast optimistic animation cannot establish that stock is reserved.

## 💾 Assign each state one owner — 4 minutes

| State | Owner | Reason |
|-------|-------|--------|
| Query, selected filters, sort and page/cursor | URL | Shareable links and browser history |
| Product, review and recommendation results | Query cache | Independent freshness and loading/error boundaries |
| Confirmed cart and quote | Account-scoped server state | Prices, limits and cart version come from the authority |
| Unsaved address and quantity draft | Local form state | Immediate editing without pretending persistence |
| Checkout attempt and its status | Durable server record plus client reference | Recover after reload or a lost response |
| Open filters, selected thumbnail, dialog focus | Local UI state | Short-lived interaction details |

A query-cache library can handle request deduplication and invalidation. A small
Zustand store can coordinate shell state. I would choose those tools because of
these responsibilities, not store the same product and cart data in both.

Query identity includes every parameter that changes the result. Private results also
include account identity. On account change, cancel work, discard private cached
results and reject late responses from the previous account generation.

Types help developers pass the expected shape, but do not remove runtime values.
A serializer must explicitly omit absent filters; casting an object to a string map
does not stop `undefined` from becoming a literal query-string value.

For purchase mutations, retain structured errors such as stock conflict, revised
quote, authentication needed and unknown payment outcome. Reducing every failure to
one message string deprives the UI of the information needed to recover safely.

## 🔧 Deep dive 1: Search should survive navigation and partial failure — 8 minutes

### Decision: URL-driven filters with bounded result pages

> “I would make search a navigable document, not a transient list hidden in a store.
> A shopper should be able to open a product, go back and find the same filter choices
> and approximate place in the results.”

The URL holds the committed query, filter set, sort order and pagination state.
Typing is a local draft; submitting or a deliberate debounced search commits it.
Autocomplete has a separate, lightweight request and does not require fetching a
full product grid on each keystroke.

I would use bounded pages initially. A page of twenty or forty cards is manageable
without virtualization. For a long continuous browsing experience, virtualization
becomes useful, but then focus, scroll restoration and screen-reader navigation
need explicit handling.

### Why not begin with infinite scroll everywhere?

It can encourage exploration, but makes a stable result position harder to recover
and can keep a footer or comparison workflow out of reach. Appending indefinitely
also grows memory unless both data retention and rendering are bounded.

Pagination trades a deliberate next-page action for simpler URLs, predictable result
size and easier back navigation. If product research favors continuous scroll, I
would preserve a recoverable cursor and scroll anchor rather than abandon those needs.

### Filter changes are one transition

Changing a price range changes both boundaries and resets pagination. Send that as
one URL update derived from the latest state. Two separate navigations can each use
the same old object, causing the second change to erase the first.

Normalize and validate URL input: allowed sort values, numeric bounds and bounded
page sizes. Avoid rewriting equivalent queries endlessly. Keep the search input in
sync when browser history or an external link changes the committed query.

A new request is keyed by the normalized query. Cancel obsolete requests where
possible and apply results only to the matching query identity. Debouncing reduces
request volume; it does not prevent an older response from arriving last.

When refreshing, the UI can keep previous results visible with a clear updating state.
They should not silently appear to satisfy new filters. An error must not look like
a successful “No products found” result.

### Facets have an API contract

The API returns labels, stable filter values and counts. The client should not parse
a label like “$25–$50” to guess numeric boundaries; labels may be translated and the
upper-bound rule may differ from a shopper's interpretation.

I would agree whether category counts reflect all active filters or exclude the
category filter itself. Selected values remain visible even when their count is zero
or a degraded response omits the corresponding aggregation.

When the server falls back to a simpler search engine, the response identifies which
filters remain supported. We can keep a useful product list and explain unavailable
facets. Quietly dropping the rating filter would violate the shopper's request.

### Render the critical content first

Prioritize the visible product image and title. Reserve image dimensions, provide
responsive sizes, and lazy-load below-the-fold images. Making the primary image lazy
can delay the largest visible content, so loading policy depends on placement.

On a product page, primary product data must not wait for recommendations or reviews.
Those sections can render independently with bounded placeholders or a retry action.
A recommendation outage should not turn an existing product into “not found.”

Prefetch likely navigation after intent or idle time, within a budget. Prefetching
all results can waste a mobile data connection and compete with the page being read.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ URL state and bounded pages | Shareable, recoverable browsing with controlled work | Explicit pagination and query normalization |
| ❌ Store-only infinite results initially | Simple continuous browsing demo | Harder history, focus and memory management |

## 🔧 Deep dive 2: A responsive cart still needs a confirmed snapshot — 8 minutes

### Decision: distinguish an edit from an accepted cart change

> “I would let the shopper see that their click registered immediately, while keeping
> a distinction between the quantity they are requesting and the quantity the server
> accepted. Otherwise an optimistic cart can overstate what we can sell.”

An ordinary cart is purchase intent. In this proposal, stock is held briefly when
checkout begins. The product page can show a recent availability summary, while the
cart warns that final availability and price are checked at checkout.

For quantity edits, display a local draft/pending state and send the intended absolute
quantity with the cart version. The response contains a new authoritative snapshot
and any stock/price adjustment that the shopper needs to understand.

A UI may optimistically update a quantity label, but totals based on unconfirmed
price/availability should remain visibly provisional. The server calculates the
confirmed subtotal and later the shipping/tax quote.

### Why not snapshot the whole store and roll it back on error?

Suppose the shopper changes quantity, then removes another item before the first
request fails. Restoring a saved copy of the entire old cart can undo the later
successful removal. That rollback is not tied to the operation that failed.

I would either serialize mutations per cart/line or use an operation log that rebases
pending edits over each confirmed version. For an initial storefront, a short per-line
queue and bounded pending controls are usually simpler to explain and debug.

A stale response cannot replace a newer confirmed cart version. After a conflict,
refresh the authoritative snapshot and ask the shopper to review material changes.
Do not repeatedly auto-retry a disputed quantity while hiding the conflict.

### More than one tab or account

Server versions handle concurrent edits from another tab/device. Cross-tab hints can
prompt a refresh, but the database remains the authority. A browser message is not
proof of a stock reservation or the current quote.

On logout, clear cart display state as well as the session token. Cancel pending
requests and guard their completion against the previous account identity. Otherwise
another user's cart can briefly appear after a fast sign-in switch.

For anonymous browsing, a local cart draft is an option. On sign-in, merging it with
the account cart needs a policy for duplicates and quantities, followed by server
validation. Local storage capacity alone is not a reason to persist private data.

### Expiry and stock messages

If the product promises a checkout hold, show its server-provided expiry and the
consequence of expiration. A countdown uses a server-time estimate, but only the
backend can decide whether an allocation remains valid.

The UI should not treat “available for new buyers” as the maximum total quantity a
buyer with an existing hold may retain. The API can return the accepted quantity and
maximum permitted adjustment explicitly, avoiding client reconstruction of stock math.

Loading, empty and failed are separate states. During a first cart fetch, render a
loading state; showing “Your cart is empty” first creates unnecessary doubt.
After checkout, reconcile the cart summary with the consumed cart version so the
header does not continue advertising items already purchased.

### Offline trade-off

An offline draft can preserve shopping intent, but cannot reserve units or establish
a current price. I would allow clearly labelled draft edits only if the product needs
them, then revalidate on reconnect. Checkout requires an authoritative response.

Persisting an old cart as if it were current creates a worse failure than admitting
that availability cannot be checked yet. Offline support also requires an explicit
account boundary, expiry policy and conflict-resolution design.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Pending edits over a versioned cart | Responsive feedback and recoverable conflicts | Mutation sequencing and reconciliation |
| ❌ Unqualified optimistic success and whole-store rollback | Short happy-path implementation | Lost later edits and misleading totals/stock |

## 🔧 Deep dive 3: Checkout must recover from an unknown result — 8 minutes

### Decision: model a durable purchase attempt

> “Disabling Place Order helps with double-clicks, but it does not handle a lost
> response, a browser reload or a provider timeout. I would make the purchase attempt
> itself recoverable, then design the page around its states.”

The shopper reviews a server quote covering items, quantities, prices, currency,
shipping and tax. A meaningful change creates a revised quote that requires acceptance.
The button must not display one amount while the server silently commits another.

Create a stable attempt reference for the accepted intent. Submit with that same
identity on retry. Keep the reference in account-scoped recovery state so a reload
can query the existing attempt rather than create a new purchase automatically.

The server binds the key to the account and request fingerprint. Reusing it with a
different address, quote or cart is a conflict, not permission to return an unrelated
old order. A deliberately changed purchase needs a new reviewed intent.

### Separate interaction steps from business outcomes

The address/payment/review screens are local navigation states. Submitted, payment
pending, action required, confirmed and failed are server business states. Finishing
a local form is not evidence that the provider authorized a payment.

A state machine can express these transitions without requiring a particular library.
The important part is the transition contract and persistence, not a diagram full
of framework event names. In-memory machine context alone does not survive reload.

After submission, show the attempt/order reference and what is known. If the response
is lost, query status. If payment is still unresolved, explain that checking is in
progress and avoid encouraging a second independent purchase.

### Why not turn every timeout into “Payment failed — retry”?

The provider may have authorized payment before the connection broke. A new operation
could duplicate the effect. Conversely, declaring success from an API acceptance
would mislead the shopper if payment still needs authentication or reconciliation.

The backend coordinates provider idempotency and recovery. The frontend preserves
that distinction and offers the supported next action. A retry reuses the existing
attempt until the server establishes a terminal outcome.

The cost is a pending-state experience and recovery endpoints. That is justified
because a clear temporary uncertainty is better than a confident but incorrect
purchase result that support later has to untangle.

### Forms and payment integration

Use explicit labels, autocomplete hints, field-level errors and a focused error
summary. Validate locally for feedback and on the server for authority. Preserve
safe form input across recoverable errors without persisting raw card information.

A provider-controlled payment component handles sensitive fields and returns a
reference. If additional authentication opens, returning to the storefront should
resume the same attempt and re-read server state.

Allow changing an address before submission; after submission, changes follow the
server's order-edit policy. Merely moving back to the address step cannot undo an
already accepted order or payment operation.

### Cancellation and confirmation

Show the server's actual order/payment status and supported actions. A cancellation
request may be accepted while payment compensation is still pending. Its response
should preserve or re-fetch order lines and show the current refund state.

Confirmation links are durable and account-authorized. A notification or redirect
can help navigation, but order status comes from the same authoritative record used
by customer support and fulfillment.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Stable attempt with status recovery | Handles reloads, lost responses and unresolved payments | Pending UI and server reconciliation contract |
| ❌ Button disabling plus a fresh request on retry | Easy form submission flow | Cannot distinguish failed requests from completed purchases |

## ♿ Make the storefront usable under constraints — 4 minutes

Keyboard users need independent product links and Add buttons, a labelled quantity
control, and predictable focus after cart changes. Avoid putting interactive buttons
inside an entire-card link. Result counts and cart confirmations can use restrained
status announcements rather than repeatedly reading the whole page.

Autocomplete needs a clear input label, keyboard navigation and dismissal behavior.
Thumbnail buttons need names, not just decorative images. Form errors should identify
which field needs correction without relying on color.

On narrow screens, filters can move into an accessible dialog with focus restoration.
The product title, price and main action should remain reachable without horizontal
scrolling. Test real text lengths and zoom, not just a screenshot at one viewport.

For slow devices, bound rendered results, avoid blocking input with expensive filtering,
and defer optional modules. Measure network, rendering and interaction delay separately;
a fast backend cannot compensate for a blocked main thread.

## ✅ Verify the customer-visible guarantees — 4 minutes

I would test these end-to-end behaviors before broad visual polish:

1. Navigate through filters, a product and Back, preserving query and result position.
2. Deliver search responses out of order and distinguish empty results from failure.
3. Change both price boundaries in one action, including a shared URL with absent fields.
4. Make overlapping cart edits and a second-tab conflict without undoing later work.
5. Switch accounts while private requests are pending.
6. Lose the checkout response, reload and recover the same order/attempt.
7. Show pending payment, revised quote and refund progress without false confirmation.

Performance checks combine lab diagnosis with field measurements on representative
devices. Accessibility checks include keyboard and screen-reader journeys. Page-shell
smoke tests alone do not prove that search filters or purchase recovery are correct.

The local project offers useful examples of route-driven search, server-returned cart
snapshots and a simple checkout. It currently lacks request/version guards, sends no
stable checkout key and simulates payment; its implementation notes describe those
limitations instead of presenting this proposal as already built.

> “My frontend makes shopping feel responsive while keeping the boundaries honest:
> a displayed product is discoverable, a cart is intent, and a confirmed order is a
> server-established outcome. The state model connects those meanings to every
> loading, retry and recovery interaction.”
