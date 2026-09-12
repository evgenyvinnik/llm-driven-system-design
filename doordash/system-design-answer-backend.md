# DoorDash — backend system design interview

A proposed 45-minute design for a food-delivery backend. Production targets and mechanisms
below are design choices, not benchmarks or claims that the local implementation already
provides them.

## 🗣️ Requirements and boundaries — 4 minutes

> “I'd start with two promises: one checkout operation creates one complete order, and one driver cannot hold two live assignments in our initial model. Fast location lookup helps dispatch, but it cannot establish either promise.”

The product has three actors. Customers discover restaurants and place an order; restaurants
confirm and prepare it; drivers accept an assignment, pick up, and deliver. Participants
need current status and an approximate arrival time. Support needs an attributable history
of accepted actions.

For this interview, I would limit an order to one restaurant and a driver to one active
order. That deliberately postpones batching and route optimization until assignment
correctness is established. I would ask whether cancellation is allowed after preparation
starts and define a narrow initial policy rather than leaving that race unspecified.

Payment collection, refunds, payouts, and chat are outside the initial design. We still
record an agreed total, but an order row is not a payment receipt. If a provider is added,
its state and reconciliation need separate treatment.

| Requirement | Proposed target or invariant |
|-------------|------------------------------|
| Availability | 99.9% monthly for regional order operations |
| Checkout transaction | p95 below 500 ms after an agreed quote |
| Connected-client visibility | Committed status visible within 2 s at p95 |
| Position ingestion | p95 below 200 ms; initial reporting cadence 10 s |
| Dispatch freshness | Ignore observations older than 30 s |
| Correctness | Scoped checkout receipts, authorized transitions, exclusive live assignments |

The latency goals end at specified boundaries. A successful checkout does not mean a
restaurant has accepted, a driver has accepted, or a card has been charged. I would keep
these acknowledgements distinct in both API responses and monitoring.

## 📏 Capacity and high-level design — 5 minutes

Assume one million orders per day and a tenfold peak relative to the daily average. That is
about 12 checkouts per second on average and 116 at peak. Dinner demand also concentrates by
market, so global averages hide local pressure.

At peak, 100,000 drivers sending every ten seconds produce 10,000 position updates per
second. This is the workload most likely to overwhelm a naive design that synchronously
updates SQL on every sample.

| Data or work | Approximation | Design implication |
|--------------|---------------|--------------------|
| Order creation | 1 million/day | Short relational transactions are reasonable initially |
| Lifecycle events | Assume 6/order: 6 million/day | About 69/s average before peak factors |
| Position events | 10,000/s at peak | Separate ingestion and replace obsolete samples |
| Core order/line payload | 2 KiB/order: about 1.9 GiB/day | Add indexes, replicas, and retention to physical sizing |
| Full-day peak position history | 200 bytes × 10,000/s: about 161 GiB/day | Upper bound, not a forecast; sampling and expiry matter |

I would draw one regional architecture and explain how markets become partition boundaries:

```
┌───────────────────────┐
│ API + authentication  │
└───────────┬───────────┘
            │
      ┌─────┴─────────────────────┐
      ▼                           ▼
┌──────────────────┐    ┌──────────────────┐
│ Catalog + orders │    │ Location intake  │
└────────┬─────────┘    └────────┬─────────┘
         ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│ Market SQL       │    │ Fresh geo index  │
│ Orders + outbox  │    └────────┬─────────┘
└────────┬─────────┘             ▼
         │              ┌──────────────────┐
         │              │ Dispatch + ETA   │
         │              └──────────────────┘
         ▼                 Claims use SQL
┌──────────────────┐
│ Relay + event bus│
└────────┬─────────┘
         ▼
┌──────────────────────────────────────────┐
│ Socket gateways + notification workers   │
└──────────────────────────────────────────┘
```

The dispatcher reads candidates from the geo index and writes authoritative claims in market
SQL. Location intake updates the geo index. The bus carries durable lifecycle events to
downstream work, while current positions can use a coalescing fan-out path.

These are logical responsibilities. I would start with a small number of deployable services
and split location ingestion when its measured load warrants it. Naming six services on a
whiteboard does not require six teams or six independently failing databases on day one.

## 💾 Data model and API — 5 minutes

PostgreSQL owns order intent, state, and assignment claims. A geo index contains potentially
stale candidates. Catalog caching can tolerate bounded staleness because checkout validates
the selected facts again.

| Entity | Important fields and constraints | Main access pattern |
|--------|----------------------------------|---------------------|
| Restaurant/menu | Owner, service area, opening status, item revision, price/currency, availability | Nearby discovery and one restaurant's menu |
| Quote | Customer, item revisions, destination, fees, total, expiry | Validate the exact terms the customer accepted |
| Order/lines | Customer, restaurant, state/version, destination snapshot, agreed line amounts | Participant reads and state transitions |
| Operation receipt | Actor, operation type/ID, payload digest, result order/version | Retry an uncertain operation safely |
| Driver | Account, service market, availability preference, profile | Eligibility and account authorization |
| Assignment claim | Order, driver, claim ID, state, deadline | At most one live claim per order and per driver |
| Outbox | Event ID, order ID/version, event kind, publication state | Retry committed events until published |
| Audit event | Actor, accepted action, before/after version, timestamp | Investigate what the system accepted |

An order line preserves the name, quantity, and agreed amount even if a menu item later
changes. Deleting a restaurant or user should not silently erase the order's fulfillment
record. Retention and privacy decisions therefore affect snapshots and access, not merely
foreign-key deletion behavior.

| Method | Proposed endpoint | Purpose |
|--------|-------------------|---------|
| GET | `/restaurants` | Bounded discovery query with cursor |
| POST | `/quotes` | Price and validate a basket/destination |
| POST | `/orders` | Commit an accepted quote under a stable operation ID |
| GET | `/operations/:id` | Resolve the caller's uncertain operation |
| GET | `/orders/:id` | Authorized snapshot with version and freshness metadata |
| POST | `/orders/:id/actions` | Authorized transition with expected version and operation ID |
| POST | `/offers/:id/accept` | Accept the exact live assignment claim |
| POST | `/drivers/me/location` | Submit a sequenced observation |

These are proposed contracts, not a list of existing local routes. A version conflict means
“re-read and determine whether the intended action is still valid.” It does not mean “retry
unconditionally until the update succeeds.”

## 🔧 Deep Dive 1: A complete order and an uncertain response — 8 minutes

### Decision: commit the order, receipt, and outbox together

Consider a server that inserts the order, inserts two of three lines, and fails on the final
line. The customer sees an error, but the kitchen may see an incomplete order. A response
cache cannot repair the partial write because the database effects already happened.

I would validate the accepted quote and create the order/lines in one SQL transaction. The
same transaction claims the operation ID, records its result, and appends an outbox event. A
unique operation key is scoped by actor and operation type, with a digest binding it to the
agreed request.

The normal flow has a few important boundaries:

1. Authenticate the caller and validate input size, shape, quantities, currency, and
destination.
2. Find or claim the scoped operation; reject reuse with a different payload.
3. Validate the quote's expiry and current required revisions under a consistent concurrency
policy.
4. Commit the order, every line, result receipt, audit event, and outbox record together.
5. Return the committed order ID; downstream delivery of the event can occur afterward.

If the connection dies after commit, the caller retries the same operation ID and gets the
stored result. If the transaction rolls back, there is no partial order. A database timeout
can still leave the client unsure, so the client must reconcile rather than infer failure
from a transport exception.

| Approach | Why it works or fails here |
|----------|----------------------------|
| ✅ SQL receipt with order transaction | The receipt and commercial intent share one commit boundary |
| ❌ Redis response cache as the only receipt | Cache loss or a crash after SQL commit can make a retry create another order |
| ❌ Separate inserts followed by cleanup | A crash or cleanup failure exposes a partially created order |

The cost is additional rows, indexes, and retention policy for receipts. Repeated use of one
operation ID serializes around its unique record. That is acceptable because all those
requests represent one logical action; different checkouts can proceed independently.

### Why the outbox is part of the same decision

Publishing directly after commit has a gap: the database succeeds and the process dies
before Kafka accepts the event. Publishing before commit has the opposite problem: consumers
act on an order that never commits. The outbox records the need to publish alongside the
order.

A relay publishes with stable event IDs and retries failures. A crash after publication but
before recording completion can cause a duplicate, so consumers must deduplicate their
effects. A notification provider may have another independent boundary; a deduplicated
consumer alone cannot promise exactly one visible notification.

I would describe this as recoverable at-least-once processing. The guarantee is a durable
accepted order and a recoverable event, not universal exactly-once behavior across every
database, broker, phone, and future payment provider.

### Handling changed terms

The quote is more than cached arithmetic. It binds the customer to a particular total and
destination. If an item becomes unavailable or a required revision changes, return a revised
quote or a specific rejection before creating the order.

If the business chooses to honor a quote for its lifetime, it needs the corresponding
reservation or pricing policy. A timestamp by itself does not reserve inventory. I would
choose simple revalidation with explicit customer agreement first, rather than silently
promising stock or delivery capacity the system has not held.

## 🔧 Deep Dive 2: Two dispatchers choose the same driver — 9 minutes

### Decision: candidate selection is approximate; assignment is transactional

> “The geo index answers who looks nearby. The database answers who actually holds the job. Those are different questions, and the race happens when we treat the first answer as permission to assign.”

Suppose two orders are confirmed at the same restaurant within a few milliseconds. Both
dispatchers read the same driver as available. A score based on distance, rating, or
experience can rank that driver first twice. The algorithm's quality does not resolve the
conflicting write.

I'd obtain a bounded candidate set from a regional geo index, check observation age and
online preference, then rank likely pickup suitability. Straight-line distance is a
candidate filter; road travel and preparation timing can refine the shortlist. Start simple,
then measure pickup delay and driver allocation before increasing model complexity.

The chosen candidate must be claimed atomically. The dispatcher enters a short market-local
transaction, checks the order still needs dispatch, and checks the driver's live claim. It
creates a claim with a unique ID and deadline while enforcing uniqueness of live order and
driver claims.

If another transaction already won the driver, try the next candidate. Do not keep a
database transaction open while waiting for a human to accept an offer. The durable expiring
claim is what reserves capacity across that waiting period.

### Acceptance, expiry, and cancellation share one authority

Acceptance requires the exact claim ID, authenticated driver, permitted order state, and
unexpired deadline. It commits assignment and an outbox event. If expiry wins first, a late
acceptance is rejected even if the phone still displays the old offer.

A timeout worker releases only the claim it was scheduled for. A stale timer must not free a
driver's replacement job. Claim identity is therefore as important as the deadline.

Cancellation uses the same order/claim transaction protocol and a consistent record locking
order. If cancellation wins, later matching cannot attach a driver to the cancelled order.
If acceptance wins, cancellation follows the explicitly defined post-acceptance policy
instead of blindly changing a status field.

Delivery also checks the assignment identity and expected order state. It closes the claim,
updates the order, and records its receipt in one transaction. Repeated delivery requests
return the original receipt, preventing duplicate completion counts or accidental release of
a new assignment.

| Assignment strategy | Strength | Cost or failure mode |
|---------------------|----------|----------------------|
| ✅ Geo candidates plus SQL claims | Fast shortlist with explicit exclusive ownership | Transaction contention and lease lifecycle handling |
| ❌ Read available, then update two records separately | Easy happy path | Concurrent dispatchers can double book or leave one side stale |
| ❌ Global dispatcher lock | Simple serialization | Unrelated markets wait behind one bottleneck and failure domain |

The SQL design sacrifices some availability during an authority outage: we stop confirming
new assignments rather than inventing ownership independently on each side of a partition.
Existing clients can still display their last known job with an uncertainty indicator.

### What happens when there is no candidate?

Keep a durable dispatch task with next-attempt time, attempt budget, and maximum wait
policy. Retry with jitter and bounded radius expansion if the business permits it. Tell the
customer that assignment is pending; a function returning `queued: true` is not enough
unless a recoverable job actually exists.

A circuit breaker can stop repeatedly calling a failing route estimator. It should not wrap
arbitrary SQL mutation and then imply that a timeout rolled those mutations back. Timed-out
work may continue unless cancellation is real; claim identity and transaction predicates
still enforce correctness.

A Redis outage also removes fresh candidate evidence. A bounded fallback using recent
observations may be acceptable at low load, but scanning every stored driver and trusting
yesterday's coordinates is not an equivalent service. Measure the fallback and fail visibly
if its freshness or load bound cannot be met.

## 🔧 Deep Dive 3: Location, ETA, and event recovery — 8 minutes

### Decision: retain business state durably and replace obsolete positions

At 10,000 position updates per second, persisting and replaying every point through the
order transaction path adds write load without improving order correctness. Most clients
need the latest observed position, while support may need a sampled history under a separate
retention policy.

A report includes a tracking-session ID, increasing sequence, observation time, accuracy,
and coordinates. Driver identity comes from authentication. Reject invalid ranges,
unreasonable future timestamps, and obsolete samples. Receipt time helps distinguish a
delayed upload from a newly observed position.

The geo index and freshness metadata need a coordinated update policy. Expiring a separate
metadata hash does not expire a member in a shared geo set. Query-time freshness checks are
mandatory even if a cleanup worker usually removes old members on schedule.

| Data | Delivery/recovery requirement | Storage choice |
|------|-------------------------------|----------------|
| Accepted order transition | Recover after a process/broker interruption | SQL state/version plus outbox |
| Latest driver position | Prefer newest valid observation | Geo index and bounded current-position record |
| Historical route sample | Optional analysis with retention/access policy | Sampled append stream and time-partitioned storage |

The trade-off is two recovery semantics. Lifecycle consumers deduplicate events and
reconcile versions. Position consumers discard older samples and display age. One global
“latest timestamp” cannot safely order independent business and telemetry facts.

### Socket fan-out

A customer subscribes to their order; a restaurant subscribes to its queue; a driver
subscribes to their assignments. The gateway verifies ownership on connection and
subscription, and revokes access when appropriate. An order ID is an identifier, not a
secret capability.

Gateways need shared routing across instances. A Kafka consumer group distributes events
among consumers; it does not automatically send an event to every gateway holding a relevant
socket. I would route by subscriber ownership or use a shared fan-out layer, with an
authoritative snapshot available for recovery.

For a slow client, retain the newest pending location and cap memory. If lifecycle delivery
falls behind beyond a bound, send a resync signal or disconnect and require a snapshot.
Replaying minutes of old movement to preserve every sample wastes bandwidth and misleads the
viewer.

Reconnect must close the subscription/snapshot race. Establish a subscription cursor, fetch
a snapshot, then apply newer events according to the documented version boundary. Queue
views may need a collection cursor or full refresh; an individual order version cannot
reveal an entirely missed new order.

### ETA is stage-dependent

Before pickup, driver travel to the restaurant and food preparation happen in parallel. If
travel takes eight minutes and prep has twelve remaining, pickup is roughly twelve minutes
away, not twenty. Add onward travel and pickup/drop-off work after that overlap.

After pickup, remaining travel starts at the driver's latest valid position, not back at the
restaurant. Remove pickup work already completed. Before assignment, include dispatch
uncertainty rather than pretending an unassigned driver is already at the restaurant.

I'd expose an ETA range and freshness, measuring error by market, vehicle, and stage. A
simple formula is a good baseline because its components are inspectable. ML becomes
justified when retained observations and error analysis show which residual uncertainty it
can improve; it does not substitute for fresh inputs or correct stage logic.

## 🛡️ Operations, scale, and the local implementation — 6 minutes

The first scaling changes follow measured pressure: separate location ingestion, bound
discovery with spatial filtering and pagination, batch candidate metadata reads, then scale
socket gateways with shared routing. Partition transaction authority by market once
contention or dataset size warrants it. Cross-market driver handoff needs an explicit
transfer protocol.

Authentication must restrict privileged role provisioning, rate-limit credentials and
telemetry, validate input, and authorize every action. Socket events should contain only the
fields each participant needs. Precise positions, addresses, and phone numbers should not be
copied into every log and downstream event by default.

Readiness should reflect the dependencies required for the advertised operation. If Kafka is
asynchronous behind a durable outbox, broker downtime need not immediately reject checkout,
but queue age and storage limits must trigger backpressure. If fresh dispatch depends on
Redis, its outage should not be hidden behind a generic green health response.

| Failure drill | Evidence I would require |
|---------------|--------------------------|
| Checkout commits, response is dropped | Same operation returns one complete order |
| Two orders choose one driver | Exactly one live claim wins; the other retries |
| Offer expires while acceptance arrives | One guarded winner; stale timer cannot release a replacement |
| Cancellation races dispatch | No live assignment on a cancelled order |
| Relay crashes after publish | Duplicate event causes no duplicate consumer effect |
| GPS stops but geo member remains | Candidate is excluded by age |
| Gateway restarts during preparation | All participants recover current authorized state |

I'd monitor operation conflicts, partial-order invariant violations, dispatch backlog age,
claim expiry, duplicate assignment attempts, stale location fraction, outbox lag, and ETA
error. Derive active counts from authority or reconcile them periodically; gauges built only
from increments drift after restarts and retries.

### What is implemented locally

The repository has one Express process, PostgreSQL, Valkey, process-local WebSockets, and
Kafka producers without consumers or an outbox. Matching runs once at restaurant
confirmation and assigns automatically. It does not use expiring offers, radius expansion,
durable rematching, or exclusive claims.

Checkout inserts the order and lines separately. Redis provides a 60-second NX marker and a
24-hour response cache only for creation; it caches error responses too, lacks actor/payload
scope, and permits processing after Redis errors. The browser generates a new key per
invocation. Isolated source execution reproduced partial orders and response reuse across
actors.

Status handlers validate a read and update by ID without a version guard. An unrelated
authenticated user can perform the nominally system-only delivered-to-completed transition.
Assignment can attach a driver to a cancelled order, and concurrent attempts can select the
same driver. Dedicated driver delivery updates also differ from generic status updates.

Location reports synchronously write SQL, then a geo set and a hash whose TTL does not
expire the geo member. The installed client's `geoSearch` returns member IDs, while the
caller expects distance objects; nonempty replies normally fall into the SQL fallback.
Neither path enforces freshness. The ETA formula uses straight-line speeds and server-clock
multipliers, and still counts the full restaurant-to-customer leg after pickup.

WebSockets accept unauthenticated arbitrary subscriptions and have no cross-process relay or
replay. Kafka publications are best effort, audit rows are written after effects, and
business gauges are not authoritative. These limits are documented with source links in
[architecture.md](./architecture.md#implementation-notes); [README.md](./README.md) covers
the demo and its setup. The proposed guarantees in this answer require implementation work.

### Trade-offs I would defend

| Decision | Chosen | Alternative | Cost accepted |
|----------|--------|-------------|---------------|
| Checkout | ✅ SQL receipt/order/outbox transaction | ❌ Cache-only retry protection | Extra durable writes and retention policy |
| Assignment | ✅ Market-local exclusive claims | ❌ Trust a stale candidate list | Serialization and acceptance/expiry lifecycle |
| Tracking | ✅ Durable status, replaceable position | ❌ Persist and replay everything identically | Two explicit recovery models |

> “The design succeeds when ownership remains unambiguous after failures. A nearby driver is only a candidate, a broker message is not the order itself, and a timeout is not a rollback. I'd establish those boundaries before optimizing ranking.”
