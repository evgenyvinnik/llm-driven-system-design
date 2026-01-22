# Local Delivery Service - System Design Interview Answer

## Opening Statement

"Today I'll design a local delivery platform like DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking, efficient driver-order matching, route optimization for multi-stop deliveries, and handling the three-sided marketplace dynamics between customers, merchants, and drivers."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Order placement** - Customers order from local merchants
2. **Driver matching** - Match orders to nearby available drivers
3. **Real-time tracking** - Live driver location and ETA updates
4. **Route optimization** - Efficient routing for single and multi-stop deliveries
5. **Notifications** - Order status updates to all parties
6. **Payments** - Customer charges, driver payouts, merchant settlements
7. **Ratings** - Two-way ratings for drivers and customers

### Non-Functional Requirements

- **Latency**: Driver match within 30 seconds, location updates every 3 seconds
- **Scale**: 1M orders/day, 100K concurrent drivers
- **Availability**: 99.99% for order placement
- **Accuracy**: ETA within 3 minutes 90% of the time

### Out of Scope

- Merchant onboarding portal
- Grocery picking optimization
- Autonomous delivery

---

## Step 2: Scale Estimation (2-3 minutes)

**Order volume:**
- 1 million orders per day
- Peak hours (lunch/dinner): 3x average = 35 orders/second
- Average order: $25, 3 items

**Driver fleet:**
- 100,000 active drivers
- 30% online at any time = 30,000 concurrent
- Location updates every 3 seconds = 10,000 updates/second

**Matching:**
- Average 5 drivers considered per order
- 35 orders/second * 5 = 175 driver queries/second

**Storage:**
- Order data: 1M * 5KB = 5GB/day
- Location history: 10K/s * 86400 * 100 bytes = 86 GB/day (hot), archive to cold

**Key insight**: This is a real-time geospatial system. Driver location indexing and matching are the critical paths.

---

## Step 3: High-Level Architecture (10 minutes)

```
                                    ┌─────────────────────────────────┐
                                    │          Client Apps            │
                                    │   (Customer, Driver, Merchant)  │
                                    └───────────────┬─────────────────┘
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                    HTTPS│                     │WebSocket
                                         │                     │
                              ┌──────────▼──────────┐  ┌───────▼───────┐
                              │    API Gateway      │  │  Real-time    │
                              │                     │  │  Gateway      │
                              └──────────┬──────────┘  └───────┬───────┘
                                         │                     │
        ┌────────────────────────────────┼─────────────────────┼────────────────────────────────┐
        │                                │                     │                                │
┌───────▼───────┐            ┌───────────▼───────────┐  ┌──────▼──────┐            ┌───────────▼───────────┐
│ Order Service │            │   Location Service    │  │ Tracking    │            │   Matching Service    │
│               │            │                       │  │ Service     │            │                       │
│ - Create      │            │ - Driver positions    │  │             │            │ - Driver selection    │
│ - Update      │            │ - Geo indexing        │  │ - Pub/Sub   │            │ - Availability        │
│ - History     │            │ - Nearby search       │  │ - ETA       │            │ - Optimization        │
└───────┬───────┘            └───────────┬───────────┘  └─────────────┘            └───────────┬───────────┘
        │                                │                                                      │
        │                    ┌───────────┴───────────┐                                         │
        │                    │                       │                                          │
        │             ┌──────▼──────┐        ┌───────▼──────┐                                  │
        │             │    Redis    │        │  TimeSeries  │                                  │
        │             │  (Geo Index)│        │     DB       │                                  │
        │             └─────────────┘        └──────────────┘                                  │
        │                                                                                       │
        └──────────────────────────────────────────┬────────────────────────────────────────────┘
                                                   │
                                    ┌──────────────▼──────────────┐
                                    │         PostgreSQL          │
                                    │  (Orders, Users, Merchants) │
                                    └──────────────┬──────────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              │                    │                    │
                      ┌───────▼───────┐    ┌───────▼───────┐    ┌──────▼──────┐
                      │    Routing    │    │   Payment     │    │ Notification│
                      │    Service    │    │   Service     │    │   Service   │
                      │               │    │               │    │             │
                      │ - ETA calc    │    │ - Stripe      │    │ - Push      │
                      │ - Route opt   │    │ - Payouts     │    │ - SMS       │
                      └───────────────┘    └───────────────┘    └─────────────┘
```

### Core Components

| Component | Purpose | Key Functions |
|-----------|---------|---------------|
| Order Service | Order lifecycle | Create, update, history, state machine |
| Location Service | Real-time positions | Geo indexing, nearby driver queries |
| Matching Service | Driver assignment | Scoring, availability, optimization |
| Tracking Service | Live updates | WebSocket, Redis Pub/Sub, ETA |
| Routing Service | Route calculation | Map APIs, multi-stop, traffic-aware |

---

## Step 4: Deep Dive - Real-Time Location Tracking (10 minutes)

### Location Update Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Driver App   │────▶│  Location    │────▶│    Redis     │────▶│  Tracking    │
│              │     │  Service     │     │  Geo Index   │     │  Service     │
│ GPS every 3s │     │              │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                                                │                      │
                                                │                      │
                                                ▼                      ▼
                                         ┌──────────────┐     ┌──────────────┐
                                         │  TimeSeries  │     │  Customer    │
                                         │     DB       │     │  App         │
                                         │  (History)   │     │  (WebSocket) │
                                         └──────────────┘     └──────────────┘
```

### Geo-Indexing with Redis

**Store Driver Location**:
- Use GEOADD command: GEOADD 'drivers:locations' lng lat driverId
- Store metadata in hash: lat, lng, updated_at, status
- Publish for real-time: PUBLISH driver:{id}:location JSON

**Find Nearby Drivers**:
- Use GEORADIUS query with distance and limit
- Filter by availability status from driver hash
- Return sorted by distance ascending

### Geohash Partitioning for Scale

```
┌─────────────────────────────────────────────────────────────────┐
│                        Geohash Grid                             │
│                                                                 │
│   ┌───────┬───────┬───────┐                                    │
│   │ 9q8yy │ 9q8yz │ 9q8z0 │  Each cell is a Redis key          │
│   ├───────┼───────┼───────┤                                    │
│   │ 9q8yv │ 9q8yw │ 9q8yx │    drivers:geo:9q8yy               │
│   ├───────┼───────┼───────┤                                    │
│   │ 9q8yq │ 9q8yr │ 9q8ys │                                    │
│   └───────┴───────┴───────┘                                    │
│                                                                 │
│   Query: Find cells that intersect with search radius          │
│   Then: Query each cell's Redis key                            │
└─────────────────────────────────────────────────────────────────┘
```

**Geohash Precision by Radius**:
- radius < 1km: precision 6
- radius < 10km: precision 5
- radius >= 10km: precision 4

**Query Algorithm**:
1. Calculate center geohash at appropriate precision
2. Get 8 neighboring cells
3. Query GEORADIUS on each cell's Redis key
4. Merge and deduplicate results

### Real-Time Streaming to Customers

**WebSocket Per Active Order**:
- Subscribe to Redis channel: driver:{driverId}:location
- On each location message: calculate ETA to destination
- Send combined update: location + eta_seconds
- Clean up subscription on WebSocket close

---

## Step 5: Deep Dive - Driver Matching (8 minutes)

### Matching Considerations

1. **Distance**: Closer drivers for faster pickup
2. **Driver rating**: Higher rated drivers preferred
3. **Current load**: Balance orders across drivers
4. **Order value**: High-value orders to reliable drivers
5. **Driver preferences**: Some prefer certain areas/merchants

### Matching Algorithm

**Scoring Formula**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Driver Matching Score                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Distance Score (weight: 0.4)                                    │
│  ├─ distanceScore = max(0, 1 - (distance / maxRadius))          │
│  ├─ Closer drivers get higher scores                            │
│                                                                  │
│  Rating Score (weight: 0.25)                                     │
│  ├─ ratingScore = driverRating / 5                              │
│  ├─ 5-star drivers score 1.0                                    │
│                                                                  │
│  Acceptance Rate (weight: 0.2)                                   │
│  ├─ acceptanceScore = driver.acceptance_rate                    │
│  ├─ Drivers who accept offers reliably                          │
│                                                                  │
│  Load Balance (weight: 0.15)                                     │
│  ├─ loadScore = max(0, 1 - (current_orders / max_orders))       │
│  ├─ Prefer drivers with fewer active orders                     │
│                                                                  │
│  Total = 0.4*distance + 0.25*rating + 0.2*acceptance + 0.15*load│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Driver Offer Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Customer   │────▶│   Matching   │────▶│   Driver 1   │
│ places order │     │   Service    │     │  (offered)   │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                    │
                            │  30s timeout       │ Accept/Reject
                            │  or reject         │
                            ▼                    │
                     ┌──────────────┐            │
                     │   Driver 2   │◀───────────┘ (if rejected)
                     │  (offered)   │
                     └──────────────┘
```

**Offer Algorithm**:
- Max attempts: 5 drivers
- Offer timeout: 30 seconds per driver
- On rejection/timeout: try next highest-scoring driver
- Track excluded drivers to avoid re-offering
- If all attempts fail: notify customer "no driver available"

### Batching Orders (Multi-Stop)

**Batch Criteria**:
- Orders from same merchant or nearby merchants
- Delivery addresses along similar route
- Time window compatibility (freshness)
- Maximum 2-3 orders per batch

**Batch Efficiency Check**:
- Calculate optimized batch route time
- Compare to sum of individual delivery times
- Only batch if route.totalTime < individual.sum * 0.8 (20% improvement)

---

## Step 6: Deep Dive - Route Optimization (5 minutes)

### ETA Calculation

**Multi-Factor ETA Breakdown**:

```
┌─────────────────────────────────────────────────────────────────┐
│                      ETA Calculation                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Time Through Prior Stops (if driver has other orders)       │
│     ├─ For each pending stop: travel_time + wait_time           │
│     ├─ Cumulative time from current location                    │
│                                                                  │
│  2. Time to Merchant                                             │
│     ├─ Calculate ETA from current position to merchant          │
│     ├─ Add estimated prep time                                  │
│                                                                  │
│  3. Time to Customer                                             │
│     ├─ Calculate ETA from merchant to delivery address          │
│                                                                  │
│  Total = prior_stops_time + to_merchant + prep + to_customer    │
│                                                                  │
│  External API: Google Maps / OSRM with traffic_model            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Multi-Stop Route Optimization

**Traveling Salesman with Constraints**:
- Each pickup must occur before its dropoff
- Minimize total distance/time
- For N <= 8: use exact algorithm
- For N > 8: use nearest neighbor heuristic

**Nearest Neighbor with Constraints Algorithm**:

```
┌─────────────────────────────────────────────────────────────────┐
│              Multi-Stop Route Optimization                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input: driver_location, pickups[], dropoffs[]                  │
│                                                                  │
│  Initialize:                                                     │
│  ├─ route = []                                                  │
│  ├─ pickedUp = Set()                                            │
│  ├─ current = driver_location                                   │
│                                                                  │
│  While route.length < pickups.length + dropoffs.length:         │
│  │                                                               │
│  │  For each order i:                                           │
│  │  ├─ If not picked up: consider pickups[i] as candidate      │
│  │  ├─ If picked up and not delivered: consider dropoffs[i]    │
│  │                                                               │
│  │  Select candidate with minimum distance from current         │
│  │  Add to route, update current position                       │
│  │  If pickup: add i to pickedUp                                │
│                                                                  │
│  Output: optimized route with stops in order                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Data Model (3 minutes)

### PostgreSQL Tables

**Core Tables**:

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| users | id, type, name, email, phone | Customers and drivers |
| drivers | id, vehicle_type, status, rating, current_lat/lng | Driver metadata |
| merchants | id, name, address, lat/lng, avg_prep_time | Restaurant data |
| orders | id, customer_id, merchant_id, driver_id, status, delivery_address | Order lifecycle |
| order_items | id, order_id, name, quantity, unit_price | Line items |

**Key Indexes**:
- orders(status) - for finding active orders
- orders(driver_id) WHERE status IN ('assigned', 'picked_up')
- drivers(status) - for finding available drivers

### Redis Data Structures

```
┌─────────────────────────────────────────────────────────────────┐
│                     Redis Data Structures                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Geo Index:                                                      │
│  ├─ drivers:locations          GEOADD (lng, lat, driver_id)    │
│  ├─ drivers:geo:{geohash}      GEOADD (partitioned by cell)    │
│                                                                  │
│  Driver Metadata:                                                │
│  ├─ driver:{id}                HASH (lat, lng, status, orders) │
│  ├─ driver:{id}:orders         LIST [order_ids]                │
│                                                                  │
│  Order Tracking:                                                 │
│  ├─ order:{id}:subscribers     SET [connection_ids]            │
│                                                                  │
│  Real-time PubSub:                                               │
│  ├─ driver:{id}:location       PUBSUB channel                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 8: API Design (2 minutes)

### Customer API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/v1/merchants?lat&lng&category | Browse nearby merchants |
| GET | /api/v1/merchants/{id}/menu | Get menu items |
| POST | /api/v1/orders | Place order |
| GET | /api/v1/orders/{id} | Get order details |
| WS | /api/v1/orders/{id}/track | Real-time tracking |
| POST | /api/v1/orders/{id}/rate | Rate driver |

### Driver API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/v1/driver/go-online | Start accepting orders |
| POST | /api/v1/driver/go-offline | Stop accepting orders |
| POST | /api/v1/driver/location | Update GPS position |
| POST | /api/v1/driver/offers/{id}/accept | Accept order offer |
| POST | /api/v1/driver/offers/{id}/reject | Reject order offer |
| POST | /api/v1/driver/orders/{id}/picked-up | Mark order picked up |
| POST | /api/v1/driver/orders/{id}/delivered | Mark order delivered |

### WebSocket Events

**Customer Receives**:
- driver_assigned: Driver info when matched
- location_update: lat, lng, eta in seconds
- status_update: picked_up, on_the_way, nearby
- delivered: Completion timestamp

**Driver Receives**:
- new_offer: Order details with 30s expiration
- offer_expired: Offer timed out
- order_cancelled: Customer cancelled

---

## Step 9: Scalability (3 minutes)

### Geographic Sharding

```
┌─────────────────────────────────────────────────────────────────┐
│                    Regional Architecture                         │
│                                                                  │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│   │   US-West   │     │   US-East   │     │   Europe    │       │
│   │   Region    │     │   Region    │     │   Region    │       │
│   │             │     │             │     │             │       │
│   │ - API       │     │ - API       │     │ - API       │       │
│   │ - Redis     │     │ - Redis     │     │ - Redis     │       │
│   │ - Workers   │     │ - Workers   │     │ - Workers   │       │
│   │ - Postgres  │     │ - Postgres  │     │ - Postgres  │       │
│   └─────────────┘     └─────────────┘     └─────────────┘       │
│                                                                  │
│   Route requests to region based on user location                │
└─────────────────────────────────────────────────────────────────┘
```

### Handling Traffic Spikes

1. **Auto-scaling**: Scale matching and tracking services
2. **Surge pricing**: Reduce demand, increase driver supply
3. **Request queuing**: Buffer order creation during spikes
4. **Graceful degradation**: Simplify matching algorithm under load

### Database Scaling

- **Read replicas**: For merchant browsing, order history
- **Sharding**: By city/region for orders and drivers
- **Time-series archival**: Move old location data to cold storage

---

## Step 10: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Redis geo-index | Fast queries, but data loss risk | Speed critical for real-time matching |
| 3-second updates | Accuracy vs. bandwidth/battery | Balance of freshness and cost |
| Sequential offers | Fair, but slower matching | Prevents race conditions |
| Geohash partitioning | Scalable, but edge cases | Worth complexity for scale |

### Alternatives Considered

**PostgreSQL PostGIS for locations**:
- More durable but slower for real-time
- Use for historical analysis instead

**Broadcast matching (all nearby drivers)**:
- Faster matching but creates race conditions
- Chose sequential for fairness

**Pre-computed ETAs**:
- Faster response but stale during traffic changes
- Use for estimates, recalculate for active orders

---

## Closing Summary

"I've designed a local delivery platform with:

1. **Redis-based geo-indexing** for real-time driver location with geohash partitioning
2. **Scoring-based driver matching** considering distance, rating, and load balancing
3. **WebSocket-based tracking** for live location updates to customers
4. **Multi-stop route optimization** for efficient batched deliveries

The key insight is that this is fundamentally a real-time geospatial system. The geo-index must be fast and accurate, matching must be fair and quick, and ETA calculations must account for real-world conditions. Happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle driver offline while carrying orders?**
   - Grace period to come back online
   - Reassign if prolonged offline
   - Customer notification with updated ETA

2. **How would you implement surge pricing?**
   - Monitor order demand vs. driver supply
   - Dynamic multiplier by zone
   - Show pricing before order confirmation

3. **How would you predict demand for driver positioning?**
   - Historical data by time/location
   - Event calendar integration
   - ML model for demand forecasting
   - Incentivize drivers to position in high-demand areas
