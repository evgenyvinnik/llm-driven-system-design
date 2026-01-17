# Design Reddit - Architecture

## System Overview

Reddit is a community-driven content platform where users submit posts, vote on content, and engage in threaded discussions. The core challenges involve efficient vote aggregation, nested comment handling, and content ranking algorithms.

**Learning Goals:**
- Implement voting systems that scale
- Design efficient nested comment storage and retrieval
- Build content ranking algorithms (hot, top, controversial)
- Handle community isolation (subreddits)

---

## Requirements

### Functional Requirements

1. **Subreddits**: Create communities, subscribe, set rules
2. **Posts**: Submit text/link/media posts to subreddits
3. **Comments**: Nested threaded discussions on posts
4. **Voting**: Upvote/downvote posts and comments
5. **Ranking**: Sort content by hot, new, top, controversial
6. **Moderation**: Remove content, ban users, automod

### Non-Functional Requirements

- **Availability**: 99.9% uptime
- **Latency**: < 100ms for feed loading
- **Scale**: Support millions of posts, billions of votes
- **Consistency**: Eventual consistency for vote counts (acceptable delay)

---

## Capacity Estimation (Learning Scale)

- **Users**: 100 active users locally
- **Subreddits**: 20 communities
- **Posts**: 1,000 posts
- **Comments**: 10,000 comments
- **Votes**: 100,000 votes

**Storage**: < 100 MB total

---

## High-Level Architecture

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
│    PostgreSQL       │              Valkey                       │
│  - Users, posts     │  - Vote counts (cached)                   │
│  - Comments, votes  │  - Hot scores (precomputed)               │
│  - Subreddits       │  - Session storage                        │
└─────────────────────┴───────────────────────────────────────────┘
```

---

## Core Components

### 1. Voting System

**Challenge**: Counting votes efficiently without locking the database

**Approach 1: Direct Count (Simple)**
```sql
UPDATE posts SET score = score + 1 WHERE id = ?
```
- **Problem**: Row-level locks under high contention

**Approach 2: Write to Vote Table + Async Aggregation (Chosen)**
```sql
INSERT INTO votes (user_id, post_id, direction) VALUES (?, ?, 1)
-- Background job aggregates periodically
```
- **Pros**: No contention, can detect duplicates
- **Cons**: Slight delay in score updates (acceptable)

**Vote Storage:**
```sql
CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  comment_id INTEGER REFERENCES comments(id),
  direction SMALLINT NOT NULL, -- 1 = up, -1 = down
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, post_id),
  UNIQUE(user_id, comment_id)
);

-- Aggregated scores cached in posts/comments tables
-- Background worker updates every 5-30 seconds
```

### 2. Nested Comments

**Challenge**: Efficiently storing and querying tree structures

**Approach 1: Adjacency List (Simple)**
```sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES comments(id),
  post_id INTEGER REFERENCES posts(id),
  ...
);
```
- Requires recursive queries (slow for deep trees)

**Approach 2: Materialized Path (Chosen)**
```sql
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id),
  path VARCHAR(255), -- e.g., "1.5.23.102"
  depth INTEGER,
  ...
);

-- Fetch all children of comment 5:
SELECT * FROM comments WHERE path LIKE '1.5.%' ORDER BY path;
```
- **Pros**: Single query for subtrees, easy sorting
- **Cons**: Path updates on moves (rare for comments)

**Approach 3: Nested Sets**
- Complex updates, better for read-heavy trees
- **Rejected**: Too complex for educational project

### 3. Ranking Algorithms

**Hot Algorithm:**
```javascript
// Reddit's hot algorithm (simplified)
function hotScore(ups, downs, createdAt) {
  const score = ups - downs
  const order = Math.log10(Math.max(Math.abs(score), 1))
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0
  const epochSeconds = 1134028003 // Reddit epoch
  const seconds = Math.floor(createdAt.getTime() / 1000) - epochSeconds
  return Math.round(sign * order + seconds / 45000, 7)
}
```

**Top Algorithm:**
```javascript
// Simple: highest score within time range
function topScore(ups, downs) {
  return ups - downs
}
```

**Controversial Algorithm:**
```javascript
// High total votes, close to 50/50 split
function controversialScore(ups, downs) {
  if (ups <= 0 || downs <= 0) return 0
  const magnitude = ups + downs
  const balance = Math.min(ups, downs) / Math.max(ups, downs)
  return magnitude * balance
}
```

**Precomputation Strategy:**
- Recalculate hot scores every 5 minutes for active posts
- Store in Valkey sorted sets for fast retrieval
- `ZREVRANGE r:programming:hot 0 24` → top 25 hot posts

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  karma_post INTEGER DEFAULT 0,
  karma_comment INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subreddits
CREATE TABLE subreddits (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(255),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  subscriber_count INTEGER DEFAULT 0,
  is_private BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE subscriptions (
  user_id INTEGER REFERENCES users(id),
  subreddit_id INTEGER REFERENCES subreddits(id),
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, subreddit_id)
);

-- Posts
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
  comment_count INTEGER DEFAULT 0,
  hot_score DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments (materialized path)
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id),
  author_id INTEGER REFERENCES users(id),
  parent_id INTEGER REFERENCES comments(id),
  path VARCHAR(255) NOT NULL,
  depth INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_path ON comments(path varchar_pattern_ops);
CREATE INDEX idx_comments_post ON comments(post_id);

-- Votes
CREATE TABLE votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  comment_id INTEGER REFERENCES comments(id),
  direction SMALLINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_post_vote UNIQUE(user_id, post_id),
  CONSTRAINT unique_comment_vote UNIQUE(user_id, comment_id)
);
```

---

## API Design

```
# Subreddits
POST   /api/subreddits              - Create subreddit
GET    /api/subreddits/:name        - Get subreddit info
POST   /api/subreddits/:name/subscribe - Subscribe

# Posts
POST   /api/r/:subreddit/posts      - Create post
GET    /api/r/:subreddit/:sort      - List posts (hot/new/top)
GET    /api/posts/:id               - Get post with comments

# Comments
POST   /api/posts/:id/comments      - Create comment
GET    /api/posts/:id/comments      - Get comment tree

# Voting
POST   /api/vote                    - Cast vote
Body: { type: "post"|"comment", id: number, direction: 1|-1|0 }

# User
GET    /api/users/:username         - Get profile
GET    /api/users/:username/posts   - Get user's posts
```

---

## Key Design Decisions

### 1. Eventual Consistency for Vote Counts

**Decision**: Vote counts are eventually consistent (5-30 second delay)

**Rationale**:
- Avoids database contention
- Users rarely notice slight delays
- Enables horizontal scaling of vote service

**Alternative**: Real-time counts with Redis atomic increments
- Better UX but more complex
- Consider for Phase 2

### 2. Materialized Path for Comments

**Decision**: Use path strings like "1.5.23" for tree traversal

**Rationale**:
- Single query to fetch entire subtree
- Easy depth-based sorting
- No recursive CTEs needed

**Trade-off**: Path updates on comment moves (but moves are rare)

### 3. Precomputed Hot Scores

**Decision**: Background job recalculates hot scores every 5 minutes

**Rationale**:
- Hot algorithm is CPU-intensive
- Same scores used by many users
- Store in Valkey sorted set for O(log N) retrieval

---

## Scalability Considerations

### Database Sharding (Future)

- Shard by subreddit_id (each community independent)
- Cross-shard queries for user profiles (aggregate across shards)

### Caching Strategy

- **Valkey**: Hot post lists, vote counts, user sessions
- **CDN**: Static assets, embedded media
- **Application**: Parsed markdown cache

### Read Replicas

- Separate read/write for post listing (read-heavy)
- Eventual consistency acceptable for feeds

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Vote counting | Async aggregation | Real-time Redis | Avoid DB contention |
| Comment tree | Materialized path | Adjacency list | Faster subtree queries |
| Hot scores | Precomputed cache | On-demand calc | CPU efficiency |
| Database | PostgreSQL | Cassandra | Relational fits better |

---

## Local Multi-Instance Setup

```bash
# Terminal 1: API Server
npm run dev:server1  # Port 3001

# Terminal 2: Vote Aggregation Worker
npm run dev:worker

# Terminal 3: Hot Score Calculator
npm run dev:ranking

# Infrastructure
docker-compose up -d  # PostgreSQL, Valkey
```

---

## Future Optimizations

1. **Bloom filters** for vote deduplication
2. **Event sourcing** for vote history
3. **CQRS** for read-optimized feeds
4. **Elasticsearch** for subreddit search
5. **Kafka** for cross-service events
