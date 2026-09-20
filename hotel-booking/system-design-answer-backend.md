# Hotel Booking — System Design Answer (Backend Focus)

*45-minute interview walkthrough. Production choices below are proposed; the final section
distinguishes the local implementation.*

## 🎯 Scope and constraints — 4 minutes

> "I would start with the invariant: for one room type on any occupied night, active
> allocations must not exceed sellable capacity. Search can be stale. That inventory decision
> cannot."

I would clarify whether we sell a specific physical room or a quantity of a room type. I'll
choose the latter: a guest books two double rooms for three nights in one hotel. Physical room
assignment, intentional overbooking, and bookings spanning several hotels are out of scope.

The service supports discovery, dated quotes, temporary holds, payment confirmation,
cancellation, and owner changes to inventory and prices. Reviews are useful, but I would defer
their details until the booking path is sound.

I would also ask who owns inventory when a property sells through other channels. Here this
service owns its configured allotment. Synchronizing an external property-management system
introduces another authority and requires a separate contract.

### Working assumptions

| Dimension | Interview assumption |
|---|---|
| Catalog | 100,000 hotels, five room types each |
| Traffic | Ten million searches and 100,000 bookings daily |
| Peak | About ten times average traffic |
| Stay model | Date-only check-in inclusive, checkout exclusive |
| Payment | External provider with retry identity and verified status |
| Correctness | One durable result per purchase intent; no overselling |

That is roughly 1,200 searches and twelve bookings per second at the assumed peak. These are
not measurements of this repository. A popular hotel can be hot even when the overall booking
rate is modest, so I would budget for skew rather than size everything from the average.

For latency, I would target search p95 under 500 ms and an inventory transaction under 300 ms,
excluding provider time. During a primary outage, reject authoritative booking writes while
allowing clearly stale catalog browsing where possible.

## 🏗️ Architecture and data contracts — 6 minutes

```
┌────────────────────────┐ HTTPS  ┌──────────────────────────────────────────────────────────┐
│ Guest / hotel owner    │        │ API boundary                                             │
│ Saved intent / command │◀──────▶│ Authentication, ownership, bounds, intent identity       │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
                                              ▲                  ▲
                                              │                  │
             ┌────────────────────────────────┘                  │
             │                       quote / hold / owner edits  │
search reads │                                                   │
             ▼                                                   ▼
┌────────────────────────┐        ┌──────────────────────────────────────────────────────────┐
│ Search service         │        │ Booking + inventory service                              │
│ Bounded candidates     │◀──────▶│ Hotel-owned transactions; conditional state changes      │
│ Advisory enrichment    │        │ Quote, receipt, booking and outbox commit together       │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
             ▲                                                  ▲
             │                                                  │
match / rank │                      authoritative transactions  │
             │                                                  │
             ▼                                                  ▼
┌────────────────────────┐        ┌──────────────────────────────────────────────────────────┐
│ Elasticsearch + cache  │        │ PostgreSQL primary, partitioned by hotel at scale        │
│ Catalog projection     │        │ Rooms, nightly inventory, quotes, holds, receipts        │
│ Disposable snapshots   │        │ Payment attempts, provider receipts, inbox and outbox    │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
             ▲                                                  ▲
index jobs   │                                                  │
             │                      jobs / state transitions    │
             ▼                                                  ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Workers: projection, expiry, payment reconciliation                                        │
│ Retry committed work; verify provider events; reconcile uncertain outcomes                 │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                               ▲
                                               │  idempotent authorization / settlement
                                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ External payment provider — separate failure domain                                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

I'd draw a read path on the left and a transactional path on the right. The database under
booking is authoritative. Elasticsearch and availability caches are projections that help
guests choose; they cannot allocate rooms.

Follow a command: the API authenticates the user, validates bounded inputs, and routes to the
hotel's owner partition. Booking commits the reservation and operation receipt together.
Durable work then drives indexing and payment activity outside that transaction.

Follow a search: the service matches a bounded set of candidates, asks for advisory dated
enrichment, and returns a coherent page. It never takes booking locks for all search results.
The worker row shows where retries and external uncertainty are handled.

For a lost payment response, the worker resolves the existing provider attempt and records
its verified outcome before advancing the booking transition. Processing inventory remains
protected while that outcome is unknown; ordinary hold expiry cannot release it underneath
reconciliation. Index workers follow a separate progress path and confirm versioned effects
before acknowledging their work. Neither an index update nor a client timer confirms a stay.

These are logical components. I would initially deploy a modular booking/catalog API with
separate workers. Independent services become useful when traffic or ownership requires them,
not because every box must be a separate process.

### Data model

| Entity | Key fields | Access pattern |
|---|---|---|
| Hotel / room type | Hotel owner, room type, capacity, base price, active state | Property details and inventory ownership |
| Booking | Hotel, type, dates, quantity, owner, state, deadline | Active occupancy and own booking history |
| Quote | Quote ID, scope, nightly amounts, currency, policy, deadline | Immutable terms accepted by the guest |
| Operation receipt | Account + intent key, request digest, booking ID | Recover the same result after retry |
| Payment attempt | Booking + attempt, provider identity, state, amount | Reconcile external money movement |
| Inbox / outbox | Unique event ID, entity version, processing state | Deduplicate events and retry committed work |

Index active booking ranges by hotel and room type, and expired-hold candidates by deadline. A
unique account/intent receipt is a correctness constraint, not merely a speed optimization.
Keep guest identity and authorization in every lookup.

I would store money in an exact representation with an explicit currency. The quote retains
its nightly breakdown and cancellation terms; later owner price edits must not silently
rewrite an accepted purchase.

### Essential API surface

| Method | Proposed path | Meaning |
|---|---|---|
| GET | `/hotels/search` | Catalog match with bounded dated enrichment |
| GET | `/hotels/:id/availability` | Advisory capacity for a range or month |
| POST | `/quotes` | Produce complete, expiring purchase terms |
| POST | `/bookings` | Allocate hold under a purchase intent |
| GET | `/booking-intents/:key` | Recover a lost creation response |
| POST | `/bookings/:id/payment-attempts` | Begin payment while hold is valid |
| GET | `/bookings/:id` | Current canonical state |
| POST | `/bookings/:id/cancel` | Apply policy and initiate any required refund |

Request and response bodies are less useful on the board than the guarantees: bounded
dates/counts, ownership, accepted quote, stable intent, canonical result, and distinct
conflict versus unknown outcomes.

## 🔧 Deep dive 1: Allocating a range of nights — 10 minutes

The hard case is two guests competing for overlapping stays, not necessarily identical dates.
A guest staying the 17th–19th competes on the 18th with a guest staying the 18th–20th.

### A simple enforceable transaction

1. Validate the hotel, room type, guest capacity, positive quantity, real dates, and maximum stay length.
2. Lock the room-type row in the hotel's PostgreSQL primary.
3. Read active occupancy for each occupied night after obtaining that lock.
4. Reject if any night's remaining capacity is below the requested quantity.
5. Persist the hold, accepted quote snapshot, receipt, and outbox work, then commit.

For a capacity of ten rooms, nightly active counts of six, nine, and seven leave only one room
available for the whole three-night stay. Summing all bookings that overlap any part of the
range would overcount stays that occupy different nights. The range must fit on each night.

At PostgreSQL's default Read Committed isolation, a statement issued after obtaining the
contested row lock sees preceding commits. Different API processes share the same database
lock. The rule holds only if every operation that increases allocations or reduces capacity
follows the same protocol.

A concurrent capacity edit also obtains a row lock through its update, but that alone is
insufficient. It must check existing obligations before reducing capacity. “All writes lock
something” is not the invariant; “all writes validate the invariant while serialized” is.

### Comparing approaches

| Approach | Benefit | Cost or failure mode |
|---|---|---|
| ✅ Room-type lock + nightly range check initially | Simple authority and rollback boundary | Serializes unrelated dates for a popular type |
| ✅ Per-night inventory rows after measured need | Nonoverlapping nights can proceed independently | More rows and multi-row allocation logic |
| ❌ Redis lease keyed only by exact range | Reduces identical-range contention | Different overlapping ranges get different leases |
| ❌ Optimistic retry as an automatic speed fix | Avoids waiting on lightly contended data | Hot sold-out inventory can create retry storms |

The Redis lease is not what makes a shared PostgreSQL transaction work across API instances.
Lease expiry and failover require their own reasoning, while the database already serializes
this resource. I would not make a cached availability boolean authoritative either.

### When to change the model

If room-type lock wait dominates, represent each room type/night as capacity, held count, and
confirmed count. Lock the requested nights in increasing date order, verify all counters, and
adjust them in one transaction. A failed night rolls back the whole allocation.

This is a valid counter model because the counter is per night. It is very different from
decrementing one hotel-wide number. One year across the assumed catalog is about 182.5 million
nightly rows, so the storage and maintenance cost is real.

Limit stay length and room quantity before locks are acquired. A malicious or mistaken
multiyear request must not become an unbounded lock set. Admission control for a hot hotel is
often more useful than blindly adding API replicas.

### Deadline semantics

A hold has a server deadline. Reads can conservatively count overdue holds until their state
changes, causing temporary underselling. But an overdue hold must not be allowed to begin
confirmation just because the sweeper has not visited it yet.

Command validation checks the deadline using the database clock. Background expiry releases
abandoned inventory and repairs derived views; it is not the sole enforcement of expiration.

> "I'd prefer one short transaction whose invariant I can explain. I would introduce per-night
> counters when measured contention justifies the extra write model."

## 🔧 Deep dive 2: Purchase identity and payment uncertainty — 10 minutes

Locks prevent conflicting allocations. They do not tell whether two serialized requests
represent one purchase repeated or two purchases intentionally made.

### A receipt tied to intention

The client creates an intent when the guest accepts a quote. The server scopes it to the
account and stores a digest of the frozen request. Same key and same payload returns the same
result; same key and different payload is a conflict.

A digest of dates and room quantity alone cannot identify intention. A guest may deliberately
book another room with identical details, or rebook after cancelling. A new intent
distinguishes that from replaying the original purchase.

The operation receipt and booking commit together. On simultaneous retries, a unique
constraint elects the winner; the losing request reads the committed result after resolving
its transaction. A preflight lookup alone has a race between “not found” and creation.

| Decision | Why it works here | Cost |
|---|---|---|
| ✅ Durable account/intent receipt | Same purchase can be recovered across retries | Retention and payload-version policy |
| ❌ Parameter hash as identity | Easy to generate | Conflates separate intentions and can omit meaningful fields |
| ❌ Cache-only deduplication | Fast lookup | Cache loss or expiration changes business behavior |

Use one canonical response representation for stored/replayed results. Storing a camelCase API
object and later treating it as a snake_case SQL row is a protocol defect, even if the booking
row itself is unique.

### Crossing the payment boundary

A database transaction cannot atomically commit at an external payment provider. I would use a
durable state machine with an idempotent provider attempt and reconciliation.

The initial hold consumes inventory. Before its deadline, a conditional transaction moves it
to payment processing and records durable work. That state continues consuming inventory while
the provider authorization is unresolved, under a separate bounded reconciliation policy.

No provider request runs while the room-type row lock is held. The worker uses a stable
attempt identity, sends the accepted amount and currency, and verifies the resulting event or
queried status. Duplicate provider events are ignored through the inbox's unique event
identity.

### The expiry race

Consider a payment authorization arriving just as inventory is being released. Both paths must
use conditional state transitions on the same authoritative booking. An old event is not
allowed to change an already expired/cancelled booking directly to confirmed.

If the payment was authorized after the inventory was released, void it or enter a
refund/reconciliation path. Reacquiring inventory is a fresh allocation decision, not a status
flip. Otherwise the service can oversell despite having correct creation locks.

| Situation | Resolution |
|---|---|
| Response lost after hold commit | Recover the same intent/booking |
| Payment request timed out | Query or retry the same provider attempt |
| Duplicate payment event | Return the already-applied event result |
| Expiry wins before processing begins | Reject payment start and release inventory |
| Late authorization after release | Void/refund or explicitly reacquire; never silently resurrect |
| Cancellation during payment uncertainty | Record intent to cancel and reconcile the outstanding attempt |

“Confirmed,” “authorized,” and “settled” should not collapse into one boolean. State history
and metrics must explain what the service knows about inventory and money separately.

### Why I accept the complexity

A synchronous provider call followed by an ordinary booking update looks simpler, but a
timeout leaves ambiguity about whether money moved. Retrying with a new identity risks another
payment; abandoning it can leave a paid guest without a booking.

An outbox, event inbox, and reconciliation worker add operational work. They make that
ambiguity recoverable and auditable. I would describe effectively-once business effects under
retry, rather than promise exactly-once message delivery.

> "My success criterion is not that the first request always returns quickly. It is that a
> guest can recover one accurate booking and payment outcome after the request fails halfway
> through."

## 🔧 Deep dive 3: Useful search without overwhelming inventory — 8 minutes

Discovery is much busier than reservation. At the assumed peak, twenty candidates times two
room types per candidate can produce roughly 48,000 availability checks each second. This is
why search needs its own read budget.

### Separate matching from allocation

Elasticsearch handles location, amenities, stars, and catalog text. The search service
enriches a bounded candidate set with advisory date availability and pricing. Batch by
hotel/type instead of opening an independent query for every card.

A result can honestly say it was available when checked, provided its dates, quantity, and
freshness are clear. It is still not a hold. The reservation transaction rechecks the primary
before allocating anything.

| Approach | Benefit | Trade-off |
|---|---|---|
| ✅ Bounded enrichment plus cache | Relevant dated results within a load budget | Some stale or partially checked candidates |
| ❌ Synchronous enrichment of every match | More exhaustive result set | Search fan-out can exhaust database connections |
| ❌ Never enrich discovery | Cheap reads | Guests repeatedly open hotels that cannot fit the stay |

I would not hide a dependency failure as sold out. If a batch cannot be checked, return an
explicit partial/unknown state or a retryable error according to the product contract.

### Cache semantics

Cache a snapshot with hotel, room type, date range, and all relevant request inputs. If the
result contains an `available` boolean, room count must be part of its identity. Alternatively
cache capacity counts and derive the boolean for each request.

Invalidating only the exact booked date range leaves all overlapping cached queries behind. A
room-type generation can invalidate every range logically, or month-key invalidation can cover
all occupied months. Owner price/capacity edits and expiry need the same refresh path.

A TTL bounds stale reads when invalidation is delayed. It does not make those reads
authoritative. Hold creation uses current inventory inside the transaction even when Redis is
down or wrong, provided the service's dependency policy allows proceeding safely.

### Pagination and price coherence

An Elasticsearch page is a candidate page, not necessarily a page of available hotels. If
enrichment removes candidates, the service may expand within its budget and return a
continuation token. Do not report the remaining page length as a global total while retaining
an unrelated page count.

Prices and capacity must refer to the same room option. A hotel's cheapest room and its
largest room may be different types. A search asking for four guests cannot assume the
cheapest one accommodates four simply because the hotel has another large room.

Dated totals incorporate nightly overrides and room quantity. The client should receive a
stable hotel DTO, not the internal index document. That representation boundary prevents index
field names from leaking into broken navigation.

### Keeping the projection current

Owner edits commit SQL and a versioned outbox event together. A worker retries indexing and
prevents an older snapshot from replacing a newer one. Reviews that change aggregate ratings
also schedule projection updates.

A periodic reconciliation/rebuild process handles historical drift. This costs worker
operations and delayed visibility, but avoids coupling a successful catalog edit to the
availability of Elasticsearch at that moment.

> "I am willing to show a stale search hint. I am not willing to use that hint as the decision
> to sell a room, or to describe a failed check as proof the hotel is full."

## 🧪 Failure tests, growth, and implementation boundary — 7 minutes

### What I would verify

| Test | Invariant or contract |
|---|---|
| Many overlapping reservations through multiple API instances | Active nightly allocations never exceed capacity |
| Capacity reduced while bookings arrive | Owner edits cannot violate future obligations |
| Same intent submitted concurrently | One canonical result, including duplicate response shape |
| Commit succeeds and response/cache write fails | Existing booking remains recoverable |
| Expiry races with payment start/event | One valid state transition; no resurrected inventory |
| Date ranges cross DST, month end, and leap day | Correct night count and exact quote total |
| Old indexing job finishes last | Newer catalog projection remains visible |

These require real database concurrency and fault-injection tests, not just mocked route
responses. Separately measure lock wait, pool wait, expired-hold lag, payment reconciliation
age, and search projection delay.

### Scaling order

First control fan-out, inputs, query plans, and connection usage. A transaction holding one
pool connection while pricing checks out a second can starve the pool under load, even with a
modest number of bookings.

Then isolate workers, add tolerant read replicas and caches, and move to nightly inventory if
room-type lock contention is measured. Partition writes by hotel so one reservation remains
local to one authoritative shard.

Multi-region operation needs an owner region and fenced failover for each hotel's inventory. I
would keep writes unavailable during an uncertain ownership transition rather than accept two
independent authorities selling the same rooms.

Guest and owner authorization remains on the server at every stage. Use current ownership,
bounded query and booking inputs, safe session handling, and redacted audit records. Neither a
hidden management tab nor a caller-supplied payment reference is authorization.

### Local implementation boundary

The demo has Express, PostgreSQL, Valkey, and Elasticsearch. Booking creation locks a
room-type row before querying nightly occupancy, and each API instance runs an expiry sweep
every minute. Redis exact-range leases are additional contention control, not the
cross-process correctness guarantee.

Several gaps are material: confirmation accepts a still-reserved row without checking its
deadline, payments are simulated, and owner capacity reductions do not check existing
obligations. Price reads use a separate connection and host-timezone date iteration can
produce incorrect totals.

Idempotency hashes parameters, checks before the lock, and mishandles the cached response
shape. Availability cache keys omit requested quantity and invalidation misses overlapping
ranges. Search filters dated candidates but returns incompatible hotel fields and inconsistent
pagination totals.

Circuit-breaker factories are not connected to request paths. There is no durable
payment/outbox workflow or versioned indexing worker. Nine isolated source checks reproduced
selected defects, but no live database race or payment integration was exercised by this
documentation review. See [architecture.md](./architecture.md#implementation-notes) for the
complete source mapping.

### Decisions to leave on the board

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Inventory authority | ✅ Short PostgreSQL transaction | ❌ Cached counts or exact-range leases | One serialization rule for all overlapping stays |
| Retry safety | ✅ Durable intent and canonical receipt | ❌ Payload coincidence | Distinguish repetition from a second purchase |
| Payment | ✅ Durable state machine and reconciliation | ❌ Long transaction across provider call | Recover partial failures without holding inventory locks |
| Discovery | ✅ Bounded advisory projection | ❌ Exhaustive authoritative reads | Preserve the booking database's capacity |

> "The system is safe when every path respects the same inventory authority and every purchase
> can be recovered by identity. Search speed and extra replicas come after those two
> properties."
