# Local Delivery Service - Architecture Design

## System Overview

A last-mile delivery platform for local goods and services, similar to DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking, efficient driver-order matching, route optimization, and handling the three-sided marketplace dynamics between customers, merchants, and drivers.

## Requirements

### Functional Requirements

1. **Order placement** - Customers order from local merchants
2. **Driver matching** - Match orders to nearby available drivers
3. **Real-time tracking** - Live driver location and ETA updates
4. **Route optimization** - Efficient routing for deliveries
5. **Notifications** - Order status updates to all parties
6. **Ratings** - Two-way ratings for drivers and customers

### Non-Functional Requirements

- **Latency**: Driver match within 30 seconds, location updates every 3 seconds
- **Scale**: Designed for 1M orders/day, 100K concurrent drivers (local demo version)
- **Availability**: 99.99% for order placement
- **Accuracy**: ETA within 3 minutes 90% of the time

## Capacity Estimation

**Order volume (production):**
- 1 million orders per day
- Peak hours (lunch/dinner): 3x average = 35 orders/second
- Average order: $25, 3 items

**Driver fleet (production):**
- 100,000 active drivers
- 30% online at any time = 30,000 concurrent
- Location updates every 3 seconds = 10,000 updates/second

**Local demo:**
- 3 test merchants
- 3 test drivers
- Sample menu items

## High-Level Architecture

```
                                    ┌─────────────────────────────────┐
                                    │          Client Apps            │
                                    │   (Customer, Driver, Admin)     │
                                    └───────────────┬─────────────────┘
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                    HTTPS│                     │WebSocket
                                         │                     │
                              ┌──────────▼──────────┐  ┌───────▼───────┐
                              │     API Server      │  │  WebSocket    │
                              │    (Express.js)     │  │   Handler     │
                              └──────────┬──────────┘  └───────┬───────┘
                                         │                     │
        ┌────────────────────────────────┼─────────────────────┼──────────┐
        │                                │                     │          │
┌───────▼───────┐            ┌───────────▼───────────┐  ┌──────▼──────┐  │
│ Auth Service  │            │   Location Service    │  │  Tracking   │  │
│               │            │                       │  │  Service    │  │
│ - Register    │            │ - Driver positions    │  │             │  │
│ - Login       │            │ - Geo indexing        │  │ - Pub/Sub   │  │
│ - Sessions    │            │ - Nearby search       │  │ - ETA       │  │
└───────────────┘            └───────────┬───────────┘  └─────────────┘  │
                                         │                               │
┌───────────────┐            ┌───────────▼───────────┐                   │
│ Order Service │            │   Matching Service    │                   │
│               │            │                       │                   │
│ - Create      │            │ - Driver selection    │                   │
│ - Update      │            │ - Scoring algorithm   │                   │
│ - History     │            │ - Offer management    │                   │
└───────┬───────┘            └───────────────────────┘                   │
        │                                                                 │
        └─────────────────────────────┬───────────────────────────────────┘
                                      │
                   ┌──────────────────┼──────────────────┐
                   │                  │                  │
            ┌──────▼──────┐   ┌───────▼───────┐  ┌──────▼──────┐
            │  PostgreSQL │   │     Redis     │  │   Redis     │
            │             │   │  (Geo Index)  │  │  (Pub/Sub)  │
            │ - Users     │   │               │  │             │
            │ - Orders    │   │ - Locations   │  │ - Events    │
            │ - Merchants │   │ - Sessions    │  │ - Updates   │
            └─────────────┘   └───────────────┘  └─────────────┘
```

### Core Components

1. **Auth Service**
   - User registration and login
   - Session-based authentication with Redis
   - Role-based access control (customer, driver, merchant, admin)

2. **Order Service**
   - Order lifecycle management
   - State machine (pending -> confirmed -> preparing -> picked_up -> delivered)
   - Order items and pricing

3. **Location Service**
   - Ingests driver location updates
   - Maintains real-time geo index in Redis
   - Supports nearby driver queries using GEORADIUS

4. **Matching Service**
   - Assigns orders to drivers
   - Scoring algorithm considers distance, rating, acceptance rate, current load
   - Handles driver acceptance/rejection with 30-second timeout

5. **Tracking Service**
   - Real-time location streaming to customers via WebSocket
   - ETA calculations based on Haversine distance
   - Redis Pub/Sub for message distribution

## Data Model

### PostgreSQL Schema

**Users Table**
- id, email, password_hash, name, phone, role
- Roles: customer, driver, merchant, admin

**Drivers Table**
- id (FK to users), vehicle_type, status, rating, total_deliveries
- current_lat, current_lng, location_updated_at

**Merchants Table**
- id, name, address, lat, lng, category, avg_prep_time_minutes, rating, is_open

**Orders Table**
- id, customer_id, merchant_id, driver_id, status
- delivery_address, delivery_lat, delivery_lng
- subtotal, delivery_fee, tip, total
- timestamps for each state transition

**Order Items Table**
- id, order_id, menu_item_id, name, quantity, unit_price

### Redis Data Structures

```
# Driver locations (geo index)
drivers:locations          -> GEOADD (lng, lat, driver_id)

# Driver metadata
driver:{id}                -> HASH (lat, lng, status, updated_at)

# Active orders by driver
driver:{id}:orders         -> SET [order_ids]

# Session storage
session:{token}            -> JSON (userId, expiresAt)

# Real-time location pubsub
driver:{id}:location       -> PUBSUB channel
order:{id}:status          -> PUBSUB channel
```

## API Design

### Customer API
- `GET /api/v1/merchants` - Browse nearby merchants
- `GET /api/v1/merchants/:id/menu` - Get menu
- `POST /api/v1/orders` - Place order
- `GET /api/v1/orders/:id` - Get order details
- WebSocket: Subscribe to order tracking

### Driver API
- `POST /api/v1/driver/go-online` - Start accepting orders
- `POST /api/v1/driver/go-offline` - Stop accepting orders
- `POST /api/v1/driver/location` - Update location
- `POST /api/v1/driver/offers/:id/accept` - Accept order
- `POST /api/v1/driver/orders/:id/delivered` - Complete delivery

### Admin API
- `GET /api/v1/admin/stats` - Dashboard statistics
- `GET /api/v1/admin/orders` - View all orders
- `GET /api/v1/admin/drivers` - View all drivers

## Key Design Decisions

### 1. Real-time Driver Location with Redis Geo

Using Redis GEOADD/GEORADIUS for driver location tracking:
- Sub-millisecond query times for nearby driver searches
- Efficient for real-time matching requirements
- Location updates published via Redis Pub/Sub

### 2. Scoring-based Driver Matching

Driver selection algorithm considers multiple factors:
- Distance to pickup (40% weight)
- Driver rating (25% weight)
- Acceptance rate (20% weight)
- Current order load (15% weight)

### 3. WebSocket for Real-time Updates

- Customers subscribe to order updates
- Drivers receive new offers in real-time
- Location updates streamed to tracking subscribers

### 4. Session-based Authentication

- Tokens stored in Redis with TTL
- Fast validation without database queries
- Easy session invalidation on logout

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, WebSocket (ws library)
- **Database**: PostgreSQL 16
- **Cache/Geo**: Redis 7
- **Containerization**: Docker Compose

## Scalability Considerations

### Geographic Sharding (Production)
- Partition by city/region
- Each region has its own Redis instance for geo queries
- Cross-region queries routed appropriately

### Horizontal Scaling
- Stateless API servers behind load balancer
- Redis Cluster for geo operations
- PostgreSQL read replicas for query scaling

### Current Local Setup
- Single PostgreSQL instance
- Single Redis instance
- Multiple API server instances on different ports

## Trade-offs and Alternatives

| Decision | Trade-off |
|----------|-----------|
| Redis geo-index | Fast queries, but data loss risk on failure |
| 3-second location updates | Accuracy vs. bandwidth/battery |
| Sequential driver offers | Fair, but slower matching |
| Session tokens in Redis | Fast validation, but requires Redis availability |

### Alternatives Considered

1. **PostgreSQL PostGIS for locations**
   - More durable
   - Slower for real-time queries
   - Better for historical analysis

2. **JWT for authentication**
   - Stateless
   - Cannot revoke tokens instantly
   - More complex refresh flow

3. **Socket.io instead of WebSocket**
   - More features (rooms, acknowledgments)
   - Higher overhead
   - Native WebSocket sufficient for our needs

## Monitoring and Observability

### Metrics to Track
- Order placement rate
- Driver acceptance rate
- Average delivery time
- ETA accuracy
- WebSocket connection count
- Redis geo query latency

### Health Checks
- `/health` endpoint checks PostgreSQL and Redis connectivity

## Security Considerations

- Password hashing with bcrypt
- Session tokens with expiration
- Role-based access control
- Input validation on all endpoints
- CORS configuration for frontend

## Consistency and Idempotency Semantics

### Consistency Model by Entity

| Entity | Consistency | Rationale |
|--------|-------------|-----------|
| Orders | Strong (PostgreSQL transactions) | Order state transitions must be atomic; no duplicate orders or lost payments |
| Driver locations | Eventual (Redis, 3-second lag acceptable) | Stale location is tolerable; freshness traded for throughput |
| Session tokens | Eventual (Redis, TTL-based) | Logout propagation within seconds is acceptable |
| Ratings | Eventual (async write) | Ratings can lag behind order completion |

### Idempotency Keys

**Order creation** uses client-generated idempotency keys to prevent duplicate orders on network retries:

```sql
-- idempotency_keys table
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for cleanup
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
```

**Implementation pattern:**
1. Client sends `X-Idempotency-Key` header with order requests
2. Server checks if key exists in `idempotency_keys` table
3. If exists, return cached response; otherwise, execute transaction
4. Store response with key on success
5. Clean up keys older than 24 hours via cron job

**Driver location updates** are naturally idempotent (last-write-wins via `GEOADD`). No special handling needed.

**Order status transitions** use optimistic locking:
```sql
UPDATE orders
SET status = 'picked_up', picked_up_at = NOW()
WHERE id = $1 AND status = 'preparing'
RETURNING *;
```
If affected rows = 0, the transition was already applied or invalid.

### Conflict Resolution

| Scenario | Resolution Strategy |
|----------|---------------------|
| Two drivers accept same order | First `UPDATE` wins (PostgreSQL row lock); second gets "already assigned" error |
| Driver goes offline with active order | Order stays assigned; admin can manually reassign after timeout (10 min) |
| Simultaneous location updates | Redis `GEOADD` is atomic; latest timestamp wins |
| Duplicate order submission | Idempotency key returns cached response |

### Replay Handling

For message replay in Pub/Sub (e.g., after WebSocket reconnect):
1. Client sends last received `message_id` on reconnect
2. Server replays missed messages from Redis stream (kept for 1 hour)
3. Clients deduplicate by `message_id` on their side

```redis
# Store recent messages for replay
XADD order:{id}:events MAXLEN 100 * type status_change data {...}

# On reconnect, read from last known ID
XREAD STREAMS order:{id}:events $last_id
```

## Data Lifecycle Policies

### Retention Policies

| Data Type | Hot Storage | Warm Storage | Archive | Deletion |
|-----------|-------------|--------------|---------|----------|
| Active orders | PostgreSQL | - | - | - |
| Completed orders | PostgreSQL (30 days) | PostgreSQL partitioned (1 year) | CSV export to MinIO (7 years) | After 7 years |
| Driver locations (Redis) | Current only | - | - | Overwritten continuously |
| Driver location history | PostgreSQL (7 days) | - | Aggregated daily to MinIO | After 30 days |
| Session tokens | Redis (24h TTL) | - | - | Auto-expire |
| Idempotency keys | PostgreSQL (24h) | - | - | Cron purge daily |
| Audit logs | PostgreSQL (90 days) | - | MinIO (2 years) | After 2 years |

### PostgreSQL Table Partitioning

Orders are partitioned by month for efficient archival:

```sql
-- Create partitioned orders table
CREATE TABLE orders (
  id SERIAL,
  created_at TIMESTAMP NOT NULL,
  -- ... other columns
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE orders_2025_01 PARTITION OF orders
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- Detach and archive old partitions
ALTER TABLE orders DETACH PARTITION orders_2024_01;
-- Export to CSV, upload to MinIO, then DROP
```

### Archival Procedure (Local Development)

For the local learning project, archival is simplified:

```bash
# Weekly archive script (run manually or via cron)
#!/bin/bash
ARCHIVE_DATE=$(date -d '30 days ago' +%Y-%m-%d)

# Export old orders to CSV
psql -c "COPY (SELECT * FROM orders WHERE created_at < '$ARCHIVE_DATE')
  TO '/tmp/orders_archive.csv' CSV HEADER"

# Upload to MinIO
mc cp /tmp/orders_archive.csv local/delivery-archive/orders/

# Delete archived records
psql -c "DELETE FROM orders WHERE created_at < '$ARCHIVE_DATE'"
```

### TTL Configuration

```yaml
# Redis TTL settings
session_tokens: 86400      # 24 hours
idempotency_cache: 86400   # 24 hours
driver_metadata: 3600      # 1 hour (refreshed on location update)
pubsub_messages: 3600      # 1 hour retention in streams
```

### Backfill Procedures

**Scenario: Redis geo-index lost after restart**

Redis driver locations are volatile. On Redis restart:
1. All online drivers are marked offline in PostgreSQL
2. Drivers must re-authenticate and call `/go-online`
3. First location update repopulates Redis geo-index

**Scenario: Rebuild search index from PostgreSQL**

```bash
# Restore driver locations from PostgreSQL to Redis
psql -c "SELECT id, current_lat, current_lng FROM drivers WHERE status = 'online'" \
  --csv | while IFS=, read id lat lng; do
    redis-cli GEOADD drivers:locations $lng $lat $id
  done
```

**Scenario: Replay orders for analytics rebuild**

Orders remain in PostgreSQL as source of truth. To rebuild analytics:
1. Query `orders` table with date range
2. Reprocess through analytics pipeline
3. No special replay infrastructure needed for local dev

## Deployment and Operations

### Local Development Rollout

Since this is a learning project running locally, "deployment" means restarting services:

```bash
# Full restart (safe for local dev)
docker-compose down && docker-compose up -d
cd backend && npm run dev

# Zero-downtime restart (multiple instances)
# Start new instance, wait for health check, stop old instance
npm run dev:server2 &
sleep 5
curl http://localhost:3002/health && kill %1
```

### Schema Migration Strategy

Migrations use sequential numbered SQL files:

```
backend/src/db/migrations/
  001_initial_schema.sql
  002_add_driver_location_history.sql
  003_add_idempotency_keys.sql
```

**Migration runner (`npm run db:migrate`):**

```typescript
// Tracks applied migrations in schema_migrations table
const applied = await db.query('SELECT version FROM schema_migrations');
const pending = migrations.filter(m => !applied.includes(m.version));

for (const migration of pending) {
  await db.query('BEGIN');
  try {
    await db.query(migration.sql);
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
```

**Migration best practices:**
- Migrations are forward-only (no automatic rollback)
- Each migration is idempotent where possible (`CREATE TABLE IF NOT EXISTS`)
- Destructive changes (column drops) require manual confirmation
- Test migrations on a copy of production data before applying

### Rollback Runbooks

#### Scenario 1: Bad Migration Applied

**Symptoms:** Application errors after migration, schema mismatch

**Runbook:**
```bash
# 1. Stop the application
pkill -f "npm run dev"

# 2. Identify the bad migration
psql -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"

# 3. Write a compensating migration (e.g., 004_revert_003.sql)
# Example: ALTER TABLE orders DROP COLUMN IF EXISTS bad_column;

# 4. Apply the fix
npm run db:migrate

# 5. Restart application
npm run dev
```

#### Scenario 2: Redis Data Corruption

**Symptoms:** Driver matching fails, locations stale

**Runbook:**
```bash
# 1. Flush driver locations (safe - will repopulate)
redis-cli DEL drivers:locations

# 2. Mark all drivers offline in PostgreSQL
psql -c "UPDATE drivers SET status = 'offline'"

# 3. Notify drivers to re-authenticate (in production: push notification)
# For local dev: manually log drivers back in

# 4. Verify recovery
redis-cli ZCARD drivers:locations  # Should increase as drivers reconnect
```

#### Scenario 3: Application Won't Start

**Symptoms:** Service crashes on startup

**Runbook:**
```bash
# 1. Check logs for error
npm run dev 2>&1 | head -50

# 2. Verify dependencies are running
docker-compose ps
curl http://localhost:5432  # PostgreSQL (will fail but port check)
redis-cli ping              # Should return PONG

# 3. Reset to known good state
git stash                   # Save local changes
git checkout main           # Return to stable branch
npm run dev                 # Try again

# 4. If database is corrupt
docker-compose down -v      # WARNING: Deletes all data
docker-compose up -d
npm run db:migrate
npm run db:seed-admin
```

#### Scenario 4: Orders Stuck in Processing

**Symptoms:** Orders remain in `preparing` state indefinitely

**Runbook:**
```bash
# 1. Identify stuck orders
psql -c "SELECT id, status, created_at FROM orders
  WHERE status IN ('pending', 'preparing')
  AND created_at < NOW() - INTERVAL '1 hour'"

# 2. Option A: Cancel old orders
psql -c "UPDATE orders SET status = 'cancelled', cancelled_at = NOW()
  WHERE status IN ('pending', 'preparing')
  AND created_at < NOW() - INTERVAL '2 hours'"

# 3. Option B: Manually reassign to a driver
psql -c "UPDATE orders SET driver_id = 1, status = 'assigned'
  WHERE id = <stuck_order_id>"
```

### Health Check Endpoints

```typescript
// GET /health - Basic liveness check
{ status: 'ok' }

// GET /health/ready - Readiness with dependency checks
{
  status: 'ok',
  postgres: 'connected',
  redis: 'connected',
  uptime_seconds: 3600
}
```

### Monitoring Alerts (Local Development)

For local development, use simple log-based monitoring:

```bash
# Watch for errors in real-time
npm run dev 2>&1 | grep -E "(ERROR|FATAL|Exception)"

# Check order processing health
watch -n 10 'psql -c "SELECT status, COUNT(*) FROM orders GROUP BY status"'

# Monitor Redis memory
watch -n 30 'redis-cli INFO memory | grep used_memory_human'
```

## Future Optimizations

- [x] Add Prometheus + Grafana for monitoring (Prometheus metrics implemented)
- [ ] Implement surge pricing based on demand/supply
- [ ] Add multi-stop route optimization (TSP)
- [ ] Machine learning for demand prediction
- [ ] Implement push notifications
- [ ] Add payment integration (Stripe)
- [ ] Performance testing with k6 or Artillery

## Implementation Notes

This section documents the rationale behind key operational features implemented in the codebase.

### WHY Idempotency Prevents Duplicate Orders and Charges

**Problem:** Network failures during order placement create a critical risk. If a customer submits an order, the server processes it successfully, but the response is lost due to a network timeout, the client will retry. Without idempotency protection, this retry creates a duplicate order and potentially a double charge.

**Solution:** The idempotency service (`src/shared/idempotency.ts`) implements exactly-once semantics:

```typescript
// Client sends unique key with each order request
const result = await withIdempotency(
  req.headers['x-idempotency-key'],  // e.g., "ord-uuid-12345"
  userId,
  'create_order',
  async () => createOrder(userId, orderData)
);
```

**How it works:**
1. Client generates a unique UUID before submitting the order
2. Server checks `idempotency_keys` table for existing key
3. If key exists with `status=completed`, return cached response (no duplicate)
4. If key doesn't exist, create it with `status=pending`, execute order, update to `completed`
5. If key exists with `status=pending`, another request is in progress (race condition protection)
6. Keys expire after 24 hours to prevent unbounded table growth

**Benefits:**
- Zero duplicate orders on network retries
- Zero double charges (payment would be part of the idempotent operation)
- Safe for aggressive client retry policies
- Audit trail of all order attempts

**Implementation files:**
- `/backend/src/shared/idempotency.ts` - Core idempotency logic
- `/backend/src/routes/orders.ts` - Integration with order creation
- `/backend/src/db/migrations/001_add_idempotency_keys.sql` - Database schema

### WHY Delivery Retention Balances History vs Storage

**Problem:** A delivery service generates massive amounts of data: orders, driver location history, offer records, ratings. Keeping everything forever leads to:
- Unbounded database growth (100K orders/day = 36M orders/year)
- Slower queries as tables grow
- Higher infrastructure costs
- Compliance risks (GDPR right to erasure)

**Solution:** The retention service (`src/shared/retention.ts`) implements tiered data lifecycle:

| Data Type | Hot (Fast Access) | Warm (Queryable) | Archive (Cold) | Delete |
|-----------|-------------------|------------------|----------------|--------|
| Orders | 30 days | 1 year | 7 years (MinIO) | After 7 years |
| Driver locations | Current only | 7 days | 30 days aggregated | After 30 days |
| Sessions | 24 hours | - | - | Auto-expire |
| Idempotency keys | 24 hours | - | - | Daily cleanup |

**Rationale by data type:**

1. **Orders (30 days hot, 7 years archive)**
   - Hot: Recent orders for customer support, refunds, disputes
   - Archive: Legal compliance, financial auditing, fraud investigation
   - 7 years: Standard financial record retention period

2. **Driver location history (7 days hot, 30 days warm)**
   - Hot: Route optimization analysis, ETA accuracy tuning
   - Warm: Weekly aggregated analytics, driver performance review
   - Delete: Individual GPS points have no long-term value after aggregation

3. **Sessions (24 hours)**
   - Functional requirement only (authentication)
   - No business value in historical sessions
   - Auto-expire via Redis TTL

**Implementation files:**
- `/backend/src/shared/retention.ts` - Cleanup jobs and policy management
- `/backend/src/db/migrations/002_add_retention_policies.sql` - Configuration table

### WHY Driver Metrics Enable Route Optimization

**Problem:** Without visibility into driver behavior and delivery patterns, the system cannot:
- Identify underperforming drivers
- Optimize matching algorithm weights
- Predict demand surges
- Detect systematic issues (e.g., certain zones always have delayed deliveries)

**Solution:** Prometheus metrics (`src/shared/metrics.ts`) track key driver and delivery KPIs:

```typescript
// Driver assignment metrics
driverAssignmentsCounter.inc({ result: 'accepted' });  // or 'rejected', 'expired', 'no_driver'
driverMatchingDurationHistogram.observe(duration);     // Time to find a driver
offersPerAssignmentHistogram.observe(offerCount);      // Offers before acceptance

// Delivery performance
deliveryTimeHistogram.observe(deliverySeconds);        // Pickup to delivery time
deliveryDistanceHistogram.observe(distanceKm);         // Delivery distance distribution
```

**How metrics enable optimization:**

1. **Matching algorithm tuning:**
   - If `offers_per_assignment` is consistently high, drivers are rejecting orders
   - Analyze by zone to find areas with driver shortages
   - Adjust scoring weights based on what actually predicts acceptance

2. **Route optimization:**
   - `delivery_time` histogram reveals slow zones (traffic, building access issues)
   - `delivery_distance` distribution shows if matching prefers close drivers effectively
   - Correlation with `vehicle_type` reveals which vehicles are optimal for which zones

3. **Capacity planning:**
   - `online_drivers` gauge by time-of-day shows driver availability patterns
   - `driver_acceptance_rate` histogram identifies reliable vs. flaky drivers
   - `active_orders` by status shows system throughput bottlenecks

**Prometheus endpoint:** `GET /metrics` returns all metrics in Prometheus text format.

**Implementation files:**
- `/backend/src/shared/metrics.ts` - Metric definitions
- `/backend/src/services/orderService.ts` - Driver matching metrics
- `/backend/src/index.ts` - HTTP request metrics and `/metrics` endpoint

### WHY Circuit Breakers Protect Matching Service

**Problem:** The driver matching service depends on multiple external systems:
- Redis for geo queries (finding nearby drivers)
- PostgreSQL for driver details and offer records
- Network I/O for each driver offer/response cycle

If any dependency is slow or unavailable:
- Matching requests pile up, consuming memory
- Workers block waiting for timeouts
- System becomes unresponsive to all requests
- Cascading failure affects unrelated features

**Solution:** Circuit breaker pattern (`src/shared/circuitBreaker.ts`) wraps the matching service:

```typescript
const driverMatchingCircuitBreaker = createCircuitBreaker(
  'driver-matching',
  async (orderId: string) => startDriverMatching(orderId),
  {
    timeout: 180000,              // 3 minutes per matching attempt
    errorThresholdPercentage: 50, // Open after 50% failures
    volumeThreshold: 3,           // Minimum 3 requests before tripping
    resetTimeout: 30000,          // Try again after 30 seconds
  }
);
```

**Circuit breaker states:**

1. **Closed (Normal):** All requests pass through. Failures are counted.
2. **Open (Tripped):** All requests fail immediately with fallback. No matching attempted.
3. **Half-Open (Testing):** One request allowed through to test recovery.

**Fallback behavior:**
```typescript
driverMatchingCircuitBreaker.fallback(async (orderId: string) => {
  // Order stays in 'pending' status
  // Logged for manual intervention or retry queue
  return false;
});
```

**Why this matters:**

1. **Fail fast:** Instead of waiting 3 minutes per order during an outage, orders fail in <1ms
2. **System stability:** Other endpoints (order history, login) remain responsive
3. **Auto-recovery:** Half-open state automatically tests when the matching service recovers
4. **Observability:** Circuit state exposed in `/health` and Prometheus metrics

**Circuit breaker metrics:**
```typescript
circuitBreakerState.set({ name: 'driver-matching' }, 1);  // 0=closed, 0.5=half-open, 1=open
circuitBreakerEvents.inc({ name: 'driver-matching', event: 'open' });
```

**Implementation files:**
- `/backend/src/shared/circuitBreaker.ts` - Generic circuit breaker factory
- `/backend/src/services/orderService.ts` - Driver matching circuit breaker
- `/backend/src/index.ts` - Health check includes circuit breaker status
