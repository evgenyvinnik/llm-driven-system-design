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

1. **Order Service**
   - Order lifecycle management
   - State machine (placed → accepted → picked up → delivered)
   - Order history and receipts

2. **Location Service**
   - Ingests driver location updates
   - Maintains real-time geo index
   - Supports nearby driver queries

3. **Matching Service**
   - Assigns orders to drivers
   - Considers distance, driver rating, current load
   - Handles driver acceptance/rejection

4. **Tracking Service**
   - Real-time location streaming to customers
   - ETA calculations and updates
   - WebSocket connections management

5. **Routing Service**
   - Route calculation using map APIs
   - Multi-stop optimization
   - Traffic-aware ETAs

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

```typescript
// Store driver location
async function updateDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  // GEOADD for spatial indexing
  await redis.geoadd('drivers:locations', lng, lat, driverId);

  // Store timestamp and metadata
  await redis.hset(`driver:${driverId}`, {
    lat,
    lng,
    updated_at: Date.now(),
    status: 'available'
  });

  // Publish for real-time tracking
  await redis.publish(`driver:${driverId}:location`, JSON.stringify({ lat, lng }));
}

// Find nearby drivers
async function findNearbyDrivers(
  lat: number,
  lng: number,
  radiusKm: number,
  limit: number = 10
): Promise<Driver[]> {
  // GEORADIUS query
  const nearbyIds = await redis.georadius(
    'drivers:locations',
    lng, lat,
    radiusKm, 'km',
    'WITHDIST',
    'ASC',
    'COUNT', limit
  );

  // Filter by availability
  const drivers = await Promise.all(
    nearbyIds.map(async ([id, dist]) => {
      const data = await redis.hgetall(`driver:${id}`);
      return {
        id,
        distance: parseFloat(dist),
        ...data,
        isAvailable: data.status === 'available'
      };
    })
  );

  return drivers.filter(d => d.isAvailable);
}
```

### Geohash Partitioning for Scale

For millions of drivers, partition by geohash:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Geohash Grid                             │
│                                                                 │
│   ┌───────┬───────┬───────┐                                    │
│   │ 9q8yy │ 9q8yz │ 9q8z0 │  ← Each cell is a Redis key        │
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

```typescript
function getGeohashCells(lat: number, lng: number, radiusKm: number): string[] {
  // Calculate geohash precision based on radius
  const precision = radiusKm < 1 ? 6 : radiusKm < 10 ? 5 : 4;

  // Get center cell and neighbors
  const centerHash = geohash.encode(lat, lng, precision);
  const neighbors = geohash.neighbors(centerHash);

  return [centerHash, ...neighbors];
}

async function findDriversInArea(lat: number, lng: number, radiusKm: number) {
  const cells = getGeohashCells(lat, lng, radiusKm);

  const results = await Promise.all(
    cells.map(cell =>
      redis.georadius(`drivers:geo:${cell}`, lng, lat, radiusKm, 'km')
    )
  );

  return results.flat();
}
```

### Real-Time Streaming to Customers

```typescript
// WebSocket connection per active order
class TrackingWebSocket {
  async handleConnection(ws: WebSocket, orderId: string) {
    const order = await getOrder(orderId);
    const driverId = order.driver_id;

    // Subscribe to driver location updates
    const subscriber = redis.duplicate();
    await subscriber.subscribe(`driver:${driverId}:location`);

    subscriber.on('message', (channel, message) => {
      const location = JSON.parse(message);

      // Calculate ETA
      const eta = await routingService.getETA(
        location,
        order.delivery_address
      );

      ws.send(JSON.stringify({
        type: 'location_update',
        driver_location: location,
        eta_seconds: eta
      }));
    });

    ws.on('close', () => {
      subscriber.unsubscribe();
      subscriber.quit();
    });
  }
}
```

---

## Step 5: Deep Dive - Driver Matching (8 minutes)

### Matching Considerations

1. **Distance**: Closer drivers for faster pickup
2. **Driver rating**: Higher rated drivers preferred
3. **Current load**: Balance orders across drivers
4. **Order value**: High-value orders to reliable drivers
5. **Driver preferences**: Some prefer certain areas/merchants

### Matching Algorithm

```typescript
interface MatchingScore {
  driverId: string;
  totalScore: number;
  factors: {
    distance: number;
    rating: number;
    acceptance_rate: number;
    current_orders: number;
  };
}

async function findBestDriver(order: Order): Promise<Driver | null> {
  // 1. Get nearby available drivers
  const nearbyDrivers = await findNearbyDrivers(
    order.merchant.lat,
    order.merchant.lng,
    5 // km
  );

  if (nearbyDrivers.length === 0) {
    return null;
  }

  // 2. Score each driver
  const scores: MatchingScore[] = await Promise.all(
    nearbyDrivers.map(async (driver) => {
      const driverStats = await getDriverStats(driver.id);

      // Distance score (closer is better)
      const distanceScore = Math.max(0, 1 - (driver.distance / 5));

      // Rating score (normalized 0-1)
      const ratingScore = driverStats.rating / 5;

      // Acceptance rate (drivers who accept orders)
      const acceptanceScore = driverStats.acceptance_rate;

      // Load balancing (prefer drivers with fewer orders)
      const loadScore = Math.max(0, 1 - (driverStats.current_orders / 3));

      // Weighted combination
      const totalScore =
        distanceScore * 0.4 +
        ratingScore * 0.25 +
        acceptanceScore * 0.2 +
        loadScore * 0.15;

      return {
        driverId: driver.id,
        totalScore,
        factors: {
          distance: distanceScore,
          rating: ratingScore,
          acceptance_rate: acceptanceScore,
          current_orders: driverStats.current_orders
        }
      };
    })
  );

  // 3. Sort by score and try in order
  scores.sort((a, b) => b.totalScore - a.totalScore);

  return scores[0] ? await getDriver(scores[0].driverId) : null;
}
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

```typescript
async function offerOrderToDrivers(order: Order): Promise<boolean> {
  const maxAttempts = 5;
  const offerTimeout = 30000; // 30 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const driver = await findBestDriver(order, excludeDrivers);

    if (!driver) {
      // No available drivers, wait and retry
      await sleep(10000);
      continue;
    }

    // Send offer to driver
    await sendDriverOffer(driver.id, order);

    // Wait for response
    const response = await waitForDriverResponse(driver.id, order.id, offerTimeout);

    if (response === 'accepted') {
      await assignOrderToDriver(order, driver);
      return true;
    }

    // Driver rejected or timed out, try next
    excludeDrivers.add(driver.id);
  }

  // No driver accepted, notify customer
  await notifyCustomer(order.id, 'no_driver_available');
  return false;
}
```

### Batching Orders (Multi-Stop)

```typescript
interface DeliveryBatch {
  driverId: string;
  orders: Order[];
  route: RouteStop[];
  totalDistance: number;
  totalTime: number;
}

async function createBatch(
  pendingOrders: Order[],
  driver: Driver
): Promise<DeliveryBatch> {
  // Group orders by merchant proximity
  const merchantGroups = groupByMerchant(pendingOrders);

  // Find orders that can be batched (same area, time window)
  const batchCandidates = pendingOrders.filter(order =>
    isWithinBatchWindow(order) &&
    isNearDriver(order.merchant, driver) &&
    order.delivery_address.isNear(driver.currentRoute)
  );

  // Optimize route for batch
  const optimizedRoute = await routingService.optimizeMultiStop(
    driver.location,
    batchCandidates.map(o => o.merchant.location),
    batchCandidates.map(o => o.delivery_address)
  );

  // Only batch if it improves efficiency
  if (optimizedRoute.totalTime < sumIndividualTimes(batchCandidates) * 0.8) {
    return {
      driverId: driver.id,
      orders: batchCandidates,
      route: optimizedRoute.stops,
      totalDistance: optimizedRoute.distance,
      totalTime: optimizedRoute.time
    };
  }

  return null;
}
```

---

## Step 6: Deep Dive - Route Optimization (5 minutes)

### ETA Calculation

```typescript
async function calculateETA(
  origin: Location,
  destination: Location,
  departureTime: Date = new Date()
): Promise<number> {
  // Call external routing API (Google Maps, OSRM)
  const route = await routingAPI.getDirections({
    origin,
    destination,
    departure_time: departureTime,
    traffic_model: 'best_guess'
  });

  return route.duration_in_traffic;
}

// For delivery ETA, sum multiple legs
async function getDeliveryETA(order: Order): Promise<ETABreakdown> {
  const driver = await getDriver(order.driver_id);

  // If driver has other orders first
  const priorStops = await getDriverPendingStops(driver.id);

  let currentLocation = driver.location;
  let totalTime = 0;
  const legs: RouteLeg[] = [];

  // Calculate time through prior stops
  for (const stop of priorStops) {
    const legTime = await calculateETA(currentLocation, stop.location);
    totalTime += legTime + stop.estimated_wait_time;
    currentLocation = stop.location;
    legs.push({ destination: stop, time: legTime });
  }

  // Time to this order's merchant
  const toMerchant = await calculateETA(currentLocation, order.merchant.location);
  totalTime += toMerchant + order.estimated_prep_time;

  // Time from merchant to customer
  const toCustomer = await calculateETA(
    order.merchant.location,
    order.delivery_address
  );
  totalTime += toCustomer;

  return {
    total_seconds: totalTime,
    pickup_eta: toMerchant,
    delivery_eta: toMerchant + order.estimated_prep_time + toCustomer,
    legs
  };
}
```

### Multi-Stop Route Optimization

For drivers with multiple orders, solve the Traveling Salesman Problem (TSP):

```typescript
async function optimizeRoute(
  driverLocation: Location,
  pickups: Location[],    // Merchant locations
  dropoffs: Location[]    // Customer locations
): Promise<OptimizedRoute> {
  // Constraints:
  // - Each pickup must happen before its corresponding dropoff
  // - Minimize total distance/time

  // For small N (< 10), use exact algorithm
  if (pickups.length <= 8) {
    return exactTSPWithConstraints(driverLocation, pickups, dropoffs);
  }

  // For larger N, use heuristics
  return nearestNeighborWithConstraints(driverLocation, pickups, dropoffs);
}

function nearestNeighborWithConstraints(
  start: Location,
  pickups: Location[],
  dropoffs: Location[]
): OptimizedRoute {
  const route: RouteStop[] = [];
  let current = start;
  const pickedUp = new Set<number>();

  while (route.length < pickups.length + dropoffs.length) {
    let bestNext = null;
    let bestDistance = Infinity;

    // Consider all valid next stops
    for (let i = 0; i < pickups.length; i++) {
      // Can pickup if not already picked up
      if (!pickedUp.has(i)) {
        const dist = haversineDistance(current, pickups[i]);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestNext = { type: 'pickup', index: i, location: pickups[i] };
        }
      }

      // Can dropoff if already picked up
      if (pickedUp.has(i) && !route.some(s => s.type === 'dropoff' && s.index === i)) {
        const dist = haversineDistance(current, dropoffs[i]);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestNext = { type: 'dropoff', index: i, location: dropoffs[i] };
        }
      }
    }

    if (bestNext.type === 'pickup') {
      pickedUp.add(bestNext.index);
    }
    route.push(bestNext);
    current = bestNext.location;
  }

  return { stops: route, totalDistance: calculateTotalDistance(route) };
}
```

---

## Step 7: Data Model (3 minutes)

### PostgreSQL Schema

```sql
-- Users (customers and drivers)
CREATE TABLE users (
  id UUID PRIMARY KEY,
  type VARCHAR(20),  -- 'customer', 'driver', 'merchant'
  name VARCHAR(255),
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  created_at TIMESTAMP
);

-- Drivers
CREATE TABLE drivers (
  id UUID PRIMARY KEY REFERENCES users(id),
  vehicle_type VARCHAR(20),
  license_plate VARCHAR(20),
  status VARCHAR(20),  -- 'offline', 'available', 'busy'
  rating DECIMAL(3, 2),
  total_deliveries INTEGER DEFAULT 0,
  current_lat DECIMAL(10, 8),
  current_lng DECIMAL(11, 8),
  location_updated_at TIMESTAMP
);

-- Merchants
CREATE TABLE merchants (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  address TEXT,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  category VARCHAR(50),
  avg_prep_time_minutes INTEGER DEFAULT 15,
  rating DECIMAL(3, 2)
);

-- Orders
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES users(id),
  merchant_id UUID REFERENCES merchants(id),
  driver_id UUID REFERENCES drivers(id),
  status VARCHAR(30),
  delivery_address TEXT,
  delivery_lat DECIMAL(10, 8),
  delivery_lng DECIMAL(11, 8),
  subtotal DECIMAL(10, 2),
  delivery_fee DECIMAL(10, 2),
  tip DECIMAL(10, 2),
  total DECIMAL(10, 2),
  estimated_delivery_time TIMESTAMP,
  actual_delivery_time TIMESTAMP,
  created_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP
);

-- Order items
CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  name VARCHAR(255),
  quantity INTEGER,
  unit_price DECIMAL(10, 2),
  special_instructions TEXT
);

-- Indexes
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_driver ON orders(driver_id) WHERE status IN ('assigned', 'picked_up');
CREATE INDEX idx_drivers_status ON drivers(status);
```

### Redis Data Structures

```
# Driver locations (geo index)
drivers:locations          → GEOADD (lng, lat, driver_id)
drivers:geo:{geohash}      → GEOADD (partitioned)

# Driver metadata
driver:{id}                → HASH (lat, lng, status, current_orders)

# Active orders by driver
driver:{id}:orders         → LIST [order_ids]

# Order tracking subscriptions
order:{id}:subscribers     → SET [connection_ids]

# Real-time location pubsub
driver:{id}:location       → PUBSUB channel
```

---

## Step 8: API Design (2 minutes)

### Customer API

```
# Browsing
GET  /api/v1/merchants?lat=...&lng=...&category=...
GET  /api/v1/merchants/{id}/menu

# Orders
POST /api/v1/orders
Body: { merchant_id, items, delivery_address, payment_method }

GET  /api/v1/orders/{id}
GET  /api/v1/orders/{id}/track  → WebSocket upgrade

POST /api/v1/orders/{id}/tip
POST /api/v1/orders/{id}/rate
```

### Driver API

```
# Status
POST /api/v1/driver/go-online
POST /api/v1/driver/go-offline
POST /api/v1/driver/location
Body: { lat, lng, heading, speed }

# Orders
GET  /api/v1/driver/current-orders
POST /api/v1/driver/offers/{order_id}/accept
POST /api/v1/driver/offers/{order_id}/reject
POST /api/v1/driver/orders/{order_id}/picked-up
POST /api/v1/driver/orders/{order_id}/delivered
```

### WebSocket Events

```typescript
// Customer receives
{ type: 'driver_assigned', driver: {...} }
{ type: 'location_update', lat: 37.7749, lng: -122.4194, eta: 480 }
{ type: 'status_update', status: 'picked_up' }
{ type: 'delivered', timestamp: '...' }

// Driver receives
{ type: 'new_offer', order: {...}, expires_in: 30 }
{ type: 'offer_expired', order_id: '...' }
{ type: 'order_cancelled', order_id: '...' }
```

---

## Step 9: Scalability (3 minutes)

### Geographic Sharding

```
┌─────────────────────────────────────────────────────────────────┐
│                    Regional Architecture                        │
│                                                                 │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐      │
│   │   US-West   │     │   US-East   │     │   Europe    │      │
│   │   Region    │     │   Region    │     │   Region    │      │
│   │             │     │             │     │             │      │
│   │ - API       │     │ - API       │     │ - API       │      │
│   │ - Redis     │     │ - Redis     │     │ - Redis     │      │
│   │ - Workers   │     │ - Workers   │     │ - Workers   │      │
│   │ - Postgres  │     │ - Postgres  │     │ - Postgres  │      │
│   └─────────────┘     └─────────────┘     └─────────────┘      │
│                                                                 │
│   Route requests to region based on user location               │
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

| Decision | Trade-off |
|----------|-----------|
| Redis geo-index | Fast queries, but data loss risk |
| 3-second location updates | Accuracy vs. bandwidth/battery |
| Sequential driver offers | Fair, but slower matching |
| Geohash partitioning | Scalable, but edge case complexity |

### Alternatives Considered

1. **PostgreSQL PostGIS for locations**
   - More durable
   - Slower for real-time queries
   - Use for historical analysis

2. **Broadcast matching (all nearby drivers)**
   - Faster matching
   - Race conditions, unfair
   - Chose sequential for fairness

3. **Pre-computed ETAs**
   - Faster response
   - Stale during traffic changes
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
