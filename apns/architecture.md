# Design APNs - Architecture

## System Overview

APNs is Apple's push notification service for iOS, macOS, and other Apple platforms. Core challenges involve reliable delivery, connection management, and scale.

**Learning Goals:**
- Build push notification infrastructure
- Design connection pooling at scale
- Implement store-and-forward delivery
- Handle device token lifecycle

---

## Requirements

### Functional Requirements

1. **Push**: Deliver notifications to devices
2. **Register**: Manage device tokens
3. **Topics**: Subscribe to notification topics
4. **Feedback**: Report undeliverable tokens
5. **Priority**: Handle urgent vs background notifications

### Non-Functional Requirements

- **Latency**: < 500ms for high-priority notifications
- **Scale**: 50B+ notifications per day
- **Reliability**: 99.99% delivery to online devices
- **Efficiency**: Minimal battery impact on devices

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Provider Layer                              │
│              App Servers sending notifications                  │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTP/2
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    APNs Gateway                                 │
│         (Auth, Rate Limiting, Connection Management)           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Routing Layer                                 │
│          (Topic resolution, Device lookup, Sharding)           │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Push Service │    │ Store Service │    │Token Registry │
│               │    │               │    │               │
│ - Delivery    │    │ - Queue       │    │ - Tokens      │
│ - Connections │    │ - Retry       │    │ - Invalidation│
│ - QoS         │    │ - Expiry      │    │ - Topics      │
└───────────────┘    └───────────────┘    └───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Device Layer                               │
│               Persistent connections to all devices             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Provider API (HTTP/2)

**Receiving Notifications from App Servers:**
```javascript
const http2 = require('http2')

class APNsGateway {
  constructor() {
    this.server = http2.createSecureServer({
      key: fs.readFileSync('server.key'),
      cert: fs.readFileSync('server.crt'),
      allowHTTP1: false
    })

    this.server.on('stream', (stream, headers) => {
      this.handleRequest(stream, headers)
    })
  }

  async handleRequest(stream, headers) {
    const method = headers[':method']
    const path = headers[':path']

    // POST /3/device/{device_token}
    if (method === 'POST' && path.startsWith('/3/device/')) {
      const deviceToken = path.split('/')[3]

      // Validate JWT
      const authHeader = headers['authorization']
      const validAuth = await this.validateJWT(authHeader)
      if (!validAuth) {
        stream.respond({ ':status': 403 })
        stream.end(JSON.stringify({ reason: 'InvalidProviderToken' }))
        return
      }

      // Read notification payload
      let payload = ''
      stream.on('data', chunk => payload += chunk)
      stream.on('end', async () => {
        try {
          const notification = JSON.parse(payload)

          // Validate payload
          if (!this.validatePayload(notification, headers)) {
            stream.respond({ ':status': 400 })
            stream.end(JSON.stringify({ reason: 'BadPayload' }))
            return
          }

          // Queue for delivery
          const result = await this.queueNotification(
            deviceToken,
            notification,
            headers
          )

          stream.respond({
            ':status': 200,
            'apns-id': result.notificationId
          })
          stream.end()

        } catch (error) {
          stream.respond({ ':status': 500 })
          stream.end(JSON.stringify({ reason: 'InternalServerError' }))
        }
      })
    }
  }

  async queueNotification(deviceToken, notification, headers) {
    const notificationId = headers['apns-id'] || uuid()
    const priority = headers['apns-priority'] || 10
    const expiration = headers['apns-expiration'] || 0
    const topic = headers['apns-topic']
    const collapseId = headers['apns-collapse-id']

    // Look up device
    const device = await this.tokenRegistry.lookup(deviceToken)
    if (!device) {
      throw new Error('Unregistered')
    }

    // Create notification record
    const notificationRecord = {
      id: notificationId,
      deviceToken,
      deviceId: device.id,
      payload: notification,
      priority,
      expiration: expiration > 0 ? new Date(expiration * 1000) : null,
      topic,
      collapseId,
      createdAt: Date.now()
    }

    // Route to appropriate push service
    const shardId = this.getShardForDevice(device.id)
    await this.routeToShard(shardId, notificationRecord)

    return { notificationId }
  }
}
```

### 2. Device Token Management

**Token Lifecycle:**
```javascript
class TokenRegistry {
  async registerToken(token, deviceInfo) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    // Check if token already exists
    const existing = await db.query(`
      SELECT * FROM device_tokens WHERE token_hash = $1
    `, [tokenHash])

    if (existing.rows.length > 0) {
      // Update last seen
      await db.query(`
        UPDATE device_tokens SET last_seen = NOW(), device_info = $2
        WHERE token_hash = $1
      `, [tokenHash, deviceInfo])

      return { deviceId: existing.rows[0].device_id, isNew: false }
    }

    // Create new token
    const deviceId = uuid()
    await db.query(`
      INSERT INTO device_tokens (device_id, token_hash, app_bundle_id, device_info, created_at, last_seen)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
    `, [deviceId, tokenHash, deviceInfo.bundleId, deviceInfo])

    return { deviceId, isNew: true }
  }

  async invalidateToken(token, reason) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    await db.query(`
      UPDATE device_tokens
      SET is_valid = false, invalidated_at = NOW(), invalidation_reason = $2
      WHERE token_hash = $1
    `, [tokenHash, reason])

    // Notify feedback service
    await this.feedbackService.reportInvalidToken(token, reason)
  }

  async lookup(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const result = await db.query(`
      SELECT * FROM device_tokens
      WHERE token_hash = $1 AND is_valid = true
    `, [tokenHash])

    if (result.rows.length === 0) {
      return null
    }

    return result.rows[0]
  }

  // Topic subscriptions
  async subscribeToTopic(deviceToken, topic) {
    const device = await this.lookup(deviceToken)
    if (!device) throw new Error('Invalid token')

    await db.query(`
      INSERT INTO topic_subscriptions (device_id, topic)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [device.device_id, topic])
  }

  async getDevicesForTopic(topic) {
    return db.query(`
      SELECT dt.* FROM device_tokens dt
      JOIN topic_subscriptions ts ON dt.device_id = ts.device_id
      WHERE ts.topic = $1 AND dt.is_valid = true
    `, [topic])
  }
}
```

### 3. Push Delivery Service

**Delivery to Devices:**
```javascript
class PushService {
  constructor(shardId) {
    this.shardId = shardId
    this.connections = new Map() // deviceId -> connection
    this.pendingQueue = new PriorityQueue() // For offline devices
  }

  async deliverNotification(notification) {
    const { deviceId, payload, priority, collapseId } = notification

    // Check if device is connected
    const connection = this.connections.get(deviceId)

    if (connection && connection.isAlive()) {
      // Immediate delivery
      return this.pushToDevice(connection, notification)
    }

    // Device offline - store for later
    return this.storeForDelivery(notification)
  }

  async pushToDevice(connection, notification) {
    const { id, payload, priority, collapseId } = notification

    // Handle collapse (replace previous notification with same ID)
    if (collapseId) {
      await this.collapseNotification(connection.deviceId, collapseId)
    }

    try {
      await connection.send({
        type: 'notification',
        id,
        payload,
        priority
      })

      // Mark as delivered
      await this.markDelivered(id)

      return { delivered: true }
    } catch (error) {
      // Connection failed, store for retry
      await this.storeForDelivery(notification)
      return { delivered: false, queued: true }
    }
  }

  async storeForDelivery(notification) {
    const { expiration, priority, collapseId } = notification

    // Check expiration
    if (expiration && expiration < Date.now()) {
      return { expired: true }
    }

    // Store in queue with priority
    await db.query(`
      INSERT INTO pending_notifications
        (id, device_id, payload, priority, expiration, collapse_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (device_id, collapse_id)
      DO UPDATE SET payload = $3, priority = $4, created_at = NOW()
    `, [notification.id, notification.deviceId, notification.payload,
        priority, expiration, collapseId])

    return { queued: true }
  }

  // Called when device connects
  async onDeviceConnect(deviceId, connection) {
    this.connections.set(deviceId, connection)

    // Deliver pending notifications
    const pending = await db.query(`
      SELECT * FROM pending_notifications
      WHERE device_id = $1
      AND (expiration IS NULL OR expiration > NOW())
      ORDER BY priority DESC, created_at ASC
    `, [deviceId])

    for (const notification of pending.rows) {
      await this.pushToDevice(connection, notification)
    }

    // Clean up delivered
    await db.query(`
      DELETE FROM pending_notifications WHERE device_id = $1
    `, [deviceId])
  }

  // Connection management
  handleConnection(socket, deviceId) {
    const connection = new DeviceConnection(socket, deviceId)

    connection.on('close', () => {
      this.connections.delete(deviceId)
    })

    connection.on('ack', (notificationId) => {
      this.markDelivered(notificationId)
    })

    this.onDeviceConnect(deviceId, connection)
  }
}
```

### 4. Feedback Service

**Reporting Invalid Tokens:**
```javascript
class FeedbackService {
  async reportInvalidToken(token, reason) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    // Get app info for the token
    const tokenInfo = await db.query(`
      SELECT app_bundle_id, invalidated_at FROM device_tokens
      WHERE token_hash = $1
    `, [tokenHash])

    if (tokenInfo.rows.length === 0) return

    const { app_bundle_id, invalidated_at } = tokenInfo.rows[0]

    // Store in feedback queue for providers
    await db.query(`
      INSERT INTO feedback_queue (token_hash, app_bundle_id, reason, timestamp)
      VALUES ($1, $2, $3, $4)
    `, [tokenHash, app_bundle_id, reason, invalidated_at])
  }

  // Provider polls for feedback
  async getFeedback(appBundleId, since) {
    const feedback = await db.query(`
      SELECT token_hash, reason, timestamp FROM feedback_queue
      WHERE app_bundle_id = $1 AND timestamp > $2
      ORDER BY timestamp ASC
      LIMIT 1000
    `, [appBundleId, since])

    return feedback.rows
  }
}
```

### 5. Quality of Service

**Priority and Rate Limiting:**
```javascript
class QoSManager {
  constructor() {
    // Priority 10: Immediate delivery (user-facing)
    // Priority 5: Background updates (power nap)
    // Priority 1: Low priority (can be delayed)
    this.priorityQueues = {
      10: new PriorityQueue(),
      5: new PriorityQueue(),
      1: new PriorityQueue()
    }
  }

  async enqueue(notification) {
    const priority = notification.priority || 10
    const queue = this.priorityQueues[priority]

    queue.enqueue(notification, notification.createdAt)

    // Rate limit per device
    const deviceRateKey = `rate:device:${notification.deviceId}`
    const deviceRate = await redis.incr(deviceRateKey)
    if (deviceRate === 1) {
      await redis.expire(deviceRateKey, 60) // 1 minute window
    }

    if (deviceRate > 100) {
      // Too many notifications to this device
      throw new Error('TooManyRequestsToDevice')
    }
  }

  async dequeue() {
    // Process high priority first
    for (const priority of [10, 5, 1]) {
      const queue = this.priorityQueues[priority]
      if (!queue.isEmpty()) {
        return queue.dequeue()
      }
    }
    return null
  }

  shouldDeliverNow(notification) {
    // Priority 10: Always deliver immediately
    if (notification.priority === 10) return true

    // Priority 5: Deliver if device is awake or will wake soon
    if (notification.priority === 5) {
      return this.isDeviceAwake(notification.deviceId)
    }

    // Priority 1: Batch and deliver during power nap
    return false
  }
}
```

---

## Database Schema

```sql
-- Device Tokens
CREATE TABLE device_tokens (
  device_id UUID PRIMARY KEY,
  token_hash VARCHAR(64) UNIQUE NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  device_info JSONB,
  is_valid BOOLEAN DEFAULT TRUE,
  invalidated_at TIMESTAMP,
  invalidation_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tokens_app ON device_tokens(app_bundle_id);
CREATE INDEX idx_tokens_valid ON device_tokens(is_valid) WHERE is_valid = true;

-- Topic Subscriptions
CREATE TABLE topic_subscriptions (
  device_id UUID REFERENCES device_tokens(device_id),
  topic VARCHAR(200) NOT NULL,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, topic)
);

CREATE INDEX idx_subscriptions_topic ON topic_subscriptions(topic);

-- Pending Notifications (for offline devices)
CREATE TABLE pending_notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id),
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, collapse_id)
);

CREATE INDEX idx_pending_device ON pending_notifications(device_id);
CREATE INDEX idx_pending_expiration ON pending_notifications(expiration);

-- Delivery Log
CREATE TABLE delivery_log (
  notification_id UUID PRIMARY KEY,
  device_id UUID,
  status VARCHAR(20) NOT NULL,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Feedback Queue
CREATE TABLE feedback_queue (
  id BIGSERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  reason VARCHAR(50),
  timestamp TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_feedback_app ON feedback_queue(app_bundle_id, timestamp);
```

---

## Key Design Decisions

### 1. HTTP/2 for Provider API

**Decision**: Use HTTP/2 multiplexed connections

**Rationale**:
- Single connection per provider
- Multiplexed streams
- Binary protocol efficiency
- Header compression

### 2. Store-and-Forward

**Decision**: Queue notifications for offline devices

**Rationale**:
- Guarantee delivery when device comes online
- Handle intermittent connectivity
- Support expiration policies

### 3. Collapse IDs

**Decision**: Replace old notifications with same collapse ID

**Rationale**:
- Reduce notification spam
- Show only latest update
- Save device resources

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Provider protocol | HTTP/2 | WebSocket | Standard, tooling |
| Device connection | Long-lived TCP | Polling | Latency, efficiency |
| Storage | Store-and-forward | Drop if offline | Delivery guarantee |
| Token storage | Hashed | Plain | Security |

---

## Consistency and Idempotency Semantics

### Write Consistency Model

**Token Registration: Strong Consistency**
- Device token registration uses PostgreSQL with `ON CONFLICT` upserts
- Each registration is idempotent: re-registering the same token updates `last_seen` rather than creating duplicates
- The `token_hash` UNIQUE constraint ensures no duplicate tokens exist

**Notification Delivery: Eventually Consistent with At-Least-Once Semantics**
- Notifications may be delivered more than once (device reconnects mid-delivery, network failures)
- Clients must handle duplicate notifications using the `notification_id`
- The delivery log records final status but may lag the actual delivery

**Pending Notifications: Last-Write-Wins with Collapse**
- When using `collapse_id`, newer notifications replace older ones via `ON CONFLICT DO UPDATE`
- Without `collapse_id`, each notification is independent
- Expiration is checked at delivery time, not queue time

### Idempotency Keys

**Provider-Supplied Notification IDs:**
```javascript
// In APNsGateway.queueNotification()
const notificationId = headers['apns-id'] || uuid()

// Idempotent insert pattern
await db.query(`
  INSERT INTO delivery_log (notification_id, device_id, status, created_at)
  VALUES ($1, $2, 'queued', NOW())
  ON CONFLICT (notification_id) DO NOTHING
`, [notificationId, device.device_id])
```

Providers can supply their own `apns-id` header. If they retry the same notification:
1. The delivery_log entry already exists (conflict)
2. We skip the insert and return the existing notification status
3. The notification is not re-queued

**Replay Handling:**
```javascript
class DeduplicationService {
  // Redis-based deduplication window (24 hours)
  async checkAndMark(notificationId) {
    const key = `dedup:${notificationId}`
    const exists = await redis.set(key, '1', 'NX', 'EX', 86400)
    return exists === null // true = duplicate
  }
}
```

For local development, a 24-hour deduplication window is sufficient. Providers retrying failed requests within this window receive the original response.

### Conflict Resolution

**Token Conflicts:**
- Same token, different app: Rejected (token tied to single app)
- Same token, same app: Update device_info and last_seen
- Token invalidation during send: Notification fails with `Unregistered` error

**Pending Notification Conflicts:**
```sql
-- collapse_id causes replacement, not duplication
INSERT INTO pending_notifications (id, device_id, payload, priority, collapse_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (device_id, collapse_id)
DO UPDATE SET payload = $3, priority = $4, created_at = NOW()
```

When two notifications with the same collapse_id arrive:
1. The second overwrites the first
2. Only the latest payload is stored
3. Original notification_id is lost (intentional for "replace" semantics)

---

## Caching Strategy

### Cache Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Provider API Request                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Redis (Valkey) - L1 Cache                       │
│  - Device token lookups                                      │
│  - Connection server mappings                                │
│  - Rate limit counters                                       │
└─────────────────────────────────────────────────────────────┘
                              │ cache miss
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL                                │
│  - Source of truth for tokens                                │
│  - Pending notifications                                     │
│  - Delivery logs                                             │
└─────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern for Token Lookups

Token lookups are read-heavy and latency-sensitive. We use cache-aside with lazy loading:

```javascript
class TokenRegistry {
  async lookup(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const cacheKey = `token:${tokenHash}`

    // 1. Check cache first
    const cached = await redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // 2. Cache miss - query database
    const result = await db.query(`
      SELECT * FROM device_tokens
      WHERE token_hash = $1 AND is_valid = true
    `, [tokenHash])

    if (result.rows.length === 0) {
      // Cache negative result to prevent repeated DB hits
      await redis.setex(`token:${tokenHash}:invalid`, 300, '1')
      return null
    }

    // 3. Populate cache
    const device = result.rows[0]
    await redis.setex(cacheKey, 3600, JSON.stringify(device)) // 1 hour TTL

    return device
  }

  async invalidateToken(token, reason) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    // Invalidate in database
    await db.query(`
      UPDATE device_tokens
      SET is_valid = false, invalidated_at = NOW(), invalidation_reason = $2
      WHERE token_hash = $1
    `, [tokenHash, reason])

    // Explicit cache invalidation
    await redis.del(`token:${tokenHash}`)
    await redis.setex(`token:${tokenHash}:invalid`, 3600, reason)

    await this.feedbackService.reportInvalidToken(token, reason)
  }
}
```

### TTL Configuration

| Cache Key Pattern | TTL | Rationale |
|-------------------|-----|-----------|
| `token:{hash}` | 1 hour | Device tokens are stable; 1-hour TTL balances freshness vs DB load |
| `token:{hash}:invalid` | 1 hour | Prevents repeated lookups for known-bad tokens |
| `conn:{deviceId}` | 5 minutes | Connection server location; short TTL handles reconnects |
| `rate:device:{id}` | 1 minute | Sliding window for per-device rate limiting |
| `rate:app:{bundleId}` | 1 minute | Sliding window for per-app rate limiting |
| `dedup:{notificationId}` | 24 hours | Idempotency window for notification retries |

### Write-Through for Connection State

Device connection state uses write-through caching because it must be immediately consistent:

```javascript
class PushService {
  async onDeviceConnect(deviceId, connection) {
    // Write-through: update Redis immediately
    await redis.setex(`conn:${deviceId}`, 300, JSON.stringify({
      serverId: this.serverId,
      connectedAt: Date.now()
    }))

    this.connections.set(deviceId, connection)
    await this.deliverPendingNotifications(deviceId, connection)
  }

  async onDeviceDisconnect(deviceId) {
    // Immediate invalidation
    await redis.del(`conn:${deviceId}`)
    this.connections.delete(deviceId)
  }
}
```

### Cache Invalidation Rules

1. **Token changes**: Invalidate on registration update or token invalidation
2. **Connection changes**: Write-through on connect, delete on disconnect
3. **Rate limits**: TTL-based expiration only (no manual invalidation)
4. **Deduplication**: TTL-based expiration only

### Local Development Notes

For local development with a single Redis instance:

```bash
# Start Valkey/Redis
docker-compose up -d valkey

# Monitor cache activity
redis-cli monitor

# Check cache hit ratio (approximate)
redis-cli INFO stats | grep keyspace
```

---

## Observability

### Metrics

Expose Prometheus metrics on `/metrics` endpoint:

```javascript
const promClient = require('prom-client')

// Request metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'apns_http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
})

// Notification metrics
const notificationsSent = new promClient.Counter({
  name: 'apns_notifications_sent_total',
  help: 'Total notifications sent',
  labelNames: ['priority', 'status'] // status: delivered, queued, expired, failed
})

const notificationDeliveryLatency = new promClient.Histogram({
  name: 'apns_notification_delivery_seconds',
  help: 'Time from notification receipt to delivery',
  labelNames: ['priority'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
})

// Queue metrics
const pendingNotificationsGauge = new promClient.Gauge({
  name: 'apns_pending_notifications',
  help: 'Number of pending notifications for offline devices'
})

// Connection metrics
const activeConnections = new promClient.Gauge({
  name: 'apns_active_device_connections',
  help: 'Number of active device connections'
})

// Token metrics
const tokenOperations = new promClient.Counter({
  name: 'apns_token_operations_total',
  help: 'Token registry operations',
  labelNames: ['operation'] // register, invalidate, lookup_hit, lookup_miss
})

// Cache metrics
const cacheHits = new promClient.Counter({
  name: 'apns_cache_hits_total',
  help: 'Cache hits',
  labelNames: ['cache'] // token, connection
})

const cacheMisses = new promClient.Counter({
  name: 'apns_cache_misses_total',
  help: 'Cache misses',
  labelNames: ['cache']
})
```

### Structured Logging

Use JSON-formatted logs for easy parsing:

```javascript
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
})

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    logger.info({
      type: 'http_request',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      request_id: req.headers['x-request-id']
    })
  })
  next()
})

// Notification delivery logging
async function logDelivery(notification, result) {
  logger.info({
    type: 'notification_delivery',
    notification_id: notification.id,
    device_id: notification.deviceId,
    priority: notification.priority,
    status: result.delivered ? 'delivered' : (result.queued ? 'queued' : 'failed'),
    latency_ms: Date.now() - notification.createdAt
  })
}

// Error logging with context
function logError(error, context) {
  logger.error({
    type: 'error',
    error: error.message,
    stack: error.stack,
    ...context
  })
}
```

### Distributed Tracing

Add trace context propagation for request flows:

```javascript
const { trace, context, propagation } = require('@opentelemetry/api')

const tracer = trace.getTracer('apns-service')

// Trace notification delivery
async function deliverWithTracing(notification) {
  const span = tracer.startSpan('deliver_notification', {
    attributes: {
      'notification.id': notification.id,
      'notification.priority': notification.priority,
      'device.id': notification.deviceId
    }
  })

  try {
    const result = await pushService.deliverNotification(notification)
    span.setAttributes({
      'notification.status': result.delivered ? 'delivered' : 'queued'
    })
    return result
  } catch (error) {
    span.recordException(error)
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  } finally {
    span.end()
  }
}
```

### SLI Dashboard (Grafana)

Key panels for a local Grafana dashboard:

**Delivery SLIs:**
```promql
# Delivery success rate (target: 99.99%)
sum(rate(apns_notifications_sent_total{status="delivered"}[5m])) /
sum(rate(apns_notifications_sent_total[5m]))

# High-priority delivery latency p99 (target: < 500ms)
histogram_quantile(0.99,
  rate(apns_notification_delivery_seconds_bucket{priority="10"}[5m])
)

# Notification throughput
sum(rate(apns_notifications_sent_total[1m])) * 60
```

**Infrastructure Health:**
```promql
# Active device connections
apns_active_device_connections

# Pending notification backlog
apns_pending_notifications

# Cache hit ratio
sum(rate(apns_cache_hits_total[5m])) /
(sum(rate(apns_cache_hits_total[5m])) + sum(rate(apns_cache_misses_total[5m])))

# Token lookup latency p95
histogram_quantile(0.95, rate(apns_http_request_duration_seconds_bucket{route="/lookup"}[5m]))
```

### Alert Thresholds

Configure alerts in Prometheus alerting rules:

```yaml
groups:
  - name: apns-alerts
    rules:
      # Delivery success rate dropping
      - alert: DeliverySuccessRateLow
        expr: |
          sum(rate(apns_notifications_sent_total{status="delivered"}[5m])) /
          sum(rate(apns_notifications_sent_total[5m])) < 0.99
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Notification delivery success rate below 99%"

      # High-priority latency SLO breach
      - alert: HighPriorityLatencyHigh
        expr: |
          histogram_quantile(0.99, rate(apns_notification_delivery_seconds_bucket{priority="10"}[5m])) > 0.5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High-priority notification p99 latency exceeds 500ms"

      # Pending notification backlog growing
      - alert: PendingBacklogHigh
        expr: apns_pending_notifications > 10000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Pending notification backlog exceeds 10,000"

      # Cache hit ratio low
      - alert: CacheHitRatioLow
        expr: |
          sum(rate(apns_cache_hits_total{cache="token"}[5m])) /
          (sum(rate(apns_cache_hits_total{cache="token"}[5m])) + sum(rate(apns_cache_misses_total{cache="token"}[5m]))) < 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Token cache hit ratio below 80%"

      # No active connections (local dev: expect at least 1 test device)
      - alert: NoActiveConnections
        expr: apns_active_device_connections == 0
        for: 5m
        labels:
          severity: info
        annotations:
          summary: "No active device connections"
```

### Audit Logging

Security-relevant events are logged to a separate audit log:

```javascript
const auditLogger = pino({
  level: 'info'
}, pino.destination('./logs/audit.log'))

// Token lifecycle events
function auditTokenEvent(event, tokenHash, context) {
  auditLogger.info({
    type: 'token_audit',
    event,  // 'registered', 'invalidated', 'lookup_failed'
    token_hash_prefix: tokenHash.substring(0, 8),
    app_bundle_id: context.appBundleId,
    timestamp: new Date().toISOString(),
    actor: context.actor,  // 'provider', 'system', 'admin'
    reason: context.reason
  })
}

// Provider authentication events
function auditAuthEvent(event, providerId, context) {
  auditLogger.info({
    type: 'auth_audit',
    event,  // 'auth_success', 'auth_failure', 'token_expired'
    provider_id: providerId,
    ip_address: context.ip,
    timestamp: new Date().toISOString(),
    user_agent: context.userAgent
  })
}

// Admin operations
function auditAdminEvent(event, adminId, context) {
  auditLogger.info({
    type: 'admin_audit',
    event,  // 'bulk_invalidate', 'view_feedback', 'rate_limit_change'
    admin_id: adminId,
    timestamp: new Date().toISOString(),
    details: context.details
  })
}
```

### Local Development Setup

Add to `docker-compose.yml` for local observability stack:

```yaml
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  grafana-data:
```

Prometheus scrape config (`prometheus.yml`):

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'apns'
    static_configs:
      - targets: ['host.docker.internal:3000']  # API server
```

---

## Implementation Notes

This section documents the implementation of observability, caching, and resilience patterns in the APNs backend. Each change is explained with the WHY behind the design decision.

### Prometheus Metrics (`src/shared/metrics.ts`)

**Why Prometheus Metrics?**

Metrics are essential for operating a push notification service at scale. Without metrics, we cannot:
- Know if notifications are being delivered successfully (SLI: delivery success rate)
- Track latency distribution (SLI: 99% of high-priority notifications < 500ms)
- Detect anomalies before they become outages (alert on error rate spikes)
- Make capacity planning decisions (understand load patterns)

**Key Metrics Implemented:**

| Metric | Type | Purpose |
|--------|------|---------|
| `apns_notifications_sent_total` | Counter | Track notification throughput by priority and status |
| `apns_notification_delivery_seconds` | Histogram | Measure delivery latency distribution |
| `apns_active_device_connections` | Gauge | Monitor WebSocket connection count |
| `apns_cache_operations_total` | Counter | Track cache hit/miss ratio for tuning TTLs |
| `apns_circuit_breaker_state` | Gauge | Expose circuit breaker health (0=closed, 1=open, 2=half-open) |
| `apns_dependency_health` | Gauge | Track database and Redis connectivity |

**Endpoint:** `GET /metrics` returns Prometheus-formatted metrics for scraping.

### Structured Logging with Pino (`src/shared/logger.ts`)

**Why Structured Logging?**

Console.log statements are inadequate for production systems because:
- They cannot be efficiently parsed by log aggregation systems
- They lack consistent structure for filtering and querying
- They mix different severity levels without distinction
- They don't support correlation across distributed systems

**Pino Advantages:**
- JSON output enables integration with ELK, Datadog, Splunk
- Log levels (trace, debug, info, warn, error, fatal) for appropriate verbosity
- Low overhead: pino is 5x faster than winston
- Request correlation via `x-request-id` header propagation

**Logging Categories:**

1. **HTTP Request Logging** (`httpLogger`): Automatic request/response logging with timing
2. **Application Events** (`logger`): Business logic events with structured context
3. **Audit Logging** (`auditLogger`): Security-relevant events for compliance
   - Token registration/invalidation
   - Authentication attempts
   - Admin operations

### Redis Caching for Device Tokens (`src/shared/cache.ts`)

**Why Cache Device Tokens?**

Token lookups are in the critical path for every notification:
1. Provider sends notification to device token
2. System must look up device ID from token hash
3. Without caching: every notification = 1 database query

**Impact:**
- At 10,000 notifications/second, that's 10,000 DB queries/second just for lookups
- With 95% cache hit rate, we reduce DB load to 500 queries/second (20x reduction)

**Cache-Aside Pattern:**

```
1. Check Redis cache for token
2. If hit: return cached data (< 1ms)
3. If miss: query PostgreSQL, cache result, return
```

**TTL Strategy:**

| Key Pattern | TTL | Rationale |
|-------------|-----|-----------|
| `cache:token:{hash}` | 1 hour | Tokens rarely change, long TTL reduces DB load |
| `cache:token:invalid:{hash}` | 5 min | Negative caching prevents repeated failed lookups |
| `cache:idem:{id}` | 24 hours | Idempotency window for duplicate detection |

**Invalidation:**
- On token registration update: invalidate cache immediately
- On token invalidation: remove from cache, add to negative cache
- This ensures consistency: no stale positive lookups for invalidated tokens

### Circuit Breaker for APNs Connections (`src/shared/circuitBreaker.ts`)

**Why Circuit Breakers?**

Without circuit breakers, a failing dependency causes cascading failures:
1. Redis goes down
2. All notification deliveries timeout waiting for Redis
3. Thread pool exhausted, server becomes unresponsive
4. Health checks fail, load balancer removes server
5. Remaining servers get overloaded, cascade continues

**Circuit Breaker Pattern:**

```
CLOSED (normal) -> errors exceed threshold -> OPEN (fail-fast)
     ^                                              |
     |                                              v
     +-------- success rate recovers <---- HALF-OPEN (testing)
```

**Implementation:**

Using [Opossum](https://github.com/nodeshift/opossum) circuit breaker library:
- `redis_pubsub` circuit: Protects cross-server notification routing
- Per-device WebSocket circuits: Protects against problematic device connections

**Configuration:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `timeout` | 5s | Generous timeout for network operations |
| `errorThresholdPercentage` | 50% | Open circuit when half of requests fail |
| `resetTimeout` | 15-30s | Time before testing if service recovered |
| `volumeThreshold` | 5-10 | Minimum requests before calculating error rate |

**Fallback Behavior:**
When Redis pub/sub circuit opens, notifications are stored for later delivery rather than failing immediately.

### Idempotency for Push Delivery (`src/services/pushService.ts`)

**Why Idempotency?**

Providers retry failed requests. Without idempotency:
1. Provider sends notification with ID `abc123`
2. Network timeout before response received
3. Provider retries same request
4. Without idempotency: user gets 2 notifications
5. With idempotency: duplicate detected, original status returned

**Implementation:**

1. Provider includes `apns-id` header (optional UUID)
2. If provided, check Redis: `cache:idem:{id}`
3. If exists: return existing notification status (duplicate)
4. If not exists: set key with 24-hour TTL, process notification
5. Mark as processed after successful creation

**Redis Key Pattern:**
```
SET cache:idem:{notification_id} "1" EX 86400 NX
```
- `NX`: Only set if not exists (atomic check-and-set)
- `EX 86400`: 24-hour expiration (reasonable retry window)

**Trade-offs:**
- 24-hour window balances memory usage vs. retry protection
- Provider must include `apns-id` to enable idempotency
- Without `apns-id`, each request is treated as unique

### Health Check Enhancements (`GET /health`)

**Why Enhanced Health Checks?**

Basic health checks only report "healthy" or "unhealthy". Enhanced checks:
- Report individual dependency status (database, Redis)
- Update Prometheus metrics for alerting
- Enable graceful degradation (Redis down but DB up = partial service)

**Response Format:**
```json
{
  "status": "healthy",
  "server_id": "server-3000",
  "services": {
    "database": "connected",
    "redis": "connected"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Metrics Updated:**
- `apns_dependency_health{dependency="database"}` = 1 (healthy) or 0 (unhealthy)
- `apns_dependency_health{dependency="redis"}` = 1 or 0

### Files Added/Modified

**New Files:**
- `src/shared/logger.ts` - Structured logging with pino
- `src/shared/metrics.ts` - Prometheus metrics collection
- `src/shared/cache.ts` - Redis caching with cache-aside pattern
- `src/shared/circuitBreaker.ts` - Circuit breaker pattern implementation
- `src/shared/index.ts` - Barrel export for shared modules

**Modified Files:**
- `src/index.ts` - Added metrics endpoint, structured logging, metrics instrumentation
- `src/services/tokenRegistry.ts` - Added caching for token lookups
- `src/services/pushService.ts` - Added idempotency, metrics, structured logging
- `package.json` - Added dependencies: prom-client, pino, pino-http, opossum

### Testing the Implementation

1. **Metrics:**
   ```bash
   curl http://localhost:3000/metrics
   # Returns Prometheus-formatted metrics
   ```

2. **Health Check:**
   ```bash
   curl http://localhost:3000/health
   # Returns JSON with dependency status
   ```

3. **Idempotency:**
   ```bash
   # First request
   curl -X POST http://localhost:3000/3/device/abc... \
     -H "apns-id: test-123" \
     -H "Content-Type: application/json" \
     -d '{"aps":{"alert":"Hello"}}'

   # Retry with same apns-id returns same notification_id
   curl -X POST http://localhost:3000/3/device/abc... \
     -H "apns-id: test-123" \
     -H "Content-Type: application/json" \
     -d '{"aps":{"alert":"Hello"}}'
   ```

4. **Logs (JSON format):**
   ```bash
   npm run dev
   # Logs are JSON: {"level":"info","event":"server_started","port":3000,...}
   ```
