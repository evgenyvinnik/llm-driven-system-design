# Twitter - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Tweet**: Post 280-character messages with media references
- **Follow**: Subscribe to other users' content
- **Timeline**: View chronological/ranked feed of followed users
- **Trending**: Real-time popular topics detection
- **Engagement**: Like, retweet, reply to tweets

### Non-Functional Requirements
- **Latency**: < 200ms for timeline load
- **Availability**: 99.99% uptime (less than 52 minutes downtime/year)
- **Scale**: 500M users, 500M tweets/day, 100B+ timeline reads/day
- **Consistency**: Eventual consistency acceptable (slight delays OK)

### Scale Estimates
- **Daily Active Users**: 200M+
- **Tweets/second**: ~6,000 average, 150K+ during peaks
- **Average followers per user**: 500 (with extreme variance)
- **Celebrity problem**: Users with 50M+ followers

---

## 2. High-Level Architecture (5 minutes)

```
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
│   PostgreSQL    │    Redis/Valkey                               │
│   - Users       │    - Timeline cache (lists)                   │
│   - Tweets      │    - Social graph cache (sets)                │
│   - Follows     │    - Trend counters                           │
└─────────────────┴───────────────────────────────────────────────┘
```

### Core Services

| Service | Responsibility |
|---------|---------------|
| Tweet Service | Create/retrieve tweets, extract hashtags, validate content |
| Timeline Service | Build/cache user timelines, merge celebrity tweets |
| Social Graph | Manage follow relationships, check permissions |
| Fanout Workers | Push tweets to follower timeline caches |
| Trend Service | Track hashtag velocity, calculate trending topics |

---

## 3. The Fanout Problem and Hybrid Solution (10 minutes)

This is Twitter's defining backend challenge: When a user tweets, all followers must see it.

### The Math Problem

```
Celebrity: 50M followers
Fanout rate: 10,000 writes/second
Time to complete: 50,000,000 / 10,000 = 5,000 seconds = 83 minutes
```

Unacceptable. Users expect tweets in seconds.

### Strategy Comparison

| Strategy | Write Cost | Read Cost | Best For |
|----------|------------|-----------|----------|
| Push (Fanout on Write) | O(followers) | O(1) | Normal users |
| Pull (Fanout on Read) | O(1) | O(following) | Celebrity users |
| Hybrid | Varies | Varies | Mixed audience |

### Hybrid Fanout Implementation

**Push for Normal Users (< 10K followers)**:

```javascript
// Fanout worker processes tweet.created events from Kafka
async function fanoutTweet(tweetId, authorId) {
  const author = await getUser(authorId);

  // Skip fanout for celebrities - handled at read time
  if (author.is_celebrity) {
    return;
  }

  const followers = await getFollowers(authorId);

  // Pipeline for atomic batch writes
  const pipeline = redis.pipeline();
  for (const followerId of followers) {
    pipeline.lpush(`timeline:${followerId}`, tweetId);
    pipeline.ltrim(`timeline:${followerId}`, 0, 799); // Keep last 800
  }

  await pipeline.exec();
}
```

**Timeline Read (Merge cached + celebrity tweets)**:

```javascript
async function getHomeTimeline(userId) {
  // 1. Get cached timeline (pushed tweets from normal users)
  const cachedIds = await redis.lrange(`timeline:${userId}`, 0, 100);
  const cachedTweets = await getTweetsByIds(cachedIds);

  // 2. Get followed celebrities
  const following = await getFollowing(userId);
  const celebrities = following.filter(u => u.is_celebrity);

  // 3. Pull recent tweets from celebrities (not fanned out)
  const celebrityTweets = await db.query(`
    SELECT * FROM tweets
    WHERE author_id = ANY($1)
    AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 50
  `, [celebrities.map(c => c.id)]);

  // 4. Merge and sort chronologically
  const allTweets = [...cachedTweets, ...celebrityTweets.rows];
  allTweets.sort((a, b) => b.createdAt - a.createdAt);

  return allTweets.slice(0, 100);
}
```

### Celebrity Detection via Triggers

```sql
-- Automatically flag celebrities when they reach threshold
CREATE OR REPLACE FUNCTION update_celebrity_status()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE users
  SET is_celebrity = (follower_count >= 10000)
  WHERE id = NEW.following_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_celebrity_check
  AFTER INSERT OR DELETE ON follows
  FOR EACH ROW EXECUTE FUNCTION update_celebrity_status();
```

### Why This Works

- **Normal users**: 500 followers = 500 Redis writes (< 1 second)
- **Celebrities**: 0 fanout writes, ~100 DB queries merged at read time
- **Read latency**: Merge is in-memory, adds ~10ms

---

## 4. Database Schema and Indexing (8 minutes)

### Core Tables

```sql
-- Users with denormalized counts and celebrity flag
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  bio TEXT,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE,  -- Auto-set via trigger at 10K followers
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tweets with relationship references
CREATE TABLE tweets (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content VARCHAR(280) NOT NULL,
  media_urls TEXT[],
  hashtags TEXT[],           -- Extracted at write time
  mentions INTEGER[],        -- User IDs mentioned
  reply_to BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  retweet_of BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Social graph: follow relationships
CREATE TABLE follows (
  follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

-- Engagement tables
CREATE TABLE likes (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);

CREATE TABLE retweets (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);
```

### Index Strategy

```sql
-- Author timeline: user's own tweets
CREATE INDEX idx_tweets_author ON tweets(author_id, created_at DESC);

-- Hashtag search: GIN index for array contains
CREATE INDEX idx_tweets_hashtags ON tweets USING GIN(hashtags);

-- Global chronological: for explore/trending
CREATE INDEX idx_tweets_created_at ON tweets(created_at DESC);

-- Soft delete filtering
CREATE INDEX idx_tweets_deleted ON tweets(deleted_at) WHERE deleted_at IS NOT NULL;

-- Social graph: bidirectional lookups
CREATE INDEX idx_follows_following ON follows(following_id);
CREATE INDEX idx_follows_follower ON follows(follower_id);

-- Engagement lookups
CREATE INDEX idx_likes_tweet ON likes(tweet_id);
CREATE INDEX idx_likes_user ON likes(user_id);
```

### Denormalized Count Triggers

```sql
-- Maintain follower/following counts atomically
CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
    UPDATE users SET follower_count = follower_count + 1 WHERE id = NEW.following_id;
    -- Check celebrity threshold
    UPDATE users SET is_celebrity = (follower_count >= 10000) WHERE id = NEW.following_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users SET following_count = following_count - 1 WHERE id = OLD.follower_id;
    UPDATE users SET follower_count = follower_count - 1 WHERE id = OLD.following_id;
    UPDATE users SET is_celebrity = (follower_count >= 10000) WHERE id = OLD.following_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_follow_counts
  AFTER INSERT OR DELETE ON follows
  FOR EACH ROW EXECUTE FUNCTION update_follow_counts();
```

---

## 5. Redis Caching Strategy (5 minutes)

### Data Structures

| Key Pattern | Type | Purpose | TTL |
|-------------|------|---------|-----|
| `timeline:{userId}` | List | Pre-computed home timeline | 7 days |
| `followers:{userId}` | Set | Fast follower lookups | None (synced) |
| `following:{userId}` | Set | Fast following lookups | None (synced) |
| `trend:{hashtag}:{bucket}` | String | Time-bucketed hashtag counts | 2 hours |
| `session:{sessionId}` | Hash | User session data | 7 days |
| `idempotency:tweet:{userId}:{key}` | String | Prevent duplicate tweets | 24 hours |

### Social Graph Cache

```javascript
// Sync follows to Redis on write
async function followUser(followerId, followingId) {
  // 1. Write to PostgreSQL
  await db.query(
    'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)',
    [followerId, followingId]
  );

  // 2. Update Redis sets (for fast lookups)
  await redis.sadd(`followers:${followingId}`, followerId);
  await redis.sadd(`following:${followerId}`, followingId);
}

// Fast check without DB hit
async function isFollowing(userA, userB) {
  const cached = await redis.sismember(`following:${userA}`, userB);
  if (cached !== null) return cached === 1;

  // Fallback to database
  const result = await db.query(
    'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
    [userA, userB]
  );
  return result.rows.length > 0;
}
```

### Timeline Cache Management

```javascript
// On tweet creation, fanout to follower timelines
async function pushToTimelines(tweetId, authorId) {
  const followers = await redis.smembers(`followers:${authorId}`);

  const pipeline = redis.pipeline();
  for (const followerId of followers) {
    pipeline.lpush(`timeline:${followerId}`, tweetId);
    pipeline.ltrim(`timeline:${followerId}`, 0, 799);
    pipeline.expire(`timeline:${followerId}`, 7 * 24 * 60 * 60);
  }

  await pipeline.exec();
}

// Cache miss: rebuild timeline from database
async function rebuildTimelineCache(userId) {
  const following = await db.query(`
    SELECT f.following_id, u.is_celebrity
    FROM follows f
    JOIN users u ON f.following_id = u.id
    WHERE f.follower_id = $1 AND u.is_celebrity = FALSE
  `, [userId]);

  const followingIds = following.rows.map(r => r.following_id);
  const tweets = await db.query(`
    SELECT id FROM tweets
    WHERE author_id = ANY($1)
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 800
  `, [followingIds]);

  const tweetIds = tweets.rows.map(t => t.id);
  if (tweetIds.length > 0) {
    await redis.del(`timeline:${userId}`);
    await redis.rpush(`timeline:${userId}`, ...tweetIds);
    await redis.expire(`timeline:${userId}`, 7 * 24 * 60 * 60);
  }
}
```

---

## 6. Real-Time Trend Detection (5 minutes)

### Sliding Window Algorithm

```javascript
// Track hashtag counts in time buckets
const BUCKET_SIZE = 60;  // 1 minute
const WINDOW_SIZE = 60;  // 60 minutes

async function recordHashtag(hashtag) {
  const bucket = Math.floor(Date.now() / 1000 / BUCKET_SIZE);
  const key = `trend:${hashtag}:${bucket}`;

  await redis.incr(key);
  await redis.expire(key, WINDOW_SIZE * BUCKET_SIZE);
}

async function getTrendScore(hashtag) {
  const now = Math.floor(Date.now() / 1000 / BUCKET_SIZE);
  let score = 0;

  const pipeline = redis.pipeline();
  for (let i = 0; i < WINDOW_SIZE; i++) {
    const bucket = now - i;
    pipeline.get(`trend:${hashtag}:${bucket}`);
  }

  const results = await pipeline.exec();

  for (let i = 0; i < results.length; i++) {
    const count = parseInt(results[i][1] || 0);
    // Exponential decay: recent buckets weighted more
    score += count * Math.pow(0.95, i);
  }

  return score;
}
```

### Velocity Calculation

```javascript
function calculateVelocity(currentHourCount, previousHourCount) {
  if (previousHourCount === 0) {
    return currentHourCount > 10 ? Infinity : 0;
  }
  return (currentHourCount - previousHourCount) / previousHourCount;
}

// Topics with velocity > 2 (200% growth) are "trending"
async function getTrendingHashtags(limit = 10) {
  // Get all active hashtags from recent tweets
  const recentHashtags = await db.query(`
    SELECT DISTINCT unnest(hashtags) as hashtag
    FROM tweets
    WHERE created_at > NOW() - INTERVAL '2 hours'
  `);

  const scored = await Promise.all(
    recentHashtags.rows.map(async ({ hashtag }) => ({
      hashtag,
      score: await getTrendScore(hashtag),
    }))
  );

  return scored
    .filter(t => t.score > 100)  // Minimum threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

---

## 7. Failure Handling and Resilience (5 minutes)

### Idempotency Keys for Tweet Creation

```javascript
async function createTweet(req, res) {
  const idempotencyKey = req.headers['idempotency-key'];
  const cacheKey = `idempotency:tweet:${req.user.id}:${idempotencyKey}`;

  // Check if already processed
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // Process the request
  const tweet = await db.query(
    'INSERT INTO tweets (author_id, content, hashtags) VALUES ($1, $2, $3) RETURNING *',
    [req.user.id, req.body.content, extractHashtags(req.body.content)]
  );

  // Cache result for 24 hours
  await redis.setex(cacheKey, 86400, JSON.stringify(tweet.rows[0]));

  // Publish to Kafka for async fanout
  await kafka.send('tweet.created', {
    tweetId: tweet.rows[0].id,
    authorId: req.user.id,
  });

  return res.json(tweet.rows[0]);
}
```

### Circuit Breaker for Fanout

```javascript
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailureTime = null;
  }

  async call(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

// Usage
const fanoutCircuit = new CircuitBreaker('fanout-service');

async function fanoutWithProtection(tweetId, authorId) {
  return fanoutCircuit.call(() => fanoutTweet(tweetId, authorId));
}
```

### Graceful Degradation

```javascript
async function getHomeTimeline(userId) {
  try {
    // Primary: Redis timeline cache
    return await getTimelineFromRedis(userId);
  } catch (redisError) {
    console.warn('Redis unavailable, falling back to PostgreSQL', redisError);

    // Fallback: Direct database query (slower but works)
    return await getTimelineFromDatabase(userId);
  }
}

async function getTimelineFromDatabase(userId) {
  const following = await db.query(
    'SELECT following_id FROM follows WHERE follower_id = $1',
    [userId]
  );

  const followingIds = following.rows.map(r => r.following_id);

  return db.query(`
    SELECT * FROM tweets
    WHERE author_id = ANY($1)
    AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 100
  `, [followingIds]);
}
```

---

## 8. Summary (3 minutes)

### Key Backend Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Fanout Strategy | Hybrid push/pull | Solves celebrity problem |
| Timeline Storage | Redis Lists | O(1) push, O(k) retrieval |
| Graph Storage | PostgreSQL + Redis Sets | Familiar tech, fast lookups |
| Event Streaming | Kafka | Decouples services, enables replay |
| Count Maintenance | PostgreSQL triggers | Atomic, consistent |

### Sharding Strategy

```
Tweets: Shard by tweet_id (snowflake IDs for ordering)
Users: Shard by user_id
Timeline: Shard by user_id (timeline belongs to user)
Follows: Shard by follower_id (queries are "who do I follow")
```

### Performance Characteristics

| Operation | Latency | Notes |
|-----------|---------|-------|
| Tweet creation | < 50ms | Async fanout via Kafka |
| Home timeline | < 100ms | Cache hit, merge ~100 tweets |
| Home timeline (cold) | < 500ms | Cache miss, rebuild + merge |
| Follow/Unfollow | < 50ms | Triggers update counts atomically |
| Trending | < 100ms | Pre-computed in Redis |

### What Would Be Different at Scale

1. **Snowflake IDs**: Distributed ID generation for tweet ordering
2. **Kafka partitioning**: Partition by author_id for ordered fanout
3. **Tiered fanout**: Partial push for influencers (10K-1M), pure pull for mega-celebrities
4. **Algorithmic timeline**: ML ranking instead of pure chronological
5. **Global sharding**: Consistent hashing across regions
