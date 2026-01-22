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

```
Request Flow:
├─▶ Check Redis for key: idempotency:{userId}:{requestKey}
├─▶ HIT?  → Return cached response immediately
├─▶ MISS? → Acquire lock (SET ... NX EX 60)
├─▶ Process request
├─▶ Cache response (TTL: 24 hours)
└─▶ Return response
```

---

## 7️⃣ Data Model Design (5 minutes)

### 📐 Key Tables

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| **users** | id, email, type (rider/driver), rating | User account |
| **drivers** | user_id, vehicle_type, is_available, is_online | Driver status |
| **rides** | id, rider_id, driver_id, status, version | Ride with optimistic lock |
| **rides** | pickup_lat/lng, dropoff_lat/lng | Location data |
| **rides** | estimated_fare, final_fare, surge_multiplier | Pricing data |

### 📇 Index Strategy

```
Rides Table Indexes:
├── PRIMARY KEY (id)
├── BTREE (rider_id, requested_at DESC)    ← Rider history
├── BTREE (driver_id, requested_at DESC)   ← Driver history
├── PARTIAL (status) WHERE status NOT IN ('completed', 'cancelled')  ← Active rides
└── BTREE (requested_at DESC)              ← Recent ride queries

Drivers Table Indexes:
├── PRIMARY KEY (user_id)
└── PARTIAL (is_available, is_online) WHERE is_available = true  ← Available drivers
```

### 🔴 Redis Data Structures

```
Geospatial (Sorted Set with geohash):
├─▶ drivers:available:{vehicleType}  →  GeoSet of driver locations

Driver Metadata (Hash):
├─▶ driver:location:{id}  →  { lat, lng, timestamp, heading }

Surge Data (String with TTL):
├─▶ surge:{geohash}  →  "1.5"  (TTL: 120s)

Idempotency Cache (String with TTL):
└─▶ idempotency:{userId}:{key}  →  { status, body }  (TTL: 86400s)
```

---

## 8️⃣ Surge Pricing (4 minutes)

### 📊 Zone-Based Calculation

```
┌─────────────────────────────────────────────────────────────┐
│                  Surge Pricing Logic                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Using 5-character geohash (~5km × 5km cells):              │
│                                                              │
│  1. Get zone: geohash.encode(lat, lng, precision=5)         │
│                                                              │
│  2. Calculate supply/demand ratio:                           │
│     ratio = available_drivers / (pending_requests + 1)       │
│                                                              │
│  3. Map ratio to multiplier:                                 │
│     ┌───────────────────┬─────────────┐                     │
│     │ Supply/Demand     │ Multiplier  │                     │
│     ├───────────────────┼─────────────┤                     │
│     │ > 2.0             │ 1.0x        │                     │
│     │ 1.5 - 2.0         │ 1.1x        │                     │
│     │ 1.0 - 1.5         │ 1.2x        │                     │
│     │ 0.75 - 1.0        │ 1.5x        │                     │
│     │ 0.5 - 0.75        │ 1.8x        │                     │
│     │ < 0.5             │ 2.0-2.5x    │                     │
│     └───────────────────┴─────────────┘                     │
│                                                              │
│  4. Cache result (TTL: 2 minutes)                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 💵 Fare Calculation

```
Base Fare Components:
├─▶ Base fee (varies by vehicle type)
├─▶ Per-km rate × distance
├─▶ Per-minute rate × duration
└─▶ Multiply total by surge multiplier

Example (Economy):
├─▶ Base: $2.00
├─▶ Distance: 5km × $0.80 = $4.00
├─▶ Duration: 15min × $0.15 = $2.25
├─▶ Subtotal: $8.25
├─▶ Surge: 1.5x
└─▶ Final: $12.38
```

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

### 📊 Graceful Degradation Matrix

```
┌─────────────────────────────────────────────────────────────┐
│                  Failure → Mitigation                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Redis Cluster Down:                                         │
│  └─▶ Fall back to PostgreSQL geo queries (10x slower)       │
│                                                              │
│  Payment Gateway Timeout:                                    │
│  └─▶ Mark payment "pending", queue for retry, allow rider   │
│      to exit vehicle                                         │
│                                                              │
│  WebSocket Servers Down:                                     │
│  └─▶ Clients automatically fall back to HTTP polling        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

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
