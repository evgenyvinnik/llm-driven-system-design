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

Naive approach: directly updating `score = score + 1` on the posts table causes row-level locks under high contention. A viral post could receive 1000 votes/second, causing lock waits and timeouts.

### Solution: Vote Table + Async Aggregation

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **votes** | id (SERIAL PK), user_id (FK users), post_id (FK posts), comment_id (FK comments), direction (SMALLINT: 1 = up, -1 = down), created_at | UNIQUE(user_id, post_id), UNIQUE(user_id, comment_id) | XOR constraint ensures exactly one target: either post_id or comment_id must be non-null, but not both |

### Vote Casting Implementation

Vote casting works as follows:

1. **Remove vote** (direction = 0): Delete the row from votes matching the user and target
2. **Cast or change vote** (direction = 1 or -1): Upsert into votes — insert a new row, or on conflict update the direction and timestamp
3. **Optimistic cache update**: Immediately increment the appropriate counter (up or down) in the Redis hash `{targetType}:{targetId}:votes` for instant UI feedback, even though the authoritative count will be updated by the background worker

### Background Aggregation Worker

The aggregation worker runs every 5-30 seconds and performs these steps:

1. **Find recently voted posts** — query for distinct post IDs from votes created in the last minute
2. **Aggregate votes per post** — count upvotes (direction = 1) and downvotes (direction = -1) using filtered aggregation
3. **Update denormalized counts** — write the computed upvotes, downvotes, and score (upvotes - downvotes) back to the posts table
4. **Refresh cache** — update the Redis hash `post:{id}:votes` with the authoritative counts

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

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **comments** | id (SERIAL PK), post_id (FK posts, CASCADE), author_id (FK users, SET NULL), parent_id (FK comments, CASCADE), path (VARCHAR 255), depth (INT), content (TEXT), score, upvotes, downvotes, created_at | path (varchar_pattern_ops) for LIKE queries; post_id | Path stores dot-separated ancestry like "1.5.23.102" |

### Creating a Comment

Creating a comment:

1. **If replying to a parent**: Look up the parent's path and depth. Generate a unique path segment (using a base-36 timestamp), then set `path = parentPath + "." + segment` and `depth = parentDepth + 1`.
2. **If top-level**: Set path to a base-36 timestamp and depth to 0.
3. **Insert the comment** into the comments table with post_id, parent_id, author_id, path, depth, and content.
4. **Increment the comment count** on the posts table.

### Fetching Comment Trees

**Fetching the full comment tree**: Query all comments for a post, joining with users for the author name. Order depends on the sort mode: "best" sorts by path then score descending, "top" sorts by score descending then path, and "new" sorts by created_at descending then path.

**Fetching a subtree** (for "load more"): Query comments whose path starts with the parent's path using a LIKE pattern (`parentPath.%`), ordered by path, with a limit parameter for pagination.

### Why Materialized Path?

- **Single query** to fetch entire subtree
- **Natural sort order** when ordering by path
- **Depth included** for indentation without parsing
- **Trade-off**: Moving comments requires updating all descendant paths (but moves are extremely rare on Reddit-like platforms)

---

## 5. Deep Dive: Ranking Algorithms (6 minutes)

### Hot Algorithm

Reddit's classic hot algorithm balances recency with popularity:

1. Compute the net score (upvotes - downvotes)
2. Take the log base 10 of the absolute score (minimum 1) to get the "order of magnitude"
3. Determine the sign (+1, -1, or 0)
4. Compute seconds since the Reddit epoch (December 8, 2005)
5. Final formula: `sign * order + seconds / 45000`

The divisor of 45000 (12.5 hours) means an older post needs exponentially more votes to compete.

**Key insight**: A 12-hour-old post with 10 upvotes has the same hot score as a brand new post with 1 upvote.

### Controversial Algorithm

Surfaces content with high engagement but balanced votes:

1. If either upvotes or downvotes is zero, return 0 (no controversy)
2. Compute magnitude as total votes (upvotes + downvotes)
3. Compute balance as the ratio of the smaller count to the larger count
4. Final score: `magnitude * balance`

A post with 100 up / 100 down scores higher than 1000 up / 10 down.

### Precomputation Strategy with Redis Sorted Sets

A background job runs every 5 minutes to precompute hot scores:

1. **Select recent posts** — query posts created in the last 7 days that are not archived
2. **Calculate hot score** for each post using the algorithm above
3. **Store in Redis sorted sets** — add each post ID with its hot score to a subreddit-specific sorted set (`r:{subredditId}:hot`) using a Redis pipeline for efficiency
4. **Persist scores** — also store individual scores in Redis string keys for reference

**Retrieving hot posts** is then an O(log N) operation: use `ZREVRANGE` on the subreddit's sorted set with offset and limit for pagination.

**Cleanup**: Old entries are removed from sorted sets by computing the hot score for a 7-day-old post with zero votes and using `ZREMRANGEBYSCORE` to remove everything below that threshold.

---

## 6. Deep Dive: Karma and User Aggregation (4 minutes)

### Karma Calculation

Karma is calculated per user by summing the direction values of all votes on their posts (post karma) and all votes on their comments (comment karma). These are written to denormalized columns on the users table.

A **batch update job** runs every 5 minutes: it identifies users whose content received votes in the last 5 minutes by joining the votes table with posts and comments, then recalculates their karma from the authoritative vote data.

---

## 6b. Deep Dive: The Comment Tree

Comments are the second data structure here that fights the relational model, and the choice of representation decides what a thread costs to read.

**Storage is a materialized path** — each comment carries a `path` like `"12.47.103"` plus a denormalized `depth`, with the column indexed using `varchar_pattern_ops` so `WHERE path LIKE '12.47.%'` is a range scan rather than a sequential filter. Fetching any subtree at any depth is one query.

| Approach | Fetching a 15-deep thread | Cost |
|----------|---------------------------|------|
| ✅ Materialized path | One indexed range scan | Insert takes two statements; depth capped by the column width |
| ❌ Adjacency list + recursive CTE | 15 sequential index probes | Latency scales with depth — the exact dimension that makes a thread interesting |
| ❌ Nested sets | One range scan | Every insert rewrites half the tree's bounds |

> "The reason adjacency list loses isn't that a recursive CTE is slow in the abstract — it's that the levels are inherently sequential. Each level's ids are the input to the next, so you cannot parallelize them and cannot batch them. A deep thread is precisely the one people want to read, and it's the one that gets slower."

**What the path costs is real.** `VARCHAR(255)` caps depth at roughly 40–60 levels depending on how wide the ids get. Creating a comment takes two statements inside a transaction — insert with an empty path, then update once the serial id is known — because the path contains the row's own id. And moving a subtree would mean rewriting every descendant's path, which is only acceptable because comments are never re-parented here.

**The assembly step is the honest weak point.** The API loads every comment on a post and builds the tree in Node. Materialized path makes *partial* subtree fetches cheap, so that's leaving the main advantage on the table — a post with 5,000 comments serialises all 5,000 to render a screen showing perhaps forty. The right unit of pagination is the open question: top-level comments with collapsed replies, or a depth cap with explicit "load more" per branch.

**Sorting is a per-request SQL expression, not a stored column.** "Best" is an inlined Wilson lower bound, which is the correct statistic for the question a comment sort actually asks: not "what is the average rating" but "what is the lowest plausible true rating given this many votes." A comment at 5 upvotes and 0 downvotes should not outrank one at 400 and 20, and a raw ratio says it does. That's the same reasoning as the hot score — except Wilson has no time term, so unlike `hot_score` it needs no materialization and no sweeper. It is correct the instant the row is written.

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Vote storage | Async aggregation | 5-30s delay for scores | Direct UPDATE (contention) |
| Comment tree | Materialized path | Move requires subtree update | Closure table (more storage) |
| Hot scores | Precomputed sorted sets | 5min staleness | On-demand calc (CPU intensive) |
| Database | PostgreSQL | Scaling requires sharding | Cassandra (easier sharding) |
| Karma | Background batch | Stale by minutes | Real-time (expensive) |

---

## 7b. Deep Dive: Why Only "Hot" Gets a Materialized Column

Four feed sorts exist and exactly one of them needs background machinery. The asymmetry is the point, not an oversight.

| Sort | Formula depends on | Needs a sweeper? |
|------|--------------------|------------------|
| top | `score` — a stored column | No |
| controversial | `(ups+downs) × min/max` — inline SQL over stored columns | No |
| new | `created_at` | No |
| **hot** | `log₁₀(score)` **+ a term in elapsed time** | **Yes** |

`top` and `controversial` are pure functions of columns that change only when a vote arrives. The write that changes the inputs is the same write that makes the new ordering correct — there is nothing to recompute later, so they can be inline expressions and remain exactly right.

`hot` is different in kind because it has a time term. **Its correct ordering changes even when nobody touches anything.** A post's rank drifts downward while the server is idle, and no write exists to hang that recomputation off. That's the entire reason a sweeper exists, and it's why the sweep is bounded to posts from the last 7 days: for anything older, the log term would have to move by a full order of magnitude to reorder it against the elapsed-time term, which effectively never happens.

> "The generalisable rule I'd take from this: materialize a ranking only when its inputs include something that changes without a write. Everything else should be computed from stored columns at query time, because a stored copy of a pure function of other columns is just a cache you now have to invalidate. Time is the one input you can't get a write notification for."

**What we give up** is that rank is stale by up to the sweep interval for posts whose only change is the passage of time, and the sweep is a row-at-a-time `UPDATE` rather than a batched statement — fine at seed scale, and the first thing to fix under real volume. The alternative that removes the sweeper entirely is a Redis sorted set the API reads directly, which trades the staleness for keeping two stores in agreement.

## 8. Database Partitioning Strategy

### Vote Table Partitioning

The votes table is range-partitioned by `created_at` with monthly partitions (e.g., `votes_2024_01` for January 2024, `votes_2024_02` for February). This enables efficient archival: the entire partition can be exported to cold storage (MinIO) as compressed JSON and then dropped, without affecting active partitions.

### Archival Worker

The archival worker handles partitions older than a configurable threshold (default 12 months):

1. Determine the partition name from the cutoff date (e.g., `votes_2024_01`)
2. Export all rows from that partition
3. Compress and upload to MinIO cold storage at `archives/votes/{partitionName}.json.gz`
4. Drop the partition after confirming the upload succeeded

---

## 8b. Vote Uniqueness Belongs in the Schema

Preventing a user from voting twice looks like handler logic and isn't. The read-then-write version — check for an existing vote, insert if absent — is a textbook race: two concurrent requests from the same user both see nothing, both insert, and the user has now voted twice with no error raised anywhere and no log line to find later.

So it's a constraint: `UNIQUE(user_id, post_id)`, `UNIQUE(user_id, comment_id)`, plus a `CHECK` that exactly one of the two target columns is non-null. That makes the bad state unrepresentable regardless of concurrency, request ordering, or how many API instances are running — which is the property application logic cannot give you.

| Guard | Survives concurrent duplicate requests? | Survives a second API instance? |
|-------|----------------------------------------|--------------------------------|
| ✅ Unique constraint | Yes — one insert wins, the other errors | Yes |
| ❌ Read-then-write in the handler | No | No |
| ❌ Application-level lock | Yes | Only with a *distributed* lock, which is a new dependency |

> "The trade I'd name is that this makes 'change my vote' awkward. Because the mutual-exclusion `CHECK` forbids setting both target columns, the insert needs a dynamically chosen column, and switching an upvote to a downvote becomes a SELECT-then-UPDATE rather than a clean upsert. That's uglier code in exchange for an invariant the database enforces. For something that directly determines content ranking, I'll take the ugly code."

## 9. Metrics and Observability

We track four Prometheus metrics:

- **reddit_votes_total** (Counter) — total votes cast, labeled by direction (up/down) and target type (post/comment)
- **reddit_vote_aggregation_lag_seconds** (Gauge) — time since the last vote aggregation completed, for monitoring freshness
- **reddit_hot_score_calculation_duration_seconds** (Histogram) — time to compute hot scores for all recent posts, with buckets from 0.1s to 30s
- **reddit_comment_tree_depth** (Histogram) — observed nesting depth of comments, with buckets from 1 to 50

---

## 9b. What Breaks First

Ordered by what I'd actually expect to hit, given the decisions above:

1. **A hot post's `UPDATE posts SET score`.** Synchronous aggregation means every voter on one post serializes on that row. This is the first thing to bind, and the fix — Redis `INCR` counters flushed periodically — is deliberately not built, because feeling the contention is the point of the exercise.
2. **The 60-second ranking sweep**, updating every post from the last 7 days one row at a time. Batching into a single `UPDATE … FROM (VALUES …)` buys a lot before the sweeper needs to go away entirely.
3. **`buildCommentTree` loading whole threads into Node.** Materialized path already makes partial fetches cheap; this is unrealized headroom rather than a design flaw.
4. **Karma recomputation on every vote**, which puts two extra queries on the hot path to keep a number second-accurate that nobody needs second-accurate. A periodic rollup is the obvious trade.

> "The pattern worth noticing is that three of those four are the *same* decision — do the work synchronously so the response is correct on write — and that decision was right for the user experience in each case. They don't fail independently; they'll all start hurting at roughly the same traffic level, which is when this system stops being one Postgres and starts needing a counter store."

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
