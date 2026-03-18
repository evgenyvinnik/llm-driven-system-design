# Ticketmaster - Event Ticketing - Architecture Design

## System Overview

An event ticketing and inventory management platform designed to handle extreme traffic spikes during high-demand on-sales while preventing overselling and ensuring fair access to tickets. The system must handle 100x traffic surges (from 200 RPS to 20,000 RPS) during popular on-sales, maintain zero overselling, and provide a fair queuing experience for users.

## Requirements

### Functional Requirements

- **Event Browsing** - Search and discover events by location, date, artist, venue, category
- **Seat Selection** - Interactive venue seat maps with real-time availability
- **Ticket Purchase** - Reserve seats, checkout with payment, order confirmation
- **Inventory Management** - Real-time seat availability across all sales channels, per-event seat generation from venue templates
- **Virtual Waiting Room** - Fair queuing for high-demand events with admission control
- **Order Management** - View tickets, order history

### Non-Functional Requirements

- **Scalability**: Handle 100x traffic spikes during popular on-sales (200 RPS to 20,000 RPS)
- **Availability**: 99.9% uptime; zero downtime during high-profile on-sales
- **Latency**: Seat map load < 200ms p95; checkout initiation < 500ms p95
- **Consistency**: Strong consistency for seat inventory (no overselling ever)

## Capacity Estimation

### Production Scale

| Metric | Normal | Peak (On-Sale) |
|--------|--------|----------------|
| Concurrent users | 10,000 | 100,000 |
| RPS | 200 | 20,000 |
| Active shopping sessions | 500 | 5,000 |
| Seat locks held | 2,000 | 50,000 |

### Storage Requirements

| Data Type | Estimate |
|-----------|----------|
| Events | 50,000/year x 5KB = 250MB |
| Seats | 50,000 events x 10,000 seats x 200B = 100GB |
| Orders | 5M orders/year x 500B = 2.5GB |
| Users | 10M users x 1KB = 10GB |
| Redis (locks + sessions + queue) | ~5GB peak during on-sale |

### SLO Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| API availability | 99.9% | < 99.5% |
| Seat map load time | < 200ms p95 | > 300ms p95 |
| Seat reservation time | < 100ms p95 | > 200ms p95 |
| Checkout completion | < 2s p95 | > 3s p95 |
| Queue position accuracy | +/- 5% | > 10% drift |
| Seat lock success rate | > 99.9% | < 99% |
| Zero overselling | 0 incidents | Any oversell |

## High-Level Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│   React SPA      │   │   Mobile App     │   │   Admin UI       │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │                      │                       │
         └──────────────────────┼───────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                    CDN (Static Assets)                        │
└───────────────────────────┬───────────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────────┐
│              API Gateway / Load Balancer                      │
│   (Rate limiting, SSL, auto-scaling trigger, queue routing)  │
└───────────────────────────┬───────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ API Server  │     │ API Server  │     │ API Server  │
│    (1)      │     │    (2)      │     │    (N)      │
│             │     │             │     │  (auto-     │
│ - Events    │     │ - Events    │     │   scaled)   │
│ - Seats     │     │ - Seats     │     │             │
│ - Queue     │     │ - Queue     │     │             │
│ - Checkout  │     │ - Checkout  │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌─────────────┐    ┌─────────────────┐    ┌──────────────────┐
│ PostgreSQL  │    │ Redis/Valkey    │    │  RabbitMQ        │
│ Primary     │    │ Cluster         │    │  (Future)        │
│             │    │                 │    │                  │
│ Events      │    │ Sessions        │    │ - Notifications  │
│ Venues      │    │ Seat locks      │    │ - Email queue    │
│ Seats       │    │ Queue state     │    │ - Analytics      │
│ Orders      │    │ Active sessions │    │                  │
│ Users       │    │ Availability    │    │                  │
│ Idempotency │    │   cache         │    │                  │
│   keys      │    │ Rate limits     │    │                  │
└──────┬──────┘    └─────────────────┘    └──────────────────┘
       │
       ▼
┌─────────────┐
│ PostgreSQL  │
│ Read        │
│ Replicas    │
│ (browsing)  │
└─────────────┘
```

### Request Flows

#### 1. Event Browsing (Read Path)

```
Client ──▶ Load Balancer ──▶ API Server ──▶ Redis Cache (if hit) ──▶ Response
                                        ──▶ PostgreSQL (if miss) ──▶ Cache ──▶ Response
```

#### 2. Seat Selection (Write Path - Critical)

```
Client ──▶ Load Balancer ──▶ API Server
                                  │
                                  ├─1──▶ Redis: SET lock:seat:{event}:{seat} NX EX 600
                                  │      (atomic lock with 10-min TTL)
                                  │
                                  ├─2──▶ PostgreSQL: BEGIN; SELECT FOR UPDATE NOWAIT
                                  │      (database-level lock for ACID)
                                  │
                                  ├─3──▶ PostgreSQL: UPDATE event_seats SET status='held'
                                  │
                                  ├─4──▶ COMMIT
                                  │
                                  └─5──▶ Response with reservation confirmation
```

#### 3. Checkout (Write Path - Payment)

```
Client ──▶ API Server ──▶ Check idempotency key (Redis + DB)
                       ──▶ Verify Redis lock still held
                       ──▶ PostgreSQL: BEGIN
                       ──▶ Verify seat status = 'held' by this session
                       ──▶ Payment processing (circuit breaker wrapped)
                       ──▶ UPDATE event_seats SET status='sold'
                       ──▶ INSERT order + order_items
                       ──▶ COMMIT
                       ──▶ Store idempotency result
                       ──▶ Delete Redis locks
                       ──▶ Response
```

#### 4. Virtual Waiting Room (High-Demand Events)

```
Client ──▶ API Server ──▶ Redis ZADD queue:{event} {timestamp} {session}
                       ──▶ Periodic poll: Redis ZRANK queue:{event} {session}
                       ──▶ When admitted: Redis SADD active:{event} {session}
                       ──▶ Allow seat selection
```

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Venues table
CREATE TABLE venues (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    address VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    country VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL,
    image_url VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Venue sections (template for seat layout)
CREATE TABLE venue_sections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    row_count INTEGER NOT NULL,
    seats_per_row INTEGER NOT NULL,
    base_price DECIMAL(10,2) NOT NULL,
    section_type VARCHAR(20) DEFAULT 'standard'
      CHECK (section_type IN ('vip', 'premium', 'standard', 'economy')),
    position_x INTEGER DEFAULT 0,
    position_y INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(venue_id, name)
);

-- Events table
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    venue_id UUID NOT NULL REFERENCES venues(id),
    artist VARCHAR(255),
    category VARCHAR(50) DEFAULT 'concert'
      CHECK (category IN ('concert', 'sports', 'theater', 'comedy', 'other')),
    event_date TIMESTAMP WITH TIME ZONE NOT NULL,
    on_sale_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'upcoming'
      CHECK (status IN ('upcoming', 'on_sale', 'sold_out', 'cancelled', 'completed')),
    total_capacity INTEGER NOT NULL,
    available_seats INTEGER NOT NULL,
    image_url VARCHAR(500),
    waiting_room_enabled BOOLEAN DEFAULT false,
    max_concurrent_shoppers INTEGER DEFAULT 5000,
    max_tickets_per_user INTEGER DEFAULT 4,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_events_date ON events(event_date);
CREATE INDEX idx_events_on_sale ON events(on_sale_date);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_venue ON events(venue_id);

-- Event seats (per-event inventory)
CREATE TABLE event_seats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    section VARCHAR(50) NOT NULL,
    row VARCHAR(10) NOT NULL,
    seat_number VARCHAR(10) NOT NULL,
    price_tier VARCHAR(20) DEFAULT 'standard'
      CHECK (price_tier IN ('vip', 'premium', 'standard', 'economy')),
    price DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'available'
      CHECK (status IN ('available', 'held', 'sold')),
    held_until TIMESTAMP WITH TIME ZONE,
    held_by_session VARCHAR(64),
    order_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(event_id, section, row, seat_number)
);
CREATE INDEX idx_event_seats_event_status ON event_seats(event_id, status);
CREATE INDEX idx_event_seats_held_until ON event_seats(held_until) WHERE status = 'held';
CREATE INDEX idx_event_seats_session ON event_seats(held_by_session) WHERE held_by_session IS NOT NULL;

-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    event_id UUID NOT NULL REFERENCES events(id),
    status VARCHAR(20) DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'cancelled', 'refunded', 'payment_failed')),
    total_amount DECIMAL(10,2) NOT NULL,
    payment_id VARCHAR(64),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_event ON orders(event_id);
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Order items table
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    seat_id UUID NOT NULL REFERENCES event_seats(id),
    price DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions table
CREATE TABLE sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Idempotency keys table
CREATE TABLE idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,
    result JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);

-- Function to generate seats for an event based on venue sections
CREATE OR REPLACE FUNCTION generate_event_seats(p_event_id UUID)
RETURNS void AS $$
DECLARE
    v_venue_id UUID;
    v_section RECORD;
    v_row INTEGER;
    v_seat INTEGER;
    v_row_letter VARCHAR(10);
BEGIN
    SELECT venue_id INTO v_venue_id FROM events WHERE id = p_event_id;
    IF v_venue_id IS NULL THEN
        RAISE EXCEPTION 'Event not found: %', p_event_id;
    END IF;
    FOR v_section IN SELECT * FROM venue_sections WHERE venue_id = v_venue_id LOOP
        FOR v_row IN 1..v_section.row_count LOOP
            v_row_letter := CHR(64 + v_row);
            FOR v_seat IN 1..v_section.seats_per_row LOOP
                INSERT INTO event_seats (event_id, section, row, seat_number, price_tier, price, status)
                VALUES (p_event_id, v_section.name, v_row_letter, v_seat::VARCHAR, v_section.section_type, v_section.base_price, 'available')
                ON CONFLICT (event_id, section, row, seat_number) DO NOTHING;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

### Redis Data Structures

```
# Session storage
session:{session_id} = {user_id, created_at, ...}  (TTL: 24h)

# Distributed seat locks (critical path)
lock:seat:{event_id}:{seat_id} = {token}  (TTL: 600s / 10 min)

# Virtual waiting room queue (sorted set)
queue:{event_id} = ZSET { session_id: join_timestamp, ... }

# Active shopping sessions (admitted from queue)
active:{event_id} = SET { session_id, ... }
active_session:{event_id}:{session_id} = "1"  (TTL: 900s / 15 min)

# Event availability cache
availability:{event_id} = JSON { sections: [...], available_count: N }  (TTL: 5s peak, 30s normal)

# Idempotency cache
idempotency:{key} = JSON { result, createdAt, completedAt }  (TTL: 24h)

# Rate limiting
rate_limit:{user_id}:{endpoint} = count  (TTL: 60s)
```

### Seat Status State Machine

```
                    reserve_seats()
    ┌───────────┐  ─────────────────►  ┌────────┐
    │ AVAILABLE │                      │  HELD  │
    └───────────┘  ◄─────────────────  └────────┘
          ▲         timeout_cleanup()       │
          │                                 │ complete_checkout()
          │                                 ▼
          │         cancel_order()     ┌────────┐
          └───────────────────────────│  SOLD  │
                                      └────────┘
```

## Caching Strategy

| Data Type | Cache Location | TTL | Invalidation |
|-----------|---------------|-----|--------------|
| Event list | Redis | 60s | On event create/update |
| Event details | Redis | 60s | On event update |
| Venue details | Redis | 5min | On venue update |
| Seat availability | Redis | 5s (on-sale) / 30s (normal) | On seat status change |
| User session | Redis | 24h | On logout |

Dynamic TTL based on event status: 5-second TTL during active on-sales provides near-real-time seat map accuracy while absorbing 95% of read traffic. 30-second TTL for browsing reduces database load when availability is changing slowly.

## API Design

### Core Endpoints

```
Authentication
  POST   /api/v1/auth/register               Create account
  POST   /api/v1/auth/login                  Login (creates session)
  POST   /api/v1/auth/logout                 Logout (destroys session)
  GET    /api/v1/auth/me                     Get current user

Events
  GET    /api/v1/events                      List events (with filters)
  GET    /api/v1/events/:id                  Get event details

Venues
  GET    /api/v1/venues                      List venues
  GET    /api/v1/venues/:id                  Get venue with section layout

Seats
  GET    /api/v1/seats/events/:id            Get seat availability map
  POST   /api/v1/seats/reserve               Reserve seats (creates hold)
  DELETE /api/v1/seats/release               Release held seats

Queue (Virtual Waiting Room)
  POST   /api/v1/queue/:eventId/join         Join waiting queue
  GET    /api/v1/queue/:eventId/position     Get queue position
  GET    /api/v1/queue/:eventId/status       Check if admitted

Checkout
  POST   /api/v1/checkout                    Complete purchase (idempotent)
  GET    /api/v1/checkout/orders             List user orders
  GET    /api/v1/checkout/orders/:id         Get order details
```

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/v1/auth/*` | 10 requests | 1 minute |
| `/api/v1/seats/reserve` | 20 requests | 1 minute |
| `/api/v1/checkout` | 5 requests | 1 minute |
| `/api/v1/queue/*/join` | 5 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

## Key Design Decisions

### 1. Two-Phase Distributed Locking (Redis + PostgreSQL)

**Chose**: Redis SET NX for fast distributed exclusion, then PostgreSQL `FOR UPDATE NOWAIT` for ACID compliance

**Why two phases**: Redis alone is insufficient because locks can expire during long operations and Redis may lose data on restart. PostgreSQL alone is insufficient because row-level locks require database roundtrips (~20ms) and serialize access, creating bottlenecks at 20,000 RPS. The combined approach uses Redis for sub-millisecond "intent to purchase" (filtering 10,000 concurrent requests down to lock holders) and PostgreSQL for the ACID guarantee (ensuring the database state is consistent).

**Alternative**: Database-only locking with `FOR UPDATE SKIP LOCKED`. Simpler but higher latency (10-50ms vs 1ms) and connection pool exhaustion under 20,000 RPS. Acceptable below 1,000 concurrent seat selections.

**Trade-off**: Additional infrastructure (Redis). If Redis fails, circuit breaker falls back to PostgreSQL advisory locks, which work but with higher latency and less capacity.

### 2. Virtual Waiting Room: FIFO Queue vs. Lottery

**Chose**: FIFO queue using Redis sorted sets (score = join timestamp)

**Why FIFO**: Users see their position and estimated wait time, creating a predictable and transparent experience. The queue controls admission rate (configurable `max_concurrent_shoppers`), preventing backend overload during 100x traffic spikes. Without a queue, all 100,000 users would hit the seat map simultaneously, overwhelming the database.

**Alternative**: Random lottery at sale time. More equitable for access (no early-arrival advantage) but less predictable for users and harder to manage operationally.

**Trade-off**: FIFO favors users with faster internet and earlier awareness of on-sale times. Mitigated by randomizing position within the first 5 seconds of queue opening.

### 3. Seat Hold Duration: 10 Minutes

**Chose**: 10-minute seat holds with automatic cleanup

**Why 10 minutes**: Long enough for 95% of users to complete checkout (payment entry + processing). Short enough that abandoned carts release inventory within a reasonable window. During a 10,000-seat event, if 20% of holds are abandoned, that is 2,000 seats locked for at most 10 minutes before becoming available again.

**Alternative**: 5-minute holds with extension option. Faster inventory turnover but more complex UX (users see countdown, must request extension) and higher failure rate for slow typists.

**Trade-off**: Some inventory is temporarily locked in abandoned carts. Background job runs every 60 seconds to clean up expired holds.

### 4. Idempotency for Checkout

**Chose**: Deterministic idempotency keys stored in both Redis (fast) and PostgreSQL (durable)

Key format: `checkout:{sessionId}:{eventId}:{sortedSeatIds}`

**Why this matters**: During a high-demand on-sale, network congestion causes timeouts. Users click "Pay" and see a spinner, then click again. Without idempotency, both requests could create charges. The deterministic key from session + event + seats ensures the same checkout attempt always maps to the same key, and the second request returns the cached first result.

**Trade-off**: Additional storage for idempotency records (24-hour TTL). Negligible cost compared to the financial risk of double-charging.

## Consistency and Idempotency

### Checkout Idempotency Flow

1. Generate key: `checkout:{sessionId}:{eventId}:{sorted_seat_ids}`
2. Check Redis for cached result (fast path)
3. Check PostgreSQL `idempotency_keys` table (durable fallback)
4. If found, return cached result (no new charge)
5. If not found, process checkout and store result in both Redis and PostgreSQL

### Seat Lock Atomicity

Seat locks use Redis SET NX with unique tokens. Release uses a Lua script for atomic check-and-delete:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

This prevents a process from accidentally releasing another process's lock.

## Security / Auth

### Authentication

Session-based with cookie storage. Session IDs are 64-byte cryptographically random strings. Sessions stored in both PostgreSQL (durability) and Redis (fast lookup) with 24-hour TTL.

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Browse events, purchase tickets, view own orders |
| `admin` | All user permissions + create/edit events, manage venues, view all orders |

### Input Validation

- Seat reservation limited to max 6 seats per transaction (`max_tickets_per_user` configurable per event)
- All UUIDs validated before database queries
- Parameterized queries prevent SQL injection

### Security Headers

Helmet middleware with CSP, HSTS, X-Content-Type-Options, X-XSS-Protection.

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total{method,endpoint,status}` | Counter | Request volume |
| `http_request_duration_seconds{method,endpoint}` | Histogram | Latency distribution |
| `seats_reserved_total{event_id}` | Counter | Seat reservations |
| `seats_sold_total{event_id}` | Counter | Completed sales |
| `checkout_completed_total{event_id}` | Counter | Successful checkouts |
| `checkout_failed_total{event_id,reason}` | Counter | Failed checkouts |
| `checkout_duration_seconds{event_id}` | Histogram | Checkout latency |
| `queue_length{event_id}` | Gauge | Current users waiting |
| `active_sessions{event_id}` | Gauge | Users currently shopping |
| `seat_lock_attempts_total{event_id,result}` | Counter | Lock success/failure |
| `circuit_breaker_state{name}` | Gauge | CB state (0=closed, 1=open, 2=half-open) |
| `circuit_breaker_trips_total{name}` | Counter | CB trip count |
| `idempotency_hits` | Counter | Duplicate request detection |
| `idempotency_misses` | Counter | New requests |
| `redis_operation_duration_seconds{operation}` | Histogram | Redis latency |

### Structured Logging

Pino JSON logging with business event loggers:
- `seat_reserved` / `seat_released` / `seat_sold`
- `checkout_completed` / `checkout_failed`
- `lock_contention` - Warns when seat locks fail
- `oversell_prevented` - Critical alert if oversell detected
- `redis_fallback` - Circuit breaker activated
- `circuit_breaker_state_change` - State transitions

### Health Checks

| Endpoint | Purpose | Components |
|----------|---------|------------|
| `GET /health` | Load balancer probe | PostgreSQL, Redis, payment CB status |
| `GET /ready` | Readiness probe | Quick DB + Redis ping |
| `GET /live` | Liveness probe | Process alive check |

### Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | 5xx rate > 1% | Critical |
| Slow responses | p95 latency > 500ms | Warning |
| Queue backup | Queue length > 10,000 | Warning |
| Redis unavailable | Connection failures > 3 | Critical |
| Pool exhausted | Available connections < 2 | Critical |
| Oversell detected | Any seat sold twice | Critical |

## Failure Handling

### Circuit Breaker (Payment Processing)

Custom circuit breaker wrapping payment calls:

| State | Behavior | Transition |
|-------|----------|------------|
| CLOSED | Requests pass through | Opens after 5 failures |
| OPEN | Requests fail immediately | Half-opens after 30 seconds |
| HALF_OPEN | Limited requests test recovery | Closes after 2 successes |

Fail-fast response tells users "Payment service temporarily unavailable" instead of hanging for 30-second timeouts. Health check endpoint includes circuit breaker state.

### Redis Fallback (Seat Locking)

When Redis is unavailable, circuit breaker falls back to PostgreSQL advisory locks:

```
acquireSeatLockWithFallback()
  ├── Try Redis SET NX (normal path)
  ├── On failure, increment failure counter
  ├── After 5 failures, open circuit (30s reset)
  └── While open, use pg_try_advisory_lock()
```

Advisory locks work but with higher latency (~20ms vs ~1ms) and connection pool pressure.

### Expired Hold Cleanup

Background job runs every 60 seconds:
1. Query seats with `status='held' AND held_until < NOW()`
2. Update status to 'available', clear `held_by_session` and `held_until`
3. Clean up corresponding Redis locks
4. Log cleanup count and increment metrics

### Retry Strategy

| Operation | Retries | Approach |
|-----------|---------|----------|
| Seat lock acquisition | 3 | Exponential backoff with jitter |
| Payment processing | Via circuit breaker | Fail-fast when open |
| Checkout | 0 (use idempotency key) | Client retries with same key |

## Scalability Considerations

### Horizontal Scaling

| Component | Strategy |
|-----------|----------|
| API Servers | Add instances behind LB (stateless, auto-scale on RPS) |
| PostgreSQL | Read replicas for event browsing, primary for seat mutations |
| Redis | Sentinel for HA, Cluster for > 10,000 concurrent locks |

### Database Scaling Path

1. **Current**: Single PostgreSQL instance
2. **Next**: Read replicas for event browsing queries
3. **Future**: Shard `event_seats` table by `event_id` for write scale

### Caching Scaling Path

1. **Current**: Single Redis instance
2. **Next**: Redis Sentinel for high availability
3. **Future**: Redis Cluster for > 10,000 concurrent seat locks

### Queue Scaling

Virtual waiting room capacity is configurable per event via `max_concurrent_shoppers`. Queue processor runs every 5 seconds, admitting users as active sessions expire.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Seat locking | Redis + PostgreSQL (dual) | Database-only | Sub-ms Redis + ACID PostgreSQL |
| Waiting room | FIFO queue (Redis ZSET) | Random lottery | Predictable, visible position |
| Hold duration | 10 minutes | 5 min with extension | Simpler UX, acceptable inventory lock |
| Checkout safety | Idempotency keys (Redis + DB) | No dedup | Prevents double-charging |
| Payment resilience | Circuit breaker | Retry loop | Fail-fast, auto-recovery |
| Session storage | Cookie + Redis | JWT | Simple revocation, no token rotation |
| Availability cache | Dynamic TTL (5s/30s) | Fixed TTL | Balance accuracy vs DB load by event status |

## Implementation Notes

This section documents the actual local implementation: what production patterns are implemented, what was simplified, and what was omitted.

### Local Setup Diagram

```
┌──────────────────┐
│  React Frontend  │
│  localhost:5173   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Express API     │
│  localhost:3000   │
│  (or 3001-3003)  │
└──┬──────────┬────┘
   │          │
   ▼          ▼
┌──────┐  ┌──────┐
│Pg    │  │Redis/│
│:5432 │  │Valkey│
│      │  │:6379 │
└──────┘  └──────┘
```

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| **Distributed Locking** | `backend/src/shared/distributed-lock.ts` | Redis SET NX with unique tokens, Lua script release, exponential backoff, multi-seat atomic locking, database advisory lock fallback |
| **Idempotency** | `backend/src/shared/idempotency.ts` | Redis + PostgreSQL dual storage, deterministic key generation from checkout context, `withIdempotency` decorator |
| **Circuit Breaker** | `backend/src/shared/circuit-breaker.ts` | Custom implementation with CLOSED/OPEN/HALF_OPEN states, configurable thresholds, Prometheus metrics integration |
| **Prometheus Metrics** | `backend/src/shared/metrics.ts` | 15+ business and infrastructure metrics (seats, queue, checkout, locks, circuit breaker) exposed at `/metrics` |
| **Structured Logging** | `backend/src/shared/logger.ts` | Pino JSON logging with business event loggers for seat operations, checkout, lock contention, circuit breaker |
| **Health Checks** | `backend/src/index.ts` | Multi-component health check (PostgreSQL, Redis, payment CB state) with latency |
| **Virtual Waiting Room** | `backend/src/services/waiting-room.service.ts` | Redis ZSET queue, admission control, configurable max concurrent shoppers, queue processor |
| **Seat Reservation** | `backend/src/services/seat.service.ts` | Two-phase locking (Redis + PostgreSQL FOR UPDATE NOWAIT), 10-minute hold, background cleanup |
| **Checkout Flow** | `backend/src/services/checkout.service.ts` | Idempotent checkout with circuit-breaker-wrapped payment, seat verification |
| **Background Jobs** | `backend/src/index.ts` | Three interval jobs: expired hold cleanup (60s), on-sale detection (30s), queue metrics update (5s) |
| **Auto On-Sale** | `backend/src/services/event.service.ts` | Automatic event status transition when `on_sale_date` arrives |
| **Seed Data** | `backend/src/db/seed.ts` | Venue + event + seat generation using `generate_event_seats()` function |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Reason |
|-------------------|------------------|--------|
| CDN for static assets | Vite dev server serves directly | No CDN needed for local dev |
| API Gateway (Kong/Envoy) | Express handles routing directly | Single process sufficient |
| Multiple API instances + nginx LB | Single instance (or 3 via `dev:server1/2/3`) | Can demo load balancing manually |
| Payment gateway (Stripe) | Simulated payment with random delay | No real payment integration |
| Redis Cluster/Sentinel | Single Redis instance with AOF persistence | Sufficient for dev |
| RabbitMQ for notifications | Not implemented (future enhancement) | Simplifies initial setup |
| Real email delivery | Not implemented | No SMTP service |
| Elasticsearch for event search | PostgreSQL LIKE queries | Simpler, sufficient for 50 events |
| Auto-scaling API servers | Fixed 1-3 instances | Manual scaling via npm scripts |
| Bot detection | Not implemented | No scalper prevention needed in dev |

### What Was Omitted

- **CDN / Edge caching** - No static asset distribution
- **Multi-region deployment** - Single-machine setup
- **Kubernetes orchestration** - Docker Compose only
- **Real payment gateway** - Simulated payments
- **Email/SMS notifications** - No notification delivery
- **Event search (Elasticsearch)** - Basic PostgreSQL queries only
- **Database read replicas** - Single PostgreSQL instance
- **Redis Cluster** - Single Redis instance
- **Rate limiting middleware** - Defined in architecture but not enforced
- **WebSocket for real-time seat updates** - Polling-based seat map refresh
- **Bot detection / behavioral analysis** - No scalper prevention
- **Mobile ticket delivery / QR codes** - Web-only
- **Secondary market (resale)** - Not implemented
- **Automated schema migrations** - Uses init.sql loaded at container start
