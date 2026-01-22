# Uber - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"I'll be designing a ride-hailing platform like Uber that connects riders with drivers in real-time. As a backend engineer, I'll focus on the geospatial indexing layer, real-time matching algorithms, database design, queue architecture for handling surge load, and the consistency guarantees needed for financial transactions. This is a challenging system because it requires sub-second geo-matching, handling millions of location updates per second, and ensuring exactly-once semantics for payment processing."

---

## 1. Requirements Clarification (3-4 minutes)

### Backend-Focused Functional Requirements

1. **Location Ingestion Pipeline**
   - Ingest driver location updates at massive scale (1.67M updates/second at peak)
   - Maintain real-time geospatial index with sub-100ms query latency
   - Handle stale update detection and filtering

2. **Matching Service**
   - Find nearby available drivers within configurable radius
   - Score drivers by ETA, rating, and acceptance probability
   - Support both greedy and batch matching algorithms

3. **Ride State Machine**
   - Manage ride lifecycle: requested -> matched -> arrived -> in_progress -> completed
   - Ensure atomic state transitions with optimistic locking
   - Prevent double-booking of drivers

4. **Surge Pricing Engine**
   - Calculate supply/demand ratio per geographic zone
   - Update surge multipliers in real-time (every 1-2 minutes)
   - Smooth transitions at zone boundaries

5. **Payment Processing**
   - Capture payments with strong consistency
   - Idempotency for retry-safe operations
   - Circuit breaker for external payment gateway

### Non-Functional Requirements (Backend Perspective)

| Requirement | Target | Justification |
|-------------|--------|---------------|
| Matching latency | < 100ms | Real-time UX expectation |
| Location update throughput | 1.67M/sec | 5M drivers x 1 update/3 sec |
| Ride state consistency | Strong | Financial and safety implications |
| Location consistency | Eventual (3s stale OK) | Hot path, acceptable delay |
| System availability | 99.99% | Riders stranded is unacceptable |
| Payment idempotency | Exactly-once | Financial correctness |

---

## 2. Scale Estimation (2-3 minutes)

### Traffic Analysis

```
Driver Location Updates:
- 5 million active drivers at peak
- Location sent every 3 seconds
- 5M / 3 = 1.67 million updates/second

Ride Requests:
- 5 million rides per day
- Peak: 10x average = ~580 rides/second
- Each request triggers: geo query + matching + state updates

Storage:
- Ride history: 5M rides/day x 1KB = 5GB/day
- Location logs (sampled): 167MB/sec raw, ~10GB/day sampled
- User/driver metadata: ~1GB static

Connections:
- 5M drivers with WebSocket connections
- ~50K WebSocket connections per server
- ~100 WebSocket servers needed
```

### Database Load

```
PostgreSQL (transactional):
- Writes: ~1000 ride state changes/sec at peak
- Reads: ~5000 ride lookups/sec
- Connection pool: 100 connections per API server

Redis (real-time state):
- GEOADD: 1.67M/sec (sharded across cluster)
- GEORADIUS: ~600/sec (one per ride request)
- GET/SET: ~50K/sec (driver status, surge data)
```

---

## 3. High-Level Architecture (5 minutes)

```
                                 ┌─────────────────┐
                                 │   CDN (Maps)    │
                                 └────────┬────────┘
                                          │
    ┌──────────────┐              ┌───────┴────────┐              ┌──────────────┐
    │  Rider App   │──────────────│  API Gateway   │──────────────│  Driver App  │
    └──────────────┘              │  + Load Balancer│              └──────────────┘
                                  └───────┬────────┘
                                          │
           ┌──────────────────────────────┼──────────────────────────────┐
           │                              │                              │
           ▼                              ▼                              ▼
    ┌──────────────┐              ┌──────────────┐              ┌──────────────┐
    │ Ride Service │              │Location Service│             │ Pricing Svc  │
    │              │              │              │              │              │
    │ - Booking    │              │ - Geo index  │              │ - Fare calc  │
    │ - State mgmt │              │ - GEOADD     │              │ - Surge      │
    │ - Idempotency│              │ - GEORADIUS  │              │ - Estimates  │
    └──────┬───────┘              └──────┬───────┘              └──────────────┘
           │                              │
           │                              ▼
           │                      ┌──────────────┐
           │                      │ Redis Cluster │
           │                      │   (Geo)      │
           │                      │              │
           │                      │ - Driver locs│
           │                      │ - Status     │
           └──────────────────────┤ - Surge data │
                                  └──────────────┘
                                          │
    ┌─────────────────────────────────────┼─────────────────────────────────────┐
    │                                     │                                     │
    ▼                                     ▼                                     ▼
┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
│  PostgreSQL  │                  │   RabbitMQ   │                  │   WebSocket  │
│              │                  │              │                  │   Server     │
│ - Users      │                  │ - Matching   │                  │              │
│ - Rides      │                  │ - Notif.     │                  │ - Real-time  │
│ - Payments   │                  │ - Billing    │                  │   updates    │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

### Service Responsibilities

| Service | Responsibilities | Scaling Strategy |
|---------|------------------|------------------|
| Location Service | Geo updates, nearby queries | Shard by geohash prefix |
| Ride Service | State machine, matching coordination | Stateless, horizontal |
| Pricing Service | Fare calculation, surge | Cache-heavy, read replicas |
| Matching Workers | Async driver selection | Scale with queue depth |
| WebSocket Server | Real-time push | Shard by user ID hash |

---

## 4. Deep Dive: Geospatial Indexing (8-10 minutes)

### Redis Geo Commands Architecture

Redis provides native geospatial commands that are ideal for driver location tracking:

```javascript
// Store driver location
await redis.geoadd('drivers:available', longitude, latitude, driverId);

// Find nearby drivers
const drivers = await redis.georadius(
  'drivers:available',
  targetLng, targetLat,
  5, 'km',
  'WITHCOORD', 'WITHDIST',
  'COUNT', 20,
  'ASC'
);
```

**Internal Structure:**
- Redis Geo uses a sorted set with geohash as score
- Geohash is a 52-bit integer encoding lat/lng
- GEORADIUS performs efficient range scan on sorted set
- O(N+log(M)) where N=results, M=total entries

### Sharding Strategy

With 5 million drivers, a single Redis instance cannot handle the load:

```javascript
// Shard by 3-character geohash prefix (~156km cells)
function getLocationShard(lat, lng) {
  const geohash3 = encodeGeohash(lat, lng, 3);
  return SHARD_MAP[geohash3] || consistentHash(geohash3, NUM_SHARDS);
}

// Update driver location
async function updateDriverLocation(driverId, lat, lng) {
  const shard = getLocationShard(lat, lng);
  const redis = redisCluster.getNode(shard);

  // Atomic pipeline
  const pipeline = redis.pipeline();
  pipeline.geoadd('drivers:available', lng, lat, driverId);
  pipeline.hset(`driver:location:${driverId}`, {
    lat, lng, timestamp: Date.now()
  });
  pipeline.expire(`driver:location:${driverId}`, 60);
  await pipeline.exec();
}
```

**Sharding Considerations:**
- City-level shards (NYC, SF, LA) for traffic isolation
- Cross-shard queries rare (drivers don't cross 156km in seconds)
- Consistent hashing for shard assignment changes

### Stale Update Handling

```javascript
// Reject updates older than 10 seconds
async function processLocationUpdate(driverId, lat, lng, clientTimestamp) {
  const now = Date.now();

  // Reject stale updates
  if (now - clientTimestamp > 10000) {
    metrics.staleUpdatesDropped.inc();
    return { accepted: false, reason: 'stale' };
  }

  // Check for out-of-order updates
  const existing = await redis.hget(`driver:location:${driverId}`, 'timestamp');
  if (existing && parseInt(existing) > clientTimestamp) {
    return { accepted: false, reason: 'out_of_order' };
  }

  await updateDriverLocation(driverId, lat, lng);
  return { accepted: true };
}
```

### Geo Query Optimization

```javascript
async function findNearbyDrivers(lat, lng, vehicleType, maxRadius = 5) {
  // Start with small radius, expand if needed
  const radii = [1, 2, 5, 10]; // km

  for (const radius of radii) {
    if (radius > maxRadius) break;

    const drivers = await redisGeoCircuitBreaker.fire(
      'georadius',
      `drivers:available:${vehicleType}`,
      lng, lat, radius, 'km',
      'WITHCOORD', 'WITHDIST', 'COUNT', 20, 'ASC'
    );

    if (drivers.length >= 3) {
      return drivers;
    }
  }

  return []; // No drivers found
}
```

---

## 5. Deep Dive: Matching Algorithm (6-7 minutes)

### Scoring Function

```javascript
function computeMatchScore(driver, riderLocation) {
  // ETA estimation (distance-based approximation)
  const distanceKm = driver.distance;
  const estimatedEtaMinutes = distanceKm * 2; // ~30 km/h city speed

  // Normalize ETA (0-1, lower is better)
  const etaScore = Math.max(0, 1 - estimatedEtaMinutes / 30);

  // Rating score (3.0-5.0 range normalized to 0-1)
  const ratingScore = (driver.rating - 3.0) / 2.0;

  // Acceptance rate (historical data)
  const acceptanceScore = driver.acceptanceRate || 0.8;

  // Weighted combination
  const weights = { eta: 0.5, rating: 0.3, acceptance: 0.2 };

  return (
    weights.eta * etaScore +
    weights.rating * ratingScore +
    weights.acceptance * acceptanceScore
  );
}
```

### Greedy Matching (Default)

```javascript
async function greedyMatch(rideRequest) {
  const { pickupLat, pickupLng, vehicleType } = rideRequest;

  // Find candidates
  const candidates = await findNearbyDrivers(pickupLat, pickupLng, vehicleType);

  if (candidates.length === 0) {
    return { success: false, reason: 'no_drivers' };
  }

  // Score and sort
  const scored = await Promise.all(
    candidates.map(async (driver) => {
      const driverInfo = await getDriverInfo(driver.memberId);
      return {
        ...driver,
        ...driverInfo,
        score: computeMatchScore({ ...driver, ...driverInfo })
      };
    })
  );

  scored.sort((a, b) => b.score - a.score);

  // Try to assign top candidate
  for (const candidate of scored) {
    const acquired = await tryAcquireDriver(candidate.id, rideRequest.id);
    if (acquired) {
      return { success: true, driver: candidate };
    }
  }

  return { success: false, reason: 'all_drivers_busy' };
}
```

### Driver Acquisition with Optimistic Locking

```javascript
async function tryAcquireDriver(driverId, rideId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Optimistic lock on driver
    const result = await client.query(`
      UPDATE drivers
      SET is_available = false, current_ride_id = $1
      WHERE user_id = $2
        AND is_available = true
        AND is_online = true
      RETURNING *
    `, [rideId, driverId]);

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    // Remove from geo index
    await redis.zrem('drivers:available', driverId);

    await client.query('COMMIT');
    return true;

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

### Batch Matching for High Demand

During surge, batch matching provides better global assignment:

```javascript
async function batchMatch(pendingRequests, windowMs = 2000) {
  // Build bipartite graph: requests -> candidate drivers
  const graph = new Map();

  for (const request of pendingRequests) {
    const candidates = await findNearbyDrivers(
      request.pickupLat, request.pickupLng, request.vehicleType
    );

    graph.set(request.id, candidates.map(d => ({
      driverId: d.memberId,
      score: computeMatchScore(d, request),
      eta: d.distance * 2
    })));
  }

  // Greedy assignment (Hungarian algorithm for optimal)
  const assignments = greedyBipartiteAssignment(graph);

  // Execute assignments
  const results = await Promise.all(
    assignments.map(async ({ requestId, driverId }) => {
      const acquired = await tryAcquireDriver(driverId, requestId);
      return { requestId, driverId, success: acquired };
    })
  );

  // Requeue failed matches
  const failed = results.filter(r => !r.success);
  for (const { requestId } of failed) {
    await requeueMatchRequest(requestId);
  }

  return results;
}
```

---

## 6. Deep Dive: Queue Architecture (5-6 minutes)

### RabbitMQ Topology

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

### Delivery Semantics

| Queue | Semantics | Ack Strategy | Retry Policy |
|-------|-----------|--------------|--------------|
| matching.requests | At-least-once | Manual after match | 3 retries, exp backoff |
| notifications | At-least-once | Manual after send | 3 retries, then DLQ |
| analytics | At-most-once | Auto ack | No retries (best effort) |
| billing | At-least-once | Manual after commit | 5 retries, then alert |

### Message Publishing

```javascript
async function publishRideEvent(eventType, rideId, payload) {
  const event = {
    eventId: uuidv4(),
    eventType,
    rideId,
    timestamp: Date.now(),
    payload
  };

  await channel.publish(
    'ride.events',
    '',  // Fanout ignores routing key
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,
      messageId: event.eventId,
      contentType: 'application/json'
    }
  );
}

// Usage
await publishRideEvent('completed', rideId, {
  driverId,
  riderId,
  fare: fareCents,
  distance: distanceMeters
});
```

### Backpressure Handling

```javascript
// Producer-side queue depth check
async function checkMatchingBackpressure() {
  const queueInfo = await channel.checkQueue('matching.requests');

  if (queueInfo.messageCount > 1000) {
    throw new ServiceUnavailableError(
      'High demand in your area. Please try again in a moment.',
      { retryAfter: 30 }
    );
  }
}

// Consumer-side prefetch limit
channel.prefetch(10); // Process 10 concurrent matches

// Memory-based backpressure
async function handleMatchRequest(msg) {
  const memUsage = process.memoryUsage();

  if (memUsage.heapUsed > 400 * 1024 * 1024) { // 400MB
    channel.nack(msg, false, true); // Requeue
    await sleep(1000); // Brief pause
    return;
  }

  // Process normally
  await processMatch(msg);
  channel.ack(msg);
}
```

---

## 7. Deep Dive: Consistency and Idempotency (5-6 minutes)

### Ride State Machine

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
                     │ driver arrives│             │
                     ▼              │               │
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

### State Transition with Version Lock

```javascript
async function transitionRideState(rideId, fromStatus, toStatus, updates = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Optimistic lock with version check
    const result = await client.query(`
      UPDATE rides
      SET status = $1,
          version = version + 1,
          updated_at = NOW(),
          ${Object.keys(updates).map((k, i) => `${k} = $${i + 4}`).join(', ')}
      WHERE id = $2
        AND status = $3
      RETURNING *
    `, [toStatus, rideId, fromStatus, ...Object.values(updates)]);

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ConflictError(`Cannot transition from ${fromStatus} to ${toStatus}`);
    }

    await client.query('COMMIT');

    // Publish event for fanout
    await publishRideEvent(toStatus, rideId, result.rows[0]);

    return result.rows[0];

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

### Idempotency Middleware

```javascript
async function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) return next();

  const cacheKey = `idempotency:${req.userId}:${idempotencyKey}`;

  // Check for cached response
  const cached = await redis.get(cacheKey);
  if (cached) {
    const { status, body } = JSON.parse(cached);
    return res.status(status).json(body);
  }

  // Acquire lock to prevent concurrent duplicates
  const acquired = await redis.set(cacheKey, 'pending', 'NX', 'EX', 60);
  if (!acquired) {
    return res.status(409).json({ error: 'Request in progress' });
  }

  // Capture response
  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    await redis.set(cacheKey, JSON.stringify({
      status: res.statusCode,
      body
    }), 'EX', 86400); // 24 hour cache

    return originalJson(body);
  };

  next();
}
```

### Payment Capture with Circuit Breaker

```javascript
const paymentCircuit = new CircuitBreaker(capturePayment, {
  timeout: 10000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5
});

paymentCircuit.fallback(async (rideId, amount) => {
  // Queue for later processing
  await publishToQueue('billing', {
    type: 'deferred_capture',
    rideId,
    amount,
    queuedAt: Date.now()
  });

  return { status: 'pending', message: 'Payment queued' };
});

async function completeRideWithPayment(rideId, fareCents) {
  // Transition state first
  const ride = await transitionRideState(rideId, 'in_progress', 'completed', {
    final_fare_cents: fareCents,
    completed_at: new Date()
  });

  // Capture payment with circuit breaker
  const paymentResult = await paymentCircuit.fire(rideId, fareCents);

  // Update payment status
  await pool.query(`
    UPDATE rides SET payment_status = $1 WHERE id = $2
  `, [paymentResult.status, rideId]);

  return { ride, payment: paymentResult };
}
```

---

## 8. Database Schema Design (4-5 minutes)

### PostgreSQL Schema

```sql
-- Users table (both riders and drivers)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    user_type VARCHAR(10) NOT NULL CHECK (user_type IN ('rider', 'driver')),
    rating DECIMAL(2,1) DEFAULT 5.0,
    rating_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Driver extended information
CREATE TABLE drivers (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('economy', 'comfort', 'premium', 'xl')),
    vehicle_make VARCHAR(50),
    vehicle_model VARCHAR(50),
    vehicle_color VARCHAR(30),
    license_plate VARCHAR(20) NOT NULL,
    is_available BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    current_ride_id UUID,
    acceptance_rate DECIMAL(3,2) DEFAULT 0.80,
    total_rides INTEGER DEFAULT 0,
    total_earnings_cents BIGINT DEFAULT 0,
    last_location_update TIMESTAMP WITH TIME ZONE
);

-- Rides table with optimistic locking
CREATE TABLE rides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES users(id),
    driver_id UUID REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'requested',
    version INTEGER NOT NULL DEFAULT 1,

    -- Locations
    pickup_lat DECIMAL(10,7) NOT NULL,
    pickup_lng DECIMAL(10,7) NOT NULL,
    pickup_address VARCHAR(500),
    dropoff_lat DECIMAL(10,7) NOT NULL,
    dropoff_lng DECIMAL(10,7) NOT NULL,
    dropoff_address VARCHAR(500),

    -- Pricing
    vehicle_type VARCHAR(20) NOT NULL,
    estimated_fare_cents INTEGER,
    final_fare_cents INTEGER,
    surge_multiplier DECIMAL(3,2) DEFAULT 1.00,

    -- Metrics
    distance_meters INTEGER,
    duration_seconds INTEGER,

    -- Payment
    payment_status VARCHAR(20) DEFAULT 'pending',
    payment_captured_at TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    matched_at TIMESTAMP WITH TIME ZONE,
    arrived_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,

    -- Constraints
    CONSTRAINT valid_status CHECK (status IN (
        'requested', 'matched', 'arrived', 'in_progress', 'completed', 'cancelled'
    ))
);

-- Indexes for common queries
CREATE INDEX idx_rides_rider_id ON rides(rider_id);
CREATE INDEX idx_rides_driver_id ON rides(driver_id);
CREATE INDEX idx_rides_status ON rides(status) WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX idx_rides_requested_at ON rides(requested_at DESC);
CREATE INDEX idx_drivers_available ON drivers(is_available, is_online) WHERE is_available = true;

-- Failed jobs for DLQ review
CREATE TABLE failed_jobs (
    id SERIAL PRIMARY KEY,
    queue VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    error_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    processed_by VARCHAR(100)
);
```

### Redis Data Structures

```
# Geospatial index (sorted set with geohash scores)
drivers:available:{vehicleType}  ->  GeoSet of {driver_id: (lng, lat)}

# Driver metadata (hash)
driver:location:{driver_id}  ->  { lat, lng, timestamp, heading, speed }

# Driver status (string with TTL)
driver:status:{driver_id}  ->  "available" | "on_ride" | "offline"  (TTL: 60s)

# Surge data per zone (string with TTL)
surge:{geohash}  ->  "1.5"  (TTL: 120s)

# Demand counting (string with TTL)
demand:{geohash}  ->  integer count  (TTL: 300s)

# Idempotency cache (string with TTL)
idempotency:{user_id}:{key}  ->  { status, body }  (TTL: 86400s)

# WebSocket connection mapping
ws:user:{user_id}  ->  server_id  (TTL: 120s)
```

---

## 9. Surge Pricing Implementation (4-5 minutes)

### Zone-Based Calculation

```javascript
// Using 5-character geohash (~5km x 5km cells)
function getGeohashZone(lat, lng) {
  return geohash.encode(lat, lng, 5);
}

async function calculateSurgeMultiplier(lat, lng) {
  const zone = getGeohashZone(lat, lng);

  // Check cache first
  const cached = await redis.get(`surge:${zone}`);
  if (cached) return parseFloat(cached);

  // Calculate fresh
  const [availableDrivers, pendingRequests, recentDemand] = await Promise.all([
    redis.zcount(`drivers:available:economy`, '-inf', '+inf'), // Simplified
    redis.llen(`queue:${zone}`),
    redis.get(`demand:${zone}:last5min`) || 0
  ]);

  const supplyDemandRatio = availableDrivers / Math.max(pendingRequests + 1, 1);

  let multiplier;
  if (supplyDemandRatio > 2) multiplier = 1.0;
  else if (supplyDemandRatio > 1.5) multiplier = 1.1;
  else if (supplyDemandRatio > 1.0) multiplier = 1.2;
  else if (supplyDemandRatio > 0.75) multiplier = 1.5;
  else if (supplyDemandRatio > 0.5) multiplier = 1.8;
  else if (supplyDemandRatio > 0.25) multiplier = 2.0;
  else multiplier = 2.5;

  // Cache for 2 minutes
  await redis.set(`surge:${zone}`, multiplier.toString(), 'EX', 120);

  // Record metric
  metrics.surgeMultiplierGauge.set({ zone }, multiplier);

  return multiplier;
}
```

### Fare Calculation

```javascript
async function calculateFareEstimate(pickup, dropoff, vehicleType) {
  // Get routing estimate
  const route = await routingService.getRoute(pickup, dropoff);

  // Base rates by vehicle type
  const rates = {
    economy: { baseCents: 200, perKmCents: 80, perMinuteCents: 15 },
    comfort: { baseCents: 350, perKmCents: 120, perMinuteCents: 25 },
    premium: { baseCents: 500, perKmCents: 200, perMinuteCents: 40 },
    xl: { baseCents: 400, perKmCents: 150, perMinuteCents: 30 }
  };

  const rate = rates[vehicleType];
  const distanceKm = route.distanceMeters / 1000;
  const durationMinutes = route.durationSeconds / 60;

  // Base fare
  let baseFare = rate.baseCents +
    (distanceKm * rate.perKmCents) +
    (durationMinutes * rate.perMinuteCents);

  // Apply surge
  const surge = await calculateSurgeMultiplier(pickup.lat, pickup.lng);
  const finalFare = Math.round(baseFare * surge);

  return {
    baseFareCents: Math.round(baseFare),
    surgeMultiplier: surge,
    finalFareCents: finalFare,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds
  };
}
```

---

## 10. Trade-offs and Alternatives (4-5 minutes)

### Geospatial Storage

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Redis Geo** | Sub-ms queries, built-in distance, simple ops | Memory-bound, limited query types | **Chosen** for hot data |
| PostGIS | Rich spatial queries, persistence | Slower for high update rate | For analytics |
| Tile38 | Purpose-built geo DB, geofencing | Operational overhead | Future consideration |
| Elasticsearch | Flexible geo queries | Overkill for radius queries | Not needed |

### Matching Algorithm

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| **Greedy** | Simple, <100ms, easy to debug | Suboptimal global assignment | Default |
| Batch Hungarian | Optimal matching | Adds 2-5s latency | High-demand zones |
| ML-based | Considers many factors | Complex training | Future optimization |

### Queue Technology

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **RabbitMQ** | Flexible routing, DLQ, mature | Not as scalable as Kafka | **Chosen** for event fanout |
| Kafka | High throughput, replay | Overkill for our scale | If >1M events/sec |
| Redis Streams | Simple, already have Redis | Limited routing options | For simple pub/sub |

### Consistency vs Availability

| Operation | Consistency | Availability | Rationale |
|-----------|-------------|--------------|-----------|
| Location updates | Eventual | High | Stale OK, must not block |
| Ride booking | Strong | Medium | Financial implications |
| Driver matching | Strong | Medium | Prevent double-booking |
| Surge calculation | Eventual | High | Approximate is fine |
| Payment capture | Strong | Lower OK | Must be correct |

---

## 11. Failure Handling (3-4 minutes)

### Redis Failure

```javascript
// Circuit breaker for Redis geo operations
const redisGeoCircuit = new CircuitBreaker(redisGeoOperation, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 15000
});

redisGeoCircuit.fallback(async (operation, ...args) => {
  if (operation === 'georadius') {
    // Fall back to PostgreSQL (slower but works)
    return await findDriversFromPostgres(args[1], args[2], args[3]);
  }
  return null;
});
```

### Database Failover

```javascript
// Connection pool with replica support
const pool = new Pool({
  host: process.env.PG_HOST,
  replicaHost: process.env.PG_REPLICA_HOST,
  maxConnections: 100,
  connectionTimeoutMillis: 5000
});

// Read from replica for non-critical queries
async function getRideHistory(riderId, options = {}) {
  const client = options.useReplica
    ? pool.replicaConnect()
    : pool.connect();
  // ...
}
```

### Graceful Degradation Matrix

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Redis cluster down | Matching slower | Fall back to PostgreSQL geo queries |
| RabbitMQ down | Notifications delayed | Queue in Redis, process later |
| Payment gateway down | Payment pending | Queue for later, complete ride anyway |
| Routing API down | ETA inaccurate | Return cached/estimated ETA |
| WebSocket down | No real-time updates | Client polls every 5 seconds |

---

## 12. Monitoring and Observability (2-3 minutes)

### Key Metrics

```javascript
// Prometheus metrics definition
const metrics = {
  // Ride lifecycle
  rideRequests: new Counter('uber_ride_requests_total', 'Ride requests', ['vehicle_type', 'status']),
  matchingDuration: new Histogram('uber_matching_duration_seconds', 'Matching time', ['success']),
  ridesByStatus: new Gauge('uber_rides_by_status', 'Rides by status', ['status']),

  // Driver availability
  driversOnline: new Gauge('uber_drivers_online_total', 'Online drivers', ['vehicle_type']),
  driversAvailable: new Gauge('uber_drivers_available_total', 'Available drivers', ['vehicle_type']),
  locationUpdates: new Counter('uber_location_updates_total', 'Location updates'),

  // Surge pricing
  surgeMultiplier: new Gauge('uber_surge_multiplier', 'Surge multiplier', ['zone']),
  surgeEvents: new Counter('uber_surge_events_total', 'Surge events', ['multiplier_range']),

  // System health
  circuitBreakerState: new Gauge('uber_circuit_breaker_state', 'Circuit state', ['circuit', 'state']),
  geoQueryDuration: new Histogram('uber_geo_query_duration_seconds', 'Geo query time', ['operation'])
};
```

### Alerting Rules

```yaml
groups:
  - name: uber_alerts
    rules:
      - alert: HighMatchingLatency
        expr: histogram_quantile(0.95, uber_matching_duration_seconds) > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Matching latency above 5 seconds"

      - alert: LowDriverAvailability
        expr: uber_drivers_available_total < 10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Less than 10 drivers available"

      - alert: CircuitBreakerOpen
        expr: uber_circuit_breaker_state{state="open"} == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker {{ $labels.circuit }} is open"
```

---

## Summary

The key backend engineering insights for a ride-hailing system:

1. **Redis Geo is ideal for hot location data**: GEOADD/GEORADIUS provide sub-millisecond queries, but shard by geography for scale

2. **Optimistic locking prevents double-booking**: Version numbers on ride state transitions ensure atomic updates without pessimistic locks

3. **Idempotency keys are essential**: Mobile networks cause retries; without idempotency, riders get charged twice

4. **Queue architecture handles surge**: RabbitMQ decouples request ingestion from matching, enabling backpressure and worker scaling

5. **Circuit breakers prevent cascade failures**: When Redis or payment gateway degrades, fail fast and use fallbacks

6. **Eventual consistency for locations, strong for payments**: Different operations have different requirements; choose appropriately

The system handles 1M+ concurrent rides through geographic sharding, careful consistency trade-offs, and async processing of non-critical operations.
