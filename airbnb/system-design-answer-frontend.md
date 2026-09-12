# Airbnb — Frontend System Design

*A 45-minute discussion of discovery, date selection and trustworthy booking feedback.*

This answer proposes a production frontend. The checked-in React application is a
smaller teaching implementation; [architecture.md](./architecture.md) distinguishes
its working flows, missing screens and correctness gaps.

## 📋 Clarify the experience — 5 minutes

> “I would focus on a guest finding a place, understanding whether the dates work,
> and making a reservation without losing their choices. I would also cover the
> host's calendar because that is the other side of the same inventory.”

The primary journey is destination search, results, listing details, date and guest
selection, price review, then a pending or confirmed reservation. A host creates a
listing and manages availability and requests.

I would ask whether a map is required and whether the product supports instant
booking, host approval, or both. For this discussion, I support both booking modes
and treat a map as a useful alternate view of the same search results.

I would leave payment-provider UI internals, recommendations and a complete support
console outside this first whiteboard. Payment status still affects the reservation
screen if payments are added to the product.

The frontend has three different promises to communicate:

- A search result is a candidate matching the current query.
- A quote describes a price for specific dates and guests.
- A reservation is a server-confirmed claim on inventory or a pending request.

Confusing these creates expensive user mistakes. Seeing an available card cannot
mean the dates will remain available while the guest compares other properties.

I would target immediate feedback for local interactions and useful results within
roughly a second under normal conditions. Those are experience goals to validate on
real devices, not a promise that every network request takes the same time.

## 🏗️ Draw the frontend boundaries — 5 minutes

```
┌────────────────────┐        ┌───────────────────────────┐
│ Search route       │───────▶│ Query/data layer          │
│ Filters, cards, map│◀───────│ Identity, cache, requests │
└────────────────────┘        └─────────────┬─────────────┘
                                          │
┌────────────────────┐                    ▼
│ Listing / booking  │◀──────────▶┌───────────────────────┐
│ Calendar, quote    │            │ Marketplace APIs      │
└────────────────────┘            └───────────────────────┘
                                          ▲
┌────────────────────┐                    │
│ Host workspace     │────────────────────┘
│ Drafts, calendar   │
└────────────────────┘
```

The router owns navigable identity: destination, applied filters, listing ID and
booking ID. Components own temporary interaction details. A shared data layer owns
server responses and the keys that distinguish them.

I would use React and TypeScript, with route-level modules for search, listing,
booking, trips and host tools. Zustand can hold small shared client state such as
an unfinished search draft. Server data needs explicit fetching, freshness and
invalidation behavior rather than an unstructured collection of global variables.

A query library could implement that data layer. The important decision is its
contract, not its brand: the same query must have one identity and older responses
must not overwrite newer intent.

For public listing pages, server rendering or prerendering is useful for search
visibility and an early meaningful page. Date availability and personalized actions
then load separately. Host tools can be client-rendered behind authentication.

I would avoid putting private booking data into a shared public page cache. The
rendering boundary also acts as a data visibility boundary.

## 💾 State ownership and API contract — 4 minutes

| State | Owner | Lifetime |
|-------|-------|----------|
| Applied destination, dates, guests, filters | Validated URL query | Shareable; survives reload and navigation |
| Open filter drawer and incomplete edits | Local component draft | Until Apply, Cancel or route exit |
| Listing cards, details and calendar response | Data layer with complete query key | Until stale or invalidated |
| Quote | Server identity plus matching local inputs | Until input change or expiry |
| Reservation attempt | Durable server operation identity | Until outcome is resolved |
| Host listing draft | Local draft plus server draft/version | Across steps and recoverable reloads |

The server owns price, inventory, authorization and booking state. The client can
check obvious input errors for responsiveness, but it cannot grant availability.

I would negotiate a few focused endpoints with backend engineers:

| Operation | Contract needed by the UI |
|-----------|---------------------------|
| Search | Applied query identity, cards, continuation and degradation state |
| Listing details | Public information, photo variants, rules and booking mode |
| Calendar | Date-only occupancy/rules for a bounded window and version |
| Quote | Dates, guests, itemized amount, currency, expiry and quote ID |
| Create or recover reservation | Operation key, durable booking ID and current state |
| Host calendar update | Edited interval, expected version, accepted result or conflict |

These are proposed contracts. The current project combines some of them, including
availability and price preview, and lacks quote and operation-status resources.

I would make validation errors addressable to fields and separate them from service
failure. A failed search should not look identical to a successful search with zero
properties; a stale host edit should not appear to have saved.

## 🔧 Deep dive: Search that follows user intent — 8 minutes

> “I would make the applied URL query the source of navigable search state. The
> tricky part is keeping the controls, cards and map on the same version of the
> search while requests return in an unpredictable order.”

### Separate editing from applying

Typing a destination or changing several filters is a draft interaction. I would
let the user finish that interaction before committing one normalized query.
The Apply action updates the URL and starts a request for that exact query.

For example, changing guests from two to four and adding a price ceiling should
produce one coherent search. Fetching after each individual state assignment can
briefly request combinations the user never intended to apply.

Normalize empty filters, sort order, date format and geographic bounds before
building the query identity. Include every result-affecting field; otherwise a
cached two-person search can be reused for an eight-person trip.

Browser Back restores the previous applied query, its controls and, where feasible,
its results and scroll position. Local draft state must not immediately overwrite
that restored URL with an older store value.

### Control asynchronous responses

Suppose the user searches Paris, then quickly searches Rome. The Paris request may
finish last. I would cancel it when possible and also check response identity before
committing it to the visible Rome screen.

Cancellation saves work; identity protects correctness. The same rule applies to
destination suggestions, result pages, calendar windows and quotes.

Suggestions should distinguish typed text from a resolved destination. If the user
edits a previously selected city, clear its old coordinates. Do not silently search
the old city because its hidden latitude survived the text edit.

A short debounce reduces suggestion traffic. Keyboard navigation, a labelled list
of options and an explicit selection preserve usability beyond mouse clicks.
A failed suggestion request needs a retry state rather than an invented destination.

### Coordinate cards, pagination and a map

Cards and map markers refer to the same listing IDs and applied query. Hovering a
card may highlight a marker, but hover should not trigger a new search or reorder
the card list.

For map movement, I prefer an explicit “Search this area” action. Automatically
searching every small pan can flood requests and move results while someone is
trying to inspect a marker. Debounced automatic search is reasonable if the product
values continuous exploration and clearly shows when results are updating.

Pagination tokens belong to the query that created them. If dates change, discard
the old continuation. Deduplicate appended cards by listing ID and do not merge a
late page from a previous destination into the new result set.

An exact total is optional. “More places available” can be a better contract than
waiting for an expensive count the user does not need to make the next decision.

### Trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Applied URL with separate draft | Shareable searches and predictable navigation | Requires normalization and explicit synchronization |
| ❌ Independent URL and global-store copies | Convenient local updates initially | Back, reload and delayed requests can show contradictory searches |

The cost of the chosen approach is more deliberate state ownership. It earns its
place because comparison shopping involves many back-and-forth navigations; losing
a guest's dates or changing the result set unexpectedly breaks that workflow.

I would retain old results during an update only with a clear updating indication.
If the new request fails, label the old set as belonging to the previous search and
preserve the draft so the user can retry without re-entering everything.

## 🔧 Deep dive: Dates, quotes and uncertain booking outcomes — 8 minutes

> “I would design booking as a small state machine. The frontend can be optimistic
> about button feedback, but the success screen must come from a durable server
> outcome.”

### Make the calendar semantics explicit

A stay from September 10 to September 12 occupies the nights of the 10th and 11th.
September 12 can be another guest's check-in. The calendar must distinguish a day
that cannot be slept on from a boundary that can still be selected as checkout.

I would send dates as date-only values in the property's calendar. Converting a
selected date into a UTC timestamp and back in the traveler's time zone can change
which day it represents. The API contract must prevent that ambiguity.

The interaction starts with check-in, then chooses checkout subject to minimum stay,
maximum stay and blocked nights between them. A range cannot jump across an occupied
night merely because its two endpoints look selectable.

Rules should explain disabled choices. “Minimum three nights” is more useful than
a silently disabled date. Typed inputs and keyboard calendar navigation should use
the same validation as pointer selection.

Fetch a bounded set of months and load more when needed. If a calendar request fails,
show availability as unknown; an empty response and a failed response have different
meanings. Unknown nights must not be painted as confirmed availability.

### Bind the quote to the chosen trip

Changing dates or guests invalidates the previous quote. Keep an input fingerprint
alongside each response and accept it only if it matches the current selection.
While recalculating, show that the previous amount is being replaced.

A server quote returns nightly charges, other fees, currency and a validity deadline.
The browser formats the amount; it does not independently invent a second rounding
policy or treat the card's nightly price as the total.

Quote expiry and inventory availability are separate. A valid quote can still lose
its dates to another guest unless the server explicitly grants an inventory hold.
If the price changes before submission, show the revised total for acceptance.

### Recover after submission

| UI state | What the guest should understand |
|----------|---------------------------------|
| Ready | Dates and quote are valid enough to submit |
| Submitting | One identified reservation attempt is in progress |
| Pending host response | The request exists; confirmation is still outstanding |
| Confirmed | The server returned a confirmed booking identity |
| Conflict | Dates or rules changed; preserve inputs for revision |
| Outcome unknown | The response was lost; recover the existing attempt |

Disable duplicate clicks while submitting, but also send a stable operation key.
A reload, mobile reconnection or impatient retry can bypass a disabled button. Only
the server can make repeated submissions resolve to one logical booking.

If the response times out, query the operation or retry with the same key. Do not
immediately show “Booking failed” and generate a fresh request. The database may
already have committed the first reservation.

After login, restore the intended listing and date draft, then revalidate it. A
return URL should identify an allowed in-app destination. Restoring inputs is not
permission to silently book with an old quote.

### Trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Server-confirmed booking with recoverable pending state | Honest outcomes and safe retries | More UI states and a recovery endpoint |
| ❌ Immediate optimistic confirmation | Fast-looking success screen | Can promise unavailable dates or conceal an unresolved request |

I would use optimistic behavior for low-risk display actions, such as opening the
price breakdown. Inventory commitment has a different cost of error, so a short
visible wait is justified. Failure should preserve the guest's work, not their
incorrect assumption that the reservation succeeded.

## 🔧 Deep dive: Host editing without losing newer changes — 7 minutes

> “A host calendar is a collaborative editor in miniature. The host can have two
> tabs open while guests are booking, so saving a stale whole calendar is unsafe.”

### Edit an interval, not a month-sized snapshot

A host may block September 10–12 while a guest books September 20–22. Sending the
entire month from the browser risks overwriting the newer booking with an older
available cell. I would send the intended interval change and its expected version.

The server validates ownership, rules and current occupancy in its inventory
transaction. If the edited interval conflicts, return the current relevant data
and a conflict explanation. The browser keeps the unsaved draft for review.

A server can use a whole-calendar version initially. That may reject harmless edits
to different dates, but it is simple. If false conflicts become common, use finer
interval-aware checks without letting the client decide which booking rows to erase.

After saving, replace the affected cache from the accepted server response and
invalidate related availability reads. A green “Saved” label means the server
accepted the edit, not merely that local state changed.

### Make the listing wizard recoverable

A multi-step listing form needs a draft identity, field validation and a clear
publish boundary. Save progress at meaningful points and show whether changes are
local, saving or saved. Keep the user's text after a request fails.

Photos have their own upload lifecycle: selected, uploading, processed, failed and
ready. Temporary browser previews are useful, but should not be mistaken for images
that the server has stored successfully.

Bound concurrent uploads so a large selection does not monopolize the connection.
Allow individual retries and removal. Publish only after required fields and required
photos are accepted, then navigate to a route that actually exists for that listing.

A retry must reuse the same draft or upload identity where appropriate. Otherwise a
lost response can create duplicate listings or multiple photo records.

### Make conflicts usable

Do not replace the entire form with an error page when one field is rejected.
Place field errors near their controls, move focus to an error summary on submission,
and preserve the draft. Permission loss is a distinct state from invalid input.

For calendar conflicts, show the affected dates and accepted server state. A generic
“Something went wrong” forces a host to guess whether a guest now owns the dates or
whether the network is simply unavailable.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned interval edits and recoverable drafts | Protects new reservations and preserves host work | Conflict handling and draft lifecycle |
| ❌ Replace the server calendar from browser state | Simple first implementation | A stale tab can erase newer inventory changes |

I would accept occasional explicit conflict resolution over silent lost updates.
For a host, a minute spent reviewing one conflict is preferable to discovering a
calendar mistake after two parties have made travel plans.

## ⚡ Rendering, accessibility and communication — 4 minutes

Listing photos dominate bandwidth. Serve responsive variants, reserve image space
to prevent layout jumps, load the first visible image promptly, and lazy-load images
below the fold. Avoid downloading full gallery originals for every result card.

Render a bounded result page first. If the experience accumulates hundreds of cards,
virtualize the scrolling list and preserve scroll position by stable listing ID.
I would measure before adding virtualization to a small twenty-card page.

Load the map and host editor only when needed. Map markers should cluster at broad
zoom levels, and the list remains the accessible alternative for selecting a place.
The map must not be the only way to discover a property's price or details.

Calendars need meaningful day labels, visible focus, keyboard movement and an
announcement of the selected range. A modal must manage focus and return it to the
control that opened it. Color alone cannot communicate unavailable or conflicted dates.

Messages need a different data flow from search. Paginate history, assign message
identities and reconcile acknowledgements with local pending messages. Live delivery
can use a persistent connection, but reopening the conversation must recover missed
messages from the server regardless of connection history.

Review visibility belongs to server policy. The browser can show that a review was
submitted without exposing a hidden counterpart. It should not run its own timer
and reveal content the server has not authorized.

## 🧪 Validate the important boundaries — 4 minutes

I would prioritize tests that exercise ordering and recovery, not only whether a
page contains a header. The most revealing scenarios are:

1. A slower old destination response arrives after a new one.
2. Back restores the previous filters, results and scroll position.
3. Checkout on an existing stay's departure day remains valid.
4. A stale quote returns after the guest changes party size.
5. A reservation commits but its HTTP response is lost.
6. A host saves from an old tab after a guest books the affected dates.

Component tests can exercise calendar keyboard behavior and validation. Integration
tests need controlled response ordering. A real backend concurrency test establishes
whether inventory is protected; a frontend mock cannot prove that invariant.

Measure search interaction latency, image loading, layout shifts, quote errors,
reservation outcome recovery and host save conflicts. Separate successful empty
searches from backend failures so the dashboard reflects the user's experience.

For the repository, I would first close the gaps between search state and responses,
calendar boundaries and booking feedback. The current implementation has no map,
no synchronized search URL, no booking idempotency and no complete host edit route.
Those omissions should be visible in the implementation documentation.

> “The frontend's job is to preserve intent and tell the truth about progress.
> Search, quote and reservation each have their own identity and freshness. Keeping
> those boundaries clear lets the interface stay responsive without promising
> inventory that the server has not committed.”
