# DoorDash - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## Opening Statement

"Today I'll design the backend systems for a food delivery platform like DoorDash, focusing on real-time driver location tracking, order-driver matching algorithms, multi-factor ETA calculation, and event-driven order state management. The core backend challenges are handling 10K location updates per second with sub-100ms latency, building an optimal matching system with multi-factor scoring, and maintaining a consistent order state machine across a three-sided marketplace."

---

## Step 1: Requirements Clarification (3 minutes)

### Backend-Specific Requirements

1. **Location Ingestion**: Process 10K driver location updates per second
2. **Geo Queries**: Find nearby drivers within radius with sub-ms latency
3. **Matching Engine**: Score and assign drivers to orders in real-time
4. **State Machine**: Manage order lifecycle with strong consistency
5. **Event Streaming**: Publish status changes for real-time client updates

### Scale Estimates

| Metric | Estimate | Backend Implication |
|--------|----------|---------------------|
| Daily Orders | 1M | ~12 orders/sec sustained, 100/sec peak |
| Concurrent Drivers | 100K | 10K location updates/sec (10s interval) |
| Active Orders | 50K | In-memory state for matching |
| Location Queries/Sec | 1K | Redis geo operations |
| Kafka Events/Sec | 5K | Order + location events |

---

## Step 2: High-Level Backend Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              API Gateway                                      │
│                    Rate limiting, auth, request routing                       │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
│   Order Service   │   │ Location Service  │   │  Match Service    │
│                   │   │                   │   │                   │
│  - CRUD orders    │   │  - GPS ingest     │   │  - Scoring        │
│  - State machine  │   │  - Geo queries    │   │  - Assignment     │
│  - Idempotency    │   │  - ETA calc       │   │  - Batching       │
└─────────┬─────────┘   └─────────┬─────────┘   └─────────┬─────────┘
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │
┌─────────────────────────────────┼────────────────────────────────────────────┐
│                            Data Layer                                         │
├──────────────────┬──────────────┴──────────────┬─────────────────────────────┤
│   PostgreSQL     │          Valkey             │          Kafka              │
│                  │                             │                             │
│   - Orders       │   - Locations (geo)         │   - Order events            │
│   - Menus        │   - Sessions                │   - Location updates        │
│   - Users        │   - Geo index               │   - Dispatch events         │
│   - Audit        │   - Cache                   │                             │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘
```

### Why This Architecture?

**Valkey for Location**: "Driver locations update every 10 seconds. We need sub-millisecond reads for matching and geo queries. Valkey's GEOADD/GEORADIUS/GEOSEARCH commands are optimized for spatial queries."

**Kafka for Events**: "Order status changes need to reach multiple consumers (customer notifications, restaurant dashboard, analytics). Kafka provides reliable pub/sub with ordering guarantees and replay capability."

**Separate Match Service**: "Matching algorithm is computationally intensive. Isolating it allows independent scaling during peak hours."

---

## Step 3: Database Schema Design (5 minutes)

### Core Tables

**restaurants**: Stores restaurant info with PostGIS location
- id, name, address, location (GEOGRAPHY POINT), cuisine_type, rating
- prep_time_minutes (default 20), is_open
- Index: GIST on location, partial index on is_open=TRUE

**menu_items**: Menu with restaurant foreign key
- id, restaurant_id (CASCADE), name, description, price, category
- is_available flag for stock management
- Index: on restaurant_id

**drivers**: Driver profiles linked to users
- id, user_id (FK), vehicle_type, is_active, rating, total_deliveries
- Index: on is_active status

**orders**: Core order table with JSONB delivery address
- id, customer_id, restaurant_id, driver_id
- status (PLACED, CONFIRMED, PREPARING, READY, PICKED_UP, DELIVERED)
- total, delivery_fee, delivery_address (JSONB)
- Timestamps: placed_at, confirmed_at, preparing_at, ready_at, picked_up_at, delivered_at
- version (optimistic locking)
- Indexes: on customer_id, driver_id, status, (restaurant_id, status)

**order_items**: Junction table for order line items
- id, order_id (CASCADE), menu_item_id, quantity, unit_price, special_instructions

**driver_locations**: Partitioned by time for history
- driver_id, location (GEOGRAPHY), recorded_at
- Partition by RANGE on recorded_at

**audit_logs**: For order disputes and debugging
- event_type, entity_type, entity_id, actor_type, actor_id
- changes (JSONB), metadata (JSONB), created_at
- Indexes: on (entity_type, entity_id), on created_at

### Why PostgreSQL + PostGIS for History?

"PostGIS handles complex spatial queries for historical analysis (driver routes, delivery patterns). For real-time queries, we use Valkey geo commands which are 10-100x faster."

---

## Step 4: Real-Time Driver Location System (10 minutes)

### Valkey Geo Commands for Location Storage

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Driver Location Update Flow                             │
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │  Driver App  │───▶│   Location   │───▶│    Valkey    │                   │
│  │  (GPS 10s)   │    │   Service    │    │  Geo Index   │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│                             │                    │                           │
│                             │                    │                           │
│                    ┌────────┴────────┐          │                           │
│                    │    Pipeline     │          │                           │
│                    │                 │          │                           │
│                    │ 1. GEOADD       │          │                           │
│                    │ 2. HSET meta    │          │                           │
│                    │ 3. EXPIRE 30s   │          ▼                           │
│                    │ 4. PUBLISH      │    ┌──────────────┐                  │
│                    └─────────────────┘    │   Pub/Sub    │──▶ Real-time     │
│                             │             │   Channel    │   tracking       │
│                             │             └──────────────┘                  │
│                             │                                                │
│                             ▼                                                │
│                    ┌─────────────────┐                                      │
│                    │   PostgreSQL    │  (async, non-blocking)               │
│                    │   History       │                                      │
│                    └─────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Update Pipeline (4 operations batched):**
1. GEOADD driver_locations: Store in geo index for spatial queries
2. HSET driver:{id}: Store metadata (lat, lon, updated_at, status)
3. EXPIRE driver:{id} 30: Auto-expire if driver stops sending updates
4. PUBLISH driver_locations: Broadcast for real-time tracking

**Async History Write:**
- Use setImmediate to avoid blocking main request
- INSERT into driver_locations partition table
- Non-critical path - can tolerate occasional failures

### Finding Nearby Available Drivers

**Two-step query:**
1. **GEOSEARCH** driver_locations FROMLONLAT, BYRADIUS 5km, WITHDIST, ASC, COUNT 20
2. **Filter** by availability: HGETALL driver:{id} to check status=active AND order_count < 2

Output: Array of { id, distance, lat, lon, activeOrders }

### Why Valkey Instead of PostgreSQL PostGIS?

| Aspect | Valkey | PostGIS |
|--------|--------|---------|
| Write latency | Sub-ms | 5-10ms |
| Updates/sec capacity | 100K+ | 10K |
| Geo query speed | Sub-ms | 10-50ms |
| Persistence | Optional | Always |
| Memory usage | Higher | Lower |

"For 10K location updates per second with sub-100ms query requirements, Valkey is the right choice. We use PostGIS for historical analysis only."

---

## Step 5: Order-Driver Matching Algorithm (10 minutes)

### Multi-Factor Scoring

"The matching algorithm scores each candidate driver by combining seven weighted factors. Distance dominates because minimizing pickup time directly reduces delivery ETA."

| Factor | Weight | Scoring Logic |
|--------|--------|---------------|
| Distance to restaurant | 40% | max(0, 100 - distance_km * 10) — closer is better |
| Current order load | 25% | -15 per active order — prefer idle drivers |
| Driver rating | 15% | rating * 5 (5 stars = +25 pts) |
| Experience bonus | 10% | min(total_deliveries / 10, 20) — capped at 20 |
| Earnings fairness | 10% | +10 if below daily earnings goal |
| Route efficiency | Bonus | +route_efficiency * 20 if driver has current orders |
| Timing alignment | Penalty | -20 if driver arrives before food is ready |

### Assignment Flow with Circuit Breaker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Order Assignment Flow                                    │
│                                                                              │
│   ┌──────────────┐                                                          │
│   │ New Order    │                                                          │
│   └──────┬───────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                    Circuit Breaker                                    │  │
│   │                                                                       │  │
│   │   Timeout: 10 seconds                                                 │  │
│   │   Error threshold: 50%                                                │  │
│   │   Reset timeout: 30 seconds                                           │  │
│   │   Fallback: { matched: false, queued: true }                          │  │
│   └───────────────────────────────┬──────────────────────────────────────┘  │
│                                   │                                          │
│                                   ▼                                          │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  1. Find nearby drivers (5km radius)                                  │  │
│   │     - If none found, expand to 10km                                   │  │
│   │     - If still none, return { matched: false, queued: true }          │  │
│   └───────────────────────────────┬──────────────────────────────────────┘  │
│                                   │                                          │
│                                   ▼                                          │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  2. Score each driver with multi-factor algorithm                     │  │
│   │     - Sort by score descending                                        │  │
│   └───────────────────────────────┬──────────────────────────────────────┘  │
│                                   │                                          │
│                                   ▼                                          │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  3. Offer to top driver (30s timeout)                                 │  │
│   │                                                                       │  │
│   │     ┌─────────────┐    Accept    ┌─────────────┐                     │  │
│   │     │  Driver 1   │─────────────▶│  Assigned!  │                     │  │
│   │     └──────┬──────┘              └─────────────┘                     │  │
│   │            │ Reject/Timeout                                           │  │
│   │            ▼                                                          │  │
│   │     ┌─────────────┐    Accept    ┌─────────────┐                     │  │
│   │     │  Driver 2   │─────────────▶│  Assigned!  │                     │  │
│   │     └──────┬──────┘              └─────────────┘                     │  │
│   │            │ Reject/Timeout                                           │  │
│   │            ▼                                                          │  │
│   │          ...continue...                                               │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Order Batching Logic

"Batching is only worthwhile when the efficiency gain outweighs the delay cost. We gate it with strict criteria: driver has exactly 1 active order, new restaurant within 500m, combined route >= 70% efficient, and additional delay <= 5 minutes to the first customer. Max 2 orders per batch."

---

## Step 6: Multi-Factor ETA Calculation (5 minutes)

**Four factors combine into the ETA:**

| Factor | Calculation |
|--------|-------------|
| Time to restaurant | Route time from driver location to restaurant |
| Prep time remaining | totalPrepTime - elapsedSinceConfirmed (min 0) |
| Delivery time | Route time from restaurant to customer |
| Fixed buffers | 3 min pickup + 2 min dropoff |

**Key insight:** Driver travel and food prep happen in PARALLEL.

```
waitTime = max(timeToRestaurant, prepTimeRemaining)
totalETA = waitTime + deliveryTime + pickupBuffer + dropoffBuffer
```

### Route Time with Traffic Multipliers

**Traffic Multiplier Schedule:**
- Rush hours (7-9 AM, 5-7 PM): 1.5x
- Lunch rush (11 AM - 1 PM): 1.3x
- Normal hours: 1.0x

**Caching Strategy:**
- Cache key: `route:{origin.lat},{origin.lon}:{dest.lat},{dest.lon}`
- TTL: 5 minutes
- Call external routing API (Google Maps, OSRM) on cache miss
- Apply traffic multiplier to base duration

---

## Step 7: Order State Machine (5 minutes)

### State Transitions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Order State Machine                                  │
│                                                                              │
│   ┌──────────┐  restaurant_confirm   ┌──────────────┐                       │
│   │  PLACED  │──────────────────────▶│  CONFIRMED   │                       │
│   └────┬─────┘                       └──────┬───────┘                       │
│        │                                    │                                │
│        │ customer_cancel                    │ restaurant_start_prep          │
│        ▼                                    ▼                                │
│   ┌──────────┐                       ┌──────────────┐                       │
│   │ CANCELLED│                       │  PREPARING   │                       │
│   └──────────┘                       └──────┬───────┘                       │
│                                             │                                │
│                                             │ restaurant_ready               │
│                                             ▼                                │
│                                      ┌──────────────────┐                   │
│                                      │ READY_FOR_PICKUP │                   │
│                                      └──────────┬───────┘                   │
│                                                 │                            │
│                                                 │ driver_pickup              │
│                                                 ▼                            │
│                                      ┌──────────────┐                       │
│                                      │  PICKED_UP   │                       │
│                                      └──────┬───────┘                       │
│                                             │                                │
│                                             │ driver_deliver                 │
│                                             ▼                                │
│                                      ┌──────────────┐  auto_complete         │
│                                      │  DELIVERED   │─────────────────────▶ │
│                                      └──────────────┘                       │
│                                                           ┌──────────────┐  │
│                                                           │  COMPLETED   │  │
│                                                           └──────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Transition with Optimistic Locking

**Transition Logic:**
1. Validate action is allowed for current status
2. Get next status based on action
3. UPDATE with version check (optimistic lock)
4. If rowCount === 0, throw ConflictError (concurrent modification)
5. Emit Kafka event for real-time updates
6. Write audit log with actor and metadata
7. Trigger side effects based on new status

**Side Effects by Status:**
- CONFIRMED: Queue for driver matching (1s delay)
- READY_FOR_PICKUP: Notify assigned driver
- PICKED_UP: Notify customer with live tracking link
- DELIVERED: Capture payment, schedule review request (30 min delay)

---

## Step 8: Caching Strategy (3 minutes)

### Cache Strategy by Data Type

| Data | Strategy | TTL | Invalidation |
|------|----------|-----|--------------|
| Restaurant details | Cache-aside | 5 min | Explicit purge on update |
| Menu items | Cache-aside | 5 min | Purge on menu edit |
| Driver locations | Write-through | 30s auto-expire | Overwrite on update |
| Order status | No cache | N/A | Real-time via WebSocket |
| Route calculations | Cache-aside | 5 min | Time-based expiry |
| Nearby restaurants | Cache-aside (geo cell) | 2 min | Background refresh |

"Cache-aside for restaurants: check `cache:restaurant_full:{id}` first, on miss query PostgreSQL and populate with 5-min TTL. Invalidate on any menu update by deleting the key — next read repopulates."

---

## Step 9: Idempotency and Consistency (2 minutes)

### Order Creation with Idempotency Key

"Every order creation requires an X-Idempotency-Key header. This prevents duplicate orders from network retries — critical for a payment-bearing operation."

**Flow:**
1. Require X-Idempotency-Key header (400 if missing)
2. Check Redis for `idempotency:order:{key}` — if found, return cached response
3. BEGIN transaction: INSERT order + order_items, COMMIT
4. Cache response in Redis with 24h TTL: `{ statusCode: 201, body: order }`
5. On error: ROLLBACK, throw — client safely retries with same key

---

## Step 10: Observability (2 minutes)

**Key Prometheus Metrics:**

| Metric | Type | Purpose |
|--------|------|---------|
| http_request_duration_seconds | Histogram | Request latency by route/method/status |
| orders_total | Counter | Order creation and state transitions |
| driver_match_duration_seconds | Histogram | Matching algorithm latency |
| geo_query_duration_seconds | Histogram | Valkey GEOSEARCH latency |
| drivers_active | Gauge | Real-time count of online drivers |

**Structured logging** via Pino in JSON format — every business event (order_placed, driver_matched) includes order ID, timestamps, and actor for debugging and audit.

---

## Closing Summary

"I've designed the backend for a food delivery platform with these core systems:

1. **Real-Time Location Tracking**: Valkey geo commands (GEOADD, GEOSEARCH) for storing and querying 10K driver location updates per second with sub-ms latency

2. **Order-Driver Matching**: Multi-factor scoring algorithm considering distance, driver load, ratings, experience, and route efficiency with circuit breaker protection

3. **ETA Calculation**: Parallel computation of prep time and driver travel, with traffic multipliers and 5-minute route caching

4. **Order State Machine**: Event-driven status flow with optimistic locking, Kafka publishing for real-time client updates, and comprehensive audit logging

5. **Caching Strategy**: Cache-aside for read-heavy data (menus), write-through for location data, with explicit invalidation on updates"

**Key Backend Trade-offs:**

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Location storage | Valkey | PostGIS | Speed over durability for ephemeral data |
| Matching algorithm | Score-based | Auction | Simplicity and speed over maximum optimization |
| ETA calculation | Multi-factor formula | ML model | Interpretability and debuggability |
| Event streaming | Kafka | Direct push | Decoupling, replay capability, multiple consumers |
