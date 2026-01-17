# Facebook Live Comments - Architecture Design

## System Overview

A real-time commenting system for live video streams, enabling viewers to post comments and reactions that are delivered to all participants with sub-second latency. Designed for high write throughput during peak live events.

## Requirements

### Functional Requirements

- **Real-time comments**: Post and receive comments with <500ms end-to-end latency
- **Comment ranking**: Display comments chronologically with support for pinned/highlighted comments
- **Moderation**: Ban users, hide comments, filter spam (word-based and rate-limiting)
- **Reactions**: Six reaction types (like, love, haha, wow, sad, angry) with aggregated counts
- **Threaded replies**: Support parent-child comment relationships

### Non-Functional Requirements

- **Scalability**: Handle 10,000 concurrent viewers per stream, 100 active streams
- **Availability**: 99.9% uptime (8.7 hours downtime/year allowed)
- **Latency**:
  - Comment delivery: p95 < 500ms, p99 < 1000ms
  - API responses: p95 < 100ms, p99 < 250ms
- **Consistency**: Eventual consistency acceptable for comments (1-2s delay between instances tolerable)

## Capacity Estimation

### Local Development Scale

These estimates are for a learning project running on a single developer machine:

| Metric | Target | Sizing Rationale |
|--------|--------|------------------|
| Concurrent viewers per stream | 100-1,000 | Enough to stress-test batching |
| Active streams | 5-10 | Multiple test scenarios |
| Comments per minute per stream | 500 | ~8 comments/second peak |
| Reactions per minute per stream | 2,000 | ~33 reactions/second peak |
| Peak WebSocket connections | 1,000 | Single server instance capacity |
| Peak RPS (HTTP + WS messages) | 500 | Combined read/write load |

### Storage Growth

| Data Type | Size per Record | Daily Growth (10 streams, 1hr each) | Monthly |
|-----------|----------------|-------------------------------------|---------|
| Comments | ~500 bytes | ~3,000 comments = 1.5 MB | 45 MB |
| Reactions | ~100 bytes | ~12,000 reactions = 1.2 MB | 36 MB |
| Users | ~300 bytes | ~100 new users = 30 KB | 1 MB |
| Streams | ~400 bytes | ~10 streams = 4 KB | 120 KB |

**Total estimated storage**: <100 MB/month for local development

### Component Sizing (Local Dev)

| Component | Configuration | Rationale |
|-----------|--------------|-----------|
| PostgreSQL | Default (max_connections: 100) | 20 connection pool is sufficient |
| Redis | Default (maxmemory: 100mb) | Recent comments cache + rate limiting |
| Node.js | 1 instance, 512 MB heap | Single process for development |
| WebSocket | 1,000 max connections | Default ws library limit |

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    | (for multi-node) |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v-----------+       +----------v----------+
    |  API Server :3001 |        |   API Server :3002    |       |  API Server :3003   |
    |  + WS Gateway     |        |   + WS Gateway        |       |  + WS Gateway       |
    +---------+---------+        +-----------+-----------+       +----------+----------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
                      +----------------------+----------------------+
                      |                      |                      |
            +---------v---------+  +---------v---------+  +---------v---------+
            |      Redis        |  |    PostgreSQL     |  |      MinIO        |
            | Pub/Sub + Cache   |  |   Primary Store   |  | (future: avatars) |
            +-------------------+  +-------------------+  +-------------------+
```

### Core Components

1. **API Server + WebSocket Gateway** (Node.js/Express)
   - Handles HTTP REST endpoints for CRUD operations
   - Manages WebSocket connections for real-time delivery
   - Implements comment batching (100ms intervals)
   - Implements reaction aggregation (500ms intervals)

2. **Redis** (Cache + Pub/Sub)
   - Recent comments cache (last 1,000 per stream, 1hr TTL)
   - Rate limit counters (sliding window)
   - Pub/Sub channels for cross-instance message distribution
   - Viewer count tracking per stream

3. **PostgreSQL** (Persistent Storage)
   - Users, streams, comments, reactions, bans
   - Indexes optimized for time-ordered comment retrieval
   - Connection pool: 20 connections per server instance

## Request Flow

### Post Comment Flow

```
1. Client sends WebSocket message: { type: "post_comment", payload: {...} }
                    |
                    v
2. WebSocket Gateway validates user is joined to stream
                    |
                    v
3. CommentService.createComment():
   a. Check global rate limit (30/min) via Redis INCR
   b. Check per-stream rate limit (5/30sec) via Redis INCR
   c. Filter banned words
   d. Generate Snowflake ID (time-ordered, no coordination)
   e. INSERT into PostgreSQL comments table
   f. INCREMENT stream.comment_count
   g. LPUSH to Redis recent:stream:{id} cache
                    |
                    v
4. Comment added to CommentBatcher buffer
                    |
                    v
5. Every 100ms, batcher flushes:
   a. PUBLISH to Redis stream:{id}:comments channel
                    |
                    v
6. All server instances receive via SUBSCRIBE
                    |
                    v
7. Broadcast to local WebSocket connections for that stream
                    |
                    v
8. Client receives: { type: "comments_batch", payload: { comments: [...] } }
```

### Join Stream Flow

```
1. Client connects WebSocket to ws://server:3000
                    |
                    v
2. Client sends: { type: "join_stream", payload: { stream_id, user_id } }
                    |
                    v
3. Gateway checks ban status via UserService
                    |
                    v
4. Gateway updates local connection map (streamId -> Set<WebSocket>)
                    |
                    v
5. Gateway subscribes to Redis channels:
   - stream:{id}:comments
   - stream:{id}:reactions
                    |
                    v
6. Gateway initializes CommentBatcher and ReactionAggregator for stream
                    |
                    v
7. Update viewer count in Redis HSET stream:{id} viewer_count
                    |
                    v
8. Fetch recent 50 comments from cache/DB and send to client
                    |
                    v
9. Broadcast viewer_count update to all stream viewers
```

## Data Model

### Database Schema

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
    is_highlighted BOOLEAN DEFAULT FALSE,  -- Creator highlights
    is_pinned BOOLEAN DEFAULT FALSE,       -- Mod pins
    is_hidden BOOLEAN DEFAULT FALSE,       -- Soft delete
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

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `recent:stream:{id}` | List | 1hr | Last 1,000 comments (JSON serialized) |
| `stream:{id}:comments` | Pub/Sub | - | Comment batch distribution |
| `stream:{id}:reactions` | Pub/Sub | - | Reaction aggregate distribution |
| `stream:{id}` | Hash | - | viewer_count, stream metadata |
| `ratelimit:global:{user_id}` | String (counter) | 60s | Global rate limit (30/min) |
| `ratelimit:stream:{stream_id}:{user_id}` | String (counter) | 30s | Per-stream rate limit (5/30s) |

### Snowflake ID Structure

```
+------------------+----------------+------------------+
|  41 bits: time   |  10 bits: node |  12 bits: seq   |
|  (ms since epoch)|   (worker ID)  |  (0-4095/ms)    |
+------------------+----------------+------------------+
```

- Enables time-ordering by ID comparison (no need for ORDER BY created_at)
- Supports 4,096 comments per millisecond per node
- No coordination required between nodes

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

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express + ws | Non-blocking I/O for WebSocket scale |
| **Frontend** | React 19 + Zustand + TanStack Router | Modern, lightweight state management |
| **Primary DB** | PostgreSQL 16 | ACID transactions, JSON support, familiar |
| **Cache** | Redis/Valkey 7 | Pub/Sub + cache in one, low latency |
| **ID Generation** | Snowflake | Time-ordered, distributed, no coordination |

## Security

### Authentication and Authorization

| User Role | Permissions |
|-----------|-------------|
| `user` | Post comments, react, delete own comments |
| `moderator` | All user permissions + hide comments, pin comments, ban users (per-stream) |
| `admin` | All moderator permissions + global bans, end any stream |

**Current Implementation** (simplified for learning):
- Session-based auth with user_id passed in requests
- No JWT/OAuth complexity
- Role stored in users table

**Production Would Add**:
- JWT tokens with short expiry
- OAuth2 for third-party login
- Rate limiting by IP in addition to user_id

### Rate Limiting

| Limit | Scope | Window | Action |
|-------|-------|--------|--------|
| 30 comments | Per user globally | 60 seconds | Reject with error |
| 5 comments | Per user per stream | 30 seconds | Reject with error |
| 100 reactions | Per user per stream | 60 seconds | Reject silently |

Implementation: Redis INCR with EXPIRE for sliding window counters.

### Content Filtering

- **Word filter**: Blocklist of banned words (placeholder for learning)
- **Spam detection**: Rate limiting prevents flooding
- **Moderation status**: Comments can be set to `pending`, `approved`, `rejected`, `spam`

**Production Would Add**:
- ML-based toxicity detection (Perspective API)
- Image/link scanning
- User reputation-based auto-moderation

## Observability

### Metrics (Prometheus format)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `ws_connections_total` | Gauge | stream_id | Current WebSocket connections |
| `comments_posted_total` | Counter | stream_id, status | Comments created |
| `reactions_posted_total` | Counter | stream_id, type | Reactions created |
| `comment_latency_ms` | Histogram | - | End-to-end comment delivery time |
| `db_query_duration_ms` | Histogram | query_type | Database query performance |
| `rate_limit_exceeded_total` | Counter | limit_type | Rate limit hits |
| `ws_message_size_bytes` | Histogram | direction | Message payload sizes |

### Logging

| Log Level | Use Case | Example |
|-----------|----------|---------|
| ERROR | Unhandled exceptions, DB failures | `Redis connection failed` |
| WARN | Rate limits, moderation actions | `User 123 rate limited` |
| INFO | Request lifecycle, connections | `User 123 joined stream abc` |
| DEBUG | Detailed flow, batching | `Flushed 5 comments to stream abc` |

Current implementation logs query duration for all database operations.

### Tracing

For local development, console logging with timestamps is sufficient. Production would add:
- OpenTelemetry spans for request tracing
- Correlation IDs across WebSocket messages
- Distributed tracing for multi-instance debugging

### Health Checks

| Endpoint | Check | Timeout |
|----------|-------|---------|
| `/health` | Server responding | 1s |
| `/health/db` | PostgreSQL ping | 2s |
| `/health/redis` | Redis ping | 1s |

## Failure Handling

### Retry Strategies

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| DB writes | 3 | Exponential (100ms, 200ms, 400ms) | Snowflake ID prevents duplicates |
| Redis cache | 2 | Fixed 50ms | Safe to retry (SET/LPUSH) |
| Redis Pub/Sub | 0 | Reconnect on disconnect | Messages are ephemeral |
| WebSocket send | 0 | Client reconnects | Client handles retries |

### Circuit Breaker Pattern

| Dependency | Threshold | Timeout | Recovery |
|------------|-----------|---------|----------|
| PostgreSQL | 5 failures in 30s | Open for 10s | Half-open probe |
| Redis | 5 failures in 30s | Open for 5s | Half-open probe |

**Current Implementation**: Basic error handling. Production would add circuit breaker library (e.g., `opossum`).

### Graceful Degradation

| Failure Mode | Fallback Behavior |
|--------------|-------------------|
| Redis cache miss | Query PostgreSQL directly |
| Redis Pub/Sub down | Comments only visible on posting instance |
| PostgreSQL down | Return cached data, queue writes |
| High load | Increase batching interval (100ms -> 500ms) |

### Backup and Recovery

| Data | Backup Strategy | Recovery Point |
|------|-----------------|----------------|
| PostgreSQL | pg_dump daily (local dev) | Last backup |
| Redis | RDB snapshots disabled (ephemeral cache) | Rebuilt from PostgreSQL |

**Production Would Add**:
- Continuous WAL archiving to S3
- Point-in-time recovery
- Multi-region replication

## Cost Tradeoffs

### Local Development Costs

| Resource | Allocation | Monthly Cost |
|----------|------------|--------------|
| Docker containers | PostgreSQL, Redis | $0 (local) |
| Storage | <1 GB | $0 (local) |
| Compute | Single laptop | $0 (local) |

### Production Scaling Decisions

| Decision | Cheaper Option | More Performant Option | Chosen for Learning |
|----------|----------------|------------------------|---------------------|
| Message Queue | Redis Pub/Sub (fire-and-forget) | Kafka (durable, replay) | Redis (simpler) |
| Caching | In-memory per-instance | Redis cluster | Redis single node |
| Database | Single PostgreSQL | Read replicas + sharding | Single PostgreSQL |
| Real-time | Polling (HTTP) | WebSocket (persistent) | WebSocket (core feature) |
| Batching | Per-message (lower latency) | Time-based (higher throughput) | Time-based (100ms) |

### Scaling Path

1. **Single instance** (current): 1,000 concurrent connections
2. **2-3 instances + Redis Pub/Sub**: 3,000 connections, horizontal scaling validated
3. **Production**: Add load balancer, Redis cluster, read replicas

## Trade-offs and Alternatives

### WebSocket vs. Server-Sent Events (SSE)
- **Chosen**: WebSocket for bidirectional communication
- **Alternative**: SSE would work for read-only viewers but requires separate POST endpoint for comments

### Comment Batching vs. Per-Message
- **Chosen**: 100ms batching interval
- **Tradeoff**: Adds up to 100ms latency but reduces message count by 80% in high-volume streams
- **Tunable**: `COMMENT_BATCH_INTERVAL_MS` environment variable

### Redis Pub/Sub vs. Kafka
- **Chosen**: Redis Pub/Sub for simplicity
- **Tradeoff**: No message persistence, no replay capability
- **When to switch**: If offline message delivery or audit logging becomes critical

### Snowflake IDs vs. UUIDs
- **Chosen**: Snowflake for time-ordering
- **Tradeoff**: Requires clock synchronization, slightly more complex
- **Benefit**: Sort by ID = sort by time, no additional index needed

## Future Optimizations

### Phase 3: Scaling
- [ ] Add nginx/HAProxy load balancer for sticky sessions
- [ ] Implement Redis Cluster for Pub/Sub partitioning
- [ ] Add PostgreSQL read replicas for comment retrieval
- [ ] Implement comment pagination for historical access

### Phase 4: Features
- [ ] ML-based spam/toxicity filtering
- [ ] Superchat (paid highlighted comments)
- [ ] Comment translation
- [ ] Emoji reactions with custom per-stream emotes

### Performance Tuning
- [ ] Connection pooling optimization based on load testing
- [ ] Adaptive batching intervals based on stream activity
- [ ] Comment compression for high-volume streams
- [ ] CDN for avatar images

## Implementation Notes

This section documents the **WHY** behind key implementation decisions, explaining how each feature addresses specific challenges in live commenting systems.

### Rate Limiting Prevents Comment Spam During Live Events

**Problem**: During high-engagement moments (goals, announcements, controversies), users may intentionally or unintentionally flood the chat with messages. A single malicious user could send thousands of comments per minute, drowning out legitimate conversation and degrading the experience for everyone.

**Solution**: Tiered rate limiting with two layers:
1. **Global limit (30 comments/minute per user)**: Prevents any single user from monopolizing the comment stream across all streams they participate in.
2. **Per-stream limit (5 comments/30 seconds per user)**: Ensures fair distribution of comment slots within a single stream.

**Implementation Details**:
- Uses Redis `INCR` with `EXPIRE` for atomic sliding window counters
- Rate limit violations are logged with `rate_limit_exceeded_total` Prometheus counter
- Allows tuning limits via environment variables without code changes
- Returns clear error messages so clients can implement backoff

**Why Not Just Moderation?**
Post-hoc moderation can't undo the damage of a comment flood. By the time a moderator sees the spam, thousands of messages have already pushed legitimate comments off-screen. Rate limiting is a preventive measure that works at scale without human intervention.

### Idempotency Prevents Duplicate Comments

**Problem**: Network unreliability is inherent in real-time systems. When a user posts a comment during a network hiccup:
1. The request may succeed but the response is lost
2. The client retries, creating a duplicate comment
3. The user sees their comment posted twice (or more)

This is especially common during high-traffic live events when servers are under load and network congestion is higher.

**Solution**: Idempotency keys that uniquely identify each comment submission:
1. **Client-provided key**: If the client sends an `X-Idempotency-Key` header, we use it
2. **Auto-generated key**: Otherwise, we generate a key from `userId:streamId:contentHash:timestampBucket`

**Implementation Details**:
- Keys are stored in Redis with 5-minute TTL (long enough for retries, short enough for reuse)
- Duplicate requests return the cached result immediately, maintaining exactly-once semantics
- `idempotency_duplicates_total` metric tracks how often duplicates are detected
- Works for both WebSocket and HTTP comment endpoints

**Why This Approach?**
- **Snowflake IDs alone aren't enough**: While Snowflake IDs ensure unique database records, they don't help when the client retries before receiving confirmation of the first request
- **Content hashing catches rapid resubmits**: Even if a user legitimately wants to post the same content, a 1-second bucket prevents accidental double-posts from rapid clicking
- **Silent deduplication**: Users don't see error messages for retries; they just see their comment appear once

### Connection Metrics Enable Capacity Planning

**Problem**: Scaling a real-time system requires understanding:
1. How many concurrent connections each server can handle
2. When to add more instances before users experience degradation
3. Which streams are drawing the most viewers
4. Whether connection churn is abnormal (indicating client issues)

Without metrics, you're flying blind, scaling reactively after problems occur rather than proactively before they do.

**Solution**: Comprehensive Prometheus metrics for WebSocket connections:

| Metric | Type | Purpose |
|--------|------|---------|
| `ws_connections_total` | Gauge | Current connections per stream (capacity utilization) |
| `ws_connections_opened_total` | Counter | Connection rate (load prediction) |
| `ws_connections_closed_total` | Counter | Disconnection rate by reason (health indicator) |
| `peak_viewers` | Gauge | Peak viewers per stream (capacity planning) |
| `ws_message_size_bytes` | Histogram | Bandwidth requirements |

**Implementation Details**:
- Metrics are exposed at `/metrics` in Prometheus text format
- Labels allow filtering by stream_id for per-stream analysis
- Close reasons (normal, abnormal, error) help diagnose client issues
- Default Node.js metrics (CPU, memory, event loop) included for full observability

**Why These Specific Metrics?**
- **`ws_connections_total` by stream**: Identifies "hot" streams that may need dedicated resources
- **Peak viewers**: Helps size infrastructure for expected maximum load
- **Close reasons**: Abnormal closes may indicate network issues or bugs
- **Message sizes**: Validates that batching is keeping messages small

### Graceful Shutdown Prevents Message Loss

**Problem**: During deployments or scaling events, servers receive termination signals. Without proper handling:
1. In-flight comments in batch buffers are lost forever
2. Clients receive connection errors with no warning
3. Users may think their comments were posted when they weren't
4. WebSocket connections are terminated abruptly, causing client reconnection storms

**Solution**: A coordinated shutdown sequence that ensures zero message loss:

```
1. isShuttingDown = true (reject new connections)
       |
       v
2. Flush all CommentBatchers (publish pending comments to Redis)
       |
       v
3. Flush all ReactionAggregators (publish pending reactions)
       |
       v
4. Wait 500ms for Redis publish propagation
       |
       v
5. Send SERVER_SHUTDOWN message to all clients
       |
       v
6. Close connections with code 1001 (Going Away)
       |
       v
7. Wait for clients to acknowledge close (1s timeout)
       |
       v
8. Terminate any remaining connections
       |
       v
9. Close WebSocket server, Redis, database pools
       |
       v
10. Exit process
```

**Implementation Details**:
- Overall shutdown timeout of 30 seconds (configurable via `SHUTDOWN_TIMEOUT_MS`)
- Each step has individual timeouts to prevent blocking
- Clients receive a notification allowing them to reconnect to another instance
- Batchers call `stop()` which flushes remaining buffers before stopping
- Force exit if graceful shutdown takes too long

**Why Not Just Kill the Process?**
- **Comment batching creates a window**: Comments added in the last 100ms before shutdown would be lost if we don't flush
- **Client reconnection storms**: Abrupt termination causes all clients to reconnect simultaneously to remaining servers, potentially overloading them
- **User experience**: A "server shutting down" message allows clients to show appropriate UI instead of generic errors

### Circuit Breaker Protects Against Cascading Failures

**Problem**: When the database becomes slow or unavailable:
1. Request threads block waiting for responses
2. Thread pool exhaustion affects all requests, not just database ones
3. Retries multiply the load on an already struggling database
4. The entire system degrades even though only one component failed

**Solution**: The circuit breaker pattern using the `opossum` library:

```
         Failures < threshold
               |
               v
+----------+  success   +----------+
|  CLOSED  | ---------> |  CLOSED  |
|  (normal)|            |  (normal)|
+----------+            +----------+
     |
     | failures >= threshold
     v
+----------+
|   OPEN   | ---------> Fail fast (no DB call)
| (protect)|
+----------+
     |
     | resetTimeout expires
     v
+----------+
|HALF-OPEN | ---------> Try one request
|  (probe) |
+----------+
     |
     +---> Success: go to CLOSED
     +---> Failure: go back to OPEN
```

**Implementation Details**:
- Database operations wrapped with `createDatabaseCircuitBreaker()`
- Opens after 5 failures at 50% error rate
- Stays open for 10 seconds before probing
- `circuit_breaker_state` gauge tracks state (0=closed, 1=open, 2=half-open)
- `circuit_breaker_failures_total` counter tracks failure patterns

**Why Circuit Breaker vs. Simple Retries?**
- **Retries amplify problems**: If the database is overloaded, retries make it worse
- **Fail fast saves resources**: An open circuit returns immediately instead of waiting for timeout
- **Recovery detection**: Half-open state automatically detects when the database recovers
- **Metrics visibility**: Teams can alert on circuit breaker state changes

### Structured Logging Enables Debugging at Scale

**Problem**: Console.log debugging doesn't scale:
1. Logs are unstructured text, requiring regex to parse
2. No consistent format across modules
3. No correlation between related log entries
4. Log aggregation systems can't efficiently index or query

**Solution**: Structured JSON logging with `pino`:

```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "fb-live-comments",
  "module": "comment-service",
  "streamId": "abc123",
  "userId": "user456",
  "commentId": "7891011",
  "latency": 45,
  "msg": "Comment created successfully"
}
```

**Implementation Details**:
- Child loggers add context (module, streamId, userId) to all log entries in scope
- Development mode uses `pino-pretty` for human-readable output
- Production mode outputs raw JSON for log aggregation (ELK, Splunk, etc.)
- Log levels are configurable via `LOG_LEVEL` environment variable
- Fatal logs trigger graceful shutdown

**Why Pino?**
- **Fastest Node.js logger**: Important for high-throughput comment processing
- **Structured by default**: No string concatenation or formatting
- **Child loggers**: Context propagation without passing logger instances everywhere
- **Pretty-printing in dev**: Best of both worlds for development experience
