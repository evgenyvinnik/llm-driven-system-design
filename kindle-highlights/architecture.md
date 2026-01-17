# Design Kindle Community Highlights - Architecture

## System Overview

A social reading platform enabling users to highlight passages, sync across devices, and discover popular community highlights. Core challenges involve real-time synchronization, large-scale aggregation, and privacy-preserving social features.

**Learning Goals:**
- Build real-time sync across devices
- Design aggregation at scale
- Implement privacy-preserving social features
- Handle offline-first architecture

---

## Requirements

### Functional Requirements

1. **Highlight**: Create, edit, delete highlights in books
2. **Sync**: Real-time sync across all user devices
3. **Discover**: View popular highlights in books
4. **Social**: Follow readers, share highlights
5. **Export**: Export personal highlights

### Non-Functional Requirements

- **Sync Latency**: < 2 seconds cross-device
- **Scale**: 10M users, 1B highlights
- **Read Load**: 100k highlights viewed/second
- **Privacy**: Community highlights are anonymized

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Devices                               │
│      Kindle | iOS App | Android App | Web Reader                 │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Local DB     │  │  Sync Engine  │  │  UI Layer     │       │
│  │  (SQLite)     │  │  (WebSocket)  │  │               │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Gateway                                  │
│              (Authentication, Rate Limiting)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Sync Service │    │  Highlight    │    │  Aggregation  │
│               │    │  Service      │    │  Service      │
│ - WebSocket   │    │               │    │               │
│ - Push sync   │    │ - CRUD ops    │    │ - Popular     │
│ - Conflict    │    │ - Search      │    │   highlights  │
│   resolution  │    │ - Export      │    │ - Trending    │
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PostgreSQL   │    │    Redis      │    │ Elasticsearch │
│               │    │               │    │               │
│ - Highlights  │    │ - Presence    │    │ - Search      │
│ - Users       │    │ - Sync state  │    │ - Full text   │
│ - Books       │    │ - Counters    │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. Highlight Service

**Highlight Management:**
```javascript
class HighlightService {
  async createHighlight(userId, highlight) {
    const { bookId, locationStart, locationEnd, text, note, color } = highlight

    // Generate highlight ID
    const highlightId = uuid()

    // Store highlight
    await db.query(`
      INSERT INTO highlights
        (id, user_id, book_id, location_start, location_end,
         highlighted_text, note, color, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [highlightId, userId, bookId, locationStart, locationEnd, text, note, color])

    // Update aggregation counters
    await this.aggregationService.incrementHighlightCount(bookId, locationStart, locationEnd)

    // Push to sync service for other devices
    await this.syncService.pushHighlight(userId, {
      action: 'create',
      highlight: { id: highlightId, ...highlight }
    })

    // Index for search
    await this.searchIndex.indexHighlight({
      id: highlightId,
      userId,
      bookId,
      text,
      note,
      createdAt: new Date()
    })

    return { id: highlightId, ...highlight }
  }

  async getUserHighlights(userId, options = {}) {
    const { bookId, search, limit = 50, offset = 0 } = options

    let query = `
      SELECT
        h.*,
        b.title as book_title,
        b.author as book_author
      FROM highlights h
      JOIN books b ON b.id = h.book_id
      WHERE h.user_id = $1
    `
    const params = [userId]
    let paramIndex = 2

    if (bookId) {
      query += ` AND h.book_id = $${paramIndex++}`
      params.push(bookId)
    }

    if (search) {
      query += ` AND (h.highlighted_text ILIKE $${paramIndex} OR h.note ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }

    query += ` ORDER BY h.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`
    params.push(limit, offset)

    const results = await db.query(query, params)
    return results.rows
  }

  async exportHighlights(userId, format = 'markdown') {
    const highlights = await this.getUserHighlights(userId, { limit: 10000 })

    // Group by book
    const byBook = {}
    for (const h of highlights) {
      if (!byBook[h.book_id]) {
        byBook[h.book_id] = {
          title: h.book_title,
          author: h.book_author,
          highlights: []
        }
      }
      byBook[h.book_id].highlights.push(h)
    }

    if (format === 'markdown') {
      return this.formatAsMarkdown(byBook)
    } else if (format === 'csv') {
      return this.formatAsCSV(highlights)
    }
  }

  formatAsMarkdown(byBook) {
    let md = '# My Highlights\n\n'

    for (const bookId in byBook) {
      const book = byBook[bookId]
      md += `## ${book.title}\n`
      md += `*by ${book.author}*\n\n`

      for (const h of book.highlights) {
        md += `> ${h.highlighted_text}\n\n`
        if (h.note) {
          md += `*Note: ${h.note}*\n\n`
        }
        md += `---\n\n`
      }
    }

    return md
  }
}
```

### 2. Real-time Sync Service

**Cross-Device Synchronization:**
```javascript
class SyncService {
  constructor() {
    this.connections = new Map() // userId -> [WebSocket]
  }

  handleConnection(ws, userId, deviceId) {
    // Register device connection
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Map())
    }
    this.connections.get(userId).set(deviceId, ws)

    // Store device sync state in Redis
    redis.hset(`sync:${userId}`, deviceId, JSON.stringify({
      connectedAt: Date.now(),
      lastSync: null
    }))

    ws.on('message', (data) => this.handleMessage(userId, deviceId, data))
    ws.on('close', () => this.handleDisconnect(userId, deviceId))

    // Send any pending syncs
    this.sendPendingHighlights(userId, deviceId)
  }

  async handleMessage(userId, deviceId, data) {
    const message = JSON.parse(data)

    switch (message.type) {
      case 'sync_request':
        await this.handleSyncRequest(userId, deviceId, message)
        break

      case 'highlight_create':
        await this.handleHighlightCreate(userId, deviceId, message)
        break

      case 'highlight_update':
        await this.handleHighlightUpdate(userId, deviceId, message)
        break

      case 'highlight_delete':
        await this.handleHighlightDelete(userId, deviceId, message)
        break
    }
  }

  async pushHighlight(userId, event) {
    const devices = this.connections.get(userId)
    if (!devices) return

    // Push to all connected devices
    const message = JSON.stringify({
      type: 'highlight_sync',
      event
    })

    for (const [deviceId, ws] of devices) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      } else {
        // Queue for later
        await this.queueForDevice(userId, deviceId, event)
      }
    }
  }

  async handleSyncRequest(userId, deviceId, message) {
    const { lastSyncTimestamp } = message

    // Get all highlights modified since last sync
    const highlights = await db.query(`
      SELECT * FROM highlights
      WHERE user_id = $1 AND updated_at > $2
      ORDER BY updated_at
    `, [userId, new Date(lastSyncTimestamp)])

    // Get deleted highlights
    const deleted = await db.query(`
      SELECT highlight_id, deleted_at FROM deleted_highlights
      WHERE user_id = $1 AND deleted_at > $2
    `, [userId, new Date(lastSyncTimestamp)])

    const ws = this.connections.get(userId)?.get(deviceId)
    if (ws) {
      ws.send(JSON.stringify({
        type: 'sync_response',
        highlights: highlights.rows,
        deleted: deleted.rows.map(d => d.highlight_id),
        serverTime: Date.now()
      }))
    }
  }

  async queueForDevice(userId, deviceId, event) {
    await redis.rpush(
      `sync:queue:${userId}:${deviceId}`,
      JSON.stringify(event)
    )
    // Expire queue after 30 days
    await redis.expire(`sync:queue:${userId}:${deviceId}`, 30 * 24 * 3600)
  }
}
```

### 3. Aggregation Service

**Popular Highlights:**
```javascript
class AggregationService {
  async incrementHighlightCount(bookId, locationStart, locationEnd) {
    // Normalize location to a passage ID
    const passageId = this.normalizePassage(bookId, locationStart, locationEnd)

    // Increment counter in Redis
    await redis.hincrby(`book:${bookId}:highlights`, passageId, 1)

    // Update PostgreSQL periodically (batch job)
    await this.queueAggregationUpdate(bookId, passageId)
  }

  normalizePassage(bookId, start, end) {
    // Round to nearest paragraph or fixed-size window
    // This groups similar highlights together
    const windowSize = 100 // characters
    const normalizedStart = Math.floor(start / windowSize) * windowSize
    const normalizedEnd = Math.ceil(end / windowSize) * windowSize

    return `${normalizedStart}-${normalizedEnd}`
  }

  async getPopularHighlights(bookId, options = {}) {
    const { limit = 10, minCount = 5 } = options

    // Check cache first
    const cacheKey = `popular:${bookId}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // Query aggregated data
    const popular = await db.query(`
      SELECT
        passage_id,
        passage_text,
        highlight_count,
        location_start,
        location_end
      FROM popular_highlights
      WHERE book_id = $1 AND highlight_count >= $2
      ORDER BY highlight_count DESC
      LIMIT $3
    `, [bookId, minCount, limit])

    const result = popular.rows

    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(result))

    return result
  }

  async runAggregationJob() {
    // Batch job to sync Redis counters to PostgreSQL
    const books = await redis.keys('book:*:highlights')

    for (const key of books) {
      const bookId = key.split(':')[1]
      const passages = await redis.hgetall(key)

      for (const [passageId, count] of Object.entries(passages)) {
        // Get sample text for the passage
        const sample = await this.getPassageSample(bookId, passageId)

        await db.query(`
          INSERT INTO popular_highlights
            (book_id, passage_id, passage_text, highlight_count, location_start, location_end)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (book_id, passage_id) DO UPDATE SET
            highlight_count = $4,
            updated_at = NOW()
        `, [bookId, passageId, sample.text, parseInt(count), sample.start, sample.end])
      }
    }
  }

  async getPassageSample(bookId, passageId) {
    // Get one highlight as sample text
    const [start, end] = passageId.split('-').map(Number)

    const sample = await db.query(`
      SELECT highlighted_text, location_start, location_end
      FROM highlights
      WHERE book_id = $1
        AND location_start >= $2
        AND location_end <= $3
      LIMIT 1
    `, [bookId, start, end])

    if (sample.rows[0]) {
      return {
        text: sample.rows[0].highlighted_text,
        start: sample.rows[0].location_start,
        end: sample.rows[0].location_end
      }
    }

    return { text: '', start, end }
  }
}
```

### 4. Social Features

**Following and Sharing:**
```javascript
class SocialService {
  async followUser(followerId, followeeId) {
    // Check if followee allows followers
    const settings = await this.getPrivacySettings(followeeId)
    if (!settings.allowFollowers) {
      throw new Error('User does not accept followers')
    }

    await db.query(`
      INSERT INTO follows (follower_id, followee_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT DO NOTHING
    `, [followerId, followeeId])
  }

  async getFriendsHighlights(userId, bookId) {
    // Get highlights from people I follow who have public/friends highlights
    const highlights = await db.query(`
      SELECT
        h.id,
        h.highlighted_text,
        h.note,
        h.location_start,
        h.created_at,
        u.username,
        u.avatar_url
      FROM highlights h
      JOIN follows f ON f.followee_id = h.user_id
      JOIN users u ON u.id = h.user_id
      JOIN user_privacy_settings ups ON ups.user_id = h.user_id
      WHERE f.follower_id = $1
        AND h.book_id = $2
        AND (ups.highlight_visibility = 'public' OR ups.highlight_visibility = 'friends')
      ORDER BY h.created_at DESC
      LIMIT 50
    `, [userId, bookId])

    return highlights.rows
  }

  async shareHighlight(userId, highlightId, platform) {
    const highlight = await db.query(`
      SELECT h.*, b.title as book_title, b.author as book_author
      FROM highlights h
      JOIN books b ON b.id = h.book_id
      WHERE h.id = $1 AND h.user_id = $2
    `, [highlightId, userId])

    if (!highlight.rows[0]) {
      throw new Error('Highlight not found')
    }

    const h = highlight.rows[0]

    // Generate share content
    const shareText = `"${h.highlighted_text}"\n\n— ${h.book_author}, ${h.book_title}`

    // Log share event
    await db.query(`
      INSERT INTO highlight_shares (highlight_id, platform, created_at)
      VALUES ($1, $2, NOW())
    `, [highlightId, platform])

    return {
      text: shareText,
      url: `https://reading.example.com/highlight/${highlightId}`
    }
  }
}
```

---

## Database Schema

```sql
-- Books catalog
CREATE TABLE books (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  author VARCHAR(200),
  isbn VARCHAR(20),
  publisher VARCHAR(200),
  total_locations INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- User highlights
CREATE TABLE highlights (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  book_id UUID NOT NULL REFERENCES books(id),
  location_start INTEGER NOT NULL,
  location_end INTEGER NOT NULL,
  highlighted_text TEXT NOT NULL,
  note TEXT,
  color VARCHAR(20) DEFAULT 'yellow',
  visibility VARCHAR(20) DEFAULT 'private', -- private, friends, public
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_highlights_user ON highlights(user_id, created_at DESC);
CREATE INDEX idx_highlights_book ON highlights(book_id);
CREATE INDEX idx_highlights_location ON highlights(book_id, location_start, location_end);

-- Soft deletes for sync
CREATE TABLE deleted_highlights (
  highlight_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  deleted_at TIMESTAMP DEFAULT NOW()
);

-- Popular highlights (aggregated)
CREATE TABLE popular_highlights (
  book_id UUID REFERENCES books(id),
  passage_id VARCHAR(50), -- normalized location range
  passage_text TEXT,
  highlight_count INTEGER DEFAULT 0,
  location_start INTEGER,
  location_end INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (book_id, passage_id)
);

CREATE INDEX idx_popular_count ON popular_highlights(book_id, highlight_count DESC);

-- Social follows
CREATE TABLE follows (
  follower_id UUID REFERENCES users(id),
  followee_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX idx_follows_followee ON follows(followee_id);

-- Privacy settings
CREATE TABLE user_privacy_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  highlight_visibility VARCHAR(20) DEFAULT 'private',
  allow_followers BOOLEAN DEFAULT true,
  include_in_aggregation BOOLEAN DEFAULT true
);
```

---

## Key Design Decisions

### 1. Passage Normalization

**Decision**: Normalize highlight locations to fixed windows

**Rationale**:
- Groups similar highlights for aggregation
- Reduces storage for popular highlights
- Handles slight variations in selection

### 2. Redis for Real-time Counters

**Decision**: Use Redis for highlight counts, batch to PostgreSQL

**Rationale**:
- Fast increment operations
- Handles high write volume
- Eventual consistency acceptable

### 3. Soft Deletes for Sync

**Decision**: Track deleted highlights separately

**Rationale**:
- Enables proper cross-device sync
- Client needs to know what to delete
- Supports undo functionality

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync protocol | WebSocket | Polling | Low latency |
| Aggregation | Redis + batch | Real-time SQL | Write performance |
| Passage matching | Normalized windows | Exact matching | Practical grouping |
| Privacy | Per-user settings | Global default | User control |

---

## Observability

### Metrics Collection

For local development, use Prometheus to scrape metrics from each service. Key metrics to track:

**Highlight Service Metrics:**
```javascript
const prometheus = require('prom-client')

// Request latency histogram
const highlightLatency = new prometheus.Histogram({
  name: 'highlight_operation_duration_seconds',
  help: 'Duration of highlight operations',
  labelNames: ['operation', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
})

// Highlight counters
const highlightsCreated = new prometheus.Counter({
  name: 'highlights_created_total',
  help: 'Total highlights created',
  labelNames: ['book_id']
})

// Sync queue depth
const syncQueueDepth = new prometheus.Gauge({
  name: 'sync_queue_depth',
  help: 'Number of pending sync events per user',
  labelNames: ['user_id']
})

// WebSocket connection gauge
const activeConnections = new prometheus.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active WebSocket connections'
})
```

**SLI Definitions:**
| SLI | Target | Measurement |
|-----|--------|-------------|
| Highlight creation latency | p99 < 200ms | `highlight_operation_duration_seconds{operation="create"}` |
| Sync latency (cross-device) | p95 < 2s | Time from create to WebSocket delivery |
| Popular highlights cache hit | > 90% | `cache_hits / (cache_hits + cache_misses)` |
| API availability | 99.5% | Successful responses / total requests |

### Logging

Use structured JSON logging for easier parsing in development:

```javascript
const logger = require('pino')({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
})

// Log highlight operations with context
logger.info({
  event: 'highlight_created',
  user_id: userId,
  book_id: bookId,
  highlight_id: highlightId,
  location: { start: locationStart, end: locationEnd },
  duration_ms: endTime - startTime
})

// Log sync events
logger.info({
  event: 'sync_pushed',
  user_id: userId,
  device_count: devices.size,
  queued_count: queuedDevices.length
})
```

**Log Levels:**
- `error`: Failed operations, database errors, unhandled exceptions
- `warn`: Retry attempts, degraded performance, approaching limits
- `info`: Successful operations, sync events, aggregation jobs
- `debug`: Request/response details, cache operations (local dev only)

### Distributed Tracing

For local development, use Jaeger with OpenTelemetry:

```javascript
const { trace } = require('@opentelemetry/api')

const tracer = trace.getTracer('highlight-service')

async function createHighlight(userId, highlight) {
  return tracer.startActiveSpan('createHighlight', async (span) => {
    span.setAttribute('user.id', userId)
    span.setAttribute('book.id', highlight.bookId)

    try {
      // Database insert span
      await tracer.startActiveSpan('db.insert', async (dbSpan) => {
        await db.query(...)
        dbSpan.end()
      })

      // Aggregation update span
      await tracer.startActiveSpan('aggregation.increment', async (aggSpan) => {
        await aggregationService.incrementHighlightCount(...)
        aggSpan.end()
      })

      // Sync push span
      await tracer.startActiveSpan('sync.push', async (syncSpan) => {
        await syncService.pushHighlight(...)
        syncSpan.end()
      })

      span.setStatus({ code: SpanStatusCode.OK })
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
```

### Alert Thresholds (Local Development)

Configure alerts in Grafana for local testing:

| Alert | Condition | Action |
|-------|-----------|--------|
| High API latency | p99 > 500ms for 5 min | Check database queries, Redis connection |
| Sync queue backlog | Queue depth > 100 per user | Investigate WebSocket disconnections |
| Cache miss spike | Hit rate < 70% for 10 min | Check Redis memory, TTL configuration |
| Error rate increase | > 5% errors for 5 min | Check logs for root cause |
| WebSocket disconnections | > 10 disconnects/min | Check network, server memory |

### Audit Logging

Track security-relevant events in a separate audit table:

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id UUID,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  details JSONB,
  ip_address INET,
  user_agent TEXT
);

CREATE INDEX idx_audit_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_log(action, timestamp DESC);
```

**Audited Actions:**
- `highlight.export` - User exported their highlights
- `privacy.changed` - User modified privacy settings
- `follow.created` / `follow.deleted` - Social graph changes
- `share.external` - Highlight shared to external platform
- `session.created` / `session.revoked` - Authentication events

```javascript
async function auditLog(userId, action, resourceType, resourceId, details, req) {
  await db.query(`
    INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address, user_agent)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [userId, action, resourceType, resourceId, JSON.stringify(details),
      req.ip, req.headers['user-agent']])
}
```

---

## Failure Handling

### Retry Strategy with Idempotency Keys

All write operations use client-generated idempotency keys to prevent duplicates:

```javascript
class HighlightService {
  async createHighlight(userId, highlight, idempotencyKey) {
    // Check if this request was already processed
    const existing = await redis.get(`idempotency:${idempotencyKey}`)
    if (existing) {
      return JSON.parse(existing) // Return cached result
    }

    // Use database transaction with idempotency check
    const result = await db.transaction(async (tx) => {
      // Check again inside transaction (race condition protection)
      const existingHighlight = await tx.query(`
        SELECT id FROM highlights WHERE idempotency_key = $1
      `, [idempotencyKey])

      if (existingHighlight.rows[0]) {
        return existingHighlight.rows[0]
      }

      const highlightId = uuid()
      await tx.query(`
        INSERT INTO highlights (id, user_id, book_id, ..., idempotency_key)
        VALUES ($1, $2, $3, ..., $4)
      `, [highlightId, userId, highlight.bookId, ..., idempotencyKey])

      return { id: highlightId, ...highlight }
    })

    // Cache result for 24 hours
    await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(result))
    return result
  }
}
```

**Retry Configuration:**
```javascript
const retryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '503', '429']
}

async function withRetry(fn, config = retryConfig) {
  let lastError
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRetryable(error, config) || attempt === config.maxRetries) {
        throw error
      }
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt),
        config.maxDelayMs
      )
      await sleep(delay + Math.random() * 100) // Jitter
    }
  }
  throw lastError
}
```

### Circuit Breaker Pattern

Protect downstream services with circuit breakers:

```javascript
const CircuitBreaker = require('opossum')

// Circuit breaker for Elasticsearch
const searchBreaker = new CircuitBreaker(async (query) => {
  return await elasticsearch.search(query)
}, {
  timeout: 3000,           // 3s timeout per request
  errorThresholdPercentage: 50,
  resetTimeout: 30000,     // 30s before trying again
  volumeThreshold: 5       // Min requests before opening
})

searchBreaker.on('open', () => {
  logger.warn({ event: 'circuit_open', service: 'elasticsearch' })
})

searchBreaker.on('halfOpen', () => {
  logger.info({ event: 'circuit_halfopen', service: 'elasticsearch' })
})

searchBreaker.fallback(async (query) => {
  // Return cached results or empty array
  const cached = await redis.get(`search:fallback:${query.bookId}`)
  return cached ? JSON.parse(cached) : []
})

// Circuit breaker for Redis (aggregation)
const redisBreaker = new CircuitBreaker(async (cmd, args) => {
  return await redis[cmd](...args)
}, {
  timeout: 1000,
  errorThresholdPercentage: 60,
  resetTimeout: 10000
})

redisBreaker.fallback(async (cmd, args) => {
  // For reads, return null; for writes, queue for later
  if (cmd.startsWith('get') || cmd.startsWith('hget')) {
    return null
  }
  await db.query(`
    INSERT INTO redis_write_queue (command, args, created_at)
    VALUES ($1, $2, NOW())
  `, [cmd, JSON.stringify(args)])
  return 'queued'
})
```

**Circuit Breaker States:**
| State | Behavior |
|-------|----------|
| Closed | Normal operation, requests pass through |
| Open | All requests immediately fail/fallback |
| Half-Open | Allow one test request to check recovery |

### Disaster Recovery (Local Simulation)

For learning purposes, simulate multi-region behavior with multiple PostgreSQL instances:

```yaml
# docker-compose.yml
services:
  postgres-primary:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: highlights
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password

  postgres-replica:
    image: postgres:16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: highlights
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
    # In production: configure streaming replication
```

**Failover Logic:**
```javascript
class DatabasePool {
  constructor() {
    this.primary = new Pool({ port: 5432 })
    this.replica = new Pool({ port: 5433 })
    this.usePrimary = true
  }

  async query(sql, params) {
    const pool = this.usePrimary ? this.primary : this.replica
    try {
      return await pool.query(sql, params)
    } catch (error) {
      if (this.usePrimary && this.isConnectionError(error)) {
        logger.error({ event: 'primary_failed', error: error.message })
        this.usePrimary = false
        // Retry on replica (read-only operations)
        if (!this.isWriteQuery(sql)) {
          return await this.replica.query(sql, params)
        }
      }
      throw error
    }
  }

  isConnectionError(error) {
    return ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code)
  }

  isWriteQuery(sql) {
    return /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(sql.trim())
  }
}
```

### Backup and Restore Testing

**Backup Strategy:**
```bash
#!/bin/bash
# backup.sh - Run weekly in local dev to practice restore

BACKUP_DIR="./backups/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# PostgreSQL backup
pg_dump -h localhost -U user -d highlights > "$BACKUP_DIR/highlights.sql"

# Redis backup (RDB snapshot)
docker exec redis redis-cli BGSAVE
docker cp redis:/data/dump.rdb "$BACKUP_DIR/redis.rdb"

# Elasticsearch snapshot
curl -X PUT "localhost:9200/_snapshot/backup/snapshot_$(date +%Y%m%d)?wait_for_completion=true"

echo "Backup completed: $BACKUP_DIR"
```

**Restore Test Script:**
```bash
#!/bin/bash
# restore-test.sh - Verify backups are valid

BACKUP_DIR=$1

# Start fresh containers
docker-compose down -v
docker-compose up -d

# Wait for services
sleep 10

# Restore PostgreSQL
psql -h localhost -U user -d highlights < "$BACKUP_DIR/highlights.sql"

# Restore Redis
docker cp "$BACKUP_DIR/redis.rdb" redis:/data/dump.rdb
docker restart redis

# Verify data
HIGHLIGHT_COUNT=$(psql -h localhost -U user -d highlights -t -c "SELECT COUNT(*) FROM highlights")
echo "Restored $HIGHLIGHT_COUNT highlights"

# Run smoke tests
npm run test:smoke
```

**Restore Checklist:**
- [ ] PostgreSQL restore completes without errors
- [ ] All foreign key constraints satisfied
- [ ] Redis cache warming successful
- [ ] Elasticsearch indices rebuilt and searchable
- [ ] WebSocket connections re-establish
- [ ] Sync queues processed after restore

---

## Cost Tradeoffs

### Storage Tiering

For a learning project, understand how storage tiers would work at scale:

**Highlights Storage Strategy:**
| Data Age | Storage Tier | Cost Implication |
|----------|--------------|------------------|
| 0-30 days | PostgreSQL (hot) | Fast SSD, full indexing |
| 30-365 days | PostgreSQL (warm) | Regular HDD, partial indexing |
| > 1 year | S3/MinIO (cold) | Object storage, no indexing |

**Implementation for Local Dev:**
```javascript
class StorageTiering {
  async archiveOldHighlights() {
    // Move highlights older than 1 year to cold storage
    const oldHighlights = await db.query(`
      SELECT * FROM highlights
      WHERE created_at < NOW() - INTERVAL '1 year'
      AND archived = false
      LIMIT 1000
    `)

    for (const highlight of oldHighlights.rows) {
      // Store in MinIO (S3-compatible)
      await minio.putObject(
        'highlights-archive',
        `${highlight.user_id}/${highlight.id}.json`,
        JSON.stringify(highlight)
      )

      // Mark as archived in PostgreSQL
      await db.query(`
        UPDATE highlights SET archived = true WHERE id = $1
      `, [highlight.id])
    }

    // Optionally delete archived data after verification
    // await db.query(`DELETE FROM highlights WHERE archived = true AND created_at < NOW() - INTERVAL '2 years'`)
  }

  async getHighlight(highlightId) {
    // Check hot storage first
    const hot = await db.query(`SELECT * FROM highlights WHERE id = $1`, [highlightId])
    if (hot.rows[0] && !hot.rows[0].archived) {
      return hot.rows[0]
    }

    // Fall back to cold storage
    try {
      const stream = await minio.getObject('highlights-archive', `*/${highlightId}.json`)
      return JSON.parse(await streamToString(stream))
    } catch (error) {
      return null
    }
  }
}
```

**Storage Cost Comparison (Illustrative):**
| Tier | 1M Highlights | Cost/Month |
|------|---------------|------------|
| PostgreSQL (SSD) | ~500 MB | ~$5 (managed) |
| PostgreSQL (HDD) | ~500 MB | ~$2 (managed) |
| S3/MinIO | ~500 MB | ~$0.02 |

### Cache Sizing

**Redis Memory Budget:**
```javascript
// Calculate cache requirements
const cacheConfig = {
  // Popular highlights cache
  popularHighlights: {
    keyPattern: 'popular:{bookId}',
    avgValueSize: 2048,      // 2KB per book (10 highlights)
    maxKeys: 10000,          // Top 10k books
    ttlSeconds: 300,
    estimatedMemoryMB: (2048 * 10000) / 1024 / 1024  // ~20MB
  },

  // Sync state cache
  syncState: {
    keyPattern: 'sync:{userId}',
    avgValueSize: 256,       // Device list + timestamps
    maxKeys: 100000,         // Active users
    ttlSeconds: 86400,
    estimatedMemoryMB: (256 * 100000) / 1024 / 1024  // ~25MB
  },

  // Idempotency keys
  idempotency: {
    keyPattern: 'idempotency:{key}',
    avgValueSize: 512,
    maxKeys: 50000,          // Last 24h of operations
    ttlSeconds: 86400,
    estimatedMemoryMB: (512 * 50000) / 1024 / 1024  // ~25MB
  },

  // Aggregation counters
  aggregation: {
    keyPattern: 'book:{bookId}:highlights',
    avgValueSize: 1024,      // Hash of passage counts
    maxKeys: 50000,          // Books with activity
    ttlSeconds: null,        // Persistent
    estimatedMemoryMB: (1024 * 50000) / 1024 / 1024  // ~50MB
  }
}

// Total: ~120MB for local dev (set maxmemory to 256MB for headroom)
```

**Local Dev Redis Configuration:**
```conf
# redis.conf
maxmemory 256mb
maxmemory-policy allkeys-lru
```

**Cache Eviction Priority:**
1. Idempotency keys (can regenerate from DB)
2. Sync state (will rebuild on reconnect)
3. Popular highlights (can query PostgreSQL)
4. Aggregation counters (preserve - write-heavy)

### Queue Retention

**Sync Queue Configuration:**
```javascript
const queueConfig = {
  // Per-device sync queue
  syncQueue: {
    maxLength: 1000,         // Events per device
    retentionDays: 30,       // Auto-expire old events
    maxMemoryPerUser: '1MB'
  },

  // Aggregation job queue
  aggregationQueue: {
    maxLength: 10000,
    retentionHours: 24,
    batchSize: 100
  }
}

// Enforce queue limits
async function enqueueSyncEvent(userId, deviceId, event) {
  const queueKey = `sync:queue:${userId}:${deviceId}`

  // Check queue length before adding
  const length = await redis.llen(queueKey)
  if (length >= queueConfig.syncQueue.maxLength) {
    // Trim oldest events (FIFO)
    await redis.ltrim(queueKey, -queueConfig.syncQueue.maxLength + 1, -1)
    logger.warn({ event: 'sync_queue_trimmed', user_id: userId, device_id: deviceId })
  }

  await redis.rpush(queueKey, JSON.stringify(event))
  await redis.expire(queueKey, queueConfig.syncQueue.retentionDays * 86400)
}
```

### Compute vs Storage Optimization

**Decision Matrix:**
| Operation | Compute | Storage | Recommendation |
|-----------|---------|---------|----------------|
| Popular highlights | Pre-compute aggregates | Query on-demand | Pre-compute: Cheaper at read-heavy scale |
| Full-text search | PostgreSQL ILIKE | Elasticsearch index | Elasticsearch: 10x faster for large datasets |
| Highlight export | Generate on request | Pre-generate nightly | On-request: Storage cost not worth it |
| Passage normalization | Compute on write | Store normalized key | Compute: Simple operation, saves storage |

**Pre-computation vs On-Demand Trade-off:**
```javascript
// Option A: Pre-compute popular highlights (chosen)
// - Runs every 5 minutes as background job
// - Stores results in PostgreSQL + Redis cache
// - Cost: 1 job/5min = ~8,640 queries/day
// - Benefit: O(1) read latency

// Option B: Compute on-demand
// - Query and aggregate on each request
// - Cost: 100k reads/sec * aggregation query
// - Problem: Would require 100k+ aggregation queries/sec

class ComputeOptimization {
  // Pre-compute popular highlights (batch job)
  async precomputePopular() {
    // Cost: One heavy query every 5 minutes
    const popular = await db.query(`
      SELECT book_id, passage_id, COUNT(*) as highlight_count
      FROM highlights
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY book_id, passage_id
      HAVING COUNT(*) >= 5
      ORDER BY highlight_count DESC
    `)

    // Store in cache and database
    for (const row of popular.rows) {
      await redis.hset(`popular:${row.book_id}`, row.passage_id, row.highlight_count)
    }
  }

  // On-demand computation (for rare queries)
  async computeOnDemand(bookId) {
    // Only for books not in pre-computed set
    const cached = await redis.hgetall(`popular:${bookId}`)
    if (Object.keys(cached).length > 0) {
      return cached
    }

    // Compute for this specific book (rare case)
    return await db.query(`
      SELECT passage_id, COUNT(*) as highlight_count
      FROM highlights
      WHERE book_id = $1
      GROUP BY passage_id
      HAVING COUNT(*) >= 3
    `, [bookId])
  }
}
```

**Resource Budget for Local Development:**
| Component | Memory | CPU | Storage |
|-----------|--------|-----|---------|
| PostgreSQL | 512 MB | 1 core | 1 GB |
| Redis | 256 MB | 0.5 core | 256 MB |
| Elasticsearch | 512 MB | 1 core | 500 MB |
| Node.js services (3) | 384 MB | 0.5 core each | - |
| **Total** | ~2 GB | ~3.5 cores | ~2 GB |

This fits comfortably on a development machine while simulating the key architectural patterns used at scale.
