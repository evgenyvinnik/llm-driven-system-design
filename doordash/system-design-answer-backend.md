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
┌─────────────────────────────────────────────────────────────────┐
│                       API Gateway                                │
│            Rate limiting, auth, request routing                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Order Service │    │Location Service│    │ Match Service │
│               │    │               │    │               │
│ - CRUD orders │    │ - GPS ingest  │    │ - Scoring     │
│ - State machine│   │ - Geo queries │    │ - Assignment  │
│ - Idempotency │    │ - ETA calc    │    │ - Batching    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────┬─────────────┬─────────────────────────────────────┤
│ PostgreSQL  │   Valkey    │           Kafka                     │
│ - Orders    │ - Locations │ - Order events                      │
│ - Menus     │ - Sessions  │ - Location updates                  │
│ - Users     │ - Geo index │ - Dispatch events                   │
│ - Audit     │ - Cache     │                                     │
└─────────────┴─────────────┴─────────────────────────────────────┘
```

### Why This Architecture?

**Valkey for Location**: Driver locations update every 10 seconds. We need sub-millisecond reads for matching and geo queries. Valkey's GEOADD/GEORADIUS/GEOSEARCH commands are optimized for spatial queries.

**Kafka for Events**: Order status changes need to reach multiple consumers (customer notifications, restaurant dashboard, analytics). Kafka provides reliable pub/sub with ordering guarantees and replay capability.

**Separate Match Service**: Matching algorithm is computationally intensive. Isolating it allows independent scaling during peak hours.

---

## Step 3: Database Schema Design (5 minutes)

### Core Tables

```sql
-- Restaurants with PostGIS location
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

CREATE INDEX idx_restaurants_location ON restaurants USING GIST(location);
CREATE INDEX idx_restaurants_open ON restaurants(is_open) WHERE is_open = TRUE;

-- Menu items with foreign key
CREATE TABLE menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category VARCHAR(50),
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);

-- Drivers with vehicle info
CREATE TABLE drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  vehicle_type VARCHAR(50),
  is_active BOOLEAN DEFAULT FALSE,
  rating DECIMAL(2, 1) DEFAULT 5.0,
  total_deliveries INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Orders with JSONB delivery address
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id),
  restaurant_id INTEGER REFERENCES restaurants(id),
  driver_id INTEGER REFERENCES drivers(id),
  status VARCHAR(30) DEFAULT 'PLACED',
  total DECIMAL(10, 2),
  delivery_fee DECIMAL(10, 2),
  delivery_address JSONB NOT NULL,
  estimated_delivery_at TIMESTAMP,
  placed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  preparing_at TIMESTAMP,
  ready_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP,
  version INTEGER DEFAULT 1
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_driver ON orders(driver_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_restaurant_status ON orders(restaurant_id, status);

-- Order items junction table
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id),
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  special_instructions TEXT
);

-- Driver location history (partitioned by time)
CREATE TABLE driver_locations (
  driver_id INTEGER REFERENCES drivers(id),
  location GEOGRAPHY(POINT, 4326),
  recorded_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);

-- Audit log for order disputes
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  actor_type VARCHAR(20) NOT NULL,
  actor_id INTEGER,
  changes JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
```

### Why PostgreSQL + PostGIS for History?

PostGIS handles complex spatial queries for historical analysis (driver routes, delivery patterns). For real-time queries, we use Valkey geo commands which are 10-100x faster.

---

## Step 4: Real-Time Driver Location System (10 minutes)

### Valkey Geo Commands for Location Storage

```javascript
// Driver sends location every 10 seconds
async function updateDriverLocation(driverId, lat, lon) {
  const pipeline = redis.pipeline();

  // 1. Store in geo index for spatial queries
  pipeline.geoadd('driver_locations', lon, lat, driverId.toString());

  // 2. Store metadata in hash
  pipeline.hset(`driver:${driverId}`, {
    lat: lat.toString(),
    lon: lon.toString(),
    updated_at: Date.now().toString(),
    status: 'active'
  });

  // 3. Set TTL - auto-expire if driver stops sending updates
  pipeline.expire(`driver:${driverId}`, 30);

  await pipeline.exec();

  // 4. Publish for real-time tracking (customers watching orders)
  await redis.publish('driver_locations', JSON.stringify({
    driverId,
    lat,
    lon,
    timestamp: Date.now()
  }));

  // 5. Async write to PostgreSQL for history (non-blocking)
  setImmediate(async () => {
    await pool.query(
      `INSERT INTO driver_locations (driver_id, location, recorded_at)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), NOW())`,
      [driverId, lon, lat]
    );
  });
}
```

### Finding Nearby Available Drivers

```javascript
async function findNearbyDrivers(restaurantLat, restaurantLon, radiusKm = 5) {
  // GEOSEARCH returns drivers sorted by distance
  const drivers = await redis.geoSearch(
    'driver_locations',
    { longitude: restaurantLon, latitude: restaurantLat },
    { radius: radiusKm, unit: 'km' },
    { WITHDIST: true, SORT: 'ASC', COUNT: 20 }
  );

  // Filter to only available drivers
  const available = [];
  for (const { member: driverId, distance } of drivers) {
    const driverData = await redis.hgetall(`driver:${driverId}`);

    if (!driverData) continue; // Expired

    const activeOrders = await redis.get(`driver:${driverId}:order_count`) || 0;

    if (driverData.status === 'active' && parseInt(activeOrders) < 2) {
      available.push({
        id: parseInt(driverId),
        distance: parseFloat(distance),
        lat: parseFloat(driverData.lat),
        lon: parseFloat(driverData.lon),
        activeOrders: parseInt(activeOrders)
      });
    }
  }

  return available;
}
```

### Why Valkey Instead of PostgreSQL PostGIS?

| Aspect | Valkey | PostGIS |
|--------|--------|---------|
| Write latency | Sub-ms | 5-10ms |
| Updates/sec capacity | 100K+ | 10K |
| Geo query speed | Sub-ms | 10-50ms |
| Persistence | Optional | Always |
| Memory usage | Higher | Lower |

For 10K location updates per second with sub-100ms query requirements, Valkey is the right choice. We use PostGIS for historical analysis only.

---

## Step 5: Order-Driver Matching Algorithm (10 minutes)

### Multi-Factor Scoring

```javascript
function calculateMatchScore(driver, order) {
  let score = 0;

  // Factor 1: Distance to restaurant (most important - 40% weight)
  const distanceToRestaurant = haversineDistance(
    { lat: driver.lat, lon: driver.lon },
    { lat: order.restaurant.lat, lon: order.restaurant.lon }
  );
  score += Math.max(0, 100 - (distanceToRestaurant * 10)); // Closer = higher

  // Factor 2: Current order load (25% weight)
  const currentOrders = driver.activeOrders || 0;
  score -= currentOrders * 15; // Penalty for already carrying orders

  // Factor 3: Driver rating (15% weight)
  score += parseFloat(driver.rating || 5) * 5; // 5 stars = +25 points

  // Factor 4: Experience bonus (10% weight)
  score += Math.min(driver.totalDeliveries / 10, 20); // Cap at 20 points

  // Factor 5: Earnings goal fairness (10% weight)
  if (driver.dailyDeliveries < driver.earningsGoal) {
    score += 10; // Prioritize drivers who need more deliveries
  }

  // Factor 6: Route efficiency for batching
  if (currentOrders > 0) {
    const efficiency = calculateRouteEfficiency(driver.currentRoute, order);
    score += efficiency * 20; // High efficiency = good for batching
  }

  // Factor 7: Timing alignment
  const estimatedArrival = estimateDriveTime(
    { lat: driver.lat, lon: driver.lon },
    { lat: order.restaurant.lat, lon: order.restaurant.lon }
  );
  if (estimatedArrival > order.prepTimeRemaining) {
    score -= 20; // Penalty if driver arrives before food is ready
  }

  return score;
}
```

### Assignment Flow with Circuit Breaker

```javascript
const CircuitBreaker = require('opossum');

const matchingBreaker = new CircuitBreaker(performMatching, {
  timeout: 10000,      // 10 second timeout
  errorThresholdPercentage: 50,
  resetTimeout: 30000  // 30 second reset
});

matchingBreaker.fallback(() => ({
  matched: false,
  queued: true,
  message: 'Driver matching will retry shortly'
}));

async function assignOrderToDriver(orderId) {
  return matchingBreaker.fire(orderId);
}

async function performMatching(orderId) {
  const order = await getOrderWithRestaurant(orderId);

  // 1. Find nearby available drivers
  let nearbyDrivers = await findNearbyDrivers(
    order.restaurant.lat,
    order.restaurant.lon,
    5 // 5km radius
  );

  if (nearbyDrivers.length === 0) {
    // Expand radius
    nearbyDrivers = await findNearbyDrivers(
      order.restaurant.lat,
      order.restaurant.lon,
      10 // 10km radius
    );
  }

  if (nearbyDrivers.length === 0) {
    return { matched: false, queued: true };
  }

  // 2. Score each driver
  const scoredDrivers = nearbyDrivers.map(driver => ({
    driver,
    score: calculateMatchScore(driver, order)
  }));

  // 3. Sort by score descending
  scoredDrivers.sort((a, b) => b.score - a.score);

  // 4. Offer to top driver with timeout
  const result = await offerOrderToDriver(
    scoredDrivers[0].driver.id,
    orderId,
    30 // 30 second timeout for driver response
  );

  if (result.accepted) {
    await assignDriver(orderId, scoredDrivers[0].driver.id);
    return { matched: true, driverId: scoredDrivers[0].driver.id };
  }

  // 5. Try next drivers if declined
  for (const { driver } of scoredDrivers.slice(1)) {
    const offer = await offerOrderToDriver(driver.id, orderId, 20);
    if (offer.accepted) {
      await assignDriver(orderId, driver.id);
      return { matched: true, driverId: driver.id };
    }
  }

  return { matched: false, queued: true };
}
```

### Order Batching Logic

```javascript
async function checkBatchOpportunity(driverId, newOrderId) {
  const driver = await getDriverWithCurrentOrders(driverId);
  const newOrder = await getOrderWithRestaurant(newOrderId);

  // Must already have an order
  if (driver.currentOrders.length === 0) {
    return null;
  }

  // Max 2 orders per batch
  if (driver.currentOrders.length >= 2) {
    return null;
  }

  const currentOrder = driver.currentOrders[0];

  // Check restaurant proximity (within 500m)
  const restaurantDistance = haversineDistance(
    currentOrder.restaurant.location,
    newOrder.restaurant.location
  );

  if (restaurantDistance > 0.5) {
    return null;
  }

  // Check delivery route efficiency
  const routeEfficiency = calculateCombinedRouteEfficiency(
    currentOrder.deliveryAddress,
    newOrder.deliveryAddress,
    { lat: driver.lat, lon: driver.lon }
  );

  if (routeEfficiency < 0.7) {
    return null; // Less than 70% efficient
  }

  // Calculate delay to first customer
  const additionalDelay = estimateAdditionalDelay(currentOrder, newOrder);

  if (additionalDelay > 5) {
    return null; // More than 5 minutes delay
  }

  return {
    canBatch: true,
    additionalDelay,
    routeEfficiency,
    savings: calculateDriverSavings(currentOrder, newOrder)
  };
}
```

---

## Step 6: Multi-Factor ETA Calculation (5 minutes)

```javascript
async function calculateDeliveryETA(orderId) {
  const order = await getOrderWithDetails(orderId);
  const driver = order.driverId ? await getDriver(order.driverId) : null;

  // Factor 1: Time to restaurant (if driver assigned and not there yet)
  let timeToRestaurant = 0;
  if (driver && !['PICKED_UP', 'DELIVERED'].includes(order.status)) {
    timeToRestaurant = await getRouteTime(
      { lat: driver.lat, lon: driver.lon },
      order.restaurant.location
    );
  }

  // Factor 2: Food preparation time remaining
  let prepTimeRemaining = 0;
  if (['CONFIRMED', 'PREPARING'].includes(order.status)) {
    const elapsed = Date.now() - new Date(order.confirmedAt).getTime();
    const totalPrepTime = order.estimatedPrepTime || order.restaurant.prepTimeMinutes * 60 * 1000;
    prepTimeRemaining = Math.max(0, totalPrepTime - elapsed);
  }

  // Factor 3: Time from restaurant to customer
  const deliveryTime = await getRouteTime(
    order.restaurant.location,
    order.deliveryAddress
  );

  // Factor 4: Fixed buffers
  const pickupBuffer = 3 * 60 * 1000;  // 3 minutes for pickup
  const dropoffBuffer = 2 * 60 * 1000; // 2 minutes for handoff

  // Calculate total: parallel activities (driver travel + prep) + sequential
  const waitTime = Math.max(timeToRestaurant, prepTimeRemaining);
  const totalMs = waitTime + deliveryTime + pickupBuffer + dropoffBuffer;

  return {
    eta: new Date(Date.now() + totalMs),
    breakdown: {
      toRestaurant: timeToRestaurant,
      preparation: prepTimeRemaining,
      toCustomer: deliveryTime,
      buffers: pickupBuffer + dropoffBuffer
    },
    confidence: calculateConfidence(order)
  };
}

// Route time with traffic multipliers and caching
async function getRouteTime(origin, destination) {
  const cacheKey = `route:${origin.lat},${origin.lon}:${destination.lat},${destination.lon}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  // Call routing API (Google Maps, OSRM, etc.)
  const route = await routingApi.getDirections(origin, destination);

  // Apply traffic multiplier based on time of day
  const trafficMultiplier = getTrafficMultiplier(new Date());
  const adjustedTime = route.duration * trafficMultiplier;

  // Cache for 5 minutes
  await redis.setex(cacheKey, 300, JSON.stringify(adjustedTime));

  return adjustedTime;
}

function getTrafficMultiplier(time) {
  const hour = time.getHours();

  // Rush hours: 1.5x
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) {
    return 1.5;
  }

  // Lunch rush: 1.3x
  if (hour >= 11 && hour <= 13) {
    return 1.3;
  }

  return 1.0;
}
```

---

## Step 7: Order State Machine (5 minutes)

### State Transitions with Kafka Events

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
};

async function transitionOrder(orderId, action, actor, req) {
  const order = await getOrder(orderId);
  const currentState = ORDER_STATES[order.status];

  // Validate action is allowed
  if (!currentState.actions.includes(action)) {
    throw new InvalidTransitionError(
      `Invalid action ${action} for status ${order.status}`
    );
  }

  const nextStatus = getNextStatus(order.status, action);

  // Optimistic locking to prevent race conditions
  const result = await pool.query(
    `UPDATE orders
     SET status = $1,
         ${action}_at = NOW(),
         version = version + 1,
         updated_at = NOW()
     WHERE id = $2 AND version = $3
     RETURNING *`,
    [nextStatus, orderId, order.version]
  );

  if (result.rowCount === 0) {
    throw new ConflictError(
      `Order ${orderId} was modified by another process`
    );
  }

  const updatedOrder = result.rows[0];

  // Emit Kafka event for real-time updates
  await kafka.send('order_status', {
    eventId: crypto.randomUUID(),
    orderId,
    previousStatus: order.status,
    newStatus: nextStatus,
    action,
    actorId: actor.id,
    actorType: actor.type,
    timestamp: Date.now()
  });

  // Audit log
  await auditOrderStatusChange(order, nextStatus, actor, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Trigger side effects
  await handleStatusChange(orderId, order.status, nextStatus);

  return updatedOrder;
}

async function handleStatusChange(orderId, previousStatus, newStatus) {
  switch (newStatus) {
    case 'CONFIRMED':
      // Queue for driver matching
      await matchQueue.add('match_driver', { orderId }, { delay: 1000 });
      break;

    case 'READY_FOR_PICKUP':
      // Notify assigned driver
      await notificationService.notifyDriver(orderId, 'Food is ready for pickup');
      break;

    case 'PICKED_UP':
      // Notify customer with live tracking link
      await notificationService.notifyCustomer(orderId, 'Driver has picked up your order');
      break;

    case 'DELIVERED':
      // Process payment capture, schedule review request
      await paymentService.capturePayment(orderId);
      await scheduleReviewRequest(orderId, { delay: 30 * 60 * 1000 }); // 30 min
      break;
  }
}
```

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

```javascript
async function getRestaurantWithMenu(restaurantId) {
  const cacheKey = `cache:restaurant_full:${restaurantId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: query database
  const restaurant = await pool.query(
    'SELECT * FROM restaurants WHERE id = $1',
    [restaurantId]
  );
  const menuItems = await pool.query(
    'SELECT * FROM menu_items WHERE restaurant_id = $1 AND is_available = TRUE',
    [restaurantId]
  );

  const result = { ...restaurant.rows[0], menu: menuItems.rows };

  // Store in cache with 5-minute TTL
  await redis.setex(cacheKey, 300, JSON.stringify(result));

  return result;
}

// Invalidation on update
async function updateMenuItem(restaurantId, itemId, updates) {
  await pool.query(
    'UPDATE menu_items SET name = $1, price = $2 WHERE id = $3',
    [updates.name, updates.price, itemId]
  );

  // Immediately invalidate cache
  await redis.del(`cache:restaurant_full:${restaurantId}`);
}
```

---

## Step 9: Idempotency and Consistency (2 minutes)

### Order Creation with Idempotency Key

```javascript
async function createOrder(req, res) {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing X-Idempotency-Key header' });
  }

  // Check for existing request with same key
  const existing = await redis.get(`idempotency:order:${idempotencyKey}`);
  if (existing) {
    const cached = JSON.parse(existing);
    return res.status(cached.statusCode).json(cached.body);
  }

  // Process order in transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await client.query(
      `INSERT INTO orders (customer_id, restaurant_id, delivery_address, total)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, req.body.restaurantId, req.body.deliveryAddress, req.body.total]
    );

    for (const item of req.body.items) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [order.rows[0].id, item.menuItemId, item.quantity, item.price]
      );
    }

    await client.query('COMMIT');

    // Cache response for idempotency (24 hours)
    await redis.setex(
      `idempotency:order:${idempotencyKey}`,
      86400,
      JSON.stringify({ statusCode: 201, body: order.rows[0] })
    );

    return res.status(201).json(order.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## Step 10: Observability (2 minutes)

### Prometheus Metrics

```javascript
const promClient = require('prom-client');

// Request latency
const httpDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

// Order counters
const ordersTotal = new promClient.Counter({
  name: 'orders_total',
  help: 'Total orders by status',
  labelNames: ['status']
});

// Driver matching latency
const matchLatency = new promClient.Histogram({
  name: 'driver_match_duration_seconds',
  help: 'Time to match driver to order',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
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

### Structured Logging with Pino

```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'doordash-api',
    version: process.env.APP_VERSION || 'dev'
  }
});

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

---

## Closing Summary

I've designed the backend for a food delivery platform with these core systems:

1. **Real-Time Location Tracking**: Valkey geo commands (GEOADD, GEOSEARCH) for storing and querying 10K driver location updates per second with sub-ms latency

2. **Order-Driver Matching**: Multi-factor scoring algorithm considering distance, driver load, ratings, experience, and route efficiency with circuit breaker protection

3. **ETA Calculation**: Parallel computation of prep time and driver travel, with traffic multipliers and 5-minute route caching

4. **Order State Machine**: Event-driven status flow with optimistic locking, Kafka publishing for real-time client updates, and comprehensive audit logging

5. **Caching Strategy**: Cache-aside for read-heavy data (menus), write-through for location data, with explicit invalidation on updates

**Key Backend Trade-offs:**
- Valkey over PostGIS for real-time queries (speed over durability for ephemeral data)
- Score-based over auction matching (simplicity and speed over maximum optimization)
- Multi-factor ETA over ML (interpretability and debuggability)
- Kafka over direct push (decoupling, replay capability, multiple consumers)
