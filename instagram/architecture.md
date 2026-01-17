# Instagram - Photo Sharing - Architecture Design

## System Overview

A photo and video sharing social platform supporting photo uploads, personalized feeds, ephemeral stories, and direct messaging.

## Requirements

### Functional Requirements

- **Photo upload**: Users upload photos with captions, tags, and location; images are processed into multiple resolutions
- **Feed**: Personalized timeline of posts from followed users, sorted by relevance/recency
- **Stories**: Ephemeral 24-hour photo/video content with view tracking
- **Direct messaging**: Private photo/text messages between users

### Non-Functional Requirements

- **Scalability**: Support 10K DAU for local dev, architecture should scale horizontally to 10M+
- **Availability**: 99.9% uptime target (8.76 hours downtime/year)
- **Latency**: Feed load <200ms p95, photo upload acknowledgment <500ms p95, image serving <50ms p95 (CDN)
- **Consistency**: Eventual consistency for feeds (acceptable 2-5 second delay), strong consistency for follows/unfollows and message delivery order

## Capacity Estimation

### Local Development Scale (Target)

| Metric | Value | Calculation |
|--------|-------|-------------|
| Daily Active Users (DAU) | 10,000 | Local testing scale |
| Posts per day | 5,000 | 50% of DAU post daily |
| Average post size (original) | 2 MB | High-quality photo |
| Average post size (processed) | 500 KB | Thumbnail + 2 resolutions |
| Feed requests/day | 100,000 | 10 feed loads per user |
| Peak RPS (feed) | 50 | 100K/day with 3x peak factor |
| Peak RPS (upload) | 5 | 5K/day with 8-hour active window |

### Storage Growth (Local Dev)

| Component | Daily Growth | Monthly Growth |
|-----------|--------------|----------------|
| Original images | 10 GB | 300 GB |
| Processed images | 2.5 GB | 75 GB |
| Database (metadata) | 50 MB | 1.5 GB |
| Message storage | 100 MB | 3 GB |

### Component Sizing (Local)

| Component | Instances | Memory | Storage |
|-----------|-----------|--------|---------|
| API Server | 2-3 | 512 MB each | - |
| PostgreSQL | 1 | 1 GB | 50 GB |
| Valkey/Redis | 1 | 512 MB | - |
| MinIO | 1 | 512 MB | 500 GB |
| RabbitMQ | 1 | 256 MB | 1 GB |

**Total local resource requirement**: <4 GB RAM, <600 GB storage

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx:3000)   |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
     +--------v--------+          +----------v---------+          +---------v--------+
     |  API Server 1   |          |   API Server 2     |          |  API Server 3    |
     |    (:3001)      |          |     (:3002)        |          |    (:3003)       |
     +--------+--------+          +----------+---------+          +---------+--------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
         +-----------------------------------+-----------------------------------+
         |                   |                   |                   |           |
+--------v--------+ +--------v--------+ +--------v--------+ +--------v--------+  |
|   PostgreSQL    | |  Valkey/Redis   | |     MinIO       | |   RabbitMQ      |  |
|    (:5432)      | |    (:6379)      | |    (:9000)      | |    (:5672)      |  |
|   Primary DB    | |   Cache/Session | |  Object Store   | |  Task Queue     |  |
+-----------------+ +-----------------+ +-----------------+ +-----------------+  |
                                                                                  |
                                                          +-----------------------+
                                                          |
                                                 +--------v--------+
                                                 |  Image Worker   |
                                                 |  (background)   |
                                                 +-----------------+
```

### Request Flows

#### Photo Upload Flow

```
1. Client → API Server: POST /api/v1/posts (multipart: image + metadata)
2. API Server → MinIO: Store original image with UUID
3. API Server → PostgreSQL: Create post record (status: 'processing')
4. API Server → RabbitMQ: Enqueue image processing job
5. API Server → Client: 202 Accepted {post_id, status: 'processing'}
6. Image Worker ← RabbitMQ: Dequeue job
7. Image Worker ← MinIO: Fetch original image
8. Image Worker: Generate resolutions (thumbnail: 150x150, small: 320x320, medium: 640x640, large: 1080x1080)
9. Image Worker → MinIO: Store processed images
10. Image Worker → PostgreSQL: Update post (status: 'published', image_urls)
11. Image Worker → RabbitMQ: Enqueue feed fanout job (optional for push model)
```

#### Feed Load Flow

```
1. Client → API Server: GET /api/v1/feed?cursor=<timestamp>&limit=20
2. API Server → Valkey: Check feed cache (key: feed:{user_id})
3. If cache hit:
   API Server → Client: Return cached feed
4. If cache miss:
   API Server → PostgreSQL: Query posts from followed users (pull model)
     SELECT p.*, u.username, u.avatar_url
     FROM posts p
     JOIN follows f ON f.following_id = p.user_id
     JOIN users u ON u.id = p.user_id
     WHERE f.follower_id = $1 AND p.status = 'published' AND p.created_at < $cursor
     ORDER BY p.created_at DESC
     LIMIT 20
5. API Server → Valkey: Cache result (TTL: 60s)
6. API Server → Client: Return feed JSON
```

#### Story View Flow

```
1. Client → API Server: GET /api/v1/stories/feed
2. API Server → Valkey: Get active story IDs for followed users
3. API Server → PostgreSQL: Fetch story metadata (created_at > NOW() - 24 hours)
4. API Server → Client: Return story ring data
5. Client → API Server: POST /api/v1/stories/{id}/view
6. API Server → PostgreSQL: Insert view record (deduplicated by user_id, story_id)
```

### Core Components

| Component | Responsibility | Technology |
|-----------|----------------|------------|
| API Server | REST endpoints, auth, request validation | Node.js + Express |
| Image Worker | Resize images, generate thumbnails | Node.js + Sharp |
| PostgreSQL | Users, posts, follows, messages, stories | PostgreSQL 16 |
| Valkey | Session store, feed cache, rate limiting | Valkey 7.2 |
| MinIO | Image storage (original + processed) | MinIO (S3-compatible) |
| RabbitMQ | Async job queue for image processing | RabbitMQ 3.12 |
| Load Balancer | Request distribution, health checks | nginx |

## Data Model

### Database Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    bio TEXT,
    avatar_url VARCHAR(500),
    is_private BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);

-- Posts table
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption TEXT,
    location VARCHAR(255),
    status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'published', 'failed', 'deleted')),
    original_url VARCHAR(500) NOT NULL,
    thumbnail_url VARCHAR(500),
    small_url VARCHAR(500),
    medium_url VARCHAR(500),
    large_url VARCHAR(500),
    width INTEGER,
    height INTEGER,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_user_created ON posts(user_id, created_at DESC) WHERE status = 'published';

-- Follows table (social graph)
CREATE TABLE follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);

-- Likes table
CREATE TABLE likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, post_id)
);
CREATE INDEX idx_likes_post ON likes(post_id);

-- Comments table
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);

-- Stories table (ephemeral content)
CREATE TABLE stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url VARCHAR(500) NOT NULL,
    media_type VARCHAR(10) DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_stories_user_expires ON stories(user_id, expires_at DESC);
CREATE INDEX idx_stories_active ON stories(expires_at) WHERE expires_at > NOW();

-- Story views (for view tracking)
CREATE TABLE story_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(story_id, viewer_id)
);
CREATE INDEX idx_story_views_story ON story_views(story_id);

-- Direct messages
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE conversation_participants (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conv_participants_user ON conversation_participants(user_id);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    media_url VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at DESC);
```

### Storage Strategy

#### Object Storage Layout (MinIO)

```
instagram-media/
├── originals/
│   └── {year}/{month}/{day}/{post_id}.{ext}
├── processed/
│   ├── thumbnails/{post_id}_150.jpg
│   ├── small/{post_id}_320.jpg
│   ├── medium/{post_id}_640.jpg
│   └── large/{post_id}_1080.jpg
├── stories/
│   └── {year}/{month}/{day}/{story_id}.{ext}
├── avatars/
│   └── {user_id}.jpg
└── messages/
    └── {conversation_id}/{message_id}.{ext}
```

#### Caching Strategy (Valkey)

| Key Pattern | Value | TTL | Purpose |
|-------------|-------|-----|---------|
| `session:{session_id}` | User session JSON | 24h | Authentication |
| `feed:{user_id}` | Cached feed JSON (20 posts) | 60s | Feed performance |
| `user:{user_id}` | User profile JSON | 5m | Profile lookups |
| `followers:{user_id}` | Set of follower IDs | 5m | Social graph |
| `following:{user_id}` | Set of following IDs | 5m | Social graph |
| `ratelimit:{user_id}:{action}` | Counter | 1m | Rate limiting |
| `story_ring:{user_id}` | Active story user IDs | 5m | Story feed |

**Cache invalidation strategy**: Write-through for critical data (follows), time-based expiry for feeds. On follow/unfollow, delete `feed:{user_id}` to trigger rebuild.

## API Design

### Core Endpoints

#### Authentication

```
POST   /api/v1/auth/register     # Create account
POST   /api/v1/auth/login        # Login, returns session cookie
POST   /api/v1/auth/logout       # Destroy session
GET    /api/v1/auth/me           # Get current user
```

#### Posts

```
POST   /api/v1/posts             # Upload photo (multipart)
GET    /api/v1/posts/{id}        # Get single post
DELETE /api/v1/posts/{id}        # Delete own post
POST   /api/v1/posts/{id}/like   # Like a post
DELETE /api/v1/posts/{id}/like   # Unlike a post
GET    /api/v1/posts/{id}/comments      # Get comments
POST   /api/v1/posts/{id}/comments      # Add comment
```

#### Feed

```
GET    /api/v1/feed              # Get personalized feed (cursor pagination)
GET    /api/v1/users/{id}/posts  # Get user's posts
```

#### Stories

```
POST   /api/v1/stories           # Create story
GET    /api/v1/stories/feed      # Get stories from followed users
GET    /api/v1/stories/{id}      # Get single story
POST   /api/v1/stories/{id}/view # Record story view
DELETE /api/v1/stories/{id}      # Delete own story
```

#### Social

```
POST   /api/v1/users/{id}/follow    # Follow user
DELETE /api/v1/users/{id}/follow    # Unfollow user
GET    /api/v1/users/{id}/followers # Get followers
GET    /api/v1/users/{id}/following # Get following
```

#### Direct Messages

```
GET    /api/v1/conversations              # List conversations
POST   /api/v1/conversations              # Start conversation
GET    /api/v1/conversations/{id}/messages # Get messages
POST   /api/v1/conversations/{id}/messages # Send message
```

#### Admin Endpoints

```
GET    /api/v1/admin/users       # List users (paginated)
DELETE /api/v1/admin/users/{id}  # Ban/delete user
GET    /api/v1/admin/posts       # List all posts (with filters)
DELETE /api/v1/admin/posts/{id}  # Remove post
GET    /api/v1/admin/stats       # System statistics
```

## Key Design Decisions

### Image Processing

**Approach**: Async processing with Sharp library

1. Accept upload, store original immediately, return 202 Accepted
2. Background worker processes image:
   - Validate image format (JPEG, PNG, WebP, HEIC)
   - Strip EXIF data (privacy)
   - Auto-orient based on EXIF
   - Generate 4 sizes: 150x150 (thumbnail), 320x320 (small), 640x640 (medium), 1080x1080 (large)
   - Convert to WebP for 30% size reduction (with JPEG fallback)
3. Store processed images in MinIO with appropriate cache headers
4. Update post status to 'published'

**Why async?** Image processing takes 2-5 seconds. Synchronous processing would block the API and timeout on slow networks.

### Feed Generation

**Approach**: Pull model with caching (simpler for local dev)

- On feed request, query posts from followed users with cursor pagination
- Cache assembled feed for 60 seconds
- For production scale, would switch to push model with pre-computed feeds in Valkey

**Trade-off**: Pull model is simpler but O(n) where n = following count. Acceptable for 10K DAU. Push model pre-computes feeds on post creation but requires more storage and fanout complexity.

### Story Expiration

**Approach**: Soft delete with scheduled cleanup

- Stories have `expires_at` timestamp set to `created_at + 24 hours`
- Active story queries filter by `WHERE expires_at > NOW()`
- Background job runs hourly to hard-delete expired stories and their media files

```javascript
// Cleanup job (runs every hour)
async function cleanupExpiredStories() {
  const expired = await db.query(`
    SELECT id, media_url FROM stories
    WHERE expires_at < NOW() - INTERVAL '1 hour'
  `);
  for (const story of expired) {
    await minio.removeObject('instagram-media', story.media_url);
    await db.query('DELETE FROM stories WHERE id = $1', [story.id]);
  }
}
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express + TypeScript | Fast development, good ecosystem, async I/O for file uploads |
| **Primary Database** | PostgreSQL 16 | ACID transactions for follows/likes, JSON support, excellent indexing |
| **Cache** | Valkey 7.2 | Redis-compatible, sessions, rate limiting, feed cache |
| **Object Storage** | MinIO | S3-compatible, local development, unlimited storage |
| **Message Queue** | RabbitMQ 3.12 | Simple queue semantics, dead letter handling, management UI |
| **Image Processing** | Sharp | Fastest Node.js image library, WebP support |
| **Load Balancer** | nginx | Proven, simple config, WebSocket support for future DMs |

## Security Considerations

### Authentication and Authorization

**Session-based authentication** (simpler for learning, avoids JWT complexity):

```javascript
// Session stored in Valkey
{
  "user_id": "uuid",
  "username": "johndoe",
  "is_admin": false,
  "created_at": "2024-01-15T10:00:00Z",
  "expires_at": "2024-01-16T10:00:00Z"
}
```

**Session configuration**:
- Cookie: `HttpOnly`, `Secure` (in production), `SameSite=Lax`
- TTL: 24 hours, sliding expiration on activity
- Stored in Valkey with `session:{session_id}` key

### Role-Based Access Control (RBAC)

| Role | Permissions |
|------|-------------|
| **anonymous** | View public profiles, view public posts |
| **user** | All anonymous + create posts, follow users, like, comment, DM |
| **admin** | All user + delete any post, ban users, view system stats |

**Middleware example**:
```javascript
const requireAuth = (req, res, next) => {
  if (!req.session?.user_id) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session?.is_admin) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Route protection
app.delete('/api/v1/admin/posts/:id', requireAuth, requireAdmin, deletePost);
app.post('/api/v1/posts', requireAuth, createPost);
```

### Rate Limiting

Implemented with Valkey sliding window:

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /auth/login | 5 | 1 minute |
| POST /posts | 10 | 1 hour |
| POST /*/like | 100 | 1 hour |
| POST /*/comment | 50 | 1 hour |
| GET /feed | 60 | 1 minute |

```javascript
async function rateLimit(userId, action, limit, windowSeconds) {
  const key = `ratelimit:${userId}:${action}`;
  const current = await valkey.incr(key);
  if (current === 1) await valkey.expire(key, windowSeconds);
  return current <= limit;
}
```

### Input Validation

- **File uploads**: Max 10MB, allowed types: image/jpeg, image/png, image/webp, image/heic
- **Captions**: Max 2200 characters, sanitize HTML
- **Usernames**: 3-30 alphanumeric + underscore, lowercase
- **UUIDs**: Validate format before database queries

## Monitoring and Observability

### Metrics (Prometheus)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, path, status | Request volume |
| `http_request_duration_seconds` | Histogram | method, path | Latency tracking |
| `image_processing_duration_seconds` | Histogram | - | Worker performance |
| `image_processing_errors_total` | Counter | error_type | Processing failures |
| `active_sessions` | Gauge | - | Logged-in users |
| `feed_cache_hit_ratio` | Gauge | - | Cache effectiveness |
| `queue_depth` | Gauge | queue_name | RabbitMQ backlog |
| `storage_bytes_total` | Gauge | bucket | MinIO usage |

### Logging (Structured JSON)

```javascript
// Request logging
{
  "level": "info",
  "timestamp": "2024-01-15T10:00:00.000Z",
  "request_id": "uuid",
  "method": "POST",
  "path": "/api/v1/posts",
  "user_id": "uuid",
  "status": 202,
  "duration_ms": 45,
  "content_length": 2048576
}

// Error logging
{
  "level": "error",
  "timestamp": "2024-01-15T10:00:01.000Z",
  "request_id": "uuid",
  "error": "ImageProcessingError",
  "message": "Failed to decode image",
  "post_id": "uuid",
  "stack": "..."
}
```

### Distributed Tracing

For local development, simple request ID propagation:

```javascript
// Middleware to assign trace ID
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

// Pass trace ID to background jobs
await channel.sendToQueue('image-processing', Buffer.from(JSON.stringify({
  post_id: postId,
  trace_id: req.traceId
})));
```

### Alert Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | 5xx rate > 1% for 5 minutes | Critical |
| Slow responses | p95 latency > 500ms for 5 minutes | Warning |
| Queue buildup | queue_depth > 100 for 10 minutes | Warning |
| Storage full | storage_bytes > 90% capacity | Critical |
| Worker down | No heartbeat for 2 minutes | Critical |

## Failure Handling

### Retry Strategy

| Operation | Max Retries | Backoff | Idempotency |
|-----------|-------------|---------|-------------|
| Image processing | 3 | Exponential (1s, 2s, 4s) | Safe (same output) |
| MinIO upload | 3 | Exponential | Safe (overwrite) |
| Database write | 0 | N/A | Use transactions |
| External API | 3 | Exponential | Idempotency key |

```javascript
// RabbitMQ dead letter handling
const queueOptions = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': 'dlx',
    'x-dead-letter-routing-key': 'image-processing-failed'
  }
};

// Failed jobs go to DLQ for manual inspection
```

### Circuit Breaker Pattern

```javascript
// Simple circuit breaker for MinIO
const circuitBreaker = {
  failures: 0,
  lastFailure: null,
  state: 'closed', // closed, open, half-open

  async call(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > 30000) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= 5) this.state = 'open';
      throw error;
    }
  }
};
```

### Graceful Degradation

| Failure | Degradation Strategy |
|---------|---------------------|
| Valkey down | Bypass cache, serve from PostgreSQL (slower) |
| RabbitMQ down | Inline image processing (blocking, with timeout) |
| MinIO down | Return 503, queue uploads for retry |
| PostgreSQL down | Return 503 for writes, serve cached reads |

### Backup and Recovery

**Local development backup strategy**:

```bash
# PostgreSQL backup (daily)
pg_dump instagram > backup/instagram_$(date +%Y%m%d).sql

# MinIO sync to local backup
mc mirror minio/instagram-media backup/media/

# Recovery
psql instagram < backup/instagram_20240115.sql
mc mirror backup/media/ minio/instagram-media
```

## Cost Tradeoffs

### Storage vs Compute

| Decision | Trade-off |
|----------|-----------|
| Store 4 image sizes | More storage (4x), but faster serving (no resize on request) |
| Cache feeds in Valkey | Memory cost (~500 bytes/user), but 10x faster feed loads |
| Keep originals | 2x storage, but allows re-processing with new algorithms |

### Recommended for local dev

- **DO**: Cache aggressively (Valkey is cheap)
- **DO**: Store processed images (disk is cheap)
- **DON'T**: Pre-compute feeds for all users (unnecessary at this scale)
- **DON'T**: Shard PostgreSQL (single instance is fine for 10K DAU)

### Production Scaling Costs (Reference)

| Component | 10K DAU (Local) | 1M DAU (Cloud) |
|-----------|-----------------|----------------|
| Compute | $0 (local) | $2,000/mo (10 app servers) |
| PostgreSQL | $0 (local) | $500/mo (RDS medium) |
| Object Storage | $0 (local) | $1,000/mo (100TB S3) |
| CDN | N/A | $2,000/mo (bandwidth) |
| Cache | $0 (local) | $300/mo (ElastiCache) |

## Scalability Considerations

### Horizontal Scaling Path

1. **Current (local dev)**: 2-3 API servers, single PostgreSQL, single Valkey
2. **10x scale**: Add read replicas for PostgreSQL, Valkey cluster
3. **100x scale**: Shard by user_id, CDN for images, push-based feeds
4. **1000x scale**: Separate services (feed service, messaging service, etc.)

### Database Scaling Strategy

```
Phase 1 (local): Single PostgreSQL instance
Phase 2: Add read replica for feed queries
Phase 3: Shard follows table by follower_id (range or hash)
Phase 4: Move messages to Cassandra (high write volume)
```

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Session auth | Valkey sessions | JWT tokens | Simpler, revocable, learning focus |
| Feed model | Pull with cache | Push (fanout on write) | Simpler, sufficient for 10K DAU |
| Message queue | RabbitMQ | Kafka | Simpler ops, sufficient throughput |
| Image storage | MinIO | Local filesystem | S3-compatible, easier migration |
| Database | PostgreSQL | MongoDB | Strong consistency for social graph |

## Future Optimizations

1. **WebSocket for real-time**: Live notifications, typing indicators in DMs
2. **Push-based feeds**: Pre-compute feeds for active users
3. **Video support**: Transcoding pipeline with FFmpeg workers
4. **Search**: Elasticsearch for user/hashtag search
5. **Recommendations**: ML-based explore feed
6. **CDN integration**: CloudFront/Cloudflare for image serving
7. **Read replicas**: Separate read/write database connections
