# Design Twitter - Architecture

## System Overview

Twitter is a real-time microblogging platform where the core challenge is delivering tweets to followers' timelines efficiently. With celebrity users having millions of followers, naive approaches fail at scale. The system must handle asymmetric follow graphs (one user followed by millions), real-time trend detection across hundreds of millions of daily tweets, and sub-second timeline delivery.

**Learning Goals:**
- Understand fanout strategies (push vs pull vs hybrid)
- Design social graph storage and queries
- Build real-time trend detection
- Handle the "celebrity problem"

---

## Requirements

### Functional Requirements

1. **Tweet**: Post 280-character messages with optional media attachments
2. **Follow**: Subscribe to other users' content (asymmetric relationship)
3. **Timeline**: View chronological feed of followed users' tweets
4. **Trending**: See popular topics computed in real-time
5. **Engagement**: Like, retweet, and reply to tweets
6. **Notifications**: Alerts for mentions, likes, retweets

### Non-Functional Requirements

- **Latency**: < 200ms for timeline load (p99), < 50ms for tweet reads
- **Availability**: 99.99% uptime (< 53 minutes downtime/year)
- **Scale**: 500M users, 500M tweets/day, 150B timeline reads/day
- **Consistency**: Eventual (users can tolerate slight delays in timeline propagation)
- **Durability**: Zero tweet loss once acknowledged

---

## Capacity Estimation

### Production Scale

- **Daily Active Users**: 200M
- **Tweets/day**: 500M (~5,800 tweets/second average, ~30K/s peak)
- **Timeline reads/day**: 150B (~1.7M reads/second)
- **Average followers**: 200
- **Celebrity users** (>10K followers): ~500K users
- **Media tweets**: ~30% of tweets include images/video

**Storage (per year)**:
- Tweet text: 500M/day * 280 bytes * 365 = ~50 TB
- Media: 150M media tweets/day * 2 MB average = ~100 PB (with transcoded variants)
- Timeline cache (Redis): 200M active users * 800 tweet IDs * 8 bytes = ~1.2 TB

### Local Development Scale

- **Users**: 1,000
- **Tweets**: 10,000
- **Follows**: 50,000 relationships
- **Timeline reads**: ~100/second
- **Storage**: ~50 MB

---

# Layer 1: Production-Ready Architecture

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Client Layer                                    │
│                  Web (React SPA)  /  Mobile (iOS, Android)                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           CDN (CloudFront/Akamai)                            │
│              Static assets, media delivery, edge caching                     │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     API Gateway / Load Balancer (L7)                         │
│            Rate limiting, auth validation, request routing                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
          ┌────────────┬────────────┼────────────┬────────────┐
          ▼            ▼            ▼            ▼            ▼
   ┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌────────────┐
   │   Tweet    ││  Timeline  ││   Social   ││   Trend    ││   Media    │
   │  Service   ││  Service   ││   Graph    ││  Service   ││  Service   │
   │            ││            ││  Service   ││            ││            │
   │ Create/    ││ Build home ││ Follow/    ││ Real-time  ││ Upload,    │
   │ read/      ││ timeline,  ││ unfollow,  ││ trending   ││ transcode, │
   │ delete     ││ merge      ││ follower   ││ topics     ││ serve      │
   └────────────┘└────────────┘│ lists      │└────────────┘└────────────┘
          │            │       └────────────┘       │            │
          ▼            ▼            │                ▼            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Kafka Event Bus                                       │
│     Topics: tweet.created, tweet.deleted, follow.new, like.created,          │
│             notification.send, analytics.event                               │
└──────────────────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
   ┌────────────┐       ┌────────────┐       ┌────────────┐
   │  Fanout    │       │Notification│       │ Analytics  │
   │  Workers   │       │  Service   │       │  Pipeline  │
   │            │       │            │       │            │
   │ Push to    │       │ Push notif │       │ Event      │
   │ timeline   │       │ via SSE/   │       │ aggregation│
   │ caches     │       │ WebSocket  │       │ & metrics  │
   └────────────┘       └────────────┘       └────────────┘
          │                                        │
          ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Data Layer                                      │
├──────────────┬──────────────┬──────────────┬──────────────┬──────────────────┤
│  PostgreSQL  │    Redis     │Elasticsearch │  Object      │   ClickHouse     │
│  (sharded)   │   Cluster    │              │  Storage     │                  │
│              │              │              │  (S3)        │                  │
│ Users,       │ Timeline     │ Full-text    │ Images,      │ Analytics,       │
│ tweets,      │ cache,       │ tweet        │ videos,      │ engagement       │
│ follows,     │ sessions,    │ search,      │ avatars      │ metrics          │
│ likes        │ trend        │ hashtag      │              │                  │
│              │ counters     │ indexing     │              │                  │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────────┘
```

---

## Core Components

### 1. Tweet Ingestion Pipeline (Write Path)

When a user posts a tweet, the write path must persist the tweet and eventually deliver it to all followers' timelines. The key insight is decoupling the write acknowledgment from the fanout -- the user sees "Tweet posted" immediately while fanout happens asynchronously.

**Write flow:**
1. Client sends tweet to Tweet Service via API Gateway
2. Tweet Service validates content (280 chars, media references), persists to PostgreSQL, returns 201 to client
3. Tweet Service publishes `tweet.created` event to Kafka (partitioned by author_id for ordering)
4. Fanout Workers consume from Kafka and push tweet IDs to followers' Redis timeline caches
5. Trend Service consumes the same event to update hashtag counters
6. Notification Service consumes to generate mention/reply alerts

**Hybrid fanout strategy:**

The fanout strategy depends on the author's follower count:

| User Type | Followers | Fanout Strategy | Rationale |
|-----------|-----------|-----------------|-----------|
| Normal | < 10K | Push (fanout on write) | O(followers) writes, but O(1) reads |
| Celebrity | >= 10K | Pull (fanout on read) | Avoids 50M-write storms |

For a normal user with 500 followers, the fanout worker writes 500 Redis `LPUSH` commands in a pipeline -- completing in < 50ms. For a celebrity with 50M followers, pushing would take 50M writes. At 100K writes/second, that is 8+ minutes per tweet. Instead, celebrity tweets are pulled at read time: when a user opens their timeline, the Timeline Service merges their cached timeline (pushed tweets) with the latest tweets from any celebrities they follow.

**Fanout worker details:**
- Consumer group of 50-100 worker instances
- Each worker receives `tweet.created` events from Kafka
- Checks if author is celebrity (via cached user metadata)
- If not celebrity: fetches follower list, pipelines `LPUSH timeline:{followerId} tweetId` + `LTRIM` to cap at 800 entries
- If celebrity: skips fanout, logs for monitoring
- Circuit breaker protects against Redis overload; failed fanouts queue to a retry list

### 2. Timeline Service (Read Path)

The Timeline Service assembles the home timeline for a given user. It is the most latency-sensitive path in the system.

**Read flow:**
1. Client requests `GET /api/timeline/home`
2. Timeline Service reads the user's cached tweet IDs from Redis (`LRANGE timeline:{userId} 0 99`)
3. Fetches the followed celebrities list (cached in Redis or queried from Social Graph Service)
4. Pulls latest 50 tweets from each celebrity from the Tweet Service (or directly from a per-celebrity Redis sorted set)
5. Merges cached + celebrity tweets, deduplicates by tweet ID, sorts by `created_at` descending
6. Hydrates tweet objects: fetches full tweet data, author info, engagement counts, and the requesting user's like/retweet status
7. Returns paginated results with cursor for infinite scroll

**Why materialized timelines in Redis:**
- Timeline reads vastly outnumber writes (300:1 ratio)
- Redis `LRANGE` on a pre-built list is O(1) amortized, versus building the timeline on every read from a follows+tweets join which would be O(following * tweets_per_user)
- Redis lists with `LTRIM` naturally cap memory usage per user
- 7-day TTL auto-expires timelines for inactive users, keeping memory bounded

**Multi-layer caching:**

| Layer | What | TTL | Hit Rate |
|-------|------|-----|----------|
| CDN edge | Static assets, profile images | 24h | ~95% |
| Application cache (Redis) | Timeline lists, user metadata, follower sets | 7 days | ~90% |
| Database cache (PgBouncer) | Connection pooling, prepared statement cache | Session | N/A |

### 3. Search (Elasticsearch)

Full-text search requires an inverted index, which PostgreSQL's GIN indexes can handle at small scale but not at 500M tweets/day.

**Search architecture:**
- Tweet Service publishes `tweet.created` events to Kafka
- Search indexer consumer writes to Elasticsearch with fields: `content`, `hashtags`, `author_username`, `created_at`, `engagement_score`
- Hashtags are indexed as keywords (exact match), content uses a custom analyzer with stopword removal and stemming
- Search queries fan out to multiple Elasticsearch shards in parallel, results merged by relevance score
- Recent tweets are boosted (decay function on `created_at`) to prioritize fresh content

**Hashtag indexing:**
- Hashtags extracted at write time via regex (`/#\w+/g`)
- Stored in the tweet's `hashtags` array column (PostgreSQL) and as keyword fields in Elasticsearch
- Hashtag timeline queries (`/timeline/hashtag/:tag`) hit Elasticsearch for ranked results or PostgreSQL's GIN index for chronological results

### 4. Trend Detection

Trending topics must surface hashtags that are accelerating in usage, not just popular. A hashtag used 10K times/hour that was used 10K times last hour is not trending; one used 5K times this hour but only 100 last hour is.

**Sliding window with exponential decay:**
- Time is divided into 1-minute buckets
- Each tweet increments `trend:{hashtag}:{bucket}` in Redis with `INCR` + `EXPIRE` (2-hour TTL)
- Trend scoring: sum counts across the 60-minute window with exponential decay: `score = sum(count[i] * 0.95^i)` where `i` is the age in minutes
- Trend velocity: `(current_hour_count - previous_hour_count) / previous_hour_count` -- rising velocity indicates emerging trends

**Count-Min Sketch (production optimization):**
At production scale, tracking every hashtag as individual Redis keys is memory-expensive. A Count-Min Sketch provides approximate frequency counts in constant space. The sketch is maintained per time bucket and queried to filter hashtags above a minimum threshold before doing exact counting.

**Trend worker:**
- Runs every 60 seconds
- Scans Redis for `trend:*:*` keys, calculates scores with decay
- Stores top 50 trends in a `trending:current` sorted set (5-minute TTL for cache)
- Cleans up expired buckets older than 2 hours

### 5. Kafka Event Processing

Kafka serves as the central nervous system, decoupling tweet creation from downstream effects.

**Topics and consumers:**

| Topic | Producer | Consumers | Partitions |
|-------|----------|-----------|------------|
| `tweet.created` | Tweet Service | Fanout Workers, Trend Service, Search Indexer, Analytics | 64 (by author_id) |
| `tweet.deleted` | Tweet Service | Fanout Workers (remove from caches), Search Indexer | 16 |
| `follow.new` | Social Graph | Fanout Workers (backfill timeline), Notification | 32 |
| `like.created` | Tweet Service | Notification, Analytics | 32 |

**Partitioning by author_id** ensures all tweets from the same user are processed in order within a partition, preventing timeline ordering anomalies.

**At-least-once delivery:** Kafka guarantees at-least-once delivery. Fanout operations are idempotent (LPUSH of the same tweet ID to a timeline list creates a duplicate, but deduplication at read time filters it). For non-idempotent operations (analytics counters), consumers use Kafka consumer offsets with manual commit after successful processing.

### 6. Database Architecture

**Sharding strategy:**
- **Tweets**: Sharded by `tweet_id` (hash-based). This distributes write load evenly since tweet IDs are auto-incrementing. Timeline queries use the Redis cache (not the tweet shard directly), so cross-shard reads are limited to hydration.
- **Users**: Sharded by `user_id`. Profile reads are single-shard lookups.
- **Follows (Social Graph)**: Sharded by `follower_id`. This optimizes the common query "who does user X follow?" which drives timeline assembly. The reverse query "who follows user X?" requires a secondary index or a reverse-sharded replica.

**Schema:**

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  bio TEXT,
  avatar_url TEXT,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  tweet_count INTEGER DEFAULT 0,
  is_celebrity BOOLEAN DEFAULT FALSE,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tweets (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content VARCHAR(280) NOT NULL,
  media_urls TEXT[],
  hashtags TEXT[],
  mentions INTEGER[],
  reply_to BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  retweet_of BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  quote_of BIGINT REFERENCES tweets(id) ON DELETE SET NULL,
  like_count INTEGER DEFAULT 0,
  retweet_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tweets_author ON tweets(author_id, created_at DESC);
CREATE INDEX idx_tweets_hashtags ON tweets USING GIN(hashtags);
CREATE INDEX idx_tweets_created_at ON tweets(created_at DESC);
CREATE INDEX idx_tweets_reply_to ON tweets(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX idx_tweets_deleted ON tweets(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE follows (
  follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX idx_follows_following ON follows(following_id);

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

CREATE TABLE hashtag_activity (
  id BIGSERIAL PRIMARY KEY,
  hashtag VARCHAR(100) NOT NULL,
  tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_hashtag_activity_hashtag ON hashtag_activity(hashtag, created_at DESC);
```

**Denormalized counts via triggers:**
Follower counts, tweet counts, like counts, and retweet counts are maintained by PostgreSQL triggers that fire on INSERT/DELETE to the respective tables. This avoids expensive `COUNT(*)` aggregations on every profile or tweet view. The `is_celebrity` flag is auto-set when `follower_count >= 10000`.

### 7. Media Pipeline

**Upload flow:**
1. Client requests a pre-signed upload URL from the Media Service
2. Client uploads directly to object storage (S3) -- bypasses API servers
3. Client sends the media key to the Tweet Service when composing the tweet
4. Media Service asynchronously transcodes images (thumbnails, WebP variants) and videos (HLS segments at multiple bitrates)
5. CDN serves media from edge locations with long cache TTLs

**Production considerations:**
- Images: resize to 3 variants (thumb 150px, small 680px, large 1200px), convert to WebP
- Videos: transcode to HLS with 3 quality levels (360p, 720p, 1080p), generate preview thumbnails
- Content moderation: ML pipeline scans uploaded media for policy violations before the tweet becomes visible

### 8. Rate Limiting and Abuse Detection

**Rate limits (per user):**

| Action | Limit | Window |
|--------|-------|--------|
| Tweet creation | 300 tweets | 3 hours |
| Like/retweet | 1,000 actions | 24 hours |
| Follow | 400 follows | 24 hours |
| API reads | 900 requests | 15 minutes |

**Implementation:** Token bucket algorithm in Redis. Each user has a key `ratelimit:{userId}:{action}` with an atomic `INCR` + `EXPIRE`. The API Gateway checks the counter before routing to backend services.

**Abuse detection:**
- Spam classifier on tweet content (ML model)
- Velocity checks: accounts creating tweets faster than humanly possible
- Bot detection: behavioral analysis (posting patterns, engagement ratios)
- Content moderation: automated flagging + human review queue

---

## API Design

```
# Authentication
POST   /api/auth/register       - Create account
POST   /api/auth/login          - Login, create session
POST   /api/auth/logout         - Destroy session
GET    /api/auth/me             - Current user profile

# Tweets
POST   /api/tweets              - Create tweet (with Idempotency-Key header)
GET    /api/tweets/:id          - Get single tweet
DELETE /api/tweets/:id          - Soft-delete tweet

# Engagement
POST   /api/tweets/:id/like     - Like a tweet
DELETE /api/tweets/:id/like     - Unlike a tweet
POST   /api/tweets/:id/retweet  - Retweet
DELETE /api/tweets/:id/retweet  - Undo retweet
GET    /api/tweets/:id/replies  - List replies

# Timeline
GET    /api/timeline/home       - Home timeline (hybrid fanout)
GET    /api/timeline/user/:username - User's tweets
GET    /api/timeline/explore    - Popular tweets (ranked by engagement)
GET    /api/timeline/hashtag/:tag - Tweets with hashtag

# Social
POST   /api/users/:id/follow    - Follow user
DELETE /api/users/:id/follow    - Unfollow user
GET    /api/users/:id/followers - List followers
GET    /api/users/:id/following - List following
GET    /api/users/:username     - User profile
GET    /api/users?q=term        - Search users

# Trends
GET    /api/trends              - Current trending topics
GET    /api/trends/all-time     - All-time popular hashtags
```

---

## Key Design Decisions

### 1. Hybrid Fanout (Push for Normal Users, Pull for Celebrities)

**Decision**: Push tweet IDs to follower timeline caches for users with < 10K followers; skip fanout for celebrities and pull their tweets at read time.

**Why push fails for celebrities**: A user with 50M followers tweeting triggers 50M Redis writes. At 100K writes/second, that takes 8+ minutes. During that window, followers see a stale timeline, the fanout queue backs up, and subsequent tweets from other users are delayed. The entire system degrades because of one celebrity tweet.

**Why pull fails for normal users**: If we use pure pull, every timeline read must query tweets from all followed users. A user following 500 accounts requires 500 queries (or a massive IN clause), sorted and merged. At 1.7M timeline reads/second, this overwhelms the database.

**Hybrid trade-off**: The read path becomes more complex -- the Timeline Service must merge two data sources (cached list + celebrity pull). This merge adds ~10-20ms latency compared to a pure cache read. But the alternative (fanout storms or read-time aggregation) is unacceptable. The threshold (10K followers) is configurable and can be tuned based on observed fanout latency.

### 2. Kafka for Event Streaming

**Decision**: All mutations produce events to Kafka. Fanout, trending, notifications, and analytics consume from Kafka independently.

**Why not direct calls**: If the Tweet Service called the Fanout Service synchronously, a fanout failure would fail the tweet creation. The user would see an error even though the tweet was persisted. Kafka decouples the tweet write (which must succeed) from fanout (which can be retried).

**Why not RabbitMQ**: Kafka provides ordered, durable, replayable event logs. If a fanout worker crashes, it resumes from its last committed offset. RabbitMQ would require separate dead-letter handling and lacks replay capability. For a system processing 500M tweets/day across multiple consumer groups, Kafka's partitioned log model is a better fit.

**Trade-off**: Kafka adds operational complexity (Zookeeper/KRaft, partition management, consumer group coordination). For a simpler system with lower throughput, RabbitMQ would be easier to operate.

### 3. Redis Lists for Timeline Cache

**Decision**: Store tweet IDs (not full tweet objects) in Redis lists, capped at 800 entries with 7-day TTL.

**Why IDs not objects**: Storing full tweet objects would consume ~10x more Redis memory. When a tweet's like count changes, we would need to update every timeline cache containing that tweet. With IDs, we hydrate at read time from a separate tweet cache, and engagement count updates are reflected automatically.

**Why 800 entries**: Users rarely scroll past 100 tweets. 800 provides 4x buffer for power users and ensures the cache covers a few days of content for active followed accounts. At 8 bytes per tweet ID, 800 entries = 6.4 KB per user. For 200M active users, that is ~1.2 TB -- fits in a Redis cluster.

**Trade-off**: If Redis is lost, timelines must be rebuilt from PostgreSQL. The `rebuildTimelineCache` function queries all followed non-celebrity users' tweets and reconstructs the list. This is slow (~5 seconds per user) but only needed after a Redis failure.

---

## Consistency and Idempotency

**Idempotency for tweet creation**: The client generates a UUID and sends it as the `Idempotency-Key` header. The server checks Redis for the key before processing. If found, returns the cached response. If not found, processes the request and caches the response with a 24-hour TTL. This prevents duplicate tweets when the client retries after a network timeout.

**Eventual consistency model**: A tweet may appear in some followers' timelines before others (fanout takes time). This is acceptable for a social feed. Users do not expect real-time consistency -- a few seconds of delay is imperceptible.

**Engagement count consistency**: Like and retweet counts are maintained by PostgreSQL triggers (atomic). The counts shown on a tweet may differ slightly from the actual count if a concurrent update is in flight, but the database is the source of truth.

---

## Observability

**Prometheus metrics exposed on `/metrics`:**
- `twitter_tweets_created_total` (counter, by status: success/error)
- `twitter_tweet_creation_duration_seconds` (histogram, by status)
- `twitter_timeline_latency_seconds` (histogram, by timeline_type and cache_hit)
- `twitter_fanout_operations_total` (counter, by status: success/error/skipped)
- `twitter_fanout_duration_seconds` (histogram, by follower_count_bucket)
- `twitter_fanout_queue_depth` (gauge)
- `twitter_circuit_breaker_state` (gauge, by circuit_name: 0=closed, 1=half-open, 2=open)
- `twitter_http_request_duration_seconds` (histogram, by method/route/status_code)
- `twitter_idempotency_cache_hits_total` (counter)
- `twitter_db_connection_pool_size` (gauge, by state: total/idle/waiting)
- `twitter_redis_connection_status` (gauge)

**Structured logging (Pino):**
- JSON format for machine parsing (ELK/Datadog)
- Request IDs for distributed tracing
- Child loggers attach context (tweetId, userId, operation) throughout the request lifecycle
- Log levels: debug (development), info (production), warn (degraded states), error (failures)

**Health check endpoints:**
- `/live` -- liveness probe (is the process running?)
- `/ready` -- readiness probe (can it serve traffic? checks PostgreSQL + Redis)
- `/health` -- detailed status (all dependency checks, circuit breaker states, pool sizes, latencies)

---

## Failure Handling

### Circuit Breakers (Opossum)

Circuit breakers protect the system when downstream dependencies fail.

**Redis fanout circuit breaker:**
- Timeout: 30s (bulk operations are slow)
- Error threshold: 60% failures before opening
- Reset timeout: 60s before testing recovery
- Fallback: queue failed fanouts to `fanout:retry_queue` in Redis for background processing

**State transitions:**
```
CLOSED (normal) ──[60% failures]──▶ OPEN (fail fast)
     ▲                                     │
     │                                     ▼
     └──[success after 60s]────── HALF_OPEN (testing)
```

When the circuit is OPEN, tweet creation still succeeds (the tweet is persisted to PostgreSQL), but fanout is deferred. Users experience slightly delayed timeline updates rather than total failure.

### Retry Strategy

Exponential backoff with jitter for transient failures:
- Max 3 attempts
- Base delay: 100ms, max delay: 5s
- Jitter: 20% randomization to prevent thundering herd
- Only retry on retryable errors (network timeouts, 503s), never on 4xx

### Graceful Degradation

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Redis down | No cached timelines | Fall back to PostgreSQL timeline query (slower) |
| Kafka down | No async fanout | Tweet creation still succeeds; fanout queued in Redis for later |
| Elasticsearch down | No search | Return empty results; hashtag timeline falls back to PostgreSQL GIN index |
| Trend service down | No trending topics | Return stale trends from cache or empty list |

### Data Retention

| Data Type | Hot Storage | TTL | Rationale |
|-----------|-------------|-----|-----------|
| Active tweets | PostgreSQL | Forever | Core user content |
| Soft-deleted tweets | PostgreSQL | 30 days | Allow recovery, then hard delete |
| Timeline cache | Redis | 7 days | Users rarely scroll beyond a week |
| Trend buckets | Redis | 2 hours | Trends are about recency |
| Idempotency keys | Redis | 24 hours | Protect against same-day retries |
| Sessions | Redis | 7 days | Auto-expire inactive sessions |

---

## Scalability Considerations

### What Breaks First

1. **Timeline read path** -- at 1.7M reads/second, Redis becomes the bottleneck. Solution: Redis Cluster with read replicas, shard timelines across nodes by `userId % num_shards`.
2. **Fanout workers** -- celebrity follows compound write amplification. Solution: increase Kafka partitions and worker count; raise the celebrity threshold dynamically.
3. **PostgreSQL writes** -- 5,800 tweet inserts/second on a single database. Solution: shard by `tweet_id`, use PgBouncer for connection pooling, batch inserts.
4. **Social graph queries** -- "who follows user X?" on a billion-row follows table. Solution: shard by `follower_id`, maintain a reverse-indexed replica for follower lookups.

### Horizontal Scaling Path

- **API servers**: Stateless, scale horizontally behind load balancer
- **Fanout workers**: Scale by adding Kafka consumer instances (up to partition count)
- **Redis**: Redis Cluster with automatic resharding
- **PostgreSQL**: Vitess or Citus for transparent sharding
- **Elasticsearch**: Add data nodes and increase shard count per index

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Fanout strategy | Hybrid push/pull | Pure push | Celebrity problem: 50M writes per tweet |
| Timeline storage | Redis lists (IDs only) | PostgreSQL materialized views | O(1) reads, bounded memory |
| Event streaming | Kafka | RabbitMQ | Ordered replay, multiple consumer groups |
| Graph storage | PostgreSQL + Redis cache | Neo4j | Simpler operations, sufficient for 2-hop queries |
| Search | Elasticsearch | PostgreSQL FTS | Better relevance scoring, horizontal scaling |
| Trend detection | Sliding window + decay | Batch MapReduce | Real-time detection, sub-minute latency |
| Auth | Session + Redis | JWT | Immediate revocation, simpler |
| Counts | Database triggers | Application-level updates | Atomic, consistent, no race conditions |

---

# Layer 2: Pocket-Size Architecture (What We Actually Built)

## Local Architecture

```
┌──────────────────────────────────────────────────┐
│            Frontend (React + Vite)                │
│            http://localhost:5173                   │
│                                                    │
│  TanStack Router, Zustand, TanStack Virtual,      │
│  Tailwind CSS (Twitter brand colors)              │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│         Backend (Express + TypeScript)             │
│         http://localhost:3000                      │
│                                                    │
│  Single monolith with route modules:              │
│  /api/auth, /api/tweets, /api/timeline,           │
│  /api/users, /api/trends                          │
│                                                    │
│  Middleware: session auth, Pino logging,           │
│  Prometheus metrics, idempotency                  │
│                                                    │
│  Endpoints: /health, /ready, /live, /metrics      │
└──────────────────────────────────────────────────┘
          │                │              │
          ▼                ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │ Valkey/Redis │ │    Kafka     │
│  :5432       │ │ :6379        │ │ :9092        │
│              │ │              │ │              │
│ twitter_db   │ │ Timelines,   │ │ tweets,      │
│ All tables   │ │ sessions,    │ │ likes        │
│ + triggers   │ │ trends,      │ │ topics       │
│              │ │ social graph │ │              │
│              │ │ cache        │ │ + Zookeeper  │
│              │ │              │ │   :2181      │
└──────────────┘ └──────────────┘ └──────────────┘

┌──────────────────────────────────────────────────┐
│              Background Workers                    │
│                                                    │
│  Fanout Worker (npm run dev:fanout-worker)         │
│  - Consumes tweet.created from Kafka               │
│  - Calls fanoutTweet() to push to Redis caches     │
│                                                    │
│  Trending Worker (npm run dev:trending-worker)     │
│  - Runs every 60s on a timer                       │
│  - Scans Redis trend buckets, calculates scores    │
│  - Updates trending:current sorted set             │
└──────────────────────────────────────────────────┘
```

## What Actually Exists

### Backend (`backend/src/`)

The backend is a **single Express monolith** (not microservices), organized into route modules. All routes share the same PostgreSQL pool, Redis connection, and session store.

**Route modules:**
- `routes/auth.ts` -- Register, login, logout, current user (bcrypt password hashing, Redis session store)
- `routes/tweets.ts` -- Create, read, delete tweets; like/unlike; retweet/unretweet; list replies. Tweet creation includes idempotency middleware and fires both synchronous fanout (`fanoutTweet()`) and async Kafka publish
- `routes/timeline.ts` -- Home timeline (hybrid fanout: reads from Redis cache + pulls celebrity tweets), user timeline, explore (ranked by engagement), hashtag timeline
- `routes/users.ts` -- Profile lookup, follow/unfollow, follower/following lists, user search (ILIKE query)
- `routes/trends.ts` -- Current trending hashtags (exponential decay scoring), all-time popular hashtags

**Services:**
- `services/fanout.ts` -- Full hybrid fanout implementation: checks `is_celebrity` flag, pipelines `LPUSH`/`LTRIM`/`EXPIRE` to follower timeline caches, circuit breaker wrapping Redis operations, fallback to retry queue, timeline rebuild function

**Shared modules (all fully implemented):**
- `shared/kafka.ts` -- KafkaJS producer/consumer with `tweets` and `likes` topics, auto-reconnect, health check
- `shared/circuitBreaker.ts` -- Opossum-based circuit breaker factory with Prometheus metrics integration (state gauge, trip counter), pre-configured options for Redis, fanout, and database
- `shared/idempotency.ts` -- Middleware that checks `Idempotency-Key` header against Redis, caches successful responses with 24h TTL, degrades gracefully on Redis failure
- `shared/metrics.ts` -- 15+ Prometheus metrics (tweet counters, timeline latency histograms, fanout gauges, circuit breaker state, HTTP duration, idempotency hit/miss, DB pool size)
- `shared/logger.ts` -- Pino structured logging with child loggers, request ID tracking
- `shared/retry.ts` -- Exponential backoff with jitter, configurable max attempts
- `shared/retention.ts` -- Retention policy configuration, cleanup SQL queries, Redis TTL enforcement

**Workers (separate processes):**
- `workers/fanout-worker.ts` -- Kafka consumer that listens for `tweet.created` events and calls `fanoutTweet()`
- `workers/trending-worker.ts` -- Timer-based worker (every 60s) that scans Redis trend buckets, calculates scores with exponential decay, updates `trending:current` sorted set, cleans up expired buckets

**Database:**
- `db/init.sql` -- Full schema with 6 tables (users, tweets, follows, likes, retweets, hashtag_activity), 15 indexes, and 5 trigger functions for count denormalization
- `db/pool.ts` -- PostgreSQL connection pool (pg)
- `db/redis.ts` -- ioredis connection
- `db/seed.ts` -- Demo data seeder

### Frontend (`frontend/src/`)

React 19 + TypeScript + Vite with TanStack Router (file-based routing) and Zustand for state management.

**Routes:**
- `/login`, `/register` -- Auth pages
- `/` (index) -- Home timeline with compose tweet box
- `/explore` -- Popular tweets ranked by engagement
- `/$username` -- User profile with their tweets
- `/hashtag/$tag` -- Hashtag timeline

**Components:**
- `Timeline.tsx` -- Virtualized tweet list using `@tanstack/react-virtual` (estimateSize: 150px, overscan: 5, dynamic height measurement), infinite scroll with scroll position detection
- `Tweet.tsx` -- Tweet card with author info, content, engagement counters, like/retweet actions
- `ComposeTweet.tsx` -- Tweet composition form
- `TrendingSidebar.tsx` -- Displays trending hashtags from `/api/trends`
- `Sidebar.tsx` -- Navigation sidebar
- `Layout.tsx` -- Three-column layout (sidebar, main content, trending)

**Styling:** Tailwind CSS with Twitter brand colors configured (`twitter-blue: #1DA1F2`, `twitter-like: #F91880`, `twitter-retweet: #00BA7C`).

### Infrastructure (docker-compose.yml)

Three services:
- **PostgreSQL 16** (Alpine) -- port 5432, user `twitter`, password `twitter_secret`, database `twitter_db`
- **Valkey 7** (Alpine) -- port 6379, AOF persistence
- **Kafka** (Confluent 7.5.0) -- port 9092, with Zookeeper on 2181

## Production-Grade Patterns Actually Implemented

| Pattern | Library | What It Does | File |
|---------|---------|-------------|------|
| Circuit breaker | Opossum | Wraps Redis fanout with CLOSED/OPEN/HALF_OPEN states; falls back to retry queue | `src/shared/circuitBreaker.ts`, `src/services/fanout.ts` |
| Structured logging | Pino | JSON logs with request IDs, child loggers for context | `src/shared/logger.ts` |
| Prometheus metrics | prom-client | 15+ custom metrics + default Node.js metrics, `/metrics` endpoint | `src/shared/metrics.ts` |
| Idempotency | Custom + Redis | Prevents duplicate tweets on retry via `Idempotency-Key` header | `src/shared/idempotency.ts` |
| Retry with backoff | Custom | Exponential backoff + jitter for transient failures | `src/shared/retry.ts` |
| Health checks | Custom | Three-tier: `/live`, `/ready`, `/health` with dependency checks | `src/app.ts` |
| Graceful shutdown | Custom | SIGTERM/SIGINT handlers drain connections before exit | `src/index.ts` |
| Retention policies | Custom | Configurable TTLs, cleanup SQL, archival config | `src/shared/retention.ts` |
| Event streaming | KafkaJS | Producer publishes tweets/likes, consumer drives fanout | `src/shared/kafka.ts` |
| Hybrid fanout | Custom | Push for normal users, skip for celebrities, Redis pipeline | `src/services/fanout.ts` |
| Trend detection | Custom | Sliding window with exponential decay, periodic recalculation | `src/workers/trending-worker.ts` |
| List virtualization | @tanstack/react-virtual | Only renders visible tweets in viewport | `frontend/src/components/Timeline.tsx` |
| Count denormalization | PostgreSQL triggers | Automatic follower/tweet/like/retweet count updates | `src/db/init.sql` |

## What Was Simplified

| Production Design | Local Implementation |
|-------------------|---------------------|
| Microservices (Tweet, Timeline, Social Graph, Trend, Media) | Single Express monolith with route modules |
| Sharded PostgreSQL (Vitess/Citus) | Single PostgreSQL instance |
| Redis Cluster with read replicas | Single Valkey instance |
| CDN for media delivery | No media handling (media_urls stored but not served) |
| Elasticsearch for search | PostgreSQL `ILIKE` for user search, GIN index for hashtag search |
| ML-based spam/content moderation | No content moderation |
| OAuth 2.0 / JWT with token refresh | Session-based auth with Redis store |
| API Gateway (rate limiting, auth) | CORS middleware, inline auth checks |
| Multi-region deployment | Single-machine Docker Compose |
| Count-Min Sketch for trends | Individual Redis keys per hashtag per time bucket |

## What Was Omitted

- **CDN** -- no static asset or media edge caching
- **Media upload/transcoding pipeline** -- media_urls field exists but no upload endpoint
- **Elasticsearch** -- no full-text tweet search
- **Notification service** -- no SSE/WebSocket push notifications
- **Rate limiting** -- no token bucket or sliding window rate limiter
- **Multi-region / geo-routing** -- single-machine deployment
- **Kubernetes / container orchestration** -- Docker Compose only
- **Algorithmic timeline ranking** -- chronological only (explore uses engagement sort)
- **Protected/private accounts** -- all accounts are public
- **DM / direct messaging** -- not implemented
- **Analytics pipeline** -- Kafka events published but no ClickHouse analytics consumer

## Local Multi-Instance Setup

```bash
# Infrastructure
docker-compose up -d  # PostgreSQL, Valkey, Kafka + Zookeeper

# API Servers (can run multiple instances)
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003

# Background Workers
npm run dev:fanout-worker    # Kafka consumer for fanout
npm run dev:trending-worker  # Periodic trend calculation

# Multiple fanout workers (separate consumer group instances)
npm run dev:worker1  # FANOUT_CONSUMER_GROUP=fanout-workers-1
npm run dev:worker2  # FANOUT_CONSUMER_GROUP=fanout-workers-2

# Frontend
cd frontend && npm run dev  # Port 5173
```
