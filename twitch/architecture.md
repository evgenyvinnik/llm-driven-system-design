# Design Twitch - Architecture

## System Overview

Twitch is a live streaming platform with real-time chat. Core challenges involve low-latency video delivery, chat at massive scale, and stream processing in real-time.

**Learning Goals:**
- Understand live video streaming protocols (RTMP, HLS)
- Design real-time chat systems at scale
- Handle stream transcoding pipelines
- Build subscription and monetization systems

---

## Requirements

### Functional Requirements

1. **Stream**: Broadcast live video to viewers
2. **Watch**: View streams with low latency
3. **Chat**: Real-time messaging during streams
4. **Subscribe**: Paid subscriptions to channels
5. **VOD**: Watch past broadcasts and clips

### Non-Functional Requirements

- **Latency**: < 5 seconds glass-to-glass (broadcast to viewer)
- **Scale**: 10M concurrent viewers, 100K concurrent streams
- **Chat**: 1M messages/minute during peak
- **Availability**: 99.99% for video delivery

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Broadcaster Layer                            │
│              OBS / Streamlabs (RTMP output)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ RTMP
┌─────────────────────────────────────────────────────────────────┐
│                    Ingest Layer                                 │
│    Multiple ingest servers globally (rtmp://ingest.twitch.tv)   │
│    - Authenticate stream key                                    │
│    - Forward to transcoder                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Transcoding Layer                              │
│    FFmpeg/MediaLive clusters                                    │
│    - Source → 1080p60, 720p60, 720p30, 480p, 360p               │
│    - Generate HLS segments (2-4 second chunks)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Origin Layer                                  │
│    - Store HLS manifests (.m3u8) and segments (.ts)             │
│    - Serve to CDN edge nodes                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CDN Edge Layer                              │
│    CloudFront / Fastly / Custom CDN                             │
│    - Cache segments at edge                                     │
│    - Serve to viewers globally                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Viewer Layer                                │
│    Browser (HLS.js) / Mobile / TV apps                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Stream Ingestion

**RTMP Server:**
```javascript
// Simplified RTMP server concept
const rtmpServer = new RTMPServer()

rtmpServer.on('connect', (session) => {
  const { streamKey } = session.connectCmdObj
  const channel = await validateStreamKey(streamKey)

  if (!channel) {
    session.reject()
    return
  }

  session.channelId = channel.id
  await notifyStreamStart(channel.id)
})

rtmpServer.on('publish', (session) => {
  // Forward to transcoder
  const transcoderUrl = assignTranscoder(session.channelId)
  session.pipe(transcoderUrl)
})
```

### 2. Transcoding

**FFmpeg Pipeline:**
```bash
# Transcode to multiple qualities
ffmpeg -i rtmp://input \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast -b:v 6000k -s 1920x1080 -f hls output_1080p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast -b:v 3000k -s 1280x720 -f hls output_720p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast -b:v 1500k -s 854x480 -f hls output_480p.m3u8
```

**HLS Manifest:**
```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480
480p/playlist.m3u8
```

### 3. Chat System

**Challenge**: Handle 100K+ concurrent users in a single chat room

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────┐
│                    Chat Service Cluster                         │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────┤
│  Chat Pod 1 │  Chat Pod 2 │  Chat Pod 3 │  Chat Pod N │   ...   │
│ (WS conns)  │ (WS conns)  │ (WS conns)  │ (WS conns)  │         │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Broker (Kafka/Valkey Pub/Sub)        │
│              channel:123 → all pods subscribed                  │
└─────────────────────────────────────────────────────────────────┘
```

**Message Flow:**
```javascript
// User sends message
async function handleChatMessage(userId, channelId, message) {
  // Validate user can chat (not banned, not slow mode limited)
  const canChat = await validateChat(userId, channelId)
  if (!canChat) return

  const chatMessage = {
    id: uuid(),
    userId,
    channelId,
    username: await getUsername(userId),
    message,
    badges: await getBadges(userId, channelId),
    timestamp: Date.now()
  }

  // Publish to all chat pods
  await redis.publish(`chat:${channelId}`, JSON.stringify(chatMessage))

  // Store for moderation/replay (optional)
  await storeChatMessage(chatMessage)
}

// Each pod receives and broadcasts to connected clients
redis.subscribe(`chat:${channelId}`)
redis.on('message', (channel, data) => {
  const message = JSON.parse(data)
  broadcastToRoom(channel, message)
})
```

### 4. VOD Recording

**Parallel Recording During Live:**
```javascript
// As transcoder outputs segments, also write to storage
async function handleSegment(channelId, segment) {
  // 1. Send to CDN for live viewers
  await cdn.uploadSegment(segment)

  // 2. Archive for VOD
  await s3.putObject({
    bucket: 'vods',
    key: `${channelId}/${streamId}/${segment.sequence}.ts`,
    body: segment.data
  })

  // 3. Update VOD manifest
  await updateVodManifest(channelId, streamId, segment)
}
```

---

## Database Schema

```sql
-- Channels
CREATE TABLE channels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  name VARCHAR(100) UNIQUE NOT NULL,
  stream_key VARCHAR(100) UNIQUE NOT NULL,
  title VARCHAR(200),
  category_id INTEGER REFERENCES categories(id),
  follower_count INTEGER DEFAULT 0,
  subscriber_count INTEGER DEFAULT 0,
  is_live BOOLEAN DEFAULT FALSE,
  current_viewers INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Streams (each broadcast)
CREATE TABLE streams (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id),
  title VARCHAR(200),
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  peak_viewers INTEGER DEFAULT 0,
  total_views INTEGER DEFAULT 0,
  vod_url VARCHAR(500)
);

-- Subscriptions
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  channel_id INTEGER REFERENCES channels(id),
  tier INTEGER DEFAULT 1, -- 1, 2, or 3
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  is_gift BOOLEAN DEFAULT FALSE,
  gifted_by INTEGER REFERENCES users(id)
);

-- Chat messages (for moderation, not primary storage)
CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Bans
CREATE TABLE channel_bans (
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  banned_by INTEGER REFERENCES users(id),
  reason TEXT,
  expires_at TIMESTAMP, -- NULL = permanent
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);
```

---

## Key Design Decisions

### 1. HLS over WebRTC

**Decision**: Use HLS for video delivery, not WebRTC

**Rationale**:
- WebRTC: Lower latency (~1s) but complex at scale
- HLS: Higher latency (~5s) but simple CDN distribution
- Trade-off: Accept 5s latency for simplicity

**When to use WebRTC**: Interactive streams (co-streaming, gaming)

### 2. Kafka for Chat Fan-Out

**Decision**: Pub/sub for chat message distribution

**Rationale**:
- Decouples message producers from consumers
- Horizontal scaling of chat pods
- Message ordering per channel

### 3. Segment-Based VOD

**Decision**: Store VOD as HLS segments during live

**Rationale**:
- No post-processing needed
- Instant VOD availability
- Same format for live and VOD

---

## Scalability Considerations

### Viewer Scaling

- CDN caches segments at edge
- No origin hit for popular streams
- Cache hit ratio > 99% for live streams

### Chat Scaling

- Partition chat pods by channel_id
- Large channels: Multiple pods per channel
- Rate limiting per user (1 message/second)

### Stream Processing

- Transcoder per stream (not shared)
- Horizontal scaling: Add transcoders as needed
- Stateless transcoders, state in message queue

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Video protocol | HLS | WebRTC | Scalability |
| Chat transport | WebSocket + Pub/Sub | HTTP polling | Low latency |
| VOD storage | Segment archive | Re-encode | Instant availability |
| Transcoding | Per-stream workers | Shared | Isolation |

---

## Consistency and Idempotency Semantics

### Write Consistency Models

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Stream key validation | Strong (PostgreSQL) | Must reject invalid keys immediately |
| Go live / offline status | Strong (PostgreSQL) | Viewers need accurate live state |
| Chat messages | Eventual (Redis pub/sub) | Slight delay acceptable; duplicates filtered client-side |
| Viewer counts | Eventual (Redis counter) | Approximate counts are acceptable |
| Subscriptions/payments | Strong (PostgreSQL with transactions) | Financial accuracy required |
| Follow/unfollow | Strong (PostgreSQL) | User expects immediate feedback |
| VOD segment writes | Eventual (S3/MinIO) | Segments processed in order by sequence number |

### Idempotency Keys

**Subscription Creation:**
```javascript
// Client generates idempotency key for payment operations
const idempotencyKey = `sub:${userId}:${channelId}:${Date.now()}`

// Server checks before processing
async function createSubscription(userId, channelId, tier, idempotencyKey) {
  // Check if already processed
  const existing = await redis.get(`idempotency:${idempotencyKey}`)
  if (existing) {
    return JSON.parse(existing) // Return cached result
  }

  // Process subscription in transaction
  const result = await db.transaction(async (tx) => {
    const sub = await tx.insert(subscriptions).values({
      user_id: userId,
      channel_id: channelId,
      tier: tier,
      started_at: new Date(),
      expires_at: addMonths(new Date(), 1)
    }).returning()
    return sub[0]
  })

  // Cache result with 24h TTL
  await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(result))
  return result
}
```

**Stream Start Event:**
```javascript
// Prevent duplicate "go live" events from RTMP reconnects
async function handleStreamConnect(channelId, streamKey) {
  const lockKey = `stream_lock:${channelId}`
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 10)

  if (!acquired) {
    // Another connection is being processed
    return { status: 'duplicate', action: 'reject' }
  }

  try {
    const channel = await db.query.channels.findFirst({
      where: eq(channels.stream_key, streamKey)
    })

    if (channel.is_live) {
      // Already live - this is a reconnect, not a new stream
      return { status: 'reconnect', streamId: channel.current_stream_id }
    }

    // New stream - create stream record
    const stream = await startNewStream(channelId)
    return { status: 'new', streamId: stream.id }
  } finally {
    await redis.del(lockKey)
  }
}
```

### Chat Message Deduplication

```javascript
// Client-side: Include message ID for dedup
const messageId = `${userId}:${Date.now()}:${Math.random().toString(36).slice(2)}`

// Server-side: Track recent message IDs in Redis set with TTL
async function processChatMessage(channelId, userId, messageId, content) {
  const dedupKey = `chat_dedup:${channelId}`

  // Check if already processed (SADD returns 0 if member exists)
  const isNew = await redis.sadd(dedupKey, messageId)
  if (!isNew) {
    return { status: 'duplicate', dropped: true }
  }

  // Set TTL on the set (5 minutes window)
  await redis.expire(dedupKey, 300)

  // Broadcast message
  await redis.publish(`chat:${channelId}`, JSON.stringify({
    id: messageId,
    userId,
    content,
    timestamp: Date.now()
  }))

  return { status: 'sent' }
}
```

### Conflict Resolution

**Concurrent Stream Updates (e.g., title change during live):**
```sql
-- Use optimistic locking with version column
ALTER TABLE channels ADD COLUMN version INTEGER DEFAULT 1;

-- Update only if version matches
UPDATE channels
SET title = $1, version = version + 1
WHERE id = $2 AND version = $3
RETURNING version;

-- If no rows returned, fetch current state and retry or notify user
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics for Local Development:**

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'twitch-api'
    static_configs:
      - targets: ['localhost:3001', 'localhost:3002', 'localhost:3003']

  - job_name: 'twitch-chat'
    static_configs:
      - targets: ['localhost:3010']

  - job_name: 'redis'
    static_configs:
      - targets: ['localhost:9121']  # redis_exporter
```

**Application Metrics (Express middleware):**
```javascript
import { Registry, Counter, Histogram, Gauge } from 'prom-client'

const register = new Registry()

// HTTP request metrics
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
})

// Business metrics
const activeStreams = new Gauge({
  name: 'twitch_active_streams',
  help: 'Number of currently live streams'
})

const chatMessagesTotal = new Counter({
  name: 'twitch_chat_messages_total',
  help: 'Total chat messages processed',
  labelNames: ['channel_id']
})

const wsConnections = new Gauge({
  name: 'twitch_websocket_connections',
  help: 'Active WebSocket connections',
  labelNames: ['server_instance']
})

const viewerCount = new Gauge({
  name: 'twitch_viewer_count',
  help: 'Total viewers across all streams'
})

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})
```

### Structured Logging

```javascript
import pino from 'pino'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'twitch-api',
    instance: process.env.INSTANCE_ID || 'local'
  }
})

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_id: req.session?.userId,
      trace_id: req.headers['x-trace-id']
    }, 'request completed')
  })
  next()
})

// Business event logging
function logStreamEvent(eventType, channelId, metadata = {}) {
  logger.info({
    event_type: eventType,
    channel_id: channelId,
    ...metadata
  }, `stream ${eventType}`)
}

// Usage
logStreamEvent('go_live', 123, { title: 'Gaming Stream', category: 'Fortnite' })
logStreamEvent('end_stream', 123, { duration_minutes: 120, peak_viewers: 450 })
```

### Distributed Tracing (OpenTelemetry)

```javascript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { JaegerExporter } from '@opentelemetry/exporter-jaeger'
import { trace } from '@opentelemetry/api'

// Setup (in instrumentation.ts, loaded before app)
const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(
  new JaegerExporter({ endpoint: 'http://localhost:14268/api/traces' })
))
provider.register()

const tracer = trace.getTracer('twitch-api')

// Trace chat message flow
async function handleChatMessage(channelId, userId, message) {
  const span = tracer.startSpan('chat.process_message')
  span.setAttributes({
    'chat.channel_id': channelId,
    'chat.user_id': userId,
    'chat.message_length': message.length
  })

  try {
    // Validate
    const validateSpan = tracer.startSpan('chat.validate', { parent: span })
    const canChat = await validateChat(userId, channelId)
    validateSpan.end()

    if (!canChat) {
      span.setStatus({ code: SpanStatusCode.OK, message: 'rate limited' })
      return
    }

    // Publish
    const publishSpan = tracer.startSpan('chat.publish_redis', { parent: span })
    await redis.publish(`chat:${channelId}`, JSON.stringify({ userId, message }))
    publishSpan.end()

    span.setStatus({ code: SpanStatusCode.OK })
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    throw error
  } finally {
    span.end()
  }
}
```

### SLI Dashboards (Grafana)

**Dashboard Panels for Local Development:**

```json
{
  "panels": [
    {
      "title": "API Request Latency (p95)",
      "type": "graph",
      "targets": [{
        "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"
      }]
    },
    {
      "title": "Active Streams",
      "type": "stat",
      "targets": [{
        "expr": "twitch_active_streams"
      }]
    },
    {
      "title": "Chat Messages/sec",
      "type": "graph",
      "targets": [{
        "expr": "rate(twitch_chat_messages_total[1m])"
      }]
    },
    {
      "title": "WebSocket Connections",
      "type": "graph",
      "targets": [{
        "expr": "sum(twitch_websocket_connections)"
      }]
    },
    {
      "title": "Error Rate",
      "type": "graph",
      "targets": [{
        "expr": "sum(rate(http_request_duration_seconds_count{status_code=~\"5..\"}[5m])) / sum(rate(http_request_duration_seconds_count[5m]))"
      }]
    }
  ]
}
```

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High API Latency | p95 > 500ms for 5 min | Warning | Check database queries |
| Error Rate Spike | 5xx rate > 1% for 2 min | Critical | Check logs, rollback if needed |
| Redis Connection Lost | Connection down > 30s | Critical | Chat will fail; restart Redis |
| No Active Streams | 0 streams for 10 min (during expected hours) | Warning | Check ingest service |
| WebSocket Saturation | Connections > 80% limit | Warning | Scale chat pods |
| Database Pool Exhausted | Available connections < 5 | Critical | Increase pool or find leaks |

**Alertmanager Config (for local testing):**
```yaml
# alertmanager.yml
route:
  receiver: 'console'
  group_wait: 30s

receivers:
  - name: 'console'
    webhook_configs:
      - url: 'http://localhost:3099/alerts'  # Local webhook for testing
```

### Audit Logging

```javascript
// Audit log for security-sensitive operations
const auditLogger = pino({
  level: 'info',
  base: { type: 'audit' }
}).child({
  destination: pino.destination('./logs/audit.log')
})

// Audit events
function audit(action, actor, resource, details = {}) {
  auditLogger.info({
    action,
    actor_id: actor.userId,
    actor_ip: actor.ip,
    resource_type: resource.type,
    resource_id: resource.id,
    details,
    timestamp: new Date().toISOString()
  })
}

// Usage examples
audit('stream_key.regenerate', { userId: 123, ip: req.ip }, { type: 'channel', id: 456 })
audit('user.ban', { userId: 123, ip: req.ip }, { type: 'user', id: 789 }, { reason: 'spam', channel_id: 456 })
audit('subscription.create', { userId: 123, ip: req.ip }, { type: 'subscription', id: 101 }, { tier: 1, channel_id: 456 })
audit('admin.login', { userId: 1, ip: req.ip }, { type: 'session', id: 'sess123' })
```

---

## Failure Handling

### Retry Strategy with Idempotency

```javascript
// Generic retry wrapper with exponential backoff
async function withRetry(operation, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    idempotencyKey = null,
    retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']
  } = options

  // Check if already completed (for idempotent operations)
  if (idempotencyKey) {
    const cached = await redis.get(`retry:${idempotencyKey}`)
    if (cached) return JSON.parse(cached)
  }

  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation()

      // Cache successful result for idempotent operations
      if (idempotencyKey) {
        await redis.setex(`retry:${idempotencyKey}`, 3600, JSON.stringify(result))
      }

      return result
    } catch (error) {
      lastError = error

      // Don't retry non-retryable errors
      if (!retryableErrors.includes(error.code) && !error.retryable) {
        throw error
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
        const jitter = delay * 0.1 * Math.random()
        await sleep(delay + jitter)

        logger.warn({
          attempt: attempt + 1,
          max_retries: maxRetries,
          error: error.message,
          next_delay_ms: delay
        }, 'retrying operation')
      }
    }
  }

  throw lastError
}

// Usage: Retry VOD segment upload
await withRetry(
  () => s3.putObject({ bucket: 'vods', key: segmentKey, body: segmentData }),
  { idempotencyKey: `segment:${streamId}:${sequence}`, maxRetries: 5 }
)
```

### Circuit Breaker

```javascript
// Simple circuit breaker implementation
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeoutMs = options.resetTimeoutMs || 30000
    this.state = 'CLOSED'  // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.lastFailureTime = null
  }

  async call(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN'
        logger.info({ circuit: this.name }, 'circuit breaker half-open, testing')
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`)
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED'
      logger.info({ circuit: this.name }, 'circuit breaker closed')
    }
  }

  onFailure() {
    this.failures++
    this.lastFailureTime = Date.now()

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      logger.error({ circuit: this.name, failures: this.failures }, 'circuit breaker opened')
    }
  }
}

// Circuit breakers for external dependencies
const circuitBreakers = {
  database: new CircuitBreaker('database', { failureThreshold: 3, resetTimeoutMs: 10000 }),
  redis: new CircuitBreaker('redis', { failureThreshold: 5, resetTimeoutMs: 5000 }),
  s3: new CircuitBreaker('s3', { failureThreshold: 5, resetTimeoutMs: 30000 })
}

// Usage
async function getChannel(channelId) {
  return circuitBreakers.database.call(async () => {
    return db.query.channels.findFirst({ where: eq(channels.id, channelId) })
  })
}
```

### Graceful Degradation

```javascript
// Fallback strategies when services are unavailable

// Chat: Fall back to local broadcast if Redis is down
async function broadcastChatMessage(channelId, message) {
  try {
    await circuitBreakers.redis.call(() =>
      redis.publish(`chat:${channelId}`, JSON.stringify(message))
    )
  } catch (error) {
    logger.warn({ channel_id: channelId }, 'Redis unavailable, using local broadcast only')
    // Only broadcast to local WebSocket connections
    localBroadcast(channelId, message)
  }
}

// Viewer count: Use cached value if Redis is down
async function getViewerCount(channelId) {
  try {
    return await circuitBreakers.redis.call(() =>
      redis.get(`viewers:${channelId}`)
    )
  } catch (error) {
    // Return last known value from local cache
    return localViewerCache.get(channelId) || 0
  }
}

// VOD: Queue for retry if S3 upload fails
async function uploadVodSegment(streamId, sequence, data) {
  try {
    await circuitBreakers.s3.call(() =>
      s3.putObject({ bucket: 'vods', key: `${streamId}/${sequence}.ts`, body: data })
    )
  } catch (error) {
    // Write to local disk and queue for retry
    await fs.writeFile(`/tmp/vod-queue/${streamId}-${sequence}.ts`, data)
    await db.insert(vod_upload_queue).values({
      stream_id: streamId,
      sequence,
      local_path: `/tmp/vod-queue/${streamId}-${sequence}.ts`,
      created_at: new Date()
    })
    logger.warn({ stream_id: streamId, sequence }, 'VOD segment queued for retry')
  }
}
```

### Local Development DR Simulation

For learning purposes, simulate disaster recovery scenarios:

```javascript
// scripts/chaos.js - Simulate failures for testing
import { program } from 'commander'

program
  .command('kill-redis')
  .description('Stop Redis to test chat fallback')
  .action(async () => {
    await exec('docker-compose stop redis')
    console.log('Redis stopped. Chat should fall back to local-only mode.')
    console.log('Run "docker-compose start redis" to restore.')
  })

program
  .command('slow-db')
  .description('Add latency to database queries')
  .action(async () => {
    // Uses pg_sleep in a middleware
    process.env.DB_ARTIFICIAL_DELAY_MS = '500'
    console.log('Database queries will have 500ms artificial delay.')
  })

program
  .command('fill-disk')
  .description('Simulate disk full for VOD storage')
  .action(async () => {
    // Create a large temp file in the VOD directory
    await exec('dd if=/dev/zero of=/tmp/vod-queue/filler bs=1M count=100')
    console.log('Added 100MB filler file. VOD uploads may fail.')
  })

program.parse()
```

### Backup and Restore Testing

**Database Backup (for local development):**

```bash
#!/bin/bash
# scripts/backup.sh

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# PostgreSQL backup
docker-compose exec -T postgres pg_dump -U postgres twitch > "$BACKUP_DIR/twitch_$TIMESTAMP.sql"
echo "Database backed up to $BACKUP_DIR/twitch_$TIMESTAMP.sql"

# Redis backup (if persistence enabled)
docker-compose exec redis redis-cli BGSAVE
sleep 2
docker cp twitch-redis:/data/dump.rdb "$BACKUP_DIR/redis_$TIMESTAMP.rdb"
echo "Redis backed up to $BACKUP_DIR/redis_$TIMESTAMP.rdb"

# MinIO/S3 backup (VOD segments)
docker-compose exec minio mc mirror /data/vods "$BACKUP_DIR/vods_$TIMESTAMP"
echo "VOD segments backed up"
```

**Restore Script:**

```bash
#!/bin/bash
# scripts/restore.sh

BACKUP_FILE=$1

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: ./restore.sh <backup_file.sql>"
  exit 1
fi

# Drop and recreate database
docker-compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS twitch"
docker-compose exec -T postgres psql -U postgres -c "CREATE DATABASE twitch"

# Restore
docker-compose exec -T postgres psql -U postgres twitch < "$BACKUP_FILE"
echo "Database restored from $BACKUP_FILE"
```

**Backup Verification Test:**

```javascript
// tests/backup-restore.test.js
import { describe, it, beforeAll, afterAll } from 'vitest'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

describe('Backup and Restore', () => {
  let backupFile

  it('should create a backup', async () => {
    const { stdout } = await execAsync('./scripts/backup.sh')
    expect(stdout).toContain('Database backed up')

    // Extract backup filename from output
    const match = stdout.match(/twitch_\d+_\d+\.sql/)
    backupFile = `./backups/${match[0]}`
  })

  it('should restore from backup', async () => {
    // Insert test data
    await db.insert(channels).values({ name: 'test_channel', stream_key: 'test123' })

    // Restore (should remove test data)
    await execAsync(`./scripts/restore.sh ${backupFile}`)

    // Verify test data is gone
    const channel = await db.query.channels.findFirst({
      where: eq(channels.name, 'test_channel')
    })
    expect(channel).toBeUndefined()
  })
})
```

### Health Checks

```javascript
// Comprehensive health check endpoint
app.get('/health', async (req, res) => {
  const checks = {
    postgres: { status: 'unknown', latency_ms: null },
    redis: { status: 'unknown', latency_ms: null },
    s3: { status: 'unknown', latency_ms: null }
  }

  // PostgreSQL
  try {
    const start = Date.now()
    await db.execute(sql`SELECT 1`)
    checks.postgres = { status: 'healthy', latency_ms: Date.now() - start }
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: error.message }
  }

  // Redis
  try {
    const start = Date.now()
    await redis.ping()
    checks.redis = { status: 'healthy', latency_ms: Date.now() - start }
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: error.message }
  }

  // S3/MinIO
  try {
    const start = Date.now()
    await s3.headBucket({ Bucket: 'vods' })
    checks.s3 = { status: 'healthy', latency_ms: Date.now() - start }
  } catch (error) {
    checks.s3 = { status: 'unhealthy', error: error.message }
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy')
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString()
  })
})

// Liveness probe (just checks process is running)
app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' })
})

// Readiness probe (checks if ready to serve traffic)
app.get('/health/ready', async (req, res) => {
  try {
    await db.execute(sql`SELECT 1`)
    await redis.ping()
    res.json({ status: 'ready' })
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message })
  }
})
```

---

## Implementation Notes

This section documents the key implementation decisions and explains WHY each pattern was chosen for the Twitch streaming platform.

### WHY Idempotency Prevents Duplicate Chat Messages

**Problem**: In a high-traffic live chat system, network instability and client retries can cause the same message to be submitted multiple times. Without deduplication:
- Users see duplicate messages cluttering the chat
- Database storage is wasted on repeated content
- Message ordering becomes confusing
- Moderators may take action on what appears to be spam

**Implementation**:
```javascript
// Each message includes a client-generated unique ID
const messageId = `${userId}:${Date.now()}:${randomSuffix}`;

// Server tracks recent message IDs in a Redis set with 5-minute TTL
const isNew = await redis.sAdd(`chat_dedup:${channelId}`, messageId);
if (!isNew) {
  // Silently drop duplicate - client may have retried
  return;
}
```

**Why Redis Sets?**
- O(1) membership checks for high throughput
- Automatic TTL cleanup prevents unbounded memory growth
- Shared across all chat server instances
- Fail-open design: if Redis is unavailable, allow the message through (users tolerate occasional duplicates better than lost messages)

**Trade-off**: We chose server-side deduplication over client-side because:
- Clients may be malicious or buggy
- Server has authoritative view of what was processed
- Centralized dedup works across all server instances

### WHY Subscription Idempotency Prevents Double Charging

**Problem**: Payment operations are critical and retries are common due to network timeouts. Without idempotency:
- Users could be charged twice for the same subscription
- Financial reconciliation becomes a nightmare
- Refund processing creates customer support burden
- Trust in the platform is damaged

**Implementation**:
```javascript
// Client includes idempotency key in header
// Idempotency-Key: sub:userId:channelId:timestamp

// Server checks before processing payment
const { isDuplicate, cachedResult } = await checkSubscriptionIdempotency(redis, key);
if (isDuplicate) {
  return cachedResult; // Return same response as original request
}

// Process subscription with transaction
await withRetry(async () => {
  const client = await getClient();
  await client.query('BEGIN');
  // ... create subscription, update counts ...
  await client.query('COMMIT');
}, { maxRetries: 3 });

// Cache result for 24 hours
await storeSubscriptionResult(redis, key, result);
```

**Why 24-hour TTL?**
- Long enough to handle delayed retries from payment processors
- Short enough to not bloat Redis memory indefinitely
- Aligns with typical payment processor retry windows

### WHY Circuit Breakers Protect Live Streaming Infrastructure

**Problem**: Live streaming is a real-time experience where cascading failures can destroy user experience:
- If Redis fails, all chat servers keep retrying, creating thundering herd
- Database connection pool exhaustion affects all users, not just the failing feature
- Transcoding service overload can cause stream drops
- Without protection, one failing component takes down the entire platform

**Implementation**:
```javascript
// Circuit breaker for Redis chat publishing
const redisChatBreaker = createCircuitBreaker('redis-chat-publish', publishFn, {
  timeout: 1000,              // Fast fail for real-time chat
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 5000,         // Try again after 5 seconds
  volumeThreshold: 10         // Need 10 requests to calculate failure rate
});

// Fallback to local-only broadcast when Redis is unavailable
redisChatBreaker.fallback((channel, message) => {
  localBroadcast(channelId, message);
  return { fallback: true };
});
```

**Why These Specific Thresholds?**
- **1000ms timeout**: Chat must feel instant; waiting longer frustrates users
- **50% threshold**: Aggressive because chat is critical but not life-safety
- **5s reset**: Fast recovery for transient issues; Redis usually recovers quickly
- **Fallback to local**: Graceful degradation keeps chat working within single instances

**Critical for Live Streaming Because**:
- Viewers expect real-time interaction during live events
- A 30-second outage during a major stream can cause massive user churn
- Streamers depend on the platform for income; reliability is paramount

### WHY Stream Start Uses Distributed Locks

**Problem**: RTMP connections are unstable; streamers may reconnect multiple times:
- OBS crashes and auto-reconnects
- Network hiccups cause brief disconnections
- Multiple connection attempts arrive simultaneously

Without locking:
- Multiple "go live" events are broadcast to followers
- Duplicate stream records are created in database
- Viewer counts are fragmented across multiple "streams"

**Implementation**:
```javascript
async function startStream(channelId, title, categoryId) {
  // Acquire lock to prevent duplicate go-live events
  const { acquired } = await acquireStreamLock(redis, channelId);
  if (!acquired) {
    // Check if already live (reconnect scenario)
    if (channel.is_live) {
      return { reconnect: true };
    }
    throw new Error('Failed to acquire stream lock');
  }

  try {
    // Create stream record and update channel
    await query('UPDATE channels SET is_live = TRUE ...');
    await query('INSERT INTO streams ...');
  } finally {
    await releaseStreamLock(redis, channelId);
  }
}
```

**Why Redis SET NX with TTL?**
- Atomic operation prevents race conditions
- TTL ensures locks don't persist forever if process crashes
- 10-second TTL is long enough for the operation but short enough for recovery

### WHY Moderation Audit Logging Enables Appeal Handling

**Problem**: Moderation actions affect real people and their income:
- Banned streamers lose revenue
- Viewers may be unfairly timed out
- Moderators may abuse their power
- Legal compliance requires action history

Without audit logging:
- Appeals are "he said, she said" with no evidence
- Patterns of abuse go undetected
- Compliance audits cannot be satisfied
- Trust and Safety team is blind

**Implementation**:
```javascript
function logUserBan(actor, targetUserId, targetUsername, channelId, reason, expiresAt) {
  auditLogger.info({
    action: 'ban_user',
    actor: { user_id: actor.userId, username: actor.username, ip: actor.ip },
    target: { type: 'user', id: targetUserId },
    channel_id: channelId,
    reason,
    metadata: {
      target_username: targetUsername,
      is_permanent: !expiresAt,
      expires_at: expiresAt
    },
    timestamp: new Date().toISOString()
  });
}
```

**What We Log**:
- **Who**: Actor user ID, username, and IP address
- **What**: Action type (ban, unban, timeout, delete, etc.)
- **Whom**: Target user or message ID
- **Where**: Channel ID where action occurred
- **Why**: Reason provided by moderator
- **When**: ISO timestamp for timezone-agnostic sorting

**Why Separate Logger?**
- Audit logs may have different retention policies (7 years for legal)
- Should be append-only and tamper-evident in production
- Can be shipped to different storage (SIEM, compliance system)
- Metrics can track moderation action rates per channel

### WHY Viewer Metrics Enable Stream Quality Optimization

**Problem**: Without metrics, platform operators are flying blind:
- Cannot detect when streams have quality issues
- Cannot optimize CDN routing
- Cannot identify popular content for recommendations
- Cannot measure SLA compliance

**Implementation**:
```javascript
// Prometheus metrics exposed at /metrics
const totalViewers = new Gauge({
  name: 'twitch_total_viewers',
  help: 'Total viewers across all live streams'
});

const activeStreams = new Gauge({
  name: 'twitch_active_streams',
  help: 'Number of currently live streams'
});

const chatMessagesTotal = new Counter({
  name: 'twitch_chat_messages_total',
  help: 'Total chat messages processed',
  labelNames: ['channel_id']
});

// Updated periodically by stream simulator
setInterval(async () => {
  const result = await query('SELECT current_viewers FROM channels WHERE is_live = TRUE');
  let total = 0;
  for (const channel of result.rows) {
    total += channel.current_viewers;
  }
  setTotalViewers(total);
  setActiveStreams(result.rows.length);
}, 30000);
```

**Key Metrics and Their Purpose**:

| Metric | Purpose |
|--------|---------|
| `twitch_active_streams` | Capacity planning, detect stream drop events |
| `twitch_total_viewers` | Platform health, trending analysis |
| `twitch_chat_messages_total` | Rate limiting tuning, spam detection |
| `twitch_websocket_connections` | Server scaling decisions |
| `twitch_circuit_breaker_state` | Dependency health monitoring |
| `twitch_moderation_actions_total` | Community health, moderator activity |

**Why Prometheus?**
- Pull-based model works well with dynamic scaling
- Rich query language (PromQL) for dashboards
- Standard format understood by Grafana, AlertManager
- Low overhead for high-cardinality metrics

### Implementation File Summary

| File | Purpose |
|------|---------|
| `src/utils/logger.js` | Structured JSON logging with pino, request correlation |
| `src/utils/metrics.js` | Prometheus metrics collection and exposition |
| `src/utils/circuitBreaker.js` | Opossum-based circuit breaker with fallbacks |
| `src/utils/retry.js` | Exponential backoff with jitter |
| `src/utils/idempotency.js` | Chat dedup, subscription idempotency, stream locks |
| `src/utils/audit.js` | Tamper-evident logging for moderation actions |
| `src/utils/health.js` | Comprehensive health check endpoints |
| `src/routes/moderation.js` | Ban/unban, message deletion, moderator management |

### Endpoints Added

| Endpoint | Purpose |
|----------|---------|
| `GET /metrics` | Prometheus metrics scraping |
| `GET /health` | Detailed health with dependency status |
| `GET /health/live` | Kubernetes liveness probe |
| `GET /health/ready` | Kubernetes readiness probe |
| `POST /api/moderation/:channelId/ban` | Ban user with audit logging |
| `DELETE /api/moderation/:channelId/ban/:userId` | Unban user with audit logging |
| `DELETE /api/moderation/:channelId/message/:messageId` | Delete message with audit logging |
| `POST /api/moderation/:channelId/clear` | Clear chat with audit logging |
| `POST /api/moderation/:channelId/moderator` | Add moderator with audit logging |
| `DELETE /api/moderation/:channelId/moderator/:userId` | Remove moderator with audit logging |

### NPM Packages Added

- `pino`: High-performance JSON logger
- `pino-http`: HTTP request logging middleware
- `prom-client`: Prometheus metrics client
- `opossum`: Circuit breaker implementation
