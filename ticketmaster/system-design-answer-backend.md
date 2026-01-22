# Ticketmaster - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing an event ticketing platform like Ticketmaster, with a focus on the backend systems that handle extreme traffic spikes during high-demand on-sales. The core challenges are distributed locking for seat reservation, queue management for fairness, and ensuring zero overselling through proper database design."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Event Management API** - CRUD operations for events, venues, seat configurations
2. **Seat Inventory System** - Real-time seat availability with atomic status updates
3. **Distributed Seat Locking** - Prevent double-booking across multiple server instances
4. **Virtual Waiting Room** - Queue system for high-demand events
5. **Checkout Processing** - Payment integration with idempotency guarantees

### Non-Functional Requirements

- **Scalability**: Handle 100x traffic spikes (from 200 RPS to 20,000 RPS during on-sales)
- **Consistency**: Strong consistency for seat inventory - zero overselling
- **Latency**: Seat reservation < 100ms p95, checkout initiation < 500ms p95
- **Availability**: 99.9% uptime with no downtime during high-profile on-sales

### Backend Focus Areas

- Two-phase distributed locking (Redis + PostgreSQL)
- Database schema design for seat inventory
- Queue implementation with Redis sorted sets
- Idempotency middleware for checkout
- Circuit breaker for payment processing
- Background job for expired hold cleanup

---

## 2. Scale Estimation (3 minutes)

### Traffic Patterns

```
Normal day:     200 RPS steady
                ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

On-sale event:         /\
                      /  \     20,000 RPS peak
                     /    \
                    /      \_____
            _______/
```

### Database Sizing

| Table | Rows | Size | Access Pattern |
|-------|------|------|----------------|
| events | 50K | 500 MB | Read-heavy, cacheable |
| seats | 500M | 50 GB | Write-heavy during sales |
| orders | 100M/year | 50 GB | Append-only |
| users | 100M | 100 GB | Read-heavy |

### Connection Pool Sizing

```
PostgreSQL connections: 100 per instance x 3 instances = 300 total
Redis connections: 50 per instance x 3 instances = 150 total
Expected concurrent seat locks: 10,000 during peak
```

---

## 3. High-Level Architecture (5 minutes)

```
                            ┌─────────────────┐
                            │    nginx LB     │
                            │     :3000       │
                            └────────┬────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
       ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
       │  API Server  │      │  API Server  │      │  API Server  │
       │    :3001     │      │    :3002     │      │    :3003     │
       └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
  │    Redis     │          │  PostgreSQL  │          │   RabbitMQ   │
  │    :6379     │          │    :5432     │          │    :5672     │
  │              │          │              │          │              │
  │ - Seat locks │          │ - Events     │          │ - Cleanup    │
  │ - Sessions   │          │ - Seats      │          │ - Notifs     │
  │ - Queue      │          │ - Orders     │          │              │
  │ - Cache      │          │ - Users      │          │              │
  └──────────────┘          └──────────────┘          └──────────────┘
```

---

## 4. Database Schema Design (8 minutes)

### Core Tables

```sql
-- Venues with section configuration
CREATE TABLE venues (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    address         VARCHAR(500),
    city            VARCHAR(100),
    capacity        INTEGER NOT NULL,
    section_config  JSONB NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Events linked to venues
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    venue_id        UUID NOT NULL REFERENCES venues(id),
    event_date      TIMESTAMP NOT NULL,
    on_sale_date    TIMESTAMP NOT NULL,
    status          VARCHAR(20) DEFAULT 'upcoming',
    high_demand     BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_on_sale ON events(on_sale_date);

-- Seat inventory per event
CREATE TABLE seats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id),
    section         VARCHAR(50) NOT NULL,
    row             VARCHAR(10) NOT NULL,
    seat_number     VARCHAR(10) NOT NULL,
    price           DECIMAL(10,2) NOT NULL,
    status          VARCHAR(20) DEFAULT 'available',
    held_by_session VARCHAR(64),
    held_until      TIMESTAMP,
    order_id        UUID,
    version         INTEGER DEFAULT 1,
    UNIQUE(event_id, section, row, seat_number)
);
CREATE INDEX idx_seats_event_status ON seats(event_id, status);
CREATE INDEX idx_seats_held_until ON seats(held_until) WHERE status = 'held';

-- Orders with idempotency key
CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    event_id        UUID NOT NULL REFERENCES events(id),
    status          VARCHAR(20) DEFAULT 'pending',
    total_amount    DECIMAL(10,2) NOT NULL,
    payment_id      VARCHAR(100),
    idempotency_key VARCHAR(100) UNIQUE,
    created_at      TIMESTAMP DEFAULT NOW(),
    completed_at    TIMESTAMP
);
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);
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

## 5. Deep Dive: Two-Phase Distributed Locking (10 minutes)

### Problem Statement

When 10,000 users try to reserve the same seat simultaneously across multiple API server instances, we need both speed and consistency.

### Phase 1: Redis Distributed Lock

```typescript
// Redis lock key format: lock:seat:{eventId}:{seatId}
// Value: unique lock token to prevent releasing other sessions' locks

async function acquireSeatLocks(
  eventId: string,
  seatIds: string[],
  sessionId: string,
  holdDuration: number
): Promise<{ acquired: string[]; lockTokens: Map<string, string> }> {
  const acquired: string[] = [];
  const lockTokens = new Map<string, string>();

  for (const seatId of seatIds) {
    const lockKey = `lock:seat:${eventId}:${seatId}`;
    const lockToken = crypto.randomUUID();

    // SET NX with expiry - atomic operation
    const result = await redis.set(lockKey, lockToken, {
      NX: true,  // Only set if not exists
      EX: holdDuration,
    });

    if (result === 'OK') {
      acquired.push(seatId);
      lockTokens.set(seatId, lockToken);
    }
  }

  // All-or-nothing: release partial locks if not all acquired
  if (acquired.length !== seatIds.length) {
    await releaseMultipleLocks(eventId, acquired, lockTokens);
    return { acquired: [], lockTokens: new Map() };
  }

  return { acquired, lockTokens };
}
```

### Lock Release with Lua Script

```lua
-- Atomic check-and-delete to prevent releasing someone else's lock
local lockKey = KEYS[1]
local expectedToken = ARGV[1]

local currentToken = redis.call('GET', lockKey)
if currentToken == expectedToken then
    return redis.call('DEL', lockKey)
end
return 0
```

```typescript
async function releaseLock(
  eventId: string,
  seatId: string,
  lockToken: string
): Promise<boolean> {
  const lockKey = `lock:seat:${eventId}:${seatId}`;

  const result = await redis.eval(
    RELEASE_LOCK_SCRIPT,
    1,
    lockKey,
    lockToken
  );

  return result === 1;
}
```

### Phase 2: PostgreSQL Transaction with Row Locking

```typescript
async function reserveSeatsInDatabase(
  eventId: string,
  seatIds: string[],
  sessionId: string,
  holdUntil: Date
): Promise<void> {
  await pool.query('BEGIN');

  try {
    // Lock rows with NOWAIT - fail fast if locked
    const { rows: seats } = await pool.query(`
      SELECT id, status, version
      FROM seats
      WHERE event_id = $1 AND id = ANY($2)
      FOR UPDATE NOWAIT
    `, [eventId, seatIds]);

    // Verify all seats are available
    for (const seat of seats) {
      if (seat.status !== 'available') {
        throw new Error(`Seat ${seat.id} not available`);
      }
    }

    // Update status to held
    await pool.query(`
      UPDATE seats
      SET status = 'held',
          held_by_session = $1,
          held_until = $2,
          version = version + 1
      WHERE id = ANY($3)
    `, [sessionId, holdUntil, seatIds]);

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}
```

### Combined Reservation Flow

```typescript
async function reserveSeats(
  eventId: string,
  seatIds: string[],
  sessionId: string
): Promise<ReservationResult> {
  const HOLD_DURATION = 600; // 10 minutes

  // Phase 1: Acquire Redis locks
  const { acquired, lockTokens } = await acquireSeatLocks(
    eventId,
    seatIds,
    sessionId,
    HOLD_DURATION
  );

  if (acquired.length === 0) {
    throw new SeatsUnavailableError('One or more seats already held');
  }

  try {
    // Phase 2: Database transaction
    const holdUntil = new Date(Date.now() + HOLD_DURATION * 1000);
    await reserveSeatsInDatabase(eventId, seatIds, sessionId, holdUntil);

    // Store lock tokens for later release
    await storeReservation(sessionId, eventId, seatIds, lockTokens, holdUntil);

    return {
      seats: seatIds,
      expiresAt: holdUntil,
      status: 'held',
    };
  } catch (error) {
    // Rollback: release Redis locks
    await releaseMultipleLocks(eventId, acquired, lockTokens);
    throw error;
  }
}
```

### Why Two Phases?

| Aspect | Redis Only | PostgreSQL Only | Two-Phase |
|--------|------------|-----------------|-----------|
| Lock latency | ~1ms | ~20ms | ~5ms (Redis first) |
| Scalability | High | Limited by connections | High |
| Durability | Volatile | ACID | ACID (with Redis speed) |
| Consistency | Eventual | Strong | Strong |

---

## 6. Deep Dive: Virtual Waiting Room Queue (8 minutes)

### Queue Data Structures in Redis

```typescript
// Redis data structures per event:
// queue:{eventId}      - ZSET: { sessionId: joinTimestamp }
// active:{eventId}     - SET: { sessionId, ... }
// active_session:{eventId}:{sessionId} - String with TTL

class VirtualWaitingRoom {
  private readonly MAX_CONCURRENT = 5000;
  private readonly SHOPPING_WINDOW = 900; // 15 minutes

  async joinQueue(
    eventId: string,
    sessionId: string
  ): Promise<QueuePosition> {
    const queueKey = `queue:${eventId}`;

    // Check if already in queue
    const existing = await redis.zscore(queueKey, sessionId);
    if (existing !== null) {
      return this.getPosition(eventId, sessionId);
    }

    // Add to queue with current timestamp as score
    const timestamp = Date.now() / 1000;
    await redis.zadd(queueKey, timestamp, sessionId);

    const rank = await redis.zrank(queueKey, sessionId);
    const position = (rank ?? 0) + 1;

    return {
      position,
      estimatedWait: this.estimateWait(position),
      status: 'queued',
    };
  }

  async getPosition(
    eventId: string,
    sessionId: string
  ): Promise<QueuePosition> {
    // Check if already admitted
    const isActive = await redis.exists(
      `active_session:${eventId}:${sessionId}`
    );
    if (isActive) {
      return { position: 0, status: 'active' };
    }

    // Check queue position
    const rank = await redis.zrank(`queue:${eventId}`, sessionId);
    if (rank === null) {
      return { position: -1, status: 'not_in_queue' };
    }

    const position = rank + 1;
    return {
      position,
      estimatedWait: this.estimateWait(position),
      status: 'queued',
    };
  }

  async admitNextBatch(eventId: string): Promise<number> {
    const activeKey = `active:${eventId}`;
    const queueKey = `queue:${eventId}`;

    // Count current active sessions
    const activeCount = await redis.scard(activeKey);
    const slotsAvailable = this.MAX_CONCURRENT - activeCount;

    if (slotsAvailable <= 0) return 0;

    // Get next batch from queue (FIFO by timestamp)
    const nextUsers = await redis.zrange(
      queueKey,
      0,
      slotsAvailable - 1
    );

    if (nextUsers.length === 0) return 0;

    // Move to active set with pipeline
    const pipeline = redis.pipeline();
    for (const sessionId of nextUsers) {
      pipeline.sadd(activeKey, sessionId);
      pipeline.setex(
        `active_session:${eventId}:${sessionId}`,
        this.SHOPPING_WINDOW,
        '1'
      );
    }
    pipeline.zrem(queueKey, ...nextUsers);
    await pipeline.exec();

    return nextUsers.length;
  }

  private estimateWait(position: number): number {
    // Assume 500 users admitted per minute on average
    return Math.ceil(position / 500) * 60;
  }
}
```

### Queue Admission Worker

```typescript
// Background worker runs every 5 seconds
async function queueAdmissionWorker(): Promise<void> {
  const waitingRoom = new VirtualWaitingRoom();

  while (true) {
    // Get all high-demand events currently on sale
    const events = await getActiveHighDemandEvents();

    for (const event of events) {
      const admitted = await waitingRoom.admitNextBatch(event.id);
      if (admitted > 0) {
        logger.info('Admitted users from queue', {
          eventId: event.id,
          count: admitted,
        });
      }
    }

    await sleep(5000);
  }
}
```

---

## 7. Idempotent Checkout (5 minutes)

### Idempotency Key Strategy

```typescript
// Key format: checkout:{sessionId}:{eventId}:{sortedSeatIds}
function generateIdempotencyKey(
  sessionId: string,
  eventId: string,
  seatIds: string[]
): string {
  const sortedSeats = [...seatIds].sort().join(',');
  return `checkout:${sessionId}:${eventId}:${sortedSeats}`;
}
```

### Checkout with Idempotency

```typescript
async function checkout(
  sessionId: string,
  userId: string,
  paymentMethod: PaymentMethod,
  idempotencyKey: string
): Promise<Order> {
  // 1. Check for existing result in Redis (fast path)
  const cachedResult = await redis.get(`idem:${idempotencyKey}`);
  if (cachedResult) {
    return JSON.parse(cachedResult);
  }

  // 2. Check database for existing order
  const existingOrder = await pool.query(
    'SELECT * FROM orders WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existingOrder.rows[0]) {
    return existingOrder.rows[0];
  }

  // 3. Get reservation
  const reservation = await getReservation(sessionId);
  if (!reservation || new Date() > reservation.expiresAt) {
    throw new ReservationExpiredError();
  }

  // 4. Process payment with circuit breaker
  const paymentResult = await paymentCircuitBreaker.execute(async () => {
    return processPayment(userId, reservation.totalAmount, paymentMethod);
  });

  // 5. Complete order in transaction
  const order = await pool.query('BEGIN');
  try {
    const { rows: [newOrder] } = await pool.query(`
      INSERT INTO orders (user_id, event_id, status, total_amount, payment_id, idempotency_key, completed_at)
      VALUES ($1, $2, 'completed', $3, $4, $5, NOW())
      RETURNING *
    `, [userId, reservation.eventId, reservation.totalAmount, paymentResult.id, idempotencyKey]);

    // Update seats to sold
    await pool.query(`
      UPDATE seats
      SET status = 'sold',
          order_id = $1,
          held_by_session = NULL,
          held_until = NULL
      WHERE id = ANY($2)
        AND status = 'held'
        AND held_by_session = $3
    `, [newOrder.id, reservation.seatIds, sessionId]);

    await pool.query('COMMIT');

    // Cache result in Redis for 24 hours
    await redis.setex(
      `idem:${idempotencyKey}`,
      86400,
      JSON.stringify(newOrder)
    );

    // Release Redis locks
    for (const [seatId, token] of reservation.lockTokens) {
      await releaseLock(reservation.eventId, seatId, token);
    }

    return newOrder;
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}
```

---

## 8. Background Jobs and Cleanup (3 minutes)

### Expired Hold Cleanup Worker

```typescript
async function cleanupExpiredHolds(): Promise<void> {
  // Single query to release expired holds and return their data
  const { rows: expired } = await pool.query(`
    UPDATE seats
    SET status = 'available',
        held_by_session = NULL,
        held_until = NULL
    WHERE status = 'held'
      AND held_until < NOW()
    RETURNING id, event_id, held_by_session
  `);

  if (expired.length === 0) return;

  // Clean up Redis locks (may already be expired by TTL)
  for (const seat of expired) {
    await redis.del(`lock:seat:${seat.event_id}:${seat.id}`);
  }

  // Invalidate availability cache for affected events
  const eventIds = [...new Set(expired.map((s) => s.event_id))];
  for (const eventId of eventIds) {
    await redis.del(`availability:${eventId}`);
  }

  logger.info('Cleaned up expired holds', {
    count: expired.length,
    eventIds,
  });
}

// Run every minute
setInterval(cleanupExpiredHolds, 60000);
```

### Circuit Breaker for Payment Processing

```typescript
class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private openedAt: Date | null = null;

  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryTimeout = 30000
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt!.getTime() > this.recoveryTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = new Date();
      logger.error('Circuit breaker opened', {
        failures: this.failures,
      });
    }
  }
}
```

---

## 9. Caching Strategy (3 minutes)

### Dynamic TTL Based on Event Status

```typescript
async function getSeatAvailability(eventId: string): Promise<SeatMap> {
  const cacheKey = `availability:${eventId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Query database
  const { rows: seats } = await pool.query(`
    SELECT section, row, seat_number, status, price
    FROM seats
    WHERE event_id = $1
    ORDER BY section, row, seat_number
  `, [eventId]);

  // Get event status for TTL decision
  const event = await getEvent(eventId);
  const ttl = event.status === 'on_sale' ? 5 : 30;

  const seatMap = formatSeatMap(seats);
  await redis.setex(cacheKey, ttl, JSON.stringify(seatMap));

  return seatMap;
}
```

### Cache Invalidation Points

| Operation | Cache Keys Invalidated |
|-----------|------------------------|
| Seat reserved | `availability:{eventId}` |
| Seat released | `availability:{eventId}` |
| Checkout completed | `availability:{eventId}` |
| Order cancelled | `availability:{eventId}` |
| Hold expired | `availability:{eventId}` |

---

## 10. Observability (2 minutes)

### Key Metrics

```typescript
// Prometheus metrics
const seatsReservedTotal = new Counter({
  name: 'seats_reserved_total',
  labelNames: ['event_id'],
});

const seatLockAttempts = new Counter({
  name: 'seat_lock_attempts_total',
  labelNames: ['event_id', 'result'],
});

const checkoutDuration = new Histogram({
  name: 'checkout_duration_seconds',
  labelNames: ['event_id'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
});

const queueLength = new Gauge({
  name: 'queue_length',
  labelNames: ['event_id'],
});
```

### Alerting Thresholds

| Metric | Threshold | Severity |
|--------|-----------|----------|
| `seat_lock_attempts{result="failure"}` rate | > 10% | Warning |
| `checkout_duration_seconds` p95 | > 2s | Warning |
| `queue_length` | > 50,000 | Critical |
| Any oversell detected | > 0 | Critical |

---

## Summary

"I've designed a backend system for high-traffic event ticketing with:

1. **Two-phase distributed locking** using Redis SET NX for speed and PostgreSQL FOR UPDATE for ACID guarantees
2. **Virtual waiting room** with Redis sorted sets for fair, scalable queue management
3. **Idempotent checkout** with idempotency keys stored in both Redis and PostgreSQL
4. **Circuit breaker** pattern for payment processing resilience
5. **Background cleanup** jobs for expired holds with cache invalidation

The key insight is that the fast path (Redis locks) protects the slow path (database transactions), and both are needed to achieve sub-100ms reservation times while guaranteeing zero overselling."
