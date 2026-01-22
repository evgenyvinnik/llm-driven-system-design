# Facebook News Feed - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## Introduction

"Today I'll design a personalized news feed system similar to Facebook's, focusing on the backend architecture. The core challenge is generating a personalized, ranked feed for billions of users while handling the write amplification problem when popular users post. I'll dive deep into fan-out strategies, database design, caching layers, and the ranking algorithm implementation."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the backend-specific requirements:

1. **Feed Generation API**: Serve personalized content from friends and followed pages
2. **Post Ingestion**: Handle high-throughput post creation with validation
3. **Fan-out Service**: Distribute posts to followers' feeds efficiently
4. **Ranking Engine**: Order posts by relevance using engagement and affinity scores
5. **Engagement Aggregation**: Track likes, comments, shares with real-time counters
6. **Social Graph Integration**: Query relationships for feed construction"

### Non-Functional Requirements

"For a news feed backend at Facebook scale:

- **Throughput**: 115,000 posts/second, 230,000 feed reads/second
- **Latency**: Feed generation < 200ms p95, post creation < 100ms p95
- **Availability**: 99.99% uptime for feed reads
- **Consistency**: Eventual consistency for feeds (5-10 second propagation)
- **Durability**: Zero data loss for posts and engagement data"

---

## Step 2: Scale Estimation

"Let me work through the backend capacity requirements:

**Write Load:**
- 2B DAU x 5 posts/day = 10B posts/day
- ~115,000 posts/second peak
- Average post size: 1KB = 115 MB/s write throughput

**Read Load:**
- 2B DAU x 10 feed loads/day = 20B feed requests/day
- ~230,000 feed requests/second
- Each request fetches ~50 posts with metadata

**The Fan-out Challenge:**
- Celebrity with 10M followers posts
- Naive push: 10M cache writes per post
- 100 celebrities posting hourly = 1B writes/hour
- This is unsustainable with pure push model

**Storage Requirements:**
- Posts: 10B/day x 1KB = 10TB/day raw
- With replication (3x) and indexes: ~50TB/day
- Feed cache per user: 1000 post IDs x 16 bytes = 16KB
- 2B users x 16KB = 32TB feed cache"

---

## Step 3: High-Level Backend Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Gateway / Load Balancer                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  Post Service   │        │  Feed Service   │        │ Ranking Service │
│  (Write Path)   │        │  (Read Path)    │        │   (ML Model)    │
└────────┬────────┘        └────────┬────────┘        └────────┬────────┘
         │                          │                          │
         ▼                          │                          │
┌─────────────────┐                 │                          │
│  Kafka Queue    │                 │                          │
│(Post Events)    │                 │                          │
└────────┬────────┘                 │                          │
         │                          │                          │
         ▼                          ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Fan-out Service (Workers)                          │
│                    Push to regular users, Index celebrities                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  Feed Cache     │        │   Post Store    │        │  Social Graph   │
│  (Redis Cluster)│        │  (Cassandra)    │        │   (Neo4j/TAO)   │
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## Step 4: Database Schema Design

### Posts Table (Cassandra)

"Cassandra is ideal for high-write throughput with time-ordered data."

**Posts by User Schema:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         posts_by_user TABLE                                │
├───────────────────────────────────────────────────────────────────────────┤
│  Partition Key: user_id (UUID)                                            │
│  Clustering Key: post_id (TIMEUUID) DESC                                  │
├───────────────────────────────────────────────────────────────────────────┤
│  Columns:                                                                  │
│  ├── content (TEXT)                                                        │
│  ├── media_ids (LIST<UUID>)                                                │
│  ├── post_type (TEXT) - 'text', 'image', 'video', 'link'                  │
│  ├── privacy (TEXT) - 'public', 'friends', 'custom'                       │
│  ├── like_count (COUNTER)                                                  │
│  ├── comment_count (COUNTER)                                               │
│  └── created_at (TIMESTAMP)                                                │
└───────────────────────────────────────────────────────────────────────────┘
```

**Feed Items Schema:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          feed_items TABLE                                  │
├───────────────────────────────────────────────────────────────────────────┤
│  Partition Key: user_id (UUID)                                            │
│  Clustering Keys: score (DOUBLE) DESC, post_id (TIMEUUID) DESC            │
├───────────────────────────────────────────────────────────────────────────┤
│  Columns:                                                                  │
│  ├── author_id (UUID)                                                      │
│  └── created_at (TIMESTAMP)                                                │
└───────────────────────────────────────────────────────────────────────────┘
```

### Engagement Tables

**Likes Schema:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│  likes TABLE                      │  user_likes TABLE                     │
├───────────────────────────────────┼───────────────────────────────────────┤
│  PK: (post_id, user_id)           │  PK: (user_id, post_id) DESC          │
│  ├── created_at                   │  ├── created_at                       │
│  Purpose: Check if liked          │  Purpose: User's liked posts          │
└───────────────────────────────────┴───────────────────────────────────────┘
```

### Affinity Scores Table

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        affinity_scores TABLE                               │
├───────────────────────────────────────────────────────────────────────────┤
│  Partition Key: user_id (UUID)                                            │
│  Clustering Key: target_user_id (UUID)                                    │
├───────────────────────────────────────────────────────────────────────────┤
│  Columns:                                                                  │
│  ├── score (DOUBLE) - 0-100 affinity value                                 │
│  ├── interaction_count (INT)                                               │
│  └── last_interaction_at (TIMESTAMP)                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step 5: Hybrid Fan-out Implementation

### Fan-out Service Design

"This is the core architectural decision - handling celebrities differently from regular users."

**Fan-out Decision Flow:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         FAN-OUT SERVICE                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  New Post ──▶ Get Follower Count                                         │
│                      │                                                    │
│         ┌────────────┴────────────┐                                      │
│         │                         │                                       │
│    < 10K followers          >= 10K followers                             │
│    (Regular User)           (Celebrity)                                  │
│         │                         │                                       │
│         ▼                         ▼                                       │
│  ┌─────────────────┐     ┌─────────────────┐                             │
│  │   PUSH MODEL    │     │   PULL MODEL    │                             │
│  ├─────────────────┤     ├─────────────────┤                             │
│  │ For each batch  │     │ Store in        │                             │
│  │ of followers:   │     │ celebrity_posts │                             │
│  │ ├─ zadd feed:id │     │ sorted set      │                             │
│  │ ├─ trim to 1000 │     │ (keep last 100) │                             │
│  │ └─ persist to   │     │                 │                             │
│  │    Cassandra    │     │ Publish update  │                             │
│  └─────────────────┘     │ to subscribers  │                             │
│                          └─────────────────┘                             │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Kafka Topic Configuration:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      post-events TOPIC                                     │
├───────────────────────────────────────────────────────────────────────────┤
│  Partitions: 256 (high parallelism)                                       │
│  Replication Factor: 3                                                    │
│  Retention: 7 days                                                        │
│  Compression: lz4                                                         │
│  Partition Strategy: hash(author_id) % 256                                │
│  └─ Ensures ordered processing per user                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Feed Retrieval Service

### Feed Aggregation Logic

**Feed Generation Pipeline:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    FEED RETRIEVAL PIPELINE                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Step 1: Get Pre-computed Feed                                            │
│          ├─ Redis ZREVRANGE feed:{user_id} 0 59                          │
│          └─ Cache miss? Rebuild from Cassandra                            │
│                      │                                                    │
│                      ▼                                                    │
│  Step 2: Get Followed Celebrities                                         │
│          └─ Social graph query for users >= 10K followers                 │
│                      │                                                    │
│                      ▼                                                    │
│  Step 3: Pull Celebrity Posts                                             │
│          └─ Pipeline ZREVRANGE celebrity_posts:{id} 0 10 for each        │
│                      │                                                    │
│                      ▼                                                    │
│  Step 4: Merge Feeds by Timestamp                                         │
│          └─ Combine cached + celebrity posts                              │
│                      │                                                    │
│                      ▼                                                    │
│  Step 5: Batch Fetch Full Post Data                                       │
│          └─ Cassandra multi-get for post details                          │
│                      │                                                    │
│                      ▼                                                    │
│  Step 6: Filter by Privacy                                                │
│          ├─ Public: Always visible                                        │
│          ├─ Friends: Check friendship in batch                            │
│          └─ Custom: Check specific ACL                                    │
│                      │                                                    │
│                      ▼                                                    │
│  Step 7: Apply Ranking                                                    │
│          └─ Multi-stage ML ranking pipeline                               │
│                      │                                                    │
│                      ▼                                                    │
│  Step 8: Paginate and Return                                              │
│          └─ Apply cursor-based pagination                                 │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Ranking Algorithm Implementation

### Multi-Stage Ranking Pipeline

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      RANKING PIPELINE                                     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Stage 1: Feature Extraction                                              │
│           └─ Batch load affinity scores, content type prefs               │
│                      │                                                    │
│                      ▼                                                    │
│  Stage 2: First-Pass Scoring (Lightweight)                                │
│           ├─ Score = engagement × recencyDecay × affinityBoost            │
│           └─ Filter 1000 candidates → top 200                             │
│                      │                                                    │
│                      ▼                                                    │
│  Stage 3: ML Model (Second Pass)                                          │
│           ├─ Feature vector: base_score, post_age, author_affinity        │
│           │                  engagement_rate, post_type, session_depth    │
│           │                  time_of_day, is_close_friend                 │
│           ├─ Predict: p_like, p_comment, p_share, p_hide                  │
│           └─ Final = p_like×1 + p_comment×2 + p_share×3 - p_hide×5        │
│                      │                                                    │
│                      ▼                                                    │
│  Stage 4: Diversity Injection                                             │
│           └─ Max 2 posts per author in final feed                         │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Base Score Formula:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        BASE SCORE CALCULATION                              │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Engagement = (likes × 1.0) + (comments × 3.0) + (shares × 5.0)           │
│                                                                            │
│  Recency Decay = 1.0 / (1 + hours_old × 0.08)                             │
│  └─ 12-hour half-life                                                      │
│                                                                            │
│  Affinity Boost = 1 + min(affinity_score, 100) / 100                      │
│  └─ Range: 1.0 - 2.0                                                       │
│                                                                            │
│  Type Multiplier = User's preference for post_type                        │
│                                                                            │
│  FINAL = Engagement × Recency × Affinity × TypeMultiplier                 │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Engagement Aggregation Service

### Real-time Counter Management

**Like Flow:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        LIKE POST FLOW                                     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  User Likes Post ──▶ Check Duplicate (SISMEMBER likes:{post_id})         │
│                              │                                            │
│                   ┌──────────┴──────────┐                                │
│                   │                     │                                 │
│              Already Liked         Not Liked                              │
│              (return false)             │                                 │
│                                         ▼                                 │
│                          ┌─────────────────────────────┐                 │
│                          │   REDIS PIPELINE            │                 │
│                          │   ├─ SADD likes:{post_id}   │                 │
│                          │   ├─ INCR like_count:{id}   │                 │
│                          │   └─ ZADD user_likes:{uid}  │                 │
│                          └─────────────┬───────────────┘                 │
│                                        │                                  │
│                          ┌─────────────┴───────────────┐                 │
│                          │                             │                  │
│                          ▼                             ▼                  │
│              ┌─────────────────────┐     ┌─────────────────────┐         │
│              │ Kafka: engagement-  │     │ Update Affinity     │         │
│              │ events (persist)    │     │ user→author +2.0    │         │
│              └─────────────────────┘     └─────────────────────┘         │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Counter Persistence Worker

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    COUNTER SYNC WORKER                                     │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Every 60 seconds:                                                         │
│  ├─ Get dirty_counters set from Redis                                      │
│  ├─ For each post_id:                                                      │
│  │   ├─ Read current counts from Redis                                     │
│  │   └─ UPDATE posts SET counts WHERE post_id = ?                          │
│  └─ Clear dirty_counters set                                               │
│                                                                            │
│  Benefits:                                                                 │
│  ├─ Handles 100K+ likes/sec without DB pressure                           │
│  ├─ At most 60-second staleness for persisted counts                       │
│  └─ Redis is source of truth for real-time display                         │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step 9: Affinity Scoring System

**Affinity Update Logic:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      AFFINITY SERVICE                                      │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  record_interaction(user_id, target_id, interaction_type):                 │
│                                                                            │
│  1. Get current score + last_update from Redis hash                        │
│                                                                            │
│  2. Apply time decay:                                                      │
│     decayed_score = old_score × (1 - 0.1)^days_since_update               │
│                                                                            │
│  3. Add interaction weight:                                                │
│     ┌──────────────┬─────────┐                                            │
│     │ Interaction  │ Weight  │                                            │
│     ├──────────────┼─────────┤                                            │
│     │ message      │  10.0   │                                            │
│     │ share        │   8.0   │                                            │
│     │ comment      │   5.0   │                                            │
│     │ like         │   2.0   │                                            │
│     │ view_profile │   1.0   │                                            │
│     └──────────────┴─────────┘                                            │
│                                                                            │
│  4. new_score = min(decayed + weight, 100)                                 │
│                                                                            │
│  5. Store in hash + update sorted set for quick lookup                     │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step 10: Caching Strategy

### Multi-Level Cache Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  L1: Application Cache (Local Memory) - Per Instance                        │
│  ├── Hot posts data (LRU, 1000 entries, 5 min TTL)                          │
│  └── Session tokens (256 entries, 1 hour TTL)                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  L2: Distributed Cache (Redis Cluster)                                       │
│  ├── Pre-computed feeds (sorted sets, 24h TTL)                               │
│  ├── Celebrity posts (sorted sets, no TTL, pruned by count)                  │
│  ├── Engagement counters (strings, no TTL)                                   │
│  └── Affinity scores (sorted sets, 7d TTL)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  L3: Database (Cassandra)                                                    │
│  ├── Posts, Users, Relationships (source of truth)                           │
│  └── Feed items (backup for cache misses)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Cache Configuration

| Key Pattern | TTL | Type | Purpose |
|-------------|-----|------|---------|
| feed:* | 24h | Sorted Set | Pre-computed user feeds |
| celebrity_posts:* | None | Sorted Set | Recent celebrity posts (max 100) |
| session:* | 24h | Hash | User session data |
| affinity:* | 7d | Hash | User-to-user affinity scores |
| like_count:* | None | String | Real-time like counters |
| likes:* | None | Set | Who liked a post |

---

## Step 11: Database Sharding Strategy

### User-Based Sharding

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SHARDING STRATEGY                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Posts: Shard by author_id                                                  │
│  └─ All posts by a user on same shard                                      │
│  └─ Profile timeline reads hit single shard                                │
│  └─ Hash: murmur3(author_id) % 256                                         │
│                                                                              │
│  Feed Items: Shard by user_id                                               │
│  └─ User's entire feed on same shard                                       │
│  └─ Feed reads are single-shard queries                                    │
│                                                                              │
│  Relationships: Shard by user_id                                            │
│  └─ User's social graph co-located                                         │
│  └─ Follower list lookup is single-shard                                   │
│                                                                              │
│  Total Shards: 256                                                          │
│  Hashing: murmur3 with seed 42, masked to 32-bit                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 12: Real-time Updates Architecture

### Pub/Sub for Online Users

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    REAL-TIME UPDATE FLOW                                   │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  User Connects via WebSocket:                                              │
│  ├─ Subscribe to feed_updates:{user_id}                                   │
│  └─ Subscribe to celebrity_updates:{celeb_id} for each followed celeb     │
│                                                                            │
│  New Post Published:                                                       │
│         │                                                                  │
│         ├── Celebrity (>= 10K followers)                                   │
│         │   └─ PUBLISH celebrity_updates:{author_id}                       │
│         │      └─ All subscribed users get notification                    │
│         │                                                                  │
│         └── Regular User (< 10K followers)                                 │
│             └─ Get online followers only                                   │
│             └─ PUBLISH feed_updates:{follower_id} for each                 │
│                                                                            │
│  Benefits:                                                                 │
│  ├─ No writes to offline users                                             │
│  ├─ Celebrities use single channel (not per-follower)                      │
│  └─ Instant updates for online users                                       │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step 13: Failure Handling and Resilience

### Circuit Breaker Implementation

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      CIRCUIT BREAKER                                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  States:                                                                   │
│  ┌─────────┐  5 failures  ┌────────┐  30s timeout  ┌────────────┐         │
│  │ CLOSED  │ ───────────▶ │  OPEN  │ ────────────▶ │ HALF-OPEN  │         │
│  │(normal) │              │(reject)│               │ (test 1)   │         │
│  └────┬────┘              └────────┘               └─────┬──────┘         │
│       │                        ▲                         │                │
│       │                        │                   success│failure        │
│       │                        └─────────────────────────┘                │
│       │                                                                    │
│       └── success ─────────────────────────────────────┘                  │
│                                                                            │
│  Fallback (when OPEN):                                                     │
│  └─ Return popular posts as degraded experience                            │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### Idempotency for Post Creation

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    IDEMPOTENT POST CREATION                                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. Client sends: POST /posts with Idempotency-Key header                  │
│                                                                            │
│  2. Server checks: GET idempotency:{user_id}:{key}                         │
│     ├─ Found? Return cached response                                       │
│     └─ Not found? Continue to create                                       │
│                                                                            │
│  3. Create post in database                                                │
│                                                                            │
│  4. Cache response: SETEX idempotency:{user_id}:{key} 86400 {response}    │
│                                                                            │
│  5. Return response to client                                              │
│                                                                            │
│  Benefits:                                                                 │
│  ├─ Network retry safety                                                   │
│  ├─ Double-click protection                                                │
│  └─ 24-hour deduplication window                                           │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| **Fan-out** | Hybrid (push/pull) | Pure push or pull | Handles celebrities without write amplification |
| **Post Storage** | Cassandra | PostgreSQL | Better write throughput at scale |
| **Feed Cache** | Redis Cluster | Memcached | Sorted sets perfect for ranked feeds |
| **Queue** | Kafka | RabbitMQ | Higher throughput, replay capability |
| **Ranking** | Multi-stage ML | Simple formula | Balances latency and quality |
| **Sharding** | User-based | Post-based | Co-locates related data for reads |
| **Counters** | Redis + async persist | Direct DB | Handles high-frequency updates |

---

## Future Enhancements

1. **ML Ranking Service**: Deploy dedicated TensorFlow Serving for second-pass ranking
2. **Feature Store**: Centralized feature computation for ranking consistency
3. **A/B Testing Framework**: Support multiple ranking algorithms simultaneously
4. **Read Replicas**: Geographic distribution for lower latency
5. **Edge Caching**: Push popular celebrity posts to CDN edge nodes
6. **Bloom Filters**: Reduce database lookups for "already seen" posts
7. **Write-Behind Cache**: Improve write latency with async persistence

---

## Summary

"For the Facebook News Feed backend:

1. **Hybrid Fan-out**: Push for regular users (< 10K followers), pull for celebrities to avoid write amplification
2. **Cassandra for Posts**: High write throughput with time-ordered clustering
3. **Redis for Feed Cache**: Sorted sets enable efficient ranked retrieval with O(log N) insertions
4. **Multi-stage Ranking**: Lightweight first pass filters 1000 to 200, ML model for final ranking
5. **Affinity Scoring**: Track user interactions to personalize feed ordering
6. **Circuit Breakers**: Graceful degradation when dependencies fail
7. **Kafka for Events**: Decouples post creation from fan-out for scalability

The key backend insight is that the celebrity problem requires fundamentally different handling - you cannot push to 10 million feeds for every celebrity post. The hybrid approach lets us optimize both paths independently."
