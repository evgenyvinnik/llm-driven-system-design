# Ticketmaster - Event Ticketing - Architecture Design

## System Overview

An event ticketing and inventory management platform designed to handle extreme traffic spikes during high-demand on-sales while preventing overselling and ensuring fair access to tickets.

## Requirements

### Functional Requirements

- **Event Browsing** - Search and discover events by location, date, artist, venue
- **Seat Selection** - Interactive venue maps with real-time available seats
- **Ticket Purchase** - Reserve seats, checkout, payment processing
- **Inventory Management** - Real-time seat availability across all sales channels
- **Order Management** - View tickets, transfers, refunds

### Non-Functional Requirements

- **Scalability**: Handle 100x traffic spikes during popular on-sales (from 200 RPS to 20,000 RPS)
- **Availability**: 99.9% uptime; zero downtime during high-profile on-sales
- **Latency**: Seat selection < 200ms p95; checkout initiation < 500ms p95
- **Consistency**: Strong consistency for seat inventory (no overselling ever)

---

## Capacity Estimation

### Local Development Scale

For this learning project, we simulate a scaled-down version that demonstrates the same patterns:

| Metric | Local Dev | Production Reference |
|--------|-----------|---------------------|
| Events | 50 | 50,000/year |
| Seats per event | 1,000 | 10,000 |
| Concurrent users | 100 | 100,000 |
| Normal RPS | 10 | 200 |
| Peak RPS (on-sale) | 200 | 20,000 |
| Active sessions | 50 | 5,000 |

### Storage Requirements (Local Dev)

```
Events:           50 events x 5 KB     = 250 KB
Seats:            50 events x 1K seats x 200 bytes = 10 MB
Orders:           1,000 orders x 500 bytes = 500 KB
Users:            100 users x 1 KB     = 100 KB
Redis sessions:   100 sessions x 1 KB  = 100 KB
Redis seat locks: 1,000 locks x 100 bytes = 100 KB
─────────────────────────────────────────────────
Total:            ~15 MB PostgreSQL + ~200 KB Redis
```

### Component Sizing (Local Dev)

| Component | Size | Rationale |
|-----------|------|-----------|
| PostgreSQL | 256 MB RAM | Handles 10 MB data + query buffers |
| Redis | 64 MB RAM | Session store + seat locks + queue state |
| API Server | Single instance | Can run 2-3 instances on different ports for load balancing demos |
| Connection pool | 10 connections | Adequate for 200 RPS with 50ms avg query time |

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

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                       │
│  │  React SPA  │  │  Mobile App │  │  Admin UI   │                       │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                       │
└─────────┼────────────────┼────────────────┼──────────────────────────────┘
          │                │                │
          └────────────────┼────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          LOAD BALANCER (nginx)                            │
│                    localhost:3000 → :3001, :3002, :3003                  │
└──────────────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  API Server 1   │ │  API Server 2   │ │  API Server 3   │
│    :3001        │ │    :3002        │ │    :3003        │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
    ┌────────────────────────┼────────────────────────┐
    │                        │                        │
    ▼                        ▼                        ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  PostgreSQL     │  │  Redis          │  │  (Future)       │
│  :5432          │  │  :6379          │  │  RabbitMQ :5672 │
│                 │  │                 │  │                 │
│  - Events       │  │  - Sessions     │  │  - Notifications│
│  - Seats        │  │  - Seat locks   │  │  - Email queue  │
│  - Orders       │  │  - Queue state  │  │  - Analytics    │
│  - Users        │  │  - Cache        │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Request Flow

#### 1. Event Browsing (Read Path)
```
Client → Load Balancer → API Server → Redis Cache (if hit) → Response
                                   → PostgreSQL (if miss) → Cache → Response
```

#### 2. Seat Selection (Write Path - Critical)
```
Client → Load Balancer → API Server
                              │
                              ├─1→ Redis: SET seat_lock:{event}:{seat} NX EX 600
                              │    (atomic lock with 10-min TTL)
                              │
                              ├─2→ PostgreSQL: BEGIN; SELECT FOR UPDATE NOWAIT
                              │    (database-level lock for consistency)
                              │
                              ├─3→ PostgreSQL: UPDATE seats SET status='held'
                              │
                              ├─4→ COMMIT
                              │
                              └─5→ Response with reservation confirmation
```

#### 3. Checkout (Write Path - Payment)
```
Client → API Server → Verify Redis lock still held
                   → PostgreSQL: BEGIN
                   → Verify seat status = 'held' by this session
                   → (Simulated) Payment processing
                   → UPDATE seats SET status='sold'
                   → INSERT order
                   → COMMIT
                   → Delete Redis lock
                   → Response
```

#### 4. Virtual Waiting Room (High-Demand Events)
```
Client → API Server → Redis ZADD queue:{event} {timestamp} {session}
                   → Periodic poll: Redis ZRANK queue:{event} {session}
                   → When admitted: Redis SADD active:{event} {session}
                   → Allow seat selection
```

---

## Data Model

### Database Schema (PostgreSQL)

```sql
-- Users table
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'user',  -- user, admin
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users(email);

-- Venues table
CREATE TABLE venues (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    address         VARCHAR(500),
    city            VARCHAR(100),
    capacity        INTEGER NOT NULL,
    section_config  JSONB,  -- {"sections": [{"name": "A", "rows": 10, "seats_per_row": 20}]}
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Events table
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    venue_id        UUID NOT NULL REFERENCES venues(id),
    event_date      TIMESTAMP NOT NULL,
    on_sale_date    TIMESTAMP NOT NULL,
    status          VARCHAR(20) DEFAULT 'upcoming',  -- upcoming, on_sale, sold_out, completed, cancelled
    high_demand     BOOLEAN DEFAULT FALSE,  -- triggers waiting room
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_on_sale ON events(on_sale_date);
CREATE INDEX idx_events_venue ON events(venue_id);

-- Seats table (per-event inventory)
CREATE TABLE seats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id),
    section         VARCHAR(50) NOT NULL,
    row             VARCHAR(10) NOT NULL,
    seat_number     VARCHAR(10) NOT NULL,
    price           DECIMAL(10,2) NOT NULL,
    status          VARCHAR(20) DEFAULT 'available',  -- available, held, sold
    held_by_session VARCHAR(64),
    held_until      TIMESTAMP,
    order_id        UUID,
    version         INTEGER DEFAULT 1,  -- optimistic locking
    UNIQUE(event_id, section, row, seat_number)
);
CREATE INDEX idx_seats_event_status ON seats(event_id, status);
CREATE INDEX idx_seats_held_by ON seats(held_by_session) WHERE status = 'held';
CREATE INDEX idx_seats_held_until ON seats(held_until) WHERE status = 'held';

-- Orders table
CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    event_id        UUID NOT NULL REFERENCES events(id),
    status          VARCHAR(20) DEFAULT 'pending',  -- pending, completed, cancelled, refunded
    total_amount    DECIMAL(10,2) NOT NULL,
    payment_id      VARCHAR(100),
    idempotency_key VARCHAR(100) UNIQUE,  -- prevent duplicate charges
    created_at      TIMESTAMP DEFAULT NOW(),
    completed_at    TIMESTAMP
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_event ON orders(event_id);
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);

-- Order items table
CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    seat_id         UUID NOT NULL REFERENCES seats(id),
    price           DECIMAL(10,2) NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
```

### Redis Data Structures

```
# Session storage
session:{session_id} = {user_id, created_at, ...}  (TTL: 24h)

# Distributed seat locks (critical path)
seat_lock:{event_id}:{seat_id} = {session_id}  (TTL: 600s / 10 min)

# Virtual waiting room queue
queue:{event_id} = ZSET { session_id: join_timestamp, ... }

# Active shopping sessions (admitted from queue)
active:{event_id} = SET { session_id, ... }
active_session:{event_id}:{session_id} = "1"  (TTL: 900s / 15 min)

# Event availability cache
availability:{event_id} = JSON { sections: [...], available_count: N }  (TTL: 5s during peak, 30s normal)

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
          └────────────────────────────│  SOLD  │
                                       └────────┘
```

---

## Caching Strategy

### Cache Hierarchy

| Data Type | Cache Location | TTL | Invalidation |
|-----------|---------------|-----|--------------|
| Event list | Redis | 60s | On event create/update |
| Event details | Redis | 60s | On event update |
| Venue details | Redis | 5min | On venue update |
| Seat availability | Redis | 5s (peak) / 30s (normal) | On seat status change |
| User session | Redis | 24h | On logout |

### Cache-Aside Pattern

```typescript
async function getEventWithCache(eventId: string): Promise<Event> {
  const cacheKey = `event:${eventId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Miss: query database
  const event = await db.query('SELECT * FROM events WHERE id = $1', [eventId]);

  // Populate cache
  await redis.setex(cacheKey, 60, JSON.stringify(event));

  return event;
}
```

### Cache Invalidation

```typescript
async function updateEvent(eventId: string, data: Partial<Event>): Promise<void> {
  await db.query('UPDATE events SET ... WHERE id = $1', [eventId, ...]);

  // Invalidate related caches
  await redis.del(`event:${eventId}`);
  await redis.del('event_list');
}
```

---

## Message Queue (Future Enhancement)

For production scale, add RabbitMQ for async operations:

### Queue Definitions

| Queue | Purpose | Delivery | Consumer |
|-------|---------|----------|----------|
| `notifications` | Email confirmations | At-least-once | Notification service |
| `analytics` | Purchase events | At-most-once | Analytics service |
| `cleanup` | Expired hold cleanup | At-least-once | Cleanup worker |

### Message Schemas

```typescript
// Order confirmation message
interface OrderConfirmationMessage {
  type: 'order_confirmation';
  orderId: string;
  userId: string;
  email: string;
  eventName: string;
  seats: { section: string; row: string; seat: string }[];
  timestamp: string;
}

// Expired hold cleanup message
interface CleanupMessage {
  type: 'cleanup_expired_holds';
  eventId: string;
  seatIds: string[];
  timestamp: string;
}
```

---

## API Design

### Core Endpoints

```
Authentication
  POST   /api/auth/register     - Create account
  POST   /api/auth/login        - Login (creates session)
  POST   /api/auth/logout       - Logout (destroys session)
  GET    /api/auth/me           - Get current user

Events
  GET    /api/events            - List events (with filters)
  GET    /api/events/:id        - Get event details
  POST   /api/events            - Create event (admin)
  PUT    /api/events/:id        - Update event (admin)

Venues
  GET    /api/venues            - List venues
  GET    /api/venues/:id        - Get venue with seat map

Seats
  GET    /api/events/:id/seats  - Get seat availability
  POST   /api/seats/reserve     - Reserve seats (creates hold)
  DELETE /api/seats/release     - Release held seats

Queue (Virtual Waiting Room)
  POST   /api/queue/:eventId/join       - Join waiting queue
  GET    /api/queue/:eventId/position   - Get queue position
  GET    /api/queue/:eventId/status     - Check if admitted

Checkout
  POST   /api/checkout          - Complete purchase
  GET    /api/orders            - List user orders
  GET    /api/orders/:id        - Get order details

Admin
  GET    /api/admin/events/:id/stats    - Event sales stats
  POST   /api/admin/events/:id/cancel   - Cancel event
```

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/auth/*` | 10 requests | 1 minute |
| `/api/seats/reserve` | 20 requests | 1 minute |
| `/api/checkout` | 5 requests | 1 minute |
| `/api/queue/*/join` | 5 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

---

## Security Considerations

### Authentication & Authorization

**Session-Based Authentication**
- Sessions stored in Redis with 24-hour TTL
- HTTP-only, secure cookies for session ID
- Session invalidation on logout

**Role-Based Access Control (RBAC)**
| Role | Permissions |
|------|-------------|
| `user` | Browse events, purchase tickets, view own orders |
| `admin` | All user permissions + create/edit events, view all orders, cancel events |

```typescript
// Middleware example
function requireRole(role: 'user' | 'admin') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await getSession(req.cookies.sessionId);
    if (!session || (role === 'admin' && session.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.user = session.user;
    next();
  };
}
```

### Input Validation

```typescript
// Example: Reserve seats validation
const reserveSeatsSchema = {
  eventId: z.string().uuid(),
  seatIds: z.array(z.string().uuid()).min(1).max(6),  // Max 6 seats per transaction
};
```

### Security Headers

```typescript
app.use(helmet({
  contentSecurityPolicy: true,
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: true,
  hsts: true,
  noSniff: true,
  xssFilter: true,
}));
```

### Sensitive Data Protection

- Passwords hashed with bcrypt (cost factor 12)
- Payment info never stored (simulated in local dev)
- Session IDs are cryptographically random (32 bytes)
- SQL injection prevented via parameterized queries

---

## Observability

### Metrics (Prometheus Format)

```
# Request metrics
http_requests_total{method, endpoint, status}
http_request_duration_seconds{method, endpoint, quantile}

# Business metrics
seats_reserved_total{event_id}
seats_sold_total{event_id}
checkout_completed_total{event_id}
checkout_failed_total{event_id, reason}

# Queue metrics
queue_length{event_id}
queue_wait_time_seconds{event_id, quantile}
active_sessions{event_id}

# Infrastructure metrics
redis_connection_pool_size
postgres_connection_pool_size
postgres_query_duration_seconds{query_type}
```

### Logging

Structured JSON logging with correlation IDs:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "correlationId": "abc-123",
  "userId": "user-456",
  "eventId": "event-789",
  "action": "seat_reserved",
  "seatIds": ["seat-1", "seat-2"],
  "durationMs": 45
}
```

### Key Log Events

| Event | Level | Fields |
|-------|-------|--------|
| `seat_reserved` | info | userId, eventId, seatIds, duration |
| `seat_released` | info | userId, eventId, seatIds, reason |
| `checkout_completed` | info | userId, eventId, orderId, amount |
| `checkout_failed` | warn | userId, eventId, reason, error |
| `lock_contention` | warn | eventId, seatId, attempts |
| `oversell_prevented` | error | eventId, seatId, details |
| `redis_fallback` | error | operation, error |

### Distributed Tracing

For local dev, use simple correlation IDs. In production, OpenTelemetry spans:

```
[trace-id: abc-123]
├── POST /api/seats/reserve (45ms)
│   ├── redis.set seat_lock (2ms)
│   ├── postgres.query SELECT FOR UPDATE (15ms)
│   ├── postgres.query UPDATE seats (8ms)
│   └── postgres.commit (5ms)
```

### Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | 5xx rate > 1% | Critical |
| Slow responses | p95 latency > 500ms | Warning |
| Queue backup | Queue length > 10,000 | Warning |
| Redis unavailable | Connection failures > 3 | Critical |
| PostgreSQL connection pool exhausted | Available < 2 | Critical |
| Oversell detected | Any seat sold twice | Critical |

---

## Failure Handling

### Retry Strategy

```typescript
async function withRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries: number; baseDelayMs: number }
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry on client errors
      if (error.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = options.baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      await sleep(delay);
    }
  }

  throw lastError;
}
```

### Idempotency Keys

Checkout uses idempotency keys to prevent duplicate charges:

```typescript
async function checkout(req: Request): Promise<Order> {
  const idempotencyKey = req.headers['idempotency-key'] || generateKey();

  // Check for existing order with this key
  const existing = await db.query(
    'SELECT * FROM orders WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  if (existing) {
    return existing;  // Return cached result
  }

  // Process new order with idempotency key
  const order = await processOrder(req.body, idempotencyKey);
  return order;
}
```

### Circuit Breaker (Redis Fallback)

```typescript
class RedisWithFallback {
  private failures = 0;
  private circuitOpen = false;
  private circuitOpenedAt: Date | null = null;

  async acquireSeatLock(eventId: string, seatId: string, sessionId: string): Promise<boolean> {
    // Circuit breaker check
    if (this.circuitOpen) {
      if (Date.now() - this.circuitOpenedAt.getTime() > 30000) {
        this.circuitOpen = false;  // Try again after 30s
      } else {
        return this.fallbackToDatabaseLock(eventId, seatId, sessionId);
      }
    }

    try {
      const acquired = await redis.set(
        `seat_lock:${eventId}:${seatId}`,
        sessionId,
        { NX: true, EX: 600 }
      );
      this.failures = 0;
      return acquired;
    } catch (error) {
      this.failures++;
      if (this.failures >= 3) {
        this.circuitOpen = true;
        this.circuitOpenedAt = new Date();
        logger.error('Redis circuit breaker opened, falling back to database locks');
      }
      return this.fallbackToDatabaseLock(eventId, seatId, sessionId);
    }
  }

  private async fallbackToDatabaseLock(eventId: string, seatId: string, sessionId: string): Promise<boolean> {
    // Use PostgreSQL advisory locks as fallback
    const result = await db.query(
      'SELECT pg_try_advisory_lock($1)',
      [hashToInt(`${eventId}:${seatId}`)]
    );
    return result.rows[0].pg_try_advisory_lock;
  }
}
```

### Expired Hold Cleanup

Background job runs every minute:

```typescript
async function cleanupExpiredHolds(): Promise<void> {
  const expired = await db.query(`
    UPDATE seats
    SET status = 'available',
        held_by_session = NULL,
        held_until = NULL
    WHERE status = 'held'
      AND held_until < NOW()
    RETURNING id, event_id, held_by_session
  `);

  // Clean up Redis locks (may already be expired)
  for (const seat of expired.rows) {
    await redis.del(`seat_lock:${seat.event_id}:${seat.id}`);
  }

  if (expired.rows.length > 0) {
    logger.info('Cleaned up expired holds', { count: expired.rows.length });
  }
}

// Run every minute
setInterval(cleanupExpiredHolds, 60000);
```

### Disaster Recovery (Local Dev)

For local development, simplified backup/restore:

```bash
# Backup PostgreSQL
docker exec ticketmaster-postgres pg_dump -U ticketmaster ticketmaster > backup.sql

# Restore PostgreSQL
docker exec -i ticketmaster-postgres psql -U ticketmaster ticketmaster < backup.sql

# Backup Redis
docker exec ticketmaster-redis redis-cli BGSAVE

# Note: Redis data persisted via docker volume with appendonly enabled
```

---

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + TypeScript + Vite | Modern stack, fast dev experience |
| **API** | Node.js + Express + TypeScript | JavaScript ecosystem, easy async |
| **Database** | PostgreSQL 16 | ACID compliance for seat inventory |
| **Cache/Locks** | Redis 7 | Sub-ms operations for distributed locks |
| **Session Store** | Redis | Fast session lookups, easy TTL |
| **Message Queue** | (Future) RabbitMQ | Reliable delivery for notifications |
| **Load Balancer** | nginx | Simple, reliable, local dev friendly |

---

## Cost Tradeoffs

### Local Development

| Choice | Cost | Benefit |
|--------|------|---------|
| Single PostgreSQL | Lower RAM | Sufficient for dev workloads |
| Single Redis | Lower RAM | Simpler setup, still demonstrates patterns |
| No CDN | N/A | Direct API access for debugging |
| No message queue | Less complexity | Sync operations fine for small scale |

### Production Considerations

| Choice | Cost Impact | When to Consider |
|--------|-------------|------------------|
| Redis Cluster | 3x Redis cost | > 10,000 concurrent locks |
| PostgreSQL replicas | 2-3x DB cost | > 5,000 RPS reads |
| CDN for static assets | ~$50-100/mo | Any production deployment |
| RabbitMQ cluster | ~$100-200/mo | When async notifications needed |
| Multi-region | 2-3x total cost | > 99.99% availability requirement |

### Storage vs. Compute Tradeoffs

| Approach | Storage Cost | Compute Cost | Use When |
|----------|--------------|--------------|----------|
| Pre-compute seat maps | Higher | Lower | High read:write ratio |
| Compute on demand | Lower | Higher | Low traffic events |
| Cache aggressively | Higher Redis | Lower DB | Spiky traffic patterns |

---

## Trade-offs and Alternatives

### Seat Locking: Redis vs. Database-Only

**Chose**: Redis SET NX + PostgreSQL FOR UPDATE (dual locking)

**Trade-off**:
- Pro: Sub-millisecond Redis locks + database consistency
- Con: Additional infrastructure, need fallback logic

**Alternative**: Database-only with FOR UPDATE SKIP LOCKED
- Simpler, but higher latency (10-50ms vs 1ms)
- Acceptable for < 1,000 concurrent seat selections

### Waiting Room: Queue vs. Lottery

**Chose**: FIFO queue with Redis sorted sets

**Trade-off**:
- Pro: Fair, predictable, position visible to users
- Con: Early advantage for those with better internet

**Alternative**: Random lottery at sale time
- More equitable for access
- Less predictable for users

### Hold Duration: 10 Minutes

**Chose**: 10-minute seat holds

**Trade-off**:
- Pro: Enough time for most checkouts
- Con: Some inventory tied up in abandoned carts

**Alternative**: 5-minute holds with extension option
- Faster turnover
- More complexity in UX

---

## Scalability Considerations

### Horizontal Scaling

```bash
# Run multiple API instances locally
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
npm run dev:lb       # nginx on port 3000
```

### Database Scaling Path

1. **Current**: Single PostgreSQL instance
2. **Next**: Read replicas for event browsing queries
3. **Future**: Shard by event_id for write scale

### Caching Scaling Path

1. **Current**: Single Redis instance
2. **Next**: Redis Sentinel for HA
3. **Future**: Redis Cluster for > 10,000 concurrent locks

---

## Future Optimizations

- [ ] WebSocket for real-time seat availability updates
- [ ] RabbitMQ for async email notifications
- [ ] Elasticsearch for event search
- [ ] Rate limiting with token bucket algorithm
- [ ] Bot detection with behavioral analysis
- [ ] Mobile ticket delivery with QR codes
- [ ] Secondary market (resale) support

---

## Implementation Notes

This section documents key implementation patterns and explains WHY specific architectural decisions were made to address the unique challenges of high-concurrency ticket sales.

### Idempotency: Preventing Double-Charging Customers

**Problem**: In distributed systems with network timeouts and retries, a checkout request might be sent multiple times. Without idempotency, this could result in:
- Customer charged twice for the same seats
- Same seats sold to the same customer twice
- Duplicate order records in the database

**Solution**: Idempotency keys for checkout operations.

```typescript
// Every checkout includes an idempotency key
const result = await checkoutService.checkout(
  sessionId,
  userId,
  paymentMethod,
  idempotencyKey,  // Unique per checkout attempt
  correlationId
);
```

**How It Works**:
1. Client generates or provides an `Idempotency-Key` header with the checkout request
2. Server checks Redis and PostgreSQL for a previous result with this key
3. If found, return the cached result (no new charge, no new order)
4. If not found, process the checkout and store the result

**Why This Matters**:
- **Network failures**: If the response is lost but the order succeeded, retrying returns the same order
- **Double-click**: User clicking "Pay" twice uses the same key, only one charge occurs
- **Mobile reliability**: Mobile apps on flaky networks can safely retry
- **Payment provider resilience**: Even if payment provider confirms but our DB write fails, we can recover

**Implementation Details**:
- Keys stored in Redis (fast lookup, 24h TTL) and PostgreSQL (durability)
- Key format: `checkout:{sessionId}:{eventId}:{sortedSeatIds}`
- Orders table has `idempotency_key` column with unique constraint

### Distributed Locking: Preventing Seat Overselling

**Problem**: When 10,000 users try to buy the last 100 seats simultaneously, race conditions could cause:
- Same seat sold to multiple customers
- Seat inventory going negative
- Lost revenue from failed purchases

**Solution**: Two-phase distributed locking using Redis + PostgreSQL.

```typescript
// Phase 1: Acquire distributed lock in Redis (sub-millisecond)
const locks = await acquireSeatLocks(eventId, seatIds, sessionId, HOLD_DURATION);

// Phase 2: Database transaction with row-level locks
await withTransaction(async (client) => {
  await client.query('SELECT ... FOR UPDATE NOWAIT');  // Fail fast if locked
  await client.query('UPDATE event_seats SET status = ...');
});
```

**Why Two Phases**:

| Phase | Technology | Purpose | Latency |
|-------|------------|---------|---------|
| 1 | Redis SET NX | Fast distributed exclusion across servers | ~1ms |
| 2 | PostgreSQL FOR UPDATE | ACID compliance and durability | ~10-50ms |

**Why Redis Alone Isn't Enough**:
- Redis locks can expire during long operations
- Redis might lose data on restart (unless AOF persistence)
- No transactional guarantees with database state

**Why PostgreSQL Alone Isn't Enough**:
- Row-level locks require database roundtrip (~20ms)
- Lock acquisition is serialized, creating bottleneck at scale
- Connection pool exhaustion under high load

**The Combined Approach**:
1. Redis provides fast "intent to purchase" lock
2. Only lock holders proceed to database
3. Database provides ACID guarantees
4. If Redis fails, circuit breaker falls back to PostgreSQL advisory locks

**Implementation Details**:
- Lock key format: `lock:seat:{eventId}:{seatId}`
- Each lock has a unique token to prevent releasing someone else's lock
- Lock release uses Lua script for atomic check-and-delete
- Lock tokens are stored with reservations for cleanup

### Caching: Enabling Flash Sale Performance

**Problem**: A Taylor Swift concert on-sale generates 100x normal traffic in the first minute. Without caching:
- Database overwhelmed by seat availability queries
- 10,000+ queries per second for the same seat map
- Slow response times cause abandoned carts

**Solution**: Aggressive Redis caching with dynamic TTLs.

```typescript
// Cache TTL varies based on event status
const cacheTtl = status === 'on_sale'
  ? 5   // High accuracy during active sales
  : 30; // Longer cache for browsing

await redis.setex(cacheKey, cacheTtl, JSON.stringify(availability));
```

**Why Dynamic TTLs**:

| Event Status | Cache TTL | Rationale |
|--------------|-----------|-----------|
| On Sale (active) | 5 seconds | Balance between accuracy and performance |
| Upcoming | 30 seconds | Seats not changing, longer cache OK |
| Sold Out | 60 seconds | Data is static |

**Why 5 Seconds for Active Sales**:
- 5 seconds allows ~20 cache hits per seat map request
- Still shows "approximately" accurate availability
- Users understand seats may be taken when they click

**Cache Invalidation Strategy**:
- Invalidate on seat status change (reserve, release, checkout)
- Invalidate on order completion or cancellation
- Pattern-based deletion: `availability:{eventId}:*`

**Performance Impact**:
```
Without cache: 10,000 RPS to PostgreSQL
With cache:    500 RPS to PostgreSQL (95% cache hit rate)
```

### Queue Metrics: Enabling Demand Prediction

**Problem**: Without visibility into queue depth and processing rates, operations cannot:
- Predict when an event will sell out
- Identify bottlenecks in the purchase flow
- Staff support appropriately for high-demand events
- Detect and respond to anomalies

**Solution**: Prometheus metrics for all queue and sales operations.

```typescript
// Queue metrics updated every 5 seconds
queueLength.set({ event_id: event.id }, stats.queueLength);
activeSessions.set({ event_id: event.id }, stats.activeCount);

// Sales metrics updated on each transaction
seatsReservedTotal.inc({ event_id: eventId }, seatCount);
seatsSoldTotal.inc({ event_id: eventId }, seatCount);
checkoutDuration.observe({ event_id: eventId }, durationMs / 1000);
```

**Key Metrics Exposed**:

| Metric | Type | Purpose |
|--------|------|---------|
| `queue_length{event_id}` | Gauge | Current users waiting |
| `active_sessions{event_id}` | Gauge | Users currently shopping |
| `seats_reserved_total{event_id}` | Counter | Seats held for checkout |
| `seats_sold_total{event_id}` | Counter | Completed seat sales |
| `checkout_duration_seconds{event_id}` | Histogram | Checkout latency distribution |
| `seat_lock_attempts_total{event_id,result}` | Counter | Lock success/failure rates |

**Why These Metrics Matter**:

1. **Demand Forecasting**:
   - `queue_length` trend predicts time to sell-out
   - Historical data informs capacity planning for similar events

2. **Bottleneck Detection**:
   - High `checkout_duration` indicates payment provider issues
   - High lock failures indicate contention (need more inventory)

3. **Anomaly Detection**:
   - Sudden queue drop might indicate site issues
   - Unusual patterns might indicate bot attacks

4. **SLO Monitoring**:
   - `checkout_duration_seconds` p95 < 2 seconds target
   - `seat_lock_attempts_total{result="failure"}` rate < 1%

**Dashboard Queries (Prometheus/Grafana)**:
```promql
# Sell-out prediction: seats remaining / sale rate
(available_seats / rate(seats_sold_total[5m])) / 60  # minutes to sellout

# Checkout success rate
rate(checkout_completed_total[1m]) / rate(http_requests_total{endpoint="/api/v1/checkout"}[1m])

# P95 checkout latency
histogram_quantile(0.95, rate(checkout_duration_seconds_bucket[5m]))
```

### Circuit Breaker: Payment Processing Resilience

**Problem**: Payment providers occasionally experience outages. Without protection:
- Requests queue up waiting for timeouts
- Server resources exhausted
- All checkouts fail, even when seats are available

**Solution**: Circuit breaker pattern for payment processing.

```typescript
// Payment calls go through circuit breaker
const result = await this.paymentCircuitBreaker.execute(async () => {
  return this.processPayment(userId, amount, paymentMethod);
});
```

**Circuit States**:

| State | Behavior | Transition |
|-------|----------|------------|
| CLOSED | Requests pass through normally | Opens after 5 failures |
| OPEN | Requests fail immediately | Half-opens after 30 seconds |
| HALF_OPEN | Limited requests test recovery | Closes after 2 successes |

**Why This Matters**:
- **Fail fast**: Users get immediate error instead of 30-second timeout
- **Auto-recovery**: System tests and recovers when provider is back
- **Resource protection**: Server threads not blocked waiting
- **Clear communication**: "Payment service temporarily unavailable"

**Health Check Integration**:
```json
// /health endpoint includes circuit breaker status
{
  "checks": [
    {
      "name": "payment_circuit_breaker",
      "status": "healthy",  // or "unhealthy" if open
      "latencyMs": 0
    }
  ]
}
```

### Summary: Defense in Depth

These patterns work together to create a robust ticketing system:

```
User Request
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                     RATE LIMITING                            │
│              (Future: Token bucket per user)                 │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                    WAITING ROOM QUEUE                        │
│              (Redis ZSET, admission control)                 │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                    SEAT AVAILABILITY                         │
│            (Redis cache, 5-second TTL during sales)          │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                   DISTRIBUTED LOCKING                        │
│            (Redis locks + PostgreSQL FOR UPDATE)             │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                     IDEMPOTENT CHECKOUT                      │
│           (Idempotency keys prevent double charges)          │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                    CIRCUIT BREAKER                           │
│           (Protects against payment provider failures)       │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY                             │
│         (Prometheus metrics, structured logging, tracing)    │
└─────────────────────────────────────────────────────────────┘
```

Each layer addresses a specific failure mode, and together they ensure that:
- No customer is charged twice
- No seat is sold twice
- System remains responsive under extreme load
- Operations have visibility into system health
- Failures are isolated and recoverable

