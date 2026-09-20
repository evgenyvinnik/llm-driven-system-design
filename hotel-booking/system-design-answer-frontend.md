# Hotel Booking — System Design Answer (Frontend Focus)

*45-minute interview walkthrough. This is a proposed design; the final section identifies the
local implementation's limits.*

## 🎯 Scope and opening — 4 minutes

> "Hotel booking looks like ordinary e-commerce and has one property that changes the whole
> client design: availability is a function of a date range, not one catalog number. Whether a
> room is free on the 17th depends on the bookings occupying that night. Changing either date
> changes the question."

That has three consequences the frontend has to live with. The date picker is the primary
input to an expensive query, so its design determines how much load the client generates.
Search results are advisory, while the booking service owns allocation. And booking submit is
money-bearing and double-click-prone, so the client participates in an idempotency protocol.

I'll go deep on those three. Availability can be computed from booking intervals or maintained
as per-night counters; either way, a single hotel-level “rooms left” number is insufficient.

### Questions I'd ask first

**“Do we hold inventory during checkout?”** A real hold allows the UI to describe a bounded
reservation window. Without a hold, reassurance about keeping a room is only a guess. This
answer decides how much confidence the flow can project.

**“Can a booking span multiple room types?”** I'll start with a quantity of one type in one
hotel. A basket can still have frozen parameters and one intent identity, but its server
transaction must allocate several resources together.

**“How volatile is pricing?”** Occasional date overrides and frequently repriced offers make
different demands on quote expiration and price-change acceptance. I would agree on whether
taxes and cancellation terms are included in the quote.

### Requirements

| Requirement | User-visible contract |
|---|---|
| Search and compare | Destination, dates, guests, room count, filters and sort survive navigation |
| Inspect a hotel | Nightly prices and availability are dated snapshots |
| Reserve and pay | One intent, accepted total, explicit hold deadline, recoverable status |
| Manage a booking | Held, confirmed, expired and cancelled states have distinct actions |
| Accessibility | Calendar and checkout work with keyboard and assistive technology |

Inventory correctness and payment uniqueness are server guarantees that the frontend must
respect. The browser alone cannot guarantee either. Multi-hotel baskets, intentional
overbooking, and hotel channel integrations are outside this walkthrough. The local demo
simulates payment; the proposed UI relies on a real payment contract without implementing a
payment provider here.

## 🏗️ Architecture and ownership — 6 minutes

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER — proposed frontend                                                                │
│                                                                                            │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Search + hotel detail  │     │ Date range picker      │     │ Checkout + bookings    │  │
│  │ Cards / room choices   │     │ Draft range + focus    │     │ Held / paid / expired  │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                         ▲                              ▲                              ▲    │
│   criteria / results    │        select / inspect      │        submit / recover      │    │
│                         │                              │                              │    │
│                         ▼                              ▼                              ▼    │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ URL criteria           │     │ Advisory query cache   │     │ Saved booking attempt  │  │
│  │ City, dates, guests    │────▶│ Month + room + count   │────▶│ Quote + saved intent   │  │
│  │ Filters + room count   │     │ Price / availability   │     │ Canonical status       │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                         ▲                              ▲                              ▲    │
│                         │                              │                              │    │
│   search identity       │        month snapshots       │        commands / receipts   │    │
│                         │                              │                              │    │
│                         ▼                              ▼                              ▼    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Data access coordinator                                                              │  │
│  │ Validated responses, request generations, cancellation, bounded retries              │  │
│  │ Read errors differ from sold out; booking timeout means outcome unknown              │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
│                                              ▲                                             │
└──────────────────────────────────────────────┼─────────────────────────────────────────────┘
                                               │
                                               │  HTTPS: reads / quote / hold / status
                                               │
                                               ▼
   ┌──────────────────────────────────────────────────────────────────────────────────────┐
   │ Booking API (server boundary)                                                        │
   │ Owns price, inventory, deadline, payment verification and operation receipts         │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

I'd draw the browser boundary first, then the three columns: discovery criteria, advisory date
data, and a purchase attempt. The shared data-access layer is where response validation,
request identity, and error classification live. The server box owns inventory and money;
there is no browser lock.

Follow a search through the left column. Committing valid criteria changes the URL and query
identity. Results render only if they belong to the active query. Opening a room calendar uses
the same date/party scope, with a separate draft selection until the range is valid.

Then follow a purchase through the right column. A chosen room and complete range produce a
server quote. Accepting that quote freezes an attempt and sends a stable intent key. The
response updates canonical booking status. If the response is lost, the same attempt is
recovered rather than silently replaced.

After a reload, I would restore only the bounded account-scoped attempt reference needed for
recovery, then reauthenticate and fetch its canonical status. I would not persist payment
details or infer expiry from a browser timer. A processing payment can remain unresolved after
the original hold deadline; the service decides whether inventory is still allocated.

The arrow from advisory data to the attempt means “request a quote for this selection,” not
“copy a cached price and declare it booked.” This is the authority boundary I'd emphasize on
the whiteboard.

### State ownership

| State | Owner / location | Lifetime |
|---|---|---|
| Committed city, dates, guests, rooms, filters | URL | Shareable, restored on back/forward navigation |
| Incomplete range, open month, keyboard focus | Local picker state | Until selection or dismissal |
| Search results and calendar snapshots | Server-query cache | Scoped keys, bounded freshness |
| Selected room | Client identity tied to current criteria | Cleared or revalidated when criteria change |
| Quote and purchase attempt | Server terms plus client intent identity | Frozen for that attempt |
| Booking status and deadline | Server | Refetched after commands and uncertain responses |
| Authentication | Server session, secure cookie in this proposal | Current account scope; private caches cleared on change |

Search parameters belong in the URL as the committed source of truth. A draft form is allowed,
but it does not become a second independent version of the committed search. This makes
sharing and the search → hotel → back journey predictable.

The current application instead persists a bearer token in localStorage and keeps search
criteria in a memory store. The table describes the design I would build, not behavior already
present.

## 🔍 Deep dive 1: The date picker is the expensive query — 9 minutes

The picker is a query builder. It should not trigger an availability request for every
intermediate input state or mouse hover.

### Why naive date handling is costly and wrong

Two independent inputs that each fire a query on change produce at least two requests per
range selection. The first can contain a new check-in with an old, earlier check-out.
Debouncing reduces frequency but does not establish that the range is meaningful.

Hotel nights are half-open intervals. A stay from the 17th to the 19th occupies the nights of
the 17th and 18th, not the 19th. Treating both ends as occupied over-counts by one night:
wrong price, wrong availability, and an answer that looks plausible.

| Approach | Why choose or reject it here | Cost |
|---|---|---|
| ✅ Commit one complete, valid range | Avoids querying invalid intermediate dates | Draft and committed state must be distinct |
| ✅ Fetch month snapshots for the calendar | Supports immediate selection and price comparison | Cache freshness and adjacent-month handling |
| ❌ Fetch on every cell interaction | Repeats expensive work for transient UI state | High request volume and response races |
| ❌ Debounce as the only rule | Can still submit an invalid range | Fewer requests without correctness |

### What I'd build

**Treat the range as a single value.** It is invalid until both endpoints exist and checkout
is strictly after check-in. Date-dependent requests wait for a valid committed range; undated
discovery can still work separately.

**Fetch availability by month for the picker.** The calendar must show nightly constraints
before the user chooses. Cache each month by hotel, room type, and relevant occupancy inputs,
then prefetch at most an adjacent month. Browsing a fresh cached month needs no network
request; stale months still need refresh.

This does not eliminate the final range check. A multi-room stay needs sufficient capacity on
every occupied night, not merely an available arrival and departure cell. Calendar hints and a
binding hold answer different questions.

**Encode the half-open convention in one place.** Use one date-only operation to enumerate
occupied nights, shared by validation and display. Do not turn hotel dates into host-local
timestamps and divide elapsed milliseconds by a day. Hotel nights remain calendar dates across
daylight-saving changes.

For example, a three-night stay crossing a clock change still has three nightly prices. The
client's locale affects formatting; the hotel's date convention determines occupancy. The
server returns authoritative monetary totals and, when needed, the nightly breakdown.

### Selection and rendering

| Calendar fact | Presentation |
|---|---|
| Occupied night has insufficient rooms | Unavailable reason, not color alone |
| Night is inside the range | Continuous highlight with distinct endpoints |
| Checkout date is sold out for that night | May still be a valid departure date |
| Date is in the past | Different explanation from sold out |
| Snapshot is loading or failed | Pending/unknown state, never fabricated availability |

A middle night with insufficient rooms invalidates the range even when both endpoints look
selectable. A checkout date's own night need not be available because the guest is leaving
that day. Today should use the agreed hotel-date rule consistently in both rendering and click
handling.

Keep text entry available. The grid needs keyboard movement, meaningful date labels, month
announcements, and focus restoration when its dialog closes. Announce the selected range and
number of nights rather than requiring users to infer them from shading.

### What I give up

Monthly batching can fetch dates the user never needs, and a cached snapshot can become stale.
I accept that bounded waste for a responsive planning interface, then recheck on quote/hold.
Aggressively prefetching a whole year would lose the benefit by multiplying traffic and
retaining stale data.

> "Once I see the date picker as a query builder, refusing invalid ranges and batching
> calendar reads become part of the design rather than late performance polish."

## 🔍 Deep dive 2: Advisory search versus a binding hold — 8 minutes

Two data sources have different authority, and the UI must represent that difference honestly.
An indexed hotel match and an availability check can both be useful without constituting a
reservation.

### The mismatch

Search can enrich a bounded candidate page with dated availability. That is a reasonable
product choice: forcing users to open every sold-out hotel would waste their time. The local
backend already does this enrichment.

The danger is equating “available when checked” with “allocated to you.” Another guest can
take the last room after that read, and a cached read may already be behind. The frontend
cannot close that window; only the authoritative reservation transaction can.

| Surface | May claim | Must not imply |
|---|---|---|
| Undated result | Typical or starting price | Price for an unspecified stay |
| Dated result/detail | Availability checked for these dates and room count | Inventory held for this user |
| Accepted quote | Total and terms valid until the stated deadline | Inventory unless a hold was created |
| Reserved booking | These rooms are held until the server deadline | Payment completed |
| Confirmed booking | Server-verified confirmation | More payment facts than the server has verified |

“From $180” and “Available when checked for these dates” describe different evidence. Both
need accurate scope. A dated total must incorporate nightly overrides and quantity; a hotel's
minimum base rate is not that total.

### The trade-off

| Approach | Benefit | Limitation |
|---|---|---|
| ✅ Bounded advisory enrichment | More relevant results within a read budget | Can be stale and needs coherent pagination |
| ❌ Check every matching hotel synchronously | Looks exhaustive | Fan-out can overwhelm inventory reads |
| ❌ Never check dates until checkout | Cheap initial search | Repeated dead ends for guests |

I would ask the API for a continuation token or an honest approximate result count. Filtering
one page and labeling its surviving length as the total creates broken pagination. The client
should not attempt to repair an incoherent backend count by guessing.

### Normal failure and unknown outcome

The no-longer-available path deserves the same care as success. Keep the guest's details,
explain that availability changed, and offer nearby dates or another room. If the server
explicitly rejects before any payment attempt, the UI can state that no payment was initiated.

A network timeout is different. It does not establish rejection or prove that nothing was
charged. Show “Checking your booking” and recover the existing intent. Avoid an enabled “Try
again” action that silently creates a new purchase identity.

If an availability read fails, retain criteria and show an unavailable-to-check state.
Displaying “Sold out” would turn an infrastructure failure into a false inventory claim.

### Preventing stale UI responses

Each request carries the query identity and account generation it belongs to. Abort superseded
reads when possible, and reject late responses even if cancellation loses a race. Changing
dates invalidates the selected room's quote and availability, rather than retaining an old
room object with new dates beside it.

This also applies to owner dashboards: changing the selected hotel must not let an earlier
request replace its bookings or statistics. Separate loading/error state per resource instead
of one global spinner.

> "The design does not ban availability in search. It makes the strength of each claim match
> the evidence: checked, quoted, held, and confirmed are different states."

## 🔍 Deep dive 3: Making booking submit repeatable — 9 minutes

A user double-clicks Book. Two requests can be fully serialized, with the second arriving
after the first commits, yet both can look like valid purchases. Locks solve contention over
inventory. Repetition needs identity.

### Where identity comes from

The local server hashes user, hotel, room type, dates, and room count. That recognizes some
repeated payloads, but also conflates a legitimate second booking with the first, even after
cancellation. It omits party/contact details, and the current cached replay format is
defective.

For the proposed contract, generate a purchase-intent key when the user accepts a quote.
Freeze the quote ID, guest details, date/room scope, and key. Every retry sends the same
attempt. A separate intentional purchase creates a new key, even if its dates happen to match.

| Layer | Responsibility | Client obligation |
|---|---|---|
| Durable intent receipt | One result per account/key, with payload binding | Retain the same key and frozen request on retry |
| Inventory transaction | Allocate available room nights | Wait for the server result |
| Single in-flight action | Avoid accidental concurrent sends | Disable action and guard the command synchronously |
| Recovery | Resolve a lost response | Look up or replay the existing attempt |

The server commits its receipt with the booking and handles simultaneous unique-key contention
by returning the winning result. A client button cannot substitute for that protocol; another
tab or a retried HTTP request can bypass it.

### Client-side layers

- Disable the button and name the state: “Reserving…” or “Checking payment…”.
- Treat a canonical duplicate result as success, then render its actual current booking status.
- Never optimistically confirm a reservation or payment.
- Keep recovery identity across navigation or reload without persisting unnecessary guest details in browser storage.
- If the user edits accepted terms, obtain a new quote and explicitly start another attempt; do not mutate the payload under an existing key.

A malformed response is also uncertainty. Validate the DTO before rendering a paid total or a
deadline. If only a booking ID can be recovered, fetch canonical detail rather than trusting
missing or null amounts.

### Hold and payment states

A real reserved state gives the frontend a window it can honestly describe. Show the server
deadline and use a server-time offset for the countdown. The timer explains remaining time; it
does not decide whether a server transaction is allowed.

| State | UI action |
|---|---|
| Quote ready | Review exact price and policy |
| Hold active | Complete payment before the stated deadline |
| Payment processing | Prevent new attempts; recover this attempt's status |
| Confirmed | Show durable booking reference and verified payment information |
| Expired | Explain release; request a fresh quote/hold if the user chooses |
| Outcome unknown | Reconcile status; do not claim success or failure |

The backend must check the deadline on commands, even if the expiry worker is delayed. A late
payment result needs reconciliation, not a client assumption that a room is still owned.
Refresh status on focus/reconnect and near meaningful transitions, with bounded polling while
payment is pending.

### Price must not drift

Two implementations of “price of this range” will diverge when an override lands mid-range.
Render a server quote with currency, total, breakdown, and terms. If it has expired or
changed, show the old and new terms and ask for renewed acceptance before purchase.

A nightly breakdown must also come from the server. Dividing a total evenly across nights
invents prices when overrides differ. The hold response must preserve the accepted amount, so
the booking receipt and checkout review agree.

### What I give up

Intent retention and unknown-state recovery add UI and server complexity. A parameter hash and
a disabled button are easier, but fail precisely when networks and people repeat actions. For
a purchase involving scarce inventory and money, recovery is part of the main flow.

> "Idempotency is a joint protocol. The server must durably recognize an intention, and the
> client must be consistent about which intention it is retrying."

## 🧪 Validation, growth, and local boundary — 9 minutes

### The bookings list is where trust is kept

The post-purchase surface deserves attention because it is where a booking either feels real
or does not. Held bookings need a deadline and action; confirmed bookings need a durable
reference; cancelled bookings stay visible as evidence that cancellation succeeded.

Split upcoming stays from history using stay dates. State the cancellation consequence before
submission, including whether a refund is pending rather than completed. The client should
render server-calculated eligibility and refund status, not independently interpret a
free-text policy.

Accessibility includes more than the calendar: announce meaningful price/status changes,
associate labels with fields, focus the first actionable error, and preserve the form after
rejection. Modal focus must remain usable during saving and on completion.

### Tests that exercise the contract

| Scenario | Expected behavior |
|---|---|
| Double click or simultaneous retry | One intent and one booking result |
| Response lost after server commit | Recover same booking; no false failure or new purchase |
| Same key with edited payload | Explicit conflict; old receipt is not silently reused |
| Last room sold after detail read | Clear rejection and retained guest input |
| Middle night unavailable | Range rejected; valid departure night handled separately |
| DST, leap day, month boundary | Same occupied-night count across UI and server |
| Old search response arrives late | Current criteria and result list remain paired |
| Hold deadline passes during payment | Canonical server state governs recovery |
| Logout/account switch during request | Private response cannot populate another account's view |

The money and concurrency cases need real API/database integration tests as well as client
simulations. A UI-only test can pass because the button is disabled while the backend still
mishandles retries.

### What breaks first

First measure availability fan-out and stale-result rejection rates. Monthly batching, bounded
prefetch, and valid committed ranges control frontend-generated load. Then address image bytes
with reserved dimensions, responsive sources, and lazy loading below the fold.

Hotel pages benefit from indexable initial content, while private checkout remains
account-specific. A server-rendered public shell is a possible production choice; the demo is
a Vite client application. At twenty results per page, virtualization is lower priority than
image weight and correct pagination.

Owner pricing tools eventually need range editing and previewing seasonal changes. A
single-date form is a sensible demo, but bulk edits need server validation and visible
partial-failure handling. Multi-type baskets retain the frozen-attempt idea while adding
server allocation complexity.

### What is actually present

The React demo has monthly calendar fetching, a submitting state, owner room forms, and
separate reserved/confirmed/cancelled statuses. Its backend runs an expiry sweep every minute;
the earlier claim that no sweeper exists is incorrect. Confirmation currently checks only
reserved status, so a late sweep leaves a deadline-enforcement gap.

Search already performs dated availability filtering, but returns Elasticsearch field names
that cards do not expect. URL restoration, complete range validation, stale-response guards,
server quotes, client intent keys, and recovery states are incomplete or absent. Booking
detail's “Total Paid” label and fabricated payment ID do not represent real payments.

I would present the diagram and three decisions as the proposed design, then use
[architecture.md](./architecture.md#implementation-notes) to explain this implementation
boundary when discussing the repository.

### Trade-offs to leave on the board

| Decision | Chosen | Alternative | Cost accepted |
|---|---|---|---|
| Calendar reads | ✅ Valid ranges + cached month snapshots | ❌ Request per interaction | Freshness and draft-state coordination |
| Search availability | ✅ Bounded advisory enrichment | ❌ Exhaustive synchronous checking | Some staleness and explicit unknown states |
| Booking submission | ✅ Stable intent + frozen quote + recovery | ❌ Parameter hash and button disable alone | Durable receipts and uncertain-outcome UI |
| Confirmation | ✅ Canonical server state | ❌ Optimistic success | Pending state while correctness is resolved |

> "The frontend's job is to make planning responsive and purchasing unambiguous. Dates define
> the question, a quote defines the terms, and a server-confirmed reservation defines the
> promise."
