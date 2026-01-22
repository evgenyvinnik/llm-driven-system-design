# Instagram - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"Today I'll design Instagram, a photo and video sharing social platform. As a backend engineer, I'll focus on the async image processing pipeline with multiple resolutions, hybrid fan-out feed generation strategy, dual-database architecture using PostgreSQL and Cassandra, and the reliability patterns including circuit breakers, rate limiting, and idempotent operations that enable the platform to handle billions of interactions."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Photo/Video Upload** - Upload, process, and store photos with multiple resolutions
2. **Feed Generation** - Personalized home feed from followed accounts with cursor pagination
3. **Stories** - Ephemeral 24-hour content with view tracking and automatic expiration
4. **Direct Messaging** - Real-time messaging with read receipts and typing indicators
5. **Social Graph** - Follow/unfollow with strong consistency

### Non-Functional Requirements

- **Scale**: 500M+ DAU, 100M+ posts/day, 1.1M feed QPS
- **Latency**: Feed load < 200ms p95, upload acknowledgment < 500ms p95
- **Consistency**: Eventual for feeds (2-5s delay acceptable), strong for follows and message ordering
- **Availability**: 99.99% uptime with graceful degradation

### Backend-Specific Clarifications

- "What's the read/write ratio for feeds?" - 100:1, extremely read-heavy
- "How should we handle celebrity accounts with millions of followers?" - Hybrid fan-out strategy
- "What consistency model for DMs?" - Strong ordering guarantee, eventual delivery

---

## Step 2: High-Level Architecture

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
        |                                                                        |
        |  +---------------------------------------------------------------------+
        |  |                                                     |
+-------v--v------+                                     +--------v--------+
|   Cassandra     |                                     |  Image Worker   |
|    (:9042)      |                                     |  (background)   |
|  Direct Msgs    |                                     +-----------------+
+-----------------+
```

---

## Step 3: Async Image Processing Pipeline (Deep Dive)

### The Challenge

Users upload high-resolution images (2-10 MB), but we need multiple sizes for different UI contexts. Processing synchronously would block requests for 2-5 seconds.

### Processing Flow

```
1. Client → API: POST /api/v1/posts (multipart: image + metadata)
2. API → MinIO: Store original image with UUID
3. API → PostgreSQL: Create post (status: 'processing')
4. API → RabbitMQ: Enqueue image processing job
5. API → Client: 202 Accepted {post_id, status: 'processing'}
6. Worker ← RabbitMQ: Dequeue job
7. Worker ← MinIO: Fetch original image
8. Worker: Generate 4 resolutions using Sharp
9. Worker → MinIO: Store processed images
10. Worker → PostgreSQL: Update post (status: 'published', image_urls)
```

### Resolution Strategy

```typescript
interface ImageProcessingJob {
  postId: string;
  originalUrl: string;
  traceId: string;  // For distributed tracing
}

const resolutions = [
  { name: 'thumbnail', size: 150, quality: 80 },   // Story rings, notifications
  { name: 'small', size: 320, quality: 85 },       // Grid view
  { name: 'medium', size: 640, quality: 85 },      // Feed on mobile
  { name: 'large', size: 1080, quality: 90 },      // Full-screen view
];

async function processImage(job: ImageProcessingJob): Promise<void> {
  const original = await minio.getObject('originals', job.originalUrl);

  // Auto-orient based on EXIF and strip metadata (privacy)
  const normalized = await sharp(original)
    .rotate()  // Auto-orient
    .toBuffer();

  const processedUrls: Record<string, string> = {};

  for (const res of resolutions) {
    const processed = await sharp(normalized)
      .resize(res.size, res.size, { fit: 'cover', position: 'center' })
      .webp({ quality: res.quality })  // 30% smaller than JPEG
      .toBuffer();

    const key = `processed/${res.name}/${job.postId}.webp`;
    await minio.putObject('instagram-media', key, processed);
    processedUrls[`${res.name}_url`] = key;
  }

  await db.query(`
    UPDATE posts
    SET status = 'published',
        thumbnail_url = $1, small_url = $2, medium_url = $3, large_url = $4,
        updated_at = NOW()
    WHERE id = $5
  `, [processedUrls.thumbnail_url, processedUrls.small_url,
      processedUrls.medium_url, processedUrls.large_url, job.postId]);
}
```

### Dead Letter Queue for Failed Jobs

```typescript
const queueOptions = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': 'dlx',
    'x-dead-letter-routing-key': 'image-processing-failed',
    'x-message-ttl': 300000  // 5 minute TTL before dead-lettering
  }
};

// Retry with exponential backoff
async function processWithRetry(job: ImageProcessingJob, attempt = 1): Promise<void> {
  try {
    await processImage(job);
  } catch (error) {
    if (attempt < 3) {
      const delay = Math.pow(2, attempt) * 1000;  // 2s, 4s
      await sleep(delay);
      return processWithRetry(job, attempt + 1);
    }
    // Mark post as failed
    await db.query('UPDATE posts SET status = $1 WHERE id = $2', ['failed', job.postId]);
    throw error;  // Let RabbitMQ dead-letter it
  }
}
```

---

## Step 4: Hybrid Fan-out Feed Generation

### The Problem

With 500 accounts followed, generating feed on each request is expensive. But pure push (fan-out on write) is prohibitive for celebrities with millions of followers.

### Hybrid Strategy

```
+-----------------------------------------------------------+
|                     Hybrid Fan-out                         |
|                                                           |
|   Small accounts (< 10K followers):                        |
|     → Fan-out on write (push to followers' timelines)      |
|                                                           |
|   Large accounts (> 10K followers):                        |
|     → Fan-out on read (pull when user loads feed)          |
|     → Merge with pre-pushed content at read time           |
+-----------------------------------------------------------+
```

### Data Model in Redis

```
Timeline Cache (Sorted Set):
Key: timeline:{user_id}
Score: timestamp (Unix epoch)
Value: post_id
Max entries: 500
TTL: 7 days (refreshed on access)

Post Metadata Cache (Hash):
Key: post:{post_id}
Fields: author_id, caption, like_count, thumbnail_url, created_at
TTL: 1 hour
```

### Fan-out on Write Pipeline

```typescript
async function handleNewPost(post: Post): Promise<void> {
  const followerCount = await getFollowerCount(post.userId);

  if (followerCount < 10000) {
    // Small account: push to all followers
    await queueFanoutJob({
      postId: post.id,
      authorId: post.userId,
      timestamp: post.createdAt.getTime()
    });
  } else {
    // Celebrity: mark as "pull-only"
    await redis.sadd('celebrity_accounts', post.userId);
  }
}

// Fan-out worker (parallel processing)
async function fanoutToFollowers(job: FanoutJob): Promise<void> {
  const followers = await getFollowerIds(job.authorId);

  // Batch updates using Redis pipeline
  const pipeline = redis.pipeline();
  for (const followerId of followers) {
    pipeline.zadd(`timeline:${followerId}`, job.timestamp, job.postId);
    pipeline.zremrangebyrank(`timeline:${followerId}`, 0, -501);  // Keep last 500
  }
  await pipeline.exec();
}
```

### Feed Generation with Merge

```typescript
async function getFeed(userId: string, cursor: number, limit: number = 20): Promise<Post[]> {
  // 1. Get pre-pushed timeline posts
  const timelinePostIds = await redis.zrevrangebyscore(
    `timeline:${userId}`,
    cursor,
    '-inf',
    'LIMIT', 0, limit
  );

  // 2. Get celebrity posts (fan-out on read)
  const celebrityFollows = await redis.sinter(
    `following:${userId}`,
    'celebrity_accounts'
  );

  let celebrityPosts: string[] = [];
  if (celebrityFollows.length > 0) {
    // Fetch recent posts from each celebrity (parallel)
    const celebrityPostPromises = celebrityFollows.map(celebId =>
      redis.zrevrangebyscore(`posts:${celebId}`, cursor, cursor - 86400000, 'LIMIT', 0, 3)
    );
    const results = await Promise.all(celebrityPostPromises);
    celebrityPosts = results.flat();
  }

  // 3. Merge and deduplicate
  const allPostIds = [...new Set([...timelinePostIds, ...celebrityPosts])];

  // 4. Fetch full post data (batch)
  const posts = await getPostsById(allPostIds.slice(0, limit));

  // 5. Sort by creation time
  return posts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
```

### Feed Cache Layer

```typescript
const FEED_CACHE_TTL = 60;  // 60 seconds

async function getCachedFeed(userId: string, cursor: number, limit: number): Promise<Post[]> {
  const cacheKey = `feed:${userId}:${cursor}:${limit}`;

  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    metrics.feedCacheHits.inc();
    return JSON.parse(cached);
  }

  metrics.feedCacheMisses.inc();

  // Generate feed
  const feed = await getFeed(userId, cursor, limit);

  // Cache result
  await redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(feed));

  return feed;
}

// Invalidate on follow/unfollow
async function onFollowChange(followerId: string): Promise<void> {
  const keys = await redis.keys(`feed:${followerId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
```

---

## Step 5: Dual Database Architecture (PostgreSQL + Cassandra)

### Why Two Databases?

| Data Type | PostgreSQL | Cassandra |
|-----------|------------|-----------|
| Users, posts, follows | Strong consistency, JOINs | - |
| Direct messages | - | High-write, TimeUUID ordering |
| Likes, comments | Atomic counters, constraints | - |
| Typing indicators | - | 5-second TTL |

### PostgreSQL Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_private BOOLEAN DEFAULT FALSE,
    follower_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Posts with status tracking
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption TEXT,
    status VARCHAR(20) DEFAULT 'processing'
        CHECK (status IN ('processing', 'published', 'failed', 'deleted')),
    original_url VARCHAR(500) NOT NULL,
    thumbnail_url VARCHAR(500),
    small_url VARCHAR(500),
    medium_url VARCHAR(500),
    large_url VARCHAR(500),
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Composite index for feed queries
CREATE INDEX idx_posts_user_created
ON posts(user_id, created_at DESC)
WHERE status = 'published';

-- Follows with compound primary key for idempotency
CREATE TABLE follows (
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- Likes with idempotent upsert support
CREATE TABLE likes (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);

-- Stories with automatic expiration filter
CREATE TABLE stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url VARCHAR(500) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stories_active
ON stories(expires_at)
WHERE expires_at > NOW();

-- Story views with deduplication
CREATE TABLE story_views (
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (story_id, viewer_id)
);
```

### Cassandra Schema for Direct Messages

```cql
-- Messages by conversation (main storage)
CREATE TABLE messages_by_conversation (
    conversation_id UUID,
    message_id TIMEUUID,          -- Natural time ordering
    sender_id UUID,
    content TEXT,
    content_type TEXT,             -- 'text', 'image', 'video', 'heart'
    media_url TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 31536000;  -- 1 year TTL

-- Conversations by user (inbox view)
CREATE TABLE conversations_by_user (
    user_id UUID,
    last_message_at TIMESTAMP,
    conversation_id UUID,
    other_user_id UUID,
    other_username TEXT,           -- Denormalized for fast display
    other_avatar_url TEXT,
    last_message_preview TEXT,
    unread_count INT,
    PRIMARY KEY (user_id, last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC);

-- Typing indicators (ephemeral)
CREATE TABLE typing_indicators (
    conversation_id UUID,
    user_id UUID,
    started_at TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
) WITH default_time_to_live = 5;  -- Auto-expire after 5 seconds
```

### Message Send Flow

```typescript
interface Message {
  conversationId: string;
  senderId: string;
  content: string;
  contentType: 'text' | 'image' | 'video' | 'heart';
  mediaUrl?: string;
}

async function sendMessage(msg: Message): Promise<MessageResult> {
  const messageId = TimeUUID.now();
  const createdAt = new Date();

  // 1. Insert message (Cassandra)
  await cassandra.execute(`
    INSERT INTO messages_by_conversation
    (conversation_id, message_id, sender_id, content, content_type, media_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [msg.conversationId, messageId, msg.senderId, msg.content,
      msg.contentType, msg.mediaUrl, createdAt]);

  // 2. Update conversation metadata for all participants
  const participants = await getConversationParticipants(msg.conversationId);
  const senderProfile = await getUserProfile(msg.senderId);

  for (const participantId of participants) {
    const otherUser = participantId === msg.senderId
      ? await getUserProfile(participants.find(p => p !== msg.senderId)!)
      : senderProfile;

    // Upsert conversation in inbox
    await cassandra.execute(`
      INSERT INTO conversations_by_user
      (user_id, last_message_at, conversation_id, other_user_id,
       other_username, other_avatar_url, last_message_preview, unread_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [participantId, createdAt, msg.conversationId, otherUser.id,
        otherUser.username, otherUser.avatarUrl,
        msg.content.substring(0, 100),
        participantId === msg.senderId ? 0 : 1]);
  }

  // 3. Publish to WebSocket for real-time delivery
  await redis.publish(`user:${participants[1]}:messages`, JSON.stringify({
    type: 'new_message',
    conversationId: msg.conversationId,
    messageId: messageId.toString(),
    senderId: msg.senderId,
    content: msg.content,
    createdAt: createdAt.toISOString()
  }));

  return { messageId: messageId.toString(), createdAt };
}
```

---

## Step 6: Idempotency Patterns

### Like Idempotency with ON CONFLICT

```typescript
async function likePost(userId: string, postId: string): Promise<LikeResult> {
  // Idempotent insert - duplicate likes are silently ignored
  const result = await db.query(`
    INSERT INTO likes (user_id, post_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, post_id) DO NOTHING
    RETURNING id
  `, [userId, postId]);

  const isNewLike = result.rowCount > 0;

  if (isNewLike) {
    // Only increment if this was a new like
    await db.query(`
      UPDATE posts SET like_count = like_count + 1 WHERE id = $1
    `, [postId]);

    metrics.likesTotal.inc({ action: 'like' });
  } else {
    metrics.likesDuplicate.inc();
  }

  return { success: true, idempotent: !isNewLike };
}
```

### Story View Deduplication

```typescript
async function recordStoryView(storyId: string, viewerId: string): Promise<boolean> {
  // Fast deduplication check in Redis
  const alreadyViewed = await redis.sismember(`story_views:${storyId}`, viewerId);
  if (alreadyViewed) {
    return false;  // Already counted
  }

  // Record in Redis (fast)
  await redis.sadd(`story_views:${storyId}`, viewerId);
  await redis.incr(`story_view_count:${storyId}`);

  // Async persist to PostgreSQL
  await queue.publish('story_view', { storyId, viewerId });

  return true;  // New view
}

// Background worker persists to PostgreSQL
async function persistStoryView(event: StoryViewEvent): Promise<void> {
  await db.query(`
    INSERT INTO story_views (story_id, viewer_id)
    VALUES ($1, $2)
    ON CONFLICT (story_id, viewer_id) DO NOTHING
  `, [event.storyId, event.viewerId]);
}
```

---

## Step 7: Rate Limiting with Sliding Window

```typescript
interface RateLimitConfig {
  keyPrefix: string;
  max: number;
  windowMs: number;
}

const rateLimits: Record<string, RateLimitConfig> = {
  follow: { keyPrefix: 'follows', max: 30, windowMs: 3600000 },     // 30/hour
  post: { keyPrefix: 'posts', max: 10, windowMs: 3600000 },         // 10/hour
  like: { keyPrefix: 'likes', max: 100, windowMs: 3600000 },        // 100/hour
  comment: { keyPrefix: 'comments', max: 50, windowMs: 3600000 },   // 50/hour
  login: { keyPrefix: 'login', max: 5, windowMs: 60000 },           // 5/minute
};

async function checkRateLimit(
  userId: string,
  action: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const config = rateLimits[action];
  const key = `ratelimit:${config.keyPrefix}:${userId}`;
  const now = Date.now();

  // Sliding window using sorted set
  const pipeline = redis.pipeline();

  // Remove expired entries
  pipeline.zremrangebyscore(key, 0, now - config.windowMs);

  // Add current request
  pipeline.zadd(key, now, `${now}-${Math.random()}`);

  // Count requests in window
  pipeline.zcard(key);

  // Set expiry
  pipeline.expire(key, Math.ceil(config.windowMs / 1000));

  const results = await pipeline.exec();
  const count = results[2][1] as number;

  if (count > config.max) {
    metrics.rateLimitHits.inc({ action });
    return {
      allowed: false,
      remaining: 0,
      resetAt: now + config.windowMs
    };
  }

  return {
    allowed: true,
    remaining: config.max - count,
    resetAt: now + config.windowMs
  };
}

// Express middleware
function rateLimitMiddleware(action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await checkRateLimit(req.session.userId, action);

    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
      });
    }

    next();
  };
}
```

---

## Step 8: Circuit Breaker Pattern

### Implementation with Opossum

```typescript
import CircuitBreaker from 'opossum';

const circuitBreakerOptions = {
  timeout: 30000,              // Fail after 30 seconds
  errorThresholdPercentage: 50, // Open if 50% fail
  resetTimeout: 60000,          // Try again after 1 minute
  volumeThreshold: 3,           // Need 3 requests to evaluate
};

// Create circuit breakers for external operations
const imageProcessingBreaker = new CircuitBreaker(
  processImage,
  {
    ...circuitBreakerOptions,
    name: 'image_processing',
    fallback: (job: ImageProcessingJob) => {
      // Mark post as requiring retry
      return db.query(
        'UPDATE posts SET status = $1 WHERE id = $2',
        ['processing_delayed', job.postId]
      );
    }
  }
);

const feedGenerationBreaker = new CircuitBreaker(
  getFeed,
  {
    ...circuitBreakerOptions,
    name: 'feed_generation',
    fallback: () => ({ posts: [], fromCache: false, degraded: true })
  }
);

// Metrics for circuit breaker state
imageProcessingBreaker.on('success', () => {
  metrics.circuitBreakerEvents.inc({ name: 'image_processing', event: 'success' });
});

imageProcessingBreaker.on('failure', () => {
  metrics.circuitBreakerEvents.inc({ name: 'image_processing', event: 'failure' });
});

imageProcessingBreaker.on('open', () => {
  metrics.circuitBreakerState.set({ name: 'image_processing' }, 1);
  logger.warn('Image processing circuit breaker OPENED');
});

imageProcessingBreaker.on('close', () => {
  metrics.circuitBreakerState.set({ name: 'image_processing' }, 0);
  logger.info('Image processing circuit breaker CLOSED');
});
```

### Graceful Degradation Strategy

| Failure Scenario | Degradation Strategy |
|-----------------|---------------------|
| MinIO down | Return 503 for uploads, queue for retry |
| Redis/Valkey down | Bypass cache, query PostgreSQL directly |
| RabbitMQ down | Process images inline (blocking, with timeout) |
| Cassandra down | DMs unavailable, return 503 for messaging |
| PostgreSQL down | Return 503 for writes, serve cached reads |

---

## Step 9: Story Expiration and Cleanup

### Active Story Filtering

```sql
-- Query active stories for a user
SELECT s.*, u.username, u.avatar_url
FROM stories s
JOIN users u ON u.id = s.user_id
WHERE s.user_id = $1 AND s.expires_at > NOW()
ORDER BY s.created_at DESC;

-- Story tray: users with active stories that I follow
SELECT DISTINCT ON (u.id)
    u.id, u.username, u.avatar_url,
    s.created_at as latest_story_time,
    CASE WHEN sv.viewer_id IS NULL THEN false ELSE true END as has_seen
FROM follows f
JOIN users u ON u.id = f.following_id
JOIN stories s ON s.user_id = u.id AND s.expires_at > NOW()
LEFT JOIN story_views sv ON sv.story_id = s.id AND sv.viewer_id = $1
WHERE f.follower_id = $1
ORDER BY u.id, has_seen ASC, s.created_at DESC;
```

### Background Cleanup Job

```typescript
// Runs every hour via cron
async function cleanupExpiredStories(): Promise<CleanupResult> {
  // 1. Find expired stories (with 1-hour buffer for edge cases)
  const expired = await db.query<Story>(`
    SELECT id, media_url FROM stories
    WHERE expires_at < NOW() - INTERVAL '1 hour'
  `);

  let deletedMedia = 0;
  let deletedRecords = 0;

  for (const story of expired.rows) {
    try {
      // 2. Delete from object storage
      await minio.removeObject('instagram-media', story.media_url);
      deletedMedia++;

      // 3. Delete from database (cascades to story_views)
      await db.query('DELETE FROM stories WHERE id = $1', [story.id]);
      deletedRecords++;
    } catch (error) {
      logger.error('Failed to cleanup story', { storyId: story.id, error });
    }
  }

  // 4. Clean up Redis view sets
  const viewKeys = await redis.keys('story_views:*');
  for (const key of viewKeys) {
    const storyId = key.split(':')[1];
    const exists = await db.query('SELECT id FROM stories WHERE id = $1', [storyId]);
    if (exists.rowCount === 0) {
      await redis.del(key, `story_view_count:${storyId}`);
    }
  }

  metrics.storiesCleanedUp.inc(deletedRecords);

  return { deletedMedia, deletedRecords };
}
```

---

## Step 10: Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

const registry = new Registry();

// Request metrics
const httpRequestsTotal = new Counter({
  name: 'instagram_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [registry]
});

const httpRequestDuration = new Histogram({
  name: 'instagram_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry]
});

// Business metrics
const postsCreated = new Counter({
  name: 'instagram_posts_created_total',
  help: 'Total posts created',
  registers: [registry]
});

const likesTotal = new Counter({
  name: 'instagram_likes_total',
  help: 'Total like/unlike actions',
  labelNames: ['action'],
  registers: [registry]
});

const likesDuplicate = new Counter({
  name: 'instagram_likes_duplicate_total',
  help: 'Duplicate like attempts (idempotency working)',
  registers: [registry]
});

// Feed metrics
const feedGenerationDuration = new Histogram({
  name: 'instagram_feed_generation_seconds',
  help: 'Feed generation duration',
  labelNames: ['cache_status'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1],
  registers: [registry]
});

const feedCacheHits = new Counter({
  name: 'instagram_feed_cache_hits_total',
  help: 'Feed cache hits',
  registers: [registry]
});

const feedCacheMisses = new Counter({
  name: 'instagram_feed_cache_misses_total',
  help: 'Feed cache misses',
  registers: [registry]
});

// Image processing metrics
const imageProcessingDuration = new Histogram({
  name: 'instagram_image_processing_seconds',
  help: 'Image processing duration',
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [registry]
});

// Circuit breaker metrics
const circuitBreakerState = new Gauge({
  name: 'instagram_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [registry]
});

const circuitBreakerEvents = new Counter({
  name: 'instagram_circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['name', 'event'],
  registers: [registry]
});

// Rate limiting metrics
const rateLimitHits = new Counter({
  name: 'instagram_rate_limit_hits_total',
  help: 'Rate limit violations',
  labelNames: ['action'],
  registers: [registry]
});
```

---

## Closing Summary

"I've designed Instagram's backend with focus on:

1. **Async Image Processing Pipeline** - RabbitMQ workers generate 4 resolutions with retry and dead-letter handling
2. **Hybrid Fan-out Feed** - Push for small accounts, pull for celebrities, merged at read time with 60s caching
3. **Dual Database Architecture** - PostgreSQL for relational data with ACID, Cassandra for high-write DMs with TimeUUID ordering
4. **Reliability Patterns** - Idempotent likes via ON CONFLICT, sliding window rate limiting, circuit breakers with fallbacks

The key insight is that the hybrid fan-out approach is essential at scale - pure push fails for celebrities, pure pull is too slow for power users. The dual database approach leverages each system's strengths: PostgreSQL's constraints and JOINs for the social graph, Cassandra's write throughput and time-ordering for messaging."

---

## Potential Follow-up Questions

1. **How would you handle database sharding as you scale?**
   - Shard by user_id using consistent hashing
   - Cross-shard queries for feed require scatter-gather pattern
   - Consider routing layer like Vitess

2. **How would you implement the Explore/Discover feature?**
   - Collaborative filtering: "users who liked this also liked"
   - Content-based: image embeddings + similarity search
   - Trending: sliding window engagement velocity

3. **How would you handle profile picture changes syncing to Cassandra?**
   - Event-driven: profile update -> message queue -> sync worker
   - Worker updates all active conversations for that user
   - Eventual consistency (2-5 second lag acceptable)
