# Design DoorDash - Architecture

## System Overview

DoorDash is a three-sided marketplace connecting customers, restaurants, and delivery drivers. Core challenges involve real-time logistics, optimal matching, and accurate ETAs.

**Learning Goals:**
- Design real-time location tracking systems
- Build optimal order-driver matching
- Calculate accurate ETAs with multiple factors
- Handle three-sided marketplace dynamics

---

## Requirements

### Functional Requirements

1. **Order**: Browse restaurants, place orders
2. **Prepare**: Restaurant confirms and prepares
3. **Deliver**: Driver picks up and delivers
4. **Track**: Real-time order status and location
5. **Rate**: Review restaurant and driver

### Non-Functional Requirements

- **Latency**: < 100ms for location updates
- **Availability**: 99.99% during peak hours
- **Scale**: 1M orders/day, 100K concurrent drivers
- **Location accuracy**: Updates every 10 seconds

---

## High-Level Architecture

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

---

## Core Components

### 1. Driver Location Tracking

**Real-Time Location Storage:**
```javascript
// Driver app sends location every 10 seconds
async function updateDriverLocation(driverId, lat, lon) {
  // Store in Valkey with geo indexing
  await redis.geoadd('driver_locations', lon, lat, driverId)

  // Also store with timestamp for history
  await redis.hset(`driver:${driverId}`, {
    lat, lon,
    updated_at: Date.now()
  })

  // Publish for real-time tracking
  await redis.publish('driver_locations', JSON.stringify({ driverId, lat, lon }))
}

// Find drivers near restaurant
async function findNearbyDrivers(restaurantLat, restaurantLon, radiusKm) {
  const drivers = await redis.georadius(
    'driver_locations',
    restaurantLon, restaurantLat,
    radiusKm, 'km',
    'WITHDIST', 'ASC', 'COUNT', 20
  )

  return drivers.filter(async d => await isDriverAvailable(d.id))
}
```

### 2. Order-Driver Matching

**Matching Factors:**
```javascript
function calculateMatchScore(driver, order) {
  let score = 0

  // Distance to restaurant (most important)
  const distanceToRestaurant = haversine(driver.location, order.restaurant.location)
  score += 100 - (distanceToRestaurant * 10) // Closer = higher score

  // Driver's current order load
  const currentOrders = driver.activeOrders || 0
  score -= currentOrders * 15

  // Driver rating
  score += driver.rating * 5

  // Driver's earnings goal (prioritize drivers who need more deliveries)
  if (driver.needsMoreDeliveries) score += 10

  // Route efficiency (if driver has existing delivery)
  if (currentOrders > 0) {
    const efficiency = calculateRouteEfficiency(driver.route, order)
    score += efficiency * 20
  }

  return score
}

async function assignOrderToDriver(orderId) {
  const order = await getOrder(orderId)
  const nearbyDrivers = await findNearbyDrivers(
    order.restaurant.lat,
    order.restaurant.lon,
    5 // 5km radius
  )

  // Score each driver
  const scoredDrivers = nearbyDrivers.map(driver => ({
    driver,
    score: calculateMatchScore(driver, order)
  }))

  // Sort by score, offer to best match
  scoredDrivers.sort((a, b) => b.score - a.score)

  // Offer to top driver
  await offerOrderToDriver(scoredDrivers[0].driver.id, orderId)
}
```

### 3. ETA Calculation

**Multi-Factor ETA:**
```javascript
async function calculateDeliveryETA(orderId) {
  const order = await getOrder(orderId)
  const driver = await getDriver(order.driverId)

  // 1. Time to restaurant (if not there yet)
  const timeToRestaurant = order.status === 'PICKED_UP' ? 0 :
    await getRouteTime(driver.location, order.restaurant.location)

  // 2. Food preparation time (from restaurant estimate)
  const prepTime = order.status === 'READY_FOR_PICKUP' ? 0 :
    order.estimatedPrepTime - (Date.now() - order.confirmedAt)

  // 3. Time from restaurant to customer
  const deliveryTime = await getRouteTime(
    order.restaurant.location,
    order.deliveryAddress
  )

  // 4. Buffer for handoff
  const handoffBuffer = 3 * 60 * 1000 // 3 minutes

  // Total ETA
  const totalMs = Math.max(timeToRestaurant, prepTime) + deliveryTime + handoffBuffer

  return {
    eta: new Date(Date.now() + totalMs),
    breakdown: {
      toRestaurant: timeToRestaurant,
      preparation: prepTime,
      toCustomer: deliveryTime,
      buffer: handoffBuffer
    }
  }
}
```

### 4. Order Status Flow

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

  if (!currentState.actions.includes(action)) {
    throw new Error(`Invalid action ${action} for status ${order.status}`)
  }

  // Determine next state based on action
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
  await kafka.send('order_status', { orderId, status: nextStatus })

  // Trigger side effects (notifications, matching, etc.)
  await handleStatusChange(orderId, nextStatus)
}
```

---

## Database Schema

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
  is_open BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
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

-- Drivers
CREATE TABLE drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  vehicle_type VARCHAR(50),
  is_active BOOLEAN DEFAULT FALSE,
  current_location GEOGRAPHY(POINT, 4326),
  rating DECIMAL(2, 1),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Driver Location History (for ETA improvement)
CREATE TABLE driver_locations (
  driver_id INTEGER REFERENCES drivers(id),
  location GEOGRAPHY(POINT, 4326),
  recorded_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);
```

---

## Key Design Decisions

### 1. Valkey for Real-Time Locations

**Decision**: Store driver locations in Valkey with geo indexing

**Rationale**:
- GEOADD/GEORADIUS for spatial queries
- Sub-millisecond read latency
- Automatic expiry for stale locations

### 2. Event-Driven Architecture

**Decision**: Use Kafka for order events

**Rationale**:
- Decouples status updates from notifications
- Enables real-time client updates
- Audit trail for all transitions

### 3. Batching for Multi-Order Deliveries

**Decision**: Allow drivers to carry multiple orders

**Rationale**:
- Better efficiency for drivers
- Faster deliveries (routes optimized)
- Lower delivery fees possible

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Location store | Valkey geo | PostgreSQL PostGIS | Speed for updates |
| Matching | Score-based | Auction | Simpler, predictable |
| ETA | Multi-factor | ML model | Interpretable |
| Events | Kafka | Direct push | Decoupling, replay |
