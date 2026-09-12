# Hotel Booking — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"Hotel booking looks like ordinary e-commerce and has one property that changes the whole client design: **availability is a function of a date range, not a number.** Whether a room is free on the 17th depends on every booking whose stay straddles that night, so 'is this available' can't be cached as a boolean or decremented as a counter — it's a query over intervals, and the answer changes the moment either date changes.

That has three consequences the frontend has to live with. The date picker is the primary input to an expensive query, so how it's designed determines how much load the client generates. Search results are **advisory** — Elasticsearch matches hotels, but only Postgres knows if a room is actually free — so the UI must never present a search result as a guarantee. And the booking submit is money-bearing and double-click-prone, so the client has to participate in idempotency rather than assuming the server handles it.

I'll go deep on those three."

---

## 🎯 Requirements

### Functional

1. **Search** hotels by destination, dates, guests, with filters
2. **View a hotel** with per-night availability and pricing
3. **Book** a room for a date range, safely
4. **Manage bookings** — view, confirm, cancel
5. **Review** a completed stay
6. **Admin** — manage hotels, room types, pricing overrides

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Never confirm an unavailable room | Absolute | Someone arrives at midnight with nowhere to sleep |
| No double bookings from double-clicks | Guaranteed | Two charges for one stay |
| Availability query volume | Minimized | Each one is an interval scan, not a lookup |
| Calendar interaction | Instant after first load | Browsing months is the most common action |
| Date selection | Unambiguous | Off-by-one on check-out is the classic booking bug |
| Price shown = price charged | Always | Dynamic pricing makes drift easy and unacceptable |

### Non-goals

No real payment processing, no multi-room-type baskets, no group bookings. Group bookings in particular would change the availability model from "N of this type" to a constraint-satisfaction problem.

I'd also flag that this design has no notion of **overbooking**, which real hotels do deliberately at 5–10%. That's not an omission the frontend can paper over: it would mean availability has two thresholds — what's sellable and what physically exists — and the UI would need to represent a booking that's confirmed but not guaranteed. Worth knowing it's out of scope rather than assumed away.

---

## 🏗️ Architecture

```
        ┌───────────────────────────────────────────────┐
        │                   Browser                      │
        │                                                │
        │   Search ──▶ Hotel detail ──▶ Booking flow     │
        │     │             │                │           │
        │     │        availability          │           │
        │     │        calendar              │           │
        │     └─────────────┴────────┬───────┘           │
        │                       ┌────▼─────┐             │
        │                       │  Stores  │             │
        │                       └────┬─────┘             │
        └────────────────────────────┼──────────────────┘
                                     │
                         ┌───────────▼───────────┐
                         │     API (Express)     │
                         └──┬─────────────────┬──┘
                            │                 │
                  Elasticsearch          PostgreSQL
                  (matching only)   (availability = truth)
                                          + Redis
                                    (cache, locks)
```

Note what the client is *not* responsible for: none of the three concurrency layers are visible to it. The browser makes one call and either gets a booking or doesn't. **That's the right division** — a client that tried to participate in locking would be reimplementing a distributed system in a tab that can close at any moment.

**The split between the two stores is the client's most important constraint.** Elasticsearch answers "which hotels match this city, price band and amenities". It is never consulted about whether a room is free. So a search result card can say "from $180/night" and cannot say "available" — and designing the UI as though it could is how you build a product that promises rooms it doesn't have.

---

## 🧭 Questions I'd Ask First

**"Do we hold inventory during checkout?"** The system creates a booking in a `reserved` state before confirmation, which is effectively a hold — so the UI can show a countdown and mean it. If there were no hold, every reassurance the checkout gives would be a guess. This single answer decides how much confidence the flow can project.

**"Can a search span multiple room types or hotels?"** Single-room booking keeps availability a per-room-type question. A basket spanning types makes it a joint constraint, and the frozen-parameter idempotency model stops fitting.

**"How volatile is pricing?"** Per-date overrides that change weekly are very different from dynamic pricing that moves hourly. The second makes price-drift-at-checkout common rather than rare, which promotes the reconciliation UI from an edge case to a main path.

> "The hold question is the one I'd insist on, because a checkout that holds inventory and a checkout that doesn't should look different to the user — and building the confident version on top of no hold is how you promise rooms you don't have."

I'd also want to know **what the availability cache TTL is**, because it bounds how wrong the calendar can be. Five minutes is fine for a hotel with twenty rooms of a type and materially misleading for one with two — the client can't compensate for that, but it can decide how emphatically to phrase what it shows.

---

## 🔍 Deep Dive 1: The Date Picker Is the Expensive Query (11 minutes)

Every date change invalidates availability and triggers an interval scan. The picker is therefore not a form control — it's the throttle on the system's most expensive read.

### Why naive date handling is costly and wrong

Two independent inputs that each fire a query on change means selecting a range produces at least two queries, the first of which is for a nonsensical state — a new check-in with the old check-out, which may be an inverted or absurdly long range. On a calendar where the user browses months, hovering can trigger far more.

And the correctness half: **hotel nights are half-open intervals.** A stay from the 17th to the 19th occupies the nights of the 17th and 18th, not the 19th. Treating the range as inclusive on both ends over-counts by one night — wrong price, wrong availability, and a wrong answer that looks plausible.

### Options

| Approach | Query volume | Correctness |
|----------|-------------|-------------|
| ❌ Fire on every date change | 2+ per selection, some meaningless | Intermediate invalid states hit the server |
| ✅ **Fire only on a complete, valid range** | One per selection | No nonsense queries |
| ✅ Prefetch a month of availability, filter locally | One per month browsed | Calendar interaction becomes instant |
| ❌ Debounce alone | Fewer, still includes invalid states | Doesn't address the half-open problem |

### What I'd build

**Treat the range as a single value.** One piece of state, invalid until both ends exist and check-out is strictly after check-in. Nothing is requested until it's valid. That eliminates the intermediate-state queries entirely and makes the "no dates selected yet" case explicit rather than an accident.

**Fetch availability by month, not by range.** The calendar has to show which nights are unavailable *before* the user picks, so it needs a month's data anyway. Fetching per month means browsing the calendar — the interaction users do most — costs nothing after the first load, and the selected range is evaluated against data already in hand. One request per month browsed replaces one per interaction.

**Encode the half-open convention in one place.** A single function converting a selected range to a set of nights, used by the price calculation, the availability check and the display. The bug where the summary says "3 nights" and the price charges for 2 comes from two components each doing their own arithmetic.

> "The framing I'd offer is that the date picker is a query builder, not an input. Once you see it that way, batching by month and refusing to emit invalid ranges stop being optimizations and become the obvious design."

---

## 🔍 Deep Dive 2: Search Results Are Advisory, Availability Is Binding (10 minutes)

Two data sources with different authority, and the UI has to represent that difference honestly.

### The mismatch

Elasticsearch holds hotel documents for matching — city, geo, stars, amenities, price bands. Postgres holds bookings, and availability is computed from them. **Search can return a hotel with no rooms free for the requested dates**, because search never checked.

The temptation is to hide that: filter search results by availability so users only see bookable hotels. It's the wrong call, and the reason is architectural — availability is per-room-type, per-night, over a range, and computing it for every search result means running the expensive interval query across the whole result set on every search. That's the query the entire caching and locking design exists to protect.

### How the UI should represent it

| Surface | May claim | Must not claim |
|---------|-----------|----------------|
| Search result card | Matches your criteria; typical price | "Available" |
| Hotel detail | Availability for these dates, as of now | A hold |
| Booking flow | Price and availability re-checked | Confirmed before the server says so |
| Confirmation | Booked | — |

**Language does the work here.** "From $180" is honest; "Available from $180" is a claim search cannot support. And because the detail page performs the real check, it's where a "no rooms for these dates" state must be excellent rather than an afterthought — it's a normal outcome, not an error, and it should offer nearby dates or similar hotels rather than a dead end.

### The staleness that remains

Even the detail page's answer is a snapshot. Between viewing and booking, someone else can take the last room. **The client cannot close that window** — only the server's lock-and-transaction can — so the client's job is to make the failure comprehensible rather than pretending it won't happen.

That means the "no longer available" outcome at submit gets designed as carefully as the success path: it says what happened, confirms nothing was charged, keeps the entered details, and offers alternatives. Generic error handling turns a normal race into what feels like a broken product.

> "I'd resist filtering search by availability even though it's what users ask for, because it moves the most expensive query in the system onto the most frequent request. The honest alternative is to never imply availability until we've actually checked."

---

## 🔍 Deep Dive 3: Making the Booking Submit Idempotent From the Client (9 minutes)

The server layers idempotency, a distributed lock, and a row lock. Only the first needs the client's cooperation — and without it, it doesn't work.

### The failure the locks can't catch

A user double-clicks Book. Two requests arrive. They may be **fully serialized** — the second starting after the first commits — so no lock is contended and both are individually valid bookings for the same stay. The result is two reservations and two charges.

Locks solve concurrency. This is repetition, and repetition needs identity.

### Where identity comes from

The server derives its key from the booking parameters — user, hotel, room type, dates, room count — which means a duplicate submit is recognized by *what it is* rather than by a client-supplied token. That's a robust design and it has one client-side implication worth stating: **the client must not vary those parameters between the two attempts.** Re-deriving dates from a fresh `new Date()` on retry, or letting a room count re-read from a control the user nudged, produces a different key and defeats deduplication.

So the client freezes the booking parameters when the user commits, and every retry sends exactly those.

| Layer | Where it lives | What the client owes it |
|-------|---------------|------------------------|
| Idempotency | Server, keyed on parameters | Send identical parameters on retry |
| Distributed lock | Server, Redis | Nothing |
| Row lock | Server, Postgres transaction | Nothing |
| Double-submit prevention | **Client** | Disable on submit; single in-flight request |

### Client-side layers

The key is correctness; these prevent the situation:

- **Disable the button and label the state** — "Booking…" rather than a spinner beside an enabled-looking control.
- **Treat a deduplicated response as success.** If the server returns the original booking flagged as a duplicate, that's the confirmation screen. Rendering it as an error invites a third attempt through a different path.
- **Never optimistically confirm.** A booking is money and a promise about a physical room; showing "Confirmed" before the server agrees is the same category of error as an optimistic signature.

> "The general rule I keep applying: the server can only deduplicate if the client is consistent about what it's asking for. Idempotency is a joint protocol, not a server feature."

---

## 💰 Price Must Not Drift

Pricing has per-date overrides, so a stay's total is a sum over nights that can change between quote and purchase.

The client displays a quoted total and **must not compute it independently**. Two implementations of "price of this range" — one in the client for display, one in the server for charging — will diverge the first time an override lands mid-range, and the user will see one number and be charged another.

So the server returns the total, the client renders it, and at submit the server re-prices. If it differs, that's an explicit confirmation step showing the old and new totals — never a silent update. Being charged more than the reviewed number is a trust failure regardless of the amount.

The corollary: the client also shouldn't render a nightly breakdown it derived by dividing. If the breakdown matters, the server should return it per night, because with overrides the nights aren't equal.

---

## ⏳ The Reservation Hold Is a UI Contract

A booking is created in a `reserved` state and confirmed separately. That two-step exists so the payment step doesn't hold inventory locks, and it hands the frontend something valuable: **a window it can honestly describe.**

This is the opposite of the Etsy case, where the schema implied a hold that didn't exist. Here the hold is real, so the UI can commit to it:

- **Show the remaining time**, because a countdown is only acceptable when it corresponds to something. It also does useful work — it communicates that the room is genuinely held, which reduces the anxiety that causes double-submits.
- **Say what happens at expiry**, before it happens. "Your room is held until 3:42" is informative; a timer hitting zero with no prior explanation is alarming.
- **Handle expiry as a first-class state.** The reservation lapsing mid-checkout is a normal event: the UI should re-check availability, tell the user plainly, and let them retry rather than submitting into a failure.

The design risk is over-claiming in the other direction — a hold is not a confirmation, and the UI shouldn't let a held reservation look like a completed booking in the user's list. Reserved and confirmed need visibly different treatment, or people will arrive at hotels holding a reservation they never confirmed.

### Where this system actually stands

Worth stating precisely, because it changes what the UI may promise. The `reserved_until` timestamp is written and there's a partial index sized for a sweeper query — **and no sweeper runs.** Nothing transitions an abandoned hold to expired, so inventory committed by someone who closed the tab stays committed indefinitely.

That inverts the usual concern. The risk isn't that the UI over-promises a hold that will vanish; it's that a countdown implies a release that never happens. **A timer reaching zero while the room remains held is a different lie**, and it also leaks inventory — every abandoned checkout permanently removes a room-night from sale.

So until the sweeper exists, I'd show the hold without a countdown to zero: state that the room is held while you complete payment, and treat expiry handling as code that's written but not yet reachable. And I'd raise the sweeper as the priority it is, because this is the kind of gap that looks fine in testing and quietly empties a hotel's inventory in production.

---

## 🗄️ State: Search Params in the URL, Everything Else Ephemeral

| State | Owner | Home | Why |
|-------|-------|------|-----|
| Destination, dates, guests | URL | Query params | Shareable, back-navigable, and the natural key for search |
| Filters, sort | URL | Query params | Same — a filtered search is a thing people send each other |
| Availability for a month | Server | Fetched, short-lived cache | Changes constantly; must not be trusted long |
| Selected room type + range | Client | Store, frozen at submit | The idempotency parameters |
| Quoted price | Server | Store, display-only | Never recomputed locally |
| Auth session | Server | Cookie | — |

**Search parameters belong in the URL and nowhere else.** A hotel search is one of the most-shared URLs on the internet — "here's the place, these dates" — and state held only in a store makes that impossible. It also makes the back button work correctly through the search → hotel → back flow, which is the dominant navigation.

Availability deliberately has a short cache life. Unlike a product catalog, a stale availability answer isn't a cosmetic issue; it's the input to a decision that can fail.

---

## 🧾 The Bookings List Is Where Trust Is Kept

The post-purchase surface gets less design attention than search and deserves more, because it's where a booking either feels real or doesn't.

**Status must be unambiguous.** `reserved`, `confirmed` and `cancelled` mean different things to someone standing at a front desk, and a list that renders them as similar-looking chips invites the worst possible confusion. Confirmed bookings should look settled; reserved ones should look like they need action, with the action available inline.

**Cancellation needs a stated consequence.** Whether a cancellation is free, and whether the room returns to inventory immediately, are facts the user needs *before* confirming — not after. This is the same blast-radius principle as any destructive action, and here the consequence is straightforwardly knowable.

**Past and upcoming stays are different lists.** A single reverse-chronological list buries the trip next week under three years of history. Splitting them is trivial and it's the difference between a useful page and an archive.

**A cancelled booking should remain visible.** Removing it looks like data loss to a user who wants to confirm the cancellation went through — the reassurance is the point.

---

## ♿ Date Pickers Are the Hardest Accessible Widget

Calendars are notorious, and this one carries booking-critical information.

- **Keyboard navigation must work fully** — arrow keys between dates, page keys between months, escape to close. A date picker that requires a pointer excludes people from booking at all.
- **Unavailable nights need more than a grey style.** Disabled state must be programmatically conveyed, and the *reason* announced — "unavailable" rather than silence.
- **The selected range must be announced as a range**, with a night count, because inferring "17th to 19th, 2 nights" from visual highlighting is exactly what a screen reader can't do.
- **Provide text inputs as an alternative.** For many users typing a date is faster and more reliable than navigating a grid; the calendar should augment rather than replace direct entry.

Beyond the picker: price and availability changes during the flow must be announced, not just re-rendered, since a silently updated total is a change the user may not notice before paying.

---

## 🧪 Testing the Money Paths

The valuable tests are the ones that reproduce concurrency and repetition, neither of which appears in manual testing.

| Scenario | Simulation | Protects |
|----------|-----------|----------|
| Double-click submit | Fire the booking action twice synchronously | One booking; duplicate response renders as success |
| Retry with re-derived params | Retry after changing nothing user-visible | Parameters are frozen, so the server still dedupes |
| Room taken between view and book | Fail availability at submit | Comprehensible outcome, entered details preserved |
| Price changed at submit | Return a different total | Explicit confirmation, never a silent charge |
| Half-open range | Select the 17th–19th | 2 nights everywhere: price, availability, summary |
| Inverted range | Pick check-out before check-in | No request fires; state is invalid |
| Month navigation | Browse six months | One request per month, none per hover |

The half-open test is worth writing exhaustively — across month boundaries, across a DST transition, and across a leap day — because the failure is a silent off-by-one in money rather than a crash. **It's also a pure function**, so exhaustive testing costs almost nothing, which is the strongest argument for extracting it in the first place.

The double-click test deserves to run against a real backend at least once. Client-side disabling makes it pass trivially in isolation, which is exactly the false confidence that lets a real duplicate through when the disable is bypassed by a fast retry or a flaky network.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Date state | ✅ One range value, valid or not | ❌ Two independent inputs | Prevents queries for nonsensical intermediate states |
| Availability fetch | ✅ By month, filtered locally | ❌ Per range change | Calendar browsing becomes free; one request replaces many |
| Night arithmetic | ✅ One shared half-open helper | ❌ Per-component math | The off-by-one is the classic booking bug |
| Search results | ✅ Advisory, never "available" | ❌ Filter by availability | Would run the expensive interval query per result |
| No-availability state | ✅ Designed as a normal outcome | ❌ Error handling | It happens constantly; it isn't a failure |
| Booking submit | ✅ Frozen parameters, single in-flight | ❌ Re-derive on retry | Different parameters defeat server-side dedupe |
| Duplicate response | ✅ Render as success | ❌ Render as error | The booking exists; an error invites a third attempt |
| Confirmation | ✅ Wait for server | ❌ Optimistic | Money and a physical room |
| Price | ✅ Server-quoted, server-re-priced | ❌ Client-computed | Two pricing implementations diverge on overrides |
| Search params | ✅ URL | ❌ Store | Sharing a search is a core behavior |
| Hold display | ✅ State it's held, no countdown to zero | ❌ Countdown | Nothing expires holds yet; a timer would promise a release that doesn't happen |
| Booking statuses | ✅ Visually distinct | ❌ Uniform chips | Reserved and confirmed mean different things at a front desk |

---

## 🗓️ Rendering Availability Across a Month

The calendar has to communicate several overlapping facts at once, and cramming them into one visual channel is where these UIs fail.

| Fact | How it's shown |
|------|---------------|
| Night is unavailable | Disabled state — with text, not only color |
| Night is inside the selected range | Range highlight |
| Night is a range endpoint | Distinct from mid-range |
| Night has a price override | Price label on the cell |
| Night is in the past | Disabled, visually distinct from "sold out" |

**"Unavailable" and "in the past" must not look the same**, because they mean different things to a user planning a trip — one says "pick another hotel", the other says "pick another month".

The harder rendering problem is the **partial range**. A user with three nights selected where the middle night is unavailable has an invalid selection, and the calendar has to say so at selection time rather than at submit. That means validating the range against the month data already fetched, which is a second payoff from the batch-by-month decision — the client can reject an impossible range instantly, without a request.

Price labels per cell are worth the visual density here. With per-date overrides, the cheapest three-night window in a month is genuinely useful information and it's invisible without them.

---

## 🚀 What Breaks First

**Availability query volume**, before anything visible. The client is the thing generating those interval scans, and a calendar that fetches per interaction rather than per month multiplies them by an order of magnitude. This is the clearest case in the product of a frontend decision determining backend load.

**Then hotel imagery.** Hotel search is photograph-driven, so the same rules apply as in any media-heavy list — explicit dimensions, responsive sources, lazy loading below the fold. Not novel, but it dominates bytes on the most-visited screen.

**Then the search result list**, as result counts grow — the usual image-weight and virtualization story, though hotel searches return tens rather than thousands, so it's further out than it would be for a feed.

**Then admin tooling.** Pricing overrides are per-date, and a UI for editing them across a season is a calendar-scale bulk-edit problem that a simple form doesn't serve. It's the surface most likely to be under-built.

**Then admin bulk editing of overrides**, mentioned above — a season of nightly prices edited one form at a time is unusable, and it's the surface where the product's operators live.

**Then the multi-room case**, if it's ever added — because a basket spanning room types turns one availability check into a set of interdependent ones, and the client's single frozen-parameter model stops fitting.

---

## 📝 Summary

Three ideas:

1. **Availability is an interval query, so the date picker is a query builder.** Batching by month and refusing to emit invalid ranges are correctness-and-load decisions, not polish — and the half-open night convention needs exactly one implementation.
2. **Two stores with different authority means the UI must be careful about what it claims.** Search matches; only Postgres knows. "From $180" is honest, "Available" is not, and the no-availability state is a normal outcome that deserves real design.
3. **Idempotency is a joint protocol.** The server dedupes on booking parameters, which only works if the client sends identical parameters on every retry — so the client freezes them at commit, keeps one request in flight, and treats a deduplicated response as the success it is.
