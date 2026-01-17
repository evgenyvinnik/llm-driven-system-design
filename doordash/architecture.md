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

## Consistency and Idempotency

### Write Consistency Model

DoorDash operations have different consistency requirements based on criticality:

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Order placement | Strong (PostgreSQL) | Payment tied to order, no duplicates allowed |
| Order status transitions | Strong with idempotency key | State machine integrity critical |
| Driver location updates | Eventual (Valkey) | High frequency, stale data acceptable for 10s |
| Menu/price updates | Eventual with 30s propagation | Restaurants can tolerate brief inconsistency |
| Driver matching offers | Optimistic with conflict detection | Race conditions handled via offer expiry |

### Idempotency Keys

All mutating API endpoints require client-generated idempotency keys:

```javascript
// Order creation with idempotency
async function createOrder(req, res) {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing X-Idempotency-Key header' });
  }

  // Check for existing request with same key (TTL: 24 hours)
  const existing = await redis.get(`idempotency:order:${idempotencyKey}`);
  if (existing) {
    const cached = JSON.parse(existing);
    return res.status(cached.statusCode).json(cached.body);
  }

  // Process order creation in transaction
  const result = await db.transaction(async trx => {
    const order = await trx('orders').insert({...}).returning('*');
    await trx('order_items').insert(items.map(i => ({ order_id: order.id, ...i })));
    return order;
  });

  // Cache response for idempotency
  await redis.setex(
    `idempotency:order:${idempotencyKey}`,
    86400, // 24 hours
    JSON.stringify({ statusCode: 201, body: result })
  );

  return res.status(201).json(result);
}
```

### Order State Machine Conflict Resolution

Order status transitions use optimistic locking to prevent race conditions:

```javascript
async function transitionOrderStatus(orderId, expectedStatus, newStatus, actorId) {
  const result = await db('orders')
    .where({ id: orderId, status: expectedStatus })
    .update({
      status: newStatus,
      updated_at: new Date(),
      version: db.raw('version + 1')
    })
    .returning('*');

  if (result.length === 0) {
    // Conflict: order was modified by another actor
    const current = await db('orders').where({ id: orderId }).first();
    throw new ConflictError(
      `Order ${orderId} is now ${current.status}, expected ${expectedStatus}`
    );
  }

  return result[0];
}
```

### Replay Handling

Kafka consumers use consumer group offsets and message deduplication:

```javascript
// Consumer with at-least-once delivery and deduplication
async function processOrderEvent(message) {
  const eventId = message.headers['event-id'];
  const processed = await redis.setnx(`processed:${eventId}`, '1');

  if (!processed) {
    console.log(`Skipping duplicate event ${eventId}`);
    return; // Already processed
  }

  // Set TTL for dedup key (7 days)
  await redis.expire(`processed:${eventId}`, 604800);

  // Process the event
  await handleOrderStatusChange(JSON.parse(message.value));
}
```

---

## Caching and Edge Strategy

### Caching Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CDN Edge                                 │
│  Static assets, menu images, restaurant photos                  │
│  TTL: 1 hour, purge on update                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Application Cache (Valkey)                   │
│  Menu data, restaurant info, driver sessions, geospatial        │
│  TTL: varies by data type                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Source of Truth)                 │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Strategy by Data Type

| Data | Strategy | TTL | Invalidation |
|------|----------|-----|--------------|
| Restaurant details | Cache-aside | 5 min | Explicit purge on update |
| Menu items | Cache-aside | 5 min | Purge on menu edit |
| Menu images | CDN | 1 hour | Version-based URL |
| Driver locations | Write-through | 30s auto-expire | Overwrite on update |
| Order status | No cache | N/A | Real-time via WebSocket |
| User sessions | Write-through | 24 hours | Explicit delete on logout |
| Nearby restaurants | Cache-aside (by geo cell) | 2 min | Background refresh |

### Cache-Aside Implementation (Read-Heavy Data)

```javascript
// Restaurant and menu data uses cache-aside pattern
async function getRestaurantWithMenu(restaurantId) {
  const cacheKey = `restaurant:${restaurantId}:full`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: query database
  const restaurant = await db('restaurants').where({ id: restaurantId }).first();
  const menuItems = await db('menu_items')
    .where({ restaurant_id: restaurantId, is_available: true });

  const result = { ...restaurant, menu: menuItems };

  // Store in cache with 5-minute TTL
  await redis.setex(cacheKey, 300, JSON.stringify(result));

  return result;
}

// Invalidation on update
async function updateMenuItem(itemId, updates) {
  const item = await db('menu_items').where({ id: itemId }).update(updates).returning('*');

  // Invalidate restaurant cache
  await redis.del(`restaurant:${item.restaurant_id}:full`);

  return item[0];
}
```

### Write-Through for Driver Locations

```javascript
// Driver location uses write-through (always write to cache first)
async function updateDriverLocation(driverId, lat, lon) {
  const pipeline = redis.pipeline();

  // Update geo index (primary query path)
  pipeline.geoadd('driver_locations', lon, lat, driverId.toString());

  // Update driver hash with timestamp
  pipeline.hset(`driver:${driverId}`, {
    lat: lat.toString(),
    lon: lon.toString(),
    updated_at: Date.now().toString()
  });

  // Auto-expire if driver stops sending updates (30 seconds)
  pipeline.expire(`driver:${driverId}`, 30);

  await pipeline.exec();

  // Async write to PostgreSQL for history (non-blocking)
  setImmediate(async () => {
    await db('driver_locations').insert({
      driver_id: driverId,
      location: db.raw(`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`),
      recorded_at: new Date()
    });
  });
}
```

### Geo-Based Cache for Nearby Restaurants

```javascript
// Cache nearby restaurants by geohash cell (reduces DB queries)
async function getNearbyRestaurants(lat, lon, radiusKm) {
  // Use geohash precision 5 (~5km cells) for cache key
  const geohash = ngeohash.encode(lat, lon, 5);
  const cacheKey = `nearby:${geohash}:${radiusKm}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Query PostGIS for restaurants in radius
  const restaurants = await db('restaurants')
    .select('*')
    .whereRaw(
      `ST_DWithin(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)`,
      [lon, lat, radiusKm * 1000]
    )
    .where({ is_open: true })
    .orderByRaw(`location <-> ST_SetSRID(ST_MakePoint(?, ?), 4326)`, [lon, lat])
    .limit(50);

  // Cache for 2 minutes (balance freshness vs DB load)
  await redis.setex(cacheKey, 120, JSON.stringify(restaurants));

  return restaurants;
}
```

### CDN Configuration for Static Assets

```javascript
// Example: Generating versioned URLs for cache-busting
function getMenuImageUrl(imageKey, version) {
  // Version changes when image is updated, forcing CDN refresh
  return `https://cdn.doordash-local.com/images/${imageKey}?v=${version}`;
}

// CDN cache headers (set by MinIO/S3 or reverse proxy)
// Cache-Control: public, max-age=3600
// ETag: "<content-hash>"
```

---

## Observability

### Metrics Collection (Prometheus)

Key metrics exposed at `/metrics` endpoint on each service:

**Order Service Metrics:**
```javascript
const promClient = require('prom-client');

// Request latency histogram
const httpDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

// Order state counters
const orderStateCounter = new promClient.Counter({
  name: 'orders_total',
  help: 'Total orders by status',
  labelNames: ['status', 'restaurant_id']
});

// Active orders gauge
const activeOrdersGauge = new promClient.Gauge({
  name: 'orders_active',
  help: 'Currently active orders by status',
  labelNames: ['status']
});

// Matching latency
const matchLatency = new promClient.Histogram({
  name: 'driver_match_duration_seconds',
  help: 'Time to match driver to order',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
});
```

**Location Service Metrics:**
```javascript
// Driver location update rate
const locationUpdates = new promClient.Counter({
  name: 'driver_location_updates_total',
  help: 'Total driver location updates'
});

// Geo query latency
const geoQueryLatency = new promClient.Histogram({
  name: 'geo_query_duration_seconds',
  help: 'Redis geo query latency',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
});

// Active drivers gauge
const activeDriversGauge = new promClient.Gauge({
  name: 'drivers_active',
  help: 'Number of active drivers'
});
```

### SLI/SLO Definitions

| SLI | Target SLO | Alert Threshold |
|-----|------------|-----------------|
| Order API p99 latency | < 200ms | > 500ms for 5 min |
| Order placement success rate | > 99.9% | < 99% for 2 min |
| Driver location update latency (p95) | < 50ms | > 100ms for 5 min |
| Driver match time (p95) | < 30s | > 60s for 5 min |
| WebSocket connection success | > 99.5% | < 98% for 5 min |
| Kafka consumer lag | < 1000 messages | > 5000 for 5 min |

### Grafana Dashboard Panels

**Recommended dashboards for local development:**

1. **Order Flow Dashboard:**
   - Orders per minute (by status)
   - Order completion rate
   - Average time per status stage
   - Failed/cancelled orders

2. **Driver Operations Dashboard:**
   - Active drivers count
   - Location updates per second
   - Match success rate
   - Average delivery time

3. **System Health Dashboard:**
   - Request latency heatmap
   - Error rate by endpoint
   - PostgreSQL connection pool usage
   - Valkey memory and hit rate
   - Kafka consumer lag

### Structured Logging

```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'order-service',
    version: process.env.APP_VERSION || 'dev'
  }
});

// Request logging middleware
function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  req.log = logger.child({ requestId, path: req.path, method: req.method });

  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      duration: Date.now() - start,
      userId: req.user?.id
    }, 'request completed');
  });

  next();
}

// Business event logging
async function logOrderEvent(orderId, event, details) {
  logger.info({
    event,
    orderId,
    ...details,
    timestamp: new Date().toISOString()
  }, `Order ${event}`);
}
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { trace } = require('@opentelemetry/api');

const tracer = trace.getTracer('doordash-order-service');

async function createOrder(orderData) {
  return tracer.startActiveSpan('createOrder', async (span) => {
    try {
      span.setAttribute('customer.id', orderData.customerId);
      span.setAttribute('restaurant.id', orderData.restaurantId);

      // Nested span for database operation
      const order = await tracer.startActiveSpan('db.insertOrder', async (dbSpan) => {
        const result = await db('orders').insert(orderData).returning('*');
        dbSpan.setAttribute('db.rows_affected', 1);
        dbSpan.end();
        return result[0];
      });

      // Nested span for Kafka publish
      await tracer.startActiveSpan('kafka.publishOrderCreated', async (kafkaSpan) => {
        await kafka.send('order_events', { type: 'ORDER_CREATED', order });
        kafkaSpan.end();
      });

      span.setAttribute('order.id', order.id);
      return order;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: 2, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### Audit Logging

Critical business operations are logged to a separate audit table:

```sql
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  actor_type VARCHAR(20) NOT NULL, -- 'customer', 'driver', 'restaurant', 'system'
  actor_id INTEGER,
  changes JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
```

```javascript
async function auditLog(event) {
  await db('audit_log').insert({
    event_type: event.type,          // 'ORDER_CREATED', 'STATUS_CHANGED', 'REFUND_ISSUED'
    entity_type: event.entityType,   // 'order', 'driver', 'restaurant'
    entity_id: event.entityId,
    actor_type: event.actorType,
    actor_id: event.actorId,
    changes: event.changes,          // { before: {...}, after: {...} }
    ip_address: event.ip,
    user_agent: event.userAgent
  });
}

// Usage in order cancellation
async function cancelOrder(orderId, reason, actor) {
  const order = await db('orders').where({ id: orderId }).first();

  await db('orders').where({ id: orderId }).update({
    status: 'CANCELLED',
    cancelled_at: new Date(),
    cancellation_reason: reason
  });

  await auditLog({
    type: 'ORDER_CANCELLED',
    entityType: 'order',
    entityId: orderId,
    actorType: actor.type,
    actorId: actor.id,
    changes: {
      before: { status: order.status },
      after: { status: 'CANCELLED', reason }
    },
    ip: actor.ip,
    userAgent: actor.userAgent
  });
}
```

### Alert Rules (Prometheus Alertmanager)

```yaml
# alerts.yml - Example alert rules for local development
groups:
  - name: doordash-alerts
    rules:
      - alert: HighOrderLatency
        expr: histogram_quantile(0.99, http_request_duration_seconds_bucket{route="/api/orders"}) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Order API p99 latency above 500ms"

      - alert: OrderPlacementFailures
        expr: rate(orders_total{status="failed"}[5m]) / rate(orders_total[5m]) > 0.01
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Order failure rate above 1%"

      - alert: KafkaConsumerLag
        expr: kafka_consumer_lag > 5000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka consumer lag exceeds 5000 messages"

      - alert: NoActiveDrivers
        expr: drivers_active == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "No active drivers available"
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Location store | Valkey geo | PostgreSQL PostGIS | Speed for updates |
| Matching | Score-based | Auction | Simpler, predictable |
| ETA | Multi-factor | ML model | Interpretable |
| Events | Kafka | Direct push | Decoupling, replay |
