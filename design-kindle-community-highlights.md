# System Design: Kindle Community Highlights

## Overview

Design a social reading platform similar to Kindle's Popular Highlights feature, where users can highlight passages while reading books, see what others have highlighted, and discover popular quotes and insights from the community.

## Functional Requirements

### Core Features

1. **Highlighting & Annotation**
   - Create highlights (select text range in a book)
   - Add personal notes to highlights
   - Edit and delete highlights
   - Support different highlight colors/types
   - Highlight metadata (book, chapter, page/location, timestamp)

2. **Community Highlights**
   - View popular highlights in a book (most highlighted passages)
   - See highlight count for each passage
   - Filter popular highlights by recency, popularity, or chapter
   - "X readers highlighted this" indicator while reading

3. **Personal Library**
   - View all my highlights across all books
   - Search my highlights by keyword, book, or date
   - Export highlights (Markdown, PDF, CSV)
   - Organize highlights by tags or collections

4. **Social Features**
   - Follow other readers
   - See friends' highlights (with permission)
   - Share highlights on social media
   - Like/comment on public highlights
   - Discover readers with similar tastes

5. **Real-time Sync**
   - Highlights sync across all devices (phone, tablet, web, e-reader)
   - Immediate propagation (highlight on phone, see on web instantly)
   - Offline support (queue highlights, sync when online)

6. **Privacy Controls**
   - Make highlights public, friends-only, or private
   - Opt-out of community highlights aggregation
   - Control what data is shared

### User Personas

#### Reader (End User)
- Highlight passages while reading
- View my highlights for reference
- Discover popular highlights in books I'm reading
- Follow friends and see their highlights
- Export highlights for note-taking

#### Author/Publisher (Content Creator)
- View engagement metrics (most highlighted passages)
- Understand which parts resonate with readers
- Discover reader insights and feedback
- Monitor book popularity and reading patterns

#### Admin/Moderator
- Monitor system health and performance
- Moderate inappropriate highlights/comments
- View engagement statistics (highlights per book, active users)
- Manage user reports and privacy complaints
- Configure highlight aggregation rules (min count for "popular")

## Non-Functional Requirements

### Scale
- **Users:** 10 million readers
- **Books:** 1 million books in catalog
- **Highlights:** 1 billion total highlights
- **Read Operations:** 100k highlights viewed per second (readers opening books)
- **Write Operations:** 1k highlights created per second (peak reading times)

### Performance
- **Sync Latency:** < 2 seconds from highlight creation to appearing on another device
- **Popular Highlights Load Time:** < 500ms to load popular highlights for a book
- **Search Latency:** < 300ms to search personal highlights

### Reliability
- **Availability:** 99.9% uptime (readers depend on access to their highlights)
- **Data Durability:** No highlight loss (highlights are valuable to users)
- **Consistency:** Eventual consistency for community highlights (slight delay acceptable)

### Privacy
- **User Control:** Users can delete all their data
- **Anonymization:** Community highlights don't reveal individual identities (unless public)
- **GDPR Compliance:** Support data export and deletion requests

## Key Technical Challenges

1. **Real-time Sync Across Devices**
   - How to propagate highlights to all user devices within 2 seconds?
   - How to handle offline devices (queue highlights, sync on reconnect)?
   - How to resolve conflicts (same passage highlighted on two devices simultaneously)?

2. **Aggregating Popular Highlights**
   - How to efficiently compute "most popular" passages in a book?
   - How to detect overlapping highlights (different users highlight slightly different ranges)?
   - How to update popular counts in real-time?

3. **Storage at Scale**
   - 1 billion highlights, each with text, location, timestamp, notes
   - Efficient storage schema (minimize duplication of book content)
   - Fast retrieval (user's highlights, popular highlights in a book)

4. **Privacy & Aggregation**
   - How to aggregate highlights while respecting privacy settings?
   - How to anonymize data (show "450 readers" without revealing who)?
   - How to handle users deleting highlights (decrement counts)?

5. **Search & Discovery**
   - Full-text search across all my highlights (fast, even with millions)
   - Discover highlights by friends or similar readers
   - Filter by book, date, tags

## Architecture Approaches

### Approach 1: Monolithic Database (Simple)

**How it works:**
- Single PostgreSQL database stores everything
- Highlights table with user_id, book_id, location, text
- Periodic batch job computes popular highlights
- REST API for all operations

**Pros:**
- Simple to implement and understand
- Strong consistency (ACID transactions)
- Easy to query (SQL joins)

**Cons:**
- Scaling bottleneck (single database)
- Slow popular highlights computation (full table scan)
- No real-time sync (polling required)

**When to use:**
- Learning basic system design
- Early prototype (< 100k users)
- Non-real-time requirements

### Approach 2: Hybrid Database + Cache + Real-time (Recommended)

**How it works:**
- **PostgreSQL:** Primary storage for highlights (durable, queryable)
- **Redis:** Cache popular highlights, user sessions, real-time sync
- **WebSocket:** Real-time sync to connected devices
- **Elasticsearch:** Full-text search for highlights
- **Background Workers:** Compute popular highlights periodically

**Pros:**
- Scalable (cache offloads read traffic)
- Real-time sync (WebSocket push)
- Fast search (Elasticsearch)
- Flexible (can optimize each component independently)

**Cons:**
- More complex (multiple storage systems)
- Eventual consistency (cache may be stale)
- Operational overhead (manage Redis, Elasticsearch)

**When to use:**
- Production system (1M+ users)
- Real-time requirements
- Learning distributed systems

### Approach 3: Event-Driven Architecture (Advanced)

**How it works:**
- **Event Bus (Kafka):** Highlight created/updated/deleted events
- **Event Processors:** Consume events to update popular highlights, sync devices
- **CQRS:** Separate write model (create highlight) from read model (view popular highlights)
- **Materialized Views:** Pre-computed popular highlights stored in Cassandra

**Pros:**
- Massive scalability (event bus handles millions of events)
- Decoupled services (highlight service, sync service, aggregation service)
- Auditability (event log is source of truth)

**Cons:**
- High complexity (event sourcing, CQRS patterns)
- Eventual consistency everywhere
- Harder to debug (distributed tracing required)

**When to use:**
- Very large scale (10M+ users)
- Learning event-driven architecture
- Building microservices platform

## Recommended Approach: Hybrid Database + Cache + Real-time (Approach 2)

**Rationale:**
- Balances real-time requirements with implementation complexity
- Can run locally with Docker (PostgreSQL, Redis, Elasticsearch)
- Teaches caching, real-time sync, and search indexing
- Sufficient for 10M users with proper optimization

**Trade-offs:**
- More complex than Approach 1 (but educational value is higher)
- Eventual consistency for popular highlights (acceptable UX trade-off)
- Requires managing multiple systems (but common in production)

## Technology Stack

### Core Stack (following CLAUDE.md defaults)
- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind
- **Backend:** Node.js + Express
- **Primary Database:** PostgreSQL (highlights, users, books)
- **Cache:** Redis/Valkey (popular highlights cache, real-time sync)
- **Search:** Elasticsearch (full-text search across highlights)
- **Real-time:** WebSocket (Socket.io) for device sync
- **Background Jobs:** Bull (Redis-backed job queue)

### Why This Stack?

**PostgreSQL for Primary Storage:**
- Relational data (users, books, highlights) with foreign keys
- ACID guarantees (no highlight loss)
- Complex queries (aggregate highlights per book)

**Redis for Caching & Real-time:**
- Fast reads (popular highlights cached in memory)
- Pub/Sub for real-time sync (publish highlight event, subscribers receive)
- Session storage (track which devices are online)

**Elasticsearch for Search:**
- Full-text search across highlight content and notes
- Faceted search (filter by book, date, tags)
- Fuzzy matching (find highlights even with typos)

**WebSocket for Real-time Sync:**
- Push highlights to connected devices instantly
- Bi-directional (device can request sync, server can push updates)
- Persistent connection (no polling overhead)

## Detailed Design

### Data Model

**PostgreSQL Schema:**

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Books
CREATE TABLE books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  author VARCHAR(255) NOT NULL,
  isbn VARCHAR(20) UNIQUE,
  published_date DATE,
  total_pages INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Highlights
CREATE TABLE highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,

  -- Location in book
  start_location INT NOT NULL, -- Character offset or page number
  end_location INT NOT NULL,
  chapter VARCHAR(255),

  -- Content
  highlighted_text TEXT NOT NULL,
  personal_note TEXT,

  -- Metadata
  color VARCHAR(20) DEFAULT 'yellow',
  visibility VARCHAR(20) DEFAULT 'private', -- private, friends, public
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Indexing
  INDEX idx_user_highlights (user_id, created_at DESC),
  INDEX idx_book_highlights (book_id, start_location),
  INDEX idx_visibility (visibility) WHERE visibility = 'public'
);

-- Popular Highlights (Materialized/Cached)
CREATE TABLE popular_highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,

  -- Aggregated location (multiple overlapping highlights merged)
  start_location INT NOT NULL,
  end_location INT NOT NULL,
  canonical_text TEXT NOT NULL, -- Representative text for this passage

  -- Aggregation
  highlight_count INT NOT NULL DEFAULT 0,
  last_highlighted_at TIMESTAMP,

  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_popular_by_book (book_id, highlight_count DESC)
);

-- Follows (social graph)
CREATE TABLE follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (follower_id, following_id)
);

-- Likes (users can like public highlights)
CREATE TABLE highlight_likes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (user_id, highlight_id)
);
```

**Redis Data Structures:**

```
1. Popular Highlights Cache (per book)
   Key: popular:book:{book_id}
   Type: Sorted Set
   Value: {start_location}:{end_location}:{text}
   Score: highlight_count
   TTL: 1 hour (recompute periodically)

2. User Devices (track online devices for real-time sync)
   Key: user:{user_id}:devices
   Type: Set
   Value: device_id
   TTL: None (removed on disconnect)

3. Highlight Sync Queue (offline devices)
   Key: sync:user:{user_id}
   Type: List
   Value: {highlight_id, action: created|updated|deleted}
   TTL: 7 days

4. User Session (authentication)
   Key: session:{session_id}
   Type: String (JSON)
   Value: {user_id, device_id, created_at}
   TTL: 30 days
```

**Elasticsearch Index:**

```json
{
  "mappings": {
    "properties": {
      "highlight_id": { "type": "keyword" },
      "user_id": { "type": "keyword" },
      "book_id": { "type": "keyword" },
      "book_title": { "type": "text" },
      "highlighted_text": { "type": "text" },
      "personal_note": { "type": "text" },
      "created_at": { "type": "date" },
      "visibility": { "type": "keyword" }
    }
  }
}
```

### Highlight Creation Flow

```typescript
// API: POST /api/highlights
async function createHighlight(req, res) {
  const { bookId, startLocation, endLocation, text, note, color, visibility } = req.body;
  const userId = req.user.id;

  // 1. Store highlight in PostgreSQL
  const highlight = await db.query(
    `INSERT INTO highlights (user_id, book_id, start_location, end_location, highlighted_text, personal_note, color, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, bookId, startLocation, endLocation, text, note, color, visibility]
  );

  // 2. Index in Elasticsearch (async)
  await elasticsearchQueue.add({
    action: 'index',
    highlight: highlight.rows[0]
  });

  // 3. Update popular highlights if public (async)
  if (visibility === 'public') {
    await popularHighlightsQueue.add({
      bookId,
      startLocation,
      endLocation,
      text
    });
  }

  // 4. Sync to user's other devices (real-time)
  await syncHighlightToDevices(userId, highlight.rows[0]);

  res.json({ highlight: highlight.rows[0] });
}
```

### Real-time Sync (WebSocket)

**Connection Setup:**
```typescript
// Server: Socket.io
io.on('connection', (socket) => {
  const { userId, deviceId } = socket.handshake.auth;

  // Register device as online
  await redis.sadd(`user:${userId}:devices`, deviceId);

  socket.on('disconnect', async () => {
    // Remove device from online set
    await redis.srem(`user:${userId}:devices`, deviceId);
  });

  // Listen for highlight events from this device
  socket.on('highlight:created', async (data) => {
    // Handle highlight creation from this device
    await createHighlight(userId, data);
  });
});

// Sync highlight to all user's devices
async function syncHighlightToDevices(userId, highlight) {
  // Get all online devices for this user
  const devices = await redis.smembers(`user:${userId}:devices`);

  // Push to each device
  for (const deviceId of devices) {
    io.to(deviceId).emit('highlight:sync', highlight);
  }

  // If devices offline, queue for later sync
  await redis.rpush(`sync:user:${userId}`, JSON.stringify({
    highlightId: highlight.id,
    action: 'created',
    timestamp: Date.now()
  }));
}
```

**Client: React Hook**
```typescript
function useHighlightSync() {
  const [socket, setSocket] = useState(null);
  const { user, deviceId } = useAuth();

  useEffect(() => {
    // Connect to WebSocket
    const newSocket = io('https://api.example.com', {
      auth: { userId: user.id, deviceId }
    });

    // Listen for highlight syncs
    newSocket.on('highlight:sync', (highlight) => {
      // Update local state (Zustand store)
      addHighlight(highlight);
    });

    setSocket(newSocket);

    return () => newSocket.close();
  }, [user.id, deviceId]);

  // Function to create highlight
  const createHighlight = useCallback((data) => {
    socket.emit('highlight:created', data);
  }, [socket]);

  return { createHighlight };
}
```

### Popular Highlights Aggregation

**Challenge:** Overlapping highlights from different users

Example:
- User A highlights characters 1200-1350: "To be or not to be, that is the question"
- User B highlights characters 1200-1340: "To be or not to be, that is the"
- User C highlights characters 1210-1350: "be or not to be, that is the question"

These should be treated as the **same popular highlight**.

**Solution: Range Overlap Detection**

```typescript
// Background job: Aggregate popular highlights for a book
async function aggregatePopularHighlights(bookId) {
  // 1. Get all public highlights for this book
  const highlights = await db.query(
    `SELECT start_location, end_location, highlighted_text
     FROM highlights
     WHERE book_id = $1 AND visibility = 'public'
     ORDER BY start_location`,
    [bookId]
  );

  // 2. Cluster overlapping highlights
  const clusters = clusterOverlappingHighlights(highlights.rows);

  // 3. For each cluster, create/update popular highlight
  for (const cluster of clusters) {
    const canonicalText = cluster[0].highlighted_text; // Use first occurrence
    const count = cluster.length;

    await db.query(
      `INSERT INTO popular_highlights (book_id, start_location, end_location, canonical_text, highlight_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (book_id, start_location, end_location)
       DO UPDATE SET highlight_count = $5, updated_at = NOW()`,
      [bookId, cluster.startLocation, cluster.endLocation, canonicalText, count]
    );

    // Cache in Redis
    await redis.zadd(
      `popular:book:${bookId}`,
      count,
      `${cluster.startLocation}:${cluster.endLocation}:${canonicalText}`
    );
    await redis.expire(`popular:book:${bookId}`, 3600); // 1 hour TTL
  }
}

// Cluster overlapping highlights
function clusterOverlappingHighlights(highlights) {
  const clusters = [];
  let currentCluster = null;

  for (const highlight of highlights) {
    if (!currentCluster) {
      currentCluster = {
        startLocation: highlight.start_location,
        endLocation: highlight.end_location,
        highlights: [highlight]
      };
    } else {
      // Check if overlaps with current cluster
      const overlap = calculateOverlap(
        currentCluster.startLocation,
        currentCluster.endLocation,
        highlight.start_location,
        highlight.end_location
      );

      if (overlap > 0.5) { // 50% overlap threshold
        // Add to current cluster
        currentCluster.highlights.push(highlight);
        // Expand cluster range
        currentCluster.endLocation = Math.max(currentCluster.endLocation, highlight.end_location);
      } else {
        // Start new cluster
        clusters.push(currentCluster);
        currentCluster = {
          startLocation: highlight.start_location,
          endLocation: highlight.end_location,
          highlights: [highlight]
        };
      }
    }
  }

  if (currentCluster) {
    clusters.push(currentCluster);
  }

  // Filter clusters with at least 5 highlights (threshold for "popular")
  return clusters.filter(c => c.highlights.length >= 5);
}

function calculateOverlap(start1, end1, start2, end2) {
  const overlapStart = Math.max(start1, start2);
  const overlapEnd = Math.min(end1, end2);
  const overlapLength = Math.max(0, overlapEnd - overlapStart);

  const length1 = end1 - start1;
  const length2 = end2 - start2;

  return overlapLength / Math.min(length1, length2);
}
```

**Scheduled Job:**
```typescript
// Run aggregation every 5 minutes using Bull
const queue = new Bull('popular-highlights', { redis: redisConfig });

queue.add(
  'aggregate-all-books',
  {},
  { repeat: { cron: '*/5 * * * *' } } // Every 5 minutes
);

queue.process('aggregate-all-books', async (job) => {
  // Get all books that had highlights in the last 5 minutes
  const books = await db.query(
    `SELECT DISTINCT book_id FROM highlights WHERE created_at > NOW() - INTERVAL '5 minutes'`
  );

  for (const book of books.rows) {
    await aggregatePopularHighlights(book.book_id);
  }
});
```

### Viewing Popular Highlights

**API: GET /api/books/:bookId/popular-highlights**
```typescript
async function getPopularHighlights(req, res) {
  const { bookId } = req.params;
  const { limit = 20, offset = 0 } = req.query;

  // 1. Try cache first (Redis)
  const cached = await redis.zrevrange(`popular:book:${bookId}`, offset, offset + limit - 1, 'WITHSCORES');

  if (cached.length > 0) {
    // Parse cached data
    const highlights = [];
    for (let i = 0; i < cached.length; i += 2) {
      const [start, end, text] = cached[i].split(':');
      highlights.push({
        startLocation: parseInt(start),
        endLocation: parseInt(end),
        text,
        highlightCount: parseInt(cached[i + 1])
      });
    }
    return res.json({ highlights, source: 'cache' });
  }

  // 2. Cache miss, query database
  const result = await db.query(
    `SELECT start_location, end_location, canonical_text, highlight_count
     FROM popular_highlights
     WHERE book_id = $1
     ORDER BY highlight_count DESC
     LIMIT $2 OFFSET $3`,
    [bookId, limit, offset]
  );

  // 3. Populate cache
  for (const row of result.rows) {
    await redis.zadd(
      `popular:book:${bookId}`,
      row.highlight_count,
      `${row.start_location}:${row.end_location}:${row.canonical_text}`
    );
  }
  await redis.expire(`popular:book:${bookId}`, 3600);

  res.json({ highlights: result.rows, source: 'database' });
}
```

### Search Highlights

**API: GET /api/highlights/search?q=keyword**
```typescript
async function searchHighlights(req, res) {
  const { q, bookId, startDate, endDate, limit = 20 } = req.query;
  const userId = req.user.id;

  // Build Elasticsearch query
  const query = {
    bool: {
      must: [
        { match: { user_id: userId } }, // Only search my highlights
        {
          multi_match: {
            query: q,
            fields: ['highlighted_text', 'personal_note']
          }
        }
      ],
      filter: []
    }
  };

  if (bookId) {
    query.bool.filter.push({ term: { book_id: bookId } });
  }

  if (startDate || endDate) {
    query.bool.filter.push({
      range: {
        created_at: {
          gte: startDate,
          lte: endDate
        }
      }
    });
  }

  // Search Elasticsearch
  const result = await elasticsearch.search({
    index: 'highlights',
    body: {
      query,
      size: limit,
      highlight: {
        fields: {
          highlighted_text: {},
          personal_note: {}
        }
      }
    }
  });

  res.json({
    total: result.hits.total.value,
    highlights: result.hits.hits.map(hit => ({
      ...hit._source,
      highlights: hit.highlight
    }))
  });
}
```

## End-User Features

### Reader Interface (React Components)

**Reading View with Highlighting:**
```typescript
function BookReader({ bookId }) {
  const [selection, setSelection] = useState(null);
  const { createHighlight } = useHighlightSync();

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (selection.toString().length > 0) {
      const range = selection.getRangeAt(0);
      setSelection({
        text: selection.toString(),
        startOffset: range.startOffset,
        endOffset: range.endOffset
      });
    }
  };

  const handleCreateHighlight = (color, note) => {
    createHighlight({
      bookId,
      startLocation: selection.startOffset,
      endLocation: selection.endOffset,
      text: selection.text,
      note,
      color,
      visibility: 'public'
    });
    setSelection(null);
  };

  return (
    <div onMouseUp={handleTextSelection}>
      <BookContent bookId={bookId} />
      {selection && (
        <HighlightMenu
          selection={selection}
          onHighlight={handleCreateHighlight}
        />
      )}
    </div>
  );
}
```

**My Highlights Library:**
```typescript
function MyHighlights() {
  const [highlights, setHighlights] = useState([]);
  const [search, setSearch] = useState('');

  const searchHighlights = async (query) => {
    const response = await fetch(`/api/highlights/search?q=${query}`);
    const data = await response.json();
    setHighlights(data.highlights);
  };

  return (
    <div>
      <input
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          searchHighlights(e.target.value);
        }}
        placeholder="Search your highlights..."
      />
      <HighlightList highlights={highlights} />
    </div>
  );
}
```

**Popular Highlights Display:**
```typescript
function PopularHighlights({ bookId }) {
  const [highlights, setHighlights] = useState([]);

  useEffect(() => {
    fetch(`/api/books/${bookId}/popular-highlights`)
      .then(res => res.json())
      .then(data => setHighlights(data.highlights));
  }, [bookId]);

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Popular Highlights</h2>
      {highlights.map(highlight => (
        <div key={highlight.id} className="p-4 bg-yellow-50 rounded-lg">
          <p className="text-lg italic">"{highlight.text}"</p>
          <p className="text-sm text-gray-600 mt-2">
            {highlight.highlightCount} readers highlighted this
          </p>
        </div>
      ))}
    </div>
  );
}
```

## Admin Dashboard

### Engagement Metrics

**API: GET /api/admin/stats**
```typescript
async function getAdminStats(req, res) {
  const stats = await db.query(`
    SELECT
      COUNT(*) as total_highlights,
      COUNT(DISTINCT user_id) as active_users,
      COUNT(DISTINCT book_id) as books_with_highlights
    FROM highlights
    WHERE created_at > NOW() - INTERVAL '30 days'
  `);

  const topBooks = await db.query(`
    SELECT b.title, b.author, COUNT(*) as highlight_count
    FROM highlights h
    JOIN books b ON h.book_id = b.id
    WHERE h.created_at > NOW() - INTERVAL '30 days'
    GROUP BY b.id
    ORDER BY highlight_count DESC
    LIMIT 10
  `);

  res.json({
    stats: stats.rows[0],
    topBooks: topBooks.rows
  });
}
```

### Moderation Tools

**Flagging System:**
```sql
CREATE TABLE highlight_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id),
  reason VARCHAR(50) NOT NULL, -- spam, inappropriate, copyright
  status VARCHAR(20) DEFAULT 'pending', -- pending, resolved, dismissed
  created_at TIMESTAMP DEFAULT NOW()
);
```

**API: GET /api/admin/flags**
```typescript
async function getFlaggedHighlights(req, res) {
  const flags = await db.query(`
    SELECT f.id, f.reason, f.created_at,
           h.highlighted_text, h.personal_note,
           u.username as reporter
    FROM highlight_flags f
    JOIN highlights h ON f.highlight_id = h.id
    JOIN users u ON f.reporter_id = u.id
    WHERE f.status = 'pending'
    ORDER BY f.created_at DESC
  `);

  res.json({ flags: flags.rows });
}
```

## Implementation Phases

### Phase 1: Basic Highlighting (Core Functionality)
**Goal:** Users can create and view their own highlights

**Tasks:**
1. Setup PostgreSQL schema (users, books, highlights)
2. Implement authentication (session-based)
3. Create highlight API (create, read, update, delete)
4. Build simple reading interface (highlight text selection)
5. Display user's highlights library
6. Test locally with seed data

**Success Criteria:**
- Users can create highlights on a book
- Highlights persist across sessions
- Users can view all their highlights

### Phase 2: Real-time Sync
**Goal:** Highlights sync across devices in real-time

**Tasks:**
1. Setup Redis for session/device tracking
2. Implement WebSocket server (Socket.io)
3. Connect frontend to WebSocket
4. Implement real-time sync (create highlight on device A, appears on device B)
5. Handle offline devices (queue highlights for later sync)
6. Test with multiple browser windows (simulating devices)

**Success Criteria:**
- Create highlight in one browser window, appears instantly in another
- Offline queue works (disconnect, create highlight, reconnect, syncs)

### Phase 3: Popular Highlights Aggregation
**Goal:** Show community's most highlighted passages

**Tasks:**
1. Implement popular_highlights table
2. Create background job to aggregate highlights
3. Implement overlap detection algorithm
4. Cache popular highlights in Redis
5. Create API to fetch popular highlights
6. Display popular highlights in reading interface

**Success Criteria:**
- Popular highlights computed correctly (overlapping ranges merged)
- Popular highlights cached and served quickly (< 500ms)
- Updates every 5 minutes

### Phase 4: Search with Elasticsearch
**Goal:** Fast full-text search across highlights

**Tasks:**
1. Setup Elasticsearch container
2. Create highlights index
3. Implement indexing job (sync PostgreSQL → Elasticsearch)
4. Build search API
5. Create search UI
6. Test search with 10k highlights

**Success Criteria:**
- Search returns results in < 300ms
- Supports full-text search across text and notes
- Filters work (by book, date range)

### Phase 5: Social Features
**Goal:** Follow friends, see their highlights

**Tasks:**
1. Implement follows table
2. Create follow/unfollow API
3. Implement friends' highlights feed
4. Add privacy controls (public, friends, private)
5. Build social feed UI

**Success Criteria:**
- Users can follow each other
- Friends' public highlights appear in feed
- Privacy settings respected

### Phase 6: Admin Dashboard
**Goal:** Operational monitoring and moderation

**Tasks:**
1. Build admin stats API
2. Implement flagging system
3. Create admin UI (React dashboard)
4. Add moderation tools (hide/delete highlights)
5. Engagement metrics (top books, active users)

**Success Criteria:**
- Dashboard shows real-time stats
- Admins can moderate flagged content
- Engagement metrics visualized

## Distributed System Challenges

### Challenge 1: Conflict Resolution (Offline Edits)

**Problem:** User edits a highlight on Device A (offline), and also on Device B. Both sync when online.

**Solutions:**

**Option A: Last-Write-Wins (LWW)**
```typescript
// Each edit has a timestamp; latest timestamp wins
const conflict = await detectConflict(highlightId);
if (conflict) {
  const latest = conflict.edits.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
  await applyEdit(latest);
}
```

**Option B: Operational Transformation (OT)**
- Complex, but used by Google Docs
- Transform conflicting operations so they can both apply

**Option C: Manual Resolution**
- Show user both versions, let them choose

**Recommendation:** Option A (LWW) for simplicity. Conflicts are rare for highlights.

### Challenge 2: Popular Highlights Consistency

**Problem:** Cached popular highlights in Redis may be stale (new highlights created since last aggregation).

**Solutions:**

**Option A: Accept Eventual Consistency**
- Cache TTL = 5 minutes
- Users see slightly outdated popular highlights
- Acceptable for most use cases

**Option B: Incremental Updates**
```typescript
// When a highlight is created, immediately increment count
await redis.zincrby(`popular:book:${bookId}`, 1, `${startLocation}:${endLocation}`);
```

**Option C: Cache Invalidation**
- Invalidate cache on every new highlight
- Recompute on next request
- Slower, but always fresh

**Recommendation:** Option B (incremental updates) for real-time feel, with periodic full recomputation for accuracy.

### Challenge 3: Elasticsearch Index Lag

**Problem:** Highlights indexed in Elasticsearch with delay. Search results may be slightly stale.

**Solutions:**

**Option A: Near Real-time (NRT) Indexing**
```typescript
// Index in Elasticsearch immediately after database insert
await db.query('INSERT INTO highlights ...');
await elasticsearch.index({ ... }); // Async, but fast
```

**Option B: Bulk Indexing**
- Queue highlights in memory/Redis
- Bulk index every 10 seconds
- More efficient, but introduces lag

**Recommendation:** Option A for better UX. Elasticsearch is fast enough for real-time indexing.

## Testing Strategy

### Unit Tests
- Highlight overlap detection algorithm
- URL normalization (book locations)
- Privacy filter logic

### Integration Tests
- Create highlight → appears in database
- Create highlight → syncs to WebSocket
- Search highlights → Elasticsearch returns correct results

### End-to-End Tests
```typescript
test('highlight syncs across devices', async () => {
  // Setup: Two browser instances, logged in as same user
  const device1 = await browser.newPage();
  const device2 = await browser.newPage();

  await device1.goto('/books/123');
  await device2.goto('/books/123');

  // Action: Create highlight on device 1
  await device1.selectText('To be or not to be');
  await device1.click('.highlight-button');

  // Verify: Highlight appears on device 2 within 2 seconds
  await device2.waitForSelector('.highlight', { timeout: 2000 });
  const highlightText = await device2.textContent('.highlight');
  expect(highlightText).toContain('To be or not to be');
});
```

## Local Development Setup

### Docker Compose
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: highlights
    ports:
      - "5432:5432"

  redis:
    image: redis:7
    ports:
      - "6379:6379"

  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
```

### Running the System
```bash
# 1. Start infrastructure
docker-compose up -d

# 2. Run migrations
npm run migrate

# 3. Seed data (books and test users)
npm run seed

# 4. Start API server
npm run api

# 5. Start frontend
cd frontend && npm run dev

# 6. Open browser
open http://localhost:5173
```

## Learning Outcomes

By implementing this system, you will learn:

1. **Real-time Systems**
   - WebSocket for bi-directional communication
   - Pub/Sub patterns (Redis)
   - Offline-first design (queue and sync)

2. **Data Aggregation**
   - Computing popular items efficiently
   - Handling overlapping ranges
   - Caching aggregations (Redis)

3. **Search Systems**
   - Elasticsearch indexing and querying
   - Full-text search optimization
   - Faceted search (filters)

4. **Privacy & Social Features**
   - Multi-level privacy controls
   - Social graph (follows)
   - Newsfeed algorithms

5. **Distributed Consistency**
   - Eventual consistency trade-offs
   - Conflict resolution strategies
   - Cache invalidation patterns

## Next Steps / Extensions

1. **Mobile Apps**
   - Native iOS/Android apps with offline support
   - Background sync

2. **AI Features**
   - Summarize highlights automatically
   - Suggest related books based on highlights
   - Detect themes in a user's highlights

3. **Export & Integrations**
   - Export to Notion, Evernote, Obsidian
   - Share highlights as images (for social media)
   - Email digests of highlights

4. **Analytics for Authors**
   - Heatmap of highlighted passages
   - Reader engagement metrics
   - Feedback from highlights

5. **Collaborative Annotations**
   - Book clubs (shared highlights and discussions)
   - Threaded comments on highlights
   - Group reading challenges

## References

- [Kindle Popular Highlights](https://www.amazon.com/kindle-dbs/highlights/)
- [Readwise: Highlight Aggregation](https://readwise.io/)
- [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation)
- [CRDTs for Eventual Consistency](https://crdt.tech/)
- [Socket.io Documentation](https://socket.io/docs/v4/)
- [Elasticsearch Text Search](https://www.elastic.co/guide/en/elasticsearch/reference/current/full-text-queries.html)
