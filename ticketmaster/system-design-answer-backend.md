# Ticketmaster - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 🎯 Introduction (2 minutes)

"Thanks for this challenge. I'll be designing an event ticketing platform like Ticketmaster, with a focus on the backend systems that handle extreme traffic spikes during high-demand on-sales. The core challenges are distributed locking for seat reservation, queue management for fairness, and ensuring zero overselling through proper database design."

---

## ✅ 1. Requirements Clarification (5 minutes)

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

## 🧮 2. Scale Estimation (3 minutes)

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

## 🏗️ 3. High-Level Architecture (5 minutes)

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

## 💾 4. Database Schema Design (8 minutes)

### Core Tables

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **venues** | id (UUID PK), name, address, city, capacity, section_config (JSONB), created_at | PK index | Section config stores flexible venue layout |
| **events** | id (UUID PK), name, venue_id (FK), event_date, on_sale_date, status (default 'upcoming'), high_demand (boolean), created_at, updated_at | idx_events_status, idx_events_on_sale | high_demand flag triggers waiting room |
| **seats** | id (UUID PK), event_id (FK), section, row, seat_number, price, status (default 'available'), held_by_session, held_until, order_id, version (optimistic locking) | idx_seats_event_status (event_id, status), idx_seats_held_until (partial: WHERE status = 'held'), unique on (event_id, section, row, seat_number) | Version column enables optimistic concurrency control |
| **orders** | id (UUID PK), user_id (FK), event_id (FK), status (default 'pending'), total_amount, payment_id, idempotency_key (unique), created_at, completed_at | idx_orders_idempotency | Idempotency key prevents duplicate checkout processing |

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

## 🔒 5. Deep Dive: Two-Phase Distributed Locking (10 minutes)

### Problem Statement

When 10,000 users try to reserve the same seat simultaneously across multiple API server instances, we need both speed and consistency.

### Phase 1: Redis Distributed Lock

The Redis lock uses SET NX EX for atomic lock acquisition with automatic expiry:

1. For each seat, construct a lock key `lock:seat:{eventId}:{seatId}` and generate a unique lock token (UUID)
2. Attempt SET NX (only set if not exists) with the hold duration as expiry
3. If the lock is acquired, record the seat ID and its token
4. **All-or-nothing semantics**: If any seat in the batch fails to lock, release all previously acquired locks and return an empty result. This prevents partial reservations where a user holds some seats but not others.

The unique lock token is critical - it prevents one session from accidentally releasing another session's lock.

### Lock Release with Lua Script

Lock release uses a Lua script for atomic check-and-delete: it reads the current lock value, compares it against the expected token, and only deletes if they match. This prevents a session from accidentally releasing a lock that was already expired and reacquired by another session. The Lua script executes atomically on the Redis server, eliminating any race condition between the GET and DEL operations.

The release function calls this Lua script via EVAL, passing the lock key and expected token. It returns true if the lock was successfully released, false if the token didn't match (meaning another session holds the lock).

### Phase 2: PostgreSQL Transaction with Row Locking

After acquiring Redis locks (the fast path), we persist the reservation in PostgreSQL for durability:

1. **BEGIN transaction**
2. **SELECT FOR UPDATE NOWAIT** on the seat rows - this acquires exclusive row locks and fails immediately if another transaction holds them (rather than waiting and blocking)
3. **Verify all seats are still available** - check that every seat's status is 'available'. If any seat has been claimed between the Redis lock and this point, throw an error
4. **UPDATE seats** - Set status to 'held', record the session ID, set the hold expiry timestamp, and increment the version number for optimistic concurrency
5. **COMMIT** - If anything fails, ROLLBACK and propagate the error

### Combined Reservation Flow

The full reservation combines both phases with rollback handling:

1. **Phase 1** - Acquire Redis locks for all requested seats with a 10-minute hold duration. If any seat fails to lock, return "seats unavailable" immediately (sub-millisecond rejection)
2. **Phase 2** - Within a try block, persist the hold in PostgreSQL via the database transaction described above. Store the lock tokens and reservation metadata for later checkout or release
3. **Rollback on failure** - If the database transaction fails for any reason, release all Redis locks to make the seats available again
4. **Return result** - On success, return the reserved seat IDs, expiration timestamp, and 'held' status

### Why Two Phases?

| Aspect | Redis Only | PostgreSQL Only | Two-Phase |
|--------|------------|-----------------|-----------|
| Lock latency | ~1ms | ~20ms | ~5ms (Redis first) |
| Scalability | High | Limited by connections | High |
| Durability | Volatile | ACID | ACID (with Redis speed) |
| Consistency | Eventual | Strong | Strong |

---

## 🚪 6. Deep Dive: Virtual Waiting Room Queue (8 minutes)

### Queue Data Structures in Redis

The waiting room uses three Redis data structures per event:

- `queue:{eventId}` - Sorted set with session IDs scored by join timestamp (FIFO ordering)
- `active:{eventId}` - Set of currently admitted session IDs
- `active_session:{eventId}:{sessionId}` - String key with TTL for shopping window expiry

**Join queue**: Check if the session is already queued (ZSCORE). If not, add with current timestamp as score (ZADD). Return the queue position via ZRANK.

**Check position**: First check if the session has an active shopping key (already admitted). If not, check the sorted set rank. Return position, estimated wait time (based on ~500 admissions per minute), and status.

**Admit next batch**: Count current active sessions (SCARD). Calculate available slots up to a maximum of 5,000 concurrent shoppers. Use ZRANGE to get the next batch from the queue head. In a Redis pipeline: add each to the active set (SADD), create a shopping window key with 15-minute TTL (SETEX), and remove them from the queue (ZREM).

### Queue Admission Worker

A background worker runs every 5 seconds, polling for all high-demand events currently on sale. For each event, it calls the admit-next-batch logic to move queued users into the active shopping pool. Admission counts are logged for monitoring queue drain rates.

---

## 💳 7. Idempotent Checkout (5 minutes)

### Idempotency Key Strategy

The idempotency key is deterministically generated from the session ID, event ID, and sorted seat IDs (format: `checkout:{sessionId}:{eventId}:{sortedSeatIds}`). This ensures the same user attempting to buy the same seats for the same event always produces the same key, regardless of retries.

### Checkout with Idempotency

The checkout flow has five steps with idempotency at each level:

1. **Fast path check** - Look up the idempotency key in Redis (`idem:{key}`). If found, return the cached order immediately
2. **Database check** - Query for an existing order with the same idempotency_key. If found, return it (handles cases where Redis cache expired but order exists)
3. **Validate reservation** - Retrieve the reservation for this session and verify it hasn't expired
4. **Process payment** - Call the payment service through a circuit breaker (see below). If the payment processor is down, fail fast rather than hanging
5. **Complete order in transaction** - Within a PostgreSQL transaction: insert the order with the idempotency key, update all held seats to 'sold' status (only if still held by this session), commit, cache the result in Redis for 24 hours, and release the Redis seat locks

If the transaction fails, it rolls back and the error propagates. The idempotency key ensures retrying the entire flow is safe.

---

## 🧹 8. Background Jobs and Cleanup (3 minutes)

### Expired Hold Cleanup Worker

A background job runs every 60 seconds to release expired seat holds:

1. **Single atomic UPDATE** - Update all seats where status is 'held' and held_until is in the past, setting them back to 'available' and clearing the session and expiry fields. The RETURNING clause captures the released seat details.
2. **Clean up Redis locks** - Delete the corresponding Redis lock keys (which may already be expired by their own TTL)
3. **Invalidate cache** - Delete the availability cache for each affected event so the next read fetches fresh data
4. **Log the cleanup** - Record the count and affected event IDs for monitoring

### Circuit Breaker for Payment Processing

The circuit breaker protects against payment processor outages using a three-state machine (closed, open, half-open):

- **Closed** (normal operation): All requests pass through. After 5 consecutive failures, the breaker opens.
- **Open** (failing fast): All requests are immediately rejected without contacting the payment processor. After 30 seconds, the breaker transitions to half-open.
- **Half-open** (testing): A single request is allowed through. On success, the breaker closes. On failure, it reopens.

When the breaker opens, it logs a critical error with the failure count for alerting.

---

## ⚡ 9. Caching Strategy (3 minutes)

### Dynamic TTL Based on Event Status

Seat availability caching uses dynamic TTLs based on event status:

- **On-sale events**: 5-second TTL (data changes rapidly during active sales)
- **Non-sale events**: 30-second TTL (availability changes infrequently)

The read path follows cache-aside: check Redis first, on miss query PostgreSQL for all seats ordered by section/row/number, determine the appropriate TTL from the event status, and cache the formatted seat map.

### Cache Invalidation Points

| Operation | Cache Keys Invalidated |
|-----------|------------------------|
| Seat reserved | `availability:{eventId}` |
| Seat released | `availability:{eventId}` |
| Checkout completed | `availability:{eventId}` |
| Order cancelled | `availability:{eventId}` |
| Hold expired | `availability:{eventId}` |

---

## 🛡️ Failure Handling and What Breaks First

An on-sale is the one moment this system is under real load, so I want to be
specific about which component gives way first and what the user sees when it
does.

### Failure matrix

| Failure | Behavior | User impact |
|---------|----------|-------------|
| **Redis down** | Seat locks unavailable; reservations rejected outright | Cannot buy — browsing and order history still work |
| **Postgres down** | Everything write-path fails | Hard outage; this is the source of truth |
| **Payment provider down** | Circuit breaker opens, fails fast | "Payment unavailable, your seats are still held" — the hold outlives the outage |
| **Lock contention on a hot seat** | `NOWAIT` returns immediately | "That seat just went — pick another", instantly, not a spinner |
| **API instance dies mid-hold** | Hold survives in `event_seats.held_until` | Nothing; the sweeper releases it on schedule |
| **Redis flushed mid-sale** | Locks vanish, but DB rows still say `held` | No overselling — the transaction re-verifies under `FOR UPDATE NOWAIT` |

The pattern: **the durable state is in Postgres and the fast state is in Redis,
so every Redis failure costs availability and none of them cost correctness.**
Losing Redis stops sales; it never sells the same seat twice.

> "The one I'd flag in review is Redis being a hard dependency for reservations.
> There's an advisory-lock fallback written and it isn't wired into the main
> path. I'd argue that's defensible — refusing to sell is a *safe* failure, and
> a half-tested fallback engaging for the first time during the highest-stakes
> ten minutes of the year is how you turn an outage into an overselling
> incident. But it should be a deliberate choice, not an accident."

### What breaks first, in order

1. **The waiting-room admission rate, under horizontal scaling.** The queue
   processor is an in-process interval. Run three API instances and three
   processors admit from the same sorted set, so the effective rate is 3× the
   configured one — and the `maxConcurrent` check is a `SCARD` followed by a
   `ZRANGE` as separate round-trips, so instances race and the active set
   overshoots. This is the first thing that breaks and it breaks *quietly*:
   admission control that admits too many looks fine until the seat map falls
   over. The fix is a single Lua script for the admit decision plus a
   leader-elected or dedicated worker.

2. **Cache invalidation.** Every reservation calls `KEYS availability:{id}:*`,
   which is O(keyspace) and blocks Redis while it runs. At seed scale it's
   invisible; during an on-sale it means the hottest write path takes a global
   lock on the component every other path depends on. A per-event version
   counter folded into the cache key removes the scan entirely.

3. **The expiry sweeper.** It issues one `UPDATE` per expired seat in a loop.
   When a 20,000-seat event's holds lapse together, that's 20,000 statements on
   a 60-second timer. Set-based, it's one statement.

4. **Lock acquisition order.** `acquireSeatLocks` takes locks in whatever order
   the client sent the seat IDs, so two buyers requesting {A,B} and {B,A} can
   each hold one. That isn't a deadlock only because acquisition is bounded —
   three retries with jittered backoff, then release everything. It's
   livelock-free by fail-fast rather than by discipline; sorting the IDs before
   acquiring makes it correct by construction and costs nothing.

> "Notice that three of those four only appear under load or under horizontal
> scaling — which is exactly the condition this product exists for. A ticketing
> system that works fine on one instance with ten users has not been tested at
> all."

---


## 📊 10. Observability (2 minutes)

### Key Metrics

We track four Prometheus metrics:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| seats_reserved_total | Counter | event_id | Total seats reserved |
| seat_lock_attempts_total | Counter | event_id, result (success/failure) | Lock acquisition success rate |
| checkout_duration_seconds | Histogram (buckets: 100ms to 5s) | event_id | End-to-end checkout latency |
| queue_length | Gauge | event_id | Current waiting room queue depth |

### Alerting Thresholds

| Metric | Threshold | Severity |
|--------|-----------|----------|
| `seat_lock_attempts{result="failure"}` rate | > 10% | Warning |
| `checkout_duration_seconds` p95 | > 2s | Warning |
| `queue_length` | > 50,000 | Critical |
| Any oversell detected | > 0 | Critical |

---

## 📌 Summary

"I've designed a backend system for high-traffic event ticketing with:

1. **Two-phase distributed locking** using Redis SET NX for speed and PostgreSQL FOR UPDATE for ACID guarantees
2. **Virtual waiting room** with Redis sorted sets for fair, scalable queue management
3. **Idempotent checkout** with idempotency keys stored in both Redis and PostgreSQL
4. **Circuit breaker** pattern for payment processing resilience
5. **Background cleanup** jobs for expired holds with cache invalidation

The key insight is that the fast path (Redis locks) protects the slow path (database transactions), and both are needed to achieve sub-100ms reservation times while guaranteeing zero overselling."
