# 🛵 Local Delivery (DoorDash / Instacart) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Two numbers shape this system. Couriers send about ten thousand location pings a second, and customers place about thirty-five orders a second at the dinner peak. The pings are a firehose of data that is stale three seconds later; the orders are a trickle of data that must never be lost, duplicated, or handed to two couriers. So I'm going to build two very different paths — a volatile, Redis-only path for locations and a transactional path for orders — and spend most of my time on the moment they meet: assigning exactly one courier to each order."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the 300:1 ping-to-order ratio |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives where, and the contract |
| Deep dive 1: one courier per order | 8 min | Sequential offers, the atomic claim, the state machine |
| Deep dive 2: the location firehose | 7 min | A geo index that only returns couriers who are really there |
| Deep dive 3: matching that survives crashes | 5 min | Leases, sweepers and `SKIP LOCKED` |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Delivery can mean restaurant food, groceries or packages. I'll design for restaurant-style orders from one merchant, delivered by one courier, because that is where timing is tightest."

### Functional requirements

1. **Order**: customers browse nearby merchants, build a cart from one merchant, see the server's price, and place an order.
2. **Dispatch**: the platform offers the order to nearby couriers, one at a time, until one accepts.
3. **Deliver**: couriers go online, receive offers with a countdown, accept or decline, and mark pickup and delivery.
4. **Track**: customers see status changes, the courier's position and an ETA, live.
5. **Cancel and rate**: customers cancel before preparation starts; afterwards they rate the courier and the merchant.

Out of scope: payments (an authorization would sit before dispatch), batching several orders onto one courier, surge pricing, and the merchant tablet app.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Order placement | 99.99% available, p99 < 300 ms | The revenue moment; must not depend on courier supply |
| Time to assign | p50 < 30 s, p99 < 2 min | Food is cooking while we search |
| Location freshness | ≤ 3 s old on the customer's map | Slower than that and the dot looks broken |
| Assignment | Exactly one courier; never for a cancelled order | Two couriers at one restaurant cannot be rolled back |
| Retries | Zero duplicate orders | A double charge is a refund and a support ticket |
| ETA | Within 3 minutes for 90% of orders | The trust metric |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Orders | 1M/day → ~12/s average, ~35/s at peak | One PostgreSQL primary is plenty |
| Online couriers | 100K drivers, ~30% online → 30K | Sizes the geo index and the socket fleet |
| Location pings | 30K ÷ 3 s → ~10K writes/s | Never on the order database's write path |
| Every ping stored | ~100 B × 10K/s ≈ 86 GB/day | Sample one in three, stream to cold storage |
| Live trackers | ~50K at peak, an update every 3 s | ~17K pushes/s across gateway nodes |
| Geo index | 30K members × ~100 B ≈ 3 MB per region | One small Redis per metro |
| Offers | ~1.5 per order → ~50/s at peak | Durable offer rows are cheap |

"The ratio is the whole story: pings outnumber orders about 300 to 1, but a lost ping costs nothing and a lost or double-assigned order costs a customer. Those two facts justify two completely different data paths."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys: placing an order, dispatching it, and tracking it."

```
  ┌──────────────────────────┐                          ┌────────────────────────────┐
  │ Customer app             │                          │ Courier app                │
  │ cart · order tracking    │                          │ offers · GPS every 3 s     │
  └───┬──────────────────────┘                          └───────────────────┬────────┘
      │                  ▲                                  ▲               │
      │ (1) POST /orders │ WSS: status,                     │ WSS: offers   │ (3) POST /location
      │ Idempotency-Key  │ location, ETA                    │               │ POST …/accept
      ▼                  ▼                                  ▼               ▼
  ┌───────────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · session auth · rate limits · routes /api/* and /ws                  │
  └────────┬───────────────────────┬───────────────────────────────────────────────┬──────────┘
           │                       │                       ▲                       │
           │ /orders               │ /offers               │ /ws                   │ /location
           ▼                       ▼                       ▼                       ▼
  ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
  │ Order Service     │   │ Dispatch Service  │   │ Tracking Gateway  │   │ Location Service  │
  │ pricing · states  │   │ matching · offers │   │ WebSocket fan-out │   │ ping ingest       │
  └────────┬──────────┘   └───┬───────────┬───┘   └───────────┬───────┘   └───┬─────────┬─────┘
           │                  │           │                   ▲               │         │
           │ INSERT order,    │ offer,    │ (2) GEOSEARCH     │ SUBSCRIBE     │ GEOADD  │
           │ key, lease       │ claim     │                   │               │ PUBLISH │
           ▼                  ▼           ▼                   │               │         │ sample
  ┌────────────────────────────────┐    ┌─────────────────────┴──────┐        │         │
  │ PostgreSQL · source of truth   │    │ Redis · one per metro      │◀───────┘         │
  │ orders, offers, couriers, keys │    │ geo, last-seen, pub/sub    │                  │
  └────────────────────────────────┘    └────────────────────────────┘                  │
                                                                                        ▼
                                                                          ┌────────────────────┐
                                                                          │ Kafka · locations  │
                                                                          │ → history, ETA ML  │
                                                                          └────────────────────┘
```

1. **Place (1).** The customer app posts the cart with an idempotency key. The Order Service prices it from the menu and, in one PostgreSQL transaction, writes the order, its items, the idempotency record and a dispatch lease. It returns `201` immediately; matching happens afterwards.
2. **Dispatch (2).** The Dispatch Service instance holding the order's lease queries the metro's Redis geo index for couriers who pinged recently, scores them, and writes a 30-second offer for the best one. The gateway pushes the offer to the courier's socket. Accepting is one transaction that claims the offer and the order together.
3. **Track (3).** Couriers post their position every 3 seconds. The Location Service writes Redis — geo index, last-seen time, and a publish on the courier's channel — and samples a fraction to Kafka. Gateway nodes subscribed to that channel push the position and an ETA to the customer.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer / API gateway | TLS, session auth, rate limits, routing | Connections | Any gateway node can serve any socket |
| Order Service | Pricing, creation, transitions, cancellation | Orders (~35/s) | Stateless; outbox for order events |
| Dispatch Service | Matching loop, offers, claim, lease sweeper | Unassigned orders | Partitioned by metro |
| Location Service | Ping ingest | Couriers (~10K/s) | Stateless; Redis-only hot path |
| Tracking Gateway | WebSocket fan-out, ETA | Open sockets | One Redis subscriber per node |
| PostgreSQL | Orders, offers, couriers, idempotency keys | Orders | Source of truth; monthly partitions |
| Redis (per metro) | Geo index, last-seen, pub/sub, sessions | Couriers per metro | Volatile on purpose |
| Kafka | Sampled locations, order events | Pings | History, ETA training, notifications |

"Why separate location ingest from orders when they share couriers? Because their profiles are opposite. Location ingest is 300 times the traffic, tolerates loss, and must never slow checkout. If pings landed in the order database, a busy Friday would make checkout slow because couriers are driving. Separating them lets each path scale and fail on its own."

### Flow 1: placing an order

```
Customer app                         Order Service                         PostgreSQL   Dispatch
      │                                    │                                    │           │
      │ 1 POST /orders, Idempotency-Key K  │                                    │           │
      │───────────────────────────────────▶│                                    │           │
      │                                    │ 2 BEGIN; INSERT key K ON CONFLICT  │           │
      │                                    │───────────────────────────────────▶│           │
      │                                    │ 3 1 row = new (0 = replay)         │           │
      │                                    │◀───────────────────────────────────│           │
      │                                    │ 4 INSERT order, items, lease       │           │
      │                                    │───────────────────────────────────▶│           │
      │                                    │ 5 store 201 under K; COMMIT        │           │
      │                                    │───────────────────────────────────▶│           │
      │ 6 201 {status: pending, v1}        │                                    │           │
      │◀───────────────────────────────────│                                    │           │
      ···································· after COMMIT ·····································
      │                                    │ 7 order.created (outbox)                       │
      │                                    │───────────────────────────────────────────────▶│
      │                                    │                                    │           │
```

"The client generates one idempotency key per checkout attempt and reuses it for every retry. Step 2 claims the key with an insert; if a retry arrives while the first request is still running, its insert waits on the unique index, then finds the stored `201` and returns it. The same key from another user, or with a different cart, gets `422` and learns nothing about the original request. Because the key, the order, its items and the lease commit in one transaction, a crash anywhere before `COMMIT` leaves no trace and the retry simply runs. Prices come from the menu table in integer cents; the request carries item ids and quantities, never amounts."

### Flow 2: dispatching an order

```
Dispatch Service                              Redis   PostgreSQL    Courier app
        │                                       │          │             │
        │ 1 renew lease WHERE owner = me                   │             │
        │─────────────────────────────────────────────────▶│             │
        │ 2 GEOSEARCH 5 km + ZMSCORE last_seen  │          │             │
        │──────────────────────────────────────▶│          │             │
        │ 3 fresh couriers, nearest first       │          │             │
        │◀──────────────────────────────────────│          │             │
        │ 4 score; skip already offered         │          │             │
        │ 5 INSERT offer, expires in 30 s                  │             │
        │─────────────────────────────────────────────────▶│             │
        │ 6 push offer (via gateway)                                     │
        │───────────────────────────────────────────────────────────────▶│
        │ 7 POST /offers/{id}/accept                                     │
        │◀───────────────────────────────────────────────────────────────│
        │ 8 one tx: offer, order, courier                  │             │
        │─────────────────────────────────────────────────▶│             │
        │ 9 200 order | 409 taken                                        │
        │───────────────────────────────────────────────────────────────▶│
        │                                       │          │             │
```

"Step 1 renews the dispatch lease; I'll come back to why in deep dive 3. Step 2 asks Redis for the nearest couriers and their last ping time in two commands, and drops anyone silent for more than 30 seconds. Step 4 scores the rest and skips couriers who already saw this order, read from the offers table rather than from memory. Step 5 is protected by unique indexes: one live offer per order and one per courier. Step 8 is the heart of the system and deep dive 1."

### Flow 3: from a courier's phone to the customer's map

```
 Courier          Location Svc                   Redis                Gateway             Customer
    │                   │                          │                     │                    │
    │ 1 POST /location  │                          │                     │                    │
    │──────────────────▶│                          │                     │                    │
    │                   │ 2 GEOADD, ZADD, PUBLISH  │                     │                    │
    │                   │─────────────────────────▶│                     │                    │
    │                   │ 3 SET gate NX PX 10s     │                     │                    │
    │                   │─────────────────────────▶│                     │                    │
    │                   │                          │ 4 location message  │                    │
    │                   │                          │────────────────────▶│                    │
    │                   │                          │                     │ 5 stage-aware ETA  │
    │                   │                          │                     │ 6 lat, lng, eta    │
    │                   │                          │                     │───────────────────▶│
    ·································· customer reconnects ····································
    │                   │                          │                     │ 7 subscribe_order  │
    │                   │                          │                     │◀───────────────────│
    │                   │                          │                     │ 8 snapshot v4      │
    │                   │                          │                     │───────────────────▶│
    │                   │                          │                     │                    │
```

"Step 2 is one Redis pipeline and the only write on the hot path. Step 3 is a `SET NX` with a 10-second expiry: the first ping in each window wins it and is also sent to Kafka, so durable storage sees one ping in three. The gateway holds one Redis subscriber per node and a map from channel to local sockets, so Redis connections scale with nodes, not with customers. Pub/sub keeps no history, so a reconnecting client resubscribes and gets a fresh snapshot of the order (steps 7–8)."

---

## 💾 Data Model (4 min)

"PostgreSQL holds everything that must be correct; Redis holds what is true for the next few seconds."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `orders` | `id`, `customer_id`, `merchant_id`, `driver_id`, `status`, `version`, amounts in cents, `dispatch_owner`, `dispatch_lease_until`, timestamps per state | Partial index on `created_at` where unassigned (the sweeper's scan); `(customer_id, created_at)`; partitioned by month |
| PostgreSQL | `order_items` | `order_id`, `menu_item_id`, `name`, `quantity`, `unit_price_cents` | Name and price are copied: tomorrow's menu change must not rewrite today's receipt |
| PostgreSQL | `driver_offers` | `id`, `order_id`, `driver_id`, `status`, `expires_at`, `responded_at` | Unique where pending on `order_id`; unique where pending on `driver_id`; unique where accepted on `order_id` |
| PostgreSQL | `drivers` | `id`, `status` (offline/available/busy), `rating`, `acceptance_rate`, sampled last position | `status` is the courier's intent; liveness lives in Redis |
| PostgreSQL | `idempotency_keys` | `key`, `user_id`, `operation`, `request_hash`, `response`, `expires_at` | Same transaction as the order; 24 h retention |
| Redis | `drivers:locations` | GEO set of courier ids | One per metro; `GEOSEARCH` by radius |
| Redis | `drivers:last_seen` | Sorted set, score = ping time | Search ignores > 30 s; prune removes > 2 min |
| Redis | channels | `driver:{id}:location`, `driver:{id}:offers`, `order:{id}:status` | Fan-out to gateway nodes |

Two decisions worth defending:

**The idempotency key lives in PostgreSQL, not Redis.** Everywhere else Redis would be my first choice for short-lived keys. Here, a key that commits separately from the order can disagree with it: written but the order never created, so the retry is blocked; or the order created and the key lost, so the retry creates a second order. In one transaction they cannot disagree.

**`version` on the order.** Every transition increments it, and every status event and snapshot carries it. Clients keep the copy with the higher version, which makes duplicated, delayed or reordered events harmless.

---

## 🔌 API Design (3 min)

```
POST /api/v1/orders/quote                price a cart → subtotal, delivery fee, tip, total
POST /api/v1/orders                      Idempotency-Key → 201 | 409 in flight | 422 reused or invalid
GET  /api/v1/orders/{id}                 snapshot with version (customer, assigned courier, admin)
POST /api/v1/orders/{id}/cancel          → 200 | 409 too late
POST /api/v1/driver/location             {lat, lng} every 3 s; heartbeat every 10 s when parked
GET  /api/v1/driver/offers/pending       live offer + expires_in_seconds (recovery after reconnect)
POST /api/v1/driver/offers/{id}/accept   the claim → 200 order | 409 offer or order unavailable
POST /api/v1/driver/orders/{id}/picked-up | in-transit | delivered   → 200 | 403 | 409
WSS  /ws                                 subscribe_order → snapshot, status, location; offers for couriers
```

- **Errors carry stable codes** (`INVALID_TRANSITION`, `ORDER_UNAVAILABLE`, `IDEMPOTENCY_KEY_REUSED`), so apps branch on the code.
- **Every courier action is safe to retry.** A second "picked up" returns `409` with the current state instead of re-stamping the time — the common cause is a phone retrying in a parking garage.
- **Quote and create share one pricing function**, so the total on the button is the total charged.
- **Status events are absolute and versioned** (`{status: picked_up, version: 4}`), never deltas.

---

## 🔧 Deep Dive 1: Exactly One Courier per Order (8 min)

"The failure I'm designing against is two couriers driving to one restaurant, or a courier driving to collect an order the customer cancelled. Neither can be fixed with a rollback once the car is moving."

### The decision: sequential offers, then an atomic claim

I offer the order to one courier at a time with an exclusive 30-second window. Accepting is a single transaction of three compare-and-set updates:

1. The offer moves `pending → accepted` only if it is still pending, unexpired, and belongs to this courier.
2. The order moves to `driver_assigned` with this courier's id only if `driver_id` is still empty and the status is still one of the pre-pickup statuses.
3. The courier moves to `busy` only if still online.

If any update matches zero rows, the whole transaction rolls back, the offer is withdrawn, and the courier sees `409 Order is no longer available`. Three partial unique indexes back this up in the database itself: one pending offer per order, one pending offer per courier, one accepted offer per order. The pending offer row doubles as a lease on the courier's attention — while it lives, no other order can offer to them.

**Why it works.** The customer's cancel is also a compare-and-set on the same order row (`WHERE status IN ('pending','confirmed')`), and it expires the live offer in the same transaction. PostgreSQL serializes the two updates on that row, so exactly one wins: either the order is cancelled and the accept fails, or the courier owns it and the cancel gets `409`. There is no window in which both succeed.

**Why the alternatives fail.**

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Broadcast to all nearby | Everyone gets the offer; first accept wins | 50 couriers race for one row; 49 lose; the fastest thumb wins, not the best match |
| ❌ Read, check, write | `SELECT status`, then `UPDATE` if allowed | Two requests both read `pending`; both write; the order is cancelled *and* assigned |
| ❌ Application lock (Redis `SETNX`) | Lock the order id around the update | A lock that expires mid-write or a process that dies leaves state the database never agreed to |
| ✅ Sequential offer + claim transaction | Compare-and-set updates + unique indexes | Slower tail: five declines take 2.5 minutes |

**What I give up.** Tail latency. Five couriers ignoring their 30-second windows is two and a half minutes, beyond my p99. I shorten the window after a decline and score acceptance rate into the ranking, so couriers who ignore offers rank lower. I accept the trade because a slow match is recoverable — the customer sees "finding your courier" — and a double assignment is not.

### The edge case everybody misses: the last-instant accept

When the 30-second window closes, the matcher expires the offer with `UPDATE … SET status = 'expired' WHERE id = $1 AND status = 'pending'`. If that matches nothing, the courier accepted between the matcher's last poll and the deadline, and their acceptance stands. A matcher that simply assumed "time is up, so it expired" would offer the order to a second courier who could also accept it. The compare-and-set turns that race into a clean answer.

### Every status change is guarded

```
  pending ──▶ confirmed ──▶ preparing ──▶ ready_for_pickup
     │            │             │                 │
     └────────────┴──────┬──────┴─────────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
     cancelled                    driver_assigned ──▶ picked_up ──▶ in_transit ──▶ delivered
```

Each arrow is one `UPDATE … WHERE id = $1 AND status = ANY($allowed) [AND driver_id = $me] RETURNING *` that also bumps `version`. Zero rows means the move is illegal right now, and the service reads the row once to answer `404`, `403` or `409`. The table lives in one place, so a new transition is a one-line change instead of a new `if` in some route.

---

## 🔧 Deep Dive 2: The Location Firehose (7 min)

"Ten thousand writes a second of data that is stale in three seconds. Where it goes decides whether checkout stays fast and whether matching tells the truth."

### The decision: a Redis geo index per metro, plus a liveness set

Each ping is one Redis pipeline: `GEOADD` to the metro's geo set, `ZADD` the ping time to a last-seen sorted set, and `PUBLISH` to the courier's channel. Matching runs `GEOSEARCH … BYRADIUS 5 km ASC COUNT 40`, then `ZMSCORE` on the last-seen set for those ids, and drops anyone silent for more than 30 seconds. A Lua script prunes members older than two minutes from both sets.

**Why liveness needs its own set.** A geo set's score is a geohash, so it cannot say when a member last moved. Without the second set, a courier whose phone died stays in the index at their last position forever, and every order near them waits 30 seconds for an offer nobody will see. Because browsers and phones only report position on movement, the courier app also sends a heartbeat ping every 10 seconds when parked; 30 seconds is three missed heartbeats.

**Why Redis and not PostGIS.** A PostGIS radius query is a few milliseconds — fine on its own. The problem is the write side: 10K updates a second into the order database would share its write-ahead log, buffer cache and connection pool with order placement. Isolation matters more than query speed.

**Why volatility is acceptable.** Lose Redis and every courier vanishes — for one heartbeat. Every online courier pings within 3 to 10 seconds, so the index rebuilds itself before any repair job could run. The rule is not "Redis for speed, PostgreSQL for safety"; it is *match the durability of the store to the lifetime of the data*. A position lives 3 seconds. An idempotency key must outlive a retry storm.

| Option | Verdict |
|--------|---------|
| ✅ Redis geo set + last-seen set, one per metro | Sub-millisecond search, 10K writes/s off the order database, self-healing |
| ❌ PostGIS in the order database | Couples the location firehose to checkout |
| ❌ Write every ping durably | ~86 GB/day of data with a 3-second shelf life |
| ⚠️ Geohash buckets in Cassandra | Durable and scalable, but needs custom neighbor-cell queries; overkill when Redis already shards by metro |

### Durable history without durable writes per ping

Analytics, disputes ("was the courier really at the door?") and ETA training need history, but not every ping. A `SET driver:{id}:persist_gate NX PX 10000` succeeds for the first ping in each 10-second window across all instances, and only that ping goes to Kafka. That's one durable event in three at the 3-second cadence, with no coordination between Location Service instances.

**What I give up.** Durability of live positions and precision of history. If Redis fails, matching pauses for a few seconds and the last 10 seconds of a courier's trail are missing from history. For a dispute, a point every 10 seconds is enough.

---

## 🔧 Deep Dive 3: Matching That Survives Crashes (5 min)

"The matching loop is long-lived work: up to five offers of 30 seconds each. If it lives only in one process's memory, a deploy or a crash silently strands every order that process was matching."

### The decision: a lease on each unassigned order

Two columns on `orders` — `dispatch_owner` and `dispatch_lease_until` — say which instance runs the loop and until when. The owner renews the lease before every offer with `UPDATE … WHERE id = $1 AND dispatch_owner = $me AND driver_id IS NULL`. Zero rows means the order was assigned, cancelled, or taken over, and the loop stops. Every Dispatch instance runs a sweeper every 5 seconds:

1. Select up to 10 unassigned orders whose lease is missing or expired, oldest first, `FOR UPDATE SKIP LOCKED`.
2. Set this instance as owner with a 45-second lease, in the same statement.
3. Start the matching loop for each.

`SKIP LOCKED` lets concurrent sweepers pass over rows another sweeper is claiming instead of waiting on them or claiming them twice. The loop's memory — which couriers already saw this order — comes from `driver_offers`, so a loop resumed on another instance does not re-offer to someone who declined. When nobody is nearby, the loop releases the lease with a 10-second delay instead of sleeping, and the circuit breaker's fallback does the same with 30 seconds: that is the retry queue, with no queue to run.

| Approach | Verdict |
|----------|---------|
| ✅ Lease columns + `SKIP LOCKED` sweeper | Resumes in seconds; reuses the database we already trust |
| ❌ In-memory loop only | A crash or deploy strands orders forever |
| ⚠️ Queue with visibility timeout | Works, but the order row and the message can disagree; needs an outbox to stay consistent |
| ⚠️ Workflow engine (Temporal) | Durable timers and retries for free; a large dependency for one loop |

**Why it's safe even when the lease lies.** A slow instance can lose its lease while it is mid-offer, and a second instance can start. The lease is for liveness only. The unique index on pending offers stops the second instance from creating a parallel offer, and the claim transaction decides the winner if the first offer is accepted. Correctness never depends on the lease being exclusive.

**What I give up.** One extra `UPDATE` per offer, a sweep query every 5 seconds per instance, and up to 45 seconds of delay before a crashed owner's orders resume. A graceful shutdown releases its leases first, so deploys don't pay that delay.

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first, in order:** the matching *policy*, not throughput — greedy per-order matching wastes courier time at peak, so batched assignment over a 30–60 second window is the first big upgrade; then one metro's Redis on writes, which splits into zones; then gateway connections, which scale horizontally; and finally the `orders` table's size (~1 GB/day), handled by monthly partitions and archiving after 30 days.

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Dispatch instance crashes | Orders pause ≤ 45 s | Lease expiry + sweeper on another instance |
| Metro Redis down | "Finding your courier" lasts longer; map freezes | Matching pauses (never assigns blindly); index rebuilds from pings in seconds |
| PostgreSQL primary down | Can't order or accept | `503` with retry; replica promotion; positions keep streaming |
| Courier's phone dies | Courier stops getting offers | Dropped from search after 30 s, pruned after 2 min |
| Customer cancels during an offer | Courier sees "order no longer available" | One compare-and-set wins |
| Lost response on checkout | Retry returns the same order | Idempotency key in the same transaction |

**Shard key for free.** Couriers do not deliver across metros, so each metro gets its own geo index and dispatch partition with zero cross-shard queries. Most sharding decisions are agonizing; geography hands us this one.

**What I'd watch:** time-to-assign p50/p99 per metro, offers per assignment and the accept/decline/expire mix, orders unassigned longer than 5 minutes, sweeper takeovers (a crashing instance), pings per second against couriers online (apps failing to report), WebSocket reconnect rate, and ETA error — the trust metric.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Courier index | Redis geo + last-seen, per metro | PostGIS in the order database | Keeps the firehose off checkout; filters ghosts |
| Offer protocol | Sequential, 30 s window | Broadcast | No herd; best courier gets first refusal |
| One courier per order | Claim transaction + unique indexes | Read-check-write or app locks | The database enforces it on every path |
| Matching ownership | Lease + `SKIP LOCKED` sweeper | In-memory loop | Survives crashes and deploys |
| Status changes | Guarded `UPDATE`, versioned | Unconditional `UPDATE` | Retries get `409`; clients ignore stale events |
| Idempotency | Key in the order's transaction | Key in Redis | Key and order cannot disagree |
| Location history | 1-in-3 sample to Kafka | Every ping to a database | 86 GB/day of three-second data otherwise |
| Placement | Returns on commit | Waits for a courier | Availability independent of supply |

"With more time I'd schedule dispatch at confirmation plus prep time minus travel time, so couriers arrive as the food does; add reassignment when an assigned courier goes silent; move to batched assignment once courier idle time justifies it; and replace straight-line ETAs with a routing engine and a model trained on the location history."
