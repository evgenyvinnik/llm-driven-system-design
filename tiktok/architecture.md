# Design TikTok - Architecture

## System Overview

TikTok is a short-video platform where the recommendation algorithm is the core product. Unlike social feeds based on follows, TikTok's FYP surfaces content from anyone based on predicted engagement.

**Learning Goals:**
- Build recommendation systems from scratch
- Handle video processing pipelines
- Design for infinite scroll UX
- Balance exploration vs exploitation

---

## Requirements

### Functional Requirements

1. **Upload**: Create short videos with effects
2. **FYP**: Personalized video recommendations
3. **Discovery**: Hashtags, sounds, search
4. **Engage**: Like, comment, share, follow
5. **Analytics**: Creator metrics and insights

### Non-Functional Requirements

- **Latency**: < 100ms for video start
- **Availability**: 99.99% for video playback
- **Scale**: 1B users, 1M videos/day
- **Freshness**: New videos in recommendations within hours

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mobile Client Layer                         │
│            React Native / Native iOS/Android                    │
│         - Video player - Infinite scroll - Upload               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        CDN Layer                                │
│              Video delivery, thumbnails, assets                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Video Service │    │  Rec Service  │    │ User Service  │
│               │    │               │    │               │
│ - Upload      │    │ - FYP         │    │ - Profiles    │
│ - Transcode   │    │ - Ranking     │    │ - Follows     │
│ - Storage     │    │ - Cold start  │    │ - Activity    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├───────────────┬───────────────┬───────────────┬─────────────────┤
│  PostgreSQL   │    Valkey     │    S3/Blob    │  Feature Store  │
│  - Metadata   │ - User state  │  - Videos     │ - Embeddings    │
│  - Engagement │ - Counters    │  - Thumbnails │ - User vectors  │
└───────────────┴───────────────┴───────────────┴─────────────────┘
```

---

## Core Components

### 1. Recommendation Engine

**Two-Phase Approach:**

**Phase 1: Candidate Generation**
```javascript
async function generateCandidates(userId, count = 1000) {
  const candidates = []

  // Source 1: Videos from followed creators
  candidates.push(...await getFollowedCreatorVideos(userId, 200))

  // Source 2: Videos with liked hashtags
  candidates.push(...await getHashtagVideos(userId, 300))

  // Source 3: Videos with liked sounds
  candidates.push(...await getSoundVideos(userId, 200))

  // Source 4: Trending videos (exploration)
  candidates.push(...await getTrendingVideos(300))

  // Deduplicate and remove already watched
  return filterWatched(userId, dedupe(candidates))
}
```

**Phase 2: Ranking**
```javascript
function rankVideos(userId, candidates) {
  const userVector = getUserEmbedding(userId)

  return candidates
    .map(video => ({
      video,
      score: predictEngagement(userVector, video)
    }))
    .sort((a, b) => b.score - a.score)
}

function predictEngagement(userVector, video) {
  const videoVector = getVideoEmbedding(video.id)

  // Cosine similarity as base
  let score = cosineSimilarity(userVector, videoVector)

  // Boost factors
  score *= videoQualityScore(video)
  score *= creatorScore(video.creatorId)
  score *= freshnessScore(video.createdAt)

  return score
}
```

### 2. Video Processing Pipeline

```
Upload → Validate → Transcode → Generate Thumbnails → CDN Distribution
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Video Processing Queue                       │
│                         (Kafka)                                 │
└─────────────────────────────────────────────────────────────────┘
   │
   ├─── Transcoder Worker 1 ──▶ 1080p, 720p, 480p, 360p
   ├─── Transcoder Worker 2 ──▶ (parallel processing)
   └─── Transcoder Worker N

Output:
  - Multiple resolutions for adaptive bitrate
  - Thumbnail at multiple timestamps
  - Audio extraction for sound matching
  - Content fingerprint for dedup
```

### 3. Cold Start Strategy

**New User (no history):**
```javascript
async function coldStartFeed(userId, demographics) {
  // Use demographic-based popular videos
  const popular = await getPopularByDemographic(demographics)

  // Add variety with exploration
  const diverse = await getDiverseContent()

  // 70% demographic popular, 30% exploration
  return shuffle([
    ...popular.slice(0, 7),
    ...diverse.slice(0, 3)
  ])
}
```

**New Video (no engagement):**
```javascript
async function boostNewVideo(videoId) {
  // Give new videos initial exposure
  const targetAudience = predictAudience(videoId) // Based on content

  // Add to candidate pools of target users
  for (const userId of targetAudience.sample(1000)) {
    await addToExplorationPool(userId, videoId)
  }

  // Track early engagement signals
  // Promote or demote based on watch-through rate
}
```

---

## Database Schema

```sql
-- Videos
CREATE TABLE videos (
  id BIGSERIAL PRIMARY KEY,
  creator_id INTEGER REFERENCES users(id),
  url VARCHAR(500),
  duration_seconds INTEGER,
  description TEXT,
  hashtags TEXT[],
  sound_id INTEGER REFERENCES sounds(id),
  view_count BIGINT DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'processing',
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Watch History (for recommendations)
CREATE TABLE watch_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  video_id BIGINT REFERENCES videos(id),
  watch_duration_ms INTEGER,
  completion_rate FLOAT,
  liked BOOLEAN DEFAULT FALSE,
  shared BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_watch_history_user ON watch_history(user_id, created_at DESC);

-- Video Embeddings (for similarity)
CREATE TABLE video_embeddings (
  video_id BIGINT PRIMARY KEY REFERENCES videos(id),
  embedding VECTOR(128) -- pgvector extension
);

-- User Embeddings (learned preferences)
CREATE TABLE user_embeddings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  embedding VECTOR(128),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Watch Time as Primary Metric

**Decision**: Optimize for completion rate, not just views

**Rationale**:
- Views can be gamed
- Watch time indicates genuine interest
- Aligns with user satisfaction

### 2. Two-Phase Recommendation

**Decision**: Candidate generation (fast, broad) + Ranking (slow, precise)

**Rationale**:
- Can't score every video for every user
- Candidates filter to ~1000, then rank
- Ranking model can be sophisticated

### 3. Content-Based + Collaborative Filtering

**Decision**: Hybrid recommendation approach

**Rationale**:
- Content-based: Works for new videos
- Collaborative: Captures subtle preferences
- Combined: Best of both worlds

---

## Scalability Considerations

### Video Storage

- Object storage (S3/GCS) for videos
- CDN edge caching for popular videos
- Adaptive bitrate streaming (HLS/DASH)

### Recommendation Serving

- Precompute recommendations batch
- Cache top-N for each user
- Real-time updates for engagement signals

### View Counting

- Aggregate in Valkey (INCR)
- Flush to database periodically
- Eventually consistent counts

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Rec metric | Watch time | Views | Quality signal |
| Rec approach | Two-phase | Single model | Scalability |
| Video storage | Object + CDN | Database | Cost, performance |
| Embeddings | pgvector | Dedicated vector DB | Simplicity |

---

## Authentication and Authorization

### Authentication Strategy

**Session-Based Auth (Primary):**
```javascript
// Express session configuration
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'strict'
  }
}))
```

**Why Session-Based Over JWT:**
- Simpler token revocation (delete from Redis)
- Server-side session invalidation on password change
- Avoids JWT refresh token complexity for a learning project
- Redis already in stack for caching

### Role-Based Access Control (RBAC)

**User Roles:**
```sql
CREATE TYPE user_role AS ENUM ('user', 'creator', 'moderator', 'admin');

ALTER TABLE users ADD COLUMN role user_role DEFAULT 'user';
```

**Permission Matrix:**

| Action | User | Creator | Moderator | Admin |
|--------|------|---------|-----------|-------|
| Watch videos | Yes | Yes | Yes | Yes |
| Upload videos | No | Yes | Yes | Yes |
| Delete own videos | No | Yes | Yes | Yes |
| Delete any video | No | No | Yes | Yes |
| Ban users | No | No | Yes | Yes |
| View analytics dashboard | No | Yes (own) | Yes (all) | Yes (all) |
| Manage user roles | No | No | No | Yes |
| Access admin API | No | No | Yes | Yes |

**Middleware Implementation:**
```javascript
// Role-checking middleware
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    if (!roles.includes(req.session.userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// Usage
app.delete('/api/v1/videos/:id', requireRole('creator', 'moderator', 'admin'), deleteVideo)
app.get('/api/v1/admin/users', requireRole('moderator', 'admin'), listUsers)
app.post('/api/v1/admin/users/:id/role', requireRole('admin'), updateUserRole)
```

### Rate Limiting

**Per-Endpoint Limits:**

| Endpoint Category | Limit | Window | Rationale |
|-------------------|-------|--------|-----------|
| Video upload | 10 | 1 hour | Prevent spam, storage abuse |
| Comments | 30 | 1 minute | Prevent comment flooding |
| Likes | 100 | 1 minute | Prevent like manipulation |
| Feed requests | 60 | 1 minute | Normal scroll behavior |
| Search | 30 | 1 minute | Prevent scraping |
| Auth (login) | 5 | 15 minutes | Brute-force protection |
| Admin APIs | 100 | 1 minute | Higher limit for ops work |

**Implementation with Redis:**
```javascript
const rateLimit = require('express-rate-limit')
const RedisStore = require('rate-limit-redis')

const uploadLimiter = rateLimit({
  store: new RedisStore({ client: redisClient, prefix: 'rl:upload:' }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Upload limit reached. Try again later.' },
  keyGenerator: (req) => req.session.userId
})

app.post('/api/v1/videos', uploadLimiter, requireRole('creator'), uploadVideo)
```

### API Route Structure

```
/api/v1/                    # Public API (authenticated users)
  /videos                   # CRUD videos (role-restricted)
  /feed                     # Get personalized feed
  /users/:id                # User profiles
  /search                   # Search videos/users

/api/v1/admin/              # Admin API (moderator+ only)
  /users                    # User management
  /videos/flagged           # Content moderation queue
  /analytics                # Platform-wide metrics
  /config                   # Feature flags, limits
```

---

## Failure Handling

### Retry Strategy with Idempotency

**Idempotency Keys for Writes:**
```javascript
// Client sends idempotency key in header
// POST /api/v1/videos
// X-Idempotency-Key: uuid-v4-from-client

async function handleUpload(req, res) {
  const idempotencyKey = req.headers['x-idempotency-key']
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency key required' })
  }

  // Check if already processed
  const existing = await redis.get(`idem:upload:${idempotencyKey}`)
  if (existing) {
    return res.status(200).json(JSON.parse(existing))
  }

  // Process upload
  const result = await processUpload(req)

  // Store result for 24 hours (idempotency window)
  await redis.setex(`idem:upload:${idempotencyKey}`, 86400, JSON.stringify(result))

  return res.status(201).json(result)
}
```

**Retry Configuration for Background Jobs:**
```javascript
// Kafka consumer retry policy
const retryPolicy = {
  maxRetries: 3,
  initialDelay: 1000,      // 1 second
  maxDelay: 30000,         // 30 seconds
  backoffMultiplier: 2,    // Exponential backoff
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'TRANSCODING_TEMP_FAILURE']
}

// Dead letter queue for permanent failures
async function processWithRetry(message) {
  for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
    try {
      await processMessage(message)
      return
    } catch (error) {
      if (!retryPolicy.retryableErrors.includes(error.code)) {
        await sendToDeadLetterQueue(message, error)
        return
      }
      if (attempt === retryPolicy.maxRetries) {
        await sendToDeadLetterQueue(message, error)
        return
      }
      const delay = Math.min(
        retryPolicy.initialDelay * Math.pow(retryPolicy.backoffMultiplier, attempt),
        retryPolicy.maxDelay
      )
      await sleep(delay)
    }
  }
}
```

### Circuit Breaker Pattern

**For External Service Calls:**
```javascript
const CircuitBreaker = require('opossum')

// Circuit breaker for transcoding service
const transcodingBreaker = new CircuitBreaker(callTranscodingService, {
  timeout: 30000,           // 30s timeout per request
  errorThresholdPercentage: 50,  // Open at 50% failure rate
  resetTimeout: 30000,      // Try again after 30s
  volumeThreshold: 10       // Minimum 10 requests before tripping
})

transcodingBreaker.on('open', () => {
  console.warn('Transcoding circuit OPEN - failing fast')
  alertOps('transcoding-circuit-open')
})

transcodingBreaker.on('halfOpen', () => {
  console.info('Transcoding circuit HALF-OPEN - testing recovery')
})

transcodingBreaker.on('close', () => {
  console.info('Transcoding circuit CLOSED - recovered')
})

// Usage
async function transcodeVideo(videoId) {
  try {
    return await transcodingBreaker.fire(videoId)
  } catch (error) {
    if (error.message === 'Breaker is open') {
      // Queue for later processing
      await queueForRetry(videoId)
      return { status: 'queued' }
    }
    throw error
  }
}
```

**Services with Circuit Breakers:**
- Transcoding service (external workers)
- CDN origin requests
- ML embedding service
- Email/push notification providers

### Disaster Recovery (Local Development Context)

**Backup Strategy:**
```bash
# PostgreSQL backup (run daily via cron)
pg_dump -h localhost -U postgres tiktok > backup_$(date +%Y%m%d).sql

# Valkey/Redis backup (RDB snapshot)
redis-cli BGSAVE

# MinIO versioning (object history)
mc version enable myminio/videos
```

**Recovery Procedures:**

| Scenario | Recovery Steps | RTO Target |
|----------|----------------|------------|
| Database corruption | Restore from daily backup + WAL replay | 1 hour |
| Redis crash | Redis restarts, sessions re-auth required | 5 minutes |
| Video storage loss | Restore from MinIO versioning or S3 backup | 2 hours |
| Service failure | Docker restart, health check recovery | 1 minute |

**Local DR Testing Script:**
```bash
#!/bin/bash
# dr-test.sh - Monthly DR drill

echo "=== TikTok Local DR Test ==="

# 1. Stop all services
docker-compose down

# 2. Backup current data
./scripts/backup-all.sh

# 3. Simulate corruption (rename volumes)
mv ./data/postgres ./data/postgres.corrupted

# 4. Restore from backup
./scripts/restore-postgres.sh

# 5. Verify data integrity
npm run test:integration

# 6. Cleanup
rm -rf ./data/postgres.corrupted

echo "=== DR Test Complete ==="
```

### Graceful Degradation

**When Components Fail:**

| Component | Degradation Behavior |
|-----------|---------------------|
| Recommendation service | Serve trending/popular videos |
| Redis (cache) | Direct database queries (slower) |
| Transcoding queue | Accept uploads, process later |
| Embedding service | Skip personalization, use content-based |

---

## Data Lifecycle Policies

### Retention Policies

| Data Type | Hot Storage | Warm Storage | Cold/Archive | Delete After |
|-----------|-------------|--------------|--------------|--------------|
| Videos (active) | S3/MinIO | - | - | Never (unless deleted by user) |
| Videos (deleted) | - | - | S3 Glacier | 30 days (legal hold) |
| Watch history | PostgreSQL | - | - | 1 year |
| Session data | Redis | - | - | 7 days (TTL) |
| Rate limit counters | Redis | - | - | 1-60 minutes (TTL) |
| Idempotency keys | Redis | - | - | 24 hours (TTL) |
| Analytics events | Kafka | PostgreSQL | S3 Parquet | 2 years |
| User embeddings | PostgreSQL | - | - | Updated continuously |
| Audit logs | PostgreSQL | S3 | S3 Glacier | 7 years |

### TTL Implementation

**Redis TTLs:**
```javascript
// Session TTL - 7 days
await redis.setex(`session:${sessionId}`, 7 * 24 * 3600, sessionData)

// Rate limit TTL - varies by endpoint
await redis.setex(`rl:upload:${userId}`, 3600, count) // 1 hour
await redis.setex(`rl:comment:${userId}`, 60, count)  // 1 minute

// Idempotency key TTL - 24 hours
await redis.setex(`idem:${key}`, 86400, result)

// View count buffer TTL - 5 minutes (flush to DB)
await redis.setex(`views:pending:${videoId}`, 300, count)
```

**PostgreSQL Retention Jobs:**
```sql
-- Daily cleanup job for old watch history
CREATE OR REPLACE FUNCTION cleanup_old_watch_history()
RETURNS void AS $$
BEGIN
  DELETE FROM watch_history
  WHERE created_at < NOW() - INTERVAL '1 year';

  RAISE NOTICE 'Deleted old watch history records';
END;
$$ LANGUAGE plpgsql;

-- Schedule with pg_cron or external scheduler
-- SELECT cron.schedule('0 3 * * *', 'SELECT cleanup_old_watch_history()');
```

### Archival to Cold Storage

**Video Archival (Deleted Content):**
```javascript
async function archiveDeletedVideo(videoId) {
  const video = await db.query('SELECT * FROM videos WHERE id = $1', [videoId])

  // 1. Copy video file to archive bucket
  await minio.copyObject(
    'videos-archive',
    `deleted/${videoId}/${video.filename}`,
    `videos/${video.filename}`
  )

  // 2. Store metadata for legal compliance
  await minio.putObject(
    'videos-archive',
    `deleted/${videoId}/metadata.json`,
    JSON.stringify({
      ...video,
      deleted_at: new Date().toISOString(),
      deletion_reason: 'user_request', // or 'policy_violation', 'dmca'
      retain_until: addDays(new Date(), 30).toISOString()
    })
  )

  // 3. Delete from hot storage
  await minio.removeObject('videos', video.filename)
  await db.query('DELETE FROM videos WHERE id = $1', [videoId])
}
```

**Analytics Archival Pipeline:**
```javascript
// Monthly job to archive old analytics to S3/Parquet
async function archiveOldAnalytics() {
  const cutoffDate = subMonths(new Date(), 3)

  // Export to Parquet format
  await db.query(`
    COPY (
      SELECT * FROM analytics_events
      WHERE created_at < $1
    ) TO PROGRAM 'parquet-tools csv2parquet -o /tmp/analytics_${cutoffDate}.parquet'
  `, [cutoffDate])

  // Upload to cold storage
  await minio.fPutObject(
    'analytics-archive',
    `${cutoffDate.getFullYear()}/${cutoffDate.getMonth()}/events.parquet`,
    `/tmp/analytics_${cutoffDate}.parquet`
  )

  // Delete from hot storage
  await db.query('DELETE FROM analytics_events WHERE created_at < $1', [cutoffDate])
}
```

### Backfill and Replay Procedures

**Kafka Replay for Reprocessing:**
```javascript
// Replay messages from a specific offset for reprocessing
async function replayFromOffset(topic, partition, fromOffset) {
  const consumer = kafka.consumer({ groupId: 'replay-group' })
  await consumer.connect()

  await consumer.subscribe({ topic, fromBeginning: false })

  // Seek to specific offset
  consumer.on('consumer.group_join', async () => {
    await consumer.seek({ topic, partition, offset: fromOffset })
  })

  await consumer.run({
    eachMessage: async ({ message }) => {
      await reprocessMessage(message)
    }
  })
}

// Usage: Replay last 24 hours of video processing
// replayFromOffset('video-uploads', 0, getOffsetFromTimestamp(Date.now() - 86400000))
```

**User Embedding Backfill:**
```javascript
// Rebuild user embeddings from watch history
async function backfillUserEmbeddings(batchSize = 1000) {
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const users = await db.query(`
      SELECT id FROM users
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [batchSize, offset])

    if (users.rows.length === 0) {
      hasMore = false
      continue
    }

    for (const user of users.rows) {
      const watchHistory = await db.query(`
        SELECT v.hashtags, wh.completion_rate, wh.liked
        FROM watch_history wh
        JOIN videos v ON wh.video_id = v.id
        WHERE wh.user_id = $1
        ORDER BY wh.created_at DESC
        LIMIT 100
      `, [user.id])

      const embedding = computeUserEmbedding(watchHistory.rows)

      await db.query(`
        INSERT INTO user_embeddings (user_id, embedding, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET embedding = $2, updated_at = NOW()
      `, [user.id, embedding])
    }

    offset += batchSize
    console.log(`Processed ${offset} users`)
  }
}
```

**Video Metadata Backfill Script:**
```bash
#!/bin/bash
# backfill-video-metadata.sh
# Re-extract metadata for videos missing duration/thumbnails

psql -h localhost -U postgres -d tiktok -c "
  SELECT id, url FROM videos
  WHERE duration_seconds IS NULL OR thumbnail_url IS NULL
" --csv | tail -n +2 | while IFS=',' read -r id url; do
  echo "Processing video $id..."

  # Extract duration
  duration=$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$url" 2>/dev/null)

  # Generate thumbnail
  thumbnail_path="/tmp/thumb_${id}.jpg"
  ffmpeg -i "$url" -ss 00:00:01 -vframes 1 "$thumbnail_path" -y 2>/dev/null

  # Upload thumbnail
  mc cp "$thumbnail_path" myminio/thumbnails/

  # Update database
  psql -h localhost -U postgres -d tiktok -c "
    UPDATE videos
    SET duration_seconds = ${duration:-0},
        thumbnail_url = 'thumbnails/thumb_${id}.jpg'
    WHERE id = $id
  "

  rm -f "$thumbnail_path"
done
```

### Data Integrity Checks

**Daily Consistency Verification:**
```sql
-- Check for orphaned records
SELECT 'orphaned_watch_history' as issue, COUNT(*) as count
FROM watch_history wh
LEFT JOIN users u ON wh.user_id = u.id
WHERE u.id IS NULL

UNION ALL

SELECT 'orphaned_comments', COUNT(*)
FROM comments c
LEFT JOIN videos v ON c.video_id = v.id
WHERE v.id IS NULL

UNION ALL

SELECT 'missing_embeddings', COUNT(*)
FROM videos v
LEFT JOIN video_embeddings ve ON v.id = ve.video_id
WHERE ve.video_id IS NULL AND v.status = 'published';
```
