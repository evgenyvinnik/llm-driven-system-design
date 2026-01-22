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

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Nearby Driver Query Flow                              │
│                                                                              │
│   Input: Restaurant coordinates, radius (default 5km)                        │
│                                                                              │
│   ┌───────────────────────────────────────────────────────────────────────┐ │
│   │  Step 1: GEOSEARCH driver_locations                                    │ │
│   │                                                                        │ │
│   │  - FROMMEMBER or FROMLONLAT                                           │ │
│   │  - BYRADIUS {km} km                                                    │ │
│   │  - WITHDIST (include distance in results)                              │ │
│   │  - ASC (sort by distance, closest first)                               │ │
│   │  - COUNT 20 (limit for performance)                                    │ │
│   └────────────────────────────────────────────────────────────────────────┘ │
│                                   │                                          │
│                                   ▼                                          │
│   ┌────────────────────────────────────────────────────────────────────────┐ │
│   │  Step 2: Filter by availability                                        │ │
│   │                                                                        │ │
│   │  For each driver_id:                                                   │ │
│   │    - HGETALL driver:{id}  (get metadata)                               │ │
│   │    - GET driver:{id}:order_count  (current orders)                     │ │
│   │    - Filter: status === 'active' AND order_count < 2                   │ │
│   └────────────────────────────────────────────────────────────────────────┘ │
│                                   │                                          │
│                                   ▼                                          │
│   Output: Array of { id, distance, lat, lon, activeOrders }                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

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

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Match Score Calculation                              │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 1: Distance to Restaurant (40% weight)                       │   │
│   │                                                                      │   │
│   │  Score = max(0, 100 - (distance_km * 10))                           │   │
│   │  Closer drivers score higher                                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 2: Current Order Load (25% weight)                           │   │
│   │                                                                      │   │
│   │  Score = -15 per active order                                        │   │
│   │  Prefer drivers with fewer current orders                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 3: Driver Rating (15% weight)                                │   │
│   │                                                                      │   │
│   │  Score = rating * 5  (5 stars = +25 points)                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 4: Experience Bonus (10% weight)                             │   │
│   │                                                                      │   │
│   │  Score = min(total_deliveries / 10, 20)                              │   │
│   │  Capped at 20 points for experienced drivers                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 5: Earnings Goal Fairness (10% weight)                       │   │
│   │                                                                      │   │
│   │  +10 if daily_deliveries < earnings_goal                             │   │
│   │  Prioritize drivers who need more deliveries                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 6: Route Efficiency for Batching                             │   │
│   │                                                                      │   │
│   │  If driver has current orders:                                       │   │
│   │  Score += route_efficiency * 20                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 7: Timing Alignment                                          │   │
│   │                                                                      │   │
│   │  -20 penalty if estimated_arrival > prep_time_remaining              │   │
│   │  Avoid drivers who arrive before food is ready                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

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

**Batch Eligibility Criteria:**
- Driver must already have an active order
- Max 2 orders per batch
- Restaurant proximity: within 500m of current order's restaurant
- Route efficiency: combined route must be >= 70% efficient
- Additional delay: <= 5 minutes to first customer

**Batch Validation Flow:**
1. Check if driver has current orders (1, not 0, not 2+)
2. Calculate restaurant distance using haversine formula
3. If > 500m, reject batch opportunity
4. Calculate combined route efficiency
5. If < 70%, reject batch opportunity
6. Calculate additional delay to first customer
7. If > 5 minutes, reject batch opportunity
8. Return batch details with savings calculation

---

## Step 6: Multi-Factor ETA Calculation (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ETA Calculation Components                            │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 1: Time to Restaurant                                        │   │
│   │                                                                      │   │
│   │  If driver assigned and not yet at restaurant:                       │   │
│   │  getRouteTime(driver.location, restaurant.location)                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 2: Food Preparation Time Remaining                           │   │
│   │                                                                      │   │
│   │  If status is CONFIRMED or PREPARING:                                │   │
│   │  remaining = totalPrepTime - elapsedSinceConfirmed                   │   │
│   │  Minimum of 0 (food might already be ready)                          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 3: Time from Restaurant to Customer                          │   │
│   │                                                                      │   │
│   │  getRouteTime(restaurant.location, order.deliveryAddress)            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Factor 4: Fixed Buffers                                             │   │
│   │                                                                      │   │
│   │  Pickup buffer: 3 minutes (parking, entering, getting food)          │   │
│   │  Dropoff buffer: 2 minutes (parking, handoff, confirmation)          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Total Calculation:                                                  │   │
│   │                                                                      │   │
│   │  waitTime = max(timeToRestaurant, prepTimeRemaining)                 │   │
│   │  totalMs = waitTime + deliveryTime + pickupBuffer + dropoffBuffer    │   │
│   │                                                                      │   │
│   │  Key insight: Driver travel and food prep happen in PARALLEL         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
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

### Cache-Aside Implementation

**Read Pattern:**
1. Try cache first with key `cache:restaurant_full:{id}`
2. If cache hit, parse JSON and return
3. If cache miss, query PostgreSQL for restaurant + menu items
4. Combine into single object
5. Store in cache with SETEX (5 min TTL)
6. Return result

**Invalidation Pattern:**
- On any UPDATE to menu_items for a restaurant:
- DEL `cache:restaurant_full:{restaurantId}`
- Next read will repopulate cache

---

## Step 9: Idempotency and Consistency (2 minutes)

### Order Creation with Idempotency Key

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Idempotent Order Creation                               │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  1. Check X-Idempotency-Key header                                    │  │
│   │     - If missing, return 400 error                                    │  │
│   └───────────────────────────────────┬──────────────────────────────────┘  │
│                                       │                                      │
│                                       ▼                                      │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  2. Check Redis for existing key: idempotency:order:{key}             │  │
│   │     - If found, return cached response (statusCode + body)            │  │
│   └───────────────────────────────────┬──────────────────────────────────┘  │
│                                       │                                      │
│                                       ▼                                      │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  3. BEGIN PostgreSQL transaction                                      │  │
│   │     - INSERT order                                                    │  │
│   │     - INSERT all order_items                                          │  │
│   │     - COMMIT                                                          │  │
│   └───────────────────────────────────┬──────────────────────────────────┘  │
│                                       │                                      │
│                                       ▼                                      │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  4. Cache response in Redis (24 hour TTL)                             │  │
│   │     - Key: idempotency:order:{key}                                    │  │
│   │     - Value: { statusCode: 201, body: order }                         │  │
│   └───────────────────────────────────┬──────────────────────────────────┘  │
│                                       │                                      │
│                                       ▼                                      │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  5. Return 201 with order                                             │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   On any error: ROLLBACK transaction, throw error                           │
│   Client can safely retry with same idempotency key                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 10: Observability (2 minutes)

### Prometheus Metrics

**HTTP Request Latency (Histogram):**
- Name: http_request_duration_seconds
- Labels: method, route, status_code
- Buckets: 10ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s

**Order Counters:**
- Name: orders_total
- Labels: status
- Tracks order creation and state transitions

**Driver Matching Latency (Histogram):**
- Name: driver_match_duration_seconds
- Buckets: 100ms, 500ms, 1s, 2s, 5s, 10s, 30s

**Geo Query Latency (Histogram):**
- Name: geo_query_duration_seconds
- Buckets: 1ms, 5ms, 10ms, 25ms, 50ms, 100ms

**Active Drivers Gauge:**
- Name: drivers_active
- Real-time count of online drivers

### Structured Logging with Pino

**Logger Configuration:**
- Level: from LOG_LEVEL env or 'info'
- Base fields: service name, version
- JSON format for log aggregation

**Business Event Logging:**
- Event type (order_placed, driver_matched, etc.)
- Order ID, timestamps
- Relevant details for debugging

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
