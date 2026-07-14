# Local Delivery Service - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a last-mile delivery platform — DoorDash, Instacart, Uber Eats. Customers order from local merchants, drivers pick up and deliver, everyone watches a dot move on a map.

The thing that makes this hard is not any one service. It's that this is a **three-sided marketplace with a physical world in the middle.** Customers, merchants, and drivers all have to be satisfied, their incentives conflict, and unlike a purely digital system we cannot retry reality: a driver who has already driven to the wrong restaurant cannot be rolled back. Two problems dominate everything else:

1. **Matching** — assigning one order to one driver, exactly once, in seconds, in a way that's fast for the customer *and* fair to the driver *and* efficient for the fleet. Those three goals actively fight each other.
2. **Location ingest and fan-out** — 10,000 location writes per second from a fleet that never stops moving, pushed to every customer staring at a tracking screen.

## 🎯 Requirements Clarification

- **Do we take payment?** Assume payment is a separate service behind an interface. It matters for the order state machine (authorize before matching, capture on delivery) but it isn't the interesting part here.
- **How stale can a driver's location be?** Three seconds. That number is doing an enormous amount of work in this design — I'll show why in Deep Dive 2.
- **Is matching optimizing for the customer or the fleet?** This is the question I most want answered, because it's the difference between greedy per-order matching and batched global assignment, and it changes the architecture.
- **One metro or many?** Many, but drivers essentially never cross metro boundaries. That's the shard key, and it's free.

### Functional Requirements

- **Order placement** with idempotency (a customer must never be charged twice for a double-tapped button)
- **Driver matching** with a scoring algorithm and an offer/accept protocol
- **Real-time tracking**: driver location and ETA to the customer
- **Order lifecycle**: a state machine from `pending` through `delivered`
- **Notifications** to all three parties on state changes
- **Two-way ratings** after completion

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Match latency | Driver assigned within 30s | Longer and the food gets cold; the merchant starts cooking on confirmation |
| Location freshness | 3s | Below the threshold where a moving dot looks broken |
| API p99 | < 200ms | Standard, but order placement specifically must never be slow — it's the revenue moment |
| Availability | 99.99% for order placement | Everything else can degrade. This can't |
| ETA accuracy | ±3 min, 90% of the time | The single biggest driver of customer trust and support-ticket volume |
| Durability | Zero lost orders | An order accepted and forgotten is worse than an order rejected |

### Scale Estimates

These numbers drive every decision below, so they're worth deriving:

- **1M orders/day** ≈ 12/second average. But delivery demand is *savagely* peaked: lunch and dinner give a 3× multiplier, so **~35 orders/second at peak**. Order volume is genuinely small — this is not a throughput problem.
- **100K drivers, ~30% online = 30,000 concurrent.** At one location update every 3 seconds, that's **10,000 writes/second** — three orders of magnitude more traffic than orders. **Location is the firehose; orders are a trickle.** Any design that treats them the same is wrong.
- **Location storage if naively persisted**: 10K/sec × ~100 bytes = **86 GB/day**. That number alone rules out "just write it to Postgres."
- **Tracking fan-out**: at peak, tens of thousands of customers watching a map, each needing an update every few seconds.

The asymmetry is the whole story: **orders are low-volume and must be perfect; locations are high-volume and are allowed to be lossy.** Those two facts justify two completely different data paths.

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│         Clients:  Customer app · Driver app · Merchant       │
└────────┬───────────────────────┬──────────────────┬──────────┘
         │ HTTPS (orders)        │ HTTPS (location) │ WSS (tracking)
         ▼                       ▼                  ▼
┌──────────────────────────────────────────────────────────────┐
│    API Gateway — TLS, authn, rate limits (per-user)          │
└───┬──────────────────┬────────────────┬──────────────┬───────┘
    ▼                  ▼                ▼              ▼
┌─────────┐    ┌──────────────┐  ┌───────────┐  ┌──────────────┐
│  Order  │    │  Location    │  │ Tracking  │  │ Notification │
│ Service │    │  Service     │  │ Service   │  │ Service      │
│ • state │    │ • GEOADD     │  │ • Pub/Sub │  │ • push/SMS   │
│   machine    │ • 10K/sec    │  │ • ETA     │  │ • via Kafka  │
│ • idem-  │   │ • no DB write│  │ • WS fan- │  └──────────────┘
│   potency│   │   on hot path│  │   out     │
└────┬─────┘   └──────┬───────┘  └─────▲─────┘
     │                │                │
     ▼                │                │
┌──────────────┐      │                │
│  Matching    │◀─────┘ GEORADIUS      │
│  Service     │                       │
│ • score      │                       │
│ • sequential │                       │
│   offers     │                       │
│ • 1 leader   │                       │
│   per metro  │                       │
└────┬─────────┘                       │
     │                                 │
     ▼                                 │
┌─────────────────┐  ┌─────────────────┴──┐  ┌──────────────────┐
│   PostgreSQL    │  │   Redis / Valkey   │  │      Kafka       │
│ orders (truth)  │  │ • geo index        │  │ • location events│
│ drivers, offers │  │ • sessions         │  │ • order events   │
│ last-known loc  │  │ • pub/sub          │  │ • analytics      │
│ ratings         │  │ • order:{id}:events│  │   (durable tail) │
└─────────────────┘  │   (replay stream)  │  └──────────────────┘
                     └────────────────────┘
```

The structural decision worth defending: **the location path and the order path share nothing but a database they use for different things.** Location writes go to Redis and Kafka and never touch PostgreSQL on the hot path. Orders go to PostgreSQL and are never allowed to be eventually consistent. Merging them — "just write locations to the orders database, it's all one system" — is how you get a delivery platform whose checkout goes down because too many drivers are driving.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id, email, password_hash, role (customer/driver/merchant/admin) | unique(email) | One identity table, four roles |
| drivers | id (= users.id), vehicle_type, **status** (offline/available/busy), rating, acceptance_rate, current_lat/lng, location_updated_at | partial index on (lat, lng) **where status='available'** | The partial index matters: we only ever geo-search available drivers, so indexing the other 70% is wasted |
| merchants | id, owner_id, name, lat, lng, category, **avg_prep_time_minutes**, is_open | (lat, lng), (category) | `avg_prep_time` is the most important column here — it's what makes the driver arrive *when the food is ready* |
| menu_items | id, merchant_id, name, price, is_available | (merchant_id) | |
| orders | id, customer_id, merchant_id, driver_id, **status**, delivery lat/lng, subtotal, delivery_fee, tip, total, timestamps per state | (status), (driver_id) partial on active, (customer_id, created_at) | The state machine lives in the `status` column and the per-state timestamps |
| order_items | id, order_id, menu_item_id, **name, unit_price** (denormalized) | (order_id) | Denormalized on purpose: the merchant changing their price tomorrow must not change what this customer was charged today |
| driver_offers | id, order_id, driver_id, status (pending/accepted/rejected/expired), offered_at, **expires_at** | (order_id), (driver_id) | This table *is* the matching protocol, and it's also the audit trail for acceptance rate |
| ratings | id, order_id, rater_id, rated_user_id, rating 1–5 | (order_id) | |
| idempotency_keys | key (PK), user_id, operation, response (JSONB), status | (expires_at) | **In PostgreSQL, not Redis** — see below |
| driver_location_history | driver_id, lat, lng, recorded_at | (driver_id, recorded_at DESC) | Time-partitioned. 7-day retention. Not on the hot path |

Two schema decisions to defend:

**`order_items` denormalizes name and price.** A foreign key to `menu_items` would be "cleaner." It would also mean that when the merchant raises the price of a burrito, every historical order silently re-prices itself. An order is a **contract about a past moment**, and contracts don't get to change retroactively. Same reasoning as a receipt.

**Idempotency keys live in PostgreSQL, not Redis.** Everywhere else in this design I'd reach for Redis. Not here: an idempotency key that vanishes when Redis restarts means a customer's retry places a *second real order* with a *second real charge*. The 24-hour TTL keeps the table small, and the durability is the entire point of the mechanism.

## 🔌 API Design

```
# Customer
GET    /api/v1/merchants?lat=&lng=       Browse nearby
GET    /api/v1/merchants/:id/menu
POST   /api/v1/orders                    Place order (X-Idempotency-Key REQUIRED)
GET    /api/v1/orders/:id
WSS    /ws                               Subscribe to order tracking

# Driver
POST   /api/v1/driver/go-online | go-offline
POST   /api/v1/driver/location           High-frequency; the firehose
POST   /api/v1/driver/offers/:id/accept  The race — see Deep Dive 1
POST   /api/v1/driver/offers/:id/reject
POST   /api/v1/driver/orders/:id/picked-up | delivered

# Admin
GET    /api/v1/admin/orders | drivers | stats
```

## 🔄 The Order State Machine

Everything in this system is easier once this is on the board, because every failure is "stuck in a state" or "transitioned twice."

```
  pending ──▶ confirmed ──▶ preparing ──▶ ready_for_pickup
     │            │                              │
     │            │                     (matching runs here,
     │            │                      or earlier — see below)
     │            │                              ▼
     │            │                       driver_assigned
     │            │                              │
     │            │                              ▼
     │            │                          picked_up
     │            │                              │
     │            │                              ▼
     │            │                         in_transit
     │            │                              │
     │            │                              ▼
     ▼            ▼                          delivered
  cancelled ◀────────────────────────────────────┘
                              (only before pickup)
```

**Transitions are enforced with a conditional update**, not a read-then-write: move to `picked_up` only *where* the current status is `driver_assigned`. If zero rows update, the transition was already applied or is invalid — and we return the current state rather than an error, because the most common cause is a driver's phone retrying on a flaky connection in a parking garage.

**When to match is a real product decision.** Matching at `ready_for_pickup` means the driver arrives to a cold pickup and the food sits. Matching at `confirmed` means the driver arrives before the food is ready and waits (unpaid, angry). The right answer is to match at `confirmed + (avg_prep_time − estimated_travel_time)`, so the driver arrives roughly when the food does. That is why `avg_prep_time_minutes` is on the merchant table — it's not decoration, it's the input to a scheduling decision that determines whether drivers are willing to work for you.

## 🔧 Deep Dive 1: Matching — Sequential Offers, and the Fairness/Latency/Efficiency Triangle

**The decision**: when an order needs a driver, score nearby available drivers, offer to the **single best one**, and give them a bounded window (30s, tightening to 15s after repeated rejections) to accept. If they decline or time out, offer to the next.

**Scoring** weights distance (~40%), driver rating (~25%), acceptance rate (~20%), and current load (~15%). The distance term dominates for an obvious reason and the acceptance-rate term exists for a subtle one: a driver who ignores every offer isn't "neutral," they're actively costing us 30 seconds per order they ignore. Deprioritizing them is how we protect match latency for the customer.

**Why not broadcast to every nearby driver?** This is the obvious alternative and it's what most first designs do. It breaks in three specific ways:

1. **Thundering herd.** 50 drivers within 5km all get a push, all open the app, all hammer `POST /offers/:id/accept` inside two seconds. 49 of those requests are guaranteed to fail. We've created a 50× write amplification and a race on a single order row, at exactly the moment the system is busiest.
2. **It doesn't actually eliminate the race, it *creates* it.** With broadcast, correctness now depends on a conditional update winning cleanly under contention — and the 49 losers have to be told "too late" in a way that doesn't make them stop using the app. Sequential offers don't have a race to resolve, because only one driver is ever *able* to accept.
3. **It's a worse product for drivers.** Broadcast is a lottery, and lotteries reward whoever has the fastest phone and the fewest scruples about driving while tapping. Sequential offers let us give the best-rated, closest driver first refusal, which is a policy we can defend to both drivers and regulators.

> "The trade-off I'm accepting is real and it's ugly: sequential offers are **slower in the worst case.** Five drivers declining at 30 seconds each is two and a half minutes, and I've blown the 30-second SLO by 5×. I mitigate it — shorten the window after a rejection, skip drivers with a history of ignoring offers, and offer to the next candidate *before* the current one's timer fully expires so the pipeline overlaps. But I want to be honest that I'm trading tail latency for correctness and fairness, and the reason that's the right trade here is that a slow match is *recoverable* — the customer sees 'finding your driver,' and we can always widen the radius — while a double-assignment is not. Two drivers showing up at one restaurant is a real-world event you cannot roll back with a transaction."

**The genuinely better alternative, and why I'd defer it: batched global assignment.** Instead of matching each order greedily on arrival, accumulate orders for a short window (say 30–60 seconds) and solve the whole assignment problem at once — a bipartite matching over orders and drivers. This is what a mature platform does, and it's meaningfully better for the *fleet*: greedy matching gives the nearest driver to whichever order happened to arrive first, which can strand a later order with no one nearby. Global assignment can also batch two deliveries in the same direction onto one driver, which is where the real margin is.

But it costs latency by construction — every order waits for the batch window — and it costs an enormous amount of complexity: you need a solver, a way to handle drivers who go offline mid-batch, and a way to explain to a driver why they didn't get the order 200 meters from them. I'd build greedy sequential first, instrument it, and move to batching when the metric that justifies it — driver idle time and cross-order routing waste — actually shows up. Building the solver first is optimizing a system you haven't measured.

**The offer is a soft lock.** While an offer is `pending`, that driver is not offered another order. This is the thing that makes "sequential" mean anything, and it needs a timeout, because a driver whose phone died must not hold a lock forever. The `expires_at` column is the lease.

## 🔧 Deep Dive 2: The Location Firehose — Why 3 Seconds Is an Architecture, Not a Setting

10,000 writes/second, from 30,000 phones, forever. This is 800× the order volume and it needs a completely different data path.

**What the naive design costs.** Write each location to PostgreSQL: 10K writes/second of a tiny row. That's not impossible, but it's 86 GB/day of data whose useful life is **three seconds**, and it puts that write load on the same primary that must never fail to accept an order. You have coupled your revenue path to your telemetry path, and telemetry is 800× bigger. The first busy Friday, checkout gets slow because drivers are driving.

**The three-way split:**

| Path | Destination | Purpose | Durability |
|------|-------------|---------|------------|
| **Hot** | Redis geo-index (`GEOADD`) | The *only* thing matching reads. Sub-ms `GEORADIUS` | ❌ Volatile — and that's fine |
| **Stream** | Kafka topic, partitioned by driver | Durable tail for analytics, ETA model training, dispute resolution ("was the driver actually there?") | ✅ Durable, replayable |
| **Cold** | PostgreSQL `drivers.current_lat/lng`, written **at most every N seconds**, not every update | Last-known location for recovery and admin views | ✅ Durable, low frequency |

The critical realization: **matching only ever reads the geo-index.** So the geo-index is the only part that needs to be fast, and it's the only part that's allowed to be volatile — because location data has a **three-second shelf life anyway.**

> "Redis losing the geo-index sounds catastrophic — every driver appears offline. But look at what recovery actually costs: every online driver sends a location update within three seconds, so the index self-heals in one update cycle. The data was going to be replaced in three seconds regardless. I'm not choosing to store location durably in Redis; I'm choosing to store it in the one place where *volatility is free* because the data expires faster than any recovery process. Compare that to the idempotency keys, which I deliberately put in PostgreSQL despite Redis being faster — because *those* losing data means a customer gets charged twice. The rule isn't 'Redis for speed, Postgres for safety.' It's: **match the durability of the store to the lifetime of the data.** Location lives 3 seconds. An idempotency key must outlive a retry storm."

**Why not PostGIS?** PostGIS is excellent and it's ~5–10ms per query versus sub-millisecond for Redis. That sounds like a small difference until you put it on the matching critical path during a dinner rush, where every second of match latency is a customer watching a spinner. But the deeper reason is the *write* path: PostGIS means the geo-index and the order tables are the same database, so the 10K/sec location firehose is now competing for the same buffer cache, WAL, and connection pool as order placement. The isolation is the point, more than the speed.

**Fan-out to trackers.** A location update publishes to a Redis Pub/Sub channel for that order. WebSocket gateways subscribe on behalf of connected customers. Two disciplines:

- **Conflate.** A price and a position are both *state*, not events — the newest strictly supersedes the older. If a customer's connection is slow, we drop queued positions and send only the latest. Nobody needs to see where the driver *was* two seconds ago.
- **But order status changes are events**, and they are never conflated. "Picked up" followed by "delivered" are two facts. They go through a durable per-order Redis Stream with a bounded length, so a customer whose phone reconnects after a tunnel replays exactly what they missed rather than silently skipping a state.

That distinction — state versus events, sharing one transport with opposite delivery guarantees — shows up three times in this design, and it's the single most useful lens for reasoning about any real-time system.

## 🔧 Deep Dive 3: Exactly-Once in a World That Can't Be Rolled Back

Two races matter, and they fail in opposite directions.

**Race 1: duplicate orders.** The customer taps "Place Order," the network hangs, the app retries. Without protection, that's two orders and two charges. The client generates an idempotency key; the server records it in PostgreSQL *before* doing the work:

1. Insert the key with status `pending`. The primary-key constraint means a concurrent duplicate fails immediately.
2. If the key already exists and is `completed`, return the cached response — byte for byte, including the original order ID.
3. If it exists and is `pending`, return 409: a request is in flight and we will not race it.
4. Do the work; store the response; mark `completed`.
5. On failure, mark `failed` so a legitimate retry can proceed.

**Race 2: double assignment.** Two drivers somehow accept the same order — because we retried an offer, or a client replayed a stale request. The guard is a conditional update: set `driver_id` and status `driver_assigned` **only where `driver_id IS NULL`**. Zero rows updated means someone else won, and the second driver is told immediately and re-queued for another offer. The database row is the lock; no application-level coordination is needed or trustworthy.

**The failure that has no clean answer: the driver accepted and we didn't hear it.** The driver taps Accept, the row updates, and the response is lost in a parking garage. Their app shows "no order." Ours shows them assigned.

There is no transaction that fixes this, because the two systems are a database and a human being in a car. So:

- The **driver's app polls its own state** on reconnect rather than assuming its last known state is correct. The server is the truth, always.
- Assignment carries a **liveness lease**: if an assigned driver sends no location update for N minutes, the order is automatically returned to the matching pool and re-offered. That covers the dead phone, the driver who quit for the day, and the driver who accepted by accident.
- Reassignment is **idempotent and audited** — the `driver_offers` table records every offer and every outcome, so "why did two drivers show up" has an answer at 2am.

> "The general principle: in a system with a physical world in it, you cannot make the world atomic — so make the *record* atomic and give the world a way to reconcile against it. Every irreversible physical action (drive to a restaurant, hand over food) must be preceded by a state transition that the database has already committed and that the actor's device has *confirmed reading*. The state machine isn't bookkeeping; it's the only thing standing between us and two drivers at one taco truck."

## 🔎 Request Flow: One Order, End to End

Worth tracing once, because it shows which steps are on the critical path and which are deliberately pushed off it.

```
 POST /orders  (X-Idempotency-Key)
      │
      ▼
 ┌────────────────────────────┐
 │ 1. Insert idempotency key  │  PostgreSQL. PK constraint = the guard.
 │    (status=pending)        │  Duplicate tap dies right here.
 └─────────────┬──────────────┘
               ▼
 ┌────────────────────────────┐
 │ 2. Validate + price order  │  Items snapshotted (name, price)
 │ 3. Authorize payment       │  External. Circuit-breakered.
 │ 4. INSERT order (pending)  │  ← the durable commit. From this
 └─────────────┬──────────────┘    moment the order cannot be lost.
               ▼
 ┌────────────────────────────┐
 │ 5. Emit order.created      │  Kafka. Merchant notified.
 │    → respond 201 to client │  ← the customer is DONE waiting.
 └─────────────┬──────────────┘
               │  everything below is asynchronous
               ▼
 ┌────────────────────────────┐
 │ 6. Merchant confirms       │  status → confirmed, prep starts
 └─────────────┬──────────────┘
               ▼
 ┌────────────────────────────┐
 │ 7. Matching triggers at    │  ← scheduled, not immediate:
 │    confirmed + (prep −     │    aims the driver's arrival at
 │    travel) minutes         │    the moment the food is ready
 │    GEORADIUS → score →     │
 │    offer to best driver    │
 └─────────────┬──────────────┘
               ▼
 ┌────────────────────────────┐
 │ 8. Driver accepts          │  UPDATE … WHERE driver_id IS NULL
 │    → driver_assigned       │  The row is the lock.
 └─────────────┬──────────────┘
               ▼
   picked_up → in_transit → delivered
   (each a conditional update; each an event on the
    order's replayable stream so a reconnecting phone
    never misses a state)
```

The key observation: **the customer's request returns at step 5.** Matching, which is the slowest and least reliable part of the system, happens entirely after the 201. If matching takes two minutes, the customer sees "finding your driver" — not a hanging request. Putting matching inside the order POST would mean the 99.99% availability target for order placement is now bounded by the availability of the geo-index, the driver fleet, and a human being deciding whether they feel like working. That's the single most important line in the architecture.

## 🧭 Consistency Model

| Data | Guarantee | Why |
|------|-----------|-----|
| Orders and state transitions | Strong, ACID, conditional updates | Money and irreversible physical actions |
| Driver assignment | Strong, single-writer via conditional update | Two drivers at one restaurant is not recoverable |
| Idempotency keys | **Durable** (PostgreSQL) | Losing one means double-charging a customer |
| Driver locations | Eventual, ≤ 3s stale, lossy | The data expires faster than any repair |
| Order status push | At-least-once via a replayable stream | A missed "delivered" leaves a customer staring at a map forever |
| Ratings | Eventual, async | Nobody is harmed if a star lands a second late |
| Driver `acceptance_rate` | Eventual, recomputed from `driver_offers` | It's a derived statistic, not a fact |

## 🛠️ Failure Handling

| Failure | Behavior | Rationale |
|---------|----------|-----------|
| **Redis down** | Geo-index gone → matching **pauses**; orders queue in `confirmed`. Sessions fall back to PostgreSQL. Existing deliveries continue | Pausing matching is bad. Matching *blindly* — assigning drivers we can't locate — is worse |
| **PostgreSQL down** | New orders rejected with 503. Active order tracking continues from Redis | We will not accept an order we cannot durably record. A rejected order is a lost sale; a forgotten order is a lost customer |
| **Kafka down** | Locations still flow to Redis; matching and tracking unaffected. Analytics and the ETA model lag; events buffer | Kafka is the durable *tail*, not the hot path. This is the whole reason it's a separate path |
| **Matching service circuit opens** | Orders hold in `confirmed`, admin alerted, customers told "finding a driver" honestly | Queuing is recoverable. A wrong assignment isn't |
| **WebSocket drops** | Client reconnects with backoff; missed order events replayed from the bounded Redis Stream | Locations are re-sent within 3s and don't need replay. Status events do |
| **Driver goes dark mid-delivery** | Liveness lease expires → order re-enters matching; customer notified | The one failure the customer feels most, and the one most likely to be a dead battery |

The rule: **degrade matching before you degrade orders, and degrade tracking before you degrade either.** Accepting an order you can't fulfill yet is fine — you can always find a driver later. Losing an order is not.

## 🔐 Security and Abuse

- **Session tokens in Redis, not JWTs.** A compromised *driver* account can accept and steal real orders — real food, real money. "Their token expires in 15 minutes" is not an acceptable answer; we need to kill a session in one operation.
- **Role-based authorization on every endpoint.** A customer hitting the driver location endpoint should be a 403, not an interesting bug. In a marketplace, the three roles have genuinely adversarial incentives.
- **Rate limits tiered by cost and by abuse potential.** Order creation is limited per-user (card testing, and simple mistakes). Location updates are limited per-driver at a rate slightly above the expected 1-per-3-seconds — enough headroom for retries, tight enough that a compromised driver account can't flood the geo-index.
- **Location spoofing is the interesting attack.** A driver reporting a fake position near a busy merchant gets more offers. The defense isn't cryptographic; it's statistical — flag physically implausible movement (a 400 km/h "bicycle"), and cross-check reported positions against the actual delivery timeline.

## 📊 Observability

| Signal | What it tells me |
|--------|------------------|
| **Time-to-match histogram** | The core SLO. p99 is what matters, because the tail is where the sequential-offer trade-off hurts |
| Offers per match | The health of the scoring function. Climbing means we're offering to drivers who don't want the work |
| **Offer rejection rate, by driver and by zone** | A zone with a high rejection rate has a *supply* problem, and no amount of backend tuning fixes it — that's a pricing signal, surfaced as a metric |
| Location ingest rate vs. drivers-online | These should track each other exactly. A gap means driver apps are failing to report and the geo-index is quietly going stale |
| Geo-index size vs. `drivers.status='available'` count | Detects Redis/Postgres divergence — the thing that makes matching silently offer to drivers who went home |
| **ETA error distribution** (predicted vs. actual) | The trust metric. It's also the training signal for ever replacing Haversine with something real |
| Orders stuck in a state > threshold | The catch-all for every failure above. Any order sitting in `confirmed` for 10 minutes is a human problem now |

## 📈 Scalability: What Breaks First

1. **The Redis geo-index, on writes.** 10K/sec on a single instance is fine; 10× that isn't. The fix is *free*, and it's the nicest property in this whole system: **shard by metro area.** Drivers do not deliver from San Francisco to Chicago. Each metro gets its own Redis instance, its own geo-index, and its own matching leader — with **zero cross-shard queries**, because the physical world already partitioned the data for us. Most sharding decisions are agonizing; this one is handed to you by geography.

2. **WebSocket connections** for tracking. Horizontal gateways, with Redis Pub/Sub distributing messages so any gateway can serve any customer. The load is bursty in exactly the same way orders are — everyone tracks at dinner time.

3. **PostgreSQL order writes.** 35/sec at peak is genuinely small; this is *not* the bottleneck people expect it to be. The table that grows is `orders` (365 GB/year), so partition by month and archive completed orders to object storage after 30 days. `driver_location_history` is far bigger and gets 7-day retention, because nobody needs last month's GPS trace at 3-second resolution.

4. **The matching leader per metro.** Matching for a metro must be single-writer to keep the offer protocol coherent. That's a vertical ceiling per metro — but a metro is a bounded amount of demand, and if one metro outgrows one process, you split it into zones. The physical world keeps handing us shard keys.

5. **ETA quality**, which isn't a throughput problem at all but is the first thing to actually *fail the user*. Haversine distance ignores roads, traffic, one-way streets, and the fifteen minutes it takes to park in a dense downtown. It is systematically optimistic in exactly the places where orders are densest. The upgrade path is a routing engine, then a learned model trained on the Kafka location history — which is the payoff of having built that durable stream on day one for reasons that looked like over-engineering at the time.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geo-index | ✅ Redis `GEOADD`/`GEORADIUS` | ❌ PostGIS | Sub-ms on the match path, and it isolates a 10K/sec firehose from the order database |
| Location durability | ✅ Volatile in Redis + durable tail in Kafka | ❌ Persist every point to Postgres | 86 GB/day of data with a 3-second lifetime; the index self-heals in one update cycle |
| Matching | ✅ Sequential offers with a lease | ❌ Broadcast to all nearby | Broadcast creates a 50× thundering herd and a race it then has to resolve |
| Matching (future) | ⚠️ Greedy now, batched global assignment later | ❌ Solver on day one | Batching is better for the fleet but costs latency and complexity; build it when the idle-time metric proves it |
| Idempotency store | ✅ PostgreSQL | ❌ Redis | A lost key means a double charge. Match durability to consequence |
| Driver assignment | ✅ Conditional update (`WHERE driver_id IS NULL`) | ❌ App-level locking | The row *is* the lock. Nothing else is trustworthy under retry |
| Order items | ✅ Denormalized name + price | ❌ FK to `menu_items` | An order is a contract about a past moment; it must not re-price itself |
| Real-time transport | ✅ WebSocket + Redis Pub/Sub | ❌ Polling | 10K trackers polling every second is 600K req/min for data that changes every 3s |
| Location delivery | ✅ Conflated (drop stale) | ❌ Buffer everything | Position is state; the newest supersedes |
| Status delivery | ✅ At-least-once via replayable stream | ❌ Conflated like locations | "Picked up" and "delivered" are two facts; losing one strands the customer |
| Auth | ✅ Redis sessions | ❌ JWT | A compromised driver account steals real food; revocation must be instant |
| Sharding | ✅ By metro | ❌ By hash | Geography already partitioned the data; there are no cross-metro queries |

## 🚀 Closing: What I'd Build Next

Three things, in the order the business would feel them.

**A real ETA.** Haversine is a placeholder wearing a lab coat. Every customer-trust metric and a large fraction of support volume traces back to a wrong ETA, and we're currently telling people a straight-line distance divided by a guess. The Kafka location stream already contains the ground truth — actual routes, actual times, actual parking hell — so the path is: routing engine first, learned model second.

**Batching and multi-stop.** Greedy one-order-one-driver leaves margin on the table. Two orders going to the same block should ride together. That's the batched-assignment problem I deferred in Deep Dive 1, and it's worth revisiting the moment the fleet-idle metric justifies it.

**Supply, which is not a backend problem and is the real one.** Every hard number in this design — 30-second matches, 30K concurrent drivers — assumes enough drivers exist near enough merchants at dinner time. When they don't, no scoring function saves you; the offer rejection rate climbs, the match time blows out, and the correct response is *pricing*, not engineering. I'd want the metrics to make that distinction loudly, so nobody spends a quarter optimizing a matcher when what they needed was a surge multiplier. Knowing which of your problems your system can't solve is part of designing it.
