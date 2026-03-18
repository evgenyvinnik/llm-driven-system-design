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
