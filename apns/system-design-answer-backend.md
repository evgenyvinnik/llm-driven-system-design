# APNs (Apple Push Notification Service) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design APNs from a backend engineering perspective, focusing on the infrastructure needed to deliver billions of push notifications daily. The core challenges are managing millions of concurrent device connections, implementing store-and-forward for reliable delivery, achieving sub-500ms latency for high-priority notifications, and maintaining exactly-once semantics where possible.

For this discussion, I'll emphasize the database schema design, caching strategies, connection management, and observability infrastructure."

## Requirements Clarification (3 minutes)

### Functional Requirements
1. **Push Delivery**: Deliver notifications to devices with < 500ms latency for high-priority messages
2. **Token Registry**: Manage device token lifecycle (registration, invalidation, refresh)
3. **Store-and-Forward**: Queue notifications for offline devices with expiration policies
4. **Topic Subscriptions**: Subscribe devices to broadcast channels
5. **Feedback Service**: Report invalid tokens back to providers

### Non-Functional Requirements
1. **Throughput**: 580K+ notifications/second (50B per day)
2. **Latency**: < 500ms for priority-10 notifications to online devices
3. **Reliability**: 99.99% delivery to online devices
4. **Consistency**: At-least-once delivery with idempotency support

### Scale Estimates
- 1 billion+ active Apple devices
- 50 billion notifications/day = 580K/second
- Each device maintains persistent connection when online
- Store up to 100 notifications per offline device
- Token registry: 1B+ records with high-read workload

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              Provider Layer                                          │
│                    App Servers (Netflix, WhatsApp, etc.)                            │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │ HTTP/2 + JWT Auth
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              APNs Gateway                                            │
│         (Rate Limiting, JWT Validation, Payload Validation, Routing)                │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│    Token Registry    │  │    Push Service      │  │    Store Service     │
│                      │  │                      │  │                      │
│ - Token CRUD         │  │ - WebSocket manager  │  │ - Pending queue      │
│ - Topic subscriptions│  │ - Delivery routing   │  │ - Expiration cleanup │
│ - Invalidation       │  │ - Connection shards  │  │ - Collapse handling  │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
         │                          │                        │
         ▼                          ▼                        ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│    PostgreSQL        │  │       Redis          │  │    Feedback Queue    │
│    (Tokens, Logs)    │  │  (Connections, Rate) │  │    (Invalid Tokens)  │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

### Core Backend Components
1. **APNs Gateway** - HTTP/2 endpoint with JWT validation and rate limiting
2. **Token Registry** - Device token CRUD with hash-based storage
3. **Push Service** - Manages device connections and delivery routing
4. **Store Service** - Queues notifications for offline devices
5. **Feedback Service** - Collects and exposes invalid token reports

## Deep Dive: Database Schema Design (8 minutes)

### Entity Relationship Model

```
┌──────────────────────────┐         ┌──────────────────────────┐
│      device_tokens       │◄────────│   topic_subscriptions    │
├──────────────────────────┤   1:N   ├──────────────────────────┤
│ device_id (PK)       UUID│         │ device_id (PK,FK)    UUID│
│ token_hash       VARCHAR │         │ topic (PK)         VARCHAR│
│ app_bundle_id    VARCHAR │         │ subscribed_at    TIMESTAMP│
│ device_info        JSONB │         └──────────────────────────┘
│ is_valid          BOOLEAN│
│ invalidated_at  TIMESTAMP│         ┌──────────────────────────┐
│ invalidation_reason      │◄────────│  pending_notifications   │
│   VARCHAR                │   1:N   ├──────────────────────────┤
│ created_at      TIMESTAMP│         │ id (PK)              UUID│
│ last_seen       TIMESTAMP│         │ device_id (FK)       UUID│
└────────────┬─────────────┘         │ payload             JSONB│
             │                       │ priority           INTEGER│
             │                       │ expiration       TIMESTAMP│
             │                       │ collapse_id       VARCHAR│
             │ 1:N                   │ created_at       TIMESTAMP│
             │                       │ UNIQUE(device_id,         │
             ▼                       │        collapse_id)       │
┌──────────────────────────┐         └──────────────────────────┘
│       notifications      │
├──────────────────────────┤         ┌──────────────────────────┐
│ id (PK)              UUID│────────▶│       delivery_log       │
│ device_id (FK)       UUID│   1:1   ├──────────────────────────┤
│ payload             JSONB│         │ notification_id (PK) UUID│
│ priority           INTEGER│        │ device_id (FK)       UUID│
│ expiration       TIMESTAMP│        │ status             VARCHAR│
│ collapse_id        VARCHAR│        │ delivered_at     TIMESTAMP│
│ status             VARCHAR│        └──────────────────────────┘
│ created_at       TIMESTAMP│
└──────────────────────────┘         ┌──────────────────────────┐
                                     │      feedback_queue      │
                                     ├──────────────────────────┤
                                     │ id (PK)          BIGSERIAL│
                                     │ token_hash         VARCHAR│
                                     │ app_bundle_id      VARCHAR│
                                     │ reason             VARCHAR│
                                     │ timestamp        TIMESTAMP│
                                     └──────────────────────────┘
```

### Key Table Design Decisions

**1. Token Hashing for Security**

```sql
-- Tokens are hashed before storage (SHA-256)
CREATE TABLE device_tokens (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(64) UNIQUE NOT NULL,  -- SHA-256 of raw token
  app_bundle_id VARCHAR(200) NOT NULL,
  device_info JSONB,
  is_valid BOOLEAN DEFAULT TRUE,
  invalidated_at TIMESTAMP,
  invalidation_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW()
);

-- Partial index for valid tokens (most common query)
CREATE INDEX idx_tokens_valid ON device_tokens(token_hash)
  WHERE is_valid = true;

-- App-level queries
CREATE INDEX idx_tokens_app ON device_tokens(app_bundle_id);
```

**Why Hash Tokens?** If the database is breached, attackers cannot use exposed hashes to send spam notifications. The 64-char hex output provides efficient fixed-length indexing.

**2. Collapse ID with UPSERT Pattern**

```sql
CREATE TABLE pending_notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,  -- 10=immediate, 5=background, 1=low
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, collapse_id)  -- Enables atomic replacement
);

-- Collapse pattern: newer notification replaces older
INSERT INTO pending_notifications (id, device_id, payload, priority, collapse_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (device_id, collapse_id)
DO UPDATE SET payload = $3, priority = $4, created_at = NOW();
```

**Use Case:** Sports score updates use collapse_id to ensure only the latest score is delivered, not 20 intermediate updates.

**3. Foreign Key Deletion Strategies**

| Relationship | ON DELETE | Rationale |
|--------------|-----------|-----------|
| topic_subscriptions → device_tokens | CASCADE | Subscriptions meaningless without device |
| pending_notifications → device_tokens | CASCADE | Cannot deliver to deleted device |
| notifications → device_tokens | SET NULL | Preserve analytics history |
| delivery_log → device_tokens | SET NULL | Preserve audit trail |

## Deep Dive: Caching Strategy (7 minutes)

### Cache Topology

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           Notification Request                                       │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         Redis (Valkey) - L1 Cache                                    │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────┐ │
│  │ Token Lookups           │  │ Connection Mapping      │  │ Rate Limiting       │ │
│  │ cache:token:{hash}      │  │ conn:{deviceId}         │  │ rate:device:{id}    │ │
│  │ TTL: 1 hour             │  │ TTL: 5 min              │  │ TTL: 1 min          │ │
│  └─────────────────────────┘  └─────────────────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │ cache miss
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              PostgreSQL                                              │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern for Token Lookups

```typescript
class TokenRegistry {
  async lookup(token: string): Promise<Device | null> {
    const tokenHash = sha256(token);
    const cacheKey = `cache:token:${tokenHash}`;

    // 1. Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      metrics.cacheHit.labels('token').inc();
      return JSON.parse(cached);
    }
    metrics.cacheMiss.labels('token').inc();

    // 2. Check negative cache (known invalid)
    const invalid = await redis.exists(`cache:token:invalid:${tokenHash}`);
    if (invalid) {
      return null;
    }

    // 3. Cache miss - query database
    const result = await db.query(`
      SELECT * FROM device_tokens
      WHERE token_hash = $1 AND is_valid = true
    `, [tokenHash]);

    if (result.rows.length === 0) {
      // Negative caching prevents repeated DB hits for bad tokens
      await redis.setex(`cache:token:invalid:${tokenHash}`, 300, '1');
      return null;
    }

    // 4. Populate cache
    const device = result.rows[0];
    await redis.setex(cacheKey, 3600, JSON.stringify(device));

    return device;
  }

  async invalidateToken(token: string, reason: string): Promise<void> {
    const tokenHash = sha256(token);

    // Database update
    await db.query(`
      UPDATE device_tokens
      SET is_valid = false, invalidated_at = NOW(), invalidation_reason = $2
      WHERE token_hash = $1
    `, [tokenHash, reason]);

    // Explicit cache invalidation
    await redis.del(`cache:token:${tokenHash}`);
    await redis.setex(`cache:token:invalid:${tokenHash}`, 3600, reason);

    await this.feedbackService.reportInvalidToken(token, reason);
  }
}
```

### TTL Configuration Matrix

| Cache Key Pattern | TTL | Rationale |
|-------------------|-----|-----------|
| `cache:token:{hash}` | 1 hour | Tokens stable, long TTL reduces DB load |
| `cache:token:invalid:{hash}` | 5-60 min | Prevents repeated failed lookups |
| `conn:{deviceId}` | 5 min | Connection server location, short for reconnects |
| `rate:device:{id}` | 1 min | Sliding window rate limiting |
| `rate:app:{bundleId}` | 1 min | Per-app rate limiting |
| `cache:idem:{notificationId}` | 24 hours | Idempotency window for retries |

### Write-Through for Connection State

Device connection state must be immediately consistent (no stale data):

```typescript
class PushService {
  async onDeviceConnect(deviceId: string, connection: WebSocket): Promise<void> {
    // Write-through: update Redis immediately
    await redis.setex(`conn:${deviceId}`, 300, JSON.stringify({
      serverId: this.serverId,
      connectedAt: Date.now()
    }));

    this.connections.set(deviceId, connection);
    await this.deliverPendingNotifications(deviceId, connection);
  }

  async onDeviceDisconnect(deviceId: string): Promise<void> {
    // Immediate invalidation
    await redis.del(`conn:${deviceId}`);
    this.connections.delete(deviceId);
  }
}
```

## Deep Dive: Store-and-Forward Queue (5 minutes)

### Queue Management for Offline Devices

```typescript
class StoreService {
  async storeForDelivery(notification: Notification): Promise<QueueResult> {
    const { expiration, priority, collapseId, deviceId } = notification;

    // Check if already expired
    if (expiration && expiration < Date.now()) {
      metrics.notificationExpired.inc();
      return { expired: true };
    }

    // Atomic insert/update with collapse semantics
    await db.query(`
      INSERT INTO pending_notifications
        (id, device_id, payload, priority, expiration, collapse_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (device_id, collapse_id)
      DO UPDATE SET payload = $3, priority = $4, created_at = NOW()
    `, [notification.id, deviceId, notification.payload,
        priority, expiration, collapseId]);

    metrics.notificationQueued.inc();
    return { queued: true };
  }

  async deliverPending(deviceId: string, connection: WebSocket): Promise<void> {
    // Fetch in priority order
    const pending = await db.query(`
      SELECT * FROM pending_notifications
      WHERE device_id = $1
      AND (expiration IS NULL OR expiration > NOW())
      ORDER BY priority DESC, created_at ASC
      LIMIT 100
    `, [deviceId]);

    for (const notification of pending.rows) {
      await connection.send(JSON.stringify(notification));
      await this.markDelivered(notification.id);
    }

    // Clean up after delivery
    await db.query(
      'DELETE FROM pending_notifications WHERE device_id = $1',
      [deviceId]
    );
  }

  // Background cleanup job
  async cleanupExpired(): Promise<void> {
    const result = await db.query(`
      DELETE FROM pending_notifications
      WHERE expiration IS NOT NULL AND expiration < NOW()
      RETURNING id
    `);

    logger.info({
      event: 'expired_cleanup',
      count: result.rowCount
    });
  }
}
```

### Priority Queue Semantics

| Priority | Value | Delivery Behavior |
|----------|-------|-------------------|
| Immediate | 10 | Wake device, deliver now |
| Background | 5 | Deliver during power nap |
| Low | 1 | Batch, deliver opportunistically |

## Deep Dive: Idempotency and Consistency (5 minutes)

### Multi-Layer Idempotency

```typescript
class NotificationService {
  async processNotification(
    token: string,
    payload: any,
    headers: APNsHeaders
  ): Promise<NotificationResult> {
    const notificationId = headers['apns-id'] || uuid();

    // Layer 1: Redis idempotency check
    const dedupKey = `cache:idem:${notificationId}`;
    const existing = await redis.get(dedupKey);
    if (existing) {
      metrics.duplicateDetected.inc();
      return JSON.parse(existing);
    }

    // Layer 2: Database UPSERT for delivery log
    const insertResult = await db.query(`
      INSERT INTO delivery_log (notification_id, device_id, status, created_at)
      VALUES ($1, $2, 'pending', NOW())
      ON CONFLICT (notification_id) DO NOTHING
      RETURNING notification_id
    `, [notificationId, device.device_id]);

    if (insertResult.rowCount === 0) {
      // Already processed - return existing status
      const existing = await db.query(
        'SELECT status FROM delivery_log WHERE notification_id = $1',
        [notificationId]
      );
      return { notificationId, status: existing.rows[0].status };
    }

    // Process notification
    const result = await this.deliverOrQueue(device, payload, headers);

    // Cache result for retry window
    await redis.setex(dedupKey, 86400, JSON.stringify(result));

    return result;
  }
}
```

### Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Token registration | Strong (PostgreSQL) | Must be immediately queryable |
| Notification delivery | At-least-once | Network failures require retry support |
| Pending queue | Last-write-wins (collapse) | Intentional replacement semantics |
| Delivery log | Eventual | Can lag actual delivery slightly |

## Deep Dive: Observability (5 minutes)

### Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Notification lifecycle
const notificationsSent = new Counter({
  name: 'apns_notifications_sent_total',
  help: 'Total notifications processed',
  labelNames: ['priority', 'status'],  // delivered, queued, expired, failed
});

const deliveryLatency = new Histogram({
  name: 'apns_notification_delivery_seconds',
  help: 'Time from receipt to delivery',
  labelNames: ['priority'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Connection management
const activeConnections = new Gauge({
  name: 'apns_active_device_connections',
  help: 'Number of active WebSocket connections',
});

const pendingNotifications = new Gauge({
  name: 'apns_pending_notifications',
  help: 'Notifications queued for offline devices',
});

// Cache efficiency
const cacheOperations = new Counter({
  name: 'apns_cache_operations_total',
  help: 'Cache operations',
  labelNames: ['cache', 'result'],  // token/connection, hit/miss
});

// Token registry
const tokenOperations = new Counter({
  name: 'apns_token_operations_total',
  help: 'Token registry operations',
  labelNames: ['operation'],  // register, invalidate, lookup
});
```

### Alert Thresholds

```yaml
groups:
  - name: apns-backend-alerts
    rules:
      # Delivery SLO breach
      - alert: DeliverySuccessRateLow
        expr: |
          sum(rate(apns_notifications_sent_total{status="delivered"}[5m])) /
          sum(rate(apns_notifications_sent_total[5m])) < 0.9999
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Delivery success rate below 99.99% SLO"

      # High-priority latency breach
      - alert: HighPriorityLatencyHigh
        expr: |
          histogram_quantile(0.99,
            rate(apns_notification_delivery_seconds_bucket{priority="10"}[5m])
          ) > 0.5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High-priority p99 latency exceeds 500ms"

      # Pending queue backlog
      - alert: PendingBacklogHigh
        expr: apns_pending_notifications > 100000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Pending notification backlog exceeds 100K"

      # Cache hit ratio degradation
      - alert: CacheHitRatioLow
        expr: |
          sum(rate(apns_cache_operations_total{result="hit"}[5m])) /
          sum(rate(apns_cache_operations_total[5m])) < 0.90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Token cache hit ratio below 90%"
```

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

// Notification delivery logging
function logDelivery(notification: Notification, result: DeliveryResult) {
  logger.info({
    event: 'notification_delivery',
    notification_id: notification.id,
    device_id: notification.deviceId,
    priority: notification.priority,
    status: result.status,
    latency_ms: Date.now() - notification.createdAt,
  });
}

// Audit logging for security events
function logTokenEvent(event: string, tokenHash: string, context: any) {
  logger.info({
    type: 'token_audit',
    event,  // 'registered', 'invalidated', 'lookup_failed'
    token_hash_prefix: tokenHash.substring(0, 8),
    app_bundle_id: context.appBundleId,
    actor: context.actor,
    reason: context.reason,
  });
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Backend Rationale |
|----------|--------|-------------|-------------------|
| Token storage | SHA-256 hash | Plaintext | Security: tokens useless if DB breached |
| Pending queue | PostgreSQL | Redis | Durability trumps speed for offline queue |
| Cache strategy | Cache-aside | Write-through | Simpler invalidation, acceptable latency |
| Collapse handling | DB UPSERT | Application logic | Atomic, conflict-free |
| Connection state | Redis write-through | Cache-aside | Must be immediately consistent |
| Idempotency window | 24 hours | Shorter | Balance memory vs retry protection |

## Future Backend Enhancements

1. **Horizontal Scaling**
   - Connection sharding by device ID hash
   - Read replicas for token lookups
   - Kafka for inter-shard routing

2. **Performance Optimization**
   - Connection pooling with PgBouncer
   - Redis Cluster for cache sharding
   - Batch inserts for high-throughput ingestion

3. **Reliability**
   - Multi-region active-active deployment
   - Circuit breakers for Redis failures
   - Graceful degradation when cache unavailable

4. **Observability**
   - Distributed tracing with OpenTelemetry
   - Log aggregation with ELK stack
   - Custom Grafana dashboards for SLI tracking
