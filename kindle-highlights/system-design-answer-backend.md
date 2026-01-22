# Kindle Community Highlights - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design a Kindle Community Highlights system - a social reading platform that enables users to highlight passages in books, sync highlights across devices in real-time, and discover popular highlights from the community.

From a backend perspective, the key challenges are: building real-time synchronization across multiple devices with offline support, designing aggregation pipelines that handle billions of highlights efficiently, and implementing privacy-preserving data flows that share community insights without exposing individual users."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Highlight Management** - Create, edit, delete highlights with notes and colors
- **Cross-device Sync** - Real-time synchronization across Kindle, iOS, Android, Web
- **Community Discovery** - View popular/trending highlights in any book
- **Social Features** - Follow readers, share highlights, friends-only sharing
- **Export** - Export personal highlights to Markdown, CSV, or PDF

### Non-Functional Requirements
- **Sync Latency** - < 2 seconds cross-device propagation
- **Scale** - 10M users, 1B highlights, 100K highlight views/second
- **Availability** - 99.9% uptime
- **Privacy** - Community highlights are anonymized, opt-out available

### Scale Estimates
- 10M daily active users
- Average 50 highlights per user = 500M personal highlights
- 1B community highlights across all books
- 100K read QPS for popular highlights

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Devices                               │
│      Kindle | iOS App | Android App | Web Reader                 │
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

### Core Services

1. **Sync Service** - WebSocket-based real-time sync with conflict resolution
2. **Highlight Service** - CRUD operations, search, and export
3. **Aggregation Service** - Community highlights with anonymization
4. **Social Service** - Authentication, following, sharing

## Deep Dive: Real-time Sync System (10 minutes)

### WebSocket Connection Management

The sync service maintains persistent WebSocket connections per user per device:

```typescript
class SyncService {
  private connections: Map<string, Map<string, WebSocket>> = new Map()

  handleConnection(ws: WebSocket, userId: string, deviceId: string) {
    // Register device connection
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Map())
    }
    this.connections.get(userId)!.set(deviceId, ws)

    // Store device sync state in Redis
    await redis.hset(`sync:${userId}`, deviceId, JSON.stringify({
      connectedAt: Date.now(),
      lastSync: null
    }))

    ws.on('message', (data) => this.handleMessage(userId, deviceId, data))
    ws.on('close', () => this.handleDisconnect(userId, deviceId))

    // Send pending syncs from offline queue
    this.sendPendingHighlights(userId, deviceId)
  }

  async handleMessage(userId: string, deviceId: string, data: string) {
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

  async pushHighlight(userId: string, event: SyncEvent) {
    const devices = this.connections.get(userId)
    if (!devices) return

    const message = JSON.stringify({
      type: 'highlight_sync',
      event
    })

    for (const [deviceId, ws] of devices) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      } else {
        // Queue for offline device
        await this.queueForDevice(userId, deviceId, event)
      }
    }
  }
}
```

### Conflict Resolution Strategy

Using last-write-wins with timestamp comparison:

```typescript
interface ConflictResolution {
  winner: 'local' | 'server' | 'both'
  action: 'push' | 'accept' | 'fork'
}

async function resolveConflict(
  localVersion: Highlight,
  serverVersion: Highlight
): Promise<ConflictResolution> {
  // Compare timestamps
  if (localVersion.updatedAt > serverVersion.updatedAt) {
    return { winner: 'local', action: 'push' }
  } else if (localVersion.updatedAt < serverVersion.updatedAt) {
    return { winner: 'server', action: 'accept' }
  } else {
    // Same timestamp - content-based merge or fork
    if (localVersion.text !== serverVersion.text) {
      return { winner: 'both', action: 'fork' }
    }
    return { winner: 'server', action: 'accept' }
  }
}
```

### Offline Queue with Redis

Pending events queued for disconnected devices:

```typescript
class OfflineQueue {
  async queueForDevice(userId: string, deviceId: string, event: SyncEvent) {
    const queueKey = `sync:queue:${userId}:${deviceId}`

    // Check queue length before adding
    const length = await redis.llen(queueKey)
    if (length >= 1000) {
      // Trim oldest events (FIFO)
      await redis.ltrim(queueKey, -999, -1)
    }

    await redis.rpush(queueKey, JSON.stringify(event))
    // Expire after 30 days
    await redis.expire(queueKey, 30 * 24 * 3600)
  }

  async drainQueue(userId: string, deviceId: string, ws: WebSocket) {
    const queueKey = `sync:queue:${userId}:${deviceId}`

    while (true) {
      const event = await redis.lpop(queueKey)
      if (!event) break

      ws.send(JSON.stringify({
        type: 'sync_batch_item',
        event: JSON.parse(event)
      }))
    }
  }
}
```

### Sync Request Handler

Fetching changes since last sync:

```typescript
async function handleSyncRequest(
  userId: string,
  deviceId: string,
  message: { lastSyncTimestamp: number }
) {
  const { lastSyncTimestamp } = message

  // Get all highlights modified since last sync
  const highlights = await db.query(`
    SELECT * FROM highlights
    WHERE user_id = $1 AND updated_at > $2
    ORDER BY updated_at
  `, [userId, new Date(lastSyncTimestamp)])

  // Get deleted highlights (soft delete tracking)
  const deleted = await db.query(`
    SELECT highlight_id, deleted_at FROM deleted_highlights
    WHERE user_id = $1 AND deleted_at > $2
  `, [userId, new Date(lastSyncTimestamp)])

  const ws = connections.get(userId)?.get(deviceId)
  if (ws) {
    ws.send(JSON.stringify({
      type: 'sync_response',
      highlights: highlights.rows,
      deleted: deleted.rows.map(d => d.highlight_id),
      serverTime: Date.now()
    }))
  }

  // Update last sync time
  await redis.hset(`sync:${userId}`, deviceId, JSON.stringify({
    lastSync: Date.now()
  }))
}
```

## Deep Dive: Aggregation Service (8 minutes)

### Passage Normalization

Grouping similar highlights by normalizing text positions:

```typescript
function normalizePassage(
  bookId: string,
  text: string,
  locationStart: number,
  locationEnd: number
): { fingerprint: string; normalized: string } {
  // Normalize text for comparison
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  // Create fingerprint for grouping
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${bookId}:${normalized}`)
    .digest('hex')
    .substring(0, 16)

  return { fingerprint, normalized }
}

// Alternative: Window-based normalization
function normalizeToWindow(
  bookId: string,
  locationStart: number,
  locationEnd: number
): string {
  const windowSize = 100 // characters
  const normalizedStart = Math.floor(locationStart / windowSize) * windowSize
  const normalizedEnd = Math.ceil(locationEnd / windowSize) * windowSize
  return `${normalizedStart}-${normalizedEnd}`
}
```

### Real-time Counters with Redis

```typescript
class AggregationService {
  async incrementHighlightCount(bookId: string, fingerprint: string) {
    const key = `highlights:${bookId}:${fingerprint}`

    // Increment counter atomically
    await redis.incr(key)

    // Add to book's sorted set for ranking
    await redis.zincrby(`book:${bookId}:popular`, 1, fingerprint)

    // Expire after 30 days of inactivity
    await redis.expire(key, 30 * 24 * 60 * 60)
  }

  async decrementHighlightCount(bookId: string, fingerprint: string) {
    const key = `highlights:${bookId}:${fingerprint}`

    // Decrement but never go below 0
    const newCount = await redis.decr(key)
    if (newCount < 0) {
      await redis.set(key, 0)
    }

    await redis.zincrby(`book:${bookId}:popular`, -1, fingerprint)
  }

  async getPopularHighlights(bookId: string, limit = 10) {
    // Check cache first
    const cacheKey = `popular:${bookId}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // Get top passages by count
    const fingerprints = await redis.zrevrange(
      `book:${bookId}:popular`, 0, limit - 1, 'WITHSCORES'
    )

    // Fetch passage details
    const highlights = []
    for (let i = 0; i < fingerprints.length; i += 2) {
      const fingerprint = fingerprints[i]
      const count = parseInt(fingerprints[i + 1])

      // Get representative highlight text
      const passage = await db.query(`
        SELECT highlighted_text, location_start, location_end
        FROM highlights
        WHERE book_id = $1 AND fingerprint = $2
        LIMIT 1
      `, [bookId, fingerprint])

      if (passage.rows[0]) {
        highlights.push({
          text: passage.rows[0].highlighted_text,
          count,
          location: {
            start: passage.rows[0].location_start,
            end: passage.rows[0].location_end
          }
        })
      }
    }

    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(highlights))

    return highlights
  }
}
```

### Batch Aggregation Worker

Syncing Redis counters to PostgreSQL for durability:

```typescript
async function aggregationWorker() {
  // Run every 5 minutes
  setInterval(async () => {
    let cursor = '0'

    do {
      const [newCursor, keys] = await redis.scan(
        cursor, 'MATCH', 'book:*:popular', 'COUNT', 100
      )
      cursor = newCursor

      for (const key of keys) {
        const bookId = key.split(':')[1]
        const passages = await redis.zrangebyscore(
          key, 1, '+inf', 'WITHSCORES'
        )

        for (let i = 0; i < passages.length; i += 2) {
          const fingerprint = passages[i]
          const count = parseInt(passages[i + 1])

          // Get sample text for the passage
          const sample = await getPassageSample(bookId, fingerprint)

          await db.query(`
            INSERT INTO highlight_aggregates
              (book_id, fingerprint, passage_text, count, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (book_id, fingerprint)
            DO UPDATE SET count = $4, updated_at = NOW()
          `, [bookId, fingerprint, sample.text, count])
        }
      }
    } while (cursor !== '0')

    logger.info({ event: 'aggregation_completed' })
  }, 5 * 60 * 1000)
}
```

## Deep Dive: Privacy Controls (5 minutes)

### Per-User Privacy Settings

```typescript
interface PrivacySettings {
  community: {
    contributeToPopular: boolean   // Include in aggregates
    showMyHighlightsToFollowers: boolean
    allowFriendRequests: boolean
  }
  sync: {
    syncNotes: boolean
    syncHighlights: boolean
  }
  export: {
    includeNotes: boolean
    includeTimestamps: boolean
  }
}

async function contributeToAggregate(userId: string, highlight: Highlight) {
  // Check user's privacy setting
  const settings = await getPrivacySettings(userId)

  if (!settings.community.contributeToPopular) {
    return // Don't include in community data
  }

  // Only contribute fingerprint and count - no user data
  await aggregationService.incrementHighlightCount(
    highlight.bookId,
    highlight.fingerprint
  )
  // userId is NOT stored in aggregate tables
}
```

### Friends-Only Sharing

```typescript
async function getSharedHighlights(
  requesterId: string,
  targetUserId: string
): Promise<Highlight[]> {
  // Check relationship
  const friendship = await db.query(`
    SELECT * FROM friendships
    WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'
  `, [requesterId, targetUserId])

  if (!friendship.rows[0]) {
    throw new ForbiddenError('Not friends')
  }

  // Check target's privacy settings
  const settings = await getPrivacySettings(targetUserId)
  if (!settings.community.showMyHighlightsToFollowers) {
    return []
  }

  // Return only public highlights (not private notes)
  const highlights = await db.query(`
    SELECT id, book_id, highlighted_text, created_at
    FROM highlights
    WHERE user_id = $1 AND visibility IN ('public', 'friends')
    ORDER BY created_at DESC
    LIMIT 50
  `, [targetUserId])

  return highlights.rows
}
```

## Database Schema (3 minutes)

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
  fingerprint VARCHAR(16), -- For aggregation grouping
  note TEXT,
  color VARCHAR(20) DEFAULT 'yellow',
  visibility VARCHAR(20) DEFAULT 'private',
  idempotency_key VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_highlights_user ON highlights(user_id, created_at DESC);
CREATE INDEX idx_highlights_book ON highlights(book_id);
CREATE INDEX idx_highlights_fingerprint ON highlights(book_id, fingerprint);
CREATE INDEX idx_highlights_location ON highlights(book_id, location_start, location_end);

-- Soft deletes for sync
CREATE TABLE deleted_highlights (
  highlight_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  deleted_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_deleted_user ON deleted_highlights(user_id, deleted_at);

-- Popular highlights (aggregated)
CREATE TABLE highlight_aggregates (
  book_id UUID REFERENCES books(id),
  fingerprint VARCHAR(16),
  passage_text TEXT,
  count INTEGER DEFAULT 0,
  location_start INTEGER,
  location_end INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (book_id, fingerprint)
);

CREATE INDEX idx_aggregates_count ON highlight_aggregates(book_id, count DESC);

-- Privacy settings
CREATE TABLE user_privacy_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  highlight_visibility VARCHAR(20) DEFAULT 'private',
  allow_followers BOOLEAN DEFAULT true,
  contribute_to_aggregation BOOLEAN DEFAULT true
);
```

## Failure Handling (4 minutes)

### Idempotency for Highlight Creation

```typescript
async function createHighlight(
  userId: string,
  highlight: HighlightInput,
  idempotencyKey: string
): Promise<Highlight> {
  // Check if request was already processed
  const existing = await redis.get(`idempotency:${idempotencyKey}`)
  if (existing) {
    return JSON.parse(existing)
  }

  // Database transaction with idempotency check
  const result = await db.transaction(async (tx) => {
    // Double-check inside transaction
    const existingHighlight = await tx.query(`
      SELECT * FROM highlights WHERE idempotency_key = $1
    `, [idempotencyKey])

    if (existingHighlight.rows[0]) {
      return existingHighlight.rows[0]
    }

    const highlightId = uuid()
    const fingerprint = normalizePassage(
      highlight.bookId,
      highlight.text,
      highlight.locationStart,
      highlight.locationEnd
    ).fingerprint

    await tx.query(`
      INSERT INTO highlights
        (id, user_id, book_id, location_start, location_end,
         highlighted_text, fingerprint, note, color, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [highlightId, userId, highlight.bookId, highlight.locationStart,
        highlight.locationEnd, highlight.text, fingerprint,
        highlight.note, highlight.color, idempotencyKey])

    return { id: highlightId, ...highlight, fingerprint }
  })

  // Cache result for 24 hours
  await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(result))
  return result
}
```

### Circuit Breaker for External Services

```typescript
const CircuitBreaker = require('opossum')

// Circuit breaker for Elasticsearch
const searchBreaker = new CircuitBreaker(async (query) => {
  return await elasticsearch.search(query)
}, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5
})

searchBreaker.on('open', () => {
  logger.warn({ event: 'circuit_open', service: 'elasticsearch' })
})

searchBreaker.fallback(async (query) => {
  // Fall back to PostgreSQL full-text search
  const result = await db.query(`
    SELECT * FROM highlights
    WHERE user_id = $1
    AND (highlighted_text ILIKE $2 OR note ILIKE $2)
    LIMIT 20
  `, [query.userId, `%${query.term}%`])
  return result.rows
})

// Circuit breaker for Redis
const redisBreaker = new CircuitBreaker(async (cmd, args) => {
  return await redis[cmd](...args)
}, {
  timeout: 1000,
  errorThresholdPercentage: 60,
  resetTimeout: 10000
})

redisBreaker.fallback(async (cmd, args) => {
  if (cmd.startsWith('get') || cmd.startsWith('hget')) {
    return null // For reads, return null
  }
  // For writes, queue for later
  await db.query(`
    INSERT INTO redis_write_queue (command, args, created_at)
    VALUES ($1, $2, NOW())
  `, [cmd, JSON.stringify(args)])
  return 'queued'
})
```

### Retry with Exponential Backoff

```typescript
const retryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '503', '429']
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config = retryConfig
): Promise<T> {
  let lastError: Error

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      if (!isRetryable(error, config) || attempt === config.maxRetries) {
        throw error
      }
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt),
        config.maxDelayMs
      )
      // Add jitter
      await sleep(delay + Math.random() * 100)
    }
  }

  throw lastError!
}
```

## Observability (3 minutes)

### Metrics Collection

```typescript
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

// WebSocket connections
const activeConnections = new prometheus.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active WebSocket connections'
})
```

### SLI Definitions

| SLI | Target | Measurement |
|-----|--------|-------------|
| Highlight creation latency | p99 < 200ms | `highlight_operation_duration_seconds{operation="create"}` |
| Sync latency (cross-device) | p95 < 2s | Time from create to WebSocket delivery |
| Popular highlights cache hit | > 90% | `cache_hits / (cache_hits + cache_misses)` |
| API availability | 99.5% | Successful responses / total requests |

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync Protocol | WebSocket | Long Polling | Low latency, bidirectional |
| Conflict Resolution | Last-Write-Wins | CRDTs | Simple, works for most cases |
| Aggregation | Redis + PostgreSQL batch | Pure streaming (Kafka) | Balance of speed and complexity |
| Sharding | Book-based | User-based | Cross-book queries less common |
| Privacy | Opt-out | Opt-in | More community data by default |

## Closing Summary (1 minute)

"The Kindle Community Highlights backend is built around three pillars:

1. **Real-time sync** using WebSocket with offline queue in Redis and last-write-wins conflict resolution
2. **Scalable aggregation** using Redis sorted sets for real-time counters with periodic PostgreSQL persistence
3. **Privacy-first design** with anonymized aggregates and per-user visibility controls

Key backend patterns include idempotency keys for safe retries, circuit breakers for external service protection, and passage fingerprinting for grouping similar highlights. The system scales by sharding on book_id and caching popular highlights aggressively with 5-minute TTLs."
