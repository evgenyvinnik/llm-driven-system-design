# Twitter - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## ✅ 1. Requirements Clarification (3 minutes)

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

## 🏗️ 2. High-Level Architecture (5 minutes)

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

## 🧮 Capacity Estimation

Two numbers decide the whole architecture, so I want them on the table before
the design.

| Metric | Estimate | Derivation |
|--------|----------|------------|
| Daily active users | 200M | — |
| Tweets/day | 200M | ~1 per DAU |
| Tweet write rate | **2.3K/s** avg, ~12K/s peak | 200M ÷ 86,400, ×5 for peak |
| Timeline reads | **230K/s** | 100:1 read:write |
| Avg followers | ~200 | long-tail distribution |
| Fanout writes | **~460K/s** average | write rate × avg followers |
| Tweet storage | ~60 GB/day raw | 200M × ~300 bytes |

The ratio that matters isn't the tweet rate — 2.3K writes/s is unremarkable and
a single Postgres node would manage it. It's the **fanout amplification**: each
of those writes becomes ~200 timeline insertions, so the system is really doing
half a million writes per second, and that's the *average*. The distribution is
what breaks it.

> "Average followers is a useless statistic here, and saying so is half the
> design. The distribution is extremely long-tailed — the median user has a few
> hundred followers, and a handful have tens of millions. If I size fanout
> against the average I'll be right for 99.9% of tweets and catastrophically
> wrong for the ones that matter most, because the accounts with 50M followers
> are also the ones whose tweets people are waiting for. Any architecture that
> treats all users the same is choosing to fail on the visible cases."

### Read path

At 230K timeline reads/s, the timeline cannot be a query. Assembling a timeline
by joining follows to tweets and sorting means touching hundreds of partitions
per request, at a rate three orders of magnitude above the write rate. The
timeline has to be a **precomputed list** that a read simply slices — which is
what makes fanout-on-write attractive, and what makes the celebrity case a
genuine dilemma rather than a detail.

### Memory for cached timelines

Holding ~800 tweet IDs per active user, at 8 bytes each plus overhead, is
roughly 10 KB per user. For 200M DAU that's ~2 TB of Redis — real money, and
the reason timelines are capped rather than unbounded, and why inactive users
are evicted rather than maintained.

---

## 📈 Scalability: What Breaks First

1. **Celebrity fanout** is the first and most visible failure. A 50M-follower
   account at 10K writes/s takes 83 minutes to fan out — the tweet is stale
   before most followers receive it. This is why the design is hybrid rather
   than pure push: above a follower threshold, we stop pushing and let readers
   pull. The threshold is the tuning knob, and it's a genuine trade — lower it
   and read cost rises for everyone following those accounts; raise it and
   fanout latency spikes.

2. **Redis memory for timelines** goes next, at ~2 TB for the active set. Fixes
   in order of cost: cap timeline length (800 entries covers any realistic
   scroll), evict inactive users and rebuild lazily on their return, then shard
   the timeline cache by user ID.

3. **The tweets table** — 60 GB/day of raw tweets, before indexes and
   replication. Partition by time so recent data stays hot and old partitions
   can move to cheaper storage; a timeline read almost never reaches back past
   the newest partition.

4. **Trend computation** is last and least urgent, because it degrades
   gracefully: trends that are five minutes stale are still useful, whereas a
   timeline that's five minutes stale is broken. That asymmetry is why trends
   run off a sampled stream rather than every tweet.

> "The ordering matters as much as the list. Celebrity fanout breaks first *and*
> it's the one users notice, so it gets architectural treatment — a whole second
> code path — rather than a tuning parameter. Trend staleness breaks last and
> nobody notices, so it gets sampling. I'd rather spend complexity where the
> failure is visible."

---


## 🔧 3. Deep Dive: The Fanout Problem and Hybrid Solution (10 minutes)

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

The fanout worker consumes `tweet.created` events from Kafka and processes them as follows:

1. Look up the tweet author. If they are flagged as a celebrity, skip fanout entirely -- their tweets are handled at read time.
2. Retrieve the author's full follower list.
3. Use a Redis pipeline (batch operation) to push the tweet ID to the front of each follower's timeline list (`timeline:{followerId}`) and trim the list to a maximum of 800 entries.
4. Execute the pipeline atomically.

For a normal user with 500 followers, this completes in under 1 second.

**Timeline Read (Merge cached + celebrity tweets)**:

Reading the home timeline is a four-step merge process:

1. **Fetch cached timeline**: Read the first 100 tweet IDs from the user's Redis timeline list (these were pushed by normal users' fanout workers), then batch-fetch the full tweet objects.
2. **Identify followed celebrities**: From the user's following list, filter to those with the `is_celebrity` flag.
3. **Pull celebrity tweets**: Query PostgreSQL for recent tweets (last 24 hours) from those celebrity authors, ordered by creation time, limited to 50.
4. **Merge and sort**: Combine cached tweets and celebrity tweets into one list, sort chronologically (newest first), and return the top 100.

> "The merge step adds roughly 10ms since it happens in-memory. The key insight is that we only query the database for the small number of celebrities a user follows (typically 10-50), not for every followed account."

### Celebrity Detection via Triggers

Celebrity status is automatically managed via a database trigger on the follows table. After each insert or delete on follows, the trigger updates the `is_celebrity` flag on the followed user by checking whether their `follower_count` has reached or fallen below the 10,000 threshold. This keeps the celebrity flag consistent without requiring application-level logic.

### Why This Works

- **Normal users**: 500 followers = 500 Redis writes (< 1 second)
- **Celebrities**: 0 fanout writes, ~100 DB queries merged at read time
- **Read latency**: Merge is in-memory, adds ~10ms

---

## 💾 4. Database Schema and Indexing (8 minutes)

### Core Tables

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **users** | id (SERIAL PK), username (UNIQUE), email (UNIQUE), password_hash, display_name, bio, follower_count, following_count, tweet_count, is_celebrity (BOOLEAN, auto-set via trigger at 10K followers), created_at | -- | Counts are denormalized and maintained by triggers for O(1) reads |
| **tweets** | id (BIGSERIAL PK), author_id (FK to users ON DELETE CASCADE), content (VARCHAR 280), media_urls (TEXT[]), hashtags (TEXT[], extracted at write time), mentions (INTEGER[]), reply_to (FK to tweets), retweet_of (FK to tweets), like_count, retweet_count, reply_count, is_deleted, deleted_at, created_at | (author_id, created_at DESC) for author timeline; GIN on hashtags for hashtag search; created_at DESC for explore/trending; partial index on deleted_at WHERE NOT NULL | Soft delete via is_deleted flag; engagement counts denormalized |
| **follows** | follower_id + following_id (composite PK, both FK to users ON DELETE CASCADE), created_at | Index on following_id; index on follower_id | Social graph edges; triggers maintain user counts |
| **likes** | user_id + tweet_id (composite PK, both FK with ON DELETE CASCADE), created_at | Index on tweet_id; index on user_id | Composite PK prevents duplicate likes |
| **retweets** | user_id + tweet_id (composite PK, both FK with ON DELETE CASCADE), created_at | -- | Same structure as likes |

### Index Strategy

Key indexes beyond the primary keys:

- **Author timeline**: Composite index on tweets(author_id, created_at DESC) for fast retrieval of a user's own tweets
- **Hashtag search**: GIN index on tweets(hashtags) for efficient array-contains queries
- **Global chronological**: Index on tweets(created_at DESC) for explore and trending feeds
- **Soft delete filtering**: Partial index on tweets(deleted_at) WHERE deleted_at IS NOT NULL for efficient cleanup queries
- **Social graph bidirectional**: Indexes on follows(following_id) and follows(follower_id) for both "who follows me" and "who do I follow" lookups
- **Engagement lookups**: Indexes on likes(tweet_id) and likes(user_id) for counting and checking if a user has liked a tweet

### Denormalized Count Triggers

A single trigger function fires after every INSERT or DELETE on the follows table. On INSERT, it increments `following_count` for the follower, increments `follower_count` for the followed user, and recalculates the `is_celebrity` flag (true when follower_count >= 10,000). On DELETE, it decrements both counts and recalculates celebrity status. This ensures counts are always consistent without requiring application-level coordination.

---

## ⚡ 5. Deep Dive: Redis Caching Strategy (5 minutes)

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

When a user follows someone, we write to both PostgreSQL (source of truth) and Redis (cache for fast lookups). The follow relationship is stored in two Redis sets: `followers:{followingId}` gains the follower, and `following:{followerId}` gains the followed user.

To check if user A follows user B, we first check the Redis set `following:{userA}` for membership. If Redis is unavailable or returns no result, we fall back to a PostgreSQL query on the follows table. This gives us O(1) follow-check latency in the common case.

### Timeline Cache Management

**Fanout on tweet creation:** When a tweet is created, the fanout worker reads the author's follower set from Redis, then uses a Redis pipeline to push the tweet ID to the front of each follower's timeline list, trim each list to 800 entries, and set a 7-day expiry. The pipeline executes all operations in a single round trip.

**Cache miss rebuild:** If a user's timeline cache has expired or is empty, we rebuild it by querying PostgreSQL: join follows with users to get all non-celebrity accounts the user follows, then fetch the most recent 800 tweet IDs from those authors (excluding deleted tweets). The result is written back to Redis with a 7-day TTL.

---

## 📈 6. Deep Dive: Real-Time Trend Detection (5 minutes)

### Sliding Window Algorithm

Hashtag counts are tracked in 1-minute time buckets over a 60-minute sliding window:

1. **Recording**: When a hashtag appears in a tweet, increment a Redis counter at `trend:{hashtag}:{bucket}` where bucket is the current minute (Unix timestamp divided by 60). Each key gets a TTL equal to the window size (60 minutes) so old buckets expire automatically.

2. **Scoring**: To compute a trend score, read the counters for all 60 buckets using a Redis pipeline. Apply exponential decay so recent buckets weigh more: `score = sum(count[i] * 0.95^i)` where i=0 is the current minute and i=59 is the oldest. This means a hashtag mentioned 100 times in the last minute scores higher than one mentioned 100 times an hour ago.

### Velocity Calculation

Velocity measures the growth rate: `(currentHourCount - previousHourCount) / previousHourCount`. If the previous hour had zero mentions but the current hour has more than 10, we treat velocity as infinite (a new topic breaking through). Topics with velocity > 2 (200% growth) are considered "trending."

To generate the trending list, we query PostgreSQL for all distinct hashtags appearing in tweets from the last 2 hours, compute the trend score for each using the sliding window algorithm, filter to those with a score above 100 (minimum visibility threshold), sort by score descending, and return the top 10.

---

## 🛡️ 7. Failure Handling and Resilience (5 minutes)

### Idempotency Keys for Tweet Creation

Tweet creation uses idempotency keys to prevent duplicate posts from client retries:

1. Check Redis for a cached result under `idempotency:tweet:{userId}:{key}`. If found, return the cached tweet immediately.
2. Insert the tweet into PostgreSQL with the extracted hashtags.
3. Cache the result in Redis with a 24-hour TTL.
4. Publish a `tweet.created` event to Kafka for async fanout processing.
5. Return the new tweet to the client.

### Circuit Breaker for Fanout

The fanout service uses a circuit breaker with three states: CLOSED (normal operation), OPEN (all requests fail fast), and HALF_OPEN (testing recovery). Configuration: failure threshold of 5, reset timeout of 30 seconds.

In CLOSED state, each failure increments a counter. When 5 failures accumulate, the circuit transitions to OPEN. In OPEN state, all calls throw immediately without attempting the operation. After 30 seconds, the circuit moves to HALF_OPEN and allows one test request through. If it succeeds, the circuit returns to CLOSED and resets the failure counter. If it fails, the circuit returns to OPEN.

The fanout worker wraps all timeline push operations through this circuit breaker, so a Redis outage causes fast failure rather than blocking the entire fanout pipeline.

### Graceful Degradation

The home timeline endpoint implements a fallback chain: it first attempts to read from the Redis timeline cache (fast path). If Redis is unavailable, it falls back to a direct PostgreSQL query -- fetching the user's following list from the follows table, then querying tweets by those authors (excluding deleted tweets), ordered chronologically, limited to 100. This is slower but functional, ensuring the timeline remains available even during a Redis outage.

---

## 📌 8. Summary (3 minutes)

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
