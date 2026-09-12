# Airbnb — Backend System Design

*A 45-minute discussion of geographic discovery, inventory consistency and recovery.*

This answer proposes a production marketplace backend. The local application has
one Express API and a smaller feature set; [architecture.md](./architecture.md)
records its actual behavior, including incomplete concurrency and worker guarantees.

## 📋 Establish the scope and invariants — 4 minutes

> “I would concentrate on finding a suitable property and committing a reservation.
> Search can tolerate some staleness. A booking cannot allocate the same property
> to two parties for overlapping nights.”

The product supports guests searching by area, dates, party size and attributes.
Hosts manage listing information and calendar rules. Reservations can be immediate
or pending host approval, and either participant can cancel according to policy.

I would clarify whether one listing represents one independently bookable property.
For this design, it does. A hotel selling twenty interchangeable rooms would require
a quantity-based inventory model, which changes the central constraint.

I would include messaging and completed-stay reviews at the boundary, but spend
most time on three difficult decisions: protecting inventory, retrieving candidates,
and recovering work across failures.

The invariants I would write on the board are:

1. Active reservations for one property do not occupy overlapping nights.
2. Every inventory mutation follows the same authoritative concurrency protocol.
3. A retried client operation converges to one durable booking outcome.
4. Losing a notification does not erase a booking; recovery can find undelivered work.

For sizing, assume ten million listings, a peak of ten thousand searches per second
and a peak of one hundred booking attempts per second. These are interview assumptions.
Traffic and contention will be concentrated in popular destinations and properties.

I would target search p95 below 500 ms and a database booking decision below one
second at p99. Payment-provider and host-response time are separate measurements.

## 🏗️ Architecture and ownership — 5 minutes

```
┌──────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│ Web / Mobile │──────▶│ API / authentication │──────▶│ Search service  │
└──────────────┘       └──────────┬───────────┘       └────────┬────────┘
                                 │                            ▼
                       ┌─────────▼───────────┐       ┌─────────────────┐
                       │ Booking / inventory │       │ Search views    │
                       │ authority           │       │ and caches      │
                       └─────────┬───────────┘       └────────▲────────┘
                                 ▼                            │
                       ┌─────────────────────┐       ┌────────┴────────┐
                       │ Database + outbox   │──────▶│ Broker / workers│
                       └─────────────────────┘       └─────────────────┘
```

The booking authority owns occupied intervals and booking transitions. Search owns
retrieval and ranking, but it does not own the decision that dates are still free.
Listing information, messaging and reviews can begin as modules beside booking.

I would initially use PostgreSQL with PostGIS for relational and geographic queries.
A modular application is sufficient before deployment or load requires separation.
The diagram identifies responsibilities, not an obligation to deploy every box.

Public images live in object storage behind a CDN. Redis can hold sessions and
public read caches. Neither an image service outage nor an analytics backlog should
prevent an otherwise valid booking database transaction.

A normal booking request is short:

1. Authenticate and validate the requested listing, dates, guests and quote.
2. Resolve the client operation identity.
3. Lock the property and recheck authoritative inventory and state.
4. Write the booking, occupied interval, operation result and outbox event.
5. Commit, return the booking identity, and deliver downstream work asynchronously.

I would keep external HTTP calls outside this transaction. Holding a database lock
while waiting for a processor or email service turns their latency into inventory
contention and consumes database connections.

## 💾 Data model and API boundaries — 4 minutes

| Record | Key information | Important rule |
|--------|-----------------|----------------|
| Listing | Host, geographic point, capacity, status and stay rules | One independent inventory owner |
| Host rule | Listing, date interval, availability or price rule | Preserve unaffected intervals when edited |
| Occupancy | Listing, stay interval, booking/hold identity and state | No overlapping active occupancy |
| Booking | Guest, listing, dates, status, amount, currency and version | Explicit legal state transitions |
| Operation | Actor, key, request fingerprint and booking result | Unique actor/operation identity |
| Outbox event | Event ID, aggregate ID, version, payload and delivery state | Written with the business change |
| Consumer receipt | Consumer name and event ID | Deduplicated within that consumer's transaction |

Dates are civil dates in the property's calendar. A September 10–12 stay occupies
the 10th and 11th; another guest can arrive on the 12th. I would make checkout
exclusive throughout storage, APIs and the calendar UI.

Price snapshots include explicit currency and component amounts. Later listing
changes do not rewrite an agreed booking price. A quote has an identity and expiry,
but it is not an inventory reservation unless a hold is explicitly created.

| API operation | Contract |
|---------------|----------|
| Search listings | Bounded geographic/filter query and continuation |
| Read calendar / quote | Current rules, available range and itemized price |
| Create reservation | Quote or validated inputs plus idempotency key |
| Read operation / booking | Recover durable identity and latest state |
| Respond / cancel / expire | Expected state/version and authorized transition |
| Update host rules | Intended interval change and conflict detection |

These are logical contracts. I would agree on typed validation, conflict, unavailable
and pending responses before detailing every endpoint or request field.

## 🔧 Deep dive: Protect the inventory through every transition — 10 minutes

> “The important question is not whether booking creation uses a transaction.
> It is whether every path that changes ownership preserves the same invariant.”

### Why a preliminary availability check is insufficient

Two guests can both read that a property is available before either writes a booking.
If each inserts independently, both succeed. A transaction around each insert does
not solve this unless the transactions actually conflict on a shared authority.

I would lock the listing row, then check occupied intervals and write the reservation
while holding that lock. Different listings can proceed concurrently; requests for
one listing form a short serial sequence.

Under this protocol, the second creator waits for the first, then observes its
committed occupied interval and returns a conflict. The lock must precede the
conflict read, and the read must use the owning database rather than a stale replica.

A database exclusion constraint over active occupied ranges can provide an additional
safety check. It is especially useful against a forgotten write path, but it does
not define cancellation, expiry or host approval for us.

### Follow the lifecycle, not only creation

For instant booking, create a confirmed reservation and occupied interval together.
For host approval, create a pending request that also occupies the dates under the
policy chosen here. Give it a deadline so a silent host does not block inventory forever.

Host acceptance, rejection, guest cancellation and expiry must lock the same listing,
then read and validate the current booking state within the transaction. Use a
consistent lock order so different operations do not deadlock unnecessarily.

Consider this race:

1. A host reads that a request is pending.
2. The guest cancels, and the server releases the occupied interval.
3. The host's delayed update changes the booking to confirmed by ID alone.
4. Another guest books the apparently free interval.

The first booking is now confirmed without inventory protection. This is why an
unconditional update after an earlier state check is insufficient, even when creation
itself is serialized correctly.

With the shared protocol, the host rechecks after acquiring the lock. If cancellation
won, acceptance returns a conflict and cannot resurrect the request. State checks
and occupancy changes commit together.

A background expiry job follows the same protocol. It cannot delete a block merely
because an earlier query found an old pending request; that request may have been
confirmed since the query ran.

### Choose an availability representation

I would separate booked occupancy from host pricing and availability rules. A host
changing a nightly rate should not rewrite the records that establish a guest's claim.

Intervals work well when many adjacent nights share a rule. To replace a rule for
September 10–12 inside September 1–20, preserve September 1–10 and September 12–20.
The boundaries touch; there is no missing night and no overlap.

A day-by-day model makes individual nightly overrides and unique listing-night
claims straightforward. It also creates many rows across a large future horizon
and requires a multi-row transaction for every stay.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Intervals with one inventory authority | Compact repeated rules and one stay range | Careful range edits and lifecycle locking |
| ❌ Precreate every listing-night by default | Simple per-night lookups and overrides | Large future inventory and multi-row writes |

I would choose based on pricing granularity and measured query patterns. I would
not claim a fixed storage reduction from intervals without knowing how fragmented
host calendars become.

### Concurrency trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Listing-scoped database serialization | One place to reason about all writers | Popular listings can queue; authority must be reachable |
| ❌ Independent cached availability decisions | Fast reads close to users | Multiple writers can sell the same nights |

Optimistic version checks are also viable if every operation checks the version
and retries the complete decision. Under contention, they create failed work and
retry pressure. I would start with short database locks for this modest write rate,
then measure contention before introducing another coordination system.

Admission limits and bounded lock waits protect a hot listing. No amount of scaling
API instances makes one property divisible inventory. The expected response to a
burst is a small number of decisions and clear conflicts, not unbounded waiting.

## 🔧 Deep dive: Geographic search with an honest freshness boundary — 7 minutes

> “I would optimize search for finding useful candidates, and then validate the
> chosen property at commitment. Synchronizing every search view immediately is
> expensive and still cannot reserve inventory for a browsing user.”

### Start with the access pattern

A query specifies a geographic area, guest count, dates and optional attributes.
The spatial index narrows nearby active listings, then relational filters and
occupied-range checks remove unsuitable candidates.

For an initial system, PostgreSQL/PostGIS avoids a second synchronization pipeline.
It can combine geographic filtering with host/listing data already stored there.
That simplicity is useful while the team is still learning actual search behavior.

I would inspect dense-city queries and combinations of amenities, price and dates.
A spatial index does not guarantee that a broad radius, expensive count and complex
sort will all be fast. Cap query size and use representative query plans.

Use a deterministic tie-breaker in ordering. Cursor pagination should carry the
query identity and sort position so a later page cannot be applied to changed dates.
A live ranking can still move between requests; choose an explicit snapshot policy
if stable exhaustive paging is a product requirement.

### Cache complete queries, not partial identities

A search key includes all normalized result-affecting fields: geographic area,
dates, guests, filters, ordering and page. Truncating an encoded parameter string is
not equivalent to hashing it; different later fields can disappear from the key.

Personalized fields need their own scope. I would prefer a public candidate cache
with personalized decoration rather than accidentally serving one user's private
attributes in a shared response.

Dates and availability change frequently, so date-specific cache lifetimes should
be short or bypassed initially. A short TTL reduces ordinary staleness but does not
eliminate the race between a search read and a later reservation.

Invalidation also races with in-flight fills. An old database read can repopulate a
key after a deletion. Versioned values, bounded TTL and authoritative booking checks
each address different parts of this problem.

### Introduce a projection when it earns its cost

At the assumed peak, an independent search projection may be needed to keep discovery
load away from booking transactions. Feed it through a recoverable event/change
pipeline, attach versions, and measure how far behind it is.

New listings may appear late, and deleted listings may remain briefly visible.
Validate active status on detail/booking paths. If an indexed candidate becomes
unavailable, return a clear conflict and preserve the guest's dates for alternatives.

An unavailable search service is different from a successful empty search. A circuit
breaker can stop repeated calls to a failing dependency, but its fallback must carry
that degraded meaning through the API and UI.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ PostGIS first, independent projection when measured | Simple start with a clear growth path | Later indexing, repair and lag monitoring |
| ❌ Immediate global synchronization for every search view | Fresher discovery in theory | Couples writes to many read systems without reserving dates |

I would accept bounded stale discovery because users browse many candidates. I would
not accept stale inventory at commitment because that creates contradictory bookings.
This is a product-specific consistency boundary, not a blanket preference for
strong or eventual consistency everywhere.

## 🔧 Deep dive: Recover bookings and downstream work — 7 minutes

> “There are two separate retry problems: a guest retrying a request whose response
> was lost, and a worker receiving an event more than once. They need different
> identities and different records.”

### Recover the client operation

The client creates an operation key before submission and reuses it after a timeout.
The server scopes it to the actor and operation type, then stores a fingerprint of
the request alongside the durable booking result.

The same key and same payload return the original logical outcome. The same key
with different dates or guests is a conflict. A database uniqueness rule makes
concurrent requests converge rather than both creating independent reservations.

If the transaction commits and the response disappears, operation lookup finds the
booking. If the transaction rolls back, a retry can perform the work. A missing
response alone cannot tell the client which case occurred.

An operation record can retain its original result while the booking resource shows
the latest state. For example, replaying a successful creation must not imply that
a subsequently cancelled booking is still confirmed.

### Close the database-to-broker gap

Publishing after commit has a failure window: the API can die after writing the
booking but before sending its event. Publishing before commit has the opposite
problem: consumers can act on a booking that later rolls back.

I would write an outbox event in the booking transaction. A relay publishes it with
broker confirmation and marks delivery progress. Broker downtime grows a visible
backlog while the committed booking remains queryable.

If the relay crashes after broker acceptance but before updating the outbox, it may
publish again. The event ID stays the same. Each consumer deduplicates independently;
notification and analytics consumers must both be allowed to process that event.

For a database consumer, write its receipt and effect in one transaction. A Redis
read followed by a later marker write cannot atomically protect a separate database
update, and one shared marker across consumers can suppress legitimate work.

### Bound retries and handle ordering

Persist an attempt count when republishing failed work, or use broker-supported
retry routing with an observable counter. Requeuing the unchanged original message
does not increment a custom retry header by itself.

After a bounded number of attempts, route the message to a dead-letter queue that
actually has a matching binding. Operators need a replay path after fixing the
underlying issue, and replay must preserve event identity.

Events can arrive out of order. A stale creation event must not recreate inventory
after cancellation. Inventory remains owned by its synchronous authority; projections
apply versions or rebuild current state rather than blindly replaying old actions.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Outbox plus consumer-scoped transactional receipts | Recoverable loss and duplicate delivery | Relay, backlog monitoring and replay tools |
| ❌ Best-effort publish plus global cache marker | Fewer records and components | Lost events, duplicate effects or skipped consumers |

External email and payment providers require their own idempotency or reconciliation
support. A local receipt cannot make an external call and a database commit atomic.
I would state that limit explicitly instead of promising universal exactly-once delivery.

If payments are required, reserve a bounded hold, record the payment attempt and
call the provider outside inventory locks. Reconcile uncertain outcomes. A late
success after hold expiry requires compensation, not unconditional confirmation.

## 🛡️ Security, reviews and operational failure — 4 minutes

Authenticate with server-side sessions and enforce guest/host ownership on every
resource operation. A caller being a host does not authorize editing another host's
listing. Validate that supplied conversation and booking relationships match the caller.

Keep exact property access details private until the chosen disclosure policy allows
them. Uploaded files need ownership checks before durable acceptance, content limits,
safe storage names and a cleanup lifecycle for abandoned uploads.

For reviews, enforce one submission per booking and author role. Reveal according
to a declared policy after both submissions or a deadline. The reveal decision needs
serialization or repair so simultaneous submissions do not each miss the other.

Operationally, I would distinguish dependency failure from business rejection:

| Condition | Response |
|-----------|----------|
| Dates occupied | Conflict with recoverable user inputs |
| Owning database unavailable | Reject/defer new booking decisions |
| Search projection unavailable | Explicit degraded/unavailable search |
| Notification backlog | Booking remains valid; delivery is delayed |
| Payment outcome unknown | Persist uncertainty and reconcile before final transition |

Monitor lock waits, conflicts, stale-state rejections, operation recovery, outbox age
and dead letters. Booking value is not collected revenue; monetary metrics must
state exactly which lifecycle event they represent.

## 📈 Scale and validate the design — 4 minutes

I would scale public reads and image delivery before splitting inventory ownership.
At larger write volume, partition bookings and occupied intervals together by listing
ID. A routing directory sends each listing's writes to its owning partition.

Guest trip history then spans listing partitions. Build a user-oriented read view
with a repairable update path rather than making the booking transaction fan out
to every query model synchronously.

Regional replicas improve browsing latency. During a network partition, a region
that cannot reach a listing's authority cannot independently confirm its dates.
Changing that requires an explicit ownership-transfer or consensus design.

The highest-value validation uses real transactions and controlled failure points:

1. Two guests reserve overlapping dates simultaneously.
2. Adjacent checkout/check-in dates both succeed.
3. Host acceptance races with cancellation and expiry.
4. A host calendar edit races with a booking.
5. Creation commits but its response is lost, then the client retries.
6. An event is duplicated, reordered and replayed independently to two consumers.

Mocked route tests are useful for HTTP contracts but cannot demonstrate database
isolation, broker acknowledgements or restart recovery. I would test those boundaries
with the actual infrastructure before claiming their guarantees.

The local repository implements the creation lock, PostGIS queries and cache/queue
helpers, but not the complete protocol described here. In particular, lifecycle
races, date-query failures and incomplete workers remain documented implementation gaps.

> “The scalable part is allowing different properties and read views to progress
> independently. The correctness part is keeping each property's ownership decision
> in one place and making every retry recover an identifiable outcome.”
