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

## Future Optimizations

1. **GraphQL** for flexible client queries
2. **Algorithmic timeline** (ML-ranked content)
3. **Geolocation** for local trends
4. **Real-time streaming** via WebSocket
5. **Tweet threading** for conversations
