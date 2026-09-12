# Airbnb — Full-Stack System Design

*A 45-minute walkthrough from a guest's search to a recoverable reservation.*

This is a proposed production design, with balanced frontend and backend depth.
The checked-in project is a local learning application; its implementation and
limitations are documented in [architecture.md](./architecture.md).

## 📋 Frame the product — 4 minutes

> “I would build around one journey: a guest finds a property, selects dates,
> understands the price and gets a reliable reservation outcome. The host's
> calendar and approval flow must agree with what the guest sees.”

A listing represents one independently bookable property. Guests can search by area,
dates, party size and attributes. Hosts can offer instant booking or approve requests.
Both parties can message, cancel according to policy and review a completed stay.

I would ask whether a map and actual payments are required. For the main discussion,
I include a map as an alternate search view and describe where a payment workflow
would connect, without designing the processor itself.

A complete support console, dynamic pricing model and recommendation engine can
wait. They should not crowd the whiteboard before the reservation invariant is clear.

The experience depends on three distinct facts:

- Search says a property is a useful candidate for this query.
- A quote says what this particular trip would cost under current rules.
- A reservation says the authoritative service accepted an inventory claim.

Search can be slightly stale. A confirmed reservation cannot overlap another active
reservation for the same property. The frontend must communicate that distinction
without asking the guest to understand databases or distributed systems.

Assume ten million listings, a peak of ten thousand searches per second and one
hundred booking attempts per second. These are sizing assumptions, not measurements.
Read-heavy discovery and concentrated inventory writes need different scaling paths.

## 🏗️ Draw one end-to-end architecture — 5 minutes

```
┌──────────────────────┐      ┌──────────────────────────────┐
│ React web client     │─────▶│ API / sessions               │
│ Search, listing,     │      └────────┬─────────────┬───────┘
│ booking, host tools  │               │             │
└──────────────────────┘               ▼             ▼
                           ┌────────────────┐ ┌─────────────────┐
                           │ Search / cache │ │ Booking / rules │
                           └────────┬───────┘ └────────┬────────┘
                                    ▼                  ▼
                           ┌────────────────┐ ┌─────────────────┐
                           │ PostGIS reads /│ │ Database +      │
                           │ search view    │ │ outbox          │
                           └────────────────┘ └────────┬────────┘
                                                       ▼
                                              ┌─────────────────┐
                                              │ Broker / workers│
                                              │ notifications   │
                                              └─────────────────┘
```

A CDN serves public images and static assets. The diagram's service boundaries are
logical at first; a modular Express application and PostgreSQL/PostGIS can support
the initial implementation without a fleet of small deployments.

Search retrieves and ranks candidates. Booking owns inventory and transitions.
An outbox records downstream work with the booking transaction. Workers update
projections and deliver notifications after the core operation commits.

In the frontend, the router owns navigable identity, local state owns temporary
edits, and a data layer owns server responses. A stable listing ID connects a card,
a map marker, a detail page and a reservation request.

I would render public listing content early for discoverability and perceived speed,
then load availability and personalized controls separately. Authenticated host tools
can be client-rendered. Private booking data must not enter a shared public cache.

We can walk through the system in five steps:

1. Apply a destination/date query and retrieve candidates.
2. Open a listing and load its rules, calendar and photos.
3. Obtain a quote for the selected dates and guests.
4. Submit one identified reservation operation to the inventory authority.
5. Show its durable state and deliver downstream updates asynchronously.

The browser never confirms a booking just because a calendar looked empty. The
server never assumes a successful database commit means the browser received it.

## 💾 Agree on data and contracts — 4 minutes

| Domain record | Information that matters |
|---------------|--------------------------|
| Listing | Host, location, capacity, attributes, active state and booking mode |
| Calendar rule | Listing, date interval, availability or pricing rule and version |
| Booking / occupancy | Guest, listing, half-open stay interval, state and deadline |
| Quote | Input identity, itemized amount, currency, version and expiry |
| Client operation | Actor, stable key, request fingerprint and durable result |
| Outbox event | Event ID, booking ID, version and payload |
| Conversation / review | Authorized participants, booking relationship and visibility policy |

A stay from September 10 to September 12 occupies two nights, ending before the
night of September 12. The same date-only convention must hold in the browser,
API validation, price calculation and database conflict query.

Money also needs one contract. The server returns the currency and price components;
the browser formats them. Store the agreed snapshot so later host edits do not
silently change an existing reservation's amount.

| API operation | UI dependency |
|---------------|---------------|
| Search | Query identity, cards, pagination and degraded/empty distinction |
| Listing and calendar reads | Public content, bounded date window and rules |
| Quote | Matching dates/guests, amount, currency and expiry |
| Create / recover reservation | Stable operation key, booking identity and current state |
| Host calendar update | Intended interval, expected version and conflict details |
| Host response / cancellation | Authorized state transition and resulting booking state |

I would define errors as part of this contract. Invalid dates, occupied dates,
expired quotes and service failure require different recovery actions. Returning
only a generic error string leaves the frontend guessing about user intent.

## 🔧 Deep dive: Keep discovery coherent across browser and server — 7 minutes

> “The search result must answer the query currently on the screen. That sounds
> obvious, but URL state, local filters, cache keys and delayed responses can each
> make the application answer a different query.”

### One applied search identity

Keep edits in a draft until Apply. Then normalize the destination, dates, guests,
filters and sort order into one URL query. That query identifies the server request,
cache entry and result pages.

A selected destination contains a resolved area or coordinates, not just text.
If the user changes the text, clear the old resolved identity. Otherwise “Rome” can
remain paired with coordinates from a previous Paris selection.

Suggestions use a short debounce and support keyboard selection. If resolution
fails, preserve the input and offer retry. Choosing an arbitrary first suggestion
can send the guest to an area they did not intend.

Browser Back restores the applied query and its result context. Opening a listing
and returning to search should preserve filters and scroll position where possible.
That behavior matters because guests compare several properties before committing.

### Guard against stale responses

Suppose a guest changes party size from two to six while the two-person request is
still running. Cancel the old request if possible, but also reject its result if
its identity no longer matches the applied query.

Use the same guard for later pages and quotes. A cancelled request can already have
completed, so cancellation alone is not a correctness condition.

The server cache key must include every field that changes results. A compact hash
of a canonical query can work; cutting off an encoded query loses later filters
and can return the wrong property set for the same destination.

### Retrieve candidates efficiently

I would start with PostGIS to narrow nearby active properties, apply capacity and
attribute filters, and exclude occupied date ranges when dates are supplied.
The database already owns those relationships, so this avoids a second data pipeline.

At higher read load or with richer ranking, build a separate search projection.
That projection needs versioned updates, replay and lag measurement. It may briefly
show a property that has just been booked or removed.

Revalidate active status and inventory at commitment. Making search globally
synchronous would add latency and failure coupling, while still not reserving dates
for a guest who keeps a tab open for twenty minutes.

Return bounded pages with stable IDs and a continuation tied to the query. An exact
total can be omitted if it requires a costly scan without materially helping the
user choose the next property.

### Keep the map and result list aligned

Cards and markers share listing IDs. Highlighting a marker should not cause a new
search. For map movement, an explicit “Search this area” action gives the user
control and avoids requests during every tiny pan.

Provide a list-based way to inspect and select every visible candidate. A map is
helpful context, but cannot be the only accessible navigation mechanism.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ One applied query and bounded stale discovery | Predictable navigation and independent read scaling | Query normalization and final inventory revalidation |
| ❌ Separate state copies plus assumed-fresh results | Faster initial wiring | Wrong-query responses and misleading availability |

During refresh, old results may remain visible with an updating indication. If the
new request fails, identify the old results as belonging to the previous query.
Do not turn an infrastructure failure into “No places found.”

## 🔧 Deep dive: From date selection to a durable reservation — 9 minutes

> “I would spend the most time here because one boundary error can look like a
> minor calendar bug in the browser and become a double booking in the backend.”

### Make the selection and quote agree

The calendar treats check-in as inclusive and checkout as exclusive. It validates
the whole stay, including blocked nights between the endpoints, minimum nights and
maximum nights. A checkout boundary may be usable even when that night's check-in
is not.

Use date-only values in the property's calendar. Avoid converting selected days to
UTC instants and then interpreting them in the traveler's time zone. The guest is
booking local nights, not a duration calculated from the browser's clock.

Each date or guest-count change invalidates the old quote. When a response arrives,
compare its input identity before displaying the amount. A price for two guests
must not replace a newer six-guest quote merely because it arrived later.

If a calendar request fails, show that availability is unknown. An empty calendar
from a successful response and an empty local array after an exception must not
produce the same reassuring display.

The quote should state its expiry and currency. A valid quote is not a hold on the
property. If inventory or price changes before submission, the server returns a
specific conflict and the browser preserves the selection for review.

### Commit through one inventory authority

The browser creates an operation key and submits it with the selected quote or
validated inputs. The server authenticates the guest, validates rules and resolves
whether that operation already has an outcome.

In a short database transaction, lock the listing, inspect occupied intervals and
create both the booking and its occupied interval. Write the operation result and
an outbox event in that same transaction.

Competing creators for one listing serialize at the lock. The later transaction
sees the earlier committed occupancy and rejects overlapping dates. Different
listings can proceed independently.

Instant booking returns confirmed. A host-approved request returns pending and,
under the policy chosen here, occupies inventory until response or deadline.
The frontend must not label that pending request as confirmed.

### Include every calendar writer

Host acceptance, cancellation, expiry and host calendar edits need the same listing
lock and a current state check inside the transaction. A preliminary read followed
by an unconditional update does not protect the lifecycle.

For example, a host reads “pending,” a guest cancels and releases the dates, then
the host's delayed update says “confirmed.” Without a shared protocol, the first
booking is confirmed without its block and another guest can book the same nights.

With state checks under the shared lock, one transition wins. The other returns a
conflict with the current state. A background expiry job follows the same rule;
it cannot release inventory based on an old snapshot.

I would also consider a database constraint against overlapping active occupancy
as a backstop. Correct transitions remain necessary even with that constraint.

### Recover an uncertain response

The database may commit before the connection fails. The browser should show
“Checking your reservation” and recover the same operation identity, rather than
immediately declaring failure and creating a second attempt.

| Server outcome | Guest experience |
|----------------|------------------|
| Confirmed | Show booking ID, dates and confirmation |
| Pending host response | Show request ID, deadline and pending status |
| Inventory conflict | Preserve dates and offer a revised selection |
| Quote changed | Show the revised amount for acceptance |
| Response lost | Recover the original operation until its state is known |

A disabled button reduces accidental double clicks but does not handle reloads or
network retries. Server idempotency requires a unique actor/key pair and a request
fingerprint; a reused key with different inputs must be rejected.

When the user returns from login, restore the draft and revalidate it. The stored
draft helps the guest continue; it is not authority to book silently with an old quote.

### Trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Authoritative transaction plus recoverable operation | Consistent inventory and truthful UI outcomes | Lock contention and explicit pending/recovery states |
| ❌ Optimistic confirmation from cached availability | Fast-looking success | Can promise dates or conceal a booking that already committed |

I would choose correctness at this boundary because users make travel plans around
a confirmation. Keep the transaction small, bound lock waits, and show clear progress
rather than hiding the cost behind an unreliable success screen.

## 🔧 Deep dive: Host changes and downstream delivery — 7 minutes

> “After a booking succeeds, the rest of the system must catch up without being
> allowed to rewrite that decision from stale browser state or an old event.”

### Save host intent with conflict detection

A host edits an interval, not a complete copy of the month's calendar. Send the
intended change and an expected version. The server verifies ownership and current
occupancy under the same inventory protocol used for bookings.

If a guest booked the edited nights while the host's tab was open, return the current
state and the conflicting dates. Preserve the host's unsaved draft so they can revise
it. Do not replace the calendar with a generic error page.

A whole-calendar version is a simple start, though it can reject independent edits
to different dates. Finer conflict checks can come later if those false conflicts
become a frequent usability problem.

For listing creation, save a recoverable draft across wizard steps. Photo previews
have their own pending/uploaded/failed states. Publishing should require accepted
fields and required uploaded images, then navigate to a valid management route.

### Deliver events after the commit

Booking confirmation should not wait for email or analytics. However, simply
publishing to a broker after commit loses work if the process dies in between.
The outbox makes that pending work part of the same durable database change.

A relay publishes events with broker confirmation and retries from the outbox.
It can publish twice if it crashes after broker acceptance but before recording
progress. Consumers must therefore tolerate duplicate event identities.

Each consumer has its own receipt scope. Analytics processing a booking event must
not mark it globally processed and prevent the notification consumer from acting.
For database effects, commit the receipt and effect in one transaction.

Repeated failures need a persisted attempt count, a delay and an eventual dead-letter
route. Requeuing an unchanged message does not magically increase its custom retry
header. A dead-letter queue also needs a matching route and a controlled replay path.

### Handle delayed effects without changing ownership

A cancellation may reach a projection before an older creation event. Apply booking
versions or reconcile current state; do not let an old event recreate occupancy.
Only the booking authority allocates and releases inventory.

Notifications can describe the booking state recorded in the event or fetch current
state according to product policy. The notification must not become the sole record
that proves whether the guest has a booking.

If payments are included, record a bounded hold and a payment attempt, then contact
the provider outside inventory locks. Recover uncertain processor responses by their
identity. A late success after the hold expires requires compensation or manual
resolution, not unconditional confirmation of already reallocated dates.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned host edits and durable asynchronous work | Recoverable conflicts, retries and projection lag | More explicit state and operational tooling |
| ❌ Blind calendar replacement and best-effort events | Fewer initial moving parts | Lost host updates, lost events and stale effects |

The browser, database and workers each keep enough identity to detect stale work.
That is the shared design principle: a later arrival is not automatically the newest
intent or the most authoritative fact.

## ⚡ Performance, privacy and secondary flows — 5 minutes

Image delivery dominates many listing pages. Use responsive variants, reserve layout
space, prioritize visible images and lazy-load the rest. Load the map only when used.
A bounded result page avoids rendering an unbounded catalogue in the browser.

If users accumulate hundreds of cards, virtualize the list while preserving position
by listing ID. Do not add that complexity to a small page without measuring a problem.
The map and list should remain synchronized when items are reused or scrolled away.

Calendars need keyboard navigation, clear labels and explanations for unavailable
choices. Host forms need field errors, focus handling and preserved drafts. Color
alone is insufficient to communicate pending, blocked or conflicting inventory.

Authentication can use HTTP-only session cookies. Authorization is enforced on the
server for every listing, booking and conversation, including relationships supplied
in a request. Hiding a button is not an authorization mechanism.

Keep private booking details out of public listing caches. Validate upload ownership
before durable acceptance and define cleanup for abandoned photos. Logs need useful
request and operation IDs without raw session credentials.

For messaging, persist messages with IDs and paginate history. A live connection
improves delivery latency, but reconnecting clients recover from stored history and
reconcile their pending sends. A lost socket should not lose a message permanently.

Reviews follow a declared mutual-reveal/deadline policy. The server enforces who can
submit and when content becomes visible. A serialized reveal decision or repair job
handles simultaneous submissions; a client timer cannot authorize disclosure.

I would measure four user-facing paths separately: search, quote, booking decision
and outcome recovery. Behind them, monitor lock waits, stale-state conflicts, outbox
age and consumer failures. A queue being reachable does not mean its consumers work.

## 🧪 Validate, then grow — 4 minutes

The most useful end-to-end test follows one piece of intent across boundaries.
I would begin with these scenarios:

1. A late old search response arrives after the guest changes dates.
2. Two adjacent stays share a checkout/check-in boundary without conflict.
3. Two guests concurrently request overlapping dates and only one succeeds.
4. Host acceptance races with guest cancellation or request expiry.
5. A booking commits, the response is lost, and the browser reloads to recover it.
6. A host edits stale calendar data after a new reservation.
7. An event is duplicated and delivered out of order to multiple consumers.

Browser tests can verify visible state and preserved inputs. Real database tests
must verify inventory concurrency. Broker restart and consumer replay tests establish
recovery behavior that mocked route tests cannot demonstrate.

As traffic grows, cache images and public metadata, then separate search reads from
booking writes. Partition booking and occupancy together by listing ID when needed.
Guest trip lists can use a user-oriented projection instead of cross-partition writes
inside every reservation transaction.

Regional replicas improve browsing. Writes for one property retain a designated
authority; a disconnected region cannot independently sell the same inventory.
This availability trade-off follows from the product invariant.

The local project contains the core React pages, PostGIS retrieval and a transactional
creation path. It currently lacks several guarantees in this proposed design,
including a shared lifecycle protocol, stable booking operation identity, reliable
workers and complete host editing. The implementation document keeps those boundaries
explicit so the interview answer can discuss the intended design honestly.

> “I would judge the system by whether the guest's chosen trip survives navigation,
> races and lost responses. The frontend preserves that intent, the database decides
> ownership, and recoverable asynchronous work lets the rest of the marketplace
> catch up without inventing a different outcome.”
