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
+---------------------------------------------------------------------+
|                         Live Stream Viewers                          |
|                    (500K concurrent per stream)                      |
+--------------------------------+------------------------------------+
                                 |
                                 v
+---------------------------------------------------------------------+
|                        Load Balancer / CDN                           |
+--------------------------------+------------------------------------+
                                 |
          +----------------------+----------------------+
          v                      v                      v
+-----------------+    +-----------------+    +-----------------+
|  Comment Write  |    |  Comment Read   |    |  WebSocket      |
|  Service        |    |  Service        |    |  Gateway        |
+--------+--------+    +--------+--------+    +--------+--------+
         |                      |                      |
         v                      v                      v
+---------------------------------------------------------------------+
|                    Stream Partitioned Kafka                          |
|                  (Topic per stream or stream range)                  |
+--------------------------------+------------------------------------+
         |                       |                      |
         v                       v                      v
+-----------------+    +-----------------+    +-----------------+
|  Persistence    |    |  Fan-out        |    |  Moderation     |
|  Service        |    |  Service        |    |  Service        |
+--------+--------+    +-----------------+    +-----------------+
         |
         v
+---------------------------------------------------------------------+
|              Cassandra (Comments) + Redis (Recent Cache)             |
+---------------------------------------------------------------------+
```

---

## Step 4: Database Schema Design

### Cassandra Schema (High Write Throughput)

```cql
-- Comments by stream (for replay, scrollback)
CREATE TABLE comments_by_stream (
    stream_id UUID,
    comment_id BIGINT,  -- Snowflake ID (time-ordered)
    user_id UUID,
    content TEXT,
    created_at TIMESTAMP,
    is_highlighted BOOLEAN,
    PRIMARY KEY (stream_id, comment_id)
) WITH CLUSTERING ORDER BY (comment_id DESC);

-- Comments by user (for moderation, user history)
CREATE TABLE comments_by_user (
    user_id UUID,
    stream_id UUID,
    comment_id BIGINT,
    content TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, created_at, comment_id)
) WITH CLUSTERING ORDER BY (created_at DESC);
```

### PostgreSQL Schema (Learning Implementation)

```sql
-- Users: viewers, streamers, moderators, admins
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(255),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
    reputation_score DECIMAL(3, 2) DEFAULT 0.5,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Streams: live broadcasts
CREATE TABLE streams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'live' CHECK (status IN ('scheduled', 'live', 'ended')),
    viewer_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments: Snowflake ID enables time-ordering
CREATE TABLE comments (
    id BIGINT PRIMARY KEY,  -- Snowflake ID
    stream_id UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    is_highlighted BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    is_hidden BOOLEAN DEFAULT FALSE,
    moderation_status VARCHAR(20) DEFAULT 'approved'
        CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'spam')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_comments_stream_id ON comments(stream_id);
CREATE INDEX idx_comments_stream_created ON comments(stream_id, created_at DESC);
CREATE INDEX idx_comments_user_id ON comments(user_id);
```

---

## Step 5: Snowflake ID Generation

"Snowflake IDs provide time-ordered, unique identifiers without coordination:

```
64-bit ID:
+-------------------+----------------+------------------+
|  41 bits: time    |  10 bits: node |  12 bits: seq   |
|  (ms since epoch) |   (worker ID)  |  (0-4095/ms)    |
+-------------------+----------------+------------------+
```

### Implementation

```typescript
class SnowflakeIdGenerator {
  private readonly epoch: bigint = 1609459200000n; // 2021-01-01
  private readonly nodeIdBits = 10n;
  private readonly sequenceBits = 12n;
  private readonly maxNodeId = (1n << this.nodeIdBits) - 1n;
  private readonly maxSequence = (1n << this.sequenceBits) - 1n;

  private nodeId: bigint;
  private sequence: bigint = 0n;
  private lastTimestamp: bigint = -1n;

  constructor(nodeId: number) {
    if (BigInt(nodeId) > this.maxNodeId) {
      throw new Error(`Node ID must be <= ${this.maxNodeId}`);
    }
    this.nodeId = BigInt(nodeId);
  }

  generate(): bigint {
    let timestamp = BigInt(Date.now()) - this.epoch;

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & this.maxSequence;
      if (this.sequence === 0n) {
        // Wait for next millisecond
        while (timestamp === this.lastTimestamp) {
          timestamp = BigInt(Date.now()) - this.epoch;
        }
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    return (
      (timestamp << (this.nodeIdBits + this.sequenceBits)) |
      (this.nodeId << this.sequenceBits) |
      this.sequence
    );
  }
}
```

**Benefits:**
- Roughly time-ordered (can sort by ID)
- No coordination needed between machines
- 4 million IDs per second per machine"

---

## Step 6: Comment Write Service

### Write Path Flow

```
1. User posts comment
2. Write Service validates (auth, rate limit, profanity check)
3. Write to Kafka (stream_id as partition key)
4. Return acknowledgment to user
5. Async: Persist to Cassandra
6. Async: Push to fan-out service
```

### Implementation

```typescript
class CommentWriteService {
  constructor(
    private rateLimiter: RateLimiter,
    private kafka: KafkaProducer,
    private idGenerator: SnowflakeIdGenerator,
    private contentFilter: ContentFilter
  ) {}

  async postComment(
    streamId: string,
    userId: string,
    content: string
  ): Promise<Comment> {
    // 1. Rate limit check
    const allowed = await this.rateLimiter.allow(userId, streamId);
    if (!allowed) {
      throw new RateLimitExceededError();
    }

    // 2. Content validation
    if (this.contentFilter.containsBannedWords(content)) {
      throw new ContentViolationError();
    }

    // 3. Create comment with Snowflake ID
    const comment: Comment = {
      id: this.idGenerator.generate(),
      streamId,
      userId,
      content,
      createdAt: Date.now(),
    };

    // 4. Publish to Kafka (async, fire-and-forget for low latency)
    await this.kafka.send({
      topic: `comments-${this.getPartition(streamId)}`,
      key: streamId,
      value: JSON.stringify(comment),
    });

    // 5. Return immediately (persistence is async)
    return comment;
  }

  private getPartition(streamId: string): number {
    // Hash stream ID to topic partition
    return this.hashCode(streamId) % 1000;
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
```

---

## Step 7: Rate Limiting Implementation

### Multi-Layer Rate Limiting

```typescript
class CommentRateLimiter {
  constructor(private redis: Redis) {}

  async allow(userId: string, streamId: string): Promise<boolean> {
    // Global rate limit (across all streams)
    const globalKey = `ratelimit:global:${userId}`;
    const globalCount = await this.redis.incr(globalKey);
    if (globalCount === 1) {
      await this.redis.expire(globalKey, 60);
    }
    if (globalCount > 30) {
      return false; // 30 per minute globally
    }

    // Per-stream rate limit
    const streamKey = `ratelimit:stream:${streamId}:${userId}`;
    const streamCount = await this.redis.incr(streamKey);
    if (streamCount === 1) {
      await this.redis.expire(streamKey, 30);
    }
    if (streamCount > 5) {
      return false; // 5 per 30 seconds per stream
    }

    return true;
  }
}
```

### Adaptive Rate Limiting

```typescript
class AdaptiveRateLimiter {
  async getLimit(userId: string): Promise<number> {
    const reputation = await this.getReputation(userId);

    if (reputation > 0.9) {
      return 10; // Trusted users get higher limit
    } else if (reputation > 0.5) {
      return 5; // Normal limit
    } else {
      return 2; // Suspicious users get lower limit
    }
  }

  private async getReputation(userId: string): Promise<number> {
    // Fetch from user service or cache
    return this.redis.hget(`user:${userId}`, 'reputation') || 0.5;
  }
}
```

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

```typescript
class FanoutService {
  private batchers: Map<string, CommentBatcher> = new Map();

  constructor(private redis: Redis) {}

  async processComment(comment: Comment): Promise<void> {
    const { streamId } = comment;

    // Get or create batcher for this stream
    let batcher = this.batchers.get(streamId);
    if (!batcher) {
      batcher = new CommentBatcher(streamId, this.redis);
      this.batchers.set(streamId, batcher);
      batcher.start();
    }

    // Add to batch buffer
    batcher.addComment(comment);
  }
}

class CommentBatcher {
  private buffer: Comment[] = [];
  private readonly batchInterval = 100; // ms

  constructor(
    private streamId: string,
    private redis: Redis
  ) {}

  addComment(comment: Comment): void {
    this.buffer.push(comment);
  }

  async start(): Promise<void> {
    setInterval(async () => {
      if (this.buffer.length > 0) {
        const batch = this.buffer;
        this.buffer = [];

        // Publish batch to Redis Pub/Sub
        await this.redis.publish(
          `stream:${this.streamId}:comments`,
          JSON.stringify(batch)
        );
      }
    }, this.batchInterval);
  }
}
```

---

## Step 9: Redis Cache and Pub/Sub

### Redis Data Structures

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `recent:stream:{id}` | List | 1hr | Last 1,000 comments (JSON) |
| `stream:{id}:comments` | Pub/Sub | - | Comment batch distribution |
| `stream:{id}:reactions` | Pub/Sub | - | Reaction aggregate distribution |
| `stream:{id}` | Hash | - | viewer_count, metadata |
| `ratelimit:global:{user_id}` | String | 60s | Global rate limit |
| `ratelimit:stream:{stream_id}:{user_id}` | String | 30s | Per-stream rate limit |

### Cache Operations

```typescript
class CommentCacheService {
  constructor(private redis: Redis) {}

  async cacheComment(comment: Comment): Promise<void> {
    const key = `recent:stream:${comment.streamId}`;
    await this.redis.lpush(key, JSON.stringify(comment));
    await this.redis.ltrim(key, 0, 999); // Keep last 1000
    await this.redis.expire(key, 3600); // 1 hour TTL
  }

  async getRecentComments(
    streamId: string,
    limit: number = 50
  ): Promise<Comment[]> {
    const key = `recent:stream:${streamId}`;
    const cached = await this.redis.lrange(key, 0, limit - 1);

    if (cached.length > 0) {
      return cached.map((c) => JSON.parse(c));
    }

    // Cache miss: query database
    return this.loadFromDatabase(streamId, limit);
  }

  private async loadFromDatabase(
    streamId: string,
    limit: number
  ): Promise<Comment[]> {
    // Query Cassandra/PostgreSQL
    // Populate cache
    // Return results
  }
}
```

---

## Step 10: Reaction Aggregation

### High-Volume Reaction Handling

```typescript
class ReactionAggregator {
  private counts: Map<string, number> = new Map();
  private readonly aggregateInterval = 500; // ms

  constructor(
    private streamId: string,
    private redis: Redis
  ) {}

  addReaction(reactionType: string): void {
    const current = this.counts.get(reactionType) || 0;
    this.counts.set(reactionType, current + 1);
  }

  async start(): Promise<void> {
    setInterval(async () => {
      if (this.counts.size > 0) {
        const aggregated = Object.fromEntries(this.counts);
        this.counts.clear();

        // Publish aggregated counts (not individual reactions)
        await this.redis.publish(
          `stream:${this.streamId}:reactions`,
          JSON.stringify({
            type: 'reactions',
            counts: aggregated,
            timestamp: Date.now(),
          })
        );
      }
    }, this.aggregateInterval);
  }
}
```

---

## Step 11: Moderation Pipeline

### Multi-Layer Defense

```
+---------------------------------------------------------------------+
|                    Moderation Pipeline                               |
+---------------------------------------------------------------------+
|                                                                      |
|  Layer 1: Pre-Send Validation (Synchronous, <10ms)                  |
|  - Rate limiting (5 comments per 30 seconds per user)               |
|  - Banned word filter (regex)                                       |
|  - Duplicate detection (exact match in last 100)                    |
|  - Account age check (no comments if account < 1 day)               |
|                                                                      |
|  Layer 2: ML Classification (Async, <100ms)                         |
|  - Spam classifier                                                  |
|  - Toxicity scorer                                                  |
|  - Scam/phishing detector                                           |
|                                                                      |
|  Layer 3: Community Moderation                                       |
|  - User reports                                                     |
|  - Moderator actions                                                |
|  - Auto-hide if N reports in M minutes                              |
|                                                                      |
|  Layer 4: Post-Hoc Analysis                                         |
|  - Batch ML re-evaluation                                           |
|  - Cross-stream pattern detection                                   |
|  - Account-level spam detection                                     |
|                                                                      |
+---------------------------------------------------------------------+
```

### Content Filter Implementation

```typescript
class ContentModerationService {
  private bannedWords: Set<string>;
  private recentHashes: LRUCache<string, boolean>;

  constructor() {
    this.bannedWords = new Set(['spam', 'scam']); // Simplified
    this.recentHashes = new LRUCache({ max: 10000 });
  }

  async moderateComment(comment: Comment): Promise<ModerationResult> {
    // Layer 1: Synchronous checks
    if (this.containsBannedWords(comment.content)) {
      return { status: 'rejected', reason: 'banned_words' };
    }

    if (this.isDuplicate(comment)) {
      return { status: 'rejected', reason: 'duplicate' };
    }

    // Layer 2: Async ML check (fire and forget for live)
    this.asyncMlCheck(comment);

    return { status: 'approved' };
  }

  private containsBannedWords(content: string): boolean {
    const words = content.toLowerCase().split(/\s+/);
    return words.some((word) => this.bannedWords.has(word));
  }

  private isDuplicate(comment: Comment): boolean {
    const hash = this.hashContent(comment.userId, comment.content);
    if (this.recentHashes.has(hash)) {
      return true;
    }
    this.recentHashes.set(hash, true);
    return false;
  }

  private hashContent(userId: string, content: string): string {
    return createHash('sha256')
      .update(`${userId}:${content}`)
      .digest('hex');
  }

  private async asyncMlCheck(comment: Comment): Promise<void> {
    // Send to ML service for toxicity scoring
    // Update moderation_status if flagged
  }
}
```

---

## Step 12: Circuit Breaker Pattern

### Database Protection

```typescript
import CircuitBreaker from 'opossum';

function createDatabaseCircuitBreaker<T>(
  fn: (...args: unknown[]) => Promise<T>
): CircuitBreaker<unknown[], T> {
  const breaker = new CircuitBreaker(fn, {
    timeout: 3000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
    resetTimeout: 10000,
  });

  breaker.on('open', () => {
    logger.warn('Circuit breaker opened - database unavailable');
  });

  breaker.on('halfOpen', () => {
    logger.info('Circuit breaker half-open - probing database');
  });

  breaker.on('close', () => {
    logger.info('Circuit breaker closed - database recovered');
  });

  return breaker;
}

// Usage
const saveComment = createDatabaseCircuitBreaker(
  async (comment: Comment) => {
    return db.query('INSERT INTO comments...', [comment]);
  }
);

try {
  await saveComment.fire(comment);
} catch (error) {
  if (error.name === 'OpenCircuitError') {
    // Fallback: queue for later processing
    await messageQueue.send('pending-comments', comment);
  }
}
```

---

## Step 13: Graceful Degradation

### Handling Viral Streams

```typescript
class DegradationPolicy {
  getPolicy(viewerCount: number): StreamPolicy {
    if (viewerCount < 10000) {
      return {
        batchInterval: 100, // ms
        maxCommentsPerBatch: 50,
        showAllComments: true,
      };
    } else if (viewerCount < 100000) {
      return {
        batchInterval: 200,
        maxCommentsPerBatch: 30,
        showAllComments: true,
      };
    } else {
      return {
        batchInterval: 500,
        maxCommentsPerBatch: 20,
        showAllComments: false,
        samplingRate: 0.1, // Show 10% of comments
      };
    }
  }
}

class CommentSampler {
  sample(comments: Comment[], rate: number): Comment[] {
    if (rate >= 1.0) return comments;

    // Priority scoring
    const scored = comments.map((comment) => {
      let score = 0;
      if (comment.user.isVerified) score += 10;
      if (comment.user.isCreator) score += 100;
      score += comment.reactionCount * 2;
      if (comment.content.includes('?')) score += 5;
      return { score, comment };
    });

    // Sort by score, take top N
    scored.sort((a, b) => b.score - a.score);
    const count = Math.floor(comments.length * rate);
    return scored.slice(0, count).map((s) => s.comment);
  }
}
```

---

## Step 14: Observability

### Prometheus Metrics

```typescript
// Key metrics to track
const metrics = {
  // Latency
  commentPostLatency: new Histogram({
    name: 'comment_post_latency_ms',
    help: 'Comment post to display latency',
    buckets: [50, 100, 250, 500, 1000],
  }),

  // Throughput
  commentsPerSecond: new Gauge({
    name: 'comments_per_second',
    help: 'Comments per second by stream',
    labelNames: ['stream_id'],
  }),

  reactionsPerSecond: new Counter({
    name: 'reactions_total',
    help: 'Total reactions by type',
    labelNames: ['stream_id', 'type'],
  }),

  // Health
  kafkaConsumerLag: new Gauge({
    name: 'kafka_consumer_lag',
    help: 'Kafka consumer lag by topic',
    labelNames: ['topic'],
  }),

  circuitBreakerState: new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
    labelNames: ['service'],
  }),

  // Moderation
  rateLimitExceeded: new Counter({
    name: 'rate_limit_exceeded_total',
    help: 'Rate limit violations',
    labelNames: ['limit_type'],
  }),
};
```

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
