# System Design Interview: DoorDash - Food Delivery Platform

## Opening Statement

"Today I'll design a food delivery platform like DoorDash, which is a three-sided marketplace connecting customers, restaurants, and delivery drivers. The core technical challenges are real-time location tracking at scale, optimal order-driver matching, accurate multi-factor ETA calculation, and managing complex order state machines across all three parties."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Order**: Customers browse restaurants and place orders
2. **Prepare**: Restaurants confirm and prepare food
3. **Deliver**: Drivers pick up and deliver orders
4. **Track**: Real-time order status and driver location
5. **Rate**: Review restaurants and drivers after delivery

### Non-Functional Requirements

- **Latency**: < 100ms for location updates
- **Availability**: 99.99% during peak hours (lunch, dinner)
- **Scale**: 1 million orders per day, 100K concurrent drivers
- **Location**: Updates every 10 seconds from driver apps

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Daily Orders | 1M |
| Concurrent Drivers | 100K |
| Location Updates/Sec | 10K (100K drivers / 10 sec interval) |
| Peak Orders/Hour | 100K |
| Average Delivery Time | 35 minutes |

---

## Step 2: High-Level Architecture (7 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│  Customer App │ Restaurant Tablet │ Driver App                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Order Service │    │Location Service│    │ Match Service │
│               │    │               │    │               │
│ - Create      │    │ - Driver GPS  │    │ - Assignment  │
│ - Status      │    │ - Geo queries │    │ - Batching    │
│ - Payment     │    │ - ETA calc    │    │ - Dispatch    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────┬─────────────┬─────────────────────────────────────┤
│ PostgreSQL  │   Valkey    │           Kafka                     │
│ - Orders    │ - Locations │ - Order events                      │
│ - Menus     │ - Sessions  │ - Location updates                  │
│ - Users     │ - Geo index │ - Dispatch events                   │
└─────────────┴─────────────┴─────────────────────────────────────┘
```

### Why This Architecture?

**Valkey for Location**: Driver locations update every 10 seconds. We need sub-millisecond reads for matching and geo queries. Valkey's GEOADD/GEORADIUS commands are perfect for this.

**Kafka for Events**: Order status changes need to reach multiple consumers (customer app, restaurant tablet, analytics). Kafka provides reliable pub/sub with ordering guarantees.

**Separate Match Service**: Matching algorithm is complex and computationally intensive. Isolating it allows independent scaling and optimization.

---

## Step 3: Driver Location Tracking Deep Dive (10 minutes)

### Real-Time Location Storage

```javascript
// Driver app sends location every 10 seconds
async function updateDriverLocation(driverId, lat, lon) {
  // 1. Store in Valkey with geo indexing
  await redis.geoadd('driver_locations', lon, lat, driverId)

  // 2. Store additional metadata
  await redis.hset(`driver:${driverId}`, {
    lat,
    lon,
    updated_at: Date.now(),
    status: 'active'  // active, on_delivery, offline
  })

  // 3. Publish for real-time tracking (customers watching their order)
  await redis.publish('driver_locations', JSON.stringify({
    driverId,
    lat,
    lon,
    timestamp: Date.now()
  }))
}
```

### Finding Nearby Drivers

```javascript
async function findNearbyDrivers(restaurantLat, restaurantLon, radiusKm = 5) {
  // Get drivers within radius, sorted by distance
  const drivers = await redis.georadius(
    'driver_locations',
    restaurantLon, restaurantLat,
    radiusKm, 'km',
    'WITHDIST', 'ASC', 'COUNT', 20
  )

  // Filter to only available drivers
  const available = []
  for (const driver of drivers) {
    const status = await redis.hget(`driver:${driver.id}`, 'status')
    const activeOrders = await redis.get(`driver:${driver.id}:order_count`)

    if (status === 'active' && parseInt(activeOrders || 0) < 2) {
      available.push({
        ...driver,
        activeOrders: parseInt(activeOrders || 0)
      })
    }
  }

  return available
}
```

### Why Valkey Instead of PostgreSQL PostGIS?

| Aspect | Valkey | PostGIS |
|--------|--------|---------|
| Write latency | Sub-ms | 5-10ms |
| Updates/sec | 100K+ | 10K |
| Geo query speed | Sub-ms | 10-50ms |
| Persistence | Optional | Always |

For 10K location updates per second with sub-100ms query requirements, Valkey is the right choice. We don't need durability for ephemeral location data.

---

## Step 4: Order-Driver Matching Deep Dive (12 minutes)

This is the heart of the logistics system.

### Matching Score Calculation

```javascript
function calculateMatchScore(driver, order) {
  let score = 0

  // Factor 1: Distance to restaurant (most important)
  const distanceToRestaurant = haversineDistance(
    driver.location,
    order.restaurant.location
  )
  score += 100 - (distanceToRestaurant * 10) // Closer = higher score

  // Factor 2: Driver's current order load
  const currentOrders = driver.activeOrders || 0
  score -= currentOrders * 15  // Penalty for already carrying orders

  // Factor 3: Driver rating
  score += driver.rating * 5  // 5 stars = +25 points

  // Factor 4: Earnings goal (prioritize drivers who need more deliveries)
  if (driver.dailyDeliveries < driver.earningsGoal) {
    score += 10
  }

  // Factor 5: Route efficiency (if driver has existing delivery)
  if (currentOrders > 0) {
    const efficiency = calculateRouteEfficiency(driver.currentRoute, order)
    score += efficiency * 20  // High efficiency = good for batching
  }

  // Factor 6: Estimated time to restaurant
  const estimatedArrival = estimateDriveTime(driver.location, order.restaurant.location)
  if (estimatedArrival > order.prepTime) {
    score -= 20  // Penalty if driver would arrive before food is ready
  }

  return score
}
```

### Assignment Flow

```javascript
async function assignOrderToDriver(orderId) {
  const order = await getOrder(orderId)

  // 1. Find nearby available drivers
  const nearbyDrivers = await findNearbyDrivers(
    order.restaurant.lat,
    order.restaurant.lon,
    5 // 5km radius
  )

  if (nearbyDrivers.length === 0) {
    // Expand radius and try again
    return await assignOrderToDriver(orderId, 10) // 10km
  }

  // 2. Score each driver
  const scoredDrivers = nearbyDrivers.map(driver => ({
    driver,
    score: calculateMatchScore(driver, order)
  }))

  // 3. Sort by score
  scoredDrivers.sort((a, b) => b.score - a.score)

  // 4. Offer to top driver (with timeout)
  const result = await offerOrderToDriver(
    scoredDrivers[0].driver.id,
    orderId,
    30 // 30 second timeout
  )

  if (result.accepted) {
    return result
  }

  // 5. Try next driver if declined
  return await tryNextDriver(scoredDrivers.slice(1), orderId)
}
```

### Order Batching

Batching allows drivers to pick up multiple orders efficiently:

```javascript
async function checkBatchOpportunity(driverId, newOrderId) {
  const driver = await getDriver(driverId)
  const newOrder = await getOrder(newOrderId)

  // Already carrying an order?
  if (driver.currentOrders.length === 0) {
    return null // No batching opportunity
  }

  const currentOrder = driver.currentOrders[0]

  // Check if restaurants are close
  const restaurantDistance = haversineDistance(
    currentOrder.restaurant.location,
    newOrder.restaurant.location
  )

  if (restaurantDistance > 0.5) { // More than 500m apart
    return null
  }

  // Check if delivery addresses are in same direction
  const routeEfficiency = calculateCombinedRouteEfficiency(
    currentOrder.deliveryAddress,
    newOrder.deliveryAddress,
    driver.location
  )

  if (routeEfficiency < 0.7) { // Less than 70% efficient
    return null
  }

  // Calculate delay to first customer
  const additionalDelay = estimateAdditionalDelay(currentOrder, newOrder)

  if (additionalDelay > 5) { // More than 5 minutes delay
    return null
  }

  return {
    canBatch: true,
    additionalDelay,
    savings: calculateSavings(currentOrder, newOrder)
  }
}
```

---

## Step 5: ETA Calculation Deep Dive (8 minutes)

Accurate ETAs are crucial for customer satisfaction.

### Multi-Factor ETA

```javascript
async function calculateDeliveryETA(orderId) {
  const order = await getOrder(orderId)
  const driver = order.driverId ? await getDriver(order.driverId) : null

  // Factor 1: Time to restaurant (if driver assigned and not there)
  let timeToRestaurant = 0
  if (driver && order.status !== 'PICKED_UP') {
    timeToRestaurant = await getRouteTime(
      driver.location,
      order.restaurant.location
    )
  }

  // Factor 2: Food preparation time
  let prepTime = 0
  if (order.status === 'PREPARING') {
    const elapsed = Date.now() - order.confirmedAt
    const remaining = order.estimatedPrepTime - elapsed
    prepTime = Math.max(0, remaining)
  }

  // Factor 3: Time from restaurant to customer
  const deliveryTime = await getRouteTime(
    order.restaurant.location,
    order.deliveryAddress
  )

  // Factor 4: Buffers
  const pickupBuffer = 3 * 60 * 1000  // 3 minutes for pickup
  const dropoffBuffer = 2 * 60 * 1000 // 2 minutes for handoff

  // Calculate total
  const waitTime = Math.max(timeToRestaurant, prepTime) // Parallel activities
  const totalMs = waitTime + deliveryTime + pickupBuffer + dropoffBuffer

  return {
    eta: new Date(Date.now() + totalMs),
    breakdown: {
      toRestaurant: timeToRestaurant,
      preparation: prepTime,
      toCustomer: deliveryTime,
      buffers: pickupBuffer + dropoffBuffer
    },
    confidence: calculateConfidence(order)
  }
}
```

### Route Time Estimation

```javascript
async function getRouteTime(origin, destination) {
  // Check cache first
  const cacheKey = `route:${origin.lat},${origin.lon}:${destination.lat},${destination.lon}`
  const cached = await redis.get(cacheKey)

  if (cached) {
    return JSON.parse(cached)
  }

  // Call routing API (Google Maps, OSRM, etc.)
  const route = await routingApi.getDirections(origin, destination)

  // Apply time-of-day multiplier
  const trafficMultiplier = getTrafficMultiplier(new Date())
  const adjustedTime = route.duration * trafficMultiplier

  // Cache for 5 minutes
  await redis.set(cacheKey, JSON.stringify(adjustedTime), 'EX', 300)

  return adjustedTime
}

function getTrafficMultiplier(time) {
  const hour = time.getHours()

  // Rush hours: 1.5x
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) {
    return 1.5
  }

  // Lunch rush: 1.3x
  if (hour >= 11 && hour <= 13) {
    return 1.3
  }

  // Normal: 1.0x
  return 1.0
}
```

---

## Step 6: Order Status Flow (5 minutes)

```javascript
const ORDER_STATES = {
  PLACED: {
    next: ['CONFIRMED', 'CANCELLED'],
    actions: ['restaurant_confirm', 'customer_cancel']
  },
  CONFIRMED: {
    next: ['PREPARING', 'CANCELLED'],
    actions: ['restaurant_start_prep', 'cancel']
  },
  PREPARING: {
    next: ['READY_FOR_PICKUP'],
    actions: ['restaurant_ready']
  },
  READY_FOR_PICKUP: {
    next: ['PICKED_UP'],
    actions: ['driver_pickup']
  },
  PICKED_UP: {
    next: ['DELIVERED'],
    actions: ['driver_deliver']
  },
  DELIVERED: {
    next: ['COMPLETED'],
    actions: ['auto_complete']
  }
}

async function transitionOrder(orderId, action, actorId) {
  const order = await getOrder(orderId)
  const currentState = ORDER_STATES[order.status]

  // Validate action is allowed
  if (!currentState.actions.includes(action)) {
    throw new Error(`Invalid action ${action} for status ${order.status}`)
  }

  // Determine next state
  const nextStatus = getNextStatus(order.status, action)

  // Update order
  await db('orders')
    .where({ id: orderId })
    .update({
      status: nextStatus,
      updated_at: new Date(),
      [`${action}_at`]: new Date(),
      [`${action}_by`]: actorId
    })

  // Emit event for real-time updates
  await kafka.send('order_status', {
    orderId,
    previousStatus: order.status,
    newStatus: nextStatus,
    action,
    actorId,
    timestamp: Date.now()
  })

  // Trigger side effects
  await handleStatusChange(orderId, order.status, nextStatus)
}

async function handleStatusChange(orderId, previousStatus, newStatus) {
  switch (newStatus) {
    case 'CONFIRMED':
      // Start matching process
      await matchService.queueForMatching(orderId)
      break

    case 'READY_FOR_PICKUP':
      // Notify driver
      await notificationService.notifyDriver(orderId, 'Food is ready')
      break

    case 'PICKED_UP':
      // Notify customer
      await notificationService.notifyCustomer(orderId, 'Driver has picked up your order')
      break

    case 'DELIVERED':
      // Process payment, request reviews
      await paymentService.capturePayment(orderId)
      await scheduleReviewRequest(orderId)
      break
  }
}
```

---

## Step 7: Database Schema (3 minutes)

```sql
-- Restaurants
CREATE TABLE restaurants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  address VARCHAR(500),
  location GEOGRAPHY(POINT, 4326),
  cuisine_type VARCHAR(50),
  rating DECIMAL(2, 1),
  prep_time_minutes INTEGER DEFAULT 20,
  is_open BOOLEAN DEFAULT TRUE
);

-- Menu Items
CREATE TABLE menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category VARCHAR(50),
  is_available BOOLEAN DEFAULT TRUE
);

-- Drivers
CREATE TABLE drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  vehicle_type VARCHAR(50),
  is_active BOOLEAN DEFAULT FALSE,
  rating DECIMAL(2, 1),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id),
  restaurant_id INTEGER REFERENCES restaurants(id),
  driver_id INTEGER REFERENCES drivers(id),
  status VARCHAR(30) DEFAULT 'PLACED',
  total DECIMAL(10, 2),
  delivery_fee DECIMAL(10, 2),
  delivery_address JSONB,
  estimated_delivery_at TIMESTAMP,
  placed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP
);
```

---

## Step 8: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Location store | Valkey geo | PostgreSQL PostGIS | 10K updates/sec needs in-memory speed |
| Matching | Score-based | Auction/bidding | Simpler, more predictable for drivers |
| ETA | Multi-factor | ML model | Interpretable, debuggable |
| Events | Kafka | Direct push | Decoupling, replay capability |

### Why Not ML for ETA?

ML models can be more accurate, but:
- Harder to debug when wrong
- Requires training data infrastructure
- Multi-factor approach gets us 80% there
- Would add ML as enhancement later

### Why Score-Based Matching vs Auction?

Auction (drivers bid on orders) could optimize earnings, but:
- Adds complexity for drivers
- Delays matching process
- Score-based is predictable and fast

---

## Closing Summary

I've designed a food delivery platform with four core systems:

1. **Location Tracking**: Valkey-based real-time driver location with GEOADD/GEORADIUS for spatial queries, supporting 10K updates per second

2. **Order-Driver Matching**: Multi-factor scoring considering distance, driver load, ratings, and route efficiency, with batching support

3. **ETA Calculation**: Parallel computation of prep time, drive times, and buffers with traffic multipliers and caching

4. **Order State Machine**: Event-driven status flow with Kafka for real-time updates to all three parties

**Key trade-offs:**
- Valkey over PostGIS (speed over durability for ephemeral data)
- Score-based over auction matching (simplicity over optimization)
- Multi-factor ETA over ML (interpretability over accuracy)

**What would I add with more time?**
- Dynamic pricing based on demand/supply
- Driver incentive optimization
- Predictive order volume for restaurant prep
