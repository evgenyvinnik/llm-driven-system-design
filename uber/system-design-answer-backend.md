# 🚗 Uber - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 🎯 Problem Statement

Design the backend infrastructure for a ride-hailing platform that:
- Matches riders with nearby available drivers in real-time
- Tracks driver locations at massive scale (millions of updates/second)
- Calculates dynamic surge pricing based on supply/demand
- Ensures exactly-once payment processing

---

## 1️⃣ Requirements Clarification (5 minutes)

### ✅ Functional Requirements

| # | Requirement | Description |
|---|-------------|-------------|
| 1 | Location Ingestion | Ingest driver GPS updates at 1.67M updates/sec (5M drivers × 1 update/3 sec) |
| 2 | Real-time Matching | Find nearby available drivers, score by ETA + rating, prevent double-booking |
| 3 | Ride State Machine | Manage lifecycle: requested → matched → arrived → in_progress → completed |
| 4 | Surge Pricing | Calculate supply/demand ratio per geographic zone every 1-2 minutes |
| 5 | Payment Processing | Idempotent capture with circuit breaker for gateway failures |

### ⚡ Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Matching Latency | < 100ms | Real-time user experience |
| Location Throughput | 1.67M/sec | 5M active drivers at peak |
| Ride Consistency | Strong | Financial and safety implications |
| Location Consistency | Eventual (3s stale OK) | Hot path, acceptable delay |
| Availability | 99.99% | Stranded riders unacceptable |

### 📊 Scale Estimates

```
Location Updates:
├─▶ 5M active drivers at peak
├─▶ Update every 3 seconds
└─▶ 5M / 3 = 1.67 million updates/second

Ride Requests:
├─▶ 5M rides per day
├─▶ Peak: 10x average = ~580 rides/second
└─▶ Each triggers: geo query + match + state update

WebSocket Connections:
├─▶ 5M driver connections
├─▶ ~50K connections per server
└─▶ ~100 WebSocket servers needed
```

### 🚫 Out of Scope

- Scheduled rides (advance booking)
- Pool/shared rides
- Driver onboarding and verification
- Detailed routing/navigation

---

## 2️⃣ High-Level Architecture (10 minutes)

### 🏗️ System Overview

```
                                ┌─────────────────────────────────────┐
                                │      🌐 API Gateway / Load Balancer  │
                                │      • Rate limiting                 │
                                │      • Auth validation               │
                                └─────────────────┬───────────────────┘
                                                  │
                  ┌───────────────────────────────┼───────────────────────────────┐
                  │                               │                               │
                  ▼                               ▼                               ▼
          ┌──────────────┐               ┌──────────────┐               ┌──────────────┐
          │ 🚗 Ride       │               │ 📍 Location   │               │ 💰 Pricing    │
          │   Service    │               │   Service    │               │   Service    │
          │              │               │              │               │              │
          │ • Booking    │               │ • Geo index  │               │ • Fare calc  │
          │ • State mgmt │               │ • Nearby     │               │ • Surge      │
          │ • Matching   │               │ • Updates    │               │ • Estimates  │
          └──────┬───────┘               └──────┬───────┘               └──────────────┘
                 │                               │
                 │                               ▼
                 │                       ┌──────────────┐
                 │                       │ 🔴 Redis      │
                 │                       │   Cluster    │
                 │                       │              │
                 │                       │ • GEOADD     │
                 └───────────────────────│ • GEORADIUS  │
                                         │ • Status     │
                                         └──────────────┘
                                                 │
         ┌───────────────────────────────────────┼───────────────────────────────────────┐
         │                                       │                                       │
         ▼                                       ▼                                       ▼
 ┌──────────────┐                       ┌──────────────┐                       ┌──────────────┐
 │ 🐘 PostgreSQL │                       │ 🐰 RabbitMQ  │                       │ 📡 WebSocket  │
 │              │                       │              │                       │   Servers    │
 │ • Users      │                       │ • Matching   │                       │              │
 │ • Rides      │                       │ • Notifs     │                       │ • Push to    │
 │ • Payments   │                       │ • Billing    │                       │   drivers    │
 └──────────────┘                       └──────────────┘                       └──────────────┘
```

### 🔧 Component Responsibilities

| Component | Responsibility | Scaling Strategy |
|-----------|----------------|------------------|
| 📍 Location Service | Geo updates, nearby queries | Shard by geohash prefix |
| 🚗 Ride Service | State machine, matching coordination | Stateless, horizontal |
| 💰 Pricing Service | Fare calculation, surge | Cache-heavy, read replicas |
| 🐰 Matching Workers | Async driver selection | Scale with queue depth |
| 📡 WebSocket Servers | Real-time push | Shard by user ID hash |

---

## 3️⃣ Deep Dive: Geospatial Indexing (10 minutes)

### 📐 Redis Geo Architecture

Redis provides native geospatial commands ideal for driver tracking:

```
Driver Location Updates:
├─▶ GEOADD drivers:available {lng} {lat} {driver_id}
├─▶ Store with geohash as sorted set score
└─▶ TTL on driver metadata for stale removal

Nearby Driver Queries:
├─▶ GEORADIUS drivers:available {lng} {lat} 5 km
├─▶ Options: WITHCOORD, WITHDIST, COUNT 20, ASC
└─▶ O(N+log(M)) where N=results, M=total entries
```

**Internal Structure:**
- Redis Geo uses sorted set with 52-bit geohash as score
- GEORADIUS performs efficient range scan
- Built-in distance calculation in km/m

### 🗂️ Sharding Strategy

With 5M drivers, single Redis cannot handle the load:

```
┌─────────────────────────────────────────────────────────────┐
│                  Geo-Based Sharding                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Shard by 3-character geohash prefix (~156km cells):       │
│                                                              │
│   ┌────────────┐   ┌────────────┐   ┌────────────┐          │
│   │  Shard: 9q  │   │  Shard: dr  │   │  Shard: gc  │         │
│   │  (SF Bay)  │   │  (NYC)     │   │  (Chicago) │          │
│   └────────────┘   └────────────┘   └────────────┘          │
│                                                              │
│   Benefits:                                                  │
│   • City-level traffic isolation                            │
│   • Cross-shard queries rare (drivers don't cross 156km)   │
│   • Consistent hashing for shard assignment                 │
└─────────────────────────────────────────────────────────────┘
```

### 🔍 Query Optimization

**Expanding radius search for sparse areas:**

1️⃣ Start with small radius (1km)
2️⃣ If fewer than 3 drivers found, expand to 2km
3️⃣ Continue expanding: 5km, 10km
4️⃣ Return best candidates or "no drivers" after max radius

This avoids expensive large-radius queries in dense areas.

### 🔄 Alternatives: Geospatial Storage

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Redis Geo** | Sub-ms queries, built-in distance | Memory-bound, limited query types | ✅ Chosen |
| PostGIS | Rich spatial queries, persistent | Slower for high update rate | For analytics |
| Tile38 | Purpose-built geo DB, geofencing | Operational overhead | Future option |
| S2/H3 Libraries | Hierarchical cells, precise | Need custom implementation | For matching v2 |

**Rationale**: Redis Geo provides sub-millisecond queries with 1.67M updates/sec. Memory-bound storage acceptable for active driver locations (hot data only).

---

## 4️⃣ Deep Dive: Matching Algorithm (8 minutes)

### 📊 Driver Scoring Function

Combine multiple signals to rank candidates:

```
Score = (w1 × ETA_score) + (w2 × Rating_score) + (w3 × Acceptance_score)

Where:
├─▶ ETA_score = 1 - (estimated_minutes / 30)  [0-1, lower ETA is better]
├─▶ Rating_score = (rating - 3.0) / 2.0       [0-1, normalized 3-5 range]
├─▶ Acceptance_score = historical_rate        [0-1, from driver history]

Weights: w1=0.5, w2=0.3, w3=0.2 (ETA most important)
```

### 🔄 Matching Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Matching Flow                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1️⃣ Rider requests ride                                                  │
│     │                                                                    │
│     ▼                                                                    │
│  2️⃣ GEORADIUS query for nearby available drivers                        │
│     │                                                                    │
│     ▼                                                                    │
│  3️⃣ Fetch driver metadata (rating, acceptance rate)                     │
│     │                                                                    │
│     ▼                                                                    │
│  4️⃣ Score and rank all candidates                                       │
│     │                                                                    │
│     ▼                                                                    │
│  5️⃣ For each candidate (best first):                                    │
│     ├─▶ Attempt atomic acquire (UPDATE ... WHERE available=true)        │
│     ├─▶ If success: remove from geo index, return match                 │
│     └─▶ If fail: try next candidate                                     │
│     │                                                                    │
│     ▼                                                                    │
│  6️⃣ No match found? → Queue for retry or return "no drivers"            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 🔒 Double-Booking Prevention

**Optimistic locking with atomic update:**

```
┌─────────────────────────────────────────────────────────────┐
│                 Atomic Driver Acquisition                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. BEGIN TRANSACTION                                        │
│                                                              │
│  2. UPDATE drivers                                           │
│     SET is_available = false, current_ride_id = ?           │
│     WHERE user_id = ?                                        │
│       AND is_available = true                                │
│       AND is_online = true                                   │
│     RETURNING *                                              │
│                                                              │
│  3. If rowCount = 0 → ROLLBACK (driver already taken)       │
│                                                              │
│  4. ZREM drivers:available {driver_id}  (remove from geo)   │
│                                                              │
│  5. COMMIT                                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

The `WHERE is_available = true` condition ensures only one ride can acquire a driver.

### 🔄 Alternatives: Matching Strategies

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| **Greedy (first-match)** | Simple, <100ms, easy debug | Suboptimal global assignment | ✅ Default |
| Batch Hungarian | Optimal matching | Adds 2-5s latency | High-demand zones |
| ML-based | Learns complex patterns | Complex training pipeline | Future optimization |

**Rationale**: Greedy matching is fast and good enough for most scenarios. Batch matching can be added for surge periods where global optimization provides 10-15% better ETAs.

---

## 5️⃣ Deep Dive: Queue Architecture (5 minutes)

### 📬 RabbitMQ Topology

```
                              ┌──────────────────┐
                              │   ride.events    │ (fanout exchange)
                              └────────┬─────────┘
             ┌─────────────────────────┼─────────────────────────┐
             ▼                         ▼                         ▼
     ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
     │ notifications │         │   analytics   │         │    billing    │
     │    queue      │         │    queue      │         │    queue      │
     └───────────────┘         └───────────────┘         └───────────────┘
             │                         │                         │
             ▼                         ▼                         ▼
     ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
     │  Push/SMS/    │         │  Event sink   │         │  Payment      │
     │  Email worker │         │  (warehouse)  │         │  processor    │
     └───────────────┘         └───────────────┘         └───────────────┘
```

### 📋 Delivery Semantics by Queue

| Queue | Semantics | Ack Strategy | Retry Policy |
|-------|-----------|--------------|--------------|
| matching.requests | At-least-once | Manual after match | 3 retries, exp backoff |
| notifications | At-least-once | Manual after send | 3 retries, then DLQ |
| analytics | At-most-once | Auto ack | No retries (best effort) |
| billing | At-least-once | Manual after commit | 5 retries, then alert |

### 🚦 Backpressure Handling

```
┌─────────────────────────────────────────────────────────────┐
│                  Backpressure Strategies                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Producer Side:                                              │
│  ├─▶ Check queue depth before enqueue                       │
│  ├─▶ If > 1000 messages: return "high demand" to user       │
│  └─▶ Suggest retry in 30 seconds                            │
│                                                              │
│  Consumer Side:                                              │
│  ├─▶ Prefetch limit = 10 (concurrent processing)            │
│  ├─▶ Memory-based nack: requeue if heap > 400MB            │
│  └─▶ Graceful shutdown: drain queue first                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 6️⃣ Deep Dive: Ride State Machine (5 minutes)

### 📐 State Transitions

```
                      ┌──────────────┐
                      │   requested  │
                      └──────┬───────┘
                             │ match success
                             ▼
      ┌───────────────┬──────────────┬───────────────┐
      │               │              │               │
      ▼               │              │               │
  cancelled           ▼              │               │
  (terminal)    ┌──────────────┐     │               │
                │   matched    │     │               │
                └──────┬───────┘     │               │
                       │ driver      │               │
                       │ arrives     │               │
                       ▼             │               │
                ┌──────────────┐     │               │
                │   arrived    │─────┘ rider cancels │
                └──────┬───────┘                     │
                       │ start ride                  │
                       ▼                             │
                ┌──────────────┐                     │
                │  in_progress │─────────────────────┘
                └──────┬───────┘
                       │ complete
                       ▼
                ┌──────────────┐
                │  completed   │ (terminal)
                └──────────────┘
```

### 🔒 Version-Based Locking

Prevent concurrent state updates with optimistic locking:

```
┌─────────────────────────────────────────────────────────────┐
│                 State Transition Pattern                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  UPDATE rides                                                │
│  SET status = {new_status},                                  │
│      version = version + 1,                                  │
│      updated_at = NOW()                                      │
│  WHERE id = {ride_id}                                        │
│    AND status = {expected_current_status}                    │
│  RETURNING *                                                 │
│                                                              │
│  If rowCount = 0 → Conflict! Status already changed.        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 🔑 Idempotency Keys

Mobile networks cause retries. Without idempotency, riders get charged twice.

A request carrying an idempotency key is looked up under `idempotency:{userId}:{key}`. A hit returns the cached response verbatim; a miss takes a 60-second `SET NX EX` lock, processes the request, caches the response for 24 hours, and returns it.

The lock is the part that is easy to omit and matters most. Caching the response alone protects against a retry that arrives *after* the first request finished — but the retry that actually happens is the one sent while the first is still in flight, because the client gave up waiting. Without the lock, both execute, and "request a ride" becomes two rides.

---

## 7️⃣ Data Model Design (5 minutes)

### 📐 Key Tables

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| **users** | id, email, user_type (rider/driver), rating, rating_count | Account and reputation |
| **drivers** | user_id (PK/FK), vehicle_type, is_online, is_available, current_lat/lng | Driver status and last known position |
| **rides** | id, rider_id, driver_id, status, vehicle_type | Ride identity and lifecycle state |
| **rides** | pickup_lat/lng + address, dropoff_lat/lng + address | Endpoints, kept denormalized on the ride |
| **rides** | estimated_fare_cents, final_fare_cents, surge_multiplier, distance_meters, duration_seconds | Pricing, with the inputs that produced it |
| **rides** | requested_at, matched_at, driver_arrived_at, picked_up_at, completed_at, cancelled_at | One timestamp per lifecycle transition |

The timestamps deserve a note. Storing a column per transition rather than a single `updated_at` means the ride row *is* its own audit log: time-to-match, time-to-pickup, and trip duration are all differences between columns already on the row, with no event table to join. The cost is a wide, mostly-NULL row — a cancelled ride has four NULL timestamps — and a schema change every time a new state is added.

### 📇 Index Strategy

| Index | Serves |
|-------|--------|
| `rides (rider_id, requested_at DESC)` | Rider history, newest first |
| `rides (driver_id, requested_at DESC)` | Driver history and the earnings rollup |
| `rides (status)` partial, WHERE status NOT IN ('completed','cancelled') | Active rides — the small hot set the dispatcher scans |
| `drivers (is_available, is_online)` partial, WHERE is_available | Available-driver lookups that bypass Redis |

The partial indexes are the interesting ones. Almost every ride in the table is eventually terminal, so an index over all statuses would be dominated by rows no query cares about; restricting it to in-flight rides keeps it proportional to concurrent demand rather than to history. The same argument applies to the driver index.

### 🔴 Redis Data Structures

| Key | Type | Purpose |
|-----|------|---------|
| `drivers:available` | GEO (sorted set) | The live driver index — one set for all vehicle types, queried with `GEORADIUS ... WITHDIST COUNT 20 ASC` |
| `driver:location:{id}` | Hash, 60s TTL | Last reported lat/lng and timestamp |
| `driver:status:{id}` | String | Availability, so a driver mid-ride is not offered another |
| `demand:{geohash}` | Counter, 5-min TTL | Requests per ~5km cell; the numerator of the surge ratio |
| `ride:{id}` | Hash | Cached ride state for the status endpoint |

One choice worth defending: a **single** geo set rather than one per vehicle type. Partitioning by vehicle type would make each radius query smaller and let a premium request skip economy drivers entirely. It also multiplies the write path — a driver who serves multiple tiers must be added to and removed from several sets atomically — and it fragments the supply signal that surge depends on, since demand is measured per area, not per tier. With filtering by tier happening after the radius query on at most 20 candidates, the extra work is negligible and the write path stays a single `GEOADD`.

### 🔒 What actually protects the ride lifecycle

This is worth being precise about, because "we use optimistic locking" is easy to say and this system does something narrower.

Only one transition is guarded: accepting an offer runs `UPDATE rides SET driver_id = $1, status = 'matched' WHERE id = $2 AND status = 'requested' RETURNING *`, and treats an empty result as "someone else got there first." That is a **compare-and-swap on the status column** — not a version counter — and status is the right thing to compare, since the invariant being protected is "a ride is matched exactly once." It is the transition that genuinely races: the same offer can be outstanding to a driver whose acceptance crosses with a timeout-driven reoffer to the next candidate.

The later transitions — `driver_arrived`, `picked_up`, `completed` — are unguarded `UPDATE ... WHERE id = $1`. In practice they are driven sequentially by one driver's app, so the race window is small. But unguarded means a duplicate or out-of-order request will happily move a ride backwards, and a retried "complete" will overwrite `final_fare_cents` and `completed_at`. Adding the expected status to each `WHERE` clause costs nothing and makes every transition idempotent; the only reason it is not there is that nobody hit the bug.

---

## 8️⃣ Surge Pricing (4 minutes)

### 📊 Zone-Based Calculation

Surge is computed per ~5km geohash cell (precision 5), on demand, from two numbers:

- **Demand** — each ride request `INCR`s `demand:{geohash}`, a counter with a 5-minute TTL.
- **Supply** — a `GEORADIUS` count of available drivers within 3km of the pickup point.

The ratio `supply / (demand + 1)` maps through a fixed table:

| Supply / demand | Multiplier | Reading |
|-----------------|-----------|---------|
| > 2.0 | 1.0× | Drivers idle; no signal needed |
| 1.5 – 2.0 | 1.1× | Comfortable |
| 1.0 – 1.5 | 1.2× | Tightening |
| 0.75 – 1.0 | 1.5× | More requests than drivers |
| 0.5 – 0.75 | 1.8× | Scarce |
| < 0.5 | 2.0 – 2.5× | Starved |

Two details carry the design. The **TTL is the window** — because the demand counter expires on its own, the system has a rolling five-minute view of demand with no background job to age it out and nothing to reconcile if a worker dies. That is a genuinely nice property: the data structure enforces the time semantics.

And **the `+1` in the denominator** is not defensive coding — it defines behaviour in the case that matters most. With zero demand the ratio would be undefined; with the increment, an empty cell reports maximum supply ratio and therefore no surge, which is the correct answer for an area nobody is requesting rides in.

**Why geohash rather than H3.** Geohash cells are rectangles on a lat/lng grid, so they are not equal-area — cells narrow toward the poles — and, worse, adjacent cells meet along straight boundaries where a rider crossing the street can see a different multiplier. Uber uses H3 hexagons precisely because hexagons have uniform adjacency: every neighbour shares an edge, so interpolation across neighbours is well-defined. The reason to accept geohash here is that Redis speaks it natively — the same encoding backs `GEOADD` — so the surge zone and the driver index share a coordinate system for free. The honest mitigation for the boundary discontinuity is to blend a cell's multiplier with its neighbours', which needs neighbour enumeration that hexagons make trivial and rectangles make fiddly.

### 💵 Fare Calculation

Fare is base fee + (per-km rate × distance) + (per-minute rate × duration), with
the whole subtotal multiplied by surge. An economy ride of 5km over 15 minutes
at 1.5× comes to $12.38 from an $8.25 base.

> "Surge multiplies the *total* rather than only the base fee, because the point
> is to move the whole price signal — a multiplier that only touched a $2 base
> fee wouldn't change anyone's behaviour. The rider sees the multiplier before
> confirming, which matters more than the arithmetic: an opaque surge is
> indistinguishable from a bug."

---

## 9️⃣ Failure Handling (3 minutes)

### 🔄 Circuit Breaker Pattern

| Service | Fallback Strategy |
|---------|-------------------|
| Redis Geo | Query PostgreSQL (slower but works) |
| Payment Gateway | Queue for later, complete ride anyway |
| Routing API | Return cached/estimated ETA |
| WebSocket | Client polls every 5 seconds |
| RabbitMQ | Queue in Redis, process later |

> "The pattern across that table: every dependency failure costs a feature, not
> the ride. Redis going down makes matching slower, not impossible. A payment
> timeout still lets the rider get out of the car — we'd rather chase the money
> asynchronously than hold someone in a vehicle over a gateway blip. The one I'd
> defend hardest is completing the ride on payment failure: the alternative
> couples a physical event we don't control to a network call we don't control,
> and that's a worse failure than a retry queue."

---

## 🔟 Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| 🔴 Redis Geo over PostGIS | Sub-ms latency vs. memory-bound storage |
| 🏃 Greedy over batch matching | Speed (<100ms) vs. global optimization |
| 🐰 RabbitMQ over Kafka | Flexible routing vs. replay capability |
| 📍 Eventual consistency for locations | Throughput vs. 3-second staleness |
| 💳 Strong consistency for payments | Latency vs. financial correctness |
| 🔢 Version-based locking | Optimistic concurrency vs. retry overhead |

---

## 🚀 Future Enhancements

1. 🧠 **ML-Based Matching**: Predict driver acceptance probability
2. 🚗 **Pool/Shared Rides**: Multi-passenger route optimization
3. ⏰ **Scheduled Rides**: Advance booking with driver pre-assignment
4. 🗺️ **Real-time Traffic**: Integration with mapping APIs
5. 📊 **A/B Testing**: Experiment with surge algorithms
6. 🌐 **Multi-Region**: Active-active deployment with geo-routing

---

## ❓ Questions I Would Ask

1. What's the expected peak concurrent drivers? (Affects Redis sharding)
2. Do we need pool/shared rides in MVP?
3. What's the acceptable matching latency? (< 100ms? < 500ms?)
4. Is dynamic pricing required from day one?
5. Any regulatory requirements for ride data retention?
