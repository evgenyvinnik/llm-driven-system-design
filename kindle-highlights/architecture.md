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
