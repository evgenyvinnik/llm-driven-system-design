# Instagram - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"Today I'll design Instagram, a photo and video sharing social platform. As a backend engineer, I'll focus on the async image processing pipeline with multiple resolutions, hybrid fan-out feed generation strategy, dual-database architecture using PostgreSQL and Cassandra, and the reliability patterns including circuit breakers, rate limiting, and idempotent operations that enable the platform to handle billions of interactions."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Photo/Video Upload** - Upload, process, and store photos with multiple resolutions
2. **Feed Generation** - Personalized home feed from followed accounts with cursor pagination
3. **Stories** - Ephemeral 24-hour content with view tracking and automatic expiration
4. **Direct Messaging** - Real-time messaging with read receipts and typing indicators
5. **Social Graph** - Follow/unfollow with strong consistency

### Non-Functional Requirements

- **Scale**: 500M+ DAU, 100M+ posts/day, 1.1M feed QPS
- **Latency**: Feed load < 200ms p95, upload acknowledgment < 500ms p95
- **Consistency**: Eventual for feeds (2-5s delay acceptable), strong for follows and message ordering
- **Availability**: 99.99% uptime with graceful degradation

### Backend-Specific Clarifications

- "What's the read/write ratio for feeds?" - 100:1, extremely read-heavy
- "How should we handle celebrity accounts with millions of followers?" - Hybrid fan-out strategy
- "What consistency model for DMs?" - Strong ordering guarantee, eventual delivery

---

## Step 2: High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Load Balancer (nginx:3000)                      │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐        ┌───────────────┐        ┌───────────────┐
│ API Server 1  │        │ API Server 2  │        │ API Server 3  │
│   (:3001)     │        │   (:3002)     │        │   (:3003)     │
└───────┬───────┘        └───────┬───────┘        └───────┬───────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
    ┌────────────┬───────────────┼───────────────┬────────────┐
    │            │               │               │            │
    ▼            ▼               ▼               ▼            ▼
┌────────┐  ┌────────┐      ┌────────┐      ┌────────┐   ┌─────────┐
│Postgres│  │ Valkey │      │ MinIO  │      │RabbitMQ│   │Cassandra│
│(:5432) │  │(:6379) │      │(:9000) │      │(:5672) │   │ (:9042) │
│Primary │  │ Cache/ │      │ Object │      │  Task  │   │  Direct │
│   DB   │  │Session │      │ Store  │      │ Queue  │   │Messages │
└────────┘  └────────┘      └────────┘      └───┬────┘   └─────────┘
                                                │
                                                ▼
                                         ┌─────────────┐
                                         │Image Worker │
                                         │(background) │
                                         └─────────────┘
```

---

## Step 3: Async Image Processing Pipeline (Deep Dive)

### The Challenge

Users upload high-resolution images (2-10 MB), but we need multiple sizes for different UI contexts. Processing synchronously would block requests for 2-5 seconds.

### Processing Flow

```
┌────────┐    POST /api/v1/posts     ┌─────────┐
│ Client │ ─────────────────────────▶│   API   │
└────────┘   (multipart: image)      └────┬────┘
                                          │
         ┌────────────────────────────────┼────────────────────────────────┐
         │                                │                                │
         ▼                                ▼                                ▼
┌─────────────────┐              ┌─────────────────┐              ┌─────────────────┐
│  Store original │              │  Create post    │              │  Enqueue job    │
│    in MinIO     │              │ status:process  │              │  to RabbitMQ    │
└─────────────────┘              └─────────────────┘              └────────┬────────┘
                                                                           │
         ┌─────────────────────────────────────────────────────────────────┘
         ▼
┌─────────────────┐              ┌─────────────────┐              ┌─────────────────┐
│  Worker dequeue │ ────────────▶│  Generate 4     │ ────────────▶│  Update post    │
│     job         │              │  resolutions    │              │ status:published│
└─────────────────┘              └─────────────────┘              └─────────────────┘
```

### Resolution Strategy

| Resolution | Size | Quality | Use Case |
|------------|------|---------|----------|
| Thumbnail | 150px | 80% | Story rings, notifications |
| Small | 320px | 85% | Grid view |
| Medium | 640px | 85% | Feed on mobile |
| Large | 1080px | 90% | Full-screen view |

"I use Sharp library for high-performance image resizing. Auto-orient based on EXIF metadata and strip it for privacy. Output as WebP format which is 30% smaller than JPEG."

### Dead Letter Queue for Failed Jobs

```
┌─────────────────┐     success     ┌─────────────────┐
│  Image Worker   │ ───────────────▶│  Post Updated   │
└────────┬────────┘                 └─────────────────┘
         │ failure (3 retries)
         ▼
┌─────────────────┐                 ┌─────────────────┐
│   Dead Letter   │ ───────────────▶│  Post marked    │
│     Queue       │                 │  as 'failed'    │
└─────────────────┘                 └─────────────────┘
```

"Retry with exponential backoff: 2s, 4s delays. After 3 failures, dead-letter the message and mark post as failed."

---

## Step 4: Hybrid Fan-out Feed Generation

### The Problem

With 500 accounts followed, generating feed on each request is expensive. But pure push (fan-out on write) is prohibitive for celebrities with millions of followers.

### Hybrid Strategy

```
┌─────────────────────────────────────────────────────────────────────┐
│                         New Post Created                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │   Check follower      │
                    │      count            │
                    └───────────┬───────────┘
                                │
         ┌──────────────────────┴──────────────────────┐
         │                                             │
         ▼                                             ▼
┌─────────────────────┐                     ┌─────────────────────┐
│  < 10K followers    │                     │  >= 10K followers   │
│  (Regular account)  │                     │  (Celebrity)        │
└──────────┬──────────┘                     └──────────┬──────────┘
           │                                           │
           ▼                                           ▼
┌─────────────────────┐                     ┌─────────────────────┐
│ Fan-out on WRITE    │                     │ Fan-out on READ     │
│ Push to followers'  │                     │ Mark as "pull-only" │
│ timeline caches     │                     │ Store separately    │
└─────────────────────┘                     └─────────────────────┘
```

### Data Model in Redis

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Timeline Cache (Sorted Set)                       │
├─────────────────────────────────────────────────────────────────────┤
│  Key: timeline:{user_id}                                            │
│  Score: timestamp (Unix epoch)                                      │
│  Value: post_id                                                     │
│  Max entries: 500                                                   │
│  TTL: 7 days (refreshed on access)                                  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                   Post Metadata Cache (Hash)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Key: post:{post_id}                                                │
│  Fields: author_id, caption, like_count, thumbnail_url, created_at  │
│  TTL: 1 hour                                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Feed Generation with Merge

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Get Feed for User                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
        ▼                                               ▼
┌─────────────────────┐                      ┌─────────────────────┐
│ Get pre-pushed      │                      │ Get celebrity       │
│ timeline posts      │                      │ follows for user    │
│ from Redis          │                      │                     │
└──────────┬──────────┘                      └──────────┬──────────┘
           │                                            │
           │                                            ▼
           │                                 ┌─────────────────────┐
           │                                 │ Fetch recent posts  │
           │                                 │ from each celebrity │
           │                                 │ (parallel)          │
           │                                 └──────────┬──────────┘
           │                                            │
           └─────────────────┬──────────────────────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Merge, deduplicate, │
                  │ sort by time        │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Cache result (60s)  │
                  │ Invalidate on       │
                  │ follow/unfollow     │
                  └─────────────────────┘
```

---

## Step 5: Dual Database Architecture (PostgreSQL + Cassandra)

### Why Two Databases?

| Data Type | PostgreSQL | Cassandra |
|-----------|------------|-----------|
| Users, posts, follows | Strong consistency, JOINs | - |
| Direct messages | - | High-write, TimeUUID ordering |
| Likes, comments | Atomic counters, constraints | - |
| Typing indicators | - | 5-second TTL |

### PostgreSQL Schema Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  users                                                               │
├─────────────────────────────────────────────────────────────────────┤
│  id UUID PK, username VARCHAR(30) UNIQUE, email VARCHAR(255) UNIQUE │
│  password_hash, is_private BOOLEAN, follower_count, following_count │
│  created_at TIMESTAMPTZ                                             │
└─────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│     posts       │   │    follows      │   │    stories      │
├─────────────────┤   ├─────────────────┤   ├─────────────────┤
│ id, user_id FK  │   │ follower_id FK  │   │ id, user_id FK  │
│ caption, status │   │ following_id FK │   │ media_url       │
│ original_url    │   │ created_at      │   │ expires_at      │
│ thumbnail_url   │   │ PK(follower,    │   │ view_count      │
│ small/med/large │   │    following)   │   │ created_at      │
│ like_count      │   └─────────────────┘   └─────────────────┘
│ comment_count   │
│ created_at      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     likes       │
├─────────────────┤
│ user_id FK      │
│ post_id FK      │
│ PK(user, post)  │
│ created_at      │
└─────────────────┘
```

"Posts have status field: processing, published, failed, deleted. Composite index on (user_id, created_at DESC) WHERE status = 'published' for feed queries."

### Cassandra Schema for Direct Messages

```
┌─────────────────────────────────────────────────────────────────────┐
│  messages_by_conversation                                            │
├─────────────────────────────────────────────────────────────────────┤
│  PK: conversation_id                                                │
│  Clustering: message_id TIMEUUID DESC                               │
│  Fields: sender_id, content, content_type, media_url, created_at    │
│  TTL: 1 year                                                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  conversations_by_user (inbox view)                                  │
├─────────────────────────────────────────────────────────────────────┤
│  PK: user_id                                                        │
│  Clustering: last_message_at DESC, conversation_id                  │
│  Fields: other_user_id, other_username, other_avatar_url,           │
│          last_message_preview, unread_count                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  typing_indicators (ephemeral)                                       │
├─────────────────────────────────────────────────────────────────────┤
│  PK: conversation_id, user_id                                       │
│  Fields: started_at                                                 │
│  TTL: 5 seconds (auto-expire)                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Message Send Flow

```
┌────────────┐                     ┌────────────────────┐
│   Client   │ ───────────────────▶│   Insert message   │
│ sends msg  │                     │   to Cassandra     │
└────────────┘                     └─────────┬──────────┘
                                             │
        ┌────────────────────────────────────┴────────────────────┐
        │                                                         │
        ▼                                                         ▼
┌─────────────────────┐                              ┌─────────────────────┐
│ Update conversation │                              │ Publish to Redis    │
│ metadata for all    │                              │ pub/sub for         │
│ participants        │                              │ real-time delivery  │
└─────────────────────┘                              └─────────────────────┘
```

---

## Step 6: Idempotency Patterns

### Like Idempotency with ON CONFLICT

```
┌────────────┐     POST /like      ┌────────────────────┐
│   Client   │ ───────────────────▶│  INSERT INTO likes │
│            │                     │  ON CONFLICT       │
└────────────┘                     │  DO NOTHING        │
                                   └─────────┬──────────┘
                                             │
                              ┌──────────────┴──────────────┐
                              │                             │
                              ▼                             ▼
                    ┌───────────────────┐       ┌───────────────────┐
                    │   New like        │       │  Duplicate like   │
                    │   rowCount > 0    │       │  rowCount = 0     │
                    │   Increment       │       │  No action        │
                    │   like_count      │       │  (idempotent)     │
                    └───────────────────┘       └───────────────────┘
```

"Idempotent insert - duplicate likes are silently ignored. Only increment counter if this was a new like."

### Story View Deduplication

```
┌────────────┐                    ┌────────────────────┐
│ View story │ ──────────────────▶│ Check Redis set    │
│            │                    │ story_views:{id}   │
└────────────┘                    └─────────┬──────────┘
                                            │
                           ┌────────────────┴────────────────┐
                           │                                 │
                           ▼                                 ▼
                 ┌───────────────────┐            ┌───────────────────┐
                 │  Already in set   │            │  Not in set       │
                 │  Return false     │            │  Add to set       │
                 │                   │            │  Incr counter     │
                 └───────────────────┘            │  Queue persist    │
                                                  │  Return true      │
                                                  └───────────────────┘
```

---

## Step 7: Rate Limiting with Sliding Window

### Rate Limit Configuration

| Action | Limit | Window |
|--------|-------|--------|
| Follow | 30 | per hour |
| Post | 10 | per hour |
| Like | 100 | per hour |
| Comment | 50 | per hour |
| Login | 5 | per minute |

### Sliding Window Implementation

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Rate Limit Check (Redis Sorted Set)                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. ZREMRANGEBYSCORE - Remove expired entries                        │
│  2. ZADD - Add current request with timestamp                        │
│  3. ZCARD - Count requests in window                                 │
│  4. EXPIRE - Set key expiry                                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
          ┌───────────────────┐   ┌───────────────────┐
          │  count > max      │   │  count <= max     │
          │  429 Too Many     │   │  Allow request    │
          │  Requests         │   │  Return remaining │
          └───────────────────┘   └───────────────────┘
```

"Response headers include X-RateLimit-Remaining and X-RateLimit-Reset for client-side handling."

---

## Step 8: Circuit Breaker Pattern

### Implementation with Opossum

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Circuit Breaker States                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    CLOSED ────▶ OPEN ────▶ HALF-OPEN ────▶ CLOSED                   │
│       │          │            │               ▲                      │
│       │    (50% fail)    (after 60s)          │                      │
│       │          │            │          (success)                   │
│       ▼          ▼            ▼               │                      │
│   Normal     Fallback     Test one      ─────┘                      │
│   operation  response     request                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Graceful Degradation Strategy

| Failure Scenario | Degradation Strategy |
|-----------------|---------------------|
| MinIO down | Return 503 for uploads, queue for retry |
| Redis/Valkey down | Bypass cache, query PostgreSQL directly |
| RabbitMQ down | Process images inline (blocking, with timeout) |
| Cassandra down | DMs unavailable, return 503 for messaging |
| PostgreSQL down | Return 503 for writes, serve cached reads |

---

## Step 9: Story Expiration and Cleanup

### Active Story Filtering

"Stories use database-level filtering with expires_at > NOW(). Index on (expires_at) WHERE expires_at > NOW() for efficient queries."

### Background Cleanup Job

```
┌─────────────────────────────────────────────────────────────────────┐
│                 Story Cleanup (Runs Hourly)                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Find expired stories (with 1-hour buffer for edge cases)         │
│  2. For each expired story:                                          │
│     a. Delete from MinIO object storage                              │
│     b. Delete from PostgreSQL (cascades to story_views)              │
│  3. Clean up orphaned Redis view sets                                │
│  4. Emit metrics for monitoring                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 10: Prometheus Metrics

### Metrics Categories

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Metrics Overview                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Request Metrics                                                     │
│  ├── instagram_http_requests_total (method, path, status_code)       │
│  └── instagram_http_request_duration_seconds (method, path)          │
│                                                                      │
│  Business Metrics                                                    │
│  ├── instagram_posts_created_total                                   │
│  ├── instagram_likes_total (action: like/unlike)                     │
│  └── instagram_likes_duplicate_total (idempotency working)           │
│                                                                      │
│  Feed Metrics                                                        │
│  ├── instagram_feed_generation_seconds (cache_status)                │
│  ├── instagram_feed_cache_hits_total                                 │
│  └── instagram_feed_cache_misses_total                               │
│                                                                      │
│  Processing Metrics                                                  │
│  └── instagram_image_processing_seconds                              │
│                                                                      │
│  Reliability Metrics                                                 │
│  ├── instagram_circuit_breaker_state (name)                          │
│  ├── instagram_circuit_breaker_events_total (name, event)            │
│  └── instagram_rate_limit_hits_total (action)                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Closing Summary

"I've designed Instagram's backend with focus on:

1. **Async Image Processing Pipeline** - RabbitMQ workers generate 4 resolutions with retry and dead-letter handling
2. **Hybrid Fan-out Feed** - Push for small accounts, pull for celebrities, merged at read time with 60s caching
3. **Dual Database Architecture** - PostgreSQL for relational data with ACID, Cassandra for high-write DMs with TimeUUID ordering
4. **Reliability Patterns** - Idempotent likes via ON CONFLICT, sliding window rate limiting, circuit breakers with fallbacks

The key insight is that the hybrid fan-out approach is essential at scale - pure push fails for celebrities, pure pull is too slow for power users. The dual database approach leverages each system's strengths: PostgreSQL's constraints and JOINs for the social graph, Cassandra's write throughput and time-ordering for messaging."

---

## Potential Follow-up Questions

1. **How would you handle database sharding as you scale?**
   - Shard by user_id using consistent hashing
   - Cross-shard queries for feed require scatter-gather pattern
   - Consider routing layer like Vitess

2. **How would you implement the Explore/Discover feature?**
   - Collaborative filtering: "users who liked this also liked"
   - Content-based: image embeddings + similarity search
   - Trending: sliding window engagement velocity

3. **How would you handle profile picture changes syncing to Cassandra?**
   - Event-driven: profile update -> message queue -> sync worker
   - Worker updates all active conversations for that user
   - Eventual consistency (2-5 second lag acceptable)
