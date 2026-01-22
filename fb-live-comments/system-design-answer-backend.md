# Facebook Live Comments - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

## Introduction

"Today I'll design a real-time commenting system for live video streams, similar to Facebook Live or YouTube Live. The core backend challenge is handling massive write throughput during popular streams while delivering comments to millions of viewers with minimal latency. This involves interesting problems around fan-out, message ordering, and spam prevention at scale."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm what we're building:

1. **Real-Time Comments**: Users post comments that appear instantly for all viewers
2. **Comment Display**: Serve comments to clients overlaid on video or in sidebar
3. **Reactions**: Quick emoji reactions (hearts, likes, etc.) with aggregation
4. **Moderation**: Filter spam, profanity, block users
5. **Comment Highlighting**: Surface interesting comments (pinned, creator responses)

Should I also design the video streaming infrastructure, or focus on comments?"

### Non-Functional Requirements

"For a live comments backend:

- **Scale**: Top streams have 500K+ concurrent viewers
- **Write Throughput**: Popular streams: 10,000+ comments per second
- **Read Throughput**: 500K viewers * 1 poll/sec = 500K reads/sec per stream
- **Latency**: Comments visible within 2-3 seconds of posting
- **Ordering**: Comments should appear in roughly chronological order"

---

## Step 2: Scale Estimation

"Let me work through the numbers for a popular live stream:

**Single Popular Stream:**
- 500,000 concurrent viewers
- 10,000 comments per second peak
- Each comment: ~200 bytes

**Platform-Wide:**
- 10,000 concurrent live streams
- Average 1,000 viewers per stream
- Total: 10 million concurrent users
- Average comments: 100/second per stream = 1M comments/second platform-wide

**Storage:**
- 1M comments/sec * 200 bytes = 200 MB/sec
- 1 hour stream = 720 GB (temporary, archived to cold storage)

**Fan-out Challenge:**
- 1 comment = 500,000 deliveries
- 10,000 comments/sec * 500,000 = 5 billion deliveries/second
- This is the hard problem"

---

## Step 3: High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Live Stream Viewers                       │
│                 (500K concurrent per stream)                 │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Load Balancer / CDN                        │
└──────────┬──────────────────┬───────────────────┬───────────┘
           │                  │                   │
           ▼                  ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Comment Write   │ │  Comment Read    │ │    WebSocket     │
│    Service       │ │    Service       │ │     Gateway      │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                Stream Partitioned Kafka                      │
│             (Topic per stream or stream range)               │
└──────────┬──────────────────┬───────────────────┬───────────┘
           │                  │                   │
           ▼                  ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   Persistence    │ │    Fan-out       │ │   Moderation     │
│    Service       │ │    Service       │ │    Service       │
└────────┬─────────┘ └──────────────────┘ └──────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│          Cassandra (Comments) + Redis (Recent Cache)         │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 4: Database Schema Design

### Cassandra Schema (High Write Throughput)

**comments_by_stream:**

| Column | Type | Purpose |
|--------|------|---------|
| stream_id | UUID | Partition key |
| comment_id | BIGINT | Clustering key (Snowflake ID) |
| user_id | UUID | Comment author |
| content | TEXT | Comment text |
| created_at | TIMESTAMP | When posted |
| is_highlighted | BOOLEAN | Creator/mod highlight |

"Clustering ORDER BY comment_id DESC for efficient recent comment queries."

**comments_by_user:**

| Column | Type | Purpose |
|--------|------|---------|
| user_id | UUID | Partition key |
| created_at | TIMESTAMP | Clustering key |
| stream_id | UUID | Which stream |
| comment_id | BIGINT | Snowflake ID |
| content | TEXT | Comment text |

"Used for moderation and user history lookups."

### PostgreSQL Schema (Learning Implementation)

**users:**

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PRIMARY KEY |
| username | VARCHAR(50) | UNIQUE |
| display_name | VARCHAR(100) | NOT NULL |
| avatar_url | VARCHAR(255) | |
| role | VARCHAR(20) | user/moderator/admin |
| reputation_score | DECIMAL(3,2) | DEFAULT 0.5 |
| is_verified | BOOLEAN | DEFAULT FALSE |

**streams:**

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PRIMARY KEY |
| title | VARCHAR(255) | NOT NULL |
| creator_id | UUID | FK → users |
| status | VARCHAR(20) | scheduled/live/ended |
| viewer_count | INTEGER | DEFAULT 0 |
| comment_count | INTEGER | DEFAULT 0 |
| started_at | TIMESTAMPTZ | |

**comments:**

| Column | Type | Constraints |
|--------|------|-------------|
| id | BIGINT | PRIMARY KEY (Snowflake) |
| stream_id | UUID | FK → streams |
| user_id | UUID | FK → users |
| content | TEXT | NOT NULL |
| parent_id | BIGINT | FK → comments (replies) |
| is_highlighted | BOOLEAN | DEFAULT FALSE |
| is_pinned | BOOLEAN | DEFAULT FALSE |
| is_hidden | BOOLEAN | DEFAULT FALSE |
| moderation_status | VARCHAR(20) | pending/approved/rejected/spam |

**Indexes:**
- idx_comments_stream_id (stream_id)
- idx_comments_stream_created (stream_id, created_at DESC)
- idx_comments_user_id (user_id)

---

## Step 5: Snowflake ID Generation

"Snowflake IDs provide time-ordered, unique identifiers without coordination."

```
┌───────────────────────────────────────────────────────────┐
│                      64-bit Snowflake ID                   │
├───────────────────┬────────────────┬──────────────────────┤
│  41 bits: time    │ 10 bits: node  │  12 bits: sequence   │
│  (ms since epoch) │  (worker ID)   │  (0-4095 per ms)     │
└───────────────────┴────────────────┴──────────────────────┘
```

**Generation Algorithm:**

| Step | Description |
|------|-------------|
| 1 | Get current timestamp - custom epoch (2021-01-01) |
| 2 | If same millisecond as last ID, increment sequence |
| 3 | If sequence overflows (4096), wait for next millisecond |
| 4 | If new millisecond, reset sequence to 0 |
| 5 | Combine: (timestamp << 22) | (nodeId << 12) | sequence |

**Benefits:**
- Roughly time-ordered (can sort by ID)
- No coordination needed between machines
- 4 million IDs per second per machine

---

## Step 6: Comment Write Service

### Write Path Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ User posts  │────▶│  Validate   │────▶│  Generate   │
│  comment    │     │  (auth/rate │     │  Snowflake  │
│             │     │   /filter)  │     │     ID      │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                                               ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Return    │◀────│  Async:     │◀────│  Publish    │
│   ACK to    │     │  Persist    │     │  to Kafka   │
│   user      │     │  + Fan-out  │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
```

**Validation Steps:**
1. Rate limit check (allow returns boolean)
2. Content filter (banned words check)
3. Create comment with Snowflake ID
4. Publish to Kafka (stream_id as partition key)
5. Return immediately (persistence is async)

**Kafka Topic Partitioning:**
- Topic: comments-{partition}
- Partition: hash(streamId) % 1000
- Key: streamId (ensures ordering per stream)

---

## Step 7: Rate Limiting Implementation

### Multi-Layer Rate Limiting

```
┌─────────────────────────────────────────────────────────────┐
│                    Rate Limit Layers                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: Global Rate Limit (across all streams)            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Key: ratelimit:global:{userId}                      │    │
│  │  Limit: 30 comments per 60 seconds                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│  Layer 2: Per-Stream Rate Limit                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Key: ratelimit:stream:{streamId}:{userId}           │    │
│  │  Limit: 5 comments per 30 seconds                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Redis Implementation:**
- INCR key (atomic increment)
- On first increment: EXPIRE key window
- If count > limit: reject with rate limit error

### Adaptive Rate Limiting

"Rate limits adjust based on user reputation."

| Reputation Score | Per-Stream Limit | Rationale |
|------------------|------------------|-----------|
| > 0.9 (trusted) | 10 per 30s | Verified good actors |
| > 0.5 (normal) | 5 per 30s | Default limit |
| < 0.5 (suspicious) | 2 per 30s | Potential spammers |

---

## Step 8: Fan-out Architecture

### The Fan-out Problem

"500K viewers need to see every comment. Two approaches:

**Push (Fan-out on write):**
- When comment posted, push to all 500K connections
- Problem: 10K comments * 500K viewers = 5 billion messages/sec

**Pull (Fan-out on read):**
- Viewers poll for new comments every second
- Problem: 500K polls/sec per stream

**Hybrid (Our Approach):**
- Maintain recent comments buffer per stream
- Viewers connect via WebSocket, receive batched updates
- Server pushes batches every 100-200ms"

### Fan-out Implementation

```
┌─────────────────────────────────────────────────────────────┐
│                      Fan-out Service                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Comment Batcher (per stream)            │    │
│  │  - buffer: Comment[]                                 │    │
│  │  - batchInterval: 100ms                              │    │
│  │                                                      │    │
│  │  addComment(comment) ──▶ buffer.push(comment)        │    │
│  │                                                      │    │
│  │  Every 100ms:                                        │    │
│  │    if (buffer.length > 0)                            │    │
│  │      batch = buffer; buffer = []                     │    │
│  │      redis.publish(stream:{id}:comments, batch)      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 9: Redis Cache and Pub/Sub

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| recent:stream:{id} | List | 1hr | Last 1,000 comments (JSON) |
| stream:{id}:comments | Pub/Sub | - | Comment batch distribution |
| stream:{id}:reactions | Pub/Sub | - | Reaction aggregate distribution |
| stream:{id} | Hash | - | viewer_count, metadata |
| ratelimit:global:{user_id} | String | 60s | Global rate limit |
| ratelimit:stream:{stream_id}:{user_id} | String | 30s | Per-stream rate limit |

### Cache Operations

**Caching a Comment:**
1. LPUSH recent:stream:{id} comment_json
2. LTRIM recent:stream:{id} 0 999 (keep last 1000)
3. EXPIRE recent:stream:{id} 3600 (1 hour TTL)

**Getting Recent Comments:**
1. LRANGE recent:stream:{id} 0 limit-1
2. If cache miss: query database, populate cache

---

## Step 10: Reaction Aggregation

### High-Volume Reaction Handling

"Reactions flood in at 100x the rate of comments. Individual delivery is impractical."

```
┌─────────────────────────────────────────────────────────────┐
│                   Reaction Aggregator                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Configuration:                                              │
│  - aggregateInterval: 500ms                                  │
│  - counts: Map<reactionType, count>                         │
│                                                              │
│  addReaction(type):                                          │
│    counts[type] = (counts[type] || 0) + 1                   │
│                                                              │
│  Every 500ms:                                                │
│    if (counts.size > 0)                                      │
│      aggregated = Object.fromEntries(counts)                │
│      counts.clear()                                          │
│      redis.publish(stream:{id}:reactions, {                 │
│        type: 'reactions',                                    │
│        counts: aggregated,                                   │
│        timestamp: Date.now()                                 │
│      })                                                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Result:** Instead of 1M individual reaction messages, send aggregated counts every 500ms.

---

## Step 11: Moderation Pipeline

### Multi-Layer Defense

```
┌─────────────────────────────────────────────────────────────┐
│                   Moderation Pipeline                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: Pre-Send Validation (Synchronous, <10ms)          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  - Rate limiting (5 comments per 30s per user)       │    │
│  │  - Banned word filter (regex match)                  │    │
│  │  - Duplicate detection (exact match in last 100)     │    │
│  │  - Account age check (no comments if < 1 day)        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Layer 2: ML Classification (Async, <100ms)                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  - Spam classifier                                   │    │
│  │  - Toxicity scorer                                   │    │
│  │  - Scam/phishing detector                            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Layer 3: Community Moderation                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  - User reports                                      │    │
│  │  - Moderator actions                                 │    │
│  │  - Auto-hide if N reports in M minutes               │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Layer 4: Post-Hoc Analysis                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  - Batch ML re-evaluation                            │    │
│  │  - Cross-stream pattern detection                    │    │
│  │  - Account-level spam detection                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Content Filter Implementation

**Duplicate Detection:**
- Hash: SHA256(userId + content)
- LRU Cache: 10,000 entries
- If hash exists: reject as duplicate

**Banned Words:**
- Set of banned terms
- Case-insensitive word tokenization
- Return rejected with reason if match

---

## Step 12: Circuit Breaker Pattern

### Database Protection

```
┌─────────────────────────────────────────────────────────────┐
│                    Circuit Breaker                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Configuration:                                              │
│  - timeout: 3000ms                                           │
│  - errorThresholdPercentage: 50%                            │
│  - volumeThreshold: 5 requests                              │
│  - resetTimeout: 10000ms                                     │
│                                                              │
│  States:                                                     │
│  ┌────────┐                    ┌────────┐                   │
│  │ CLOSED │──errors >= 50%───▶│  OPEN  │                   │
│  │        │                    │        │                   │
│  └────▲───┘                    └───┬────┘                   │
│       │                            │                         │
│  success                      resetTimeout                   │
│       │                            │                         │
│  ┌────┴────┐                       │                         │
│  │HALF_OPEN│◀──────────────────────┘                         │
│  │         │                                                 │
│  └─────────┘                                                 │
│                                                              │
│  Fallback when OPEN:                                         │
│    Queue comment for later processing                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 13: Graceful Degradation

### Handling Viral Streams

**Degradation Policies by Viewer Count:**

| Viewer Count | Batch Interval | Max Comments/Batch | Show All? |
|--------------|----------------|-------------------|-----------|
| < 10,000 | 100ms | 50 | Yes |
| < 100,000 | 200ms | 30 | Yes |
| 100,000+ | 500ms | 20 | No (10% sample) |

### Comment Sampling

"For mega-streams, we sample comments using priority scoring."

**Scoring Factors:**

| Factor | Points | Rationale |
|--------|--------|-----------|
| User is verified | +10 | Trusted identity |
| User is creator | +100 | Stream owner |
| Reaction count | +2 per reaction | Community validated |
| Contains question | +5 | Engagement opportunity |

**Algorithm:**
1. Score each comment
2. Sort by score descending
3. Take top N where N = count * samplingRate

---

## Step 14: Observability

### Key Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| comment_post_latency_ms | Histogram | - | Post to display time |
| comments_per_second | Gauge | stream_id | Throughput per stream |
| reactions_total | Counter | stream_id, type | Reaction volume |
| kafka_consumer_lag | Gauge | topic | Processing backlog |
| circuit_breaker_state | Gauge | service | 0=closed, 1=open, 2=half |
| rate_limit_exceeded_total | Counter | limit_type | Rate limit violations |

**Alert Thresholds:**
- comment_post_latency_ms p99 > 3000ms
- kafka_consumer_lag > 10000
- circuit_breaker_state = 1 (OPEN)
- rate_limit_exceeded spike > 10x baseline

---

## Step 15: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Message Queue | Kafka | RabbitMQ | Throughput, replayability, partitioning |
| Database | Cassandra | PostgreSQL | Write throughput, scale for production |
| Cache | Redis | Memcached | Pub/Sub + cache in one, data structures |
| Fan-out | Redis Pub/Sub | Kafka Consumer Groups | Lower latency for real-time |
| ID Generation | Snowflake | UUID | Time-ordering without coordination |
| Ordering | Approximate | Global sequencer | Latency vs strict order tradeoff |

---

## Summary

"To summarize the backend architecture for Facebook Live Comments:

1. **Write Path**: Kafka for durability and ordering, async persistence to Cassandra
2. **ID Generation**: Snowflake IDs for time-ordered, coordination-free unique identifiers
3. **Fan-out**: Redis Pub/Sub to WebSocket gateways, batched updates every 100-500ms
4. **Caching**: Redis for recent comments (1,000 per stream with 1-hour TTL)
5. **Rate Limiting**: Two-tier Redis counters (global and per-stream)
6. **Moderation**: Multi-layer defense with sync validation and async ML
7. **Resilience**: Circuit breakers for database protection, graceful degradation for viral streams

The key backend insights are:
- Fan-out is the hardest problem - solved by batching and pub/sub
- Snowflake IDs enable sorting by ID (no timestamp index needed)
- Approximate ordering is acceptable for real-time experience
- Different scale requires different policies (sampling for mega-streams)
- Reactions need aggregation, not individual delivery

What aspects would you like me to elaborate on?"
