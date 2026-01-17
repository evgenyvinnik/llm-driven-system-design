# Twitter - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Twitter, a real-time microblogging platform where users post 280-character tweets that appear in their followers' timelines. The core challenge is the 'fanout problem' - when a user tweets, how do we efficiently notify millions of followers? A celebrity with 50 million followers can't wait 83 minutes for their tweet to propagate.

This involves three key technical challenges: implementing a hybrid fanout strategy that handles both normal users and celebrities differently, designing an efficient social graph storage and query system, and building real-time trend detection that identifies emerging topics within minutes."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Tweet**: Post 280-character messages with optional media
- **Follow**: Subscribe to other users' content
- **Timeline**: View chronological/ranked feed of followed users
- **Trending**: See popular topics in real-time
- **Engage**: Like, retweet, reply to tweets

### Non-Functional Requirements
- **Latency**: < 200ms for timeline load
- **Availability**: 99.99% uptime
- **Scale**: 500M users, 500M tweets/day
- **Consistency**: Eventual consistency acceptable (slight delays OK)

### Scale Estimates
- **Daily Active Users**: 200M+
- **Tweets/day**: 500M
- **Timeline reads/day**: 100B+
- **Average followers**: 500 (with huge variance)

### Key Questions I'd Ask
1. What's the threshold for "celebrity" treatment?
2. Should the timeline be purely chronological or algorithmically ranked?
3. What's acceptable delay for a celebrity tweet to appear?

## High-Level Architecture (5 minutes)

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

### Core Components

1. **Tweet Service**: Creates tweets, extracts hashtags, stores media references
2. **Timeline Service**: Builds and caches user timelines
3. **Social Graph**: Manages follow relationships
4. **Fanout Workers**: Push tweets to follower timelines
5. **Trend Service**: Real-time hashtag tracking

## Deep Dive: The Fanout Problem and Hybrid Solution (8 minutes)

This is Twitter's core scaling challenge. When a user tweets, all followers need to see it.

### The Math Problem

```
Celebrity: 50M followers
Fanout rate: 10,000 writes/second
Time to complete: 50,000,000 / 10,000 = 5,000 seconds = 83 minutes
```

This is unacceptable. Users expect tweets to appear within seconds.

### Strategy Comparison

| Strategy | Write Cost | Read Cost | Best For |
|----------|------------|-----------|----------|
| Push (Fanout on Write) | O(followers) | O(1) | Normal users |
| Pull (Fanout on Read) | O(1) | O(following) | Celebrity users |
| Hybrid | Varies | Varies | Mixed audience |

### Hybrid Implementation

**Push for Normal Users (< 10K followers)**:

```javascript
// Fanout worker processes tweet.created events
async function fanoutTweet(tweetId, authorId) {
  const author = await getUser(authorId);

  // Skip fanout for celebrities
  if (author.is_celebrity) {
    return; // Handled at read time
  }

  const followers = await getFollowers(authorId);

  // Write to each follower's timeline cache
  const pipeline = redis.pipeline();
  for (const followerId of followers) {
    pipeline.lpush(`timeline:${followerId}`, tweetId);
    pipeline.ltrim(`timeline:${followerId}`, 0, 799); // Keep last 800
  }
  await pipeline.exec();
}
```

**Timeline Read (Merge cached + celebrity)**:

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

  // 4. Merge and sort
  const allTweets = [...cachedTweets, ...celebrityTweets.rows];
  allTweets.sort((a, b) => b.createdAt - a.createdAt);

  return allTweets.slice(0, 100);
}
```

### Celebrity Detection

```sql
-- Trigger to flag celebrities when they reach 10K followers
CREATE OR REPLACE FUNCTION update_celebrity_status()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE users
  SET is_celebrity = (follower_count >= 10000)
  WHERE id = NEW.following_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Why This Works

- **Normal users**: Fanout of 500 followers = 500 writes (fast)
- **Celebrities**: No fanout, ~100 celebrity pulls at read time
- **Merge is cheap**: ~100 extra tweets to sort in memory

## Deep Dive: Social Graph Storage (6 minutes)

### Storage Design

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

**Redis for Fast Lookups**:

```javascript
// followers:{userId} = SET of user IDs who follow this user
// following:{userId} = SET of user IDs this user follows

await redis.sadd(`followers:${userId}`, followerId);
await redis.sadd(`following:${followerId}`, userId);
```

### Why Both PostgreSQL and Redis?

| Concern | PostgreSQL | Redis |
|---------|------------|-------|
| Durability | ACID guaranteed | Persistence optional |
| Query flexibility | Complex queries | Set operations |
| Latency | 5-50ms | < 1ms |
| Scale | Sharding complex | Memory bound |

PostgreSQL is source of truth; Redis is cache for hot path queries.

### Follower Queries

```javascript
// Check if A follows B
async function isFollowing(userA, userB) {
  // Check cache first
  const cached = await redis.sismember(`following:${userA}`, userB);
  if (cached !== null) return cached === 1;

  // Fall back to database
  const result = await db.query(
    'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
    [userA, userB]
  );
  return result.rows.length > 0;
}
```

## Deep Dive: Real-Time Trend Detection (5 minutes)

### Sliding Window Counting

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

  for (let i = 0; i < WINDOW_SIZE; i++) {
    const bucket = now - i;
    const count = await redis.get(`trend:${hashtag}:${bucket}`) || 0;
    // Recent buckets weighted more heavily (exponential decay)
    score += parseInt(count) * Math.pow(0.95, i);
  }

  return score;
}
```

### Trend Velocity

```javascript
function calculateVelocity(currentHourCount, previousHourCount) {
  if (previousHourCount === 0) {
    return currentHourCount > 10 ? Infinity : 0;
  }
  return (currentHourCount - previousHourCount) / previousHourCount;
}

// Topics with velocity > 2 (200% growth) are "trending"
```

### Trend Detection Pipeline

1. **Extract**: Parse hashtags from incoming tweets
2. **Count**: Increment time-bucketed counters in Redis
3. **Score**: Calculate weighted score every minute
4. **Rank**: Maintain sorted set of top trends
5. **Filter**: Remove offensive/spam hashtags

## Trade-offs and Alternatives (5 minutes)

### 1. Hybrid vs. Pure Push Fanout

**Chose: Hybrid (push for normal, pull for celebrities)**
- Pro: Handles celebrity problem
- Pro: Reasonable latency for all users
- Con: More complex read path
- Alternative: Pure push (simpler, doesn't scale)

### 2. Timeline Storage

**Chose: Redis lists**
- Pro: O(1) push, O(k) retrieval
- Pro: Automatic trimming (LTRIM)
- Con: Memory cost
- Alternative: PostgreSQL only (slower, but simpler)

### 3. Event Streaming

**Chose: Kafka for tweet events**
- Pro: Decouples services
- Pro: Enables replay for debugging
- Pro: Async processing
- Con: Operational complexity
- Alternative: Direct service calls (simpler, tighter coupling)

### 4. Graph Storage

**Chose: PostgreSQL + Redis cache**
- Pro: Familiar technology
- Pro: 1-hop queries efficient
- Con: Multi-hop queries expensive
- Alternative: Graph DB (Neo4j) - overkill for our patterns

### 5. Trend Detection

**Chose: Sliding window with decay**
- Pro: Catches emerging trends quickly
- Pro: Handles burst patterns
- Con: Memory for many hashtags
- Alternative: Fixed window (simpler, less responsive)

### Sharding Strategy

```
Tweets: Shard by tweet_id (auto-increment/snowflake)
Users: Shard by user_id
Timeline: Shard by user_id (timeline belongs to user)
Follows: Shard by follower_id (queries are "who do I follow")
```

### The Celebrity Threshold

```javascript
// Why 10K followers?
// Below 10K: Fanout < 1 second (acceptable)
// Above 10K: Fanout grows linearly, becomes problematic

// Could be tiered:
// 10K-1M: Partial push (active followers only)
// 1M+: Pure pull (no fanout at all)
```

## Database Schema

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100),
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tweets (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id),
  content VARCHAR(280) NOT NULL,
  media_urls TEXT[],
  hashtags TEXT[],
  mentions INTEGER[],
  reply_to BIGINT REFERENCES tweets(id),
  retweet_of BIGINT REFERENCES tweets(id),
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tweets_author ON tweets(author_id, created_at DESC);
CREATE INDEX idx_tweets_hashtags ON tweets USING GIN(hashtags);

CREATE TABLE follows (
  follower_id INTEGER REFERENCES users(id),
  following_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE likes (
  user_id INTEGER REFERENCES users(id),
  tweet_id BIGINT REFERENCES tweets(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, tweet_id)
);
```

## Closing Summary (1 minute)

"Twitter's architecture solves the fanout problem through three key design decisions:

1. **Hybrid fanout strategy** - Normal users (< 10K followers) get push fanout where their tweets are written to followers' timeline caches immediately. Celebrities are excluded from fanout; their tweets are pulled at timeline read time and merged. This bounds write amplification while maintaining low read latency.

2. **Kafka event streaming** - All mutations publish events, enabling asynchronous processing by fanout workers, trend calculators, and notification services. This decouples services and allows replay for debugging.

3. **Sliding window trend detection** - Hashtags are counted in time-bucketed Redis keys with exponential decay weighting, allowing us to identify emerging trends within minutes rather than hours.

The main trade-off is complexity vs. scale. We chose the hybrid fanout model because pure push doesn't work for celebrities. Future improvements would include an algorithmic timeline (ML-ranked rather than chronological) and WebSocket-based real-time updates for new tweets."
