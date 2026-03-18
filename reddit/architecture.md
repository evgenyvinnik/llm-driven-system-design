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
- **Latency**: < 100ms for feed loading, p99 < 200ms
- **Scale**: 500M monthly active users, millions of posts/day, billions of votes
- **Consistency**: Eventual consistency for vote counts (acceptable 5-30s delay)
- **Throughput**: 100K votes/sec peak, 50K feed reads/sec

---

## Capacity Estimation

### Production Scale

- **Users**: 500M MAU, 50M DAU, 5M peak concurrent
- **Posts**: 10M new posts/day (~115 posts/sec)
- **Comments**: 100M new comments/day (~1,150/sec)
- **Votes**: 1B votes/day (~11,500/sec, peak 100K/sec during viral events)
- **Feed reads**: 50M DAU * 20 feed views/day = 1B feed requests/day (~11,500 QPS)
- **Storage**: Posts + comments ~5 TB/year, votes ~50 TB/year (before archival)

### Local Development Scale

- 2-5 concurrent users, ~20 subreddits, ~1,000 posts, ~10,000 comments
- Single PostgreSQL instance, single Valkey instance
- No message queue needed (workers run as separate processes with timers)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
│                    (Web / Mobile / Third-party Apps)                      │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │       CDN         │
                     │  (Static assets,  │
                     │   embedded media) │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │   API Gateway /   │
                     │   Load Balancer   │
                     └─────────┬─────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
┌─────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│  Post Service    │ │  Vote Service   │ │ Comment Service │
│  - CRUD posts    │ │  - Cast votes   │ │  - Tree mgmt    │
│  - Feed ranking  │ │  - Aggregation  │ │  - Threading    │
└─────────┬────────┘ └────────┬────────┘ └────────┬────────┘
          │                    │                    │
          │         ┌──────────┴──────────┐         │
          │         │                     │         │
┌─────────▼─────────▼───┐  ┌─────────────▼─────────▼───┐
│     PostgreSQL         │  │        Valkey/Redis        │
│  (Users, Posts,        │  │  (Vote counts cached,      │
│   Comments, Votes,     │  │   Hot scores precomputed,  │
│   Subreddits, Audit)   │  │   Session storage, Karma)  │
└────────────────────────┘  └───────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────┐
│              Background Workers                     │
│  ┌──────────────────┐  ┌─────────────────────┐     │
│  │ Vote Aggregator  │  │ Ranking Calculator  │     │
│  │ (every 5-30s)    │  │ (every 60s)         │     │
│  └──────────────────┘  └─────────────────────┘     │
└────────────────────────────────────────────────────┘
```

At production scale, the architecture would include:
- **Kafka** for event streaming between services (vote events, post creation events)
- **Elasticsearch** for full-text search across posts and comments
- **Read replicas** for feed queries (read-heavy workload)
- **Sharding** by subreddit_id for horizontal partitioning
- **CDN** for static assets, embedded media, and pre-rendered feeds

---

## Core Components

### 1. Voting System

**Challenge**: Counting votes efficiently without database row locks under high contention.

At production scale with 100K votes/sec on a viral post, a direct `UPDATE posts SET score = score + 1` approach creates catastrophic row-level lock contention. Every concurrent voter serializes on the same row, turning a microsecond operation into a multi-second queue.

**Chosen approach: Write to vote table + async aggregation**

Votes are inserted into a separate `votes` table with no contention (each INSERT creates a new row). A background worker aggregates vote counts every 5-30 seconds, batch-updating the denormalized `score`, `upvotes`, and `downvotes` columns on posts and comments. This trades real-time accuracy for write throughput. Users see eventual consistency with a 5-30 second delay, which is acceptable because Reddit itself fuzzes displayed scores to prevent vote manipulation.

**Why not Redis INCR?** Atomic Redis increments give real-time counts but introduce durability risk. If Redis restarts between increments and persistence, votes are lost. The vote table approach preserves every vote for auditing, fraud detection, and karma recalculation.

### 2. Nested Comments (Materialized Path)

**Challenge**: Efficiently storing and querying arbitrarily deep comment trees.

| Method | Read Subtree | Insert | Move Subtree |
|--------|--------------|--------|--------------|
| Adjacency List | O(n) recursive CTE | O(1) | O(1) |
| Materialized Path | O(log n) LIKE query | O(1) | O(subtree size) |
| Nested Sets | O(log n) range query | O(n) renumber | O(n) renumber |
| Closure Table | O(1) join | O(depth) inserts | O(subtree size) |

**Chosen: Materialized Path** with path strings like `"1.5.23.102"` encoding ancestry.

A single `WHERE path LIKE '1.5.%' ORDER BY path` fetches an entire subtree in tree order. This is the sweet spot for Reddit's access pattern: frequent subtree reads, frequent inserts (new replies), and essentially zero moves (users never rearrange comments). The `varchar_pattern_ops` index on PostgreSQL makes LIKE prefix queries efficient.

**Trade-off acknowledged**: Moving a comment requires updating all descendant paths, which is O(subtree size). On Reddit, comment moves are essentially non-existent, so this cost is irrelevant.

### 3. Ranking Algorithms

**Hot algorithm** (Reddit's formula):

```
score = ups - downs
order = log10(max(|score|, 1))
sign = +1 if score > 0, -1 if score < 0, 0 if score = 0
seconds = (created_at_epoch - reddit_epoch)
hot_score = sign * order + seconds / 45000
```

The time component (`seconds / 45000`) means older posts need exponentially more votes to compete with newer ones. A 12.5-hour-old post needs 10x the score of a new post to rank equally.

**Controversial algorithm**: `magnitude * (min(ups, downs) / max(ups, downs))`. High total engagement with balanced votes surfaces divisive content.

**Wilson score** (for "best" comment sorting): Lower bound of the 95% confidence interval for the upvote proportion. This prevents a comment with 1 upvote / 0 downvotes from ranking above a comment with 100 upvotes / 5 downvotes.

**Precomputation strategy**: A background worker recalculates hot scores every 60 seconds for posts created in the last 7 days. Older posts are frozen. At production scale, these scores would be stored in Valkey sorted sets (`ZREVRANGE r:programming:hot 0 24`) for O(log N) retrieval.

---

## Database Schema

### Entity-Relationship Diagram

```
┌──────────────┐
│    users     │
├──────────────┤         ┌───────────────┐
│ id (PK)      │─────────│   sessions    │
│ username     │    1:N  ├───────────────┤
│ email        │         │ id (PK)       │
│ password_hash│         │ user_id (FK)  │
│ karma_post   │         │ expires_at    │
│ karma_comment│         └───────────────┘
│ role         │
│ created_at   │
└──────────────┘
       │
       ├──────────────────────────────────────────┐
       │ 1:N                                      │ 1:N
       ▼                                          ▼
┌──────────────┐    ┌──────────────┐       ┌──────────────┐
│  subreddits  │    │    posts     │       │   comments   │
├──────────────┤    ├──────────────┤       ├──────────────┤
│ id (PK)      │    │ id (PK)      │  1:N  │ id (PK)      │
│ name         │    │ subreddit_id │◄──────│ post_id (FK) │
│ title        │    │ author_id    │       │ author_id    │
│ description  │    │ title        │       │ parent_id    │──┐ SELF-REF
│ created_by   │    │ content      │       │ path         │◄─┘
│ subscriber_  │    │ url          │       │ depth        │
│   count      │    │ score        │       │ content      │
│ is_private   │    │ upvotes      │       │ score        │
└──────────────┘    │ downvotes    │       │ upvotes      │
       │            │ comment_count│       │ downvotes    │
       │ 1:N        │ hot_score    │       └──────────────┘
       ▼            │ is_archived  │              │
┌──────────────┐    └──────────────┘              │ 1:N
│subscriptions │           │                      ▼
├──────────────┤           │ 1:N           ┌──────────────┐
│ user_id (PK) │           ▼               │    votes     │
│ subreddit_id │    ┌──────────────┐       ├──────────────┤
│ subscribed_at│    │    votes     │       │ id (PK)      │
└──────────────┘    │  (post_id)   │       │ user_id (FK) │
                    └──────────────┘       │ post_id (FK) │
                                           │ comment_id   │
                                           │ direction    │
                                           └──────────────┘
                                                  │
                                    XOR: Either post_id OR
                                    comment_id set, not both
```

### Complete Table Definitions

#### 1. users

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing user identifier |
| username | VARCHAR(50) | UNIQUE, NOT NULL | Display name |
| email | VARCHAR(255) | UNIQUE, NOT NULL | Email for auth |
| password_hash | VARCHAR(255) | NOT NULL | Bcrypt-hashed password |
| karma_post | INTEGER | DEFAULT 0 | Accumulated post karma |
| karma_comment | INTEGER | DEFAULT 0 | Accumulated comment karma |
| role | VARCHAR(20) | DEFAULT 'user' | Role: user, moderator, admin |
| created_at | TIMESTAMP | DEFAULT NOW() | Account creation |

**Design rationale**: Separate karma for posts and comments allows different karma thresholds for different actions (e.g., minimum karma to post in certain subreddits).

#### 2. sessions

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | VARCHAR(255) | PRIMARY KEY | Session token |
| user_id | INTEGER | FK -> users ON DELETE CASCADE | Session owner |
| expires_at | TIMESTAMP | NOT NULL | Expiry time |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation time |

#### 3. subreddits

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Subreddit identifier |
| name | VARCHAR(50) | UNIQUE, NOT NULL | URL-friendly name |
| title | VARCHAR(255) | | Human-readable title |
| description | TEXT | | Community rules and description |
| created_by | INTEGER | FK -> users (no cascade) | Original creator |
| subscriber_count | INTEGER | DEFAULT 0 | Denormalized subscriber count |
| is_private | BOOLEAN | DEFAULT FALSE | Private community flag |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |

**Design rationale**: `created_by` has no ON DELETE to preserve subreddit history even if the creator deletes their account.

#### 4. subscriptions

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | INTEGER | PK, FK -> users ON DELETE CASCADE | Subscriber |
| subreddit_id | INTEGER | PK, FK -> subreddits ON DELETE CASCADE | Target subreddit |
| subscribed_at | TIMESTAMP | DEFAULT NOW() | Subscription time |

#### 5. posts

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Post identifier |
| subreddit_id | INTEGER | FK -> subreddits ON DELETE CASCADE | Target community |
| author_id | INTEGER | FK -> users ON DELETE SET NULL | Post author |
| title | VARCHAR(300) | NOT NULL | Post title |
| content | TEXT | | Text content (null for link posts) |
| url | VARCHAR(2048) | | Link URL (null for text posts) |
| score | INTEGER | DEFAULT 0 | Net score (upvotes - downvotes) |
| upvotes | INTEGER | DEFAULT 0 | Total upvotes |
| downvotes | INTEGER | DEFAULT 0 | Total downvotes |
| comment_count | INTEGER | DEFAULT 0 | Denormalized comment count |
| hot_score | DOUBLE PRECISION | DEFAULT 0 | Precomputed hot ranking score |
| is_archived | BOOLEAN | DEFAULT FALSE | Archive flag |
| archived_at | TIMESTAMP | | Archive timestamp |
| created_at | TIMESTAMP | DEFAULT NOW() | Submission timestamp |

**Indexes**: `(subreddit_id, hot_score DESC)` for hot feeds, `(subreddit_id, created_at DESC)` for new feeds, `(subreddit_id, score DESC)` for top feeds, partial index on `is_archived = FALSE` for active posts.

**Design rationale**: `ON DELETE SET NULL` for author preserves posts as "[deleted]" when users delete accounts. Denormalized score/upvotes/downvotes avoid expensive aggregation queries on the read path.

#### 6. comments

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Comment identifier |
| post_id | INTEGER | FK -> posts ON DELETE CASCADE | Parent post |
| author_id | INTEGER | FK -> users ON DELETE SET NULL | Comment author |
| parent_id | INTEGER | FK -> comments ON DELETE CASCADE | Parent comment (null for top-level) |
| path | VARCHAR(255) | NOT NULL | Materialized path (e.g., "1.5.23") |
| depth | INTEGER | DEFAULT 0 | Nesting level |
| content | TEXT | NOT NULL | Comment body |
| score | INTEGER | DEFAULT 0 | Net score |
| upvotes | INTEGER | DEFAULT 0 | Total upvotes |
| downvotes | INTEGER | DEFAULT 0 | Total downvotes |
| is_archived | BOOLEAN | DEFAULT FALSE | Archive flag |
| created_at | TIMESTAMP | DEFAULT NOW() | Submission timestamp |

**Indexes**: `(path varchar_pattern_ops)` for subtree queries, `(post_id, created_at)` for chronological listing, `(post_id, score DESC)` for best comment sorting.

#### 7. votes

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Vote identifier |
| user_id | INTEGER | FK -> users ON DELETE CASCADE | Voter |
| post_id | INTEGER | FK -> posts ON DELETE CASCADE | Voted post (null if comment vote) |
| comment_id | INTEGER | FK -> comments ON DELETE CASCADE | Voted comment (null if post vote) |
| direction | SMALLINT | NOT NULL | 1 (up) or -1 (down) |
| created_at | TIMESTAMP | DEFAULT NOW() | Vote timestamp |

**Constraints**: `UNIQUE(user_id, post_id)`, `UNIQUE(user_id, comment_id)`, CHECK that exactly one of post_id or comment_id is set.

#### 8. audit_logs

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Log identifier |
| timestamp | TIMESTAMP | DEFAULT NOW() | Event time |
| actor_id | INTEGER | FK -> users ON DELETE SET NULL | Acting user |
| actor_ip | INET | | Client IP address |
| action | VARCHAR(50) | NOT NULL | Action type (e.g., post.delete, user.ban) |
| target_type | VARCHAR(20) | | Entity type (post, comment, user, subreddit) |
| target_id | INTEGER | | Affected entity ID |
| details | JSONB | | Action-specific context |
| subreddit_id | INTEGER | FK -> subreddits ON DELETE SET NULL | Context subreddit |

**Indexes**: `(timestamp DESC)`, `(actor_id)`, `(action)`, `(target_type, target_id)`, partial index on recent 90 days.

### Foreign Key Cascade Behaviors

| From | Column | To | On Delete | Rationale |
|------|--------|----|-----------|-----------|
| sessions | user_id | users | CASCADE | Sessions meaningless without user |
| subreddits | created_by | users | (none) | Preserve subreddit history |
| posts | author_id | users | SET NULL | Show as "[deleted]" |
| posts | subreddit_id | subreddits | CASCADE | Posts belong to subreddit lifecycle |
| comments | author_id | users | SET NULL | Preserve comment content |
| comments | parent_id | comments | CASCADE | Remove entire reply subtree |
| votes | user_id | users | CASCADE | Vote history removed with user |
| audit_logs | actor_id | users | SET NULL | Preserve audit trail |

---

## API Design

```
# Authentication
POST   /api/auth/register           - Create account
POST   /api/auth/login              - Login
POST   /api/auth/logout             - Logout
GET    /api/auth/me                 - Get current user

# Subreddits
POST   /api/subreddits              - Create subreddit
GET    /api/subreddits/:name        - Get subreddit info
POST   /api/subreddits/:name/subscribe - Subscribe/unsubscribe

# Posts
POST   /api/r/:subreddit/posts     - Create post
GET    /api/r/:subreddit/:sort      - List posts (hot/new/top/controversial)
GET    /api/posts/:id               - Get post with vote status

# Comments
POST   /api/posts/:id/comments     - Create comment
GET    /api/posts/:id/comments     - Get comment tree

# Voting
POST   /api/vote                   - Cast vote
Body: { type: "post"|"comment", id: number, direction: 1|-1|0 }

# Users
GET    /api/users/:username        - Get profile + karma
GET    /api/users/:username/posts  - User's post history

# Search
GET    /api/search?q=              - Search posts
```

---

## Key Design Decisions

### 1. Eventual Consistency for Vote Counts

**Chosen**: Vote counts are eventually consistent with a 5-30 second delay.

**Why this works for Reddit**: Users rarely notice slight delays in score updates. Reddit itself fuzzes displayed scores to prevent vote manipulation, so exact real-time accuracy is not a user expectation. The aggregation delay also provides a natural batch window for detecting suspicious voting patterns before scores are committed.

**What breaks with the alternative**: Real-time counts via direct `UPDATE posts SET score = score + 1` create row-level locks. On a viral post receiving 10,000 votes/second, every voter waits in a lock queue. Average response time degrades from 5ms to 500ms+, and the database connection pool exhausts within seconds. The application appears "hung" to all users, not just those voting on the viral post, because the connection pool is shared.

**What we give up**: Users see stale scores for up to 30 seconds. On posts receiving few votes, this is imperceptible. On viral posts, the score visually "jumps" in increments rather than ticking up smoothly. This is acceptable because Reddit's fuzzing already causes similar behavior.

### 2. Materialized Path for Comments

**Chosen**: Path strings like `"1.5.23"` encode comment ancestry.

**Why this works**: Reddit's dominant access pattern is "show me all replies under this comment." A single `WHERE path LIKE '1.5.%'` query with a `varchar_pattern_ops` index retrieves an entire subtree in tree order. No recursive CTEs, no multiple round-trips.

**What breaks with adjacency lists**: Fetching a comment tree requires recursive CTEs (`WITH RECURSIVE`), which PostgreSQL executes as iterative breadth-first traversal. For a post with 5,000 comments and 20 levels of nesting, this means 20 sequential query rounds inside the CTE. On a busy database server, this takes 50-200ms per request compared to 5-10ms for a single LIKE query.

**What we give up**: Comment moves require updating all descendant paths. But on Reddit, comments are never moved. This is a textbook case of choosing a data structure optimized for the actual access pattern.

### 3. Precomputed Hot Scores

**Chosen**: Background worker recalculates hot scores every 60 seconds for posts from the last 7 days.

**Why precomputation**: The hot algorithm involves `log10`, sign detection, and epoch arithmetic. Calculating this on every feed request for 50 posts means 50 floating-point computations per request. At 11,500 QPS, that is 575,000 computations/second. While individually cheap, precomputation moves this entirely off the read path, letting feed requests be simple sorted index scans.

**Why 7-day window**: Posts older than 7 days have effectively frozen hot scores because the time component dominates. A 7-day-old post would need millions of votes to compete with a 1-hour-old post with 10 votes. Freezing old scores saves computation without affecting ranking quality.

---

## Consistency and Idempotency

### Vote Idempotency

Votes use `INSERT ... ON CONFLICT (user_id, post_id) DO UPDATE SET direction = $3`. This ensures:
- Repeated identical votes are no-ops (idempotent)
- Changing vote direction is a single atomic operation
- Removing a vote sets direction to 0 (soft delete)

The background aggregator reads the full vote table state, so duplicate inserts or missed updates self-correct on the next aggregation cycle.

### Karma Recalculation

Karma is derived entirely from the votes table: `SUM(direction) FROM votes JOIN posts ON post_id WHERE author_id = ?`. This means karma is always recalculable from source-of-truth data. If the denormalized `karma_post` column drifts, the aggregation worker corrects it.

### Audit Log Durability

Audit events are fire-and-forget with error suppression. A failed audit write does not block the user-facing operation. This trades audit completeness for availability. At production scale, audit events would flow through Kafka for guaranteed delivery.

---

## Security / Auth

- **Session-based auth** with Valkey-backed sessions (cookie-based tokens)
- **bcrypt** password hashing with 12 rounds
- **Cookie security**: HttpOnly, SameSite=Lax for CSRF protection
- **Input sanitization**: Parameterized SQL queries prevent injection
- **CORS**: Restricted to frontend origin
- **Graceful shutdown**: Rejects new requests with 503 during shutdown, drains in-flight requests

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `reddit_http_request_duration_seconds` | Histogram | API latency by method/route/status |
| `reddit_http_requests_total` | Counter | Request count by method/route/status |
| `reddit_votes_total` | Counter | Votes by direction and target type |
| `reddit_vote_aggregation_lag_seconds` | Gauge | Freshness of aggregated scores |
| `reddit_vote_aggregation_duration_seconds` | Histogram | Aggregation batch time |
| `reddit_posts_created_total` | Counter | Post creation rate by subreddit |
| `reddit_comments_created_total` | Counter | Comment rate by depth bucket |
| `reddit_comment_tree_depth` | Histogram | Comment nesting depth distribution |
| `reddit_hot_score_calculation_duration_seconds` | Histogram | Ranking job duration |
| `reddit_db_pool_size` | Gauge | Connection pool utilization |
| `reddit_db_query_duration_seconds` | Histogram | Query duration by operation type |
| `reddit_cache_hits_total` / `reddit_cache_misses_total` | Counter | Cache effectiveness |
| `reddit_audit_events_total` | Counter | Audit event rate by action/target |
| `reddit_karma_calculation_duration_seconds` | Histogram | Karma recalculation time |

### Health Checks

- `GET /health` - Detailed status with PostgreSQL and Valkey latency, memory usage
- `GET /health/live` - Simple liveness probe (process running)
- `GET /health/ready` - Readiness probe (all dependencies healthy)
- `GET /metrics` - Prometheus scrape endpoint

### Structured Logging

Pino logger with JSON output. Each request gets a child logger with request ID, method, path, and user ID for correlation. Slow queries (>100ms) trigger warning-level logs with query text and duration.

### SLO Targets

| SLI | Target | Measurement |
|-----|--------|-------------|
| Feed load latency | p95 < 100ms | `reddit_http_request_duration_seconds{route="/r/:subreddit/:sort"}` |
| API availability | 99.9% | 1 - (5xx / total) |
| Vote visibility delay | < 30s | `reddit_vote_aggregation_lag_seconds` |
| Cache hit rate | > 85% | hits / (hits + misses) |

---

## Failure Handling

- **Vote aggregation failure**: Worker crashes do not lose votes. Votes persist in the `votes` table. On restart, the aggregator recomputes from the full vote state, self-correcting any drift
- **Ranking worker failure**: Hot scores become stale but still valid. Posts continue to be served in the last-computed order. The `new` and `top` sorts are unaffected (derived from indexes)
- **Database connection exhaustion**: Pool configured with 20 max connections, 2-second connection timeout. Slow query logging identifies runaway queries before pool exhaustion
- **Graceful shutdown**: SIGTERM sets `isShuttingDown = true`, rejects new requests with 503, waits for in-flight requests (30-second timeout), then closes database and Redis connections

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless (sessions in Valkey), scale behind load balancer. Run 3+ instances for redundancy
2. **Workers**: Vote aggregator and ranking calculator run independently. Multiple instances can partition by subreddit ranges
3. **Database reads**: Add PostgreSQL read replicas for feed queries. Write to primary, read from replicas with acceptable lag
4. **Sharding**: Partition by subreddit_id. Each shard contains a community's posts, comments, and votes. Cross-shard queries needed only for user profiles and home feeds
5. **Caching**: Valkey sorted sets for hot post lists per subreddit. CDN for static assets. Application-level markdown render cache
6. **Event streaming**: Kafka for vote events, post creation events, enabling decoupled consumers (search indexing, analytics, notifications)

### Data Lifecycle

| Data Type | Hot Storage | Warm Storage | Cold/Archive | Total Retention |
|-----------|-------------|--------------|--------------|-----------------|
| Posts | 1 year | 2 years | Forever (S3) | Permanent |
| Comments | 1 year | 2 years | Forever (S3) | Permanent |
| Votes | 90 days | 1 year | Aggregate only | 1 year detail |
| Sessions | 30 days | N/A | N/A | 30 days |
| Audit logs | 90 days | 1 year | 7 years (S3) | 7 years |
| Hot scores | 24 hours | N/A | N/A | Recomputed |

Vote partitioning by month (`PARTITION BY RANGE (created_at)`) enables clean archival: export a partition to S3 as compressed JSON, verify the upload, drop the partition.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Vote counting | Async aggregation | Direct UPDATE / Redis INCR | Eliminates row locks, preserves vote audit trail |
| Comment tree | Materialized path | Adjacency list / Closure table | Single-query subtree fetch, zero-cost inserts |
| Hot scores | Precomputed by worker | On-demand calculation | Removes computation from read path |
| Database | PostgreSQL | Cassandra / MongoDB | Relational model fits entity relationships, ACID for votes |
| Session storage | Valkey + cookie | JWT | Immediate revocation, simpler for server-rendered sessions |
| Search | PostgreSQL full-text | Elasticsearch | Simpler for learning; Elasticsearch needed at scale |

---

## Implementation Notes

### Local Architecture

```
┌───────────────────┐     ┌───────────────────────────┐
│   React Frontend  │────▶│   Express API Server      │
│   localhost:5173   │     │   localhost:3000           │
└───────────────────┘     │                           │
                          │  Routes:                  │
                          │  /api/auth/*              │
                          │  /api/subreddits/*        │
                          │  /api/posts/*             │
                          │  /api/vote                │
                          │  /api/r/*                 │
                          │                           │
                          │  /health, /metrics        │
                          └──────┬──────────┬─────────┘
                                 │          │
                    ┌────────────▼┐   ┌─────▼────────┐
                    │ PostgreSQL  │   │    Valkey     │
                    │ :5432       │   │    :6379      │
                    │ reddit/     │   │  sessions,    │
                    │ reddit_pwd  │   │  vote cache   │
                    └─────────────┘   └──────────────┘

        ┌──────────────────────────────────────────────┐
        │           Background Workers                  │
        │  ┌─────────────────────┐ ┌─────────────────┐ │
        │  │ Vote Aggregator     │ │ Ranking Calc    │ │
        │  │ npm run dev:worker  │ │ npm run         │ │
        │  │ (every 5s)          │ │ dev:ranking     │ │
        │  │                     │ │ (every 60s)     │ │
        │  └─────────────────────┘ └─────────────────┘ │
        └──────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

1. **Async vote aggregation** (`src/workers/voteAggregator.ts`): Background worker polls every 5 seconds, batch-updates post/comment scores from the votes table. Includes Prometheus metrics for aggregation lag and duration. Graceful shutdown ensures in-flight batches complete.

2. **Hot score precomputation** (`src/workers/rankingCalculator.ts`): Recalculates hot scores every 60 seconds for posts from the last 7 days. Implements the full Reddit hot algorithm (`src/utils/ranking.ts`), including Wilson score for "best" comment sorting and controversial score.

3. **Prometheus metrics** (`src/shared/metrics.ts`): 15+ custom metrics covering HTTP requests, vote velocity, aggregation lag, database pool utilization, cache effectiveness, and audit events. Route normalization prevents label cardinality explosion.

4. **Structured logging** (`src/shared/logger.ts`): Pino with JSON output, request-scoped child loggers with trace context (request ID, user ID, method, path). Slow query detection at 100ms threshold.

5. **Audit logging** (`src/shared/audit.ts`): Database-backed audit trail for security events (login/logout, content deletion, user bans, suspicious voting). Convenience functions for common events. Metrics integration for audit event rate tracking.

6. **Data retention policies** (`src/shared/retention.ts`): Configurable lifecycle policies for posts, comments, votes, sessions, and audit logs. Hot/warm/cold storage tiers with archive path generation.

7. **Health checks** (`src/index.ts`): Detailed health endpoint checking PostgreSQL and Valkey connectivity with latency measurement. Separate liveness and readiness probes. Memory usage reporting.

8. **Graceful shutdown** (`src/index.ts`): SIGTERM/SIGINT handlers that stop accepting connections, drain in-flight requests, and close database/Redis connections with a 30-second timeout.

### What Was Simplified

| Production Design | Local Implementation |
|-------------------|---------------------|
| Kafka event streaming | Direct timer-based workers (setInterval) |
| Elasticsearch for search | PostgreSQL ILIKE queries |
| Sharded PostgreSQL | Single PostgreSQL instance |
| Read replicas | Single database, same pool for reads and writes |
| CDN for static assets | Vite dev server serves frontend |
| OAuth/SSO | Cookie-based session auth with bcrypt |
| Valkey sorted sets for feeds | Direct PostgreSQL `ORDER BY hot_score` |
| Distributed rate limiting | No rate limiting implemented |

### What Was Omitted

- CDN and multi-region deployment
- Kubernetes orchestration
- Database sharding and read replicas
- Message queue (Kafka/RabbitMQ) for inter-service communication
- Elasticsearch for full-text search
- Rate limiting and anti-spam
- Email notifications
- Media upload and processing
- Moderation tools (automod, ban, content removal)
- A/B testing framework
- Vote fuzzing for anti-brigade

---

## Frontend Architecture

### Component Hierarchy

```
__root (RootComponent)
├── Header                          # Global nav bar with auth state, search, navigation
├── Outlet (route-specific content)
│   ├── / (HomePage)                # Global feed with sort tabs + sidebar
│   │   ├── SortTabs                # Hot / New / Top / Controversial sort selector
│   │   ├── PostCard[]              # Post summary cards in a vertical list
│   │   │   └── VoteButtons         # Upvote/downvote with optimistic score update
│   │   └── Sidebar                 # Subreddit list, community info
│   ├── /r/$subreddit               # Subreddit page with header + post list
│   │   ├── SortTabs
│   │   └── PostCard[]
│   ├── /r/$subreddit/comments/$postId  # Post detail with threaded comments
│   │   ├── VoteButtons             # Post-level voting
│   │   ├── CommentThread[]         # Recursive comment tree (self-referencing)
│   │   │   ├── VoteButtons         # Comment-level voting (horizontal layout)
│   │   │   └── CommentThread[]     # Nested replies (recursive rendering)
│   │   └── Comment form            # Top-level comment submission
│   ├── /submit                     # Post creation form
│   ├── /subreddits/create          # Subreddit creation form
│   ├── /u/$username                # User profile with post history
│   ├── /search                     # Search results page
│   ├── /login                      # Login form
│   └── /register                   # Registration form
```

### Zustand Stores

**`useAuthStore`** (`stores/authStore.ts`): Manages authentication state with `persist` middleware. Stores the current `User` object and provides `login`, `register`, `logout`, and `checkAuth` actions. The `persist` middleware serializes only the `user` field to localStorage under the key `reddit-auth`, enabling session restoration across page reloads without re-authenticating. On app startup, `checkAuth` validates the session cookie against the backend `/api/auth/me` endpoint; if the cookie has expired or been revoked server-side, the store clears the cached user.

The project does not use a dedicated feed or post store. Post data, subreddit info, and comment trees are managed as local React state within each route component via `useState` + `useEffect`. This is a deliberate simplification: since Reddit's content is community-scoped (each subreddit has its own feed), there is no global feed state to share across routes.

### Routing

TanStack Router with file-based routing. Routes are organized to mirror Reddit's URL structure:

| File | URL Pattern | Purpose |
|------|-------------|---------|
| `routes/index.tsx` | `/` | Global front page with sort tabs |
| `routes/r.$subreddit.tsx` | `/r/:subreddit` | Subreddit feed |
| `routes/r.$subreddit.comments.$postId.tsx` | `/r/:subreddit/comments/:postId` | Post detail + comment tree |
| `routes/submit.tsx` | `/submit` | Post creation with optional subreddit pre-fill |
| `routes/subreddits/create.tsx` | `/subreddits/create` | Subreddit creation |
| `routes/u.$username.tsx` | `/u/:username` | User profile |
| `routes/search.tsx` | `/search` | Search results |
| `routes/login.tsx` / `routes/register.tsx` | `/login`, `/register` | Authentication |

Search params are validated via `validateSearch` for sort type (`hot`, `new`, `top`, `controversial`) and comment sort type (`best`, `top`, `new`, `controversial`). This allows sharing URLs like `/r/programming?sort=top` with the sort state encoded in the URL.

### Data Fetching

All data fetching uses a centralized `api.ts` module that wraps the native `fetch` API with `credentials: 'include'` for cookie-based session auth. Each route component fetches its own data in a `useEffect` hook triggered by route params or search params. The subreddit page uses `Promise.all` to fetch subreddit metadata and posts in parallel, reducing load time.

There is no client-side caching layer (no React Query or SWR). Every route navigation triggers a fresh fetch. This is acceptable for a learning project but means navigating back to a previously viewed page re-fetches all data.

### Optimistic Updates

The `VoteButtons` component implements a partial optimistic update pattern. When a user clicks upvote or downvote, the component immediately sends the API request and waits for the server response before updating the displayed score. The score shown comes from `result.score` (the server-computed value), not a client-side increment. This means there is a brief delay (the round-trip time) before the score visually changes, but the displayed value is always accurate. The `isVoting` flag prevents double-clicks during the round-trip.

The comment submission flow uses an immediate local insert: after `api.createComment` resolves, the new comment is prepended to the local `comments` array via `setComments`. For replies, `handleReplyAdded` recursively walks the comment tree to insert the reply under the correct parent, preserving the nested structure without re-fetching the entire tree.

### Key UI Patterns

**Recursive comment rendering**: `CommentThread` is a self-referencing component. Each instance renders its own content, vote buttons, and reply form, then maps over `comment.replies` to render child `CommentThread` instances. Nesting depth is visualized with left margin (`marginLeft: comment.depth > 0 ? '16px' : 0`) and a vertical collapse line. Users can collapse a subtree by clicking the `[-]` button, which switches to a compact one-line summary showing username, score, and timestamp.

**Sort tabs with URL state**: Sort selection is stored as a URL search parameter rather than component state. This means sort preferences survive page refreshes and can be shared via URL. `SortTabs` renders links that update the `?sort=` parameter, and the route's `validateSearch` function parses and validates the value.

**Subreddit subscription toggle**: The subscribe/unsubscribe button uses local state (`isSubscribed`) initialized from the server response (`sub.subscribed`). Toggling calls the API and flips the local boolean. This is a simple optimistic pattern where the UI updates immediately and silently logs errors.

---

## Deep Pattern Explanations

### Structured Logging

Structured logging means emitting log messages as machine-parseable JSON objects instead of free-form text strings. A traditional log line like `"User 42 created post in r/programming"` is easy for humans to read but difficult for machines to search, filter, or aggregate. A structured log for the same event looks like `{"level":"info","msg":"post.created","userId":42,"subreddit":"programming","postId":1234,"timestamp":"2024-01-15T10:30:00Z"}`. Every field is a named key-value pair that log aggregation tools (Elasticsearch/Kibana, Datadog, Grafana Loki) can index and query.

The implementation uses Pino (`src/shared/logger.ts`), which outputs JSON by default. Each HTTP request gets a child logger with request-scoped context (request ID, HTTP method, path, user ID). This means every log line emitted during that request's lifecycle carries the same correlation fields, making it possible to reconstruct the full request flow by filtering on request ID. Slow queries (>100ms) automatically trigger warning-level logs with the query text and duration, providing a built-in slow query detector without separate database monitoring.

**Why it matters at scale**: When running multiple API server instances behind a load balancer, a single user request might be served by any instance. Without structured logging with request IDs, correlating log lines across instances requires manual timestamp matching, which is error-prone. With structured JSON logs, a query like `requestId="abc-123"` instantly returns every log line from that request regardless of which server emitted it.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements from your application at regular intervals (typically every 15 seconds). The application exposes a `/metrics` endpoint that Prometheus scrapes, returning metrics in a specific text format. There are four metric types:

- **Counter**: A value that only goes up (e.g., total HTTP requests served). You calculate rates from counters: "requests per second" = change in counter / time interval.
- **Histogram**: Records the distribution of values (e.g., request latency). A histogram automatically creates buckets (e.g., <10ms, <50ms, <100ms, <500ms) and counts how many observations fall into each. This lets you calculate percentiles like p95 and p99 without storing every individual value.
- **Gauge**: A value that can go up or down (e.g., current number of database connections in the pool).
- **Summary**: Similar to histogram but calculates percentiles on the client side (less common).

The implementation (`src/shared/metrics.ts`) defines 15+ custom metrics. Route labels are normalized to prevent cardinality explosion: `/r/programming/hot` and `/r/funny/hot` both become `/r/:subreddit/:sort` in the metric label. Without this normalization, each unique subreddit name would create a new time series, eventually overwhelming Prometheus's memory.

**Why it matters at scale**: Metrics answer operational questions that logs cannot efficiently answer. "What is the p99 latency of feed requests over the last hour?" requires aggregating millions of log entries but is a single PromQL query: `histogram_quantile(0.99, rate(reddit_http_request_duration_seconds_bucket{route="/r/:subreddit/:sort"}[1h]))`. Metrics are also the foundation for alerting: trigger a page when error rate exceeds 1% for 5 minutes.

### Health Checks

Health checks are HTTP endpoints that report whether the application is functioning correctly. They serve three distinct purposes, which is why there are three separate endpoints:

- **`GET /health`** (detailed): Returns a JSON object with the status of every dependency (PostgreSQL connectivity + latency, Valkey connectivity + latency, memory usage). Operations teams use this for debugging: if the database is slow, this endpoint reveals it immediately.
- **`GET /health/live`** (liveness): Returns 200 if the process is running. Kubernetes uses this to detect hung processes. If liveness fails, Kubernetes kills and restarts the container. This endpoint should never check external dependencies because a database outage should not cause all API servers to restart in a cascading failure.
- **`GET /health/ready`** (readiness): Returns 200 if the application is ready to serve traffic. This checks that database connections are established and Redis is reachable. Kubernetes uses this to decide whether to route traffic to this instance. A newly started instance that has not yet connected to the database will fail readiness, so the load balancer skips it until it is ready.

**Why three endpoints instead of one**: Conflating liveness and readiness causes cascading failures. If `/health` checks the database and the database is overloaded, all instances report unhealthy simultaneously. The orchestrator restarts all of them, which sends a surge of new connection requests to the already-overloaded database, making the situation worse.

### Idempotency

An idempotent operation produces the same result regardless of how many times it is executed. This is critical in distributed systems because network failures make it impossible to distinguish "the request failed before the server processed it" from "the request succeeded but the response was lost." In both cases, the client retries, and without idempotency, the second attempt creates a duplicate.

In the Reddit implementation, vote idempotency uses `INSERT ... ON CONFLICT (user_id, post_id) DO UPDATE SET direction = $3`. If a user sends the same upvote twice (due to a network retry or double-click), the second insert hits the unique constraint conflict and simply updates the direction to the same value it already has. The operation is a no-op. The background vote aggregator reads the full state of the votes table, so even if duplicate inserts somehow occurred, the aggregated score would be computed from the deduplicated vote records.

The broader principle: idempotency is achieved either through unique constraints (database rejects duplicates), upsert semantics (insert-or-update), or client-generated idempotency keys (stored server-side to detect retries). Reddit votes use the first approach because the `(user_id, post_id)` pair is a natural unique key.
