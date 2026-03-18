# YouTube - Video Platform - Architecture Design

## System Overview

A video hosting and streaming platform that supports video upload, transcoding, adaptive streaming, recommendations, and social features (comments, subscriptions, reactions). The system is designed around two computationally expensive operations -- video transcoding and recommendation generation -- both of which benefit from asynchronous processing and horizontal scaling. The architecture separates concerns into upload/ingest, transcoding, metadata, streaming, and recommendation services, connected by message queues for reliability.

## Requirements

### Functional Requirements

- **Video Upload**: Chunked uploads for large files (up to 5GB), progress tracking, resumable uploads
- **Transcoding**: Convert uploaded videos to multiple resolutions (1080p, 720p, 480p, 360p) with HLS packaging
- **Streaming**: Adaptive bitrate streaming via HLS, quality selection, seek support
- **Channels**: User-owned channels with customization (banner, description, playlists)
- **Subscriptions**: Subscribe to channels, subscription feed with notification preferences
- **Comments**: Threaded comments on videos with replies and reactions
- **Recommendations**: Personalized video suggestions based on watch history, subscriptions, and trending signals
- **Search**: Full-text search across video titles, descriptions, and channel names

### Non-Functional Requirements

- **Scalability**: Support 100M daily active users, 500K concurrent viewers, 500 hours of video uploaded per minute
- **Availability**: 99.99% uptime for streaming; 99.9% for upload and metadata APIs; graceful degradation for recommendations
- **Latency**: Video start time < 2 seconds; API responses < 100ms p95; search < 300ms p95; upload chunk acknowledgement < 500ms
- **Consistency**: Strong consistency for user actions (comments, subscriptions, reactions); eventual consistency for view counts, subscriber counts, and recommendations
- **Durability**: Zero data loss for uploaded videos; transcoding jobs must survive worker crashes

## Capacity Estimation

### Production Scale

| Metric | Value | Sizing Implication |
|--------|-------|-------------------|
| DAU | 100M | ~1.2M concurrent at peak |
| Video uploads | 500 hrs/min | ~30K videos/hour assuming 1-min average |
| Storage growth | ~50TB/day | Multi-resolution + raw + thumbnails |
| View events | ~5B/day | Batch aggregation, not real-time writes |
| API requests | ~500K RPS peak | Horizontally scaled API fleet |
| CDN bandwidth | ~100 Tbps peak | Edge caching critical for cost |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 1-5 |
| Videos | ~100 |
| Storage | < 5GB (MinIO) |
| API throughput | < 10 RPS |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                   │
│     Web (React SPA) / Mobile (React Native) / Smart TV / Embed          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           CDN Layer                                     │
│    CloudFront / Akamai — video segments, thumbnails, static assets      │
│    Edge cache hit rate target: > 95%                                    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        API Gateway                                      │
│          Rate limiting, auth validation, request routing                 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
         ┌───────────┬───────────┼───────────┬───────────────┐
         ▼           ▼           ▼           ▼               ▼
┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐
│   Upload    │ │ Metadata │ │ Streaming│ │    Rec    │ │  Search  │
│   Service   │ │ Service  │ │ Service  │ │  Service  │ │ Service  │
│             │ │          │ │          │ │           │ │          │
│ - Chunked   │ │ - Videos │ │ - HLS    │ │ - Feed    │ │ - Index  │
│ - Resume    │ │ - Channels│ │ - ABR   │ │ - Suggest │ │ - Query  │
│ - Validate  │ │ - Comments│ │ - Serve  │ │ - Trending│ │ - Rank   │
└──────┬──────┘ └─────┬────┘ └─────┬────┘ └─────┬─────┘ └─────┬────┘
       │              │            │             │             │
       │              ▼            │             ▼             ▼
       │         ┌─────────┐      │        ┌─────────┐  ┌───────────┐
       │         │ PostgreSQL│     │        │  Redis   │  │Elasticsearch│
       │         │ (Primary)│     │        │ (Cache)  │  │ (Full-text)│
       │         └─────────┘      │        └─────────┘  └───────────┘
       │                          │
       ▼                          ▼
┌─────────────┐           ┌─────────────┐
│  RabbitMQ   │           │  S3 / Blob  │
│  (Job Queue)│           │  Storage    │
└──────┬──────┘           └─────────────┘
       │
       ├──── Transcoder Worker 1 ──▶ 1080p, 720p, 480p, 360p + HLS
       ├──── Transcoder Worker 2
       └──── Transcoder Worker N
```

## Core Components

### 1. Upload Service

Handles chunked, resumable uploads for large video files. Each upload session is tracked in PostgreSQL with chunk progress. The flow:

1. Client requests an upload session, providing file metadata (size, MIME type, chunk count)
2. Server creates an `upload_sessions` row and returns a session ID
3. Client uploads chunks sequentially or in parallel, each acknowledged individually
4. On final chunk, server assembles the file in object storage and publishes a transcoding job to RabbitMQ
5. If the client disconnects, the session can be resumed by querying which chunks were received

Upload sessions expire after 24 hours. A background cleanup job removes abandoned sessions and their partial uploads from object storage.

### 2. Transcoding Pipeline

Transcoding is the most resource-intensive operation. Videos are converted to multiple resolutions with HLS packaging for adaptive bitrate streaming.

```
┌────────────┐     ┌─────────────┐     ┌─────────────────────┐
│  RabbitMQ  │────▶│  Transcoder │────▶│  Object Storage     │
│  Job Queue │     │  Worker     │     │  (processed bucket) │
└────────────┘     └──────┬──────┘     └─────────────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │  PostgreSQL │
                   │ (status →   │
                   │  ready)     │
                   └─────────────┘
```

**Output per video:**
- 4 resolution variants (1080p, 720p, 480p, 360p)
- HLS manifest (master + per-quality playlists)
- Thumbnail at multiple timestamps
- Duration metadata

**Failure handling:** Jobs are acknowledged only after successful processing. Failed jobs are retried with exponential backoff (max 3 retries). Permanently failed jobs go to a dead-letter queue for manual review. The video status is set to `failed` so the uploader can be notified.

### 3. Metadata Service

Serves video metadata, channel information, comments, subscriptions, and reactions. This is the highest-traffic read service.

**Caching strategy:**
- Video metadata: cached in Redis with 5-minute TTL (invalidated on update)
- Channel info: cached with 10-minute TTL
- Comment counts: eventual consistency, updated via denormalized counters
- Subscriber counts: maintained by PostgreSQL triggers on the subscriptions table

### 4. Streaming Service

Serves HLS manifests and video segments from object storage (or CDN origin).

**Adaptive bitrate flow:**
1. Client requests master manifest (`/videos/{id}/master.m3u8`)
2. Master manifest lists available qualities with bandwidth hints
3. Client selects quality based on network conditions
4. Client fetches segments from the quality-specific playlist
5. Client can switch qualities mid-stream based on bandwidth changes

### 5. Recommendation Service

Generates personalized video feeds using a multi-signal approach:

**Candidate generation (broad, fast):**
- Subscription-based: recent videos from subscribed channels (40%)
- Category-based: videos matching viewed categories (25%)
- Trending: globally popular videos (20%)
- Collaborative: "users like you also watched" (15%)

**Ranking (narrow, precise):**
- Watch completion rate prediction
- Freshness boost (time decay)
- Creator quality score
- Diversity injection (avoid repetitive content)

**View counting:**
View events are buffered in Redis using `INCR` and flushed to PostgreSQL every 60 seconds. This trades exact real-time accuracy for significant write reduction (5B daily events become ~100M batch updates).

## Database Schema

```sql
-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- USERS TABLE
-- =============================================================================
-- Users serve as both viewers and channel owners. Each user has an optional
-- channel (channel_name, channel_description) that becomes active when they
-- upload. Denormalized subscriber_count avoids COUNT(*) on channel pages.

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    channel_name VARCHAR(100),
    channel_description TEXT,
    avatar_url TEXT,
    subscriber_count BIGINT DEFAULT 0,   -- Updated via trigger
    role VARCHAR(20) DEFAULT 'user',     -- 'user', 'creator', 'admin'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);

-- =============================================================================
-- VIDEOS TABLE
-- =============================================================================
-- Uses YouTube-style short IDs (11 chars) for shareable URLs.
-- Status workflow: uploading -> processing -> ready/failed -> blocked
-- Counters are denormalized for performance; updated via batch jobs.

CREATE TABLE videos (
    id VARCHAR(11) PRIMARY KEY,
    channel_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    duration_seconds INTEGER,
    status VARCHAR(20) DEFAULT 'processing',   -- uploading|processing|ready|failed|blocked
    visibility VARCHAR(20) DEFAULT 'public',   -- public|unlisted|private
    view_count BIGINT DEFAULT 0,
    like_count BIGINT DEFAULT 0,
    dislike_count BIGINT DEFAULT 0,
    comment_count BIGINT DEFAULT 0,
    categories TEXT[] DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    thumbnail_url TEXT,
    raw_video_key TEXT,
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_videos_channel ON videos(channel_id, published_at DESC);
CREATE INDEX idx_videos_published ON videos(published_at DESC) WHERE status = 'ready';
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_videos_visibility ON videos(visibility) WHERE visibility = 'public';
CREATE INDEX idx_videos_tags ON videos USING GIN(tags);
CREATE INDEX idx_videos_categories ON videos USING GIN(categories);

-- =============================================================================
-- VIDEO RESOLUTIONS TABLE
-- =============================================================================
-- Transcoded video variants for adaptive bitrate streaming.

CREATE TABLE video_resolutions (
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    resolution VARCHAR(10) NOT NULL,    -- '1080p', '720p', '480p', '360p'
    manifest_url TEXT,
    video_url TEXT,
    bitrate INTEGER,
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (video_id, resolution)
);

-- =============================================================================
-- COMMENTS TABLE
-- =============================================================================
-- Threaded comments with self-referential parent_id for replies.

CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    is_edited BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_comments_video ON comments(video_id, created_at DESC);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_user ON comments(user_id, created_at DESC);

-- =============================================================================
-- SUBSCRIPTIONS TABLE
-- =============================================================================
CREATE TABLE subscriptions (
    subscriber_id UUID REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES users(id) ON DELETE CASCADE,
    notifications_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (subscriber_id, channel_id)
);

CREATE INDEX idx_subscriptions_channel ON subscriptions(channel_id);
CREATE INDEX idx_subscriptions_subscriber ON subscriptions(subscriber_id);

-- =============================================================================
-- VIDEO REACTIONS TABLE
-- =============================================================================
CREATE TABLE video_reactions (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    reaction_type VARCHAR(10) NOT NULL,   -- 'like' or 'dislike'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, video_id)
);

CREATE INDEX idx_video_reactions_video ON video_reactions(video_id, reaction_type);

-- =============================================================================
-- COMMENT LIKES TABLE
-- =============================================================================
CREATE TABLE comment_likes (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, comment_id)
);

CREATE INDEX idx_comment_likes_comment ON comment_likes(comment_id);

-- =============================================================================
-- WATCH HISTORY TABLE
-- =============================================================================
-- Tracks user viewing behavior for recommendations and resume playback.

CREATE TABLE watch_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    video_id VARCHAR(11) REFERENCES videos(id) ON DELETE CASCADE,
    watch_duration_seconds INTEGER DEFAULT 0,
    watch_percentage DECIMAL(5,2) DEFAULT 0,
    last_position_seconds INTEGER DEFAULT 0,
    watched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_watch_history_user ON watch_history(user_id, watched_at DESC);
CREATE INDEX idx_watch_history_video ON watch_history(video_id);
CREATE INDEX idx_watch_history_user_video ON watch_history(user_id, video_id);

-- =============================================================================
-- UPLOAD SESSIONS TABLE
-- =============================================================================
-- Manages chunked upload state. Sessions expire after 24 hours.

CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    content_type VARCHAR(100),
    total_chunks INTEGER NOT NULL,
    uploaded_chunks INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    minio_upload_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id, status);
CREATE INDEX idx_upload_sessions_expires ON upload_sessions(expires_at) WHERE status = 'active';

-- =============================================================================
-- TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_videos_updated_at BEFORE UPDATE ON videos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_comments_updated_at BEFORE UPDATE ON comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Auto-update subscriber_count on subscription changes
CREATE OR REPLACE FUNCTION update_subscriber_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE users SET subscriber_count = subscriber_count + 1 WHERE id = NEW.channel_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE users SET subscriber_count = subscriber_count - 1 WHERE id = OLD.channel_id;
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER trigger_update_subscriber_count
    AFTER INSERT OR DELETE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_subscriber_count();
```

## API Design

### Upload API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/uploads/start` | Create upload session, returns session ID |
| PUT | `/api/v1/uploads/:sessionId/chunks/:chunkIndex` | Upload a single chunk |
| POST | `/api/v1/uploads/:sessionId/complete` | Finalize upload, trigger transcoding |
| GET | `/api/v1/uploads/:sessionId/status` | Check upload progress |

### Video API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/videos/:id` | Get video metadata + resolutions |
| GET | `/api/v1/videos/:id/comments` | Get threaded comments (paginated) |
| POST | `/api/v1/videos/:id/comments` | Add a comment |
| POST | `/api/v1/videos/:id/reactions` | Like or dislike a video |
| POST | `/api/v1/videos/:id/view` | Record a view event |
| GET | `/api/v1/videos/:id/stream` | Get HLS master manifest |

### Channel API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/channels/:id` | Get channel profile + stats |
| GET | `/api/v1/channels/:id/videos` | Get channel videos (paginated) |
| POST | `/api/v1/channels/:id/subscribe` | Subscribe to channel |
| DELETE | `/api/v1/channels/:id/subscribe` | Unsubscribe |

### Feed API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/feed/home` | Personalized home feed |
| GET | `/api/v1/feed/subscriptions` | Videos from subscribed channels |
| GET | `/api/v1/feed/trending` | Globally trending videos |
| GET | `/api/v1/feed/history` | User watch history |

### Auth API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Create account |
| POST | `/api/v1/auth/login` | Login, set session cookie |
| POST | `/api/v1/auth/logout` | Destroy session |
| GET | `/api/v1/auth/me` | Get current user |

## Key Design Decisions

### 1. Chunked Upload with Resumability

**Decision**: Multipart chunked uploads with server-side session tracking.

**Why it works**: Video files are large (100MB-5GB). A single HTTP request for the entire file is unreliable on mobile networks. Chunked uploads allow resumption after network failures without re-uploading the entire file. Each chunk is independently acknowledged, so the client knows exactly where to resume.

**Why not direct-to-S3 presigned URLs**: Presigned URLs are simpler but lose server-side visibility into upload progress. With chunked uploads through the API server, we can enforce rate limits, validate content types, track progress for the UI, and immediately publish transcoding jobs on completion. The trade-off is higher API server bandwidth, which we accept for the control it provides.

### 2. RabbitMQ for Transcoding Jobs

**Decision**: RabbitMQ with persistent queues over Kafka.

**Why it works**: Transcoding is a classic work queue pattern -- each video needs to be processed exactly once by one worker. RabbitMQ's built-in acknowledgement and retry semantics fit this perfectly. Dead-letter queues handle permanent failures. Queue depth metrics enable auto-scaling decisions.

**Why not Kafka**: Kafka excels at event streaming where multiple consumers need the same data (analytics, audit logs). For a work queue where each message is consumed once and order doesn't matter, Kafka adds complexity (consumer groups, partition management, offset tracking) without benefit. Kafka would be the right choice for the view event stream.

### 3. View Count Buffering in Redis

**Decision**: Buffer view counts in Redis, flush to PostgreSQL every 60 seconds.

**Why it works**: At production scale, view events would generate 50K+ writes per second. Writing each view directly to PostgreSQL would overwhelm the database. Redis `INCR` operations handle this throughput trivially, and periodic batch flushes reduce database writes by 100-1000x.

**What we give up**: View counts are eventually consistent with up to 60 seconds of lag. This is acceptable because exact real-time view counts are not critical for user experience -- a video showing "1.2M views" vs "1,200,047 views" makes no difference.

### 4. Denormalized Counters with Triggers

**Decision**: Store `subscriber_count`, `view_count`, `like_count` directly on the parent row, updated by triggers and batch jobs.

**Why it works**: Counting queries (`SELECT COUNT(*) FROM subscriptions WHERE channel_id = $1`) are expensive and get slower as the table grows. Denormalized counters make channel pages and video cards O(1) reads.

**Trade-off**: Counter accuracy depends on trigger reliability. In rare failure cases (transaction rollback after trigger fires), counts can drift. A nightly reconciliation job corrects any drift.

## Consistency and Idempotency

**Upload idempotency**: Each upload session has a unique ID. Re-uploading a chunk that was already received is a no-op (server checks `uploaded_chunks` count). Completing an already-completed session returns the existing video ID.

**Reaction idempotency**: The `video_reactions` table has a composite primary key `(user_id, video_id)`. Repeated likes are upserts, not duplicates. Changing from like to dislike is a single `UPDATE`.

**View deduplication**: Views are buffered in Redis with a per-user-per-video cooldown key (`view:{userId}:{videoId}` with 30-second TTL). Multiple page loads within 30 seconds count as one view.

## Security and Auth

**Session-based authentication**: Redis-backed sessions with HTTP-only, secure cookies. Sessions expire after 7 days. Immediate revocation by deleting the Redis key (vs. JWT where you cannot revoke without a blocklist).

**Role-based access control**: Three roles -- `user` (view content), `creator` (upload videos), `admin` (moderation, user management). Enforced via middleware on every route.

**Rate limiting**: Redis-backed rate limiters per endpoint category:

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| Auth (login/register) | 5 requests | 15 minutes |
| Upload | 10 uploads | 1 hour |
| Comments | 30 requests | 1 minute |
| General API | 100 requests | 1 minute |

## Observability

**Prometheus metrics** (via `prom-client`):
- HTTP request rate and latency histograms by route and status code
- Video upload count and size distribution
- Transcoding queue depth, job duration, and success/failure rates
- View, comment, reaction, and subscription counters
- Database query duration and connection pool gauge
- Cache hit/miss ratio
- Circuit breaker state gauge
- Rate limit hit counter

**Structured logging** (via `pino`):
- JSON format for machine parsing
- Request ID propagation across all log entries
- Event-based logging (`video_uploaded`, `transcode_completed`, `view_counts_flushed`)

**Health checks**:
- `/health` -- liveness probe (is the process running?)
- `/health/ready` -- readiness probe (are PostgreSQL, Redis, and RabbitMQ reachable?)
- `/health/detailed` -- full dependency health with latency measurements

## Failure Handling

### Circuit Breakers

Circuit breakers (via Opossum) protect against cascading failures:

- **Storage operations**: If MinIO/S3 becomes unresponsive, the circuit opens and upload requests fail fast with a clear error instead of timing out for 30 seconds each
- **Transcoding service**: If the transcoding pipeline is overwhelmed, new jobs are queued for later rather than piling up

Configuration: 50% error threshold, 30-second reset timeout, 10-request volume threshold before tripping.

### Retry Strategy

Transient failures (network timeouts, connection resets) are retried with exponential backoff and jitter:
- Initial delay: 1 second
- Maximum delay: 30 seconds
- Maximum retries: 3
- Jitter: random 0-1 second added to prevent thundering herd

Non-retryable errors (validation failures, auth errors, 4xx responses) fail immediately.

### Graceful Degradation

| Component Failure | Degradation Behavior |
|-------------------|---------------------|
| Redis (cache) down | Direct database queries; higher latency but functional |
| RabbitMQ down | Uploads accepted but transcoding delayed until queue recovers |
| Recommendation service slow | Fall back to trending/recent videos |
| Storage timeout | Circuit breaker opens; uploads return 503 |

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new HTTP connections
2. Flush remaining buffered view counts to PostgreSQL
3. Wait for in-flight requests to complete (10-second timeout)
4. Close database and Redis connections
5. Exit

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless; scale horizontally behind a load balancer. Session state is in Redis, so any instance can serve any request.
2. **Transcoder workers**: Scale independently based on queue depth. Each worker pulls jobs from RabbitMQ and processes them in isolation.
3. **PostgreSQL**: Read replicas for metadata queries. Write sharding by channel_id for very large scale. Connection pooling via PgBouncer.
4. **Redis**: Cluster mode for cache partitioning. Separate Redis instances for sessions vs. view count buffering.
5. **Object storage**: S3/GCS is inherently scalable. CDN edge caching reduces origin load by >95%.

### What Breaks First

1. **Database writes** from view counting -- solved by Redis buffering
2. **Transcoding throughput** -- solved by adding workers, the queue absorbs burst
3. **Metadata read load** -- solved by Redis caching and read replicas
4. **Storage costs** -- solved by tiered storage (hot/warm/cold) and CDN caching

### CDN Strategy

- Popular videos (>10K views) are cached at edge with long TTLs
- HLS segments are immutable and infinitely cacheable
- Thumbnails cached at edge with 24-hour TTL
- Cache invalidation only needed for deleted/blocked content

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Upload approach | Chunked via API server | Direct-to-S3 presigned URLs | Server-side progress tracking, rate limiting, immediate job publish |
| Transcoding queue | RabbitMQ | Kafka | Work queue pattern fits better; simpler ACK/retry semantics |
| View counting | Redis buffer + batch flush | Direct DB writes | 100-1000x write reduction at scale |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler token management |
| Video IDs | 11-char short IDs | UUID | Shareable URLs, YouTube-compatible format |
| Counter storage | Denormalized on parent row | COUNT(*) queries | O(1) reads for video cards and channel pages |
| Thumbnails | Generated during transcode | User-uploaded | Consistent quality, multiple timestamp options |

---

## Implementation Notes

This section maps the production architecture above to what is actually running locally.

### Local Architecture

```
┌───────────────────────┐         ┌───────────────────────┐
│   React Frontend      │────────▶│   Express API Server  │
│   :5173 (Vite)        │         │   :3000                │
│                       │         │                       │
│ - Video player (HLS)  │         │ - Upload routes       │
│ - Channel pages       │         │ - Video/channel CRUD  │
│ - Feed/browse views   │         │ - Feed/recommendations│
│ - Upload modal        │         │ - Auth (cookie-based) │
│ - Comment threads     │         │ - Rate limiting       │
│ - Zustand state       │         │ - Prometheus metrics  │
└───────────────────────┘         └────┬──────────┬───────┘
                                       │          │
                          ┌────────────┘          │
                          ▼                       ▼
                 ┌─────────────────┐    ┌─────────────────┐
                 │   PostgreSQL    │    │   Valkey/Redis   │
                 │   :5432         │    │   :6379          │
                 │   (youtube db)  │    │   (view counts,  │
                 └─────────────────┘    │    rate limits)  │
                                        └─────────────────┘
                 ┌─────────────────┐    ┌─────────────────┐
                 │   MinIO         │    │   RabbitMQ       │
                 │   :9000 (API)   │    │   :5672 (AMQP)   │
                 │   :9001 (UI)    │    │   :15672 (mgmt)  │
                 │   Buckets:      │    │                   │
                 │   - raw-videos  │    │   Transcode jobs  │
                 │   - processed   │    │   consumed by     │
                 │   - thumbnails  │    │   worker process  │
                 └─────────────────┘    └─────────────────┘
```

Run with:
```
docker-compose up -d              # Infrastructure
cd backend && npm run dev         # API server on :3000
cd backend && npm run dev:worker  # Transcode worker
cd frontend && npm run dev        # Frontend on :5173
```

### Production Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Structured logging | Pino JSON logger with request ID propagation | `backend/src/shared/logger.ts` |
| Prometheus metrics | 15+ custom metrics (uploads, views, transcoding, cache) | `backend/src/shared/metrics.ts` |
| Circuit breakers | Opossum wrapping storage operations | `backend/src/shared/circuitBreaker.ts` |
| Rate limiting | Redis-backed per-endpoint rate limiters | `backend/src/shared/rateLimiter.ts` |
| Retry with backoff | Exponential backoff with jitter for transient failures | `backend/src/shared/retry.ts` |
| Health checks | Liveness, readiness, and detailed probes | `backend/src/shared/health.ts` |
| Resilient storage | Storage operations wrapped with circuit breaker + retry | `backend/src/shared/resilientStorage.ts` |
| Message queue | RabbitMQ publish/consume for transcoding jobs | `backend/src/shared/queue.ts` |
| View count buffering | Redis INCR with periodic flush to PostgreSQL | `backend/src/utils/redis.ts`, `backend/src/index.ts` |
| Graceful shutdown | SIGTERM handler flushes view counts before exit | `backend/src/index.ts` |
| Chunked uploads | Multipart upload with session tracking in PostgreSQL | `backend/src/routes/upload.ts` |
| Denormalized counters | PostgreSQL triggers for subscriber_count | `backend/src/db/init.sql` |

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| AWS S3 / GCS | MinIO (S3-compatible) | Same API, runs in Docker |
| CDN (CloudFront/Akamai) | Direct MinIO access | No edge caching needed locally |
| FFmpeg transcoding | Simulated transcoding | Focuses on pipeline design, not video processing |
| Kafka (view events) | Redis INCR + batch flush | Simpler for local scale |
| Elasticsearch | PostgreSQL ILIKE queries | Full-text search not implemented |
| OAuth / JWT | Session cookies in Redis | Simpler for learning |
| PgBouncer | Direct pg connections | Single instance doesn't need pooling |
| Multi-region deployment | Single Docker Compose | All services on localhost |

### What Was Omitted

- **CDN layer**: No edge caching; videos served directly from MinIO
- **Real FFmpeg transcoding**: Pipeline is simulated; generates placeholder resolutions
- **Full-text search**: No Elasticsearch; search is basic SQL `ILIKE`
- **ML-based recommendations**: Recommendation uses rule-based scoring, not trained models
- **Multi-region**: Single-node deployment
- **Kubernetes**: No container orchestration
- **Auto-scaling**: Fixed number of workers
- **Video content moderation**: No ML-based content analysis
- **Push notifications**: No notification system for new uploads
- **Playlist management**: Schema supports it but no UI/API implementation

---

## Frontend Architecture

This section describes how the React frontend is structured and why each architectural decision was made.

### Component Hierarchy

```
RootLayout (__root.tsx, checks auth on mount)
├── Header (search bar, upload button, auth modal trigger)
├── Sidebar (fixed 240px, nav links: Home, Trending, Subscriptions, History, Studio)
└── <Outlet /> (route content, offset by sidebar width)
    ├── HomePage (/) -- video grid with recommendations or search results
    │   └── VideoCard[] (thumbnail, channel avatar, title, view count, time ago)
    ├── WatchPage (/watch/$videoId) -- video player + metadata + comments
    │   ├── VideoPlayer (custom player with quality selector, progress, volume)
    │   ├── Video metadata (title, channel, subscribe, like/dislike, description)
    │   └── CommentSection (threaded comments, replies, likes)
    ├── ChannelPage (/channel/$channelId) -- channel banner, tabs, video grid
    ├── TrendingPage (/trending) -- trending video grid
    ├── SubscriptionsPage (/subscriptions) -- subscription feed
    ├── HistoryPage (/history) -- watch history list
    ├── StudioPage (/studio) -- creator dashboard (manage uploaded videos)
    ├── AuthModal (overlay for login/register)
    └── UploadModal (overlay for video upload with progress)
```

The root layout uses a fixed sidebar + header shell that persists across all routes. The sidebar is fixed at 240px width, and the main content area is offset with `ml-60`. The header is fixed at the top with `pt-14` padding on the content area to prevent overlap. Authentication status is checked once on mount via `checkAuth()` in the root layout's `useEffect`.

### Zustand Stores

YouTube uses three Zustand stores, each managing a distinct domain. Zustand's selector-based subscriptions prevent unnecessary re-renders -- critical for the video player where `currentTime` updates many times per second but only the progress bar component needs to re-render.

**`authStore`** manages authentication: current user, loading state, and error messages. This store uses Zustand's `persist` middleware with `localStorage`, which means the user object survives page refreshes without an API call. On load, `checkAuth` still verifies the session with the backend to ensure the cached user data is current. The `partialize` option limits persistence to just the `user` field, preventing transient state (loading, error) from being persisted.

**`videoStore`** is the primary data store, managing: current video (for the watch page), recommendations (personalized home feed), trending videos, search results, search query, and pagination state. This store centralizes all video-related API calls including `fetchRecommendations`, `fetchTrending`, `searchVideos`, `reactToVideo`, and `recordView`. The `reactToVideo` action implements **optimistic updates** -- when a user clicks like or dislike, the UI immediately updates the local like/dislike count and reaction state, then sends the API request in the background. This avoids a 100-200ms delay where the button would appear unresponsive. If the API call fails, the optimistic update remains (a minor inconsistency that self-corrects on the next page load), because reverting the UI after the user has already moved on would feel jarring. The optimistic update logic handles all state transitions: like-to-dislike (decrement like, increment dislike), removing a reaction (decrement the active count), and switching reactions (decrement old, increment new).

**`uploadStore`** manages the video upload lifecycle: upload progress, transcoding status, and error handling. This store supports two upload modes: simple upload for files under 50MB (single POST request) and chunked upload for larger files (initialize session, upload 5MB chunks sequentially, complete session). During chunked uploads, the store tracks `uploadedChunks`, `totalChunks`, and `progress` (percentage), enabling a real-time progress bar in the upload modal. After upload completes, the store can poll `checkTranscodingStatus` to show transcoding progress (the video moves through `processing -> ready/failed` status).

### TanStack Router Structure

YouTube uses **file-based routing** via TanStack Router's Vite plugin. Route files are automatically discovered in `routes/` and compiled into `routeTree.gen.ts`.

| File | Path | Purpose |
|------|------|---------|
| `__root.tsx` | (layout) | Shell with Header, Sidebar, auth check |
| `index.tsx` | `/` | Home feed (recommendations or search results) |
| `watch.$videoId.tsx` | `/watch/:videoId` | Video player with comments |
| `channel.$channelId.tsx` | `/channel/:channelId` | Channel page with video grid |
| `trending.tsx` | `/trending` | Trending videos |
| `subscriptions.tsx` | `/subscriptions` | Subscription feed |
| `history.tsx` | `/history` | Watch history |
| `studio.tsx` | `/studio` | Creator dashboard |

Dynamic segments use the `$param` convention (e.g., `watch.$videoId.tsx`), providing type-safe parameter access via `useParams()`.

### Data Fetching Pattern

The frontend uses a centralized API service (`services/api.ts`) that wraps `fetch` with consistent error handling, cookie credentials, and content-type headers. The service exposes typed methods: `api.get<T>`, `api.post<T>`, `api.patch<T>`, `api.delete`, `api.simpleUpload`, and `api.uploadChunk`. Zustand store actions call these methods and update state. Route components trigger store actions in `useEffect` on mount.

The homepage demonstrates conditional data fetching: if a search query is active in the video store, it displays search results instead of recommendations. This avoids separate search and home routes while maintaining a single-page feel.

### Key UI Patterns

**Custom Video Player** -- The video player is a self-contained component managing local state for playback (play/pause, current time, duration, volume, mute, fullscreen, quality selection, settings panel). It does not use a Zustand store for playback state because video player state is scoped to the watch page and does not need to persist across navigation (unlike Spotify where music continues during navigation). The player reports progress to the parent component via an `onProgress` callback every 5 seconds, which records watch history to the backend. Quality selection is implemented as a settings dropdown that allows switching between transcoded resolutions (1080p, 720p, 480p, 360p); on switch, the component saves the current time, changes the video source, then restores the position and play state after a 100ms delay to allow the new source to load.

**Progress Bar** -- YouTube-style red progress bar with a scrubber dot that appears on hover. The progress bar uses direct DOM position calculation (`getBoundingClientRect`) for seek-on-click, providing pixel-accurate seeking. The scrubber dot scales from 0 to full size on hover via CSS transition.

**Comment Section** -- Implements threaded comments with three features: (1) new comment submission with focus-dependent action buttons (Cancel/Comment appear only when the input is focused), (2) replies with inline reply forms, and (3) optimistic like updates. Comment likes update the local count immediately without waiting for the API response. The section supports both authenticated (full interaction) and unauthenticated (read-only with "Sign in to comment" prompt) states.

**Upload Modal with Chunked Progress** -- The upload modal shows a multi-step flow: file selection, metadata entry (title, description, categories, tags), upload progress (with per-chunk tracking), and transcoding status. The 5MB chunk size balances reliability (smaller chunks are more likely to succeed on poor connections) with overhead (too many chunks increase HTTP overhead from headers and connection setup).

**Skeleton Loading** -- The homepage renders animated skeleton cards (pulsing gray rectangles matching the VideoCard layout) during data loading, preventing layout shift and providing visual feedback that content is being fetched.

---

## Deep Pattern Explanations

This section explains the production-grade patterns implemented in this project from first principles.

### RBAC (Role-Based Access Control)

YouTube defines three roles: `user` (view content, comment, react), `creator` (upload videos, manage own channel), and `admin` (moderation, user management). RBAC centralizes authorization into a role-based hierarchy rather than scattering permission checks across route handlers.

The middleware chain processes requests in sequence: (1) extract session token from the HTTP-only cookie and look up in Redis, (2) attach the user object (including role) to the request, (3) compare the user's role against the endpoint's minimum required role. For example, the upload endpoint requires `creator`, while the comment endpoint requires `user`. The role hierarchy means `admin` can perform any action that `creator` or `user` can.

Without RBAC, authorization would require checking individual user flags or IDs in every route handler. Adding a new protected endpoint would mean remembering to add the right permission check. With RBAC, adding a new endpoint means adding one `ensureRole('creator')` middleware call, and the authorization logic is centralized and auditable.

### Redis Cache-Aside Pattern

The cache-aside pattern reduces database load by checking Redis before querying PostgreSQL. A typical PostgreSQL query takes 2-10ms (query parsing, planning, index lookup, network round-trip); a Redis `GET` takes ~0.1ms. This 20-100x speedup is critical when serving 500K RPS at production scale.

YouTube applies cache-aside with different TTLs by data volatility:
- **Video metadata**: 5-minute TTL. Video metadata changes infrequently (title edits are rare), so a 5-minute cache window is acceptable. At peak load, this cache absorbs ~95% of metadata reads.
- **Channel info**: 10-minute TTL. Channel descriptions and subscriber counts change even less frequently.
- **Comment counts**: Eventual consistency. Denormalized counters are updated via batch jobs, and the cached values may lag by minutes. This is acceptable because displaying "1.2M views" vs "1,200,047 views" makes no difference to the user.

**Invalidation strategy**: When data changes (video updated, subscriber count changed), the service deletes the cache key. The next read triggers a cache miss, re-fetches from PostgreSQL, and populates a fresh cache entry. This "delete on write" approach is simpler and safer than "update on write," which risks race conditions where a stale write overwrites a newer value.

Why not an in-memory cache? YouTube runs multiple API server instances behind a load balancer. An in-memory cache is per-process -- instance A and instance B would have independent, potentially inconsistent caches. When a user updates their video title on instance A, instance B's cache would still serve the old title until its TTL expires. Redis provides a shared cache visible to all instances with atomic operations for safe concurrent access.

### Circuit Breaker Pattern

When a downstream service (MinIO storage, Redis, RabbitMQ) becomes slow or unresponsive, requests pile up waiting for timeouts. If the API server has 100 request processing slots and 80 are waiting on a dead storage service, only 20 remain for healthy requests. Eventually all slots are consumed, and the entire API goes down -- even for endpoints that don't use storage. This is a cascading failure.

The circuit breaker has three states:
- **CLOSED** (normal): Requests pass through. The breaker tracks the error rate over a rolling window (last 10 requests).
- **OPEN** (tripped): When errors exceed 50%, the breaker opens. All requests fail immediately (~1ms) instead of waiting for timeouts (~30 seconds). This is the critical insight: fast failure preserves capacity for healthy endpoints.
- **HALF-OPEN** (recovery test): After the reset timeout (30 seconds), the breaker allows one probe request. If it succeeds, the breaker closes. If it fails, it reopens.

YouTube wraps two critical paths with circuit breakers:
- **Storage operations**: If MinIO becomes unresponsive, upload requests fail fast with a clear error instead of hanging for 30 seconds each.
- **Transcoding service**: If the transcoding pipeline is overwhelmed, new jobs are queued for later rather than piling up and exhausting connection pools.

Configuration: 50% error threshold, 30-second reset timeout, 10-request volume threshold (prevents a single slow query from tripping the breaker). The Prometheus gauge `circuit_breaker_state` (0=closed, 1=half-open, 2=open) enables alerting on state changes.

### Structured Logging with Pino

`console.log` fails at scale. With 50 API server instances producing thousands of log lines per second, unstructured text like `"Upload completed for video xyz"` is unsearchable. You cannot filter by severity, correlate entries across a single request, aggregate error counts, or trigger alerts.

Structured logging replaces text output with JSON objects:
```json
{"level":"info","time":1710500000,"msg":"video_uploaded","videoId":"abc123","userId":"user456","requestId":"req-789","size":52428800}
```

Each entry has consistent fields: `level` (error/warn/info/debug), `time`, `msg` (event name), `requestId` (UUID that ties all log entries from a single HTTP request together). This enables:
- **Correlation**: Find all log entries for a failed upload by `requestId`
- **Aggregation**: Count `transcode_completed` events per minute to monitor pipeline throughput
- **Alerting**: Trigger alert when `msg == "circuit_breaker_opened"` or when error rate exceeds threshold
- **Filtering**: Show only errors from the last hour: `level == "error" AND time > now() - 3600`

Pino is used because it is the fastest JSON logger in Node.js -- it writes JSON directly to stdout with zero synchronous processing, unlike Winston which formats synchronously. For YouTube's transcoding events where thousands of status updates flow through per minute, this performance difference matters.

### Prometheus Metrics

Prometheus collects time-series numerical data that enables monitoring, alerting, and capacity planning. YouTube tracks 15+ custom metrics in addition to standard HTTP metrics.

**Three metric types:**
- **Counters** (monotonically increasing): `http_requests_total`, `video_uploads_total`, `view_counts_total`. Useful for computing rates: `rate(http_requests_total[5m])` gives RPS.
- **Histograms** (value distributions): `http_request_duration_seconds`, `transcode_duration_seconds`, `upload_size_bytes`. Enable percentile calculations: p95 latency is more useful than average because averages hide tail latency where 5% of requests take 10x longer.
- **Gauges** (current values): `circuit_breaker_state`, `db_pool_connections`, `transcode_queue_depth`. Show instantaneous system state.

**RED method** (Rate, Errors, Duration) for each service: request rate shows throughput, error rate shows reliability, duration shows performance. If transcoding queue depth (gauge) grows while completion rate (counter) stays flat, workers are falling behind and need scaling.

### Rate Limiting

Rate limiting prevents any single client from overwhelming the API. YouTube applies Redis-backed rate limiters per endpoint category with different limits reflecting the cost of each operation:

| Category | Limit | Window | Why |
|----------|-------|--------|-----|
| Auth | 5 | 15 min | Brute-force protection |
| Upload | 10 | 1 hour | Uploads trigger expensive transcoding |
| Comments | 30 | 1 min | Prevent comment spam |
| General API | 100 | 1 min | Normal browsing headroom |

The implementation uses Redis sorted sets (sliding window). Each request adds a timestamp entry. On each new request, entries older than the window are removed, the remaining count is checked, and the request is rejected with 429 if over the limit. This provides smooth enforcement without burst abuse.

Why not token bucket? Token bucket accumulates tokens during inactivity. A user idle for 10 minutes at 100/min could fire 1000 requests at once, overwhelming the transcoding queue or comment moderation pipeline. Sliding window prevents this by always counting requests within the rolling window.

### Idempotency

Idempotency ensures that retrying a failed operation does not create duplicates or corrupt data. YouTube needs idempotency in three places:

**Upload sessions**: Each session has a unique ID. Re-uploading a chunk that was already received is a no-op (server checks the `uploaded_chunks` count). Completing an already-completed session returns the existing video ID. This is critical because large file uploads over unreliable connections will inevitably be retried.

**Reactions**: The `video_reactions` table has a composite primary key `(user_id, video_id)`. Repeated likes are upserts, not duplicates. Changing from like to dislike is a single `UPDATE`. The API returns 200 (not 409) for repeated identical reactions, following the idempotent behavior principle.

**View deduplication**: Views are rate-limited per user per video in Redis with a 30-second cooldown key (`view:{userId}:{videoId}` with TTL). Multiple page loads within 30 seconds count as one view, preventing inflated view counts from rapid scrolling or page refreshes.

### Health Checks

Health checks are HTTP endpoints that report service status to load balancers and orchestrators.

**Liveness** (`/health`): Answers "is the process running?" Returns 200 if Express can respond. Must not call external dependencies -- a slow database should not cause the process to be killed and restarted by Kubernetes. Restarting a process because a database is slow only makes things worse (connection storm during restart).

**Readiness** (`/health/ready`): Answers "can this instance serve traffic?" Checks PostgreSQL, Redis, and RabbitMQ connectivity. If any is unreachable, the load balancer stops routing traffic to this instance. The instance remains alive and resumes serving when the dependency recovers. This prevents users from hitting an instance that would fail every request.

**Detailed** (`/health/detailed`): Returns per-dependency health with latency measurements, connection pool stats, and circuit breaker states. Used by operators for debugging during incidents, not by automated routing. Includes process memory usage and uptime.
