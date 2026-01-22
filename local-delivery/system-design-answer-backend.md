# Local Delivery Service - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design a local delivery platform like DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking with geo-indexing, efficient driver-order matching with scoring algorithms, route optimization for multi-stop deliveries, and handling the three-sided marketplace dynamics between customers, merchants, and drivers.

## Requirements Clarification

### Functional Requirements
- **Order placement**: Customers order from local merchants with item customization
- **Driver matching**: Match orders to nearby available drivers using scoring algorithm
- **Real-time tracking**: Live driver location and ETA updates via WebSocket
- **Route optimization**: Efficient routing for single and multi-stop deliveries
- **Notifications**: Order status updates to all parties
- **Ratings**: Two-way ratings for drivers and customers

### Non-Functional Requirements
- **Latency**: Driver match within 30 seconds, location updates every 3 seconds
- **Scale**: 1M orders/day, 100K concurrent drivers
- **Availability**: 99.99% for order placement
- **Accuracy**: ETA within 3 minutes 90% of the time

### Scale Estimates
- **Peak orders**: 35 orders/second (3x average during lunch/dinner)
- **Location updates**: 10,000 updates/second (30K drivers x 3-second intervals)
- **Storage**: 5GB/day orders, 86GB/day location history

## High-Level Architecture

```
                                    +-----------------------------+
                                    |       Client Apps           |
                                    | (Customer, Driver, Admin)   |
                                    +-------------+---------------+
                                                  |
                                       +----------+----------+
                                       |                     |
                                  HTTPS|                     |WebSocket
                                       |                     |
                            +----------v---------+   +-------v--------+
                            |    API Gateway     |   |   Real-time    |
                            |                    |   |    Gateway     |
                            +----------+---------+   +-------+--------+
                                       |                     |
        +------------------------------+---------------------+---------------+
        |                              |                     |               |
+-------v-------+           +----------v----------+   +------v------+       |
| Order Service |           |  Location Service   |   |  Tracking   |       |
|               |           |                     |   |  Service    |       |
| - Create      |           | - Driver positions  |   |             |       |
| - State machine|          | - Geo indexing      |   | - Pub/Sub   |       |
| - History     |           | - Nearby search     |   | - ETA       |       |
+-------+-------+           +----------+----------+   +-------------+       |
        |                              |                                     |
        |                   +----------+----------+                          |
        |                   |                     |                          |
        |            +------v------+      +-------v------+                   |
        |            |    Redis    |      |  TimeSeries  |                   |
        |            | (Geo Index) |      |     DB       |                   |
        |            +-------------+      +--------------+                   |
        |                                                                    |
        +------------------------------------+-------------------------------+
                                             |
                              +--------------v--------------+
                              |         PostgreSQL          |
                              |  (Orders, Users, Merchants) |
                              +-----------------------------+
```

## Deep Dives

### 1. PostgreSQL Schema Design

The schema handles the three-sided marketplace with 13 interconnected tables:

**Core Tables with Relationships:**

```sql
-- Users (customers, drivers, merchants, admin)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'driver', 'merchant', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drivers extends users via same UUID (1:1 relationship)
CREATE TABLE drivers (
  id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('bicycle', 'motorcycle', 'car', 'van')),
  license_plate VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy')),
  rating DECIMAL(3,2) DEFAULT 5.00,
  total_deliveries INTEGER DEFAULT 0,
  acceptance_rate DECIMAL(5,4) DEFAULT 1.0000,
  current_lat DECIMAL(10,8),
  current_lng DECIMAL(11,8),
  location_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders with full lifecycle tracking
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'confirmed', 'preparing', 'ready_for_pickup',
    'driver_assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled'
  )),
  delivery_address TEXT NOT NULL,
  delivery_lat DECIMAL(10,8) NOT NULL,
  delivery_lng DECIMAL(11,8) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  tip DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) NOT NULL,
  estimated_delivery_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  archived_at TIMESTAMP,
  retention_days INTEGER DEFAULT 90
);
```

**Why ON DELETE SET NULL for Orders?**

Orders use `SET NULL` for customer_id, merchant_id, and driver_id to preserve order history even if the associated entity is deleted. This is critical for:
- Financial auditing (orders remain queryable)
- Dispute resolution
- Historical analytics

**Driver Offers Table for Sequential Matching:**

```sql
CREATE TABLE driver_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  offered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  responded_at TIMESTAMP
);
```

**Performance Indexes:**

```sql
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_driver ON orders(driver_id) WHERE status IN ('driver_assigned', 'picked_up', 'in_transit');
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_drivers_status ON drivers(status);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lng) WHERE status = 'available';
```

### 2. Redis Geo-Indexing for Driver Location

Redis GEOADD/GEORADIUS provides sub-millisecond nearby driver queries:

```typescript
// Store driver location with GEOADD
async function updateDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  // GEOADD for spatial indexing (note: Redis uses lng, lat order)
  await redis.geoadd('drivers:locations', lng, lat, driverId);

  // Store metadata in hash for quick access
  await redis.hset(`driver:${driverId}`, {
    lat: lat.toString(),
    lng: lng.toString(),
    updated_at: Date.now().toString(),
    status: 'available'
  });

  // Publish for real-time tracking subscribers
  await redis.publish(`driver:${driverId}:location`, JSON.stringify({ lat, lng }));
}

// Find nearby drivers with GEORADIUS
async function findNearbyDrivers(
  lat: number,
  lng: number,
  radiusKm: number,
  limit: number = 10
): Promise<Driver[]> {
  // GEORADIUS returns drivers within radius, sorted by distance
  const nearbyIds = await redis.georadius(
    'drivers:locations',
    lng, lat,
    radiusKm, 'km',
    'WITHDIST',
    'ASC',
    'COUNT', limit
  );

  // Fetch metadata and filter by availability
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

**Geohash Partitioning for Scale:**

For millions of drivers, partition by geohash to distribute load:

```typescript
function getGeohashCells(lat: number, lng: number, radiusKm: number): string[] {
  // Precision based on search radius
  const precision = radiusKm < 1 ? 6 : radiusKm < 10 ? 5 : 4;

  const centerHash = geohash.encode(lat, lng, precision);
  const neighbors = geohash.neighbors(centerHash);

  return [centerHash, ...neighbors];
}

async function findDriversInArea(lat: number, lng: number, radiusKm: number) {
  const cells = getGeohashCells(lat, lng, radiusKm);

  // Query each geohash cell's Redis key in parallel
  const results = await Promise.all(
    cells.map(cell =>
      redis.georadius(`drivers:geo:${cell}`, lng, lat, radiusKm, 'km')
    )
  );

  return results.flat();
}
```

**Redis Data Structures:**

```
# Driver locations (geo index)
drivers:locations          -> GEOADD (lng, lat, driver_id)
drivers:geo:{geohash}      -> GEOADD (partitioned by geohash)

# Driver metadata
driver:{id}                -> HASH (lat, lng, status, updated_at)

# Active orders by driver
driver:{id}:orders         -> SET [order_ids]

# Session storage
session:{token}            -> JSON {userId, expiresAt}

# Real-time location pubsub
driver:{id}:location       -> PUBSUB channel
order:{id}:status          -> PUBSUB channel
```

### 3. Driver Matching Algorithm

Multi-factor scoring considers distance, rating, acceptance rate, and current load:

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
  // 1. Get nearby available drivers (5km radius)
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
      const stats = await getDriverStats(driver.id);

      // Distance score (closer is better) - 40% weight
      const distanceScore = Math.max(0, 1 - (driver.distance / 5));

      // Rating score (normalized 0-1) - 25% weight
      const ratingScore = stats.rating / 5;

      // Acceptance rate - 20% weight
      const acceptanceScore = stats.acceptance_rate;

      // Load balancing (fewer orders = better) - 15% weight
      const loadScore = Math.max(0, 1 - (stats.current_orders / 3));

      // Weighted combination
      const totalScore =
        distanceScore * 0.4 +
        ratingScore * 0.25 +
        acceptanceScore * 0.2 +
        loadScore * 0.15;

      return { driverId: driver.id, totalScore, factors: { distance: distanceScore, rating: ratingScore, acceptance_rate: acceptanceScore, current_orders: stats.current_orders } };
    })
  );

  // 3. Sort by score and return best
  scores.sort((a, b) => b.totalScore - a.totalScore);
  return scores[0] ? await getDriver(scores[0].driverId) : null;
}
```

**Sequential Offer Flow with Timeout:**

```typescript
async function offerOrderToDrivers(order: Order): Promise<boolean> {
  const maxAttempts = 5;
  const offerTimeout = 30000; // 30 seconds
  const excludeDrivers = new Set<string>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const driver = await findBestDriver(order, excludeDrivers);

    if (!driver) {
      await sleep(10000); // Wait before retry
      continue;
    }

    // Create offer record
    await db.query(`
      INSERT INTO driver_offers (order_id, driver_id, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 seconds')
    `, [order.id, driver.id]);

    // Send offer via WebSocket
    await sendDriverOffer(driver.id, order);

    // Wait for response with timeout
    const response = await waitForDriverResponse(driver.id, order.id, offerTimeout);

    if (response === 'accepted') {
      await assignOrderToDriver(order, driver);
      return true;
    }

    // Driver rejected or timed out, try next
    excludeDrivers.add(driver.id);
  }

  await notifyCustomer(order.id, 'no_driver_available');
  return false;
}
```

### 4. Idempotency for Order Creation

Prevent duplicate orders on network retries:

```typescript
async function withIdempotency<T>(
  key: string | undefined,
  userId: string,
  operation: string,
  execute: () => Promise<T>
): Promise<{ result: T; cached: boolean }> {
  if (!key) {
    return { result: await execute(), cached: false };
  }

  // Check for existing key
  const existing = await db.query(`
    SELECT response, status FROM idempotency_keys
    WHERE key = $1 AND user_id = $2
  `, [key, userId]);

  if (existing.rows[0]?.status === 'completed') {
    return { result: existing.rows[0].response, cached: true };
  }

  // Create pending record
  await db.query(`
    INSERT INTO idempotency_keys (key, user_id, operation, status, expires_at)
    VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '24 hours')
    ON CONFLICT (key) DO NOTHING
  `, [key, userId, operation]);

  // Execute operation
  const result = await execute();

  // Store response
  await db.query(`
    UPDATE idempotency_keys
    SET status = 'completed', response = $1
    WHERE key = $2
  `, [JSON.stringify(result), key]);

  return { result, cached: false };
}
```

**Usage in order creation:**

```typescript
router.post('/orders', async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;

  const { result, cached } = await withIdempotency(
    idempotencyKey,
    req.userId,
    'create_order',
    async () => createOrder(req.userId, req.body)
  );

  res.status(cached ? 200 : 201).json(result);
});
```

### 5. Order Status Transitions with Optimistic Locking

Prevent race conditions in status updates:

```typescript
async function updateOrderStatus(
  orderId: string,
  expectedStatus: string,
  newStatus: string
): Promise<boolean> {
  const result = await db.query(`
    UPDATE orders
    SET status = $1, updated_at = NOW()
    WHERE id = $2 AND status = $3
    RETURNING id
  `, [newStatus, orderId, expectedStatus]);

  if (result.rowCount === 0) {
    // Status was already changed by another process
    return false;
  }

  // Publish status change for real-time subscribers
  await redis.publish(`order:${orderId}:status`, JSON.stringify({
    status: newStatus,
    timestamp: new Date().toISOString()
  }));

  return true;
}

// Example: Driver picks up order
async function pickupOrder(driverId: string, orderId: string): Promise<void> {
  const success = await updateOrderStatus(orderId, 'preparing', 'picked_up');

  if (!success) {
    throw new Error('Order cannot be picked up - invalid status');
  }

  await db.query(`
    UPDATE orders SET picked_up_at = NOW() WHERE id = $1
  `, [orderId]);
}
```

### 6. Circuit Breaker for Matching Service

Protect the system when dependencies fail:

```typescript
interface CircuitBreakerConfig {
  timeout: number;
  errorThresholdPercentage: number;
  volumeThreshold: number;
  resetTimeout: number;
}

const matchingCircuitBreaker = createCircuitBreaker(
  'driver-matching',
  async (orderId: string) => startDriverMatching(orderId),
  {
    timeout: 180000,              // 3 minutes per attempt
    errorThresholdPercentage: 50, // Open after 50% failures
    volumeThreshold: 3,           // Minimum 3 requests before tripping
    resetTimeout: 30000,          // Test recovery after 30 seconds
  }
);

// Fallback when circuit is open
matchingCircuitBreaker.fallback(async (orderId: string) => {
  // Order stays in 'pending' status for manual intervention
  console.log(`Circuit open: order ${orderId} queued for retry`);
  return false;
});
```

**Circuit States:**
1. **Closed**: All requests pass through, failures counted
2. **Open**: Requests fail immediately with fallback
3. **Half-Open**: One request allowed to test recovery

### 7. Data Retention Policies

Tiered storage for cost-effective data lifecycle:

```sql
-- Retention policies table
CREATE TABLE retention_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name VARCHAR(100) UNIQUE NOT NULL,
  hot_storage_days INTEGER NOT NULL DEFAULT 30,
  warm_storage_days INTEGER NOT NULL DEFAULT 365,
  archive_enabled BOOLEAN DEFAULT true,
  last_cleanup_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert policies
INSERT INTO retention_policies (table_name, hot_storage_days, warm_storage_days)
VALUES
  ('orders', 30, 365),
  ('driver_location_history', 7, 30),
  ('idempotency_keys', 1, 1),
  ('sessions', 1, 1);
```

**Cleanup Job:**

```typescript
async function runRetentionCleanup(): Promise<void> {
  // Clean up expired idempotency keys
  await db.query(`
    DELETE FROM idempotency_keys
    WHERE expires_at < NOW()
  `);

  // Archive old orders (30+ days)
  const oldOrders = await db.query(`
    SELECT * FROM orders
    WHERE created_at < NOW() - INTERVAL '30 days'
    AND archived_at IS NULL
  `);

  for (const order of oldOrders.rows) {
    // Export to MinIO/S3
    await uploadToArchive('orders', order);

    // Mark as archived
    await db.query(`
      UPDATE orders SET archived_at = NOW()
      WHERE id = $1
    `, [order.id]);
  }

  // Delete old location history
  await db.query(`
    DELETE FROM driver_location_history
    WHERE recorded_at < NOW() - INTERVAL '30 days'
  `);
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geo-indexing | Redis GEOADD | PostgreSQL PostGIS | Sub-ms queries for real-time matching; PostGIS better for analytics |
| Location updates | 3-second interval | 1-second / 5-second | Balance accuracy vs. bandwidth/battery drain |
| Driver offers | Sequential | Broadcast to all | Fairer to drivers, avoids race conditions |
| Order matching | Scoring algorithm | First available | Multi-factor scoring improves quality and driver satisfaction |
| Idempotency | PostgreSQL table | Redis with TTL | ACID guarantees for financial operations |
| Authentication | Session tokens + Redis | JWT | Instant revocation, simpler refresh flow |
| Partitioning | Geohash cells | City-based | Finer granularity, better edge case handling |

## Future Enhancements

1. **Surge pricing**: Monitor demand/supply ratio by zone, apply dynamic multipliers
2. **Multi-stop TSP optimization**: Solve traveling salesman for batched deliveries
3. **ML demand prediction**: Train model on historical data for driver positioning
4. **Real-time traffic integration**: Use Google Maps traffic API for accurate ETAs
5. **PostgreSQL partitioning**: Partition orders by month for efficient archival
6. **Read replicas**: Scale read-heavy endpoints (merchant browsing, order history)
