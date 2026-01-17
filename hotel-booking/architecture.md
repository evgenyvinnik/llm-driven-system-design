# Hotel Booking - Hotel Reservation and Management System - Architecture Design

## System Overview

A hotel reservation and management system with inventory management, pricing, and booking capabilities. This design targets a local development learning environment while demonstrating production-grade patterns.

## Requirements

### Functional Requirements

- Hotel and room inventory management
- Search and filtering (location, dates, price, amenities)
- Booking and reservation system with double-booking prevention
- Pricing and availability with dynamic pricing support
- Payment processing (simulated for local development)
- Booking modifications and cancellations
- Reviews and ratings
- Loyalty programs (stretch goal)

### Non-Functional Requirements

- **Scalability:** Support 100 concurrent users locally; design patterns should extend to 10K+ concurrent users
- **Availability:** 99.9% uptime target (allows ~8.7 hours downtime/year in production)
- **Latency:** Search p95 < 500ms, Booking p95 < 1s, Page loads p95 < 2s
- **Consistency:** Strong consistency for bookings (no double-booking), eventual consistency acceptable for search (5-minute stale data OK)

## Capacity Estimation

### Local Development Targets

| Metric | Local Dev | Production Extrapolation |
|--------|-----------|-------------------------|
| Daily Active Users (DAU) | 10-50 | 100,000 |
| Peak concurrent sessions | 10 | 5,000 |
| Searches per second (peak) | 5 RPS | 500 RPS |
| Bookings per second (peak) | 0.1 RPS | 10 RPS |
| Hotels in system | 100 | 50,000 |
| Room types per hotel (avg) | 5 | 5 |
| Bookings per day | 10 | 10,000 |

### Storage Growth (Local Development)

| Data Type | Size per Unit | Units/Month | Monthly Growth | 1-Year Total |
|-----------|---------------|-------------|----------------|--------------|
| Hotels | 2 KB | 10 | 20 KB | 240 KB |
| Room Types | 1 KB | 50 | 50 KB | 600 KB |
| Bookings | 500 B | 300 | 150 KB | 1.8 MB |
| Reviews | 1 KB | 100 | 100 KB | 1.2 MB |
| User Sessions (Redis) | 200 B | 500 | 100 KB | Rotating (TTL) |
| Search Index (ES) | 5 KB/hotel | 100 total | - | 500 KB |

**Total storage for 1 year local dev:** ~5 MB PostgreSQL, ~500 KB Elasticsearch, ~1 MB Redis peak

### Component Sizing (Local Development)

Based on capacity estimates:

| Component | Local Config | Rationale |
|-----------|-------------|-----------|
| PostgreSQL | Single instance, 256 MB RAM | 5 MB data fits in memory, no replication needed |
| Redis | Single instance, 128 MB RAM | Session store + availability cache < 10 MB |
| Elasticsearch | Single node, 512 MB heap | 100 hotels, minimal indexing load |
| API Server | 2-3 instances on ports 3001-3003 | Demonstrate load balancing, each 256 MB |
| Background Worker | 1 instance | Process expired reservations, ES sync |

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx:3000)   |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
     +--------v--------+          +----------v--------+          +----------v--------+
     |  API Server 1   |          |   API Server 2    |          |   API Server 3    |
     |   (port 3001)   |          |    (port 3002)    |          |    (port 3003)    |
     +--------+--------+          +----------+--------+          +----------+--------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
        +------------------------------------+------------------------------------+
        |                    |                    |                    |          |
+-------v-------+   +--------v-------+   +-------v-------+   +--------v-------+   |
|  PostgreSQL   |   |     Redis      |   | Elasticsearch |   |   RabbitMQ     |   |
|  (port 5432)  |   |  (port 6379)   |   |  (port 9200)  |   |  (port 5672)   |   |
+---------------+   +----------------+   +---------------+   +----------------+   |
                                                                                  |
                                                              +-------------------v--+
                                                              |  Background Worker   |
                                                              | (reservation expiry, |
                                                              |  ES sync, cleanup)   |
                                                              +----------------------+
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| API Gateway/LB | Route requests, SSL termination, rate limiting | nginx |
| API Server | Business logic, authentication, request handling | Node.js + Express |
| PostgreSQL | Source of truth for hotels, rooms, bookings, users | PostgreSQL 16 |
| Redis | Session storage, availability caching, distributed locks | Redis/Valkey 7 |
| Elasticsearch | Full-text search, geo queries, faceted filtering | Elasticsearch 8 |
| RabbitMQ | Async job processing, ES sync, notifications | RabbitMQ 3.12 |
| Background Worker | Process queued jobs, cleanup expired reservations | Node.js |

### Request Flow Examples

#### Search Flow (Read-Heavy, Eventually Consistent)
```
1. User submits search (location: "NYC", dates: Jan 15-17, guests: 2)
2. nginx routes to API Server (round-robin)
3. API Server queries Elasticsearch for matching hotels
   - Geo-distance filter (50km from NYC center)
   - Amenity filters, price range
   - Returns hotel IDs + metadata
4. For each hotel, check Redis availability cache
   - Cache key: availability:{hotel_id}:{YYYY-MM}
   - If cache miss, query PostgreSQL and populate cache (TTL: 5 min)
5. Filter to hotels with available rooms
6. Return ranked results to user
```

#### Booking Flow (Write, Strongly Consistent)
```
1. User selects hotel, room type, dates (Jan 15-17)
2. API Server begins PostgreSQL transaction
3. SELECT ... FOR UPDATE on room_types row (pessimistic lock)
4. Check availability: no overlapping confirmed bookings for dates
5. If available:
   a. Insert booking with status='reserved', expires_at=NOW()+15min
   b. Commit transaction
   c. Invalidate Redis availability cache for affected dates
   d. Return reservation_id to user
6. If unavailable:
   a. Rollback transaction
   b. Return 409 Conflict with alternative suggestions
7. User completes payment within 15 minutes
8. Update booking status='confirmed', clear expires_at
9. Publish "booking.confirmed" event to RabbitMQ for notifications
```

#### Reservation Expiry Flow (Background)
```
1. Worker polls every 60 seconds
2. Query: SELECT * FROM bookings WHERE status='reserved' AND expires_at < NOW()
3. For each expired reservation:
   a. Update status='expired'
   b. Invalidate availability cache
   c. Log for analytics
```

## Data Model

### Database Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'guest', -- 'guest', 'hotel_admin', 'system_admin'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users(email);

-- Hotels table
CREATE TABLE hotels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    country VARCHAR(100) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    star_rating INTEGER CHECK (star_rating BETWEEN 1 AND 5),
    amenities JSONB DEFAULT '[]',
    images JSONB DEFAULT '[]',
    status VARCHAR(50) DEFAULT 'active', -- 'active', 'inactive', 'pending'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_hotels_city ON hotels(city);
CREATE INDEX idx_hotels_owner ON hotels(owner_id);
CREATE INDEX idx_hotels_status ON hotels(status);

-- Room types table
CREATE TABLE room_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID REFERENCES hotels(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    base_price DECIMAL(10, 2) NOT NULL,
    max_guests INTEGER NOT NULL,
    total_rooms INTEGER NOT NULL, -- Total inventory
    amenities JSONB DEFAULT '[]',
    images JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_room_types_hotel ON room_types(hotel_id);

-- Price overrides for dynamic pricing
CREATE TABLE price_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID REFERENCES room_types(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    reason VARCHAR(100), -- 'weekend', 'holiday', 'high_demand', 'promotion'
    UNIQUE(room_type_id, date)
);
CREATE INDEX idx_price_overrides_room_date ON price_overrides(room_type_id, date);

-- Bookings table
CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    hotel_id UUID REFERENCES hotels(id),
    room_type_id UUID REFERENCES room_types(id),
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    guests INTEGER NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'reserved', -- 'reserved', 'confirmed', 'cancelled', 'completed', 'expired'
    guest_name VARCHAR(255) NOT NULL,
    guest_email VARCHAR(255) NOT NULL,
    special_requests TEXT,
    expires_at TIMESTAMP, -- For reserved bookings
    cancelled_at TIMESTAMP,
    idempotency_key VARCHAR(255) UNIQUE, -- Prevent duplicate bookings
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT valid_dates CHECK (check_out > check_in)
);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_hotel ON bookings(hotel_id);
CREATE INDEX idx_bookings_room_type ON bookings(room_type_id);
CREATE INDEX idx_bookings_dates ON bookings(room_type_id, check_in, check_out);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_expires ON bookings(expires_at) WHERE status = 'reserved';

-- Reviews table
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID REFERENCES bookings(id) UNIQUE,
    user_id UUID REFERENCES users(id),
    hotel_id UUID REFERENCES hotels(id),
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    title VARCHAR(255),
    content TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_reviews_hotel ON reviews(hotel_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);
```

### Availability Query

```sql
-- Get available rooms for a room type on given dates
-- Uses generate_series to check each night in the range
SELECT rt.total_rooms - COALESCE(booked.count, 0) AS available_rooms
FROM room_types rt
LEFT JOIN (
    SELECT room_type_id, MAX(nightly_bookings) AS count
    FROM (
        SELECT
            room_type_id,
            d::date,
            COUNT(*) AS nightly_bookings
        FROM bookings b
        CROSS JOIN generate_series(b.check_in, b.check_out - INTERVAL '1 day', '1 day') AS d
        WHERE b.room_type_id = $1
          AND b.status IN ('reserved', 'confirmed')
          AND d::date >= $2 AND d::date < $3
        GROUP BY room_type_id, d::date
    ) nightly
    GROUP BY room_type_id
) booked ON rt.id = booked.room_type_id
WHERE rt.id = $1;
```

### Storage Strategy

| Data Type | Storage Engine | Rationale |
|-----------|---------------|-----------|
| Users, Hotels, Bookings | PostgreSQL | ACID transactions, relational integrity |
| Sessions | Redis (TTL: 24h) | Fast lookup, automatic expiry |
| Availability Cache | Redis (TTL: 5min) | Read-heavy, tolerates stale data |
| Search Index | Elasticsearch | Full-text, geo queries, faceted search |
| Job Queue | RabbitMQ | Reliable delivery, dead-letter handling |

### Caching Strategy

| Cache Key Pattern | TTL | Invalidation Trigger |
|------------------|-----|---------------------|
| `session:{session_id}` | 24 hours | Logout, password change |
| `availability:{hotel_id}:{YYYY-MM}` | 5 minutes | Booking create/cancel/expire |
| `hotel:{hotel_id}` | 10 minutes | Hotel update |
| `search:{query_hash}` | 2 minutes | None (short TTL only) |

**Cache-Aside Pattern:**
1. Check Redis for cached value
2. On miss, query PostgreSQL
3. Store result in Redis with TTL
4. Return to caller

**Invalidation Strategy:**
- Booking operations explicitly delete affected cache keys
- Use Redis key patterns: `DEL availability:hotel123:*` when hotel changes significantly

## API Design

### Core Endpoints

#### Authentication
```
POST /api/v1/auth/register     # Create user account
POST /api/v1/auth/login        # Create session
POST /api/v1/auth/logout       # Destroy session
GET  /api/v1/auth/me           # Get current user
```

#### Hotels (Public)
```
GET  /api/v1/hotels            # List hotels with filters
GET  /api/v1/hotels/:id        # Get hotel details
GET  /api/v1/hotels/:id/rooms  # Get room types and availability
```

#### Search
```
POST /api/v1/search            # Search hotels
{
  "location": "New York",
  "checkIn": "2024-01-15",
  "checkOut": "2024-01-17",
  "guests": 2,
  "priceMin": 100,
  "priceMax": 500,
  "amenities": ["wifi", "parking"],
  "starRating": [4, 5]
}
```

#### Bookings
```
POST   /api/v1/bookings              # Create reservation
GET    /api/v1/bookings              # List user's bookings
GET    /api/v1/bookings/:id          # Get booking details
POST   /api/v1/bookings/:id/confirm  # Confirm after payment
POST   /api/v1/bookings/:id/cancel   # Cancel booking
```

#### Reviews
```
POST /api/v1/bookings/:id/review  # Submit review for completed stay
GET  /api/v1/hotels/:id/reviews   # Get hotel reviews
```

#### Admin Endpoints
```
GET    /api/v1/admin/hotels              # List admin's hotels
POST   /api/v1/admin/hotels              # Create hotel
PUT    /api/v1/admin/hotels/:id          # Update hotel
DELETE /api/v1/admin/hotels/:id          # Delete hotel
GET    /api/v1/admin/hotels/:id/bookings # List hotel bookings
POST   /api/v1/admin/rooms               # Create room type
PUT    /api/v1/admin/rooms/:id           # Update room type
PUT    /api/v1/admin/rooms/:id/pricing   # Set price overrides
```

## Key Design Decisions

### Inventory Management and Overbooking

**Approach:** Strict inventory with optional soft limits for overbooking.

```sql
-- Room types can have soft_limit for overbooking
ALTER TABLE room_types ADD COLUMN soft_limit INTEGER; -- NULL = no overbooking

-- Availability check respects either total_rooms or soft_limit
-- soft_limit typically = total_rooms * 1.05 (5% overbooking)
```

**Trade-off:** Overbooking increases revenue but requires a rebooking workflow when inventory is truly exhausted. For local dev, we implement strict limits only.

### Concurrency Control for Bookings

**Approach:** Pessimistic locking with `SELECT ... FOR UPDATE`.

```sql
BEGIN;
-- Lock the room type row
SELECT * FROM room_types WHERE id = $1 FOR UPDATE;

-- Check availability (from previous query)
-- ...

-- Insert booking
INSERT INTO bookings (...) VALUES (...);

COMMIT;
```

**Why pessimistic over optimistic:**
- Booking success rate matters more than throughput
- 1:100 booking-to-search ratio means lock contention is rare
- Simpler than retry loops with version checks

**Fallback for high contention:** If flash sales cause deadlocks, add Redis distributed lock as overflow:
```
SETNX lock:room_type:{id} {uuid} EX 30
```

### Dynamic Pricing

**Approach:** Base price with date-specific overrides.

```javascript
async function getRoomPrice(roomTypeId, date) {
  // Check for override
  const override = await db.query(
    'SELECT price FROM price_overrides WHERE room_type_id = $1 AND date = $2',
    [roomTypeId, date]
  );
  if (override.rows.length > 0) {
    return override.rows[0].price;
  }

  // Fall back to base price
  const room = await db.query(
    'SELECT base_price FROM room_types WHERE id = $1',
    [roomTypeId]
  );
  return room.rows[0].base_price;
}
```

**Future enhancement:** Demand-based pricing using booking velocity and search volume.

### Search and Filtering

**Approach:** Two-phase search combining Elasticsearch speed with PostgreSQL accuracy.

**Phase 1 - Elasticsearch (fast, eventually consistent):**
```json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "city": "New York" } }
      ],
      "filter": [
        { "geo_distance": { "distance": "50km", "location": "40.7128,-74.0060" } },
        { "range": { "min_price": { "lte": 500 } } },
        { "terms": { "amenities": ["wifi", "parking"] } }
      ]
    }
  }
}
```

**Phase 2 - PostgreSQL (accurate availability):**
For each candidate hotel from ES, query real-time availability.

**Optimization:** Cache availability aggressively. For local dev, 5-minute cache is sufficient.

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + TypeScript + Vite | Modern, fast dev experience |
| **Routing** | TanStack Router | Type-safe, file-based routing |
| **State** | Zustand | Simple, minimal boilerplate |
| **Styling** | Tailwind CSS | Rapid UI development |
| **API Server** | Node.js + Express | JavaScript ecosystem, async I/O |
| **Database** | PostgreSQL 16 | ACID, JSON support, mature |
| **Cache** | Redis 7 / Valkey | Sessions, caching, distributed locks |
| **Search** | Elasticsearch 8 | Full-text, geo queries |
| **Queue** | RabbitMQ 3.12 | Reliable messaging, dead-letter queues |
| **Load Balancer** | nginx | Proven, easy configuration |

## Scalability Considerations

### Horizontal Scaling Points

| Component | Scaling Strategy |
|-----------|-----------------|
| API Servers | Add instances behind nginx (stateless) |
| PostgreSQL | Read replicas for search, primary for writes |
| Redis | Redis Cluster for cache, Sentinel for HA |
| Elasticsearch | Add nodes to cluster |
| Workers | Add instances (RabbitMQ handles distribution) |

### Database Sharding (Future)

If PostgreSQL becomes a bottleneck:
- Shard bookings by `hotel_id` hash
- Keep hotels/rooms on primary (rarely updated)
- Use Citus or application-level sharding

### Local Dev Scaling Demo

Run multiple API instances to demonstrate load balancing:
```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
npm run dev:lb       # nginx on port 3000
```

## Security Considerations

### Authentication and Authorization

**Authentication:** Session-based with Redis storage.
```javascript
// Session creation on login
const sessionId = crypto.randomUUID();
await redis.setex(`session:${sessionId}`, 86400, JSON.stringify({
  userId: user.id,
  role: user.role,
  createdAt: Date.now()
}));
res.cookie('session_id', sessionId, { httpOnly: true, secure: true, sameSite: 'strict' });
```

**Authorization (RBAC):**
| Role | Permissions |
|------|-------------|
| `guest` | Search, book, view own bookings, submit reviews |
| `hotel_admin` | Manage own hotels, view hotel bookings, set pricing |
| `system_admin` | All operations, user management, system config |

```javascript
// Middleware example
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Usage
app.post('/api/v1/admin/hotels', requireRole('hotel_admin', 'system_admin'), createHotel);
```

### Rate Limiting

| Endpoint Pattern | Limit | Window |
|-----------------|-------|--------|
| `/api/v1/auth/login` | 5 requests | 1 minute |
| `/api/v1/search` | 30 requests | 1 minute |
| `/api/v1/bookings` (POST) | 10 requests | 1 minute |
| Default | 100 requests | 1 minute |

```javascript
// Using express-rate-limit
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, try again later' }
});
app.post('/api/v1/auth/login', loginLimiter, loginHandler);
```

### Input Validation

- Validate all inputs with Zod schemas
- Sanitize SQL parameters (parameterized queries only)
- Escape HTML in user-generated content (reviews, hotel descriptions)

### Data Protection

- Passwords hashed with bcrypt (cost factor 12)
- Session cookies: `httpOnly`, `secure`, `sameSite=strict`
- Database connections use SSL in production
- No PII in logs (mask emails, redact card numbers)

## Monitoring and Observability

### Metrics (Prometheus)

```javascript
// Key metrics to track
const metrics = {
  // Request metrics
  http_requests_total: new Counter({ name: 'http_requests_total', labelNames: ['method', 'path', 'status'] }),
  http_request_duration_seconds: new Histogram({ name: 'http_request_duration_seconds', labelNames: ['method', 'path'] }),

  // Business metrics
  bookings_created_total: new Counter({ name: 'bookings_created_total', labelNames: ['status'] }),
  bookings_expired_total: new Counter({ name: 'bookings_expired_total' }),
  search_latency_seconds: new Histogram({ name: 'search_latency_seconds' }),
  availability_cache_hits_total: new Counter({ name: 'availability_cache_hits_total' }),
  availability_cache_misses_total: new Counter({ name: 'availability_cache_misses_total' }),

  // Infrastructure metrics
  db_pool_active: new Gauge({ name: 'db_pool_active' }),
  redis_connected: new Gauge({ name: 'redis_connected' }),
  elasticsearch_cluster_health: new Gauge({ name: 'elasticsearch_cluster_health' })
};
```

### Logging (Structured JSON)

```javascript
// Log format
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "api-server",
  "traceId": "abc123",
  "message": "Booking created",
  "bookingId": "uuid",
  "hotelId": "uuid",
  "userId": "uuid",
  "durationMs": 245
}
```

### Distributed Tracing

- Generate `traceId` at nginx (X-Request-ID header)
- Propagate through all service calls
- Include in logs for cross-service correlation

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| API p95 latency | > 500ms | > 2s |
| Error rate (5xx) | > 1% | > 5% |
| Database connections | > 80% pool | > 95% pool |
| Redis memory | > 70% | > 90% |
| Queue depth | > 1000 | > 5000 |
| Booking failure rate | > 5% | > 10% |

### Local Dev Monitoring Stack

```yaml
# docker-compose.monitoring.yml
services:
  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3030:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Elasticsearch query | 3 | Exponential (100ms, 200ms, 400ms) | Safe (read) |
| Redis cache | 1 | None | Safe (cache-aside) |
| Booking creation | 0 | None | Idempotency key required |
| Payment confirmation | 3 | Exponential | Idempotency key required |
| Queue publish | 3 | Exponential | Message deduplication |

### Idempotency Keys

```javascript
// Booking creation with idempotency
app.post('/api/v1/bookings', async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'X-Idempotency-Key header required' });
  }

  // Check if already processed
  const existing = await db.query(
    'SELECT id, status FROM bookings WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existing.rows.length > 0) {
    return res.status(200).json({ booking: existing.rows[0], deduplicated: true });
  }

  // Process new booking...
});
```

### Circuit Breaker Pattern

```javascript
// For external services (future: payment gateway)
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,        // Open after 5 failures
  resetTimeout: 30000,        // Try again after 30s
  monitorInterval: 10000      // Check every 10s
});

async function processPayment(bookingId, amount) {
  return circuitBreaker.execute(async () => {
    return await paymentGateway.charge(bookingId, amount);
  });
}
```

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|------------------|
| Elasticsearch down | Search falls back to PostgreSQL (slower, limited) |
| Redis down | Sessions fail (force re-login), skip cache |
| RabbitMQ down | Write to local file queue, process when restored |
| Payment gateway down | Queue booking, notify user of delay |

### Database Failure Recovery

```javascript
// Connection pool with automatic reconnection
const pool = new Pool({
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20,
  // Retry logic
  connectionRetries: 3,
  retryDelayMs: 1000
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
  // Alert, but pool will attempt reconnection
});
```

### Disaster Recovery (Production Considerations)

| Component | Backup Strategy | RTO | RPO |
|-----------|----------------|-----|-----|
| PostgreSQL | Daily full + WAL streaming | 1 hour | 5 minutes |
| Redis | RDB snapshots (hourly) | 15 minutes | 1 hour |
| Elasticsearch | Snapshots to S3 (daily) | 2 hours | 24 hours |

For local development: Rely on Docker volumes and `docker-compose down -v` awareness.

## Cost Tradeoffs

### Local Development Resource Usage

| Component | Memory | CPU | Disk |
|-----------|--------|-----|------|
| PostgreSQL | 256 MB | 0.5 core | 100 MB |
| Redis | 128 MB | 0.1 core | 10 MB |
| Elasticsearch | 512 MB | 0.5 core | 200 MB |
| RabbitMQ | 128 MB | 0.1 core | 50 MB |
| API Server (x3) | 768 MB | 0.3 core | - |
| nginx | 32 MB | 0.1 core | - |
| **Total** | **~2 GB** | **~2 cores** | **~400 MB** |

### Production Cost Optimization

| Decision | Cost Impact | Trade-off |
|----------|-------------|-----------|
| Single Redis (no cluster) | -$50/mo | Reduced availability |
| Elasticsearch 1 node | -$100/mo | No search HA |
| Aggressive caching (5min TTL) | -$30/mo | Slightly stale search results |
| Reserved instances | -40% | 1-year commitment |
| Spot instances for workers | -60% | Interruption handling needed |

### When to Add Components

| Trigger | Action | Estimated Cost |
|---------|--------|----------------|
| p95 latency > 500ms | Add API server instance | +$20/mo |
| Cache hit rate < 80% | Increase Redis memory | +$10/mo |
| DB CPU > 70% sustained | Add read replica | +$50/mo |
| Search latency > 200ms | Add ES node | +$100/mo |

## Trade-offs and Alternatives

### Considered Alternatives

| Decision | Alternative | Why Not Chosen |
|----------|-------------|----------------|
| PostgreSQL for bookings | MongoDB | Need ACID transactions for inventory |
| Redis sessions | JWT tokens | Simpler revocation with Redis |
| Pessimistic locking | Optimistic locking | Lower complexity, acceptable throughput |
| RabbitMQ | Kafka | Simpler for job queue, no event sourcing needed |
| Elasticsearch | PostgreSQL full-text | Better geo queries, faceted search |

### Known Limitations

1. **Single primary database:** Write throughput limited (~1000 TPS). Acceptable for learning project.
2. **No multi-region:** All components in single region. Add read replicas and CDN for production.
3. **Simulated payments:** No real payment gateway integration. Add Stripe/PayPal for production.
4. **No mobile app:** API designed for web. Add mobile SDK and push notifications for production.

## Future Optimizations

### Short Term (Next Implementation Phase)
- [ ] Add comprehensive test suite (unit, integration, e2e)
- [ ] Implement Prometheus metrics collection
- [ ] Add Grafana dashboards
- [ ] Load test booking concurrency with k6

### Medium Term
- [ ] Payment gateway integration (Stripe test mode)
- [ ] Email notifications via SendGrid/Mailgun
- [ ] Image upload to MinIO (S3-compatible)
- [ ] Admin analytics dashboard

### Long Term (Production Readiness)
- [ ] Multi-region deployment
- [ ] Database read replicas
- [ ] CDN for static assets
- [ ] Mobile app API endpoints
- [ ] Loyalty program implementation
- [ ] Machine learning for dynamic pricing
