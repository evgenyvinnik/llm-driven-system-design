# Facebook Live Comments - Architecture Design

## System Overview

A real-time commenting system for live video streams, enabling viewers to post comments and reactions that are delivered to all participants with sub-second latency. Designed for high write throughput during peak live events with comment batching, reaction aggregation, and multi-instance fan-out via Redis Pub/Sub.

**Learning goals:** WebSocket connection management at scale, comment batching for throughput, Snowflake ID generation, rate limiting patterns, graceful shutdown with zero message loss.

## Requirements

### Functional Requirements

- **Real-time comments**: Post and receive comments with <500ms end-to-end latency
- **Comment ranking**: Display comments chronologically with support for pinned/highlighted comments
- **Moderation**: Ban users, hide comments, filter spam (word-based and rate-limiting)
- **Reactions**: Six reaction types (like, love, haha, wow, sad, angry) with aggregated counts
- **Threaded replies**: Support parent-child comment relationships

### Non-Functional Requirements

- **Scalability**: Handle 10M+ concurrent viewers per stream, 100K+ active streams
- **Availability**: 99.99% uptime target
- **Latency**:
  - Comment delivery: p95 < 500ms, p99 < 1000ms
  - API responses: p95 < 100ms, p99 < 250ms
- **Throughput**: 1M+ comments/second globally, 100K reactions/second per stream
- **Consistency**: Eventual consistency acceptable for comments (1-2s delay between instances tolerable)

## Capacity Estimation

**Production Scale:**
- 10M concurrent viewers on a top-tier live event
- 50K comments/second at peak for a single stream
- Average comment: 500 bytes
- 100K active streams, averaging 1,000 viewers each
- Total WebSocket connections: 100M+

**Storage:**
- Comments: 50K/s x 500B x 3600s = 90GB/hour for a peak stream
- Reactions: 100K/s x 100B = 10MB/s, aggregated (not stored individually at scale)
- Daily storage growth across platform: ~5TB

### Local Development Scale

| Metric | Target | Sizing Rationale |
|--------|--------|------------------|
| Concurrent viewers per stream | 100-1,000 | Enough to stress-test batching |
| Active streams | 5-10 | Multiple test scenarios |
| Comments per minute per stream | 500 | ~8 comments/second peak |
| Reactions per minute per stream | 2,000 | ~33 reactions/second peak |
| Peak WebSocket connections | 1,000 | Single server instance capacity |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CDN / Edge                                       │
│              (WebSocket termination, geographic routing)                       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                      API Gateway / Load Balancer                              │
│            (Sticky sessions by stream_id for WebSocket)                       │
└──────┬─────────────────┬─────────────────┬──────────────────────────────────┘
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  WS Gateway  │  │  WS Gateway  │  │  WS Gateway  │
│  + API :3001 │  │  + API :3002 │  │  + API :3003 │
│              │  │              │  │              │
│  Comment     │  │  Comment     │  │  Comment     │
│  Batcher     │  │  Batcher     │  │  Batcher     │
│  (100ms)     │  │  (100ms)     │  │  (100ms)     │
│              │  │              │  │              │
│  Reaction    │  │  Reaction    │  │  Reaction    │
│  Aggregator  │  │  Aggregator  │  │  Aggregator  │
│  (500ms)     │  │  (500ms)     │  │  (500ms)     │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┴─────────────────┘
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Redis       │  │  PostgreSQL  │  │   Kafka      │
│  Pub/Sub +   │  │  Primary     │  │  (durable    │
│  Cache       │  │  Store       │  │   comment    │
│  Rate Limits │  │              │  │   stream)    │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Core Components

| Component | Responsibility | Production Technology |
|-----------|---------------|----------------------|
| **WS Gateway** | WebSocket connection management, message routing | Node.js + ws library |
| **Comment Batcher** | Buffers comments for 100ms, publishes batch to Redis | In-process timer |
| **Reaction Aggregator** | Aggregates reaction counts over 500ms windows | In-process timer |
| **Redis** | Pub/Sub for cross-instance sync, rate limiting, comment cache | Redis Cluster |
| **PostgreSQL** | Persistent storage for comments, users, streams, bans | PostgreSQL with read replicas |
| **Kafka** | Durable comment stream for replay, audit, analytics | Kafka cluster (production) |

## Request Flows

### Post Comment Flow

```
1. Client sends WebSocket message: { type: "post_comment", payload: {...} }
                    │
                    ▼
2. WebSocket Gateway validates user is joined to stream
                    │
                    ▼
3. CommentService.createComment():
   a. Check global rate limit (30/min) via Redis INCR
   b. Check per-stream rate limit (5/30sec) via Redis INCR
   c. Filter banned words
   d. Check idempotency key (dedup retries)
   e. Generate Snowflake ID (time-ordered, no coordination)
   f. INSERT into PostgreSQL comments table
   g. INCREMENT stream.comment_count
   h. LPUSH to Redis recent:stream:{id} cache
                    │
                    ▼
4. Comment added to CommentBatcher buffer
                    │
                    ▼
5. Every 100ms, batcher flushes:
   a. PUBLISH to Redis stream:{id}:comments channel
                    │
                    ▼
6. All server instances receive via SUBSCRIBE
                    │
                    ▼
7. Broadcast to local WebSocket connections for that stream
                    │
                    ▼
8. Client receives: { type: "comments_batch", payload: { comments: [...] } }
```

### Join Stream Flow

```
1. Client connects WebSocket to ws://server:3000
                    │
                    ▼
2. Client sends: { type: "join_stream", payload: { stream_id, user_id } }
                    │
                    ▼
3. Gateway checks ban status via UserService
                    │
                    ▼
4. Gateway updates local connection map (streamId ──▶ Set<WebSocket>)
                    │
                    ▼
5. Gateway subscribes to Redis channels:
   - stream:{id}:comments
   - stream:{id}:reactions
                    │
                    ▼
6. Gateway initializes CommentBatcher and ReactionAggregator for stream
                    │
                    ▼
7. Update viewer count in Redis HSET stream:{id} viewer_count
                    │
                    ▼
8. Fetch recent 50 comments from cache/DB and send to client
                    │
                    ▼
9. Broadcast viewer_count update to all stream viewers
```

## Database Schema

```sql
-- Users: viewers, streamers, moderators, admins
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(255),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
    reputation_score DECIMAL(3, 2) DEFAULT 0.5,  -- 0.0 to 1.0
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Streams: live broadcasts
CREATE TABLE streams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'live' CHECK (status IN ('scheduled', 'live', 'ended')),
    viewer_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    thumbnail_url VARCHAR(255),
    video_url VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments: Snowflake ID enables time-ordering without separate timestamp index
CREATE TABLE comments (
    id BIGINT PRIMARY KEY,  -- Snowflake ID (timestamp embedded)
    stream_id UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    is_highlighted BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    is_hidden BOOLEAN DEFAULT FALSE,
    moderation_status VARCHAR(20) DEFAULT 'approved'
        CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'spam')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reactions: one per user per comment per type
CREATE TABLE reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    reaction_type VARCHAR(20) NOT NULL
        CHECK (reaction_type IN ('like', 'love', 'haha', 'wow', 'sad', 'angry')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, comment_id, reaction_type)
);

-- Bans: per-stream or global
CREATE TABLE user_bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stream_id UUID REFERENCES streams(id) ON DELETE CASCADE,  -- NULL = global ban
    banned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_comments_stream_id ON comments(stream_id);
CREATE INDEX idx_comments_stream_created ON comments(stream_id, created_at DESC);
CREATE INDEX idx_comments_user_id ON comments(user_id);
CREATE INDEX idx_reactions_stream_id ON reactions(stream_id);
CREATE INDEX idx_reactions_comment_id ON reactions(comment_id);
CREATE INDEX idx_streams_status ON streams(status);
CREATE INDEX idx_streams_creator ON streams(creator_id);
CREATE INDEX idx_user_bans_user ON user_bans(user_id);
```

### Snowflake ID Structure

```
┌──────────────────┬────────────────┬──────────────────┐
│  41 bits: time   │  10 bits: node │  12 bits: seq   │
│  (ms since epoch)│   (worker ID)  │  (0-4095/ms)    │
└──────────────────┴────────────────┴──────────────────┘
```

- Enables time-ordering by ID comparison (no need for ORDER BY created_at)
- Supports 4,096 comments per millisecond per node
- No coordination required between nodes

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `recent:stream:{id}` | List | 1hr | Last 1,000 comments (JSON serialized) |
| `stream:{id}:comments` | Pub/Sub | - | Comment batch distribution |
| `stream:{id}:reactions` | Pub/Sub | - | Reaction aggregate distribution |
| `stream:{id}` | Hash | - | viewer_count, stream metadata |
| `ratelimit:global:{user_id}` | String (counter) | 60s | Global rate limit (30/min) |
| `ratelimit:stream:{stream_id}:{user_id}` | String (counter) | 30s | Per-stream rate limit (5/30s) |

## API Design

### WebSocket Messages (Real-time)

| Type | Direction | Payload |
|------|-----------|---------|
| `join_stream` | C->S | `{ stream_id, user_id }` |
| `leave_stream` | C->S | `{}` |
| `post_comment` | C->S | `{ stream_id, user_id, content, parent_id? }` |
| `react` | C->S | `{ stream_id, user_id, reaction_type, comment_id? }` |
| `comments_batch` | S->C | `{ stream_id, comments: [...] }` |
| `reactions_batch` | S->C | `{ stream_id, counts: { like: 5, love: 3, ... } }` |
| `viewer_count` | S->C | `{ stream_id, count }` |
| `error` | S->C | `{ code, message }` |
| `ping/pong` | Both | Heartbeat (30s interval) |

### REST Endpoints (HTTP Fallback)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/streams` | List all streams |
| GET | `/api/streams/live` | List live streams only |
| GET | `/api/streams/:id` | Get stream details |
| POST | `/api/streams` | Create new stream |
| POST | `/api/streams/:id/end` | End a stream |
| GET | `/api/streams/:id/comments` | Get recent comments |
| POST | `/api/streams/:id/comments` | Post comment (fallback) |
| GET | `/api/streams/:id/reactions` | Get reaction counts |
| GET | `/api/streams/:id/metrics` | Get viewer/comment counts |

## Key Design Decisions

### Comment Batching vs Per-Message Delivery

The core throughput challenge: a stream with 50K comments/second would generate 50K WebSocket messages per second per viewer. With 10M viewers, that is 500 billion messages/second -- impossible.

**Batching (chosen, 100ms interval):** Comments are buffered for 100ms and delivered as a single batch. This reduces message count by 80-95% in high-volume streams. A batch of 50 comments in one message is vastly more efficient than 50 individual messages. The trade-off is added latency: users see comments up to 100ms later. For live events, 100ms is imperceptible. The interval is configurable via `COMMENT_BATCH_INTERVAL_MS` environment variable.

**Per-message delivery (rejected):** Simpler code but would collapse under load. Even with WebSocket compression, the message framing overhead per message dominates at high volume.

### WebSocket vs Server-Sent Events (SSE)

WebSocket provides bidirectional communication, essential because viewers both read and write comments through the same connection. SSE is read-only and would require a separate POST endpoint for comments, doubling the connection management complexity and losing the ability to correlate a user's writes with their read stream.

### Redis Pub/Sub vs Kafka for Cross-Instance Sync

Redis Pub/Sub (chosen for simplicity): Fire-and-forget, sub-millisecond latency, no message persistence. If a server instance is down when a message is published, those comments are missed by its connected clients. This is acceptable because: (1) comments are ephemeral in live streams, (2) clients can fetch missing comments via REST fallback, (3) Redis Pub/Sub is operationally simple.

Kafka (production alternative): Durable message log with replay capability. Required if: comment audit trails are mandated, offline message delivery is needed, or analytics pipelines consume the comment stream. The operational complexity (ZooKeeper, partition management, consumer groups) is justified at production scale but unnecessary for learning.

### Snowflake IDs vs UUIDs

Snowflake IDs embed the creation timestamp in the ID itself. Sorting by ID = sorting by time, eliminating the need for a separate timestamp index. At 4,096 IDs per millisecond per node, they support extreme write throughput. UUIDs are random and require a separate `created_at` index for chronological ordering, adding storage and query cost. The trade-off: Snowflake IDs require clock synchronization across nodes, but NTP provides sufficient accuracy for millisecond-level ordering.

## Security

### Authentication and Authorization

| User Role | Permissions |
|-----------|-------------|
| `user` | Post comments, react, delete own comments |
| `moderator` | All user permissions + hide comments, pin comments, ban users (per-stream) |
| `admin` | All moderator permissions + global bans, end any stream |

### Rate Limiting

| Limit | Scope | Window | Action |
|-------|-------|--------|--------|
| 30 comments | Per user globally | 60 seconds | Reject with error |
| 5 comments | Per user per stream | 30 seconds | Reject with error |
| 100 reactions | Per user per stream | 60 seconds | Reject silently |

Implemented using Redis `INCR` with `EXPIRE` for atomic sliding window counters. Rate limit violations are logged with Prometheus counters. At production scale, IP-based limiting and ML-based spam detection would supplement user-level limits.

### Content Filtering

- **Word filter**: Blocklist of banned words
- **Spam detection**: Rate limiting prevents flooding
- **Moderation status**: Comments can be `pending`, `approved`, `rejected`, `spam`
- **Production additions**: ML toxicity detection (Perspective API), image/link scanning, reputation-based auto-moderation

## Observability

### Metrics (Prometheus format)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `ws_connections_total` | Gauge | stream_id | Current WebSocket connections |
| `ws_connections_opened_total` | Counter | - | Connection rate |
| `ws_connections_closed_total` | Counter | reason | Disconnection patterns |
| `comments_posted_total` | Counter | stream_id, status | Comments created |
| `reactions_posted_total` | Counter | stream_id, type | Reactions created |
| `comment_latency_ms` | Histogram | - | End-to-end comment delivery time |
| `db_query_duration_ms` | Histogram | query_type | Database query performance |
| `rate_limit_exceeded_total` | Counter | limit_type | Rate limit hits |
| `ws_message_size_bytes` | Histogram | direction | Message payload sizes |
| `circuit_breaker_state` | Gauge | service | Circuit breaker monitoring |
| `idempotency_duplicates_total` | Counter | - | Duplicate comment detection |
| `peak_viewers` | Gauge | stream_id | Peak viewers per stream |

### Health Check Endpoints

| Endpoint | Check | Purpose |
|----------|-------|---------|
| `/health` | Server running | Liveness probe |
| `/health/live` | Process alive | Kubernetes liveness |
| `/health/ready` | DB + Redis healthy | Kubernetes readiness |
| `/health/db` | PostgreSQL ping | Database-specific |
| `/health/redis` | Redis ping | Cache-specific |

### Logging

Structured JSON logs via Pino with child loggers per module. Log levels: ERROR (unhandled exceptions, DB failures), WARN (rate limits, moderation), INFO (connections, request lifecycle), DEBUG (batching details, Redis operations).

## Failure Handling

### Graceful Shutdown

During deployments, in-flight comments in batch buffers would be lost without proper handling. The shutdown sequence:

1. Set `isShuttingDown = true` (reject new connections)
2. Flush all CommentBatchers (publish pending comments to Redis)
3. Flush all ReactionAggregators (publish pending reactions)
4. Wait 500ms for Redis publish propagation
5. Send SERVER_SHUTDOWN message to all clients
6. Close connections with code 1001 (Going Away)
7. Wait for client acknowledgment (1s timeout)
8. Close WebSocket server, Redis, and database pools
9. Force exit after 30s timeout

### Circuit Breaker Pattern

Database operations are wrapped with circuit breakers. The circuit opens after 5 failures at 50% error rate, stays open for 10 seconds before probing. When open, comments fail fast rather than blocking on database timeouts. Metrics track state transitions for alerting.

### Retry Strategies

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| DB writes | 3 | Exponential (100ms, 200ms, 400ms) | Snowflake ID prevents duplicates |
| Redis cache | 2 | Fixed 50ms | Safe to retry (SET/LPUSH) |
| Redis Pub/Sub | 0 | Reconnect on disconnect | Messages are ephemeral |
| WebSocket send | 0 | Client reconnects | Client handles retries |

### Graceful Degradation

| Failure Mode | Fallback Behavior |
|--------------|-------------------|
| Redis cache miss | Query PostgreSQL directly |
| Redis Pub/Sub down | Comments only visible on posting instance |
| PostgreSQL down | Return cached data, queue writes |
| High load | Increase batching interval (100ms to 500ms) |

## Scalability Considerations

### Horizontal Scaling Path

1. **WebSocket Gateways**: Add instances behind sticky-session load balancer. Each gateway handles a subset of streams.
2. **Redis**: Cluster mode with pub/sub sharding by stream_id.
3. **PostgreSQL**: Read replicas for comment retrieval. Partition comments table by stream_id and time range.
4. **Hot stream isolation**: Streams with > 1M viewers get dedicated gateway instances to prevent noisy-neighbor effects.

### Connection Capacity Planning

Each Node.js instance handles ~50K concurrent WebSocket connections (limited by memory and event loop). A stream with 10M viewers requires 200+ gateway instances. The load balancer uses consistent hashing on stream_id to minimize connection redistribution during scaling events.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time protocol | WebSocket | SSE | Bidirectional needed for posting comments |
| Comment delivery | 100ms batching | Per-message | 80-95% message reduction, imperceptible latency |
| Cross-instance sync | Redis Pub/Sub | Kafka | Simpler ops, acceptable for ephemeral comments |
| Comment IDs | Snowflake | UUID | Time-ordered, eliminates timestamp index |
| Rate limiting | Redis INCR + EXPIRE | In-memory | Works across instances, atomic operations |
| Comment storage | PostgreSQL | Cassandra | ACID for moderation, simpler for learning |

## Frontend Architecture

### Component Hierarchy

```
App
├── UserSelector              (demo user selection dropdown)
├── StreamList                (sidebar list of available streams)
├── StreamInfo                (title, viewer count, connection status)
├── VideoPlayer               (video embed / placeholder for current stream)
├── FloatingReactions          (animated reaction emojis rising over video)
├── CommentList                (scrollable list of live comments)
│   └── CommentItem            (single comment with avatar, name, content)
├── ReactionButtons            (row of 6 reaction type buttons)
└── CommentInput               (text input for posting comments)
```

The application uses a single-page layout without a router. `App` is the root component that manages initial data loading, user/stream selection, and the two-panel layout (sidebar + main content). There is no TanStack Router because the interface is a single view with no navigation between pages.

### Zustand Store (`useAppStore`)

A single Zustand store manages all global state:

| Slice | State | Purpose |
|-------|-------|---------|
| **User** | `currentUser` | Currently selected demo user (no real auth) |
| **Streams** | `streams`, `currentStream` | Available streams and the one being watched |
| **Comments** | `comments` (capped at 200) | Live comment feed, newest appended, oldest trimmed |
| **Reactions** | `reactionCounts` | Aggregated reaction totals by type (like, love, haha, wow, sad, angry) |
| **Presence** | `viewerCount` | Real-time viewer count from server |
| **Connection** | `isConnected` | WebSocket connection status |
| **Animations** | `floatingReactions` | Temporary reaction entries for CSS animation, auto-removed after animation ends |

The comment buffer is capped at 200 entries via `allComments.slice(-200)` to prevent memory growth during long live streams. New comments are appended to the end, and oldest are trimmed from the beginning. Reaction counts are merged additively -- each incoming batch adds to the running totals rather than replacing them.

### Data Fetching

**Initial load (HTTP):** On mount, `App` fetches streams and users via the REST API (`services/api.ts`) using `Promise.all` for parallel loading. The first live stream and a default viewer user are auto-selected.

**Real-time updates (WebSocket):** All ongoing data flows through the `useWebSocket` hook. The hook connects to `ws://hostname:3001`, joins the selected stream, and routes incoming messages to store actions:

| Server Message | Store Action | Effect |
|----------------|-------------|--------|
| `comments_batch` | `addComments()` | Appends batch of comments to feed |
| `reactions_batch` | `addReactionCounts()` + `addFloatingReaction()` | Updates totals and spawns animations |
| `viewer_count` | `setViewerCount()` | Updates viewer count display |
| `error` | Console log | Displays error in dev tools |
| `pong` | (no-op) | Heartbeat acknowledgment |

**Sending data:** `sendComment()` and `sendReaction()` are returned by the hook and wired to `CommentInput` and `ReactionButtons`. Both send JSON messages over the existing WebSocket connection.

### Real-Time Update Patterns

**WebSocket lifecycle:** The `useWebSocket` hook manages connection, reconnection (3-second delay on disconnect), and heartbeat pings (25-second interval). When the user switches streams, the hook's `useEffect` cleanup closes the old connection and opens a new one. The WebSocket reference is held in a `useRef` to avoid re-renders on connection state changes.

**Optimistic UI:** Comments are not optimistically displayed -- the client waits for the server to include the comment in a `comments_batch` response. This is intentional because the server performs rate limiting, spam filtering, and ban checks that could reject the comment. Showing a comment before validation would create a confusing "comment appears then disappears" experience.

**Floating reactions:** When a `reactions_batch` arrives, the store spawns floating reaction entries (capped at 10 per type per batch for performance). Each entry gets a unique ID (`Date.now()-Math.random()`). The `FloatingReactions` component renders them as CSS-animated emojis that rise over the video player, and removes them from the store after the animation completes.

### Key UI Patterns

- **Two-panel layout:** Fixed-width sidebar (320px) for user/stream selection, flexible main area split between video and comments panel.
- **Comment feed auto-scroll:** `CommentList` auto-scrolls to the newest comment as batches arrive. The 200-comment cap prevents DOM node accumulation.
- **Connection status indicator:** `StreamInfo` displays the WebSocket connection state, giving users feedback when the real-time feed is disconnected.
- **Dark theme:** The entire UI uses a dark color scheme (`bg-gray-900`) to match the live video viewing experience.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation describes what the pattern is, why it exists, and how it works -- assuming no prior knowledge.

### Rate Limiting

**What it is:** Rate limiting restricts how many actions a user can perform within a time window. It is a protective mechanism that prevents any single user (or bot) from overwhelming the system with excessive requests.

**Why it matters:** In a live comments system, a malicious user or script could flood a stream with thousands of comments per second, drowning out legitimate conversation and overloading the database. Without rate limiting, a single bad actor could degrade the experience for millions of viewers.

**How it works here:** Two limits are enforced. The global limit allows 30 comments per user per 60 seconds across all streams. The per-stream limit allows 5 comments per user per 30 seconds on a single stream. Each limit is implemented using Redis `INCR` with `EXPIRE`: when a user posts a comment, the server increments a Redis counter keyed to `ratelimit:global:{user_id}` or `ratelimit:stream:{stream_id}:{user_id}`. If the counter exceeds the threshold, the comment is rejected. The `EXPIRE` command sets the key to auto-delete after the window elapses, resetting the counter. Because Redis operations are atomic, this works correctly even when multiple server instances check the same user's limits simultaneously.

**File:** `backend/src/services/commentService.ts`

### Redis Cache-Aside

**What it is:** Cache-aside (also called "lazy loading") is a caching strategy where the application checks a cache before querying the database. On a cache miss, the application queries the database, stores the result in the cache, and returns it. On a cache hit, the database is skipped entirely.

**Why it matters:** Live streams with millions of viewers generate massive read load. Every viewer joining a stream requests the 50 most recent comments. Without caching, each join would query PostgreSQL, creating thousands of identical queries per second. Redis serves these reads from memory in sub-millisecond time, reducing database load by orders of magnitude.

**How it works here:** Recent comments for each stream are stored in a Redis list at `recent:stream:{id}`. When a new comment is posted, it is pushed to this list (`LPUSH`) in addition to being inserted into PostgreSQL. When a viewer joins, the server first checks the Redis list. If the list exists and has enough entries, it returns them directly without touching PostgreSQL. The list has a 1-hour TTL and is capped at 1,000 entries. This is not a pure cache-aside pattern (it also pushes on write), making it a hybrid write-through + cache-aside approach that ensures the cache is always warm for active streams.

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing dependency. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately (fast-fail) without attempting the actual operation. After a cooldown period, the circuit enters a "half-open" state where it allows a single probe request through. If the probe succeeds, the circuit closes and normal operation resumes. If it fails, the circuit opens again.

**Why it matters:** When PostgreSQL becomes slow or unresponsive (network issue, disk full, connection pool exhausted), every comment post would block for the full database timeout (typically 5-30 seconds). With thousands of concurrent comment submissions, this creates a cascade: blocked requests exhaust the Node.js event loop, WebSocket message processing stalls, and the entire server becomes unresponsive -- even for operations that do not need the database (like WebSocket pings or Redis Pub/Sub). The circuit breaker stops this cascade by failing database calls instantly when the database is known to be unhealthy.

**How it works here:** The Opossum library wraps all PostgreSQL operations. Configuration: the circuit opens after 5 failures at a 50% error rate, stays open for 10 seconds before sending a half-open probe. When open, comment creation fails fast with an error message rather than hanging. The server continues to handle WebSocket connections, Redis Pub/Sub, and cached data reads. Prometheus metrics track circuit state transitions (`circuit_breaker_state` gauge) for alerting.

**File:** `backend/src/shared/circuitBreaker.ts`

### Structured Logging

**What it is:** Structured logging writes log entries as machine-parseable JSON objects rather than free-form text strings. Each log entry includes standardized fields (timestamp, level, message) plus context-specific metadata (user ID, stream ID, operation duration).

**Why it matters:** In a distributed system with multiple server instances, free-form text logs like `"User posted a comment"` are nearly impossible to search, filter, or aggregate. When debugging why comments are slow for a specific stream, you need to query logs by stream_id, filter by level, and sort by timestamp. JSON logs enable this with standard tools (Elasticsearch/Kibana, CloudWatch Logs Insights, `jq`). Structured logs also feed into monitoring pipelines -- extracting latency percentiles from a JSON `duration_ms` field is trivial; parsing them from a text string is fragile.

**How it works here:** Pino is configured with child loggers per module. The WebSocket gateway logger includes `module: "wsGateway"`, the comment service logger includes `module: "commentService"`. Each log entry automatically includes a timestamp, log level, and process ID. Log levels are: ERROR (database failures, unhandled exceptions), WARN (rate limit violations, moderation events), INFO (connections, stream joins, comment batches), DEBUG (batching details, Redis operations). In development, `pino-pretty` formats the JSON as human-readable colored output.

**File:** `backend/src/shared/logger.ts`

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics on an HTTP endpoint (`/metrics`) in a specific text format. Prometheus scrapes this endpoint periodically (typically every 15 seconds) and stores the time-series data. Grafana or similar tools visualize the data as dashboards and trigger alerts when metrics cross thresholds.

**Why it matters:** Metrics answer operational questions that logs cannot efficiently answer: "What is the p99 comment delivery latency over the last hour?" "How many WebSocket connections are active right now?" "Is the rate limit rejection rate increasing?" Without metrics, operators must manually grep through logs and compute aggregates -- a process that takes minutes instead of the seconds a pre-computed dashboard provides.

**How it works here:** The `prom-client` library exposes 11+ custom metrics. Key examples: `ws_connections_total` (Gauge) tracks current WebSocket connections per stream. `comments_posted_total` (Counter) counts comments by stream and status (success/rejected/error). `comment_latency_ms` (Histogram) records end-to-end delivery time in buckets for percentile calculation. `rate_limit_exceeded_total` (Counter) counts rate limit violations by type. `circuit_breaker_state` (Gauge) reports the circuit breaker state (0=closed, 0.5=half-open, 1=open). Default Node.js metrics (CPU, memory, event loop lag) are collected automatically.

**File:** `backend/src/shared/metrics.ts`

### Idempotency

**What it is:** Idempotency means that performing the same operation multiple times produces the same result as performing it once. In distributed systems, network failures cause retries: a client sends a comment, the server processes it, but the acknowledgment is lost. The client retries, and without idempotency, the comment is posted twice.

**Why it matters:** Duplicate comments are a poor user experience and corrupt data. In a live stream with millions of viewers, even a 0.1% duplicate rate means thousands of duplicate comments. Worse, automated scripts retrying aggressively could multiply this further.

**How it works here:** Each comment submission includes an idempotency key computed as a hash of the content combined with a timestamp bucket. Before processing a comment, the server checks Redis for this key. If the key exists (indicating the comment was already processed), the server returns the previous result without re-inserting. If the key does not exist, the server processes the comment and stores the key in Redis with a 1-hour TTL. The Snowflake ID also provides a secondary deduplication layer: because IDs embed timestamps and are assigned server-side, the same logical comment always gets the same ID range.

**File:** `backend/src/shared/idempotency.ts`

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers (to route traffic away from unhealthy instances), orchestrators like Kubernetes (to restart crashed containers), and monitoring systems (to trigger alerts).

**Why it matters:** In a multi-instance deployment, one server might lose its database connection while others are healthy. Without health checks, the load balancer continues sending traffic to the broken instance, causing errors for a fraction of users. Health checks enable automatic traffic rerouting within seconds.

**How it works here:** Five endpoints serve different consumers. `/health` returns basic server status. `/health/live` confirms the process is alive (Kubernetes liveness probe -- if this fails, the container is restarted). `/health/ready` checks that both PostgreSQL and Redis are reachable (Kubernetes readiness probe -- if this fails, the instance is removed from the load balancer but not restarted, allowing it to recover). `/health/db` and `/health/redis` check individual dependencies. Each endpoint returns a JSON response with status and latency information.

**File:** `backend/src/index.ts`

### RBAC (Role-Based Access Control)

**What it is:** RBAC is an authorization model where permissions are assigned to roles rather than to individual users. Each user is assigned one or more roles, and the role determines what actions they can perform. This simplifies permission management: instead of configuring permissions for each of 10 million users, you define permissions for 3 roles and assign users to roles.

**Why it matters:** In a live comments system, different users need different capabilities. Regular viewers can post comments and react. Moderators need to hide offensive comments and ban disruptive users. Admins need to manage streams globally. Without RBAC, these permission checks would be ad-hoc conditional statements scattered throughout the codebase, making them error-prone and difficult to audit.

**How it works here:** Three roles are defined: `user` (post comments, react, delete own comments), `moderator` (all user permissions plus hide/pin comments and per-stream bans), and `admin` (all moderator permissions plus global bans and ending any stream). The role is stored in the `users.role` column and checked in middleware before executing privileged operations. The moderation service (`moderation.ts`) validates roles before allowing ban, hide, or pin actions.

## Implementation Notes

This section maps the production architecture to the actual local implementation.

### Local Architecture

```
┌───────────────────┐
│  React Frontend   │
│  Vite :5173       │
│                   │
│  WebSocket Hook   │
│  Floating         │
│  Reactions        │
│  Comment List     │
└─────────┬─────────┘
          │ HTTP + WebSocket
          ▼
┌───────────────────┐
│  Express + WS     │
│  :3000            │
│                   │
│  WS Gateway       │
│  ├─ Connection    │
│  │  Manager       │
│  ├─ Room Manager  │
│  ├─ Comment       │
│  │  Batcher       │
│  └─ Reaction      │
│     Aggregator    │
│                   │
│  REST Routes      │
│  Services Layer   │
└──┬──────────┬─────┘
   │          │
   ▼          ▼
┌────────┐ ┌────────┐
│Postgres│ │ Valkey  │
│ :5432  │ │ :6379  │
│live_   │ │(pubsub,│
│comments│ │ cache, │
│        │ │ rates) │
└────────┘ └────────┘
```

### Production Patterns Actually Implemented

| Pattern | File | What It Does |
|---------|------|-------------|
| **Comment batching** (100ms) | `backend/src/services/wsGateway/room-manager.ts` | Buffers comments per stream, flushes on timer, publishes batch to Redis |
| **Reaction aggregation** (500ms) | `backend/src/services/wsGateway/room-manager.ts` | Aggregates reaction counts per type, publishes summary to Redis |
| **Redis Pub/Sub fan-out** | `backend/src/services/wsGateway/index.ts` | Subscribes to stream channels, broadcasts batches to local WS connections |
| **Snowflake ID generation** | `backend/src/utils/snowflake.ts` | 41-bit timestamp + 10-bit node + 12-bit sequence, no coordination |
| **Rate limiting** | `backend/src/services/commentService.ts` | Redis INCR + EXPIRE for global (30/min) and per-stream (5/30s) limits |
| **Idempotency** | `backend/src/shared/idempotency.ts` | Redis-backed dedup with content hash + timestamp bucket |
| **Circuit breaker** (Opossum) | `backend/src/shared/circuitBreaker.ts` | Wraps DB operations with failure detection and fast-fail |
| **Prometheus metrics** (prom-client) | `backend/src/shared/metrics.ts` | WebSocket, comment, reaction, DB, circuit breaker, rate limit metrics |
| **Structured logging** (Pino) | `backend/src/shared/logger.ts` | JSON logs with child loggers per module, pino-pretty for dev |
| **Graceful shutdown** | `backend/src/index.ts` | Flush batchers, notify clients, close connections, drain pools |
| **Health checks** | `backend/src/index.ts` | /health, /health/live, /health/ready, /health/db, /health/redis |
| **Connection management** | `backend/src/services/wsGateway/connection-manager.ts` | Track connections per stream, heartbeat monitoring, cleanup |
| **Moderation** | `backend/src/services/wsGateway/moderation.ts` | Ban checks, user session validation |
| **WebSocket hook** | `frontend/src/hooks/useWebSocket.ts` | React hook for WS lifecycle, reconnection, message handling |
| **Floating reactions** | `frontend/src/components/FloatingReactions.tsx` | Animated reaction overlay on live video |

### What Was Simplified or Substituted

| Production Design | Local Implementation | Why |
|-------------------|---------------------|-----|
| CDN WebSocket termination | Direct WS to Express | Single region, no edge needed |
| Kafka for durable comment stream | Redis Pub/Sub only | No replay/audit needed for learning |
| Sticky-session load balancer | Single instance (or manual multi-port) | Stream routing not needed at dev scale |
| PostgreSQL read replicas | Single PostgreSQL instance | Read load is minimal |
| Redis Cluster | Single Valkey instance | All data fits in memory |
| ML toxicity detection | Word blocklist | Placeholder for learning |
| OAuth/JWT auth | Simplified session with user_id in requests | No token complexity |
| Separate WS gateway service | WS colocated with REST in single process | Simpler deployment |

### What Was Omitted

- CDN / edge WebSocket termination
- Kafka for durable comment streams and replay
- Sticky-session load balancer (nginx/HAProxy)
- PostgreSQL read replicas and comment table partitioning
- ML-based spam/toxicity filtering (Perspective API)
- Superchat (paid highlighted comments)
- Comment translation
- Custom per-stream emotes
- Multi-region deployment
- Kubernetes orchestration
- Connection pooling optimization / adaptive batching intervals
- Image/avatar storage (MinIO/S3)
