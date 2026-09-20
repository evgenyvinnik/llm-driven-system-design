# Hotel Booking — System Design Answer (Fullstack Focus)

*45-minute interview walkthrough. This is a proposed end-to-end design; the local demo's
boundary is called out at the end.*

## 🎯 Scope and user promise — 4 minutes

> "I'd design around a guest planning a stay, accepting a price, and obtaining one reliable
> booking. Search helps them choose. A hold allocates rooms. Payment and confirmation make the
> final promise. Those are separate stages."

I would first clarify whether we book a specific physical room or a quantity of a room type.
I'll support the latter, in one hotel, for one continuous date range. Multi-hotel baskets,
intentional overbooking, and external hotel-channel synchronization are out of scope.

The guest can search, compare nightly prices, reserve, pay, inspect status, and cancel under
agreed terms. A property owner can manage room types, capacity, and date-specific prices. The
initial architecture can be a modular application plus workers; each logical box need not be a
microservice.

### Requirements to agree on

| Concern | Contract |
|---|---|
| Inventory | Active allocations cannot exceed capacity on any occupied night |
| Dates | Check-in inclusive, checkout exclusive, using hotel calendar dates |
| Money | The accepted quote defines amount, currency, and cancellation terms |
| Retries | One purchase intent has one recoverable result |
| Interaction | Search is responsive; unavailable and unknown outcomes are distinct |
| Accessibility | Planning and checkout work without pointer-only interactions |

I would ask how long checkout holds last and what happens when payment is unresolved at
expiry. The UI cannot truthfully show a timer until the server has a clear deadline contract.

For a sizing exercise, assume ten million searches and 100,000 bookings daily, with a tenfold
peak. That is roughly 1,200 searches and twelve bookings per second at peak, but hot
properties can concentrate the writes. These are assumptions, not benchmark results.

I'd target sub-500 ms p95 discovery and short inventory transactions. A provider may take
longer, so the frontend must support pending and recoverable outcomes instead of waiting
behind an unexplained spinner.

## 🏗️ Architecture and one booking journey — 6 minutes

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                    │
│                             pick                                                           │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Search + calendar      │     │ Checkout attempt       │     │ Booking status         │  │
│  │ URL + draft range      │────▶│ Quote + saved intent   │◀───▶│ Held / confirmed       │  │
│  └────────────────────────┘     └────────────────────────┘     │ Unknown / expired      │  │
│                         ▲                                      └────────────────────────┘  │
│                         │                                                             ▲    │
│                         │                                                             │    │
│  advisory reads         │        hold / payment command / status recovery             │    │
│                         │                                                             │    │
└─────────────────────────┼─────────────────────────────────────────────────────────────┼────┘
                          │     dated checks                                            │
                          ▼                                                             ▼
┌───────────────────────────┐      ┌─────────────────────────────────────────────────────────┐
│ Discovery API             │      │ Booking API                                             │
│ Catalog + dated results   │◀────▶│ Auth + ownership + canonical amount                     │
└───────────────────────────┘      │ Inventory and payment state machine                     │
                          ▲        └─────────────────────────────────────────────────────────┘
                          │                                                             ▲
                          │                                                             │
match / enrich            │         atomic booking + receipt + outbox                   │
                          │                                                             │
                          ▼                                                             ▼
┌───────────────────────────┐      ┌─────────────────────────────────────────────────────────┐
│ Search index / read cache │      │ PostgreSQL primary                                      │
│ Eventually updated        │◀──┐  │ Inventory, quote, hold, operation receipt               │
└───────────────────────────┘   │  │ Payment attempts + inbox/outbox                         │
                                │  └─────────────────────────────────────────────────────────┘
                                │                                                       ▲
index / progress                │                                                       │
                                │  expiry / reconciliation / delivery                   │
                                │                                                       │
                                │                                                       ▼
┌───────────────────────────┐   │  ┌─────────────────────────────────────────────────────────┐
│ Payment provider          │   └─▶│ Workers                                                 │
│ Verified events           │◀────▶│ Guard deadlines; retry and reconcile provider calls     │
│ Idempotent operations     │      └─────────────────────────────────────────────────────────┘
└───────────────────────────┘
```

I would draw the browser row first because it makes the product flow concrete. Search and
calendar data help select a stay. Checkout owns a frozen attempt. The status view shows what
the server currently knows, including uncertainty.

Underneath, the left side is advisory discovery and the right side is authoritative booking.
PostgreSQL owns inventory, accepted quotes, and receipts. The search index is updated through
durable projection work. The payment provider is a separate failure domain reached through
retryable workers.

### Walk through the arrows

1. The guest commits destination, dates, guests, and room count; these become URL criteria and the discovery query identity.
2. Discovery matches hotels and enriches a bounded candidate set with dated availability and price hints.
3. Selecting a room requests a quote; the server returns exact terms and their deadline.
4. Accepting the quote freezes a purchase intent. Booking allocates a hold and commits its receipt in one transaction.
5. A valid hold enters payment processing. Durable work calls the provider using a stable attempt identity.
6. Verified payment status drives a guarded booking transition. The browser fetches canonical status after completion, reconnect, or uncertainty.

On reload, recover the bounded account-scoped intent reference and resolve the same booking
and payment attempt after reauthentication. An unknown provider outcome keeps the relevant
processing allocation protected until reconciliation. The left worker branch updates the
search projection and records confirmed effects independently; its freshness does not decide
whether the guest has a confirmed booking.

The quote-to-hold boundary is where advisory planning becomes inventory allocation. The
provider boundary is where a single database transaction stops being sufficient. Those are the
two places I would circle on the board.

### State and contracts

| Data | Authority | Frontend representation |
|---|---|---|
| Committed search criteria | URL | Shareable state restored by navigation |
| Incomplete date range | Local picker | Draft until valid |
| Calendar/results | Server snapshots | Cache with scope, freshness, loading and error state |
| Quote | Server | Display-only terms tied to room/date/count scope |
| Purchase intent | Client identity, server receipt | Frozen key and payload for retries |
| Booking/payment status | Server state machine | Held, processing, confirmed, expired, cancelled, unknown |

Authentication scopes private queries and commands. I would use a secure session cookie for
this proposal and clear private client state on account changes. The local implementation uses
an opaque bearer token in localStorage instead.

## 🔍 Deep dive 1: Making date-based discovery trustworthy — 9 minutes

A hotel search is a planning tool. Guests change dates repeatedly and compare prices across
nights. The frontend needs fast local interaction without implying that a read reserved a
room.

### Calendar as a query builder

Keep an incomplete selection local. Only commit a range when both dates are valid and checkout
is strictly after check-in. Two independent inputs that fetch after every change send
intermediate nonsense and invite late-response races.

Fetch month snapshots for the calendar and cache them under the room/date scope. Prefetch at
most nearby months. Hovering over a date should not trigger another inventory query. A final
quote or hold still checks the complete requested stay.

Half-open nights matter across the whole stack. The 17th–19th occupies two nights; a guest may
check out on the 19th even when the night of the 19th is sold out. Validate all occupied
nights, not just the selected endpoints.

Use date-only operations for hotel dates. Host-local timestamp iteration can duplicate or skip
labels around daylight-saving changes, while UTC conversion can shift a local midnight to the
previous date. One shared convention should govern API validation, price breakdowns, and UI
summaries.

### Discovery budget and freshness

The server first matches catalog candidates, then batches dated availability and prices for a
bounded set. It is reasonable to filter search by availability. It is not reasonable to treat
a successful check as a hold.

At twenty candidate hotels and two room types per candidate, naive enrichment multiplies the
assumed peak into roughly 48,000 availability checks per second. Caching and batching are
therefore an end-to-end concern, not just a backend optimization.

| Choice | Why it fits | Cost |
|---|---|---|
| ✅ Valid committed range + month snapshots | Responsive planning with controlled request volume | Draft state and cache freshness rules |
| ✅ Bounded dated enrichment | Avoids repeated sold-out detail visits | Some stale hints and a finite candidate budget |
| ❌ Fetch on every interaction | Easy event wiring | Invalid queries, waste, and response races |
| ❌ Check every candidate authoritatively | Appears exhaustive | Can overwhelm the inventory database |

A cache key must include requested room count if it caches an availability boolean.
Alternatively cache nightly counts and derive the comparison for the current quantity.
Invalidation must cover overlapping ranges and owner edits, not just the exact dates of one
new booking.

### Keeping the UI and API aligned

Return an explicit hotel DTO with stable field names and a coherent continuation contract. If
enrichment removes half a candidate page, its remaining length is not the total number of
available hotels. The frontend should not combine that value with an unfiltered page count.

A hotel's minimum base price also may belong to a different room type from the one that fits
the guest's party. Dated offers must pair capacity and price for the same option. An accepted
quote includes nightly overrides and quantity, not a client extrapolation from “from $180.”

Every read response is tied to its query identity. Abort obsolete reads and reject late
results if their criteria or account no longer match. Changing dates clears or revalidates the
selected room and quote, rather than leaving a stale room object next to new dates.

### Honest presentation

| Evidence | Appropriate UI |
|---|---|
| Catalog match | Typical price and hotel attributes |
| Dated check | Available when checked for this range and quantity |
| Read failure | Unable to check right now |
| Hold created | Allocated until the server deadline |
| Verified confirmation | Durable booking reference and accurate payment state |

“Sold out” and “could not check” need separate views. A reservation rejection preserves guest
input and offers alternatives. A network timeout goes into recovery because the server might
already have committed.

Calendar accessibility belongs in this design: labeled dates, keyboard navigation, announced
ranges/night counts, and text entry as an alternative. A sold-out night, a past date, and a
loading cell need different explanations, not just different shades.

> "The client can make planning feel immediate by caching hints. It earns trust by showing
> exactly when those hints have become a quote, a hold, or a confirmed booking."

## 🔧 Deep dive 2: A purchase attempt that survives retry — 9 minutes

The key failure is a reservation committed on the server while its response is lost. An
ordinary retry button can either create another booking or misleadingly report failure for a
purchase that already exists.

### Define the attempt across both sides

When the guest accepts a quote, create an intent key and freeze the quote ID,
hotel/room/date/count scope, and guest details. All retries use that same identity and
request. A deliberate second purchase gets a new identity even when dates match.

The server scopes the receipt to the authenticated account and binds it to a request digest.
Same key and same payload recovers the same booking. Same key and changed terms is a conflict,
not permission to silently return an unrelated result.

| Mechanism | What it solves | What it cannot solve alone |
|---|---|---|
| Disabled submit + synchronous action guard | Accidental repeated UI actions | Another tab or an HTTP retry |
| Frozen attempt and stable key | Consistent identity across retries | Server atomicity |
| Receipt committed with booking | Durable one-result protocol | Inventory allocation correctness |
| Inventory transaction | Conflicting scarce-resource writes | Whether a repeated purchase is intentional |

A hash of booking parameters is not a substitute for an intent. It cannot distinguish booking
another identical room from retrying the first one, and omitting guest details can replay a
booking for a changed request.

### Allocate inside a short transaction

The server validates activity, party capacity, dates, bounds, and quote eligibility. It then
locks the room type in PostgreSQL, reads fresh nightly occupancy, and checks capacity on every
occupied night.

For ten rooms with nightly occupancy six, nine, and seven, a three-night request can allocate
at most one more room. A range-wide sum of all overlapping stays would answer a different
question and may overcount guests staying on different nights.

Persist the hold, accepted monetary snapshot, operation receipt, and durable work together.
Simultaneous retries contend on a unique account/intent constraint; the loser returns the
winner's canonical result after transaction resolution. A precheck before locking leaves a
race.

| Allocation choice | Benefit | Cost |
|---|---|---|
| ✅ Room-type lock initially | Simple enforceable rule across API instances | Unrelated dates for the same type serialize |
| ✅ Per-night inventory rows when needed | Independent nonoverlapping dates | More rows and ordered multi-row locking |
| ❌ Exact-range Redis lease as authority | Reduces identical-range contention | Overlapping different ranges use different keys |

The database row lock works across API processes sharing that primary. Owner capacity
reductions must validate existing obligations under the same serialization rule; otherwise the
owner path can violate an invariant the booking path preserves.

### Price acceptance and response handling

The quote includes total, currency, nightly prices, policy version, and deadline. If it is no
longer valid, return an explicit new-quote requirement. The UI displays changed terms and
obtains renewed acceptance before starting another attempt.

Return one canonical booking representation on first response and replay. The client validates
the representation and renders the actual status, never an optimistic confirmation. A
malformed or missing receipt is uncertainty and should trigger recovery, not invented price or
payment data.

Keep enough non-sensitive identity to recover after a reload without persisting guest contact
details unnecessarily. Fetch current status before enabling another purchase action. A
cancelled or expired receipt remains useful history; a fresh intended booking receives a fresh
intent.

### The trade-off

This is more work than a form post and a spinner. It requires receipt retention,
payload-binding rules, and an unknown-state UI. The simpler alternative fails when a
successful write and failed response straddle the network boundary, which is exactly when
guests are most likely to click again.

> "I want one intention to survive a flaky network. The client preserves the identity; the
> server preserves the result; neither side can provide that guarantee by itself."

## 🔧 Deep dive 3: Hold expiry and payment reconciliation — 9 minutes

A held room is not paid, and a provider timeout is not proof of payment failure. The client
and server need a common state model that acknowledges both facts.

### Agree on the transitions

| Current state | Event / guard | Result |
|---|---|---|
| Held | User starts payment before server deadline | Payment processing, inventory still allocated |
| Held | Deadline reached before processing begins | Expired and inventory released |
| Payment processing | Verified matching authorization | Advance according to confirmation/settlement policy |
| Payment processing | Decline or bounded reconciliation decision | Release or cancel with explicit money outcome |
| Released/cancelled | Late provider success | Void/refund or explicitly reacquire inventory |
| Confirmed | Valid cancellation request | Apply accepted policy and track refund separately |

I would keep authorized, settled, and refunded money states distinct from inventory state. The
UI can show a confirmed booking with payment details only as strongly as the server has
verified them.

### The server side

Starting payment is a conditional database transition that checks the hold deadline. It
creates durable work for an external call, then commits. No inventory row lock stays open
during provider latency.

A worker sends a stable payment-attempt identity with the accepted amount and currency.
Verified callbacks or status queries enter a deduplicated inbox and drive another conditional
transition. A lost response is reconciled against the same attempt, not replaced with a new
charge.

The expiry worker and payment transition compete on the same booking state. If expiry wins, an
old provider event cannot simply mark it confirmed after inventory has been sold elsewhere.
Void the authorization or track a refund; reacquiring rooms requires another inventory check
and explicit terms.

A delayed expiry sweep does not extend a hold's right to begin payment. Commands check the
database deadline themselves. The worker releases abandoned capacity and updates projections,
but its scheduling interval is not the business clock.

### The frontend side

Show the canonical deadline and use the server's time reference to estimate remaining time.
The countdown informs the guest; reaching zero prompts a status refresh rather than locally
inventing a final state.

| UI state | Behavior |
|---|---|
| Held | Explain deadline and next action |
| Processing | Disable competing commands and show progress/recovery |
| Outcome unknown | “Checking your booking”; query the existing attempt |
| Expired | Explain release and offer a new quote |
| Confirmed | Show reference, stay dates, terms, and verified money details |
| Cancelled / refund pending | Preserve history and distinguish pending refund from completed refund |

Refresh on reconnect and focus. Poll briefly while a payment is genuinely pending, with
bounded backoff; do not poll every historical booking forever. Announce meaningful status
changes for assistive technology without reading out every countdown second.

### Alternatives and costs

| Approach | Benefit | Why I would not rely on it here |
|---|---|---|
| ✅ Outbox + provider identity + reconciliation | Recoverable external effects | Adds worker operations and visible pending states |
| ❌ Keep the SQL transaction open during payment | Superficially linear code | Slow provider calls hold scarce locks and still cannot make two systems atomic |
| ❌ Trust a browser-supplied payment ID | Easy local demo | A string is not evidence of authorization or amount |
| ❌ Countdown alone enforces expiry | Simple presentation | A closed or modified tab cannot release inventory reliably |

The important operational signal is how long attempts remain uncertain, not just how many
payment calls return an error. A worker can retry delivery while the business result has
already happened, so counting calls is not counting purchases.

> "Expiry and payment form one recovery problem. The system must know who still owns the room
> and what happened to the money, even when the guest has closed the tab."

## 🧪 Validation, scaling, and implementation boundary — 8 minutes

### End-to-end tests

| Scenario | Expected result |
|---|---|
| Change dates quickly; old result arrives last | UI keeps the active criteria and corresponding data |
| Select across a sold-out middle night | Invalid range is explained before purchase |
| Cross DST, leap day, or month boundary | Correct hotel-night count and quote breakdown |
| Submit the same intent through two API instances | One canonical booking result |
| Lose response after SQL commit | Recover existing booking without another purchase |
| Owner reduces capacity during allocation | Future obligations remain within capacity |
| Expiry races with a provider event | One valid inventory transition and reconciled money state |
| Switch account while a private request is pending | No cross-account response contamination |

Frontend simulations cover rendering, request identity, and accessible recovery. Database
integration tests cover actual locks and constraints. Provider sandbox/fault tests cover
retries and event ordering. A page-render smoke test is not a booking-correctness test.

### What breaks first

Availability enrichment and image bytes dominate the discovery journey before a long list
needs virtualization. Bound candidate expansion, batch reads, size images responsively,
reserve their layout space, and lazy-load below the fold. Public hotel pages may benefit from
server-rendered content and CDN delivery; private checkout requires current account state.

Measure room-type lock wait, connection pool wait, hold success, expiry lag, and payment
reconciliation age. A transaction that holds one connection while its pricing helper requests
another can exhaust the pool without extraordinary traffic.

When coarse room-type locking becomes the bottleneck, introduce per-night inventory rows and
deterministic lock ordering. Partition authoritative data by hotel so one reservation stays
local. Search projections and tolerant reads can scale separately.

Property tools should eventually support bounded date-range price edits with a preview of
affected nights. Capacity changes require server validation against bookings. Client optimism
is appropriate for a local editing draft; a committed inventory change needs an authoritative
result.

Secure sessions, current ownership checks, request limits, and provider verification belong on
the server. Private caches clear on account changes, and logs should avoid guest/payment
details. UI role checks only improve navigation; they do not authorize writes.

### What the local project actually implements

The demo supplies React routes and stores, Express APIs, PostgreSQL booking-range checks,
Valkey caches/leases, and Elasticsearch discovery. Booking creation does take a room-type row
lock before its nightly occupancy query. A real minute-based sweep expires abandoned
reservations in each API process.

The production contracts in this answer are not all present. Confirmation accepts a
still-reserved row without comparing its deadline, takes a fabricated payment reference, and
does not contact a provider. There is no durable outbox, verified payment inbox, immutable
quote, or client intent-recovery protocol.

Search already filters dated candidates, but returns snake_case index fields to camelCase
cards and mixes filtered page totals with unfiltered page counts. The browser loses search URL
criteria and can retain stale room selection. Calendar range handling misses interior-night
and departure rules.

Cached replay formatting, incomplete availability cache keys/invalidation, and host-timezone
pricing loops are additional verified gaps. Owner capacity reductions can undercut existing
bookings. The booking screen's “Total Paid” label is not proof that money moved.

The documentation review used isolated source checks and inspection, not a live end-to-end
run. [architecture.md](./architecture.md#implementation-notes) records the precise
implementation and evidence. I would explain those gaps separately from the proposed
whiteboard design.

### Decisions to leave on the board

| Decision | Chosen | Alternative | Accepted cost |
|---|---|---|---|
| Planning | ✅ URL criteria and scoped advisory cache | ❌ Uncoordinated request-per-control state | Freshness and response identity |
| Purchase | ✅ Frozen quote and durable intent receipt | ❌ Parameter hash and blind retries | Recovery protocol and retention |
| Allocation | ✅ One database serialization rule | ❌ Cached availability as authority | Contention that must be measured |
| Payment | ✅ Guarded states and reconciliation | ❌ Browser success or a long SQL transaction | Worker operations and pending UI |

> "I'd finish by walking the same booking through one success and one lost response. If the
> diagram explains both without inventing a second purchase or promising an unallocated room,
> the design has earned its complexity."
