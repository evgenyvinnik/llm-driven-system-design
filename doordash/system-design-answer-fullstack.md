# DoorDash — fullstack system design interview

A proposed 45-minute design connecting customer, restaurant, and driver experiences to
backend guarantees. The final section distinguishes this proposal from the checked-in local
application.

## 🗣️ Frame the problem — 4 minutes

> “I'd follow one dinner order across three people. The customer needs to know whether checkout succeeded, the restaurant needs a complete queue, and the driver needs an unambiguous assignment. The integration problem is making their different screens describe the same accepted business state.”

I'd clarify three boundaries first: web versus native driver support, the cancellation
policy, and whether batching or payments are in scope. I'll assume customer and restaurant
web apps, a foreground driver web experience, one restaurant per order, and one active order
per driver.

Customers can browse, build a cart, review a total, place an order, track it, and cancel
before the defined cutoff. Restaurants confirm and advance preparation. Drivers receive an
offer, accept it while connected, then report pickup and delivery. Payment collection,
refunds, driver payouts, promotions, and chat are separate extensions.

The distinction matters at checkout: an accepted order is not proof that a restaurant has
confirmed, a driver has accepted, or a payment has settled. The interface should use
separate statuses and acknowledgements for those different facts.

| User need | Technical consequence |
|-----------|-----------------------|
| “Did my order go through?” | A stable operation ID and recoverable server receipt |
| “Are there orders I haven't seen?” | Queue snapshots and recovery after missed events |
| “Is this still my delivery?” | An authoritative assignment claim checked on actions |
| “Where is the driver now?” | Observation age and sequence, not just a coordinate |
| “When will it arrive?” | Stage-aware estimate with a range and update time |

For the interview, assume one million orders per day, up to 100,000 drivers reporting at
peak, and 200,000 connected clients. Target p95 checkout commit below 500 ms after quote
agreement and committed status visibility within two seconds for connected participants.
These are proposed targets, not measurements from the demo.

## 🏗️ Architecture and ownership — 5 minutes

I would start with this diagram and expand a single flow at a time:

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Customer app    │  │ Restaurant app  │  │ Driver app      │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         └───────────────────┼───────────────────┘
                             ▼
           ┌──────────────────────────────────┐
           │ Authenticated HTTP + socket edge │
           └───────────────┬──────────────────┘
                           ▼
           ┌──────────────────────────────────┐
           │ Catalog │ Orders │ Dispatch/ETA  │
           └─────────┬────────────────┬───────┘
                     ▼                ▼
        ┌────────────────────┐  ┌────────────────────┐
        │ Market SQL         │  │ Fresh geo index    │
        │ Orders + outbox    │  │ Latest observations│
        └─────────┬──────────┘  └────────────────────┘
                  ▼
        ┌────────────────────────────────────────────┐
        │ Relay + event bus → gateways/notifications │
        └────────────────────────────────────────────┘
```

Driver position ingestion updates the geo index through an authenticated path; at scale it
can be deployed separately from order writes. Dispatch uses the index to discover
candidates, then claims an order and driver in market SQL. The bus distributes committed
lifecycle events; it is not the authority for whether a checkout transaction succeeded.

The frontend needs a similarly explicit ownership model. Route components own local
presentation. A server-data layer stores restaurant and order snapshots by identity/query. A
small persisted client store holds cart selections and unresolved operation IDs. One
connection service owns socket lifetime and subscription recovery.

| State | Authority | Client behavior |
|-------|-----------|-----------------|
| Basket edits | Customer's draft | Apply immediately, persist a small versioned shape |
| Current price/availability | Catalog and quote service | Display cached facts; validate before submission |
| Accepted order state | Order transaction | Render returned revision; do not invent success |
| Assignment | Live server claim | Show pending offers; accept only after acknowledgement |
| Position | Latest valid device observation | Display age; discard older sequences |
| Connectivity | Client transport | Explain uncertainty and trigger reconciliation |

I would use React, TanStack Router, and Zustand for these web surfaces, but the ownership
model matters more than the library names. Sharing TypeScript interfaces helps maintenance;
it does not validate network input, authorize an action, or guarantee that database numeric
strings match the declared type.

## 📏 Scale and contracts — 4 minutes

One million orders per day is about 11.6 per second on average. A tenfold peak gives roughly
116 checkouts per second. Meanwhile, 100,000 drivers reporting every ten seconds produce
10,000 location updates per second. Those streams should not compete for the same
synchronous SQL work on every sample.

If each order yields six durable lifecycle events, that is six million per day, or about 69
per second on average. Kafka traffic can be much higher if it also retains telemetry. At 200
bytes per position, a full day sustained at the peak rate would be about 161 GiB before
replication; I'd sample historical positions and retain them under an explicit policy.

The API contract should make uncertainty and revision visible:

| Proposed API | Request includes | Response establishes |
|--------------|------------------|----------------------|
| Quote basket | Items, quantities, destination | Terms, total, revision binding, expiry |
| Create order | Accepted quote and stable operation ID | Complete committed order and its version |
| Resolve operation | Caller-scoped operation ID | Accepted result, rejection, or pending state |
| Apply order action | Action, expected version, assignment where relevant | Accepted new revision or explicit conflict |
| Accept offer | Exact claim ID | Server-confirmed assignment or expiry/conflict |
| Read order/queue | Authorized resource and cursor where supported | Snapshot plus version/recovery boundary |
| Report position | Session sequence, observation time, accuracy, coordinates | Observation accepted or rejected |

I'd define one normalized order representation at the API boundary, with stable field
naming, explicit optional driver details, money/currency semantics, and a version. Socket
events and HTTP responses should use compatible records so receiving a status event does not
accidentally erase driver information from the page.

Validation belongs on both sides for different reasons. The client helps a person correct
input; the server enforces shape, range, size, authority, and current-state rules. A
malformed response is an integration error to surface and recover from, not something a type
assertion can make valid.

## 🔧 Deep Dive 1: Checkout from tap to durable receipt — 9 minutes

### Decision: local edits, an agreed quote, and a transactional operation

The customer adds food while browsing and may return much later. During that time, a menu
item can change price or become unavailable. The UI needs continuity, but continuity does
not give the saved cart authority over current terms.

I would keep the draft cart local for immediate quantity edits. At checkout, request a quote
that includes the item revisions, destination, delivery fee, currency, and total. Show
changes explicitly, preserving unaffected selections. A different total requires the
customer's agreement rather than a silent server-side correction after the button press.

Opening another restaurant should leave the basket intact. If the customer actually adds an
item from that restaurant, ask whether to replace the current single-restaurant basket. That
is the moment when their intent requires a conflicting edit.

### The transaction and the screen share one operation identity

When the customer accepts the quote, persist a new operation ID and its agreed payload
before sending. The server scopes the key by actor and operation type, checks payload
identity, and uses one SQL transaction for the operation receipt, complete order, line
snapshots, audit entry, and outbox event.

1. The client displays a submitting state for this operation and prevents duplicate local
submission.
2. The server validates quote expiry, required revisions, restaurant status, destination,
and quantities.
3. The transaction either records the complete accepted order and receipt or rolls back.
4. The client applies the returned order revision and clears only the submitted basket.
5. If the response is lost, the client resolves or retries the same operation before
starting another checkout.

A disabled button is a convenience, not the idempotency guarantee. Two tabs, a proxy retry,
or a process restart can bypass the button. The durable receipt must answer the same
question after those failures.

| Strategy | User experience | Backend consequence |
|----------|-----------------|---------------------|
| ✅ Local cart + quote + SQL receipt | Fast edits and explicit recovery | Order, lines, and receipt share one commit |
| ❌ Trust the stored basket total | Few UI states | Obsolete terms can be accepted silently |
| ❌ New operation ID after every timeout | Easy retry button | A lost response can produce a duplicate order |
| ❌ Cache the response only after SQL writes | Usually works in demos | Crash between commit and caching leaves ambiguity |

The cost is more UI states and durable receipt storage. The benefit is that both layers can
explain a transport failure without guessing. A timeout becomes “checking your order,” not
“failed, start again.”

### Quote changes and concurrent edits

A quote does not magically reserve ingredients or driver capacity. Choose whether the
business honors its terms until expiry or revalidates them; that choice determines what must
be reserved. I'd begin with explicit revalidation and a revised-quote flow, documenting the
boundary clearly.

If the user edits the cart while a previous operation is unresolved, retain a separate
draft. Do not mutate the payload under the old operation ID. A key reused with a different
body should produce a conflict, even when both bodies belong to the same customer.

Represent money consistently at the boundary, using integer minor units or exact decimal
amounts with currency. Components display server-defined rounded line amounts and totals.
They should not each recompute taxes differently or concatenate numeric strings by accident.

### Publishing the new order

The outbox is written in the checkout transaction so a process crash cannot lose the need to
notify the restaurant. A relay retries publication with a stable event ID. A consumer may
see the same event twice after a retry, so queue insertion and notifications need
effect-specific deduplication.

The restaurant's new-order indicator is persistent until acknowledged. A socket event makes
it responsive, while a recovered queue snapshot makes it complete after a disconnect.
Payment-provider confirmation, if later added, needs its own durable operation and
reconciliation rather than being implied by this order receipt.

## 🔧 Deep Dive 2: Preparation and assignment across three screens — 9 minutes

### Decision: let the server serialize authority; let the clients show pending intent

> “The restaurant may be ready and the driver may be nearby, but neither fact alone means that driver owns the delivery. I'd make assignment an explicit claim that every subsequent driver action must present.”

After restaurant confirmation, dispatch finds drivers near the pickup point and filters for
recent observations and eligibility. A score can favor suitable arrival time and use simple
distance/rating inputs initially. A fast candidate search is useful, but the result is
already stale by the time another dispatcher reads it.

If two orders select the same available driver, an atomic claim transaction chooses one
winner. Live claims are unique for both the order and driver. The worker that loses retries
another candidate; it does not overwrite the existing assignment.

The claim has an identity and deadline. The driver receives an offer and can accept it
online. The server checks the exact claim and expiry before committing assignment. We do not
hold a database lock while waiting for a person; the durable claim represents the
reservation during that wait.

### Aligning the state machine with the interface

| Stage | What a participant may request | What the server must check |
|-------|-------------------------------|----------------------------|
| Placed | Customer cancellation or restaurant confirmation | Actor, current version, cancellation policy |
| Confirmed/preparing | Restaurant advances preparation | Ownership and permitted transition |
| Offered | Driver accepts | Driver identity, exact live claim, deadline |
| Ready for pickup | Assigned driver confirms pickup | Assignment, current order state/version |
| Picked up | Assigned driver confirms delivery | Same authority and idempotent operation |
| Delivered | Internal closeout | System authority; not an arbitrary customer action |

A client may render a pending button state immediately, but it applies an authoritative
status only from the accepted response or a newer server event. If the restaurant's HTTP
response arrives before the socket message, apply it. If the socket arrives first, the later
response must not move the card backward.

One transition service should own shared effects such as closing an assignment, recording
delivery, and writing events. Duplicating “deliver” in both a generic status route and a
driver-specific route invites different counters and availability behavior for the same
business action.

| Consistency choice | Benefit | Cost accepted |
|--------------------|---------|---------------|
| ✅ Short SQL transaction around order and claim | Concurrent actors have one accepted outcome | Contention and explicit conflict responses |
| ❌ Each client advances optimistically as final | Immediate apparent success | Parties can disagree on pickup, cancellation, or assignment |
| ❌ Separate order and driver availability writes | Easy implementation | Double booking and leaked capacity after partial failure |

The transaction does not need a global lock. Keep the related order/driver claims in one
market database, acquire records in a consistent order, and use versions or guarded updates.
Partition by market when needed; cross-market movement then needs a deliberate transfer
policy.

### Races are product states, not just exceptions

Cancellation, offer acceptance, and claim expiry can happen nearly together. All must use
the same authority and compare the claim identity. If cancellation wins, a delayed
dispatcher must not attach a driver afterward. If an old timeout runs after reassignment, it
must not release the replacement claim.

The UI receives an explicit conflict and refreshes current state. An expired offer should
disappear with a clear explanation. The client countdown is helpful presentation; the server
deadline decides whether acceptance succeeded.

For a delivery tap during poor connectivity, persist a minimal pending operation tied to the
order and assignment. Retry the same identity after reconnecting, but do not show global
completion until acknowledged. Reassignment or cancellation can invalidate that intent, so a
local queue must support rejected/conflicted outcomes instead of blindly replaying forever.

If no driver is available, retain a durable dispatch job with bounded retries and wait
policy. The customer should see assignment pending, and support should see queue age. A
fallback object that merely says “queued” creates neither recovery nor an actionable
explanation.

## 🔧 Deep Dive 3: Tracking that recovers after a disconnect — 8 minutes

### Decision: durable order revisions and replaceable position samples

Location and business status have different loss tolerances. Missing a GPS sample is often
repaired by the next sample. Missing an entire new order leaves the restaurant unable to
act. I would therefore give lifecycle events durable recovery and positions latest-value
semantics.

Location intake authenticates the driver, validates coordinates and sample time, and rejects
obsolete sequence numbers within a tracking session. It records observation age separately
from receipt age. A newly received upload can still describe where the driver was several
minutes ago.

Candidate queries reject stale observations even if a geo member remains present. Expiring a
metadata key alone is insufficient because a shared geo set's member may outlive it. Cleanup
helps memory use; freshness checks make dispatch safe.

The frontend shows connection status and point age independently. A green socket indicator
cannot prove that GPS is reporting. Animation can smooth between received points, but should
stop at a bounded age and never imply a known route through missing data.

| Recovery choice | What it handles | Limitation |
|-----------------|-----------------|------------|
| ✅ Push plus authoritative snapshot | Low latency and missed-event repair | Needs a version/cursor contract and reconnect lifecycle |
| ❌ Resume socket only | Future messages | Missed orders and transitions stay missing |
| ❌ Reliably replay every old position | Preserves samples | Slow clients see obsolete movement before current state |

The accepted cost is two ordering rules: order revisions for business state and
tracking-session sequence/observation age for position. A location update cannot move a
delivered order back to active, and a newer order event cannot make old coordinates fresh.

### Reconnect without a new gap

The client connection service establishes an authorized subscription, buffers newer events
while fetching a snapshot, and reconciles against the snapshot's version boundary. The
server needs a defined cursor/acknowledgement contract so no interval remains uncovered
between subscribing and reading.

A single order version works for one order view. A restaurant queue also needs a collection
cursor or full refresh, because a completely missed order is absent from its local version
map. Bound the buffer and use a fresh snapshot if it overflows or the retained cursor
expires.

Tag asynchronous work with its account/resource/connection generation. A late fetch for
restaurant A must not replace restaurant B's queue after switching. An intentional logout
cancels reconnect timers; an old `onclose` callback must not resurrect a socket with stale
subscriptions.

Gateways authorize every channel and bound subscriptions and pending output. For scale,
events must reach the gateway that actually holds the participant's socket. One Kafka
consumer group does not automatically broadcast each event to every gateway; use subscriber
routing or a shared fan-out layer and retain snapshot recovery.

### ETA from backend model to human interpretation

Before pickup, driver travel to the restaurant and remaining preparation overlap. If those
are eight and twelve minutes, use about twelve before onward travel and handoff work, not
twenty. After pickup, route from the latest driver position to the customer and remove
completed pickup work.

Before assignment, include dispatch uncertainty. A server can expose an ETA range with
stage, update time, and supported reason for a change. The client should widen or mark a
stale estimate rather than maintaining a false precise countdown.

I'd start with an inspectable formula and measure error by vehicle, market, and stage. Fixed
straight-line speeds are a baseline, not a road-routing engine. Native background tracking,
map rendering, and ML estimation are separate capabilities; none should be implied just
because a WebSocket carries latitude and longitude.

## 🧪 Verification, scaling, and implementation comparison — 6 minutes

I would test one journey across three independent sessions, then inject failures at the
boundaries above. The important assertion is what all parties and the database agree
happened, not only whether a page is visible.

| Test | Cross-layer assertion |
|------|-----------------------|
| Price changes after adding to cart | Revised terms appear; no silent order at an unreviewed amount |
| Lost checkout response | Reload resolves the same receipt and exactly one complete order |
| Two dispatchers choose one driver | One live claim; losing order remains recoverably pending |
| Ready event arrives before HTTP response | Driver sees pickup available; neither screen regresses |
| Restaurant disconnects during new orders | Snapshot restores the complete relevant queue |
| Older GPS arrives after a newer point | Sequence check preserves newest observation |
| Pending delivery loses authority | UI explains conflict; backend does not free another assignment |
| Logout with pending timers/requests | No old-account data or actions enter the next session |

Contract checks should exercise numeric strings, naming conventions, optional driver
expansion, and identical HTTP/socket representations. Component tests can control clocks and
network ordering; integration tests must exercise real transaction constraints and
authorization. A broad smoke assertion that a `main` element exists cannot establish these
guarantees.

Accessibility follows the same state model: announce accepted status changes, make
pending/rejected actions explicit, preserve focus when queue cards move, and keep text
tracking usable without a map. Quantity buttons need item-specific accessible names, and
connection failure must not look like an empty result set.

For growth, first separate high-volume position intake from order writes, bound catalog
queries and image loading, then scale socket gateways with shared routing. Virtualize long
lists after measuring rendering cost. Market-local databases limit assignment contention;
outbox age, claim conflicts, stale position fraction, and unresolved client operations tell
us where the design is failing.

### What the repository implements today

The checked-in app uses React, TanStack Router, persisted Zustand auth/cart stores, direct
route fetches, and one Express API with PostgreSQL and Valkey. It has automatic assignment
on restaurant confirmation, heuristic ETA, local WebSocket broadcasts, and best-effort Kafka
producers. It has no quote API, operation lookup, dispatch offers, durable retry worker, or
payment provider.

Checkout creates a new UUID per API invocation and random San Francisco destination
coordinates. The backend rereads menu prices but writes orders and lines separately, accepts
closed restaurants, and caches error responses under keys without actor/payload binding. The
proposal's atomic order and retry guarantees are therefore not implemented.

Status updates check an earlier read and later write by ID without a version predicate.
Matching updates the order and driver separately, can assign cancelled orders, and has no
exclusive claim. The nominally system-only completion transition lacks an actor check. These
are backend authority gaps, not issues a disabled button can solve.

The owner open-state toggle sends `is_open` to an API expecting `isOpen`. Driver stats
return camelCase while the dashboard reads snake_case. Driver subscriptions receive
assignments but miss subsequent preparation status events. The owner dashboard ignores
successful mutation responses and waits for WebSocket updates, making transport loss visible
as an apparently ineffective action.

The socket server authorizes neither connections nor subscriptions; the client has no
snapshot catch-up or visible freshness and can schedule reconnects after cleanup. Tracking
is coordinate text, not a map. Location synchronously writes SQL, and only a companion hash
expires. The installed Redis search API returns IDs while matching expects distance objects,
causing nonempty searches to fall back to SQL. ETA remains a stage-imperfect straight-line
formula.

These source findings and setup limits are documented in
[architecture.md](./architecture.md#implementation-notes) and [README.md](./README.md). The
review used isolated mocked executions for selected backend behaviors; it did not validate a
complete live delivery stack. The interview proposal describes the work needed to make the
user-visible promises defensible.

### Trade-offs I would defend

| Decision | Chosen | Alternative | Cost accepted |
|----------|--------|-------------|---------------|
| Checkout | ✅ Local draft, agreed quote, durable receipt | ❌ Treat timeout as failure and start over | More recovery states and stored operation results |
| Assignment | ✅ Server claims and versioned actions | ❌ Independent optimistic authority | Short transactions and explicit conflicts |
| Tracking | ✅ Versioned status, fresh positions, snapshot recovery | ❌ Treat a connected socket as complete state | Two ordering models and connection lifecycle work |

> “I'd leave the whiteboard with one traceable order journey. Every screen can explain what is accepted, what is pending, and what is stale, because the backend returns those distinctions explicitly and the frontend preserves them through retries and reconnects.”
