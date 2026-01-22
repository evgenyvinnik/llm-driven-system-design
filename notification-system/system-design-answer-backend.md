# Notification System - Backend Engineer Interview Answer

## System Design Interview (45 minutes)

### Opening Statement (1 minute)

"I'll design the backend infrastructure for a high-throughput notification system delivering messages across push, email, SMS, and in-app channels. The core challenge is processing millions of notifications per minute while respecting user preferences, managing delivery priorities, and ensuring reliable delivery with appropriate retry strategies.

From a backend perspective, I'll focus on priority queue design, multi-channel worker architecture, rate limiting strategies, and delivery tracking with comprehensive retry logic."

---

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Multi-Channel Delivery**: Push (iOS/Android), Email, SMS, In-App
- **Priority Handling**: Critical notifications bypass normal queues
- **User Preferences**: Respect opt-outs, quiet hours, channel preferences
- **Template System**: Dynamic content with variable substitution
- **Delivery Tracking**: Status tracking, open/click analytics

### Non-Functional Requirements
- **Throughput**: 1M+ notifications per minute
- **Latency**: < 100ms for critical notifications
- **Reliability**: 99.99% delivery rate
- **Ordering**: Best-effort ordering within priority level

### Scale Estimates
- **Notifications/day**: 1 billion+
- **Peak rate**: 20,000+ per second
- **Channels**: 4 (push, email, SMS, in-app)
- **Users**: 100M+ with preferences to manage

---

## Deep Dive: Priority Queue System (10 minutes)

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Message Router                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Validation   │  │ Preferences  │  │ Routing      │      │
│  │ - Schema     │  │ - User prefs │  │ - Channel    │      │
│  │ - Rate limit │  │ - Quiet hours│  │ - Priority   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Priority Queue│    │ Priority Queue│    │ Priority Queue│
│    (Push)     │    │   (Email)     │    │    (SMS)      │
│               │    │               │    │               │
│ Critical/High │    │ Critical/High │    │ Critical/High │
│ Normal/Low    │    │ Normal/Low    │    │ Normal/Low    │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Priority Scoring with Redis Sorted Sets

"I use Redis sorted sets where lower scores indicate higher priority. The score combines priority weight and timestamp for ordering within priority levels."

**Priority Weight System:**

| Priority | Weight Range | Processing Order |
|----------|--------------|------------------|
| critical | 0 - 999B | First (immediate) |
| high | 1T - 2T | After critical |
| normal | 2T - 3T | Standard |
| low | 3T+ | Best effort |

**Score Formula:** `priorityWeight[priority] + timestamp`

**Queue Operations:**

| Operation | Redis Command | Complexity |
|-----------|---------------|------------|
| Enqueue | ZADD queue:channel score notification | O(log N) |
| Dequeue batch | ZPOPMIN queue:channel batchSize | O(log N) |
| Get depth | ZCARD queue:channel | O(1) |
| Count by priority | ZCOUNT queue:channel minScore maxScore | O(log N) |

### Why Sorted Sets Over Separate Queues?

| Approach | Pros | Cons |
|----------|------|------|
| Separate queues per priority | Simple logic | Must poll all queues |
| Single sorted set | Atomic dequeue | Score calculation |
| Multiple lists with polling | Simple | Priority inversion risk |

"Sorted sets let us atomically pop the highest-priority items in O(log N) without polling multiple queues."

### RabbitMQ Alternative

**Queue Configuration per Priority:**

| Priority | Queue Name | TTL | Dead Letter Exchange |
|----------|------------|-----|---------------------|
| critical | channel.critical | 1 minute | notifications.dlx |
| high | channel.high | 5 minutes | notifications.dlx |
| normal | channel.normal | 1 hour | notifications.dlx |
| low | channel.low | 24 hours | notifications.dlx |

**Message Properties:**
- persistent: true (survives broker restart)
- contentType: application/json
- messageId: notification.id
- timestamp: Date.now()

---

## Deep Dive: Multi-Channel Workers (10 minutes)

### Worker Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Channel Worker                          │
├─────────────────────────────────────────────────────────────┤
│  Configuration:                                              │
│  - concurrency: 10 (parallel notifications)                  │
│  - batchSize: 100 (dequeue per cycle)                       │
│  - circuitBreaker: failureThreshold=5, resetTimeout=30s     │
├─────────────────────────────────────────────────────────────┤
│  Processing Loop:                                            │
│  1. Dequeue batch from priority queue                        │
│  2. If empty, backoff 100ms                                  │
│  3. Process batch with concurrency limit                     │
│  4. Each notification: circuit breaker ──▶ deliver           │
│  5. On success: update tracker, increment metrics            │
│  6. On failure: handleFailure (retry or dead letter)        │
└─────────────────────────────────────────────────────────────┘
```

### Push Notification Worker (APNs/FCM)

**Delivery Flow:**

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Get User   │────▶│ For Each    │────▶│  Platform   │
│  Devices    │     │  Device     │     │  Dispatch   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┴──────────────────────────┐
                    ▼                                                      ▼
           ┌─────────────┐                                        ┌─────────────┐
           │  iOS: APNs  │                                        │ Android:FCM │
           │  - alert    │                                        │ - title     │
           │  - sound    │                                        │ - body      │
           │  - badge    │                                        │ - priority  │
           │  - topic    │                                        │ - channelId │
           │  - expiry   │                                        └─────────────┘
           └─────────────┘
```

**Error Handling:**
- NoDevicesError: User has no registered devices
- InvalidToken: Device uninstalled app, deregister token
- Partial success: At least one device received = success

### Email Worker with Template Rendering

**Delivery Flow:**

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Get User   │────▶│  Validate   │────▶│  Render     │
│  Email      │     │  Verified   │     │  Template   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                                               ▼
                                      ┌─────────────────┐
                                      │  Send Email     │
                                      │  - to: email    │
                                      │  - subject      │
                                      │  - html/text    │
                                      │  - headers:     │
                                      │    X-Notif-Id   │
                                      │    Unsubscribe  │
                                      │  - tracking:    │
                                      │    click/open   │
                                      └─────────────────┘
```

### Channel-Specific Rate Limits

| Channel | Rate Limit | Retry Strategy | Typical Latency |
|---------|------------|----------------|-----------------|
| Push (APNs) | High | 3x exponential | <100ms |
| Push (FCM) | High | 3x exponential | <100ms |
| Email | 100/sec | 5x with backoff | 1-5s |
| SMS | 10/sec | 2x | 1-3s |

---

## Deep Dive: Rate Limiting (7 minutes)

### Multi-Level Rate Limiting

```
┌─────────────────────────────────────────────────────────────┐
│                    Rate Limit Check Flow                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. User Limit (prevent spam to single user)                │
│     Key: ratelimit:user:{userId}:{channel}                  │
│     ┌────────────────────────────────────────┐              │
│     │ push:  50/hour                          │              │
│     │ email: 10/hour                          │              │
│     │ sms:   5/hour                           │              │
│     └────────────────────────────────────────┘              │
│                           │                                  │
│                           ▼ If allowed                       │
│  2. Service Limit (prevent runaway services)                │
│     Key: ratelimit:service:{serviceId}:{channel}            │
│     ┌────────────────────────────────────────┐              │
│     │ push:  50,000/min                       │              │
│     │ email: 5,000/min                        │              │
│     │ sms:   500/min                          │              │
│     └────────────────────────────────────────┘              │
│                           │                                  │
│                           ▼ If allowed                       │
│  3. Global Limit (protect downstream services)              │
│     Key: ratelimit:global:{channel}                         │
│     ┌────────────────────────────────────────┐              │
│     │ push:  100,000/min                      │              │
│     │ email: 10,000/min                       │              │
│     │ sms:   1,000/min                        │              │
│     └────────────────────────────────────────┘              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Redis Implementation:**
- INCR key (atomic increment)
- EXPIRE key window (set TTL on first increment)
- Check count > limit (return limited: true with retryAfter from TTL)

### Sliding Window Rate Limiter

"For more accurate limiting at window boundaries, use Redis sorted sets."

**Algorithm:**
1. Remove entries older than window: ZREMRANGEBYSCORE key 0 windowStart
2. Count current entries: ZCARD key
3. If count >= limit: calculate retryAfter from oldest entry
4. Otherwise: ZADD key timestamp randomId, EXPIRE key windowSeconds

---

## Deep Dive: Retry and Circuit Breaker (8 minutes)

### Exponential Backoff with Jitter

**Retry Configuration:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| maxRetries | 5 | Maximum attempts |
| baseDelay | 1000ms | Initial wait |
| maxDelay | 300000ms | Cap at 5 minutes |
| jitterFactor | 0.1 | Randomization |

**Delay Formula:** `min(baseDelay * 2^attempt + jitter, maxDelay)`

**Example Delays:**
- Attempt 0: ~1s
- Attempt 1: ~2s
- Attempt 2: ~4s
- Attempt 3: ~8s
- Attempt 4: ~16s

**Retryable Errors:**
- HTTP 429, 500, 502, 503, 504
- ECONNRESET, ETIMEDOUT, ECONNREFUSED

**Non-retryable (send to dead letter):**
- 400 Bad Request
- 401 Unauthorized
- 404 Not Found

### Circuit Breaker Implementation

```
┌─────────────────────────────────────────────────────────────┐
│                   Circuit Breaker States                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────┐                    ┌──────────┐              │
│   │  CLOSED  │───failures >= 5───▶│   OPEN   │              │
│   │          │                    │          │              │
│   └────▲─────┘                    └────┬─────┘              │
│        │                               │                     │
│   successes >= 3                  resetTimeout (30s)        │
│        │                               │                     │
│   ┌────┴─────┐                         │                     │
│   │HALF_OPEN │◀────────────────────────┘                     │
│   │          │                                               │
│   └──────────┘                                               │
│                                                              │
│  CLOSED: Normal operation, track failures                   │
│  OPEN: Reject immediately, throw CircuitOpenError           │
│  HALF_OPEN: Allow limited requests to probe recovery        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Configuration:**
- failureThreshold: 5 (failures to open)
- resetTimeout: 30000ms (time in OPEN state)
- halfOpenRequests: 3 (successes to close)

### Dead Letter Queue Handler

**DLQ Entry Fields:**

| Field | Type | Purpose |
|-------|------|---------|
| notification_id | UUID | Original notification |
| original_payload | JSONB | Full notification data |
| channel | VARCHAR | Delivery channel |
| error_message | TEXT | Last error |
| error_code | VARCHAR | Error classification |
| attempts | INTEGER | Total attempts |
| failed_at | TIMESTAMP | When moved to DLQ |
| reprocessed_at | TIMESTAMP | When reprocessed |

**Reprocessing Flow:**
1. Query pending DLQ items (reprocessed_at IS NULL)
2. Parse original_payload
3. Reprocess through notification service
4. On success: set reprocessed_at, status='success'
5. On failure: increment reprocess_attempts, update last_error

**Alerting:** Trigger ops alert when DLQ count > 100

---

## Database Schema (5 minutes)

### PostgreSQL Tables

**notifications:**

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PRIMARY KEY |
| user_id | UUID | NOT NULL |
| template_id | VARCHAR(100) | |
| content | JSONB | NOT NULL |
| channels | TEXT[] | NOT NULL |
| priority | VARCHAR(20) | DEFAULT 'normal' |
| status | VARCHAR(20) | DEFAULT 'pending' |
| idempotency_key | VARCHAR(255) | UNIQUE (partial) |
| scheduled_at | TIMESTAMP | |
| created_at | TIMESTAMP | DEFAULT NOW() |
| delivered_at | TIMESTAMP | |

**delivery_status:**

| Column | Type | Constraints |
|--------|------|-------------|
| notification_id | UUID | FK → notifications |
| channel | VARCHAR(20) | NOT NULL |
| status | VARCHAR(20) | NOT NULL |
| details | JSONB | DEFAULT '{}' |
| attempts | INTEGER | DEFAULT 1 |
| last_attempt_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |
| | | PK(notification_id, channel) |

**notification_preferences:**

| Column | Type | Purpose |
|--------|------|---------|
| user_id | UUID | PRIMARY KEY |
| channels | JSONB | Per-channel enable/disable |
| categories | JSONB | Category preferences |
| quiet_hours_start | INTEGER | Minutes from midnight |
| quiet_hours_end | INTEGER | Minutes from midnight |
| timezone | VARCHAR(50) | DEFAULT 'UTC' |

**device_tokens:**

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID | PRIMARY KEY |
| user_id | UUID | NOT NULL |
| platform | VARCHAR(20) | ios, android, web |
| token | TEXT | NOT NULL, UNIQUE |
| device_info | JSONB | Device metadata |
| active | BOOLEAN | DEFAULT true |

**notification_events:**

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID | PRIMARY KEY |
| notification_id | UUID | FK → notifications |
| channel | VARCHAR(20) | |
| event_type | VARCHAR(20) | open, click, dismiss |
| metadata | JSONB | Event details |
| occurred_at | TIMESTAMP | |

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| prefs:{userId} | String (JSON) | 5 min | User preferences cache |
| ratelimit:user:{userId}:{channel} | String (int) | window | User rate limit |
| ratelimit:global:{channel} | String (int) | window | Global rate limit |
| ratelimit:service:{serviceId}:{channel} | String (int) | window | Service rate limit |
| idempotency:{key} | String (JSON) | 24h | Deduplication |
| queue:{channel} | Sorted Set | - | Priority queue |
| circuit:{channel} | String (JSON) | - | Circuit breaker state |

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Queue Technology | Redis Sorted Sets | RabbitMQ/Kafka | Simpler priority implementation, low latency |
| Delivery Guarantee | At-least-once | Exactly-once | Simpler, more reliable; clients handle duplicates |
| Preference Caching | 5-minute TTL | Real-time | Reduces DB load; acceptable staleness |
| Worker Scaling | Per-channel pools | Unified pool | Independent scaling, failure isolation |
| Retry Strategy | Exponential backoff | Fixed interval | Prevents thundering herd |
| Rate Limiting | Sliding window | Fixed window | More accurate at window boundaries |
| Idempotency | Redis with 24h TTL | Database | Low latency, automatic cleanup |
| Circuit Breaker | Per-provider | Global | Isolate failures by channel |

---

## Future Enhancements

1. **Notification Batching**: Aggregate low-priority notifications into digest emails
2. **A/B Testing**: Test different templates and delivery times
3. **Machine Learning**: Optimize delivery time based on user engagement patterns
4. **Multi-Region Delivery**: Route to nearest provider endpoint
5. **Webhook Delivery**: Support HTTP endpoint delivery for external integrations
6. **Priority Escalation**: Auto-escalate undelivered high-priority notifications to SMS
