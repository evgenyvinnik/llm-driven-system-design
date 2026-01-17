# Reddit - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Reddit, a community-driven content platform where users submit posts, vote on content, and engage in threaded discussions. The core challenge is building a voting system that scales under high contention, efficiently storing and retrieving nested comment trees, and implementing ranking algorithms that surface quality content.

This involves three key technical challenges: designing vote aggregation that avoids database locks on popular posts, implementing materialized paths for efficient nested comment queries, and building ranking algorithms like 'hot' and 'controversial' that can be precomputed efficiently."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Subreddits**: Create communities with custom rules
- **Posts**: Submit text, link, or media posts
- **Comments**: Nested threaded discussions
- **Voting**: Upvote/downvote posts and comments
- **Ranking**: Sort by hot, new, top, controversial
- **Moderation**: Remove content, ban users

### Non-Functional Requirements
- **Availability**: 99.9% uptime
- **Latency**: < 100ms for feed loading
- **Scale**: Millions of posts, billions of votes
- **Consistency**: Eventual consistency acceptable for vote counts

### Scale Estimates
- **Daily Active Users**: 50M+
- **Posts/day**: 1M+
- **Comments/day**: 10M+
- **Votes/day**: 100M+

### Key Questions I'd Ask
1. How stale can vote counts be? (5 seconds? 30 seconds?)
2. What's the maximum comment thread depth to support?
3. Should we support nested subreddits (like r/sports/football)?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│                    React + Tanstack Router                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway                              │
│                    Node.js + Express                            │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Post Service │    │ Vote Service  │    │Comment Service│
│               │    │               │    │               │
│ - CRUD posts  │    │ - Cast votes  │    │ - Tree mgmt   │
│ - Ranking     │    │ - Aggregation │    │ - Threading   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────────┬───────────────────────────────────────────┤
│    PostgreSQL       │              Valkey/Redis                 │
│  - Users, posts     │  - Vote counts (cached)                   │
│  - Comments, votes  │  - Hot scores (precomputed)               │
│  - Subreddits       │  - Session storage                        │
└─────────────────────┴───────────────────────────────────────────┘
```

### Core Components

1. **Post Service**: CRUD operations, ranking score calculation
2. **Vote Service**: Handles vote casting, aggregation
3. **Comment Service**: Nested comment tree management
4. **Background Workers**: Vote aggregation, hot score computation

## Deep Dive: Voting System (8 minutes)

The voting system is Reddit's core feature and presents interesting scaling challenges.

### The Contention Problem

Naive approach:
```sql
UPDATE posts SET score = score + 1 WHERE id = ?
```

**Problem**: Row-level locks under high contention. A viral post could receive 1000 votes/second.

### Solution: Vote Table + Async Aggregation

```sql
-- Store individual votes (no contention)
CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  comment_id INTEGER REFERENCES comments(id),
  direction SMALLINT NOT NULL,  -- 1 = up, -1 = down
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, post_id),
  UNIQUE(user_id, comment_id)
);
```

**Vote Casting**:
```javascript
async function castVote(userId, postId, direction) {
  // Upsert vote (handles vote changes)
  await db.query(`
    INSERT INTO votes (user_id, post_id, direction)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, post_id)
    DO UPDATE SET direction = $3, created_at = NOW()
  `, [userId, postId, direction]);

  // Optimistic update in cache for instant feedback
  await redis.hincrby(`post:${postId}:votes`,
    direction > 0 ? 'up' : 'down', 1);
}
```

**Background Aggregation**:
```javascript
// Runs every 5-30 seconds
async function aggregateVotes() {
  const posts = await db.query(`
    SELECT post_id,
           SUM(CASE WHEN direction = 1 THEN 1 ELSE 0 END) as upvotes,
           SUM(CASE WHEN direction = -1 THEN 1 ELSE 0 END) as downvotes
    FROM votes
    WHERE post_id IN (
      SELECT DISTINCT post_id FROM votes
      WHERE created_at > NOW() - INTERVAL '1 minute'
    )
    GROUP BY post_id
  `);

  for (const post of posts.rows) {
    await db.query(`
      UPDATE posts
      SET upvotes = $1, downvotes = $2, score = $1 - $2
      WHERE id = $3
    `, [post.upvotes, post.downvotes, post.post_id]);
  }
}
```

### Why This Approach?

| Approach | Pros | Cons |
|----------|------|------|
| Direct UPDATE | Simple, real-time | Row locks, contention |
| Vote table + async | No contention, auditable | Slight delay |
| Redis INCR only | Fast, real-time | Memory cost, no persistence |

We get the best of both worlds: no contention + cached real-time display.

## Deep Dive: Nested Comments with Materialized Path (7 minutes)

Reddit's comment threads can be deeply nested. Efficiently storing and querying tree structures is critical.

### Tree Storage Approaches

| Method | Query Complexity | Insert Complexity | Move Complexity |
|--------|------------------|-------------------|-----------------|
| Adjacency List | O(n) recursive | O(1) | O(1) |
| Materialized Path | O(1) | O(1) | O(subtree) |
| Nested Sets | O(1) | O(n) | O(n) |
| Closure Table | O(1) | O(depth) | O(subtree) |

### Materialized Path Implementation

```sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id),
  author_id INTEGER REFERENCES users(id),
  parent_id INTEGER REFERENCES comments(id),
  path VARCHAR(255) NOT NULL,  -- "1.5.23.102"
  depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_path ON comments(path varchar_pattern_ops);
CREATE INDEX idx_comments_post ON comments(post_id);
```

**Creating a Comment**:
```javascript
async function createComment(postId, parentId, authorId, content) {
  let path, depth;

  if (parentId) {
    const parent = await db.query(
      'SELECT path, depth FROM comments WHERE id = $1',
      [parentId]
    );
    path = `${parent.path}.${Date.now()}`; // Unique path segment
    depth = parent.depth + 1;
  } else {
    path = Date.now().toString();
    depth = 0;
  }

  return db.query(`
    INSERT INTO comments (post_id, parent_id, author_id, path, depth, content)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [postId, parentId, authorId, path, depth, content]);
}
```

**Fetching Comment Tree**:
```sql
-- Get all comments for a post, ordered as tree
SELECT * FROM comments
WHERE post_id = $1
ORDER BY path;

-- Get all replies to comment 5 (with path "1.5")
SELECT * FROM comments
WHERE path LIKE '1.5.%'
ORDER BY path;
```

### Why Materialized Path?

- **Single query** to fetch entire subtree
- **Natural sort order** when ordering by path
- **Depth included** for indentation display
- **Trade-off**: Moving comments (rare) requires updating subtree paths

## Deep Dive: Ranking Algorithms (5 minutes)

Different ranking algorithms create different user experiences.

### Hot Algorithm

Reddit's classic hot algorithm balances recency with popularity:

```javascript
function hotScore(ups, downs, createdAt) {
  const score = ups - downs;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;

  // Reddit epoch: December 8, 2005
  const epochSeconds = 1134028003;
  const seconds = Math.floor(createdAt.getTime() / 1000) - epochSeconds;

  // 45000 seconds ≈ 12.5 hours
  return sign * order + seconds / 45000;
}
```

**Key insight**: An older post needs exponentially more votes to compete with a newer post. A 12-hour-old post with 10 upvotes has the same hot score as a new post with 1 upvote.

### Controversial Algorithm

High engagement, balanced votes:

```javascript
function controversialScore(ups, downs) {
  if (ups <= 0 || downs <= 0) return 0;

  const magnitude = ups + downs;
  const balance = Math.min(ups, downs) / Math.max(ups, downs);

  return magnitude * balance;
}
```

A post with 100 up / 100 down scores higher than 1000 up / 10 down.

### Precomputation Strategy

```javascript
// Background job runs every 5 minutes
async function computeHotScores() {
  const recentPosts = await db.query(`
    SELECT id, upvotes, downvotes, created_at
    FROM posts
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);

  for (const post of recentPosts.rows) {
    const score = hotScore(post.upvotes, post.downvotes, post.created_at);

    // Store in Redis sorted set for fast retrieval
    await redis.zadd(
      `subreddit:${post.subreddit_id}:hot`,
      score,
      post.id
    );
  }
}

// Getting hot posts is O(log N)
async function getHotPosts(subredditId, limit) {
  return redis.zrevrange(
    `subreddit:${subredditId}:hot`,
    0,
    limit - 1
  );
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Eventual Consistency for Votes

**Chose: 5-30 second delay acceptable**
- Pro: No database contention
- Pro: Enables horizontal scaling
- Con: Users might see stale counts
- Trade-off: Display cached value, actual value catches up

### 2. Tree Storage

**Chose: Materialized path**
- Pro: Single query for subtree
- Pro: Natural ordering
- Con: Path updates on moves
- Alternative: Closure table (faster for deep traversals, more storage)

### 3. Hot Score Precomputation

**Chose: Precompute every 5 minutes**
- Pro: O(1) reads from Redis
- Pro: Complex calculations done once
- Con: Not real-time
- Trade-off: Hot ranking doesn't need second-level precision

### 4. Database Choice

**Chose: PostgreSQL**
- Pro: ACID, relational model fits well
- Pro: JSONB for flexible metadata
- Con: Scaling requires sharding
- Alternative: Cassandra (easier sharding, eventual consistency)

### 5. Karma Calculation

**Chose: Aggregated from votes**
- User karma = sum of scores on their posts/comments
- Updated in background to avoid contention

### Sharding Considerations (At Scale)

```
Strategy: Shard by subreddit_id

Benefits:
- Each subreddit is independent
- Hot posts query stays within shard
- Natural isolation

Challenges:
- User profiles span shards
- Cross-subreddit queries require scatter-gather
```

## Database Schema

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  karma_post INTEGER DEFAULT 0,
  karma_comment INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subreddits (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  subscriber_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  subreddit_id INTEGER REFERENCES subreddits(id),
  author_id INTEGER REFERENCES users(id),
  title VARCHAR(300) NOT NULL,
  content TEXT,
  url VARCHAR(2048),
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  hot_score DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_posts_hot ON posts(subreddit_id, hot_score DESC);
CREATE INDEX idx_posts_new ON posts(subreddit_id, created_at DESC);
CREATE INDEX idx_posts_top ON posts(subreddit_id, score DESC);
```

## Closing Summary (1 minute)

"Reddit's architecture centers on three key design decisions:

1. **Async vote aggregation** - Individual votes insert without contention, background workers aggregate scores every 5-30 seconds. This trades real-time accuracy for scalability under high load.

2. **Materialized path for comments** - Storing the full ancestry path (e.g., '1.5.23') enables single-query subtree fetches and natural sorting, critical for Reddit's deep discussion threads.

3. **Precomputed ranking scores** - Hot, top, and controversial scores are calculated in background jobs and stored in Redis sorted sets, making feed retrieval O(log N).

The main trade-off is freshness vs. performance. We accept eventually consistent vote counts and ranking scores because the user experience doesn't require real-time precision for these values. Future improvements would include Bloom filters for vote deduplication at scale and event sourcing for complete vote history."
