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

Handles CRUD operations on highlights with keyword search and export.

**Create highlight flow**:
1. Validate input (book exists, location range valid, color in palette)
2. Check idempotency key in Redis (prevent duplicate creates from retries)
3. Insert into `highlights` table within a transaction
4. Update `user_books` reading progress
5. If visibility is `public` and user has opted into aggregation, increment Redis counter for the passage
6. Store idempotency result in Redis (24-hour TTL)
7. Push sync event to all user's other connected devices via Sync Service

**Search**: locally, a case-insensitive substring match (`ILIKE`) on the `highlighted_text` and `note` fields, always scoped to the requesting user's own highlights. At production scale this moves to an Elasticsearch cluster — `ILIKE` is scan-heavy and index-unfriendly, so it would overload PostgreSQL as highlight volume grows.

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

## Frontend Architecture

### Component Hierarchy

```
App (TanStack Router)
├── __root.tsx (RootLayout)
│   ├── Header: nav links (Library, Trending, Export), user greeting, logout
│   ├── <Outlet /> ──▶ routes
│   └── Footer
│
├── / (LandingPage)
│   └── Welcome content with login/register CTAs
│
├── /login (LoginPage)
│   └── Email + password form
│
├── /register (RegisterPage)
│   └── Email + username + password form
│
├── /library (LibraryPage)
│   ├── View toggle: Books | All Highlights
│   ├── Search bar (full-text search)
│   ├── BooksView
│   │   └── Book cards (grid layout: title, author, highlight count, last read)
│   └── HighlightsView
│       └── HighlightCard (blockquote with color styling + note)
│
├── /books/$bookId (BookDetailPage)
│   ├── Book title + author header
│   ├── Tab bar: My Highlights | Popular | Friends
│   ├── MyHighlightCard (with inline note editing, delete)
│   ├── PopularHighlightCard (passage text + reader count)
│   └── FriendHighlightCard (avatar + username + passage)
│
├── /trending (TrendingPage)
│   └── Trending highlights across all books
│
└── /export (ExportPage)
    └── Format selector (Markdown/CSV/JSON) + export button
```

### Zustand Store

A single Zustand store (`useStore`) with `persist` middleware manages all global state:

**Auth state**: `user` (User object or null), `isAuthenticated` (derived boolean). The `persist` middleware stores only `user` and `isAuthenticated` in `localStorage` under the key `kindle-highlights-storage`, so the user stays logged in across page reloads. The `logout` action clears the localStorage `sessionId`, resets user state, and empties cached data arrays.

**Highlights state**: `highlights` array with `setHighlights`, `addHighlight`, `removeHighlight`, and `updateHighlightInStore` mutators. Highlights are loaded from the API on page navigation and cached in the store for immediate rendering.

**Library state**: `library` (array of Book objects with highlight counts) with `setLibrary`. Loaded alongside highlights on the library page.

**UI state**: `selectedBookId` (currently viewed book) and `searchQuery` (search input value). These are persisted across navigation so the search bar retains its value when switching between views.

### Routing

TanStack Router with file-based routing provides six routes:
- `/` -- Landing page (unauthenticated welcome)
- `/login` -- Login form, stores session ID in `localStorage` on success
- `/register` -- Registration form
- `/library` -- User's books and highlights (requires auth)
- `/books/$bookId` -- Book detail with tabbed highlight views (requires auth)
- `/trending` -- Trending highlights across the platform (requires auth)
- `/export` -- Export highlights in multiple formats (requires auth)

The root layout provides navigation links that change based on `isAuthenticated` -- unauthenticated users see Login/Sign Up, authenticated users see Library/Trending/Export.

### Data Fetching

All API calls go through `api/client.ts`, a typed API client module. Authentication uses Bearer tokens -- the session ID is stored in `localStorage` and attached as an `Authorization: Bearer {sessionId}` header on every request. The Vite dev server proxies `/api` requests to the four backend services.

**Library page loading**: On mount, the library page calls `getLibrary()` and `getHighlights()` in parallel via `Promise.all`. Both results are stored in the Zustand store. Subsequent visits to the library page re-fetch to ensure freshness.

**Book detail page loading**: Uses `Promise.all` to fetch three data sets simultaneously: the user's highlights for this book (`getHighlights({bookId})`), popular highlights (`getPopularHighlights(bookId)`), and friends' highlights (`getFriendsHighlights(bookId)`). Each is stored in local component state (not the global store) because these are page-specific and do not need to persist across navigation.

**Search**: The library page search form updates `searchQuery` in the store and triggers a re-fetch of highlights with the search parameter. The backend performs full-text search via PostgreSQL.

### Key UI Patterns

**Color-coded highlights**: Each highlight has a `color` field (yellow, green, blue, pink). The frontend maps these to CSS classes like `highlight-yellow` that apply background colors to blockquote elements. This creates the familiar Kindle highlighting experience where different colors serve different purposes (important passages, questions, favorites).

**Three-tab book detail view**: The `BookDetailPage` uses a tab bar to switch between "My Highlights," "Popular," and "Friends" views. Each tab has a count badge showing how many highlights exist. The tabs load all data upfront (via the parallel `Promise.all` fetch) rather than lazy-loading per tab, since highlight lists are small enough that the bandwidth cost is negligible.

**Inline note editing**: `MyHighlightCard` supports inline editing of the note field. Clicking "Edit" toggles the card into edit mode, showing a textarea pre-filled with the existing note. "Save" calls `updateHighlight` and updates local state. "Cancel" reverts to view mode. This avoids opening a separate modal for a simple text edit.

**Popular highlights with social proof**: `PopularHighlightCard` displays the passage text in a yellow-tinted blockquote with a footer showing "N readers highlighted this passage." This count comes from the aggregation service's batch-synced Redis counters.

**Friend highlight attribution**: `FriendHighlightCard` shows the friend's avatar (first letter of username in a circle) and username above the highlighted passage. This creates a social reading experience where you can see what your friends found interesting in the same book.

**Multi-format export**: The export page lets users choose between Markdown, CSV, and JSON formats. The API returns the formatted text directly (not JSON-wrapped), and the frontend displays or downloads it.

## Production-Grade Pattern Deep Dives

This section explains each production-grade pattern referenced in the architecture, written for readers encountering these concepts for the first time.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "hit"), it is returned immediately without touching the database. If not (a "miss"), the application queries the database, stores the result in the cache with a TTL (time-to-live), and returns it.

**How it works step by step**: (1) A request arrives for popular highlights of a book. (2) Check Redis: `GET popular:{bookId}`. (3) If found, deserialize and return -- this takes ~0.2ms versus ~5ms for a database query. (4) If not found, query PostgreSQL's `popular_highlights` table. (5) Store the result in Redis: `SET popular:{bookId} value EX 300` (5-minute TTL). (6) Return the result.

**Cache invalidation**: For popular highlights, the cache naturally expires every 5 minutes, which aligns with the aggregation worker's batch sync interval. For user-specific data, cache keys are deleted on write operations (create, update, delete highlight).

**How it works in this project**: Popular highlights for each book are cached in Redis with a 5-minute TTL. The aggregation service updates these counts every 5 minutes, so the cache TTL matches the data freshness interval. See `src/shared/cache.ts`.

**Why it matters for reading platforms**: The architecture targets 100K reads/second for popular highlights of bestselling books. A Harry Potter title might have millions of readers checking "what others highlighted." Without caching, each request would run a `SELECT ... ORDER BY highlight_count DESC LIMIT 10` query against PostgreSQL, which at 100K QPS would overwhelm the database. Redis serves these cached results with sub-millisecond latency.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. For API design, this means a duplicate request (caused by network retries, client-side double-taps, or load balancer request duplication) does not create duplicate data.

**How idempotency keys work**: The client generates a unique key (typically a UUID) for each highlight creation and sends it as a header. The server checks Redis for this key before processing: (1) If found, return the cached result from the first execution. (2) If not found, create the highlight, store the result in Redis with a 24-hour TTL, and return it.

**Two-layer deduplication in this project**: First, Redis is checked for the idempotency key (fast path). Second, the `idempotency_key` column in the PostgreSQL `highlights` table provides database-level deduplication within a transaction. This double-check handles the case where Redis is unavailable -- the database constraint still prevents duplicates.

**Why this matters for highlight sync**: Consider a user highlighting a passage on their Kindle. The device sends a create request, but the cellular connection drops before the response arrives. The device queues the request for retry. When connectivity returns, it retries. Without idempotency, the user now has two identical highlights in their library. With idempotency keys, the retry hits the cached result and returns the already-created highlight.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing downstream service. It works like an electrical circuit breaker: when failures exceed a threshold, the "circuit opens" and subsequent calls fail immediately without attempting the request. After a cooldown period, the circuit allows one test request through ("half-open"). If it succeeds, the circuit closes and normal operation resumes.

**The three states**:
1. **Closed** (normal): Requests flow through normally. Failures are counted. If failures exceed the threshold (e.g., 50% of the last 5 requests fail), the circuit opens.
2. **Open** (failing): All requests are immediately routed to a fallback function without attempting the downstream call. This prevents a failing service from dragging down the caller with timeout delays.
3. **Half-open** (testing): After the reset timeout (e.g., 30 seconds), one request is allowed through to test whether the downstream service has recovered. If it succeeds, the circuit closes. If it fails, the circuit reopens.

**Fallback behaviors in this project**: Redis read failures fall back to returning null (cache miss, continue to PostgreSQL). Redis write failures fall back to queuing the write in a PostgreSQL fallback table. PostgreSQL read failures return cached data if available, or an error. Elasticsearch failures (at production scale) fall back to PostgreSQL `ILIKE` search.

**Why this matters for a reading platform**: The highlight service depends on both PostgreSQL and Redis. If Redis goes down, every highlight creation would wait for the Redis timeout (e.g., 1-3 seconds) before falling through to the database path. With 10K highlights/second at scale, that is 10K-30K seconds of accumulated waiting per second -- the server would quickly exhaust its connection pool and crash. A circuit breaker detects the failure after a few requests and starts skipping Redis entirely, keeping highlight creation fast.

### Structured Logging

Structured logging means emitting log entries as machine-readable JSON objects instead of free-form text strings. Instead of `"User alice created highlight in The Great Gatsby"`, the entry is `{"level":"info","service":"highlight","userId":"abc-123","bookId":"def-456","highlightId":"ghi-789","action":"highlight_created","durationMs":12}`.

**Why JSON instead of text**: In production with multiple service instances generating thousands of log lines per second, searching free-form text is impractical. JSON logs can be indexed by any field in a log aggregation system. Finding "all highlight creations that took longer than 500ms" becomes a filter query instead of a regex search through millions of lines.

**How Pino works in this project**: Pino outputs JSON in production mode and pretty-prints in development mode. Each service creates a child logger with the service name as context (`createLogger('highlight')`, `createLogger('sync')`). This means every log line from the highlight service automatically includes `"service":"highlight"`, making it trivial to filter logs by service. See `src/shared/logger.ts`.

**Key events logged**: `highlight_created` (userId, bookId, highlightId, location, durationMs), `sync_pushed` (userId, deviceCount, queuedCount), `aggregation_completed` (booksProcessed, durationMs), `privacy_changed` (userId, oldSettings, newSettings). Each event includes enough context to reconstruct what happened without needing to correlate with other log lines.

**Why it matters for sync debugging**: When a user reports "my highlight didn't sync to my other device," you need to trace the event through four microservices (highlight creation -> sync push -> device queue -> WebSocket delivery). With structured logs and a shared userId, you can filter to that user's events across all services and see exactly where the sync chain broke.

### Prometheus Metrics

Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics at a `/metrics` HTTP endpoint. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the time-series data for querying, dashboards, and alerting.

**Three metric types that matter**:
- **Counter**: A number that only goes up. Example: `highlights_created_total{book_id}`. The *rate* of change tells you how many highlights are being created per second.
- **Gauge**: A number that goes up and down. Example: `websocket_active_connections`. Shows how many devices are currently connected for sync.
- **Histogram**: Tracks the distribution of values across configurable buckets. Example: `highlight_operation_duration_seconds` with buckets at 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5 seconds. Lets you compute percentiles -- "p99 highlight creation latency is 180ms."

**SLIs defined in this project**: Highlight creation latency (target: p99 < 200ms), cross-device sync latency (target: p95 < 2s), popular highlights cache hit rate (target: > 90%), API availability (target: 99.5% successful responses). Each SLI maps to a specific Prometheus metric.

**Why it matters for a sync platform**: The architecture promises < 2 second cross-device sync. Without metrics measuring the time from highlight creation to WebSocket delivery, you cannot verify this promise. A histogram on sync latency gives you exact p95 values. If p95 drifts above 2 seconds, an alert fires before users notice degradation.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without it, a single misbehaving client can overwhelm the server.

**How it works**: The server tracks request counts per client (identified by user ID or IP address). Each incoming request checks the counter. If exceeded, the server returns HTTP 429 (Too Many Requests). If not, the request proceeds and the counter increments. Counters are typically stored in Redis for cross-server sharing.

**Rate limits defined in this project**:
- Highlight creation: 100/minute per user (prevents automated bulk creation)
- Auth attempts: 5/minute per IP (prevents brute-force password guessing)
- Export: 10/hour per user (exports are expensive database queries)
- Search: 30/minute per user (search queries are CPU-intensive)
- Global API: 1000/minute per user (general abuse protection)

**Why different limits for different endpoints**: Not all operations cost the same. Creating a highlight involves a database write, cache update, Redis counter increment, and sync event broadcast -- it is 10x more expensive than reading a highlight. Export requires scanning and formatting potentially thousands of highlights. Rate limits should reflect the actual cost of each operation.

### Health Checks

A health check is an HTTP endpoint that reports whether the service is alive and capable of handling requests. Load balancers and container orchestrators poll this endpoint to decide where to route traffic.

**How it works in this project**: Each of the four microservices exposes a health endpoint. A basic check just returns HTTP 200 to prove the process is running. A more thorough check tests downstream dependencies -- can this service reach PostgreSQL? Is Redis responding? If either is down, the service reports unhealthy, and the load balancer stops sending it traffic.

**Why health checks matter for microservices**: With four separate services (highlight, sync, aggregation, social), a failure in one should not cascade to the others. If the aggregation worker's PostgreSQL connection dies, the health check fails, and the orchestrator restarts just that service without affecting highlight creation or sync.

### RBAC (Role-Based Access Control)

RBAC is a method of restricting system access based on roles assigned to users rather than per-user permission lists. You define roles (e.g., "owner", "friend", "public") with associated permissions and assign users to roles for each resource.

**How it applies to this project**: The privacy system functions as a simplified RBAC model. Each highlight has a `visibility` field that acts as a role assignment:
- `private`: Only the owner can see it (owner role)
- `friends`: Owner and users in the `follows` table can see it (friend role)
- `public`: Everyone can see it, and it is included in aggregation counts (public role)

The `user_privacy_settings` table sets default visibility for new highlights, which users can override per-highlight. Query-time enforcement JOINs the highlights table with the follows table and privacy settings to filter results based on the requesting user's relationship to the highlight owner.

**Why per-highlight rather than per-user visibility**: Users want fine-grained control. A reader might share a profound quote publicly while keeping personal annotations private within the same book. Per-user settings establish the default; per-highlight overrides enable this flexibility without requiring a complex RBAC middleware.

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
