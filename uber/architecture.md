# Uber - Ride Hailing - Architecture Design

## System Overview

A ride-hailing platform connecting riders and drivers with real-time matching, location tracking, and dynamic pricing.

## Requirements

### Functional Requirements

1. **Rider Experience**
   - Request a ride from current location to destination
   - See nearby available drivers
   - Get fare estimate before booking
   - Track driver location in real-time
   - Rate drivers after trip completion

2. **Driver Experience**
   - Toggle availability status
   - Receive ride requests with passenger details
   - Navigate to pickup and dropoff locations
   - View earnings and trip history

3. **Matching System**
   - Match riders with optimal nearby drivers
   - Handle surge pricing during high demand
   - Calculate ETAs accurately

### Non-Functional Requirements

- **Latency**: Matching should complete within 3-5 seconds
- **Availability**: 99.99% uptime
- **Scale**: Support multiple concurrent rides locally
- **Location Updates**: Handle frequent driver location updates

## Capacity Estimation

For local development:
- 5-10 concurrent users
- 3 active drivers
- Location updates every 3 seconds

For production scale (reference):
- 10 million DAU (50% riders, 50% drivers)
- 5 million rides per day
- 1.67 million location updates per second at peak
- Storage: 5GB/day for ride history

## High-Level Architecture

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
    │ - Booking    │              │ - Driver locs │              │ - Fare calc  │
    │ - Status     │              │ - Geo queries │              │ - Surge      │
    │ - Matching   │              │ - ETA         │              │ - Estimates  │
    └──────┬───────┘              └──────┬───────┘              └──────────────┘
           │                              │
           │                              ▼
           │                      ┌──────────────┐
           │                      │  Geo Index   │
           │                      │   (Redis)    │
           │                      │              │
           │                      │ - GEOADD     │
           │                      │ - GEORADIUS  │
           └──────────────────────┤              │
                                  └──────────────┘
                                          │
    ┌─────────────────────────────────────┼─────────────────────────────────────┐
    │                                     │                                     │
    ▼                                     ▼                                     ▼
┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
│  PostgreSQL  │                  │   WebSocket  │                  │   Redis      │
│              │                  │   Server     │                  │              │
│ - Users      │                  │              │                  │ - Sessions   │
│ - Rides      │                  │ - Real-time  │                  │ - Geo index  │
│ - Payments   │                  │   updates    │                  │ - Demand     │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

### Core Components

**1. API Gateway (Express)**
- Handles authentication for both riders and drivers
- Routes requests to appropriate services
- Rate limiting and request validation

**2. Ride Service**
- Manages the ride lifecycle: request, match, in-progress, completed
- Coordinates between rider, driver, and payment systems
- Stores ride state in PostgreSQL

**3. Location Service**
- Ingests driver location updates
- Maintains real-time geospatial index in Redis
- Powers "find nearby drivers" queries

**4. Pricing Service**
- Calculates base fares using distance and time
- Implements surge pricing based on supply/demand ratio
- Provides fare estimates before booking

**5. Geo Index (Redis with Geospatial)**
- Stores driver locations using GEOADD
- Supports GEORADIUS queries for nearby drivers
- Updates locations in real-time

## Data Model

### PostgreSQL Schema

```sql
-- Users table (both riders and drivers)
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    user_type VARCHAR(10) NOT NULL, -- 'rider' or 'driver'
    rating DECIMAL(2,1) DEFAULT 5.0,
    rating_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Drivers extended info
CREATE TABLE drivers (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    vehicle_type VARCHAR(20) NOT NULL, -- economy, comfort, premium, xl
    vehicle_make VARCHAR(50),
    vehicle_model VARCHAR(50),
    vehicle_color VARCHAR(30),
    license_plate VARCHAR(20) NOT NULL,
    is_available BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    current_lat DECIMAL(10,7),
    current_lng DECIMAL(10,7),
    total_rides INTEGER DEFAULT 0,
    total_earnings_cents INTEGER DEFAULT 0
);

-- Rides table
CREATE TABLE rides (
    id UUID PRIMARY KEY,
    rider_id UUID NOT NULL REFERENCES users(id),
    driver_id UUID REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'requested',
    pickup_lat DECIMAL(10,7) NOT NULL,
    pickup_lng DECIMAL(10,7) NOT NULL,
    pickup_address VARCHAR(500),
    dropoff_lat DECIMAL(10,7) NOT NULL,
    dropoff_lng DECIMAL(10,7) NOT NULL,
    dropoff_address VARCHAR(500),
    vehicle_type VARCHAR(20) NOT NULL,
    estimated_fare_cents INTEGER,
    final_fare_cents INTEGER,
    surge_multiplier DECIMAL(3,2) DEFAULT 1.00,
    distance_meters INTEGER,
    duration_seconds INTEGER,
    requested_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);
```

### Redis (Real-time State)

```
# Driver locations (geospatial index)
GEOADD drivers:available {longitude} {latitude} {driver_id}

# Driver status
SET driver:status:{driver_id} "available" | "on_ride" | "offline"

# Driver location with timestamp
HSET driver:location:{driver_id} lat {lat} lng {lng} timestamp {ts}

# Demand counting per geohash
SET demand:{geohash} {count} EX 300
```

## API Design

### Core Endpoints

**Authentication**
- `POST /api/auth/register/rider` - Register rider
- `POST /api/auth/register/driver` - Register driver
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

**Rides (Rider)**
- `POST /api/rides/estimate` - Get fare estimates
- `POST /api/rides/request` - Request a ride
- `GET /api/rides/:rideId` - Get ride status
- `POST /api/rides/:rideId/cancel` - Cancel ride
- `POST /api/rides/:rideId/rate` - Rate the ride

**Driver**
- `POST /api/driver/location` - Update location
- `POST /api/driver/online` - Go online
- `POST /api/driver/offline` - Go offline
- `POST /api/driver/rides/:rideId/accept` - Accept ride
- `POST /api/driver/rides/:rideId/arrived` - Notify arrival
- `POST /api/driver/rides/:rideId/start` - Start ride
- `POST /api/driver/rides/:rideId/complete` - Complete ride

### WebSocket Events

```javascript
// Client -> Server
{ type: 'auth', token: 'xxx' }
{ type: 'location_update', lat: 37.77, lng: -122.41 }

// Server -> Client (Driver)
{ type: 'ride_offer', rideId, rider, pickup, dropoff, estimatedFare, expiresIn }

// Server -> Client (Rider)
{ type: 'ride_matched', rideId, driver }
{ type: 'driver_arrived', rideId }
{ type: 'ride_started', rideId }
{ type: 'ride_completed', rideId, fare }
```

## Key Design Decisions

### Real-time Geo-matching

**Challenge**: Find nearby drivers quickly from millions of locations

**Solution**: Redis Geo commands

```javascript
// Store driver location
await redis.geoadd('drivers:available', lng, lat, driverId);

// Find 20 nearest drivers within 5km
const drivers = await redis.georadius(
  'drivers:available',
  lng, lat,
  5, 'km',
  'WITHCOORD', 'WITHDIST',
  'COUNT', 20,
  'ASC'
);
```

**Why Redis Geo?**
- O(log N) operations
- Built-in distance calculation
- Handles millions of updates
- Simple operational model

### Matching Algorithm

```javascript
function computeMatchScore(driver, eta) {
  // Lower ETA is better (invert and normalize)
  const etaScore = Math.max(0, 1 - eta / 30);

  // Higher rating is better
  const ratingScore = (driver.rating - 3) / 2;

  // Weighted combination
  return (0.6 * etaScore) + (0.4 * ratingScore);
}
```

### Surge Pricing

```javascript
function calculateSurge(availableDrivers, pendingRequests) {
  const ratio = availableDrivers / Math.max(pendingRequests, 1);

  if (ratio > 2) return 1.0;      // Plenty of drivers
  if (ratio > 1.5) return 1.1;
  if (ratio > 1) return 1.2;
  if (ratio > 0.75) return 1.5;
  if (ratio > 0.5) return 1.8;
  if (ratio > 0.25) return 2.0;
  return 2.5;                     // Very high demand
}
```

## Technology Stack

- **Application Layer**: Node.js + Express + WebSocket
- **Data Layer**: PostgreSQL (transactional), Redis (real-time)
- **Caching Layer**: Redis (sessions, geo index, demand counts)
- **Frontend**: React + TypeScript + Zustand + TanStack Router

## Scalability Considerations

1. **Shard by geography**: Location updates partition naturally by city/region
2. **Stateless services**: API servers can scale horizontally
3. **Redis Cluster**: For geo data at scale
4. **CDN for static assets**: Map tiles, images

## Trade-offs and Alternatives

| Decision | Alternative | Why We Chose This |
|----------|-------------|-------------------|
| Redis Geo | PostGIS, Tile38 | Simplicity, speed |
| Greedy matching | Hungarian algorithm | Fast enough for demo |
| Session auth | JWT | Simpler, Redis-based |
| WebSocket | SSE, Polling | Lower latency |

## Monitoring and Observability

Key metrics to track:
- Request-to-match time: Target < 5 seconds
- Match-to-pickup time: Track by zone
- Ride completion rate: Detect failed rides
- Driver utilization: Optimize supply positioning
- Surge frequency: Ensure fairness

## Security Considerations

- Password hashing with bcrypt
- Session tokens stored in Redis with expiry
- Input validation on all endpoints
- CORS configuration for frontend

## Consistency and Idempotency Semantics

This section defines how the system handles consistency, replays, and conflicts for core write operations.

### Consistency Model by Operation

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Ride request | Strong (PostgreSQL transaction) | Must prevent double-booking |
| Driver location update | Eventual (Redis overwrite) | Latest location always wins |
| Ride state transition | Strong (row-level lock) | State machine must be atomic |
| Payment capture | Strong (external idempotency) | Financial correctness required |
| Driver availability toggle | Eventual (Redis + DB sync) | Small delay acceptable |
| Rating submission | Strong (upsert with conflict) | One rating per ride per party |

### Idempotency Key Strategy

All mutating API endpoints accept an `X-Idempotency-Key` header (client-generated UUID). The system uses Redis to track processed requests:

```javascript
// Idempotency middleware
async function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) return next();

  const cacheKey = `idempotency:${req.userId}:${idempotencyKey}`;

  // Check if request was already processed
  const cached = await redis.get(cacheKey);
  if (cached) {
    const { status, body } = JSON.parse(cached);
    return res.status(status).json(body);
  }

  // Store pending marker to prevent concurrent duplicate requests
  const acquired = await redis.set(cacheKey, 'pending', 'NX', 'EX', 60);
  if (!acquired) {
    return res.status(409).json({ error: 'Request in progress' });
  }

  // Capture response to cache
  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    await redis.set(cacheKey, JSON.stringify({
      status: res.statusCode,
      body
    }), 'EX', 86400); // Cache for 24 hours
    return originalJson(body);
  };

  next();
}
```

**Key TTLs:**
- In-flight lock: 60 seconds
- Completed response cache: 24 hours
- Payment idempotency keys: 7 days (for dispute resolution)

### Conflict Resolution Rules

**Ride State Machine Conflicts:**

```
requested -> [matched, cancelled]
matched -> [driver_arrived, cancelled]
driver_arrived -> [in_progress, cancelled]
in_progress -> [completed]
completed -> (terminal)
cancelled -> (terminal)
```

State transitions use optimistic locking with version numbers:

```sql
UPDATE rides
SET status = 'matched',
    driver_id = $1,
    version = version + 1
WHERE id = $2
  AND status = 'requested'
  AND version = $3
RETURNING *;
```

If no rows are updated, the operation is rejected (stale state or already transitioned).

**Concurrent Driver Matching:**

When multiple matching workers target the same driver for different rides:
1. First `UPDATE drivers SET is_available = false WHERE is_available = true` wins
2. Losing requests re-enter the matching queue
3. Driver assignment is wrapped in a PostgreSQL transaction with the ride update

**Location Update Conflicts:**

Location updates are last-write-wins by design. Redis GEOADD overwrites previous coordinates. The `driver:location:{id}` hash includes a timestamp to detect stale updates if needed:

```javascript
// Reject location updates older than 10 seconds
if (Date.now() - incomingTimestamp > 10000) {
  return; // Silently drop stale update
}
```

## Async Queue Architecture (RabbitMQ)

This section introduces an async queue layer for fanout, background jobs, and backpressure handling.

### Queue Topology

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
   │  Email worker │         │  (Postgres)   │         │  processor    │
   └───────────────┘         └───────────────┘         └───────────────┘
```

### Queue Definitions

```javascript
// RabbitMQ setup for local development
const QUEUES = {
  // Ride lifecycle events (fanout to multiple consumers)
  RIDE_EVENTS: {
    exchange: 'ride.events',
    type: 'fanout',
    queues: ['notifications', 'analytics', 'billing']
  },

  // Driver matching (work queue with single consumer per message)
  MATCHING: {
    queue: 'matching.requests',
    durable: true,
    prefetch: 5 // Process 5 concurrent matches per worker
  },

  // Background jobs (delayed/scheduled)
  BACKGROUND: {
    queue: 'background.jobs',
    deadLetterExchange: 'background.dlx',
    messageTtl: 300000 // 5 minute max processing time
  }
};
```

### Delivery Semantics

| Queue | Semantics | Ack Strategy | Retry Policy |
|-------|-----------|--------------|--------------|
| ride.events (notifications) | At-least-once | Manual ack after send | 3 retries, then DLQ |
| ride.events (analytics) | At-most-once | Auto ack | No retries (best effort) |
| ride.events (billing) | At-least-once | Manual ack after DB commit | 5 retries with backoff |
| matching.requests | At-least-once | Manual ack after match | Immediate retry, then requeue |
| background.jobs | At-least-once | Manual ack | 3 retries, then DLQ |

### Message Schemas

```typescript
// Ride event envelope
interface RideEvent {
  eventId: string;       // UUID for deduplication
  eventType: 'requested' | 'matched' | 'completed' | 'cancelled';
  rideId: string;
  timestamp: number;
  payload: {
    riderId?: string;
    driverId?: string;
    fare?: number;
    location?: { lat: number; lng: number };
  };
}

// Matching request
interface MatchingRequest {
  requestId: string;     // Idempotency key
  rideId: string;
  pickupLocation: { lat: number; lng: number };
  vehicleType: string;
  maxWaitSeconds: number;
  attempt: number;       // For retry tracking
}
```

### Backpressure Handling

**Producer-side (API servers):**

```javascript
// Check queue depth before accepting new ride requests
async function checkBackpressure() {
  const queueInfo = await channel.checkQueue('matching.requests');
  if (queueInfo.messageCount > 100) {
    throw new ServiceUnavailableError('High demand - please retry');
  }
}
```

**Consumer-side (matching workers):**

```javascript
// Prefetch limit prevents overwhelming workers
channel.prefetch(5);

// Reject and requeue if worker is overloaded
if (process.memoryUsage().heapUsed > 500 * 1024 * 1024) {
  channel.nack(message, false, true); // Requeue
  return;
}
```

### Dead Letter Queue (DLQ) Processing

Failed messages after max retries go to DLQ for manual inspection:

```javascript
// DLQ consumer for alerting and manual processing
channel.consume('background.dlq', async (msg) => {
  const payload = JSON.parse(msg.content.toString());

  // Log for alerting
  console.error('DLQ message:', {
    originalQueue: msg.properties.headers['x-first-death-queue'],
    reason: msg.properties.headers['x-first-death-reason'],
    payload
  });

  // Store in PostgreSQL for admin review
  await db.query(`
    INSERT INTO failed_jobs (queue, payload, error_reason, created_at)
    VALUES ($1, $2, $3, NOW())
  `, [
    msg.properties.headers['x-first-death-queue'],
    JSON.stringify(payload),
    msg.properties.headers['x-first-death-reason']
  ]);

  channel.ack(msg);
});
```

### Local Development Setup

Add to `docker-compose.yml`:

```yaml
rabbitmq:
  image: rabbitmq:3-management
  ports:
    - "5672:5672"
    - "15672:15672"
  environment:
    RABBITMQ_DEFAULT_USER: uber
    RABBITMQ_DEFAULT_PASS: uber
  volumes:
    - rabbitmq_data:/var/lib/rabbitmq
```

## Failure Handling and Resilience

This section covers retry strategies, circuit breakers, disaster recovery, and backup/restore procedures.

### Retry Strategy with Idempotency Keys

**API Layer Retries:**

```javascript
// Axios client with retry configuration
const apiClient = axios.create({
  timeout: 5000,
  headers: { 'X-Idempotency-Key': () => uuidv4() }
});

axiosRetry(apiClient, {
  retries: 3,
  retryDelay: (retryCount) => {
    // Exponential backoff: 100ms, 200ms, 400ms
    return Math.pow(2, retryCount) * 100;
  },
  retryCondition: (error) => {
    // Retry on network errors and 5xx, but not 4xx
    return axiosRetry.isNetworkOrIdempotentRequestError(error)
      || (error.response?.status >= 500);
  }
});
```

**Queue Consumer Retries:**

```javascript
// Retry with exponential backoff for queue messages
async function processWithRetry(message, handler) {
  const attempt = (message.properties.headers['x-retry-count'] || 0) + 1;
  const maxRetries = 3;

  try {
    await handler(message);
    channel.ack(message);
  } catch (error) {
    if (attempt >= maxRetries) {
      // Send to DLQ
      channel.reject(message, false);
    } else {
      // Requeue with delay using message TTL
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      channel.publish('', 'matching.requests.delayed', message.content, {
        headers: { 'x-retry-count': attempt },
        expiration: delay.toString()
      });
      channel.ack(message);
    }
  }
}
```

### Circuit Breaker Implementation

```javascript
const CircuitBreaker = require('opossum');

// Circuit breaker for external services (e.g., payment gateway)
const paymentCircuit = new CircuitBreaker(capturePayment, {
  timeout: 10000,           // 10 second timeout
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5        // Minimum 5 requests before tripping
});

paymentCircuit.on('open', () => {
  console.warn('Payment circuit OPEN - payments disabled');
  // Alert ops team
});

paymentCircuit.on('halfOpen', () => {
  console.info('Payment circuit HALF-OPEN - testing');
});

paymentCircuit.on('close', () => {
  console.info('Payment circuit CLOSED - payments restored');
});

// Fallback behavior when circuit is open
paymentCircuit.fallback(() => {
  return { status: 'pending', message: 'Payment queued for retry' };
});

// Usage
async function completeRide(rideId, fare) {
  const payment = await paymentCircuit.fire(rideId, fare);
  // ...
}
```

**Circuit Breakers by Service:**

| Service | Timeout | Error Threshold | Reset Timeout | Fallback |
|---------|---------|-----------------|---------------|----------|
| Payment gateway | 10s | 50% | 30s | Queue for later |
| Routing/ETA API | 3s | 70% | 15s | Return cached ETA |
| Push notifications | 2s | 80% | 10s | Queue in Redis |
| SMS gateway | 5s | 50% | 60s | Queue in DB |

### Graceful Degradation Modes

When components fail, the system degrades gracefully:

| Failure | Degradation | User Impact |
|---------|-------------|-------------|
| Redis down | Use PostgreSQL for matching (slower) | Matching takes 2-5s instead of <1s |
| RabbitMQ down | Queue messages in Redis, process later | Notifications delayed |
| Payment gateway down | Accept ride, queue payment capture | Payment processed within 1 hour |
| WebSocket server down | Fall back to polling (5s interval) | Higher latency for updates |

### Multi-Region DR (Production Reference)

For local development, we simulate multi-region with multiple instances:

```bash
# Simulate "region A" (primary)
REGION=A PORT=3001 npm run dev:server1

# Simulate "region B" (secondary)
REGION=B PORT=3002 npm run dev:server2
```

**Production DR strategy (reference architecture):**

```
                    ┌─────────────────┐
                    │   Global LB     │
                    │  (Route 53/CF)  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼                             ▼
       ┌─────────────┐               ┌─────────────┐
       │  Region A   │               │  Region B   │
       │  (Primary)  │               │  (Standby)  │
       └──────┬──────┘               └──────┬──────┘
              │                             │
    ┌─────────┼─────────┐         ┌─────────┼─────────┐
    ▼         ▼         ▼         ▼         ▼         ▼
 ┌─────┐  ┌─────┐  ┌─────┐   ┌─────┐  ┌─────┐  ┌─────┐
 │ API │  │Redis│  │ PG  │   │ API │  │Redis│  │ PG  │
 │     │  │     │  │     │   │     │  │     │  │replica
 └─────┘  └─────┘  └─────┘   └─────┘  └─────┘  └─────┘
              │         │                         ▲
              └─────────┼─────────────────────────┘
                        │ (async replication)
```

**Failover triggers:**
- Primary region health check fails for 30 seconds
- Database replication lag exceeds 5 minutes
- Manual operator intervention

**RTO/RPO targets:**
- RTO (Recovery Time Objective): 5 minutes
- RPO (Recovery Point Objective): 30 seconds of data loss acceptable

### Backup and Restore Procedures

**PostgreSQL Backups:**

```bash
# Daily full backup (local dev)
pg_dump -h localhost -U uber uber_dev > backup_$(date +%Y%m%d).sql

# Restore from backup
psql -h localhost -U uber uber_dev < backup_20240115.sql
```

**Automated backup script (cron job):**

```bash
#!/bin/bash
# backup.sh - Run daily at 2 AM

BACKUP_DIR="/backups/postgres"
RETENTION_DAYS=7

# Create backup
pg_dump -h localhost -U uber -Fc uber_dev > \
  "$BACKUP_DIR/uber_$(date +%Y%m%d_%H%M%S).dump"

# Clean old backups
find "$BACKUP_DIR" -name "*.dump" -mtime +$RETENTION_DAYS -delete

# Verify backup is readable
pg_restore --list "$BACKUP_DIR/uber_$(date +%Y%m%d)*.dump" > /dev/null
if [ $? -ne 0 ]; then
  echo "ALERT: Backup verification failed!" | mail -s "Backup Error" ops@example.com
fi
```

**Redis Persistence:**

```bash
# Redis RDB snapshot (already configured in docker-compose)
# Manually trigger snapshot
redis-cli BGSAVE

# Check last save time
redis-cli LASTSAVE
```

**Backup Restore Testing (Monthly Drill):**

```bash
# 1. Stop services
docker-compose stop api

# 2. Create test database
docker exec uber-postgres createdb -U uber uber_restore_test

# 3. Restore backup
cat backup_20240115.sql | docker exec -i uber-postgres psql -U uber uber_restore_test

# 4. Verify row counts match
docker exec uber-postgres psql -U uber -c "SELECT COUNT(*) FROM rides" uber_restore_test

# 5. Run smoke tests against restored DB
DATABASE_URL=postgres://uber:uber@localhost:5432/uber_restore_test npm run test:smoke

# 6. Cleanup
docker exec uber-postgres dropdb -U uber uber_restore_test
```

**Data Recovery Scenarios:**

| Scenario | Recovery Method | Expected Time |
|----------|-----------------|---------------|
| Accidental row deletion | Point-in-time recovery from WAL | 15 minutes |
| Table corruption | Restore from daily backup | 30 minutes |
| Full database loss | Restore from backup + replay WAL | 1 hour |
| Redis data loss | Application re-populates from PostgreSQL | 5 minutes |
| Complete data center loss | Promote standby region | 5 minutes |

## Future Optimizations

- [ ] Batch matching for high-demand zones
- [ ] ML-based ETA prediction
- [ ] Geofenced surge zones
- [ ] Driver routing optimization
- [ ] Ride pooling (shared rides)
