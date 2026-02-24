# Calendly - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## Introduction

"I'll design a meeting scheduling platform like Calendly, focusing on the backend architecture. The core challenge is preventing double bookings under high concurrency while efficiently calculating availability across multiple calendar sources. I need to balance strong consistency for bookings against low latency for availability checks."

---

## 🎯 Requirements Clarification

### Functional Requirements

1. **Availability Management** - Hosts define weekly working hours
2. **Meeting Types** - Configurable durations with buffer times
3. **Booking Flow** - Guests select slots and book with conflict prevention
4. **Calendar Integration** - Sync with Google Calendar and Outlook
5. **Notifications** - Email confirmations and reminders

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Consistency | Zero double bookings | A single double booking destroys user trust |
| Availability p99 | < 200ms | Users browse many dates before booking |
| Booking p99 | < 500ms | Acceptable for a form submission |
| Scale | 1M users, 5K RPS | Availability checks dominate (100:1 ratio to bookings) |

> "The key insight is that availability reads vastly outnumber booking writes. This shapes my entire architecture - I'll optimize heavily for reads while ensuring absolute consistency on writes."

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Load Balancer                            │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Gateway Layer                            │
│                   (Rate Limiting, Auth)                          │
└─────────────────────────────────────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Booking Service │  │ Availability    │  │ Integration     │
│                 │  │ Service         │  │ Service         │
│ Handles writes  │  │ Handles reads   │  │ Calendar sync   │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   PostgreSQL    │  │   Redis/Valkey  │  │    RabbitMQ     │
│   (Primary)     │  │   (Cache)       │  │   (Async Jobs)  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## 💾 Data Model

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| users | id, email, timezone | Host accounts |
| meeting_types | id, user_id, duration_minutes, buffer_before, buffer_after | Event templates |
| availability_rules | user_id, day_of_week, start_time, end_time | Weekly schedule |
| bookings | id, host_user_id, start_time, end_time, status, version | Confirmed meetings |
| calendar_integrations | user_id, provider, access_token, refresh_token | OAuth connections |

**Critical indexes:**
- Unique partial index on `bookings(host_user_id, start_time) WHERE status = 'confirmed'` - database-level double booking prevention
- Composite index on `bookings(host_user_id, start_time, end_time)` - fast overlap queries

---

## 🔧 Deep Dive: Double Booking Prevention

> "This is the hardest problem. Two guests clicking 'Book' at the exact same moment must never both succeed for the same slot. I need to guarantee this without making bookings painfully slow."

### The Race Condition Problem

Consider this scenario: Alice and Bob both see 2:00 PM available. Both click "Book" within 50ms of each other. Without proper protection, both database inserts could succeed because each check sees no existing booking.

### Trade-off Analysis: Locking Strategies

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Pessimistic locking (SELECT FOR UPDATE) | Guarantees correctness, simple mental model | Adds 10-50ms latency, potential lock contention |
| ❌ Optimistic locking only | Lower latency happy path | Higher conflict rate, complex retry logic |
| ❌ Serializable isolation | Strongest guarantees | Severe performance penalty, serialization failures |
| ❌ Application-level locks only | Works across databases | Redis failure = booking system failure |

**Why I chose pessimistic locking with layered protection:**

> "Optimistic locking seems appealing - no locks, lower latency. But for a scheduling system, the conflict rate during popular time slots (Monday 10 AM, lunch hours) would be significant. When 50 people try to book the same slot in a flash sale scenario, optimistic locking means 49 failed transactions that need retry logic, error handling, and user communication. The retry storms would actually create more load than the locks would.

> With pessimistic locking, I serialize access to a host's calendar for the 200ms it takes to complete a booking. This adds latency, but the booking either succeeds or fails cleanly - no retries, no race conditions. For a system where correctness matters more than raw throughput, this is the right trade-off.

> I layer this with a Redis distributed lock as a fast-fail mechanism. If someone is already booking with this host, new requests fail immediately rather than waiting for a database lock. This protects the database while providing better UX - users see 'someone else is booking, please retry' rather than waiting 5 seconds."

### The Five-Layer Approach

1. **Idempotency key** - Prevents duplicate submissions from network retries
2. **Distributed lock** - Fast-fail if another booking is in progress for this host
3. **Row-level lock** - Serialize within the transaction
4. **Overlap query** - Explicit conflict check
5. **Unique partial index** - Database constraint as final safety net

> "Each layer catches different failure modes. The idempotency key handles the 'user clicked twice' problem. The distributed lock handles concurrent requests. The database constraints catch anything that slips through application code bugs."

---

## 🔧 Deep Dive: Availability Calculation

> "A host might have 5 calendar integrations, each with 100+ events per month, plus internal bookings and availability rules. Computing available slots needs to be fast because users browse many dates before booking."

### The Algorithm

1. Fetch availability rules for the requested day
2. Fetch confirmed bookings for that day
3. Fetch external calendar events (from cache or API)
4. Merge all busy periods into sorted, non-overlapping intervals
5. Subtract busy periods from availability windows
6. Generate slots based on meeting duration and buffer times

### Trade-off Analysis: Caching Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Short TTL cache (5 min) + invalidation | Fresh enough, handles 80%+ of reads | Complexity of invalidation logic |
| ❌ No cache | Always accurate | 5K RPS would crush the database |
| ❌ Long TTL cache (1 hour) | Great hit rate | Unacceptable staleness - users book unavailable slots |
| ❌ Pre-compute all availability | Fastest reads | Explosion of cache keys, complex invalidation |

**Why 5-minute TTL with event-driven invalidation:**

> "The fundamental tension is freshness vs. performance. A user browsing dates expects to see accurate availability, but recalculating from scratch on every request would overwhelm the system.

> I chose a 5-minute TTL because that's the typical browsing session length. If a user is actively looking at availability, they're seeing cached data that's at most 5 minutes old - acceptable for this use case. The key insight is that during active booking, I invalidate the cache immediately. So the sequence is: Alice books 2:00 PM → cache invalidated → Bob refreshes and sees 2:00 PM gone.

> Long TTL (1 hour) fails because it would show slots as available that were booked 45 minutes ago. Users would frequently hit 'slot unavailable' errors after filling out forms - terrible UX. No cache fails because we'd hit the database 5000 times per second during peak, which is unsustainable without massive overprovisioning.

> The invalidation is pattern-based: when anything changes for a host (booking, cancellation, availability rule change, calendar sync), I delete all cache keys matching `availability:{host_id}:*`. This is aggressive but simple - I'd rather have cache misses than stale data for a booking system."

---

## 🔧 Deep Dive: Calendar Integration

### The Sync Challenge

External calendars (Google, Outlook) contain events that block availability. I need to keep this data fresh without overwhelming provider APIs or missing important updates.

### Trade-off Analysis: Sync Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Webhooks + polling fallback | Real-time when working, resilient to failures | More complex implementation |
| ❌ Polling only | Simple, predictable | 10-minute staleness minimum, wastes API quota |
| ❌ Webhooks only | Real-time updates | Silent failures leave data stale for days |
| ❌ On-demand sync | Always fresh | Adds 500ms+ to every availability request |

**Why hybrid sync:**

> "Google Calendar offers push notifications (webhooks), which is ideal - when a user adds an event, Google notifies us immediately. But webhooks fail silently. The notification might not arrive due to network issues, or our endpoint might be down during deployment. If I rely only on webhooks, a failed notification means the calendar data stays stale until the user manually syncs.

> On-demand sync (fetch calendar on every availability request) seems attractive for freshness, but it adds 200-500ms to every request and quickly exhausts API rate limits. Google allows 1 million requests/day, which sounds like a lot until you have 1M users each browsing 10 dates - that's 10M requests per day just for calendar data.

> The hybrid approach gives me the best of both: webhooks for real-time updates, plus a polling job that runs every 10 minutes to catch anything webhooks missed. The polling is batched by user, only fetching calendars that haven't been updated recently. This catches webhook failures within 10 minutes while keeping API usage reasonable."

---

## 📧 Notifications

### Queue-Based Processing

Booking confirmations and reminders go through RabbitMQ rather than being sent synchronously:

```
Booking Created ──▶ Queue Message ──▶ Notification Worker ──▶ Email Sent
```

**Why async:**

> "Email delivery can take 1-3 seconds (SMTP handshake, retries). If I send synchronously, the user waits 3 seconds after clicking 'Book' before seeing confirmation. Worse, if SendGrid is slow or down, the booking might fail entirely even though the database write succeeded.

> By queuing notifications, the booking completes in 200ms, user sees confirmation immediately, and the email arrives 5-10 seconds later. If email delivery fails, the worker retries with exponential backoff. The booking is never blocked by email infrastructure issues."

---

## 📈 Scaling Considerations

### What Breaks First

At 10x current scale:
1. **Availability cache** - More users browsing = more cache misses = database pressure
2. **Calendar sync** - More integrations = more API calls = rate limit issues
3. **Single PostgreSQL** - Write amplification from all the index updates on bookings

### Scaling Path

1. **Read replicas** for availability queries - most load is reads
2. **Table partitioning** by month for bookings - keeps active partition small
3. **Rate-limited calendar sync** with priority queue - popular hosts sync more often
4. **Horizontal scaling** of stateless API servers behind load balancer

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why Alternative Fails |
|----------|--------|-------------|----------------------|
| DB for bookings | PostgreSQL | DynamoDB | Need ACID transactions for double-booking prevention |
| Locking strategy | Pessimistic | Optimistic | High conflict rate during popular slots |
| Availability cache | 5-min TTL | Long TTL | Stale data causes booking failures |
| Calendar sync | Webhook + poll | Webhook only | Silent failures leave data stale |
| Notifications | Async queue | Synchronous | Email failures shouldn't block bookings |
| Time storage | UTC only | Local time | DST transitions corrupt data |

---

## 🎯 Summary

"The Calendly backend architecture centers on one principle: strong consistency for bookings, aggressive caching for availability reads.

**Double booking prevention** uses five defensive layers - any one of them would likely work alone, but the combination handles edge cases and provides defense in depth. The database unique index is the last line of defense that catches any application bugs.

**Availability calculation** is optimized for the 100:1 read-to-write ratio. Aggressive caching with event-driven invalidation keeps read latency low while ensuring users see fresh data when it matters - right after a booking changes.

**Calendar integration** uses a hybrid approach because neither webhooks nor polling alone is sufficient. Webhooks fail silently; polling is too slow and expensive. Together, they provide real-time updates with reliable fallback.

The key trade-off throughout is complexity vs. correctness. I could build a simpler system that occasionally double-books or shows stale availability, but for a scheduling product, these failures destroy user trust. The extra complexity is worth it."
