# Design Twitter - Architecture

## System Overview

Twitter is a real-time microblogging platform where the core challenge is delivering tweets to followers' timelines efficiently. With celebrity users having millions of followers, naive approaches fail at scale.

**Learning Goals:**
- Understand fanout strategies (push vs pull vs hybrid)
- Design social graph storage and queries
- Build real-time trend detection
- Handle the "celebrity problem"

---

## Requirements

### Functional Requirements

1. **Tweet**: Post 280-character messages with media
2. **Follow**: Subscribe to other users' content
3. **Timeline**: View chronological feed of followed users
4. **Trending**: See popular topics in real-time
5. **Notifications**: Alerts for mentions, likes, retweets

### Non-Functional Requirements

- **Latency**: < 200ms for timeline load
- **Availability**: 99.99% uptime
- **Scale**: 500M users, 500M tweets/day
- **Consistency**: Eventual (users can tolerate slight delays)

---

## Capacity Estimation (Learning Scale)

- **Users**: 1,000
- **Tweets**: 10,000
- **Follows**: 50,000 relationships
- **Timeline reads**: 100/second

**Storage**: ~50 MB

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│              React + Tanstack Router + SSE/WebSocket            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / Load Balancer                  │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Tweet Service │    │ Timeline Svc  │    │ Social Graph  │
│               │    │               │    │               │
│ - Create tweet│    │ - Build feed  │    │ - Follow/unf  │
│ - Store media │    │ - Fanout      │    │ - Followers   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Queue (Kafka)                        │
│              tweet.created, follow.new, etc.                    │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Fanout Workers │    │ Trend Service │    │ Notification  │
│               │    │               │    │   Service     │
│- Push to cache│    │- Count tags   │    │- Real-time    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │
        ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │    Valkey/Redis                               │
│   - Users       │    - Timeline cache (lists)                   │
│   - Tweets      │    - Social graph cache                       │
│   - Follows     │    - Trend counters                           │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Timeline Fanout

**The Core Problem**: User A tweets → All followers (could be millions) need to see it

**Strategy Comparison**:

| Strategy | Write Cost | Read Cost | Best For |
|----------|------------|-----------|----------|
| Push (Fanout on Write) | O(followers) | O(1) | Normal users |
| Pull (Fanout on Read) | O(1) | O(following) | Celebrity users |
| Hybrid | Varies | Varies | Mixed audience |

**Push Implementation**:
```javascript
// Fanout worker processes tweet.created events
async function fanoutTweet(tweetId, authorId) {
  const followers = await getFollowers(authorId)

  // Write to each follower's timeline cache
  const pipeline = redis.pipeline()
  for (const followerId of followers) {
    pipeline.lpush(`timeline:${followerId}`, tweetId)
    pipeline.ltrim(`timeline:${followerId}`, 0, 799) // Keep last 800
  }
  await pipeline.exec()
}
```

**Pull Implementation**:
```javascript
// Fetch timeline on demand
async function getTimeline(userId) {
  const following = await getFollowing(userId)

  // Get recent tweets from all followed users
  const tweets = await db.query(`
    SELECT * FROM tweets
    WHERE author_id = ANY($1)
    ORDER BY created_at DESC
    LIMIT 100
  `, [following])

  return tweets
}
```

**Hybrid (Recommended)**:
- Users with < 10K followers: Push (fanout on write)
- Users with > 10K followers: Pull (merge at read time)
- Timeline read: Merge cached timeline + pull from celebrities

### 2. Social Graph

**Storage Options**:

| Option | Pros | Cons |
|--------|------|------|
| PostgreSQL adjacency | Simple, transactional | Slow for deep queries |
| Graph DB (Neo4j) | Fast traversals | Operational complexity |
| Valkey Sets | Fast reads | Memory intensive |

**Chosen: PostgreSQL + Valkey Cache**

```sql
-- PostgreSQL for source of truth
CREATE TABLE follows (
  follower_id INTEGER REFERENCES users(id),
  following_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX idx_follows_following ON follows(following_id);
```

```javascript
// Valkey for fast lookups
// followers:123 = SET of user IDs who follow user 123
// following:123 = SET of user IDs that user 123 follows

await redis.sadd(`followers:${userId}`, followerId)
await redis.sadd(`following:${followerId}`, userId)
```

### 3. Trend Detection

**Challenge**: Identify trending hashtags in real-time

**Approach: Sliding Window with Decay**

```javascript
// Track hashtag counts in time buckets
const BUCKET_SIZE = 60 // 1 minute
const WINDOW_SIZE = 60 // 60 minutes

async function recordHashtag(hashtag) {
  const bucket = Math.floor(Date.now() / 1000 / BUCKET_SIZE)
  const key = `trend:${hashtag}:${bucket}`

  await redis.incr(key)
  await redis.expire(key, WINDOW_SIZE * BUCKET_SIZE)
}

async function getTrendScore(hashtag) {
  const now = Math.floor(Date.now() / 1000 / BUCKET_SIZE)
  let score = 0

  for (let i = 0; i < WINDOW_SIZE; i++) {
    const bucket = now - i
    const count = await redis.get(`trend:${hashtag}:${bucket}`) || 0
    // Recent buckets weighted more heavily
    score += count * Math.pow(0.95, i)
  }

  return score
}
```

**Trend Velocity**: Compare current hour vs previous hour
```javascript
function trendVelocity(currentCount, previousCount) {
  if (previousCount === 0) return currentCount > 10 ? Infinity : 0
  return (currentCount - previousCount) / previousCount
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100),
  bio TEXT,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE, -- > 10K followers
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tweets
CREATE TABLE tweets (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id),
  content VARCHAR(280) NOT NULL,
  media_urls TEXT[],
  hashtags TEXT[],
  mentions INTEGER[], -- User IDs mentioned
  reply_to BIGINT REFERENCES tweets(id),
  retweet_of BIGINT REFERENCES tweets(id),
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tweets_author ON tweets(author_id, created_at DESC);
CREATE INDEX idx_tweets_hashtags ON tweets USING GIN(hashtags);

-- Follows
CREATE TABLE follows (
  follower_id INTEGER REFERENCES users(id),
  following_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

-- Likes
CREATE TABLE likes (
  user_id INTEGER REFERENCES users(id),
  tweet_id BIGINT REFERENCES tweets(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);
```

---

## API Design

```
# Tweets
POST   /api/tweets              - Create tweet
GET    /api/tweets/:id          - Get single tweet
DELETE /api/tweets/:id          - Delete tweet

# Timeline
GET    /api/timeline/home       - Home timeline
GET    /api/timeline/user/:id   - User's tweets

# Social
POST   /api/users/:id/follow    - Follow user
DELETE /api/users/:id/follow    - Unfollow user
GET    /api/users/:id/followers - List followers
GET    /api/users/:id/following - List following

# Engagement
POST   /api/tweets/:id/like     - Like tweet
DELETE /api/tweets/:id/like     - Unlike tweet
POST   /api/tweets/:id/retweet  - Retweet

# Trends
GET    /api/trends              - Get trending topics
GET    /api/trends/:location    - Location-based trends
```

---

## Key Design Decisions

### 1. Hybrid Fanout

**Decision**: Push for normal users, pull for celebrities

**Rationale**:
- Pure push: Celebrity tweets take too long (50M writes)
- Pure pull: Normal timeline too slow (aggregate from 1000 users)
- Hybrid: Best of both worlds

**Implementation**:
- Flag users as `is_celebrity` when followers > 10K
- Fanout workers skip celebrity tweets
- Timeline service merges: cached + celebrity pulls

### 2. Valkey for Timelines

**Decision**: Store timeline IDs in Valkey lists

**Rationale**:
- O(1) push to front of list
- O(1) retrieval of first N items
- Automatic trimming (LTRIM)
- Fast enough for real-time

**Trade-off**: If Valkey crashes, rebuild from database

### 3. Kafka for Event Streaming

**Decision**: All mutations produce events to Kafka

**Rationale**:
- Decouples services (tweet service doesn't know about fanout)
- Enables replay for debugging
- Async processing for better latency

---

## Scalability Considerations

### The Celebrity Problem

| User Type | Followers | Fanout Strategy |
|-----------|-----------|-----------------|
| Normal | < 10K | Push (cache on write) |
| Influencer | 10K - 1M | Partial push + pull |
| Celebrity | > 1M | Pull only |

### Sharding Strategy

- **Tweets**: Shard by tweet_id (auto-increment)
- **Users**: Shard by user_id
- **Timeline**: Shard by user_id
- **Follows**: Shard by follower_id

### Caching Layers

1. **CDN**: Profile images, media
2. **Valkey**: Timelines, counters, trends
3. **Local**: Parsed tweet cache

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Fanout | Hybrid push/pull | Pure push | Celebrity problem |
| Timeline storage | Valkey lists | PostgreSQL | Speed of reads |
| Graph storage | PostgreSQL + cache | Graph DB | Simplicity |
| Events | Kafka | Direct calls | Decoupling |

---

## Local Multi-Instance Setup

```bash
# API Servers
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002

# Fanout Workers
npm run dev:fanout-worker

# Trend Calculator
npm run dev:trends

# Infrastructure
docker-compose up -d  # PostgreSQL, Valkey, Kafka
```

---

## Failure Handling

### Idempotency Keys

**Problem**: Network failures can cause duplicate requests (user clicks "Tweet" twice, or client retries after timeout).

**Solution**: Idempotency keys for all write operations.

```javascript
// Client sends unique key with each request
POST /api/tweets
Headers: Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

// Server tracks completed operations in Redis
async function handleTweetCreate(req, res) {
  const idempotencyKey = req.headers['idempotency-key']
  const cacheKey = `idempotency:tweet:${req.user.id}:${idempotencyKey}`

  // Check if we already processed this request
  const cached = await redis.get(cacheKey)
  if (cached) {
    return res.json(JSON.parse(cached)) // Return cached response
  }

  // Process the request
  const tweet = await createTweet(req.body)

  // Cache the result for 24 hours
  await redis.setex(cacheKey, 86400, JSON.stringify(tweet))

  return res.json(tweet)
}
```

**Local Implementation**: Store idempotency keys in Redis with 24-hour TTL. For learning, focus on tweet creation and follow/unfollow operations.

### Retry Strategy

**Exponential Backoff with Jitter**:
```javascript
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
}

async function withRetry(operation, context) {
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isRetryable(error) || attempt === RETRY_CONFIG.maxAttempts) {
        throw error
      }

      const delay = Math.min(
        RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1),
        RETRY_CONFIG.maxDelayMs
      )
      const jitter = delay * 0.2 * Math.random()

      console.log(`Retry ${attempt}/${RETRY_CONFIG.maxAttempts} for ${context} in ${delay + jitter}ms`)
      await sleep(delay + jitter)
    }
  }
}

function isRetryable(error) {
  // Retry on network errors, timeouts, 503s
  // Do NOT retry on 4xx client errors
  return error.code === 'ECONNRESET' ||
         error.code === 'ETIMEDOUT' ||
         error.status === 503
}
```

### Circuit Breaker Pattern

**Purpose**: Prevent cascading failures when a downstream service is unhealthy.

```javascript
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeoutMs = options.resetTimeoutMs || 30000
    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.lastFailureTime = null
  }

  async call(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN'
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`)
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    this.state = 'CLOSED'
  }

  onFailure() {
    this.failures++
    this.lastFailureTime = Date.now()
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      console.error(`Circuit breaker ${this.name} tripped to OPEN`)
    }
  }
}

// Usage for fanout service
const fanoutCircuit = new CircuitBreaker('fanout-service', {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
})

async function fanoutWithProtection(tweetId, authorId) {
  return fanoutCircuit.call(() => fanoutTweet(tweetId, authorId))
}
```

**Local Circuit Breakers**:
| Service | Failure Threshold | Reset Timeout | Fallback Behavior |
|---------|-------------------|---------------|-------------------|
| Redis timeline | 5 failures | 30s | Serve from PostgreSQL |
| Trend service | 3 failures | 60s | Return cached/empty trends |
| Fanout worker | 5 failures | 30s | Queue for retry |

### Graceful Degradation

When services fail, the system should degrade gracefully:

1. **Redis down**: Fall back to PostgreSQL for timeline queries (slower but works)
2. **Kafka down**: Queue tweets in Redis list, process when Kafka recovers
3. **Trend service down**: Return stale trends from cache or empty list

```javascript
async function getHomeTimeline(userId) {
  try {
    // Primary: Redis timeline cache
    return await getTimelineFromRedis(userId)
  } catch (redisError) {
    console.warn('Redis unavailable, falling back to PostgreSQL', redisError)

    // Fallback: Direct database query
    return await getTimelineFromDatabase(userId)
  }
}
```

### Backup and Restore (Local Development)

**PostgreSQL Backup Script** (`scripts/backup.sh`):
```bash
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups"

mkdir -p $BACKUP_DIR

# Dump PostgreSQL
pg_dump -h localhost -U twitter -d twitter_dev \
  --format=custom \
  --file="${BACKUP_DIR}/twitter_${TIMESTAMP}.dump"

# Keep last 7 backups
ls -t ${BACKUP_DIR}/*.dump | tail -n +8 | xargs -r rm

echo "Backup created: ${BACKUP_DIR}/twitter_${TIMESTAMP}.dump"
```

**Restore Script** (`scripts/restore.sh`):
```bash
#!/bin/bash
BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore.sh <backup_file>"
  exit 1
fi

# Restore PostgreSQL
pg_restore -h localhost -U twitter -d twitter_dev \
  --clean --if-exists \
  "$BACKUP_FILE"

echo "Restored from: $BACKUP_FILE"
```

**Testing Backups** (add to weekly dev routine):
```bash
# 1. Create backup
./scripts/backup.sh

# 2. Create test database
createdb twitter_restore_test

# 3. Restore to test database
pg_restore -h localhost -U twitter -d twitter_restore_test backups/latest.dump

# 4. Verify row counts
psql -d twitter_restore_test -c "SELECT 'users', count(*) FROM users UNION ALL SELECT 'tweets', count(*) FROM tweets"

# 5. Cleanup
dropdb twitter_restore_test
```

---

## Data Lifecycle Policies

### Retention and TTL Configuration

| Data Type | Hot Storage | TTL | Archive Strategy |
|-----------|-------------|-----|------------------|
| Tweets | PostgreSQL | Forever (soft delete) | None for learning |
| Timeline cache | Redis | 7 days | Auto-expires |
| Trend buckets | Redis | 2 hours | Auto-expires |
| Idempotency keys | Redis | 24 hours | Auto-expires |
| Session data | Redis | 7 days | Auto-expires |
| Deleted tweets | PostgreSQL | 30 days | Hard delete via cron |

**Redis TTL Configuration**:
```javascript
// Timeline entries: 7 days
await redis.lpush(`timeline:${userId}`, tweetId)
await redis.expire(`timeline:${userId}`, 7 * 24 * 60 * 60)

// Trend buckets: 2 hours (auto-expire after window closes)
await redis.incr(`trend:${hashtag}:${bucket}`)
await redis.expire(`trend:${hashtag}:${bucket}`, 2 * 60 * 60)

// Session: 7 days
await redis.setex(`session:${sessionId}`, 7 * 24 * 60 * 60, userData)
```

### Soft Delete Pattern

Tweets use soft delete to preserve timeline integrity:

```sql
-- Soft delete column
ALTER TABLE tweets ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL;
CREATE INDEX idx_tweets_deleted ON tweets(deleted_at) WHERE deleted_at IS NOT NULL;

-- Soft delete operation
UPDATE tweets SET deleted_at = NOW() WHERE id = $1;

-- Query excludes deleted tweets
SELECT * FROM tweets WHERE author_id = $1 AND deleted_at IS NULL;
```

**Hard Delete Cleanup Job** (run weekly):
```sql
-- Delete tweets soft-deleted more than 30 days ago
DELETE FROM likes WHERE tweet_id IN (
  SELECT id FROM tweets WHERE deleted_at < NOW() - INTERVAL '30 days'
);

DELETE FROM tweets WHERE deleted_at < NOW() - INTERVAL '30 days';

-- Log count for monitoring
SELECT 'Cleaned up', count(*) FROM tweets WHERE deleted_at < NOW() - INTERVAL '30 days';
```

### Archival to Cold Storage (Production Concept)

For learning purposes, understand the pattern even if not implemented locally:

```javascript
// Conceptual: Archive old tweets to S3/MinIO
async function archiveOldTweets(olderThanDays = 365) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

  // 1. Export to JSONL file
  const oldTweets = await db.query(`
    SELECT * FROM tweets
    WHERE created_at < $1
    ORDER BY created_at
  `, [cutoff])

  const filename = `tweets_archive_${cutoff.toISOString().split('T')[0]}.jsonl`
  await writeToMinIO('archives', filename, oldTweets.map(JSON.stringify).join('\n'))

  // 2. Replace with tombstone reference
  await db.query(`
    UPDATE tweets
    SET content = '[ARCHIVED]',
        media_urls = NULL,
        archived_at = NOW(),
        archive_location = $2
    WHERE created_at < $1
  `, [cutoff, `s3://archives/${filename}`])
}
```

### Backfill and Replay Procedures

**Timeline Cache Rebuild** (if Redis data is lost):
```javascript
async function rebuildTimelineCache(userId) {
  console.log(`Rebuilding timeline cache for user ${userId}`)

  // 1. Get users this person follows (excluding celebrities)
  const following = await db.query(`
    SELECT f.following_id, u.is_celebrity
    FROM follows f
    JOIN users u ON f.following_id = u.id
    WHERE f.follower_id = $1 AND u.is_celebrity = FALSE
  `, [userId])

  // 2. Get recent tweets from followed users
  const followingIds = following.rows.map(r => r.following_id)
  const tweets = await db.query(`
    SELECT id FROM tweets
    WHERE author_id = ANY($1)
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 800
  `, [followingIds])

  // 3. Rebuild Redis list
  const tweetIds = tweets.rows.map(t => t.id)
  if (tweetIds.length > 0) {
    await redis.del(`timeline:${userId}`)
    await redis.rpush(`timeline:${userId}`, ...tweetIds)
    await redis.expire(`timeline:${userId}`, 7 * 24 * 60 * 60)
  }

  console.log(`Rebuilt timeline for user ${userId} with ${tweetIds.length} tweets`)
}

// Rebuild all timelines (run after Redis recovery)
async function rebuildAllTimelines() {
  const users = await db.query('SELECT id FROM users')
  for (const user of users.rows) {
    await rebuildTimelineCache(user.id)
  }
}
```

**Kafka Event Replay** (conceptual):
```javascript
// Replay events from a specific offset to reprocess
async function replayEvents(topic, fromOffset, toOffset) {
  const consumer = kafka.consumer({ groupId: 'replay-consumer' })
  await consumer.connect()

  await consumer.subscribe({ topic, fromBeginning: false })
  consumer.seek({ topic, partition: 0, offset: fromOffset })

  await consumer.run({
    eachMessage: async ({ message, offset }) => {
      if (parseInt(offset) > toOffset) {
        await consumer.disconnect()
        return
      }

      const event = JSON.parse(message.value)
      await processEvent(event) // Same handler as normal processing
    }
  })
}
```

---

## Deployment and Operations

### Rollout Strategy

**Blue-Green Deployment (Local Simulation)**:
```bash
# Run two versions simultaneously on different ports
# Blue (current): Ports 3001, 3002
# Green (new): Ports 3003, 3004

# 1. Start green instances
PORT=3003 npm run start &
PORT=3004 npm run start &

# 2. Run smoke tests against green
curl -f http://localhost:3003/health
curl -f http://localhost:3003/api/timeline/home -H "Cookie: session=..."

# 3. Update load balancer to point to green
# (In nginx.conf, change upstream servers)

# 4. Drain and stop blue instances
kill $(lsof -ti:3001)
kill $(lsof -ti:3002)
```

**Canary Releases** (conceptual):
```nginx
# nginx.conf - Route 10% of traffic to canary
upstream api_servers {
    server localhost:3001 weight=45;
    server localhost:3002 weight=45;
    server localhost:3003 weight=10;  # Canary
}
```

**Feature Flags**:
```javascript
// Simple feature flag check
const FEATURES = {
  NEW_TREND_ALGORITHM: process.env.FF_NEW_TREND_ALGO === 'true',
  ASYNC_FANOUT: process.env.FF_ASYNC_FANOUT === 'true',
}

async function getTrends() {
  if (FEATURES.NEW_TREND_ALGORITHM) {
    return getNewTrends()  // New implementation
  }
  return getLegacyTrends()  // Safe fallback
}
```

### Schema Migrations

**Migration File Structure** (`backend/src/db/migrations/`):
```
001_initial_schema.sql
002_add_is_celebrity.sql
003_add_deleted_at.sql
004_add_trend_indexes.sql
```

**Migration Runner** (`backend/src/db/migrate.js`):
```javascript
const fs = require('fs')
const path = require('path')
const pool = require('./pool')

async function migrate() {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(50) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Get applied migrations
  const { rows: applied } = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  )
  const appliedVersions = new Set(applied.map(r => r.version))

  // Get pending migrations
  const migrationsDir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(migrationsDir).sort()

  for (const file of files) {
    const version = file.replace('.sql', '')
    if (appliedVersions.has(version)) continue

    console.log(`Applying migration: ${file}`)

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')

    await pool.query('BEGIN')
    try {
      await pool.query(sql)
      await pool.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      )
      await pool.query('COMMIT')
      console.log(`Applied: ${file}`)
    } catch (error) {
      await pool.query('ROLLBACK')
      console.error(`Failed: ${file}`, error)
      throw error
    }
  }

  console.log('All migrations applied')
}

migrate().catch(console.error).finally(() => pool.end())
```

**Safe Migration Practices**:
```sql
-- 003_add_deleted_at.sql

-- Always use IF NOT EXISTS for additive changes
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL;

-- Create indexes CONCURRENTLY to avoid locking (PostgreSQL)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tweets_deleted
  ON tweets(deleted_at) WHERE deleted_at IS NOT NULL;

-- For column renames, use a multi-step process:
-- Step 1: Add new column
-- Step 2: Backfill data
-- Step 3: Update application to use new column
-- Step 4: Drop old column (in next release)
```

### Rollback Runbooks

**Scenario 1: Bad Application Deploy**
```bash
# Symptoms: 5xx errors spike, latency increase

# 1. Check recent deployments
git log --oneline -5

# 2. Identify the bad commit
# Look for correlation between deploy time and error spike

# 3. Revert to previous version
git revert HEAD
npm run build
npm run start

# OR restore from known-good tag
git checkout v1.2.3
npm run build
npm run start

# 4. Notify team and investigate root cause
```

**Scenario 2: Bad Database Migration**
```bash
# Symptoms: Application errors referencing schema

# 1. Identify the failing migration
psql -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"

# 2. Check migration file for DOWN script
cat backend/src/db/migrations/003_add_deleted_at.sql

# 3. Apply rollback SQL manually
psql -f backend/src/db/migrations/003_add_deleted_at.down.sql

# 4. Remove from migrations table
psql -c "DELETE FROM schema_migrations WHERE version = '003_add_deleted_at'"

# 5. Fix migration and reapply
npm run db:migrate
```

**Scenario 3: Redis Data Corruption**
```bash
# Symptoms: Timeline showing wrong tweets, trends broken

# 1. Identify scope of corruption
redis-cli KEYS "timeline:*" | wc -l
redis-cli KEYS "trend:*" | wc -l

# 2. Option A: Clear and rebuild specific keys
redis-cli DEL timeline:123
node -e "require('./src/db/rebuild').rebuildTimelineCache(123)"

# 3. Option B: Full Redis flush and rebuild
redis-cli FLUSHDB
npm run rebuild:timelines
npm run rebuild:trends

# 4. Verify rebuild completed
redis-cli KEYS "timeline:*" | wc -l
```

**Scenario 4: Kafka Consumer Lag**
```bash
# Symptoms: Fanout delayed, tweets not appearing in timelines

# 1. Check consumer lag
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group fanout-workers

# 2. If lag is high, scale up consumers temporarily
PORT=3005 npm run dev:fanout-worker &
PORT=3006 npm run dev:fanout-worker &

# 3. Monitor until lag clears
watch -n 5 'kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group fanout-workers'

# 4. Scale back down once caught up
```

### Health Check Endpoints

```javascript
// Comprehensive health check for monitoring
app.get('/health', async (req, res) => {
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {}
  }

  // PostgreSQL check
  try {
    await pool.query('SELECT 1')
    checks.services.postgres = { status: 'ok' }
  } catch (error) {
    checks.services.postgres = { status: 'error', message: error.message }
    checks.status = 'degraded'
  }

  // Redis check
  try {
    await redis.ping()
    checks.services.redis = { status: 'ok' }
  } catch (error) {
    checks.services.redis = { status: 'error', message: error.message }
    checks.status = 'degraded'
  }

  // Kafka check (if applicable)
  try {
    const admin = kafka.admin()
    await admin.connect()
    await admin.listTopics()
    await admin.disconnect()
    checks.services.kafka = { status: 'ok' }
  } catch (error) {
    checks.services.kafka = { status: 'error', message: error.message }
    checks.status = 'degraded'
  }

  const statusCode = checks.status === 'ok' ? 200 : 503
  res.status(statusCode).json(checks)
})

// Readiness probe (for load balancer)
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    await redis.ping()
    res.status(200).send('ready')
  } catch (error) {
    res.status(503).send('not ready')
  }
})

// Liveness probe (for process manager)
app.get('/live', (req, res) => {
  res.status(200).send('alive')
})
```

---

## Implementation Notes

This section explains the reasoning behind key implementation decisions in the codebase.

### Why Idempotency Prevents Duplicate Tweets on Retry

**The Problem**: Network failures are inevitable. When a user clicks "Tweet" and experiences a timeout:
- Did the server receive and process the request?
- Did the server crash before persisting the tweet?
- Did the response get lost on the way back?

The user doesn't know, so they click "Tweet" again. Without idempotency, this creates duplicate tweets.

**The Solution**: The client generates a unique idempotency key (UUID) and sends it with the request:

```javascript
// Client sends:
POST /api/tweets
Headers: Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Body: { content: "Hello world!" }
```

The server workflow:
1. Check Redis for the idempotency key
2. If found: return the cached response (request already processed)
3. If not found: process the request, cache the response with 24-hour TTL

**Why This Works**:
- **Same key = same outcome**: Retries with the same key are idempotent
- **User context isolation**: Keys are scoped to user ID, preventing cross-user conflicts
- **TTL-based cleanup**: 24-hour TTL balances storage vs protection window
- **Graceful degradation**: On Redis failure, we allow potential duplicates rather than blocking all requests

**Implementation**: See `/Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/twitter/backend/src/shared/idempotency.js`

### Why Circuit Breakers Protect the Timeline Service During Fanout Storms

**The Problem**: When a popular user tweets, the fanout service must write to potentially millions of follower timelines. If Redis becomes slow or unresponsive:
- Fanout operations queue up, consuming memory
- Request threads block, reducing capacity for other requests
- Timeouts cascade, causing user-facing latency spikes
- Retry storms amplify the load when Redis partially recovers

**The Solution**: Circuit breakers act like electrical fuses:

```
CLOSED (normal) --[failures exceed threshold]--> OPEN (fail fast)
     ^                                              |
     |                                              v
     +--[success after reset timeout]------ HALF_OPEN (testing)
```

When the circuit is OPEN:
- Requests fail immediately without waiting for timeout
- Failed fanouts are queued for later retry
- System resources are preserved for healthy paths
- Users still get their tweets created (fanout happens async)

**Why This Works**:
- **Fail fast**: OPEN circuit returns immediately, freeing resources
- **Graceful degradation**: Tweet creation succeeds; fanout catches up later
- **Automatic recovery**: HALF_OPEN state tests if service recovered
- **Fallback behavior**: Failed fanouts queue in Redis for background processing

**Configuration**:
```javascript
// Fanout circuit breaker settings
{
  timeout: 30000,           // 30 second timeout for bulk operations
  errorThresholdPercentage: 60,  // Trip after 60% failures
  resetTimeout: 60000,      // Try again after 1 minute
  volumeThreshold: 5,       // Minimum requests before tripping
}
```

**Implementation**: See `/Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/twitter/backend/src/shared/circuitBreaker.js`

### Why Retention Policies Balance Storage Costs vs User Experience

**The Problem**: Every tweet, timeline entry, and trend bucket consumes storage. At scale:
- PostgreSQL storage costs increase with tweet volume
- Redis memory is expensive (in-memory pricing)
- Old data provides diminishing value to users
- Compliance may require keeping or deleting specific data

**The Solution**: Define retention policies that balance these concerns:

| Data Type | Retention | Rationale |
|-----------|-----------|-----------|
| Active tweets | Forever | Core user content, never auto-delete |
| Soft-deleted tweets | 30 days | Allow recovery, then hard delete |
| Timeline cache | 7 days | Users rarely scroll beyond a week |
| Trend buckets | 2 hours | Trends are about recency, not history |
| Idempotency keys | 24 hours | Protect against same-day retries |
| Hashtag activity | 90 days | Historical trend analysis |

**Why These Numbers**:
- **30-day soft delete**: Gives users time to request recovery (GDPR considerations)
- **7-day timeline cache**: Covers typical user behavior while limiting Redis memory
- **2-hour trend buckets**: Trends should be "what's happening now", not yesterday
- **24-hour idempotency**: Covers retry scenarios without infinite storage

**Storage Savings Calculation** (hypothetical 1M users):
```
Without retention:
- Timeline cache: 1M users * 800 tweets * 8 bytes = 6.4 GB Redis

With 7-day TTL:
- Only active users have data in Redis
- Inactive users auto-expire
- Typical: 10% active = 640 MB Redis
```

**Implementation**: See `/Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/twitter/backend/src/shared/retention.js`

### Why Health Checks Enable Zero-Downtime Deployments

**The Problem**: During deployment, we need to:
1. Start new instances without dropping traffic
2. Drain old instances gracefully
3. Detect unhealthy instances before routing traffic
4. Recover from dependency failures

**The Solution**: Three-tier health check strategy:

| Endpoint | Purpose | Used By |
|----------|---------|---------|
| `/live` | Is the process alive? | Process manager (systemd, PM2) |
| `/ready` | Can it accept traffic? | Load balancer |
| `/health` | Detailed status | Monitoring, debugging |

**Liveness Probe** (`/live`):
```javascript
app.get('/live', (req, res) => {
  res.status(200).send('alive');
});
```
- Always returns 200 if the process is running
- Process manager restarts if this fails
- No dependency checks (avoids false positives)

**Readiness Probe** (`/ready`):
```javascript
app.get('/ready', async (req, res) => {
  await pool.query('SELECT 1');  // Check PostgreSQL
  await redis.ping();            // Check Redis
  res.status(200).send('ready');
});
```
- Returns 200 only if dependencies are healthy
- Load balancer removes instance from rotation if 503
- Instance can recover and re-enter rotation

**Zero-Downtime Deployment Flow**:
```
1. Start new instance (green)
2. Wait for /ready to return 200
3. Load balancer adds green to rotation
4. Drain old instance (blue):
   - Stop sending new requests
   - Wait for in-flight requests to complete (graceful shutdown)
5. Terminate blue instance
```

**Graceful Shutdown**:
```javascript
const gracefulShutdown = async (signal) => {
  server.close(async () => {
    await pool.end();     // Close DB connections
    await redis.quit();   // Close Redis connection
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000);  // Force after 30s
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

**Implementation**: See `/Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/twitter/backend/src/index.js`

### Why Structured Logging with Pino

**The Problem**: `console.log` debugging doesn't scale:
- No machine-parseable format for log aggregation
- No log levels for filtering in production
- No context (request ID, user ID) for tracing
- Performance overhead from string concatenation

**The Solution**: Structured JSON logging with Pino:

```javascript
logger.info({
  requestId: 'abc-123',
  userId: 42,
  tweetId: 12345,
  durationMs: 45,
}, 'Tweet created successfully');
```

Output:
```json
{
  "level": 30,
  "time": "2024-01-15T10:30:00.000Z",
  "requestId": "abc-123",
  "userId": 42,
  "tweetId": 12345,
  "durationMs": 45,
  "msg": "Tweet created successfully"
}
```

**Why Pino**:
- **Fastest**: 10x faster than Winston/Bunyan
- **JSON by default**: Machine-readable for ELK, Datadog
- **Pretty print in dev**: Human-readable during development
- **Child loggers**: Attach context once, use everywhere

**Implementation**: See `/Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/twitter/backend/src/shared/logger.js`

### Why Prometheus Metrics for Observability

**The Problem**: Without metrics, you're flying blind:
- Is latency increasing gradually before users notice?
- Are certain endpoints failing more than others?
- Is the fanout queue backing up?

**The Solution**: Export Prometheus metrics on `/metrics`:

```
# HELP twitter_timeline_latency_seconds Home timeline fetch latency
# TYPE twitter_timeline_latency_seconds histogram
twitter_timeline_latency_seconds_bucket{timeline_type="home",cache_hit="true",le="0.1"} 950
twitter_timeline_latency_seconds_bucket{timeline_type="home",cache_hit="false",le="0.1"} 200

# HELP twitter_fanout_queue_depth Current depth of the fanout queue
# TYPE twitter_fanout_queue_depth gauge
twitter_fanout_queue_depth 0

# HELP twitter_circuit_breaker_state Circuit breaker state: 0=closed, 1=half-open, 2=open
# TYPE twitter_circuit_breaker_state gauge
twitter_circuit_breaker_state{circuit_name="redis-fanout"} 0
```

**Key Metrics**:
- **Tweet throughput**: Tweets created per second, error rate
- **Timeline latency**: P50, P95, P99 by timeline type and cache hit
- **Fanout queue depth**: Detect backup before it causes problems
- **Circuit breaker state**: Know when protection is active

**Implementation**: See `/Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/twitter/backend/src/shared/metrics.js`

---

## Future Optimizations

1. **GraphQL** for flexible client queries
2. **Algorithmic timeline** (ML-ranked content)
3. **Geolocation** for local trends
4. **Real-time streaming** via WebSocket
5. **Tweet threading** for conversations
