# YouTube - Video Platform - Architecture Design

## System Overview

A video hosting and streaming platform that supports video upload, transcoding, adaptive streaming, recommendations, and social features (comments, subscriptions, reactions). Designed for local development learning with patterns that scale to production.

## Requirements

### Functional Requirements

- **Video Upload**: Chunked uploads for large files (up to 5GB), progress tracking, resumable uploads
- **Transcoding**: Convert uploaded videos to multiple resolutions (1080p, 720p, 480p, 360p) with HLS packaging
- **Streaming**: Adaptive bitrate streaming via HLS, quality selection, seek support
- **Channels**: User-owned channels with customization (banner, description, playlists)
- **Subscriptions**: Subscribe to channels, subscription feed
- **Comments**: Threaded comments on videos, replies, reactions
- **Recommendations**: Personalized video suggestions based on watch history and subscriptions
- **Search**: Full-text search across video titles, descriptions, and channel names

### Non-Functional Requirements

- **Scalability**: Handle 1,000 concurrent users locally; design patterns support horizontal scaling
- **Availability**: 99.9% uptime target for streaming; graceful degradation for non-critical features
- **Latency**: Video start time < 2 seconds; API responses < 200ms p95; search < 500ms p95
- **Consistency**: Strong consistency for user actions (comments, subscriptions); eventual consistency for view counts and recommendations

## Capacity Estimation

### Local Development Scale

For learning and testing, target these baseline metrics:

| Metric | Value | Sizing Implication |
|--------|-------|-------------------|
| Daily Active Users (DAU) | 100 | Single PostgreSQL instance sufficient |
| Concurrent Viewers | 50 | 2-3 API server instances behind load balancer |
| Video Uploads/Day | 20 | Single transcoding worker handles queue |
| Average Video Size | 500 MB (raw) | ~10 GB/day raw storage growth |
| Videos in Library | 1,000 | ~50 GB processed video storage |
| Comments/Day | 500 | ~50 KB/day metadata growth |

### Derived Capacity Targets

| Component | Calculation | Target |
|-----------|-------------|--------|
| API RPS (peak) | 50 users x 2 req/sec | 100 RPS |
| Upload Bandwidth | 20 uploads x 500 MB / 86400 sec | ~120 KB/s average |
| Streaming Bandwidth | 50 viewers x 5 Mbps (720p) | ~31 MB/s peak |
| PostgreSQL Storage | 1,000 videos x 5 KB metadata + comments | ~50 MB/year |
| Redis Memory | Session + cache for 100 users | ~100 MB |
| MinIO Storage | 1,000 videos x 50 MB (processed avg) | ~50 GB |

### SLO Targets

| Service | Metric | Target | Alerting Threshold |
|---------|--------|--------|-------------------|
| API Gateway | Availability | 99.9% | < 99.5% over 5 min |
| Video Streaming | Time to first byte | < 500ms p95 | > 1s p95 |
| Video Playback | Start time | < 2s p95 | > 3s p95 |
| Metadata API | Response latency | < 200ms p95 | > 500ms p95 |
| Search | Query latency | < 500ms p95 | > 1s p95 |
| Upload Processing | Queue time | < 5 min p95 | > 15 min |
| Transcoding | Completion time | < 30 min/video | > 1 hour |

## High-Level Architecture

```
                                    +------------------+
                                    |   CDN / Nginx    |
                                    |  (Static + HLS)  |
                                    +--------+---------+
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
           +--------v--------+      +--------v--------+      +--------v--------+
           |  Upload Service |      |   API Gateway   |      | Streaming Svc   |
           |   (Port 3002)   |      |   (Port 3000)   |      |   (Port 3003)   |
           +--------+--------+      +--------+--------+      +--------+--------+
                    |                        |                        |
                    |                +-------+-------+                |
                    |                |               |                |
           +--------v--------+  +----v----+  +------v------+         |
           |   RabbitMQ      |  |  Redis  |  | PostgreSQL  |         |
           | (Transcode Q)   |  | (Cache) |  | (Metadata)  |         |
           +--------+--------+  +---------+  +-------------+         |
                    |                                                 |
           +--------v--------+                               +--------v--------+
           | Transcode Worker|                               |     MinIO       |
           | (Background)    +------------------------------>|  (Video Store)  |
           +-----------------+                               +-----------------+
```

### Core Components

| Component | Responsibility | Technology | Port |
|-----------|---------------|------------|------|
| API Gateway | Route requests, auth, rate limiting | Express.js | 3000 |
| Upload Service | Chunked uploads, validation | Express.js | 3002 |
| Streaming Service | HLS manifest, segment delivery | Express.js | 3003 |
| Transcode Worker | Video processing, thumbnail generation | Node.js + FFmpeg | - |
| PostgreSQL | User/video/comment metadata | PostgreSQL 16 | 5432 |
| Redis/Valkey | Session store, caching, rate limiting | Valkey 7 | 6379 |
| RabbitMQ | Transcode job queue | RabbitMQ 3.12 | 5672 |
| MinIO | Video and thumbnail storage | MinIO | 9000 |

## Request Flows

### Video Upload Flow

```
1. Client initiates upload
   POST /api/v1/uploads/init
   Body: { filename, fileSize, mimeType }
   Response: { uploadId, chunkSize, totalChunks }

2. Client uploads chunks (parallel, up to 3 concurrent)
   PUT /api/v1/uploads/:uploadId/chunks/:chunkNumber
   Body: binary chunk data
   Response: { received: true, etag }

3. Client completes upload
   POST /api/v1/uploads/:uploadId/complete
   Body: { title, description, channelId, tags }

4. Server actions:
   a. Validate all chunks received
   b. Assemble chunks into raw video file
   c. Store raw video in MinIO (raw-videos bucket)
   d. Create video record in PostgreSQL (status: 'processing')
   e. Publish transcode job to RabbitMQ
   Response: { videoId, status: 'processing' }

5. Transcode worker picks up job
   a. Download raw video from MinIO
   b. Generate thumbnail at 10% mark
   c. Transcode to multiple resolutions (1080p, 720p, 480p, 360p)
   d. Package as HLS (10-second segments)
   e. Upload processed files to MinIO (videos bucket)
   f. Update video record (status: 'ready', duration, resolutions)
   g. Acknowledge job completion
```

### Video Playback Flow

```
1. Client requests video page
   GET /api/v1/videos/:videoId
   Response: { video metadata, hlsManifestUrl, thumbnailUrl }

2. Client loads HLS manifest
   GET /videos/:videoId/master.m3u8 (via CDN/Nginx)
   Response: HLS master playlist with quality variants

3. Player selects quality based on bandwidth
   GET /videos/:videoId/720p/playlist.m3u8
   Response: Quality-specific playlist

4. Player fetches segments
   GET /videos/:videoId/720p/segment-001.ts
   (Served directly from MinIO or CDN cache)

5. Client reports watch progress (every 30 seconds)
   POST /api/v1/videos/:videoId/progress
   Body: { watchedSeconds, completed }
```

### Comment Flow

```
1. Fetch comments (paginated, sorted by time or popularity)
   GET /api/v1/videos/:videoId/comments?page=1&sort=newest
   Response: { comments: [...], total, hasMore }

2. Post comment
   POST /api/v1/videos/:videoId/comments
   Body: { content, parentId? }
   Response: { commentId, createdAt }

3. React to comment
   POST /api/v1/comments/:commentId/reactions
   Body: { type: 'like' | 'dislike' }
```

## Data Model

### PostgreSQL Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'creator', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- Channels table
CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    handle VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    banner_url VARCHAR(500),
    subscriber_count INTEGER DEFAULT 0,
    video_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_channels_user_id ON channels(user_id);
CREATE INDEX idx_channels_handle ON channels(handle);

-- Videos table
CREATE TABLE videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    duration_seconds INTEGER,
    status VARCHAR(20) DEFAULT 'processing'
        CHECK (status IN ('uploading', 'processing', 'ready', 'failed', 'deleted')),
    visibility VARCHAR(20) DEFAULT 'public'
        CHECK (visibility IN ('public', 'unlisted', 'private')),
    thumbnail_url VARCHAR(500),
    hls_manifest_url VARCHAR(500),
    resolutions JSONB DEFAULT '[]',
    tags TEXT[],
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    dislike_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    raw_file_key VARCHAR(500),
    file_size_bytes BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    published_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_videos_channel_id ON videos(channel_id);
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_videos_visibility ON videos(visibility);
CREATE INDEX idx_videos_published_at ON videos(published_at DESC);
CREATE INDEX idx_videos_view_count ON videos(view_count DESC);
CREATE INDEX idx_videos_tags ON videos USING GIN(tags);

-- Full-text search index
ALTER TABLE videos ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED;
CREATE INDEX idx_videos_search ON videos USING GIN(search_vector);

-- Comments table
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    dislike_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    is_edited BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_comments_video_id ON comments(video_id);
CREATE INDEX idx_comments_user_id ON comments(user_id);
CREATE INDEX idx_comments_parent_id ON comments(parent_id);
CREATE INDEX idx_comments_created_at ON comments(created_at DESC);

-- Subscriptions table
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    notification_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, channel_id)
);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_channel_id ON subscriptions(channel_id);

-- Reactions table (videos and comments)
CREATE TABLE reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('video', 'comment')),
    target_id UUID NOT NULL,
    reaction_type VARCHAR(20) NOT NULL CHECK (reaction_type IN ('like', 'dislike')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, target_type, target_id)
);
CREATE INDEX idx_reactions_target ON reactions(target_type, target_id);
CREATE INDEX idx_reactions_user ON reactions(user_id);

-- Watch history table
CREATE TABLE watch_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    watched_seconds INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    last_watched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, video_id)
);
CREATE INDEX idx_watch_history_user ON watch_history(user_id, last_watched_at DESC);

-- Transcode jobs table (for tracking and debugging)
CREATE TABLE transcode_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_transcode_jobs_video_id ON transcode_jobs(video_id);
CREATE INDEX idx_transcode_jobs_status ON transcode_jobs(status);
```

### Storage Strategy

#### MinIO Buckets

| Bucket | Purpose | Access | Lifecycle |
|--------|---------|--------|-----------|
| `raw-videos` | Original uploaded files | Private | Delete after transcode + 7 days |
| `videos` | Processed HLS segments | Public read | Permanent |
| `thumbnails` | Video thumbnails | Public read | Permanent |
| `avatars` | User/channel images | Public read | Permanent |
| `temp-chunks` | Upload chunks | Private | Delete after 24 hours |

#### Storage Layout

```
raw-videos/
  ├── {uploadId}/raw.{ext}

videos/
  ├── {videoId}/
  │   ├── master.m3u8
  │   ├── 1080p/
  │   │   ├── playlist.m3u8
  │   │   └── segment-{n}.ts
  │   ├── 720p/
  │   ├── 480p/
  │   └── 360p/

thumbnails/
  ├── {videoId}/
  │   ├── default.jpg
  │   ├── t-0.jpg (0%)
  │   ├── t-25.jpg (25%)
  │   ├── t-50.jpg (50%)
  │   └── t-75.jpg (75%)
```

### Caching Strategy

#### Redis/Valkey Key Patterns

| Pattern | TTL | Purpose |
|---------|-----|---------|
| `session:{sessionId}` | 24h | User session data |
| `user:{userId}` | 1h | User profile cache |
| `video:{videoId}` | 5m | Video metadata cache |
| `channel:{channelId}` | 5m | Channel metadata cache |
| `feed:{userId}` | 5m | Subscription feed cache |
| `trending` | 1m | Trending videos list |
| `rate:{ip}:{endpoint}` | 1m | Rate limit counters |
| `upload:{uploadId}` | 24h | Upload progress/chunk tracking |

#### Cache Invalidation Rules

| Event | Invalidate |
|-------|-----------|
| Video published | `video:{id}`, `channel:{channelId}`, `trending`, `feed:*` (subscribed users) |
| Video updated | `video:{id}` |
| User subscribes | `feed:{userId}`, `channel:{channelId}` |
| Comment added | `video:{id}` (comment count) |
| Profile updated | `user:{userId}`, `channel:{channelId}` |

## Message Queue Design

### RabbitMQ Exchanges and Queues

```
Exchange: youtube.transcode (direct)
  └── Queue: transcode.jobs
      └── Routing key: transcode.new
      └── Dead letter: transcode.dlq

Exchange: youtube.events (topic)
  └── Queue: notifications
      └── Routing key: video.published, comment.new
  └── Queue: analytics
      └── Routing key: video.*, user.*
```

### Transcode Job Message Format

```json
{
  "jobId": "uuid",
  "videoId": "uuid",
  "rawFileKey": "raw-videos/{uploadId}/raw.mp4",
  "resolutions": [1080, 720, 480, 360],
  "priority": "normal",
  "retryCount": 0,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Queue Configuration

| Queue | Prefetch | Retry | DLQ TTL |
|-------|----------|-------|---------|
| transcode.jobs | 1 | 3 attempts, exponential backoff (1m, 5m, 15m) | 7 days |
| notifications | 10 | 5 attempts, 30s delay | 24 hours |
| analytics | 100 | No retry (at-most-once) | - |

## API Design

### Core Endpoints

#### Authentication
```
POST   /api/v1/auth/register     Register new user
POST   /api/v1/auth/login        Login, create session
POST   /api/v1/auth/logout       Destroy session
GET    /api/v1/auth/me           Get current user
```

#### Videos
```
GET    /api/v1/videos            List videos (paginated, filterable)
GET    /api/v1/videos/:id        Get video details
POST   /api/v1/videos            Create video metadata (after upload)
PATCH  /api/v1/videos/:id        Update video metadata
DELETE /api/v1/videos/:id        Delete video

GET    /api/v1/videos/:id/comments    Get comments
POST   /api/v1/videos/:id/comments    Add comment
POST   /api/v1/videos/:id/reactions   Add reaction
POST   /api/v1/videos/:id/progress    Update watch progress
```

#### Uploads
```
POST   /api/v1/uploads/init           Initialize chunked upload
PUT    /api/v1/uploads/:id/chunks/:n  Upload chunk
POST   /api/v1/uploads/:id/complete   Complete upload
DELETE /api/v1/uploads/:id            Cancel upload
```

#### Channels
```
GET    /api/v1/channels/:handle       Get channel by handle
GET    /api/v1/channels/:id/videos    Get channel videos
POST   /api/v1/channels/:id/subscribe Subscribe to channel
DELETE /api/v1/channels/:id/subscribe Unsubscribe
```

#### Feed & Discovery
```
GET    /api/v1/feed                   Subscription feed
GET    /api/v1/trending               Trending videos
GET    /api/v1/search?q=              Search videos
GET    /api/v1/recommendations        Personalized recommendations
```

#### Admin (RBAC: admin role required)
```
GET    /api/v1/admin/videos           List all videos (including private)
PATCH  /api/v1/admin/videos/:id       Moderate video (takedown, restore)
GET    /api/v1/admin/users            List users
PATCH  /api/v1/admin/users/:id        Update user role, ban/unban
GET    /api/v1/admin/transcode-jobs   View job queue status
POST   /api/v1/admin/transcode-jobs/:id/retry  Retry failed job
```

### Response Format

```json
{
  "data": { ... },
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 150,
    "hasMore": true
  },
  "error": null
}
```

### Error Response Format

```json
{
  "data": null,
  "meta": null,
  "error": {
    "code": "VIDEO_NOT_FOUND",
    "message": "Video with id 'abc' not found",
    "details": { "videoId": "abc" }
  }
}
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + Vite + TypeScript | Fast builds, modern React features |
| | Tanstack Router | Type-safe routing |
| | Zustand | Lightweight state management |
| | Tailwind CSS | Rapid UI development |
| | hls.js | HLS playback in browsers without native support |
| **API Layer** | Express.js + TypeScript | Simple, well-understood, sufficient for learning |
| | express-session | Session management |
| | multer | File upload handling |
| **Data Layer** | PostgreSQL 16 | ACID, full-text search, JSONB |
| | Valkey 7 (Redis-compatible) | Sessions, caching, rate limiting |
| | MinIO | S3-compatible object storage |
| **Queue** | RabbitMQ 3.12 | Reliable message delivery, DLQ support |
| **Processing** | FFmpeg | Video transcoding (or simulated for learning) |
| **Reverse Proxy** | Nginx | Static files, HLS caching, load balancing |

## Security

### Authentication and Authorization

#### Session-Based Auth
- HTTP-only, secure cookies (secure=true in production)
- Session stored in Redis with 24-hour TTL
- CSRF protection via same-site cookies and origin checking

#### Role-Based Access Control (RBAC)

| Role | Permissions |
|------|------------|
| `guest` | View public videos, search |
| `user` | + Comment, react, subscribe, watch history |
| `creator` | + Upload videos, manage own channel |
| `admin` | + Moderate content, manage users, view system metrics |

#### Middleware Authorization Pattern
```typescript
// Route protection
router.post('/videos', requireAuth, requireRole(['creator', 'admin']), createVideo);
router.patch('/admin/videos/:id', requireAuth, requireRole(['admin']), moderateVideo);

// Resource ownership check
router.patch('/videos/:id', requireAuth, requireOwnership('video'), updateVideo);
```

### Rate Limiting

| Endpoint Pattern | Limit | Window |
|-----------------|-------|--------|
| `/api/v1/auth/*` | 10 | 1 minute |
| `/api/v1/uploads/*` | 5 | 1 minute |
| `/api/v1/comments` POST | 20 | 1 minute |
| `/api/v1/*` (default) | 100 | 1 minute |

### Input Validation

- All inputs validated with zod schemas
- File uploads: type checking (video/mp4, video/webm, etc.), size limits
- SQL injection: parameterized queries via pg library
- XSS: React escaping + Content-Security-Policy headers

## Observability

### Metrics (Prometheus)

```
# Request metrics
http_requests_total{method, endpoint, status}
http_request_duration_seconds{method, endpoint, quantile}

# Business metrics
videos_uploaded_total
videos_transcoded_total{status}
video_views_total
comments_created_total
subscriptions_total

# System metrics
transcode_queue_depth
transcode_job_duration_seconds{resolution}
cache_hit_ratio{cache}
db_connection_pool_size
db_query_duration_seconds{query_type}
```

### Logging Strategy

```typescript
// Structured logging with pino
logger.info({
  event: 'video_uploaded',
  videoId: video.id,
  userId: user.id,
  fileSize: file.size,
  duration: processingTime
});

// Log levels
// ERROR: Failures requiring attention (transcode failures, DB errors)
// WARN: Degraded state (cache miss, rate limit hit)
// INFO: Business events (upload, publish, subscribe)
// DEBUG: Request/response details (development only)
```

### Tracing

For local development, use simple request-id propagation:
```
X-Request-ID: {uuid}
```

Each log entry includes the request ID for correlation:
```json
{"level":"info","requestId":"abc-123","event":"video_fetched","videoId":"xyz"}
```

### Health Checks

```
GET /health           Quick liveness check
GET /health/ready     Deep readiness check (DB, Redis, MinIO, RabbitMQ)
```

### Alerting Thresholds (Local Simulation)

| Metric | Warning | Critical |
|--------|---------|----------|
| API error rate | > 1% | > 5% |
| p95 latency | > 500ms | > 2s |
| Transcode queue depth | > 10 | > 50 |
| Cache hit ratio | < 80% | < 50% |
| Disk usage | > 80% | > 95% |

## Failure Handling

### Retry Policies

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Transcode job | 3 | Exponential (1m, 5m, 15m) | Job ID prevents duplicates |
| DB write | 3 | Immediate | Transaction rollback |
| Cache write | 1 | None | Overwrite is safe |
| MinIO upload | 3 | Linear (1s) | ETag verification |

### Circuit Breaker Pattern

For external dependencies (simulated locally):
```typescript
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,      // Open after 5 failures
  resetTimeout: 30000,      // Try again after 30s
  successThreshold: 2       // Close after 2 successes
});

// Usage
const result = await circuitBreaker.execute(() => minioClient.putObject(...));
```

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|------------------|
| Redis down | Fall back to DB for sessions; disable caching |
| RabbitMQ down | Return upload as 'queued', poll for recovery |
| MinIO down | Serve cached HLS from Nginx; uploads fail gracefully |
| PostgreSQL down | Full service unavailable (critical dependency) |

### Idempotency Keys

For upload completion and video publishing:
```
POST /api/v1/uploads/:id/complete
X-Idempotency-Key: {client-generated-uuid}
```

Server stores key in Redis (24h TTL) and returns cached response for duplicates.

### Backup and Recovery (Local Dev)

```bash
# PostgreSQL backup
pg_dump -U youtube youtube_db > backup.sql

# PostgreSQL restore
psql -U youtube youtube_db < backup.sql

# MinIO: mc mirror for bucket replication
mc mirror minio/videos backup/videos
```

## Cost Tradeoffs

### Storage vs Compute

| Decision | Tradeoff |
|----------|----------|
| Pre-transcode all resolutions | Higher storage (4x), lower compute during playback |
| Transcode on-demand | Lower storage, higher latency, more compute |
| **Chosen**: Pre-transcode | Better user experience; storage is cheap |

### Cache Sizing

| Cache | Size | Cost | Benefit |
|-------|------|------|---------|
| Video metadata | 100 MB | Low | 90%+ hit rate on popular videos |
| Session store | 50 MB | Low | Avoid DB for every request |
| Full video cache (Nginx) | 1 GB | Medium | Reduce MinIO load |

### Queue Retention

| Queue | Retention | Rationale |
|-------|-----------|-----------|
| Transcode jobs | 7 days in DLQ | Debug failed jobs |
| Event notifications | 24 hours | Non-critical, at-most-once OK |
| Analytics | No retention | Fire-and-forget |

### Local Development Resource Budget

| Component | Memory | Disk | Justification |
|-----------|--------|------|---------------|
| PostgreSQL | 512 MB | 1 GB | Small dataset, simple queries |
| Valkey | 128 MB | - | Sessions + cache for 100 users |
| RabbitMQ | 256 MB | 100 MB | Low message volume |
| MinIO | 256 MB | 50 GB | Video storage (main cost) |
| API Services (x3) | 512 MB each | - | Node.js baseline |
| Nginx | 64 MB | 1 GB | Static cache |
| **Total** | ~2.5 GB | ~52 GB | Runs on 8GB laptop |

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scaling Strategy |
|-----------|-----------------|
| API Gateway | Add instances behind Nginx load balancer |
| Upload Service | Add instances; MinIO handles concurrent writes |
| Transcode Workers | Add workers; RabbitMQ distributes jobs |
| PostgreSQL | Read replicas for queries; write to primary |
| Redis | Redis Cluster for sharding |
| MinIO | Add nodes for capacity |

### Local Multi-Instance Testing

```bash
# Run 3 API instances
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003

# Nginx load balancer config
upstream api {
    server localhost:3001;
    server localhost:3002;
    server localhost:3003;
}
```

## Implementation Notes

This section documents the key infrastructure patterns implemented in the backend and explains their purpose.

### Prometheus Metrics (`/metrics` endpoint)

**WHY metrics enable content recommendation optimization:**

Metrics provide quantitative insights into user behavior and system performance that directly feed into recommendation algorithms:

1. **View patterns**: `video_views_total` and `video_watch_duration_seconds` track which videos are being watched and for how long. Videos with high completion rates (watch duration / total duration) are likely higher quality content worth promoting.

2. **Popular content identification**: Real-time metrics on view counts, likes, and engagement allow the trending algorithm to surface content that's gaining traction. The `transcode_queue_depth` metric helps prioritize processing of videos from channels with historically high engagement.

3. **User engagement signals**: Metrics on comments, reactions, and subscriptions provide implicit feedback signals. A video generating many comments quickly likely deserves recommendation boost.

4. **Capacity planning**: Metrics like `http_request_duration_seconds` and `db_query_duration_seconds` help identify bottlenecks before they impact recommendations (slow API = users abandon before engagement data is captured).

**Implemented metrics:**
- `video_views_total{video_id, channel_id}` - Total views per video
- `video_watch_duration_seconds` - Watch time histogram
- `video_uploads_total{status}` - Upload success/failure counts
- `transcode_queue_depth` - Current transcoding backlog
- `transcode_job_duration_seconds{resolution, status}` - Processing time per resolution
- `http_requests_total{method, endpoint, status_code}` - Request counts
- `http_request_duration_seconds` - API latency histogram

### Rate Limiting

**WHY rate limiting prevents abuse and protects transcoding resources:**

Transcoding is the most expensive operation in a video platform. A single video upload can consume CPU for 10-60 minutes depending on length and quality. Rate limiting serves multiple purposes:

1. **Resource protection**: Without limits, a malicious actor could queue hundreds of transcode jobs, blocking legitimate uploads for hours. The upload rate limit (5/minute) ensures the queue stays manageable.

2. **Fair access**: Rate limiting ensures one heavy user can't monopolize shared resources. If the transcode queue has capacity for 100 jobs/hour, limiting uploads prevents one creator from consuming the entire quota.

3. **Cost control**: Cloud transcoding costs scale with usage. Rate limits provide a predictable ceiling on infrastructure costs.

4. **Abuse prevention**: Limits on auth endpoints (10/minute) prevent brute-force attacks. Limits on comments (20/minute) prevent spam.

5. **Quality of service**: By rejecting excess requests with 429 status, rate limiting prevents system overload that would degrade performance for everyone.

**Implemented rate limits:**
- Auth endpoints: 10 requests/minute (prevents brute force)
- Upload endpoints: 5 uploads/minute (protects transcoding)
- Write operations: 20 requests/minute (prevents spam)
- Read operations: 100 requests/minute (generous for UX)

### Circuit Breakers

**WHY circuit breakers prevent cascade failures:**

In a distributed system, one failing service can bring down the entire platform through cascading failures. Circuit breakers act as automatic safety switches:

1. **Failure isolation**: When MinIO (storage) becomes unresponsive, the circuit opens. Instead of every request waiting 30 seconds before timing out (blocking threads, exhausting connection pools), requests fail immediately with a meaningful error.

2. **Fast recovery**: The half-open state periodically tests if the service recovered. When MinIO comes back, the circuit closes and normal operation resumes automatically---no manual intervention needed.

3. **Graceful degradation**: With circuit breakers, the API can return cached video metadata even when storage is down. Users can browse (degraded mode) rather than seeing complete failure.

4. **Resource conservation**: Without circuit breakers, a slow storage service causes thread pool exhaustion, database connection timeouts, and memory pressure from queued requests. Breaking the circuit early prevents this domino effect.

5. **Visibility**: Circuit breaker state changes are logged and exposed via metrics (`circuit_breaker_state`), enabling alerting when services are struggling.

**Implemented circuit breakers:**
- Storage operations (MinIO): Opens after 5 failures within threshold
- 30-second reset timeout before retrying
- Metrics track circuit state and failure counts

### Structured Logging with Pino

**WHY structured logging enables debugging distributed systems:**

Plain text logs (`console.log`) become unusable in distributed systems. Structured JSON logging solves critical debugging challenges:

1. **Request correlation**: Every request gets a `requestId` that's included in all log entries and returned in the `X-Request-ID` header. When a user reports "upload failed," you can search logs for that specific request ID and trace the entire flow across services.

2. **Machine parsing**: JSON logs can be ingested by log aggregation tools (ELK stack, Grafana Loki) for searching, filtering, and alerting. Finding all transcode failures in the last hour becomes a simple query rather than grep gymnastics.

3. **Context preservation**: Structured logs include contextual fields (userId, videoId, duration, error code) that would be lost in text logs. When debugging, you see the full picture without reconstructing context from surrounding lines.

4. **Performance analysis**: Logs include timing information. Aggregating the `duration` field from request logs reveals slow endpoints. Finding patterns like "all slow requests have userId=X" becomes trivial.

5. **Error categorization**: Structured error logs include error codes and types, enabling automatic categorization (operational vs. programmer errors) and smart alerting (alert on new error types, not volume).

**Log structure example:**
```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "requestId": "abc-123",
  "userId": "user-456",
  "event": "video_uploaded",
  "videoId": "vid-789",
  "fileSize": 52428800,
  "duration": 1523
}
```

### RBAC (Role-Based Access Control)

**Implemented roles:**
- `viewer`: Default role. Can watch videos, comment, subscribe.
- `creator`: Can upload videos, manage own channel and content.
- `admin`: Full access including content moderation and user management.

**Permission enforcement:**
- Role checks via `requireRole()` middleware
- Ownership checks via `requireOwnership()` for resource-specific access
- Role hierarchy: admin permissions supersede creator, which supersede viewer

### Retry with Exponential Backoff

**Implementation details:**
- Base delay: 1 second, doubles each attempt (1s, 2s, 4s, 8s...)
- Max delay cap: 30 seconds (prevents unreasonably long waits)
- Jitter: 20% randomization prevents thundering herd after outages
- Configurable presets for different operation types (cache, database, storage)

### Health Checks

**Endpoints:**
- `GET /health` - Liveness check (is the process running?)
- `GET /health/ready` - Readiness check (are dependencies healthy?)
- `GET /health/detailed` - Full status including circuit breaker states, queue depths, memory usage

**Dependency checks:**
- PostgreSQL: Simple query test
- Redis: Ping command
- MinIO: Head object request

## Future Optimizations

1. **Real FFmpeg Integration**: Replace simulated transcoding with actual video processing
2. **Live Streaming**: Add RTMP ingest and live HLS generation
3. **CDN Simulation**: Implement edge caching layer with geographic routing simulation
4. **ML Recommendations**: Replace rule-based recommendations with collaborative filtering
5. **Elasticsearch**: Add dedicated search cluster for better full-text search
6. **WebSocket**: Real-time notifications for transcode completion, new comments
