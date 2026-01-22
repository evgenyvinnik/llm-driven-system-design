# Reddit - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing Reddit, a community-driven content platform where users submit posts, vote on content, and engage in threaded discussions. As a backend engineer, I'll focus on the voting system that scales under high contention, materialized path implementation for nested comments, ranking algorithms with precomputation, and background workers for eventual consistency. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Subreddits** - Create communities with custom rules
2. **Posts** - Submit text, link, or media posts
3. **Comments** - Nested threaded discussions with arbitrary depth
4. **Voting** - Upvote/downvote posts and comments
5. **Ranking** - Sort by hot, new, top, controversial
6. **Moderation** - Remove content, ban users

### Non-Functional Requirements

- **Availability** - 99.9% uptime
- **Latency** - < 100ms for feed loading
- **Scale** - Millions of posts, billions of votes
- **Consistency** - Eventual consistency acceptable for vote counts (5-30s delay)

### Backend-Specific Considerations

- Atomic vote operations to prevent double-voting
- Background aggregation to eliminate database contention
- Efficient tree queries for nested comments
- Precomputed ranking scores stored in sorted sets

---

## 2. High-Level Architecture (5 minutes)

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
│   - POST /subreddits, /posts, /comments                         │
│   - POST /vote                                                  │
│   - GET /r/:subreddit/hot, /new, /top                          │
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
│  - Comments, votes  │  - Hot scores (sorted sets)               │
│  - Subreddits       │  - Session storage                        │
└─────────────────────┴───────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Background       │
                    │  Workers          │
                    │  - Vote aggregator│
                    │  - Ranking calc   │
                    │  - Archiver       │
                    └───────────────────┘
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| Vote Service | Vote casting with deduplication | Express + PostgreSQL |
| Aggregation Worker | Batch vote count updates | Background job |
| Ranking Worker | Precompute hot/controversial scores | Cron + Redis |
| Comment Service | Materialized path tree operations | PostgreSQL LIKE queries |

---

## 3. Deep Dive: Voting System (10 minutes)

### The Contention Problem

Naive approach:
```sql
UPDATE posts SET score = score + 1 WHERE id = ?
```

**Problem**: Row-level locks under high contention. A viral post could receive 1000 votes/second, causing lock waits and timeouts.

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

-- XOR constraint: exactly one target
ALTER TABLE votes ADD CONSTRAINT vote_target CHECK (
  (post_id IS NOT NULL AND comment_id IS NULL) OR
  (post_id IS NULL AND comment_id IS NOT NULL)
);
```

### Vote Casting Implementation

```typescript
async function castVote(
  userId: number,
  targetType: 'post' | 'comment',
  targetId: number,
  direction: 1 | -1 | 0
): Promise<VoteResult> {
  const column = targetType === 'post' ? 'post_id' : 'comment_id';

  if (direction === 0) {
    // Remove vote
    await pool.query(
      `DELETE FROM votes WHERE user_id = $1 AND ${column} = $2`,
      [userId, targetId]
    );
  } else {
    // Upsert vote (handles vote changes)
    await pool.query(`
      INSERT INTO votes (user_id, ${column}, direction)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, ${column})
      DO UPDATE SET direction = $3, created_at = NOW()
    `, [userId, targetId, direction]);
  }

  // Optimistic update in cache for instant UI feedback
  const cacheKey = `${targetType}:${targetId}:votes`;
  await redis.hincrby(cacheKey, direction > 0 ? 'up' : 'down', 1);

  return { success: true, direction };
}
```

### Background Aggregation Worker

```typescript
// Runs every 5-30 seconds
async function aggregateVotes(): Promise<void> {
  // Find posts with recent votes
  const recentlyVoted = await pool.query(`
    SELECT DISTINCT post_id FROM votes
    WHERE post_id IS NOT NULL
      AND created_at > NOW() - INTERVAL '1 minute'
  `);

  for (const { post_id } of recentlyVoted.rows) {
    // Aggregate all votes for this post
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction = 1) as upvotes,
        COUNT(*) FILTER (WHERE direction = -1) as downvotes
      FROM votes
      WHERE post_id = $1
    `, [post_id]);

    const { upvotes, downvotes } = result.rows[0];
    const score = upvotes - downvotes;

    // Update denormalized counts
    await pool.query(`
      UPDATE posts
      SET upvotes = $1, downvotes = $2, score = $3
      WHERE id = $4
    `, [upvotes, downvotes, score, post_id]);

    // Update cache
    await redis.hmset(`post:${post_id}:votes`, {
      up: upvotes,
      down: downvotes,
      score: score
    });
  }
}
```

### Why This Approach?

| Approach | Pros | Cons |
|----------|------|------|
| Direct UPDATE | Simple, real-time | Row locks, contention |
| Vote table + async | No contention, auditable | 5-30s delay |
| Redis INCR only | Fast, real-time | Memory cost, no persistence |

We get the best of both worlds: no contention + cached real-time display.

---

## 4. Deep Dive: Nested Comments with Materialized Path (8 minutes)

### Tree Storage Approaches

| Method | Query Complexity | Insert Complexity | Move Complexity |
|--------|------------------|-------------------|-----------------|
| Adjacency List | O(n) recursive | O(1) | O(1) |
| Materialized Path | O(1) | O(1) | O(subtree) |
| Nested Sets | O(1) | O(n) | O(n) |
| Closure Table | O(1) | O(depth) | O(subtree) |

### Materialized Path Schema

```sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  path VARCHAR(255) NOT NULL,  -- "1.5.23.102"
  depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Critical index for subtree queries
CREATE INDEX idx_comments_path ON comments(path varchar_pattern_ops);
CREATE INDEX idx_comments_post ON comments(post_id);
```

### Creating a Comment

```typescript
async function createComment(
  postId: number,
  parentId: number | null,
  authorId: number,
  content: string
): Promise<Comment> {
  let path: string;
  let depth: number;

  if (parentId) {
    const parent = await pool.query(
      'SELECT path, depth FROM comments WHERE id = $1',
      [parentId]
    );

    if (parent.rows.length === 0) {
      throw new Error('Parent comment not found');
    }

    // Generate unique path segment (using timestamp for uniqueness)
    const segment = Date.now().toString(36);
    path = `${parent.rows[0].path}.${segment}`;
    depth = parent.rows[0].depth + 1;
  } else {
    // Top-level comment
    path = Date.now().toString(36);
    depth = 0;
  }

  const result = await pool.query(`
    INSERT INTO comments (post_id, parent_id, author_id, path, depth, content)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [postId, parentId, authorId, path, depth, content]);

  // Increment comment count on post
  await pool.query(
    'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
    [postId]
  );

  return result.rows[0];
}
```

### Fetching Comment Trees

```typescript
// Get all comments for a post in tree order
async function getCommentTree(
  postId: number,
  sortBy: 'best' | 'top' | 'new' = 'best'
): Promise<Comment[]> {
  const orderClause = {
    best: 'path, score DESC',
    top: 'score DESC, path',
    new: 'created_at DESC, path'
  }[sortBy];

  const result = await pool.query(`
    SELECT c.*, u.username as author_name
    FROM comments c
    LEFT JOIN users u ON c.author_id = u.id
    WHERE c.post_id = $1
    ORDER BY ${orderClause}
  `, [postId]);

  return result.rows;
}

// Get subtree for "load more" functionality
async function getCommentSubtree(
  parentPath: string,
  limit: number = 100
): Promise<Comment[]> {
  const result = await pool.query(`
    SELECT c.*, u.username as author_name
    FROM comments c
    LEFT JOIN users u ON c.author_id = u.id
    WHERE c.path LIKE $1
    ORDER BY c.path
    LIMIT $2
  `, [`${parentPath}.%`, limit]);

  return result.rows;
}
```

### Why Materialized Path?

- **Single query** to fetch entire subtree
- **Natural sort order** when ordering by path
- **Depth included** for indentation without parsing
- **Trade-off**: Moving comments requires updating all descendant paths (but moves are extremely rare on Reddit-like platforms)

---

## 5. Deep Dive: Ranking Algorithms (6 minutes)

### Hot Algorithm

Reddit's classic hot algorithm balances recency with popularity:

```typescript
function calculateHotScore(
  upvotes: number,
  downvotes: number,
  createdAt: Date
): number {
  const score = upvotes - downvotes;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;

  // Reddit epoch: December 8, 2005
  const epochSeconds = 1134028003;
  const seconds = Math.floor(createdAt.getTime() / 1000) - epochSeconds;

  // 45000 seconds = 12.5 hours
  // An older post needs exponentially more votes to compete
  return sign * order + seconds / 45000;
}
```

**Key insight**: A 12-hour-old post with 10 upvotes has the same hot score as a brand new post with 1 upvote.

### Controversial Algorithm

Surfaces content with high engagement but balanced votes:

```typescript
function calculateControversialScore(
  upvotes: number,
  downvotes: number
): number {
  if (upvotes <= 0 || downvotes <= 0) return 0;

  const magnitude = upvotes + downvotes;
  const balance = Math.min(upvotes, downvotes) / Math.max(upvotes, downvotes);

  return magnitude * balance;
}
```

A post with 100 up / 100 down scores higher than 1000 up / 10 down.

### Precomputation Strategy with Redis Sorted Sets

```typescript
// Background job runs every 5 minutes
async function computeHotScores(): Promise<void> {
  // Only process recent posts (hot algorithm naturally deprioritizes old)
  const posts = await pool.query(`
    SELECT id, subreddit_id, upvotes, downvotes, created_at
    FROM posts
    WHERE created_at > NOW() - INTERVAL '7 days'
      AND is_archived = FALSE
  `);

  const pipeline = redis.pipeline();

  for (const post of posts.rows) {
    const hotScore = calculateHotScore(
      post.upvotes,
      post.downvotes,
      post.created_at
    );

    // Store in subreddit-specific sorted set
    pipeline.zadd(
      `r:${post.subreddit_id}:hot`,
      hotScore,
      post.id.toString()
    );

    // Update database for persistence
    pipeline.set(`post:${post.id}:hot`, hotScore.toString());
  }

  await pipeline.exec();
}

// Getting hot posts is O(log N) with sorted sets
async function getHotPosts(
  subredditId: number,
  page: number = 0,
  limit: number = 25
): Promise<number[]> {
  const start = page * limit;
  const postIds = await redis.zrevrange(
    `r:${subredditId}:hot`,
    start,
    start + limit - 1
  );

  return postIds.map(id => parseInt(id));
}
```

### TTL for Sorted Sets

```typescript
// Clean up old entries after 7 days
async function cleanupOldHotScores(): Promise<void> {
  const subreddits = await pool.query('SELECT id FROM subreddits');

  for (const sub of subreddits.rows) {
    const key = `r:${sub.id}:hot`;

    // Remove posts older than 7 days
    const cutoff = calculateHotScore(0, 0,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    );

    await redis.zremrangebyscore(key, '-inf', cutoff.toString());
  }
}
```

---

## 6. Deep Dive: Karma and User Aggregation (4 minutes)

### Karma Calculation

```typescript
async function updateUserKarma(userId: number): Promise<void> {
  // Calculate post karma (sum of votes on user's posts)
  const postKarma = await pool.query(`
    SELECT COALESCE(SUM(v.direction), 0) as karma
    FROM votes v
    JOIN posts p ON v.post_id = p.id
    WHERE p.author_id = $1
  `, [userId]);

  // Calculate comment karma
  const commentKarma = await pool.query(`
    SELECT COALESCE(SUM(v.direction), 0) as karma
    FROM votes v
    JOIN comments c ON v.comment_id = c.id
    WHERE c.author_id = $1
  `, [userId]);

  await pool.query(`
    UPDATE users
    SET karma_post = $1, karma_comment = $2
    WHERE id = $3
  `, [postKarma.rows[0].karma, commentKarma.rows[0].karma, userId]);
}

// Batch update karma for all affected users
async function batchUpdateKarma(): Promise<void> {
  // Find users with recent votes on their content
  const affectedUsers = await pool.query(`
    SELECT DISTINCT p.author_id as user_id
    FROM votes v
    JOIN posts p ON v.post_id = p.id
    WHERE v.created_at > NOW() - INTERVAL '5 minutes'
      AND p.author_id IS NOT NULL
    UNION
    SELECT DISTINCT c.author_id as user_id
    FROM votes v
    JOIN comments c ON v.comment_id = c.id
    WHERE v.created_at > NOW() - INTERVAL '5 minutes'
      AND c.author_id IS NOT NULL
  `);

  for (const { user_id } of affectedUsers.rows) {
    await updateUserKarma(user_id);
  }
}
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Vote storage | Async aggregation | 5-30s delay for scores | Direct UPDATE (contention) |
| Comment tree | Materialized path | Move requires subtree update | Closure table (more storage) |
| Hot scores | Precomputed sorted sets | 5min staleness | On-demand calc (CPU intensive) |
| Database | PostgreSQL | Scaling requires sharding | Cassandra (easier sharding) |
| Karma | Background batch | Stale by minutes | Real-time (expensive) |

---

## 8. Database Partitioning Strategy

### Vote Table Partitioning

```sql
-- Partition votes by month for easy archival
CREATE TABLE votes (
  id SERIAL,
  user_id INTEGER NOT NULL,
  post_id INTEGER,
  comment_id INTEGER,
  direction SMALLINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE votes_2024_01 PARTITION OF votes
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE votes_2024_02 PARTITION OF votes
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
```

### Archival Worker

```typescript
async function archiveOldVotes(monthsAgo: number = 12): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - monthsAgo);

  const partitionName = `votes_${cutoffDate.getFullYear()}_${
    String(cutoffDate.getMonth() + 1).padStart(2, '0')
  }`;

  // Export to cold storage before dropping
  const votes = await pool.query(`SELECT * FROM ${partitionName}`);

  await minioClient.putObject(
    'reddit-archive',
    `archives/votes/${partitionName}.json.gz`,
    zlib.gzipSync(JSON.stringify(votes.rows))
  );

  // Drop partition after confirming upload
  await pool.query(`DROP TABLE IF EXISTS ${partitionName}`);
}
```

---

## 9. Metrics and Observability

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

const metrics = {
  votes: new Counter({
    name: 'reddit_votes_total',
    help: 'Total votes cast',
    labelNames: ['direction', 'target_type']
  }),

  aggregationLag: new Gauge({
    name: 'reddit_vote_aggregation_lag_seconds',
    help: 'Time since last vote aggregation'
  }),

  hotScoreCalculation: new Histogram({
    name: 'reddit_hot_score_calculation_duration_seconds',
    help: 'Time to calculate hot scores',
    buckets: [0.1, 0.5, 1, 5, 10, 30]
  }),

  commentTreeDepth: new Histogram({
    name: 'reddit_comment_tree_depth',
    help: 'Comment nesting depth',
    buckets: [1, 2, 3, 5, 10, 20, 50]
  })
};
```

---

## 10. Future Enhancements

1. **Bloom Filters** - Detect vote duplication at scale without DB lookup
2. **Event Sourcing** - Store vote events for complete audit trail
3. **CQRS** - Separate read/write models for optimized feeds
4. **Elasticsearch** - Full-text search across subreddits
5. **Kafka** - Async event processing for cross-service communication

---

## Summary

"To summarize, I've designed Reddit's backend with:

1. **Async vote aggregation** - Individual votes insert without contention, background workers aggregate every 5-30 seconds. This trades real-time accuracy for scalability under high load.

2. **Materialized path for comments** - Storing the full ancestry path (e.g., '1.5.23') enables single-query subtree fetches and natural sorting, critical for Reddit's deep discussion threads.

3. **Precomputed ranking scores** - Hot, top, and controversial scores are calculated in background jobs and stored in Redis sorted sets, making feed retrieval O(log N).

4. **Partitioned vote storage** - Monthly partitions enable archival of old votes while keeping recent data fast.

The main trade-off is freshness vs. performance. We accept eventually consistent vote counts and ranking scores because the user experience doesn't require real-time precision for these values."
