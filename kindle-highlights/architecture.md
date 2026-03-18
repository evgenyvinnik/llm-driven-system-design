# Design Kindle Community Highlights - Architecture

## System Overview

A social reading platform enabling users to highlight passages in books, sync highlights across devices in real time, and discover popular community highlights. The system handles offline-first clients, privacy-preserving aggregation, and social features (follow, share, export).

**Learning Goals:**
- Build real-time sync across devices via WebSocket push
- Design aggregation at scale (billions of highlights)
- Implement privacy-preserving community features
- Handle offline-first architecture with conflict resolution

## Requirements

### Functional Requirements

1. **Highlight**: Create, edit, delete highlights with color and notes
2. **Sync**: Real-time sync across all user devices within 2 seconds
3. **Discover**: View popular highlights in any book, ranked by highlight count
4. **Social**: Follow readers, view friends' highlights, share to external platforms
5. **Export**: Export personal highlights in Markdown, CSV, and JSON formats
6. **Privacy**: Per-highlight visibility (private, friends, public) and per-user privacy settings

### Non-Functional Requirements

- **Sync Latency**: < 2 seconds cross-device (p95)
- **Scale**: 10M users, 1B highlights stored
- **Read Throughput**: 100K highlight views/second for popular books
- **Write Throughput**: 10K highlights created/second globally
- **Privacy**: Community highlights are anonymized; aggregation respects opt-in settings
- **Availability**: 99.9% uptime for read operations, 99.5% for writes

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Users | 10M registered, 1M DAU | -- |
| Highlights | 1B total, 5M created/day | ~100 per active user per day |
| Books | 5M in catalog | -- |
| Popular highlights | 50M aggregated passages | Top 10 per popular book |
| WebSocket connections | 2M concurrent | 2 devices per active user |
| Sync events/sec | 60 RPS peak | 5M highlights/day / 86,400s |
| Popular highlights reads | 100K RPS | Hot path, heavily cached |
| Storage (highlights) | ~500 GB | 1B rows x ~500 bytes avg |
| Storage (popular) | ~5 GB | 50M rows x ~100 bytes |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 10 seeded accounts |
| Highlights | ~500 seeded |
| WebSocket connections | 1-5 |
| Sync events/sec | < 1 |
| PostgreSQL storage | < 50 MB |
| Redis memory | < 10 MB |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Devices                               │
│            Kindle  │  iOS App  │  Android App  │  Web Reader           │
│                                                                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐              │
│  │  Local DB     │  │  Sync Engine  │  │  UI Layer     │              │
│  │  (SQLite)     │  │  (WebSocket)  │  │               │              │
│  └───────────────┘  └───────────────┘  └───────────────┘              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS + WSS
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         API Gateway / CDN                              │
│           TLS termination, rate limiting, geographic routing           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ Highlight Service│ │   Sync Service   │ │  Social Service  │
│                  │ │                  │ │                  │
│ CRUD operations  │ │ WebSocket server │ │ Auth, follow,    │
│ Search, export   │ │ Device registry  │ │ share, privacy   │
│ Idempotency      │ │ Offline queue    │ │                  │
│                  │ │ Conflict resolve │ │                  │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                     │
         └────────┬───────────┴──────────┬──────────┘
                  │                      │
         ┌────────┴────────┐    ┌────────┴────────┐
         ▼                 ▼    ▼                  ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   PostgreSQL     │ │   Redis/Valkey   │ │ Aggregation      │
│                  │ │                  │ │ Worker            │
│ users            │ │ Sessions         │ │                  │
│ books            │ │ Sync queues      │ │ Redis counters   │
│ highlights       │ │ Popular cache    │ │ → PostgreSQL     │
│ follows          │ │ Aggregation      │ │   batch sync     │
│ popular_*        │ │ counters         │ │                  │
│ privacy          │ │                  │ │                  │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

## Core Components

### Highlight Service

Handles CRUD operations on highlights with full-text search and export.

**Create highlight flow**:
1. Validate input (book exists, location range valid, color in palette)
2. Check idempotency key in Redis (prevent duplicate creates from retries)
3. Insert into `highlights` table within a transaction
4. Update `user_books` reading progress
5. If visibility is `public` and user has opted into aggregation, increment Redis counter for the passage
6. Store idempotency result in Redis (24-hour TTL)
7. Push sync event to all user's other connected devices via Sync Service

**Search**: PostgreSQL full-text search on `highlighted_text` and `note` fields. At production scale, an Elasticsearch cluster would handle search to avoid loading PostgreSQL with LIKE queries.

**Export**: Generate Markdown, CSV, or JSON from a user's highlights, filtered by book, date range, or tag.

### Sync Service

Maintains WebSocket connections for real-time cross-device synchronization.

**Sync protocol**:
1. Device connects via WebSocket, authenticates with session token
2. Server registers device in connection map (in-memory) and Redis (for cross-server awareness)
3. On highlight create/edit/delete, server pushes sync event to all user's connected devices
4. If a device is offline, event is queued in Redis with 30-day TTL
5. On reconnect, device sends `lastSyncTimestamp` and receives all queued events

**Conflict resolution**: Last-write-wins using `updated_at` timestamps. If two devices edit the same highlight offline, the edit with the later timestamp wins. This is acceptable because highlight edits are rare and conflicts are rarer.

**Why not CRDTs**: CRDTs (Conflict-free Replicated Data Types) provide mathematically guaranteed convergence without coordination. For highlights, the data model is simple (text + color + note), edits are infrequent, and users rarely edit the same highlight from two devices simultaneously. Last-write-wins with timestamp comparison handles the vanishingly rare conflict case with far less implementation complexity. CRDTs would be appropriate for a collaborative text editor where concurrent character-level edits are common.

### Aggregation Service

Computes and serves popular highlights per book.

**Two-phase counting**:
1. **Real-time phase**: When a public highlight is created, `HINCRBY` increments a Redis hash counter for the book's passage (`book:{bookId}:highlights` → `{passageId}: count`)
2. **Batch phase**: Background worker runs every 5 minutes, syncing Redis counters to the `popular_highlights` PostgreSQL table with passage text samples

**Passage normalization**: Highlights on similar passages are grouped using 100-character normalized windows. This balances precision (grouping "similar enough" selections) against over-aggregation (merging clearly distinct passages).

**Why Redis counters + batch sync (not real-time SQL)**:
- At 10K highlights/second, running `UPDATE popular_highlights SET count = count + 1` on every create would generate 10K PostgreSQL writes/second on the same hot rows, causing lock contention and WAL amplification
- Redis `HINCRBY` handles 100K+ increments/second without breaking a sweat
- The 5-minute batch sync means popular highlight counts are eventually consistent (5 minutes stale at worst), which is perfectly acceptable for a "X people highlighted this" feature

**What we give up**: Real-time accuracy. A highlight created at t=0 may not appear in the "popular" count until t=5min. For a reading platform where users spend 30+ minutes per session, this delay is imperceptible.

### Social Service

Handles authentication, follows, sharing, and privacy settings.

**Follow model**: Directed graph (`follows` table). Following enables viewing a user's `friends`-visibility highlights for shared books.

**Privacy enforcement**: Three visibility levels per highlight:
- `private`: Only the owner sees it
- `friends`: Owner + followers see it
- `public`: Everyone sees it; included in aggregation if user has opted in

Privacy settings are enforced at query time: the Social Service joins `highlights` with `follows` and `user_privacy_settings` to filter results.

**Sharing**: Generate formatted text ("highlighted text" -- Author, Book Title) with a shareable link. Log share events for analytics.

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(500),
  bio TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- Books catalog
CREATE TABLE books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  author VARCHAR(200),
  isbn VARCHAR(20),
  publisher VARCHAR(200),
  description TEXT,
  cover_url VARCHAR(500),
  total_locations INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_books_isbn ON books(isbn);
CREATE INDEX idx_books_title ON books(title);

-- User-book associations (reading progress)
CREATE TABLE user_books (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  book_id UUID REFERENCES books(id) ON DELETE CASCADE,
  progress_location INTEGER DEFAULT 0,
  last_read_at TIMESTAMP DEFAULT NOW(),
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, book_id)
);

CREATE INDEX idx_user_books_user ON user_books(user_id);
CREATE INDEX idx_user_books_book ON user_books(book_id);

-- User highlights with sync support
CREATE TABLE highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  location_start INTEGER NOT NULL,
  location_end INTEGER NOT NULL,
  highlighted_text TEXT NOT NULL,
  note TEXT,
  color VARCHAR(20) DEFAULT 'yellow',
  visibility VARCHAR(20) DEFAULT 'private',
  archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_highlights_user ON highlights(user_id, created_at DESC);
CREATE INDEX idx_highlights_book ON highlights(book_id);
CREATE INDEX idx_highlights_location ON highlights(book_id, location_start, location_end);
CREATE INDEX idx_highlights_visibility ON highlights(visibility) WHERE archived = false;

-- Soft deletes for cross-device sync
CREATE TABLE deleted_highlights (
  highlight_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_deleted_highlights_user ON deleted_highlights(user_id);

-- Aggregated popular highlights
CREATE TABLE popular_highlights (
  book_id UUID REFERENCES books(id) ON DELETE CASCADE,
  passage_id VARCHAR(50),
  passage_text TEXT,
  highlight_count INTEGER DEFAULT 0,
  location_start INTEGER,
  location_end INTEGER,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (book_id, passage_id)
);

CREATE INDEX idx_popular_count ON popular_highlights(book_id, highlight_count DESC);

-- Social follows (directed graph)
CREATE TABLE follows (
  follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX idx_follows_followee ON follows(followee_id);
CREATE INDEX idx_follows_follower ON follows(follower_id);

-- Per-user privacy settings
CREATE TABLE user_privacy_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  highlight_visibility VARCHAR(20) DEFAULT 'private',
  allow_followers BOOLEAN DEFAULT true,
  include_in_aggregation BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id VARCHAR(100) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Redis Data Structures

```
# Session tokens
session:{sessionId} = { userId, email, expiresAt }
TTL: 24 hours

# Sync offline queue (per user per device)
sync:queue:{userId}:{deviceId} = [event1, event2, ...]
TTL: 30 days

# Aggregation counters (per book)
book:{bookId}:highlights = { passageId1: count, passageId2: count, ... }
No TTL (persistent, synced to PostgreSQL by worker)

# Popular highlights cache
popular:{bookId} = [{ passageText, count, locationStart, locationEnd }, ...]
TTL: 5 minutes

# Idempotency keys
idempotency:{key} = { result }
TTL: 24 hours
```

## API Design

### Highlight Service (port 3001)

```
POST   /api/highlights                → Create highlight
GET    /api/highlights                → List user's highlights (with filters)
GET    /api/highlights/:id            → Get single highlight
PUT    /api/highlights/:id            → Update highlight
DELETE /api/highlights/:id            → Delete highlight (soft delete)
GET    /api/highlights/search?q=      → Full-text search
GET    /api/highlights/export         → Export in Markdown/CSV/JSON
```

### Sync Service (port 3002)

```
WebSocket /ws/sync                    → Real-time sync connection
GET    /api/sync/status               → Sync status for current user
POST   /api/sync/pull                 → Pull missed events since timestamp
```

### Aggregation Service (port 3003)

```
GET    /api/popular/:bookId           → Popular highlights for a book
GET    /api/trending                  → Trending highlights across all books
```

### Social Service (port 3004)

```
POST   /api/auth/register             → Create account
POST   /api/auth/login                → Login
POST   /api/auth/logout               → Logout
GET    /api/auth/me                   → Current user

POST   /api/social/follow/:userId     → Follow a user
DELETE /api/social/follow/:userId     → Unfollow a user
GET    /api/social/followers          → My followers
GET    /api/social/following          → People I follow
GET    /api/social/friends-highlights/:bookId → Friends' highlights for a book

POST   /api/social/share/:highlightId → Share highlight to external platform
PUT    /api/privacy/settings          → Update privacy settings
GET    /api/privacy/settings          → Get privacy settings
```

## Key Design Decisions

### Sync Protocol: WebSocket Push with Offline Queue

**Chosen**: Persistent WebSocket connections for connected devices. Redis-backed queue for offline devices.

**Why WebSocket over polling**: The sync requirement is < 2 seconds cross-device. HTTP polling at 2-second intervals means average 1-second latency plus the overhead of 30 requests/minute per device for a mostly-idle connection. WebSocket pushes the event immediately when it happens, achieving sub-second sync with zero wasted requests.

**Why not Server-Sent Events (SSE)**: SSE is unidirectional (server → client). The sync protocol needs bidirectional communication -- the client needs to send sync acknowledgments, request missed events, and report connection state. WebSocket supports both directions natively.

**Offline queue design**: When a device disconnects, sync events are appended to a Redis list keyed by `sync:queue:{userId}:{deviceId}` with 30-day TTL. On reconnect, the device sends its `lastSyncTimestamp`, and the server replays all queued events newer than that timestamp. This ensures devices that have been offline for weeks (e.g., a Kindle left in a drawer) still receive all updates.

**What we give up**: WebSocket connections are stateful and harder to load-balance than stateless HTTP. Adding a new server requires sticky sessions or a Redis-backed connection registry. Connection drops require client-side reconnection logic with exponential backoff.

### Aggregation: Redis Counters with Batch Sync to PostgreSQL

**Chosen**: Real-time increments in Redis hashes, batch sync to PostgreSQL every 5 minutes.

**Why not real-time SQL aggregation**: At scale, 10K highlights/second touching the same `popular_highlights` rows creates severe lock contention. PostgreSQL's MVCC handles concurrent reads well, but concurrent increments on the same row serialize on the row lock. Redis hash increments are single-threaded and lock-free, handling 100K+ operations/second.

**Why not pre-compute on read**: Computing `SELECT book_id, passage_id, COUNT(*) FROM highlights GROUP BY ...` on every popular-highlights API call would scan millions of rows. With 100K reads/second on popular books, this would collapse the database. Pre-computing and caching is the only viable approach.

**What we give up**: Popular highlight counts are eventually consistent (up to 5 minutes stale). A newly created highlight will not appear in the "popular" list immediately. For a reading platform, this latency is invisible -- users spend minutes to hours reading before checking popular highlights.

### Privacy: Per-Highlight Visibility with Query-Time Enforcement

**Chosen**: Each highlight has a `visibility` field (private/friends/public). Privacy is enforced by JOINing with the `follows` table and `user_privacy_settings` at query time.

**Why query-time enforcement (not materialized views)**: Materialized views for "highlights visible to user X" would require refreshing whenever a follow relationship changes, a privacy setting changes, or a highlight's visibility changes. The combinatorial explosion (10M users x their visible highlights) makes pre-computation infeasible.

**Why per-highlight visibility (not per-user only)**: Users want fine-grained control. A reader might share a profound quote publicly while keeping personal annotations private. Per-user defaults (in `user_privacy_settings`) set the default for new highlights, but per-highlight overrides enable this flexibility.

**What we give up**: Query complexity. Every highlights query must JOIN with follows and privacy settings, adding latency. Mitigation: index on `(visibility) WHERE archived = false` and Redis caching for frequently-accessed data (popular highlights, friends' highlights).

### Conflict Resolution: Last-Write-Wins with Timestamps

**Chosen**: When two devices edit the same highlight offline, the edit with the later `updated_at` timestamp wins.

**Why not operational transform (OT)**: OT is designed for real-time collaborative editing where multiple users modify the same document simultaneously. Highlights are owned by a single user who occasionally edits from different devices. The probability of concurrent edits on the same highlight is extremely low (editing the note on your phone while simultaneously editing it on your Kindle). When it does happen, keeping the most recent edit is intuitive behavior.

**Why not CRDTs**: CRDTs guarantee convergence without coordination but require every field to be modeled as a CRDT type (e.g., LWW-Register, G-Counter). For a highlight (text, color, note), this adds implementation complexity with no practical benefit given the low conflict probability.

**What we give up**: In the rare case of concurrent offline edits, one edit is silently lost. The user sees the "newer" version on sync. For highlight notes, this is acceptable -- the user can re-edit.

## Consistency and Idempotency

### Idempotency Keys

All write operations accept a client-generated idempotency key (via header or request body):

1. Before processing, check Redis for `idempotency:{key}`
2. If found, return the cached result (preventing duplicate creates)
3. If not found, process the operation
4. Store the result in Redis with 24-hour TTL
5. Also store an `idempotency_key` column in PostgreSQL for database-level deduplication within a transaction

This handles network retries, client-side double-taps, and load balancer request duplication.

### Soft Deletes for Sync

Highlights are not physically deleted. Instead, a record is inserted into `deleted_highlights` with the highlight's UUID. This allows the sync protocol to propagate deletions to offline devices -- without the tombstone, a reconnecting device would not know to delete the highlight locally.

Tombstones are retained for 90 days (longer than the 30-day offline queue TTL), ensuring any device that reconnects within 30 days receives the deletion event.

## Security

### Authentication

Session-based authentication with tokens stored in Redis (24-hour TTL). Passwords hashed with bcrypt. Sessions are revocable server-side by deleting the Redis key.

### Authorization

| Resource | Owner | Followers | Public |
|----------|-------|-----------|--------|
| Private highlights | Read/Write | -- | -- |
| Friends highlights | Read/Write | Read | -- |
| Public highlights | Read/Write | Read | Read |
| Privacy settings | Read/Write | -- | -- |
| Follow relationship | Create/Delete | -- | -- |

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| Highlight create | 100 per minute | Per user |
| Auth attempts | 5 per minute | Per IP |
| Export | 10 per hour | Per user |
| Search | 30 per minute | Per user |
| API requests | 1000 per minute | Per user |

## Observability

### Metrics

**Highlight operations**:
- `highlight_operation_duration_seconds{operation,status}` -- Histogram [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
- `highlights_created_total{book_id}` -- Counter per book

**Sync**:
- `websocket_active_connections` -- Gauge
- `sync_queue_depth{user_id}` -- Gauge (pending events per user)
- `sync_latency_seconds` -- Histogram (time from create to WebSocket delivery)

**Aggregation**:
- `aggregation_job_duration_seconds` -- Histogram
- `cache_hits_total` / `cache_misses_total` -- Popular highlights cache effectiveness

**SLIs**:

| SLI | Target | Measurement |
|-----|--------|-------------|
| Highlight creation latency | p99 < 200ms | `highlight_operation_duration_seconds{operation="create"}` |
| Cross-device sync latency | p95 < 2s | Time from create to WebSocket delivery |
| Popular highlights cache hit rate | > 90% | `cache_hits / (cache_hits + cache_misses)` |
| API availability | 99.5% | Successful responses / total requests |

### Structured Logging (Pino)

JSON-formatted logs with service-scoped child loggers.

**Log levels**:
- `error`: Failed operations, database errors, unhandled exceptions
- `warn`: Retry attempts, degraded performance, approaching limits
- `info`: Successful operations, sync events, aggregation jobs
- `debug`: Request/response details, cache operations (dev only)

**Key events logged**:
- `highlight_created` -- userId, bookId, highlightId, location, durationMs
- `sync_pushed` -- userId, deviceCount, queuedCount
- `aggregation_completed` -- booksProcessed, durationMs
- `privacy_changed` -- userId, oldSettings, newSettings

### Alert Thresholds

| Alert | Condition | Action |
|-------|-----------|--------|
| High API latency | p99 > 500ms for 5 min | Check database queries, Redis connection |
| Sync queue backlog | Queue depth > 100 per user | Investigate WebSocket disconnections |
| Cache miss spike | Hit rate < 70% for 10 min | Check Redis memory, TTL configuration |
| Error rate increase | > 5% errors for 5 min | Check logs for root cause |
| WebSocket disconnections | > 10 disconnects/min | Check network, server memory |

## Failure Handling

### Retry Strategy with Idempotency

All write operations use exponential backoff with jitter:
- Max retries: 3
- Base delay: 100ms, max delay: 5s, multiplier: 2x
- Retryable errors: ECONNRESET, ETIMEDOUT, ECONNREFUSED, 503, 429
- Idempotency keys ensure retries are safe (no duplicate side effects)

### Circuit Breaker Pattern

Downstream services (PostgreSQL, Redis, Elasticsearch at scale) are protected by circuit breakers:

| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| PostgreSQL | 3s | 50% over 5 requests | 30s |
| Redis | 1s | 60% over 5 requests | 10s |
| Elasticsearch (future) | 3s | 50% over 5 requests | 30s |

**Fallback behaviors**:
- Redis read fails → return null (cache miss, fall through to PostgreSQL)
- Redis write fails → queue write in PostgreSQL fallback table
- PostgreSQL read fails → return cached data if available, error otherwise
- Elasticsearch fails → fall back to PostgreSQL ILIKE search (slower but functional)

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Sync service down | Highlights still created in DB; sync queued, delivered on recovery |
| Aggregation worker down | Popular counts stale until worker recovers |
| Redis down | Sessions fall back to PostgreSQL; popular highlights served from DB |
| Search fails | Disable search feature, show browse-only UI |

## Scalability Considerations

### Horizontal Scaling Path

1. **< 10K users**: Single instance of each service, single PostgreSQL, single Redis
2. **10K-100K users**: Multiple service instances behind LB, PostgreSQL read replicas, Redis Sentinel
3. **100K-1M users**: Elasticsearch for search, Kafka for event streaming, database sharding by user_id
4. **1M-10M users**: CDN for book metadata, geographic distribution, dedicated aggregation pipeline

### Bottleneck Analysis

| Component | Bottleneck | Threshold | Solution |
|-----------|------------|-----------|----------|
| PostgreSQL writes | Highlights table | ~10K inserts/sec | Shard by user_id, batch inserts |
| PostgreSQL reads | Popular highlights queries | ~5K queries/sec | Redis cache with 5-min TTL |
| Redis memory | Aggregation counters + sync queues | ~500 MB for 1M users | Redis Cluster, eviction policy |
| WebSocket connections | Per-server connection limit | ~10K per server | Add servers, sticky LB |
| Sync fanout | Multi-device broadcast | ~5 devices per user | Connection registry in Redis |

### Storage Tiering (production)

| Data Age | Storage Tier | Access Pattern |
|----------|--------------|----------------|
| 0-30 days | PostgreSQL (SSD) | Full indexing, fast queries |
| 30-365 days | PostgreSQL (HDD) | Partial indexing, slower queries |
| > 1 year | Object storage (S3) | Archive, no indexing, retrieve on demand |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Sync protocol | WebSocket push | HTTP polling | Sub-2s sync; polling wastes bandwidth on idle connections |
| Aggregation | Redis counters + batch sync | Real-time SQL | 100x write throughput; 5-min staleness acceptable |
| Passage grouping | 100-char normalized windows | Exact matching | Practical grouping of "similar enough" selections |
| Conflict resolution | Last-write-wins (timestamps) | CRDTs | Simple, sufficient for low-conflict highlights |
| Privacy enforcement | Query-time JOINs | Materialized views | Avoids combinatorial explosion of pre-computation |
| Soft deletes | Tombstone table | Physical delete | Enables sync propagation to offline devices |
| Session storage | Redis tokens | JWT | Immediate revocation, server-controlled expiry |
| Search (production) | Elasticsearch | PostgreSQL LIKE | 10x faster for large datasets; PG fallback available |

## Implementation Notes

This section maps the production architecture to the actual local implementation, documenting production-grade patterns used, simplifications, and omissions.

### Local Setup

```
┌────────────────────────────────────────────────────────────────────┐
│                   React Frontend (:5173)                          │
│   TanStack Router, Zustand state, Tailwind CSS                   │
│   Library, Book detail, Trending, Export views                   │
│   Vite proxy → backend services                                  │
└──────────────────┬───────────────────┬─────────────────────────────┘
                   │ HTTP              │ WS
    ┌──────────────┴──────┐    ┌───────┴──────────┐
    ▼                     ▼    ▼                  ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│Highlight │  │  Social  │  │   Sync   │  │ Aggreg.  │
│ Service  │  │ Service  │  │ Service  │  │ Service  │
│ (:3001)  │  │ (:3004)  │  │ (:3002)  │  │ (:3003)  │
│          │  │          │  │          │  │          │
│ CRUD,    │  │ Auth,    │  │ WebSocket│  │ Popular  │
│ search,  │  │ follow,  │  │ push,    │  │ highlights│
│ export   │  │ share,   │  │ offline  │  │ API      │
│          │  │ privacy  │  │ queue    │  │          │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     └──────┬──────┴──────┬──────┴──────┬───────┘
            ▼             ▼             ▼
     ┌────────────┐  ┌──────────┐  ┌──────────┐
     │ PostgreSQL │  │  Valkey  │  │ Aggreg.  │
     │  (:5432)   │  │ (:6379)  │  │ Worker   │
     │            │  │          │  │ (bg job) │
     │ highlights │  │ sessions │  │          │
     │ books      │  │ sync     │  │ Redis →  │
     │ users      │  │ queues   │  │ Postgres │
     │ follows    │  │ popular  │  │ batch    │
     │ popular_*  │  │ cache    │  │ sync     │
     │ privacy    │  │ counters │  │          │
     └────────────┘  └──────────┘  └──────────┘
```

All services started concurrently via `npm run dev` (uses `concurrently` to run all `dev:*` scripts).

### Production-Grade Patterns Implemented

**Microservice decomposition** (`backend/src/{highlight,sync,aggregation,social}/`): Four separate Express services, each with its own port and responsibility. Services share database and cache connections via shared modules but run as independent processes.

**WebSocket sync with offline queue** (`backend/src/sync/app.ts`): Persistent WebSocket connections with device registration. Push sync events to all connected devices. Redis-backed offline queue with 30-day TTL for disconnected devices. Last-write-wins conflict resolution using timestamps.

**Background aggregation worker** (`backend/src/aggregation/worker.ts`): Separate background process that periodically syncs Redis counters to PostgreSQL `popular_highlights` table. Decoupled from the API servers so aggregation work does not impact user-facing latency.

**Privacy-preserving queries** (`backend/src/social/app.ts`): Friends' highlights queries JOIN with `follows` and `user_privacy_settings` tables to enforce per-highlight and per-user visibility rules at query time.

**Structured logging (Pino)** (`backend/src/shared/logger.ts`): JSON-formatted output in production, pretty-print in development. Service-scoped child loggers via `createLogger(serviceName)`.

**Session-based auth** (`backend/src/shared/auth.ts`): Session tokens stored in Redis with 24-hour TTL. Middleware validates session on every request.

**Database migrations** (`backend/src/db/migrate.ts`, `backend/src/db/init.sql`): Full SQL schema with indexes, constraints, and foreign keys. Migration runner executes `init.sql` against PostgreSQL.

**Seed data** (`backend/src/db/seed.ts`): Demo data with users, books, highlights, follows, and privacy settings for local development and screenshot automation.

**Redis caching** (`backend/src/shared/cache.ts`): Popular highlights cached in Redis with 5-minute TTL. Cache-aside pattern -- check Redis first, fall through to PostgreSQL on miss.

**Multi-format export** (`backend/src/highlight/app.ts`): Export highlights as Markdown, CSV, or JSON with book/date filtering.

### Simplifications

| Production Design | Local Simplification |
|-------------------|---------------------|
| API Gateway with rate limiting | Direct service access via Vite proxy |
| Elasticsearch for full-text search | PostgreSQL ILIKE queries |
| Redis Sentinel/Cluster for HA | Single Valkey instance |
| PostgreSQL read replicas | Single PostgreSQL instance |
| Kafka for event streaming | Direct WebSocket push + Redis queues |
| CDN for book covers and static assets | Vite dev server |
| OAuth / JWT for mobile clients | Simple session tokens |
| Storage tiering (SSD → HDD → S3) | All data in single PostgreSQL |
| Database sharding by user_id | Single database, no sharding |
| Horizontal scaling of services | Single instance per service |

### What Was Omitted

- **Elasticsearch**: Full-text search uses PostgreSQL; Elasticsearch would be needed at scale
- **Kafka**: Event streaming for cross-service communication; replaced by direct Redis pub/sub and WebSocket
- **CDN**: No content delivery network for static assets or book metadata
- **Multi-region**: No geographic distribution or cross-region replication
- **Kubernetes**: No container orchestration or auto-scaling
- **Circuit breakers**: Not implemented in this project (documented in architecture for production)
- **Prometheus metrics (prom-client)**: Not instrumented; Pino logging provides observability
- **Client-side SQLite**: No offline-first local database on the client; the web frontend fetches from the API
- **Storage tiering**: No archival of old highlights to cold storage
- **Audit logging**: No separate audit table for security-relevant events
