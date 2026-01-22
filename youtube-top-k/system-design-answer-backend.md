# YouTube Top K Videos - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design a real-time analytics backend for tracking video views and computing trending videos across configurable time windows. The core backend challenges are: building a high-throughput view counting pipeline that handles 10K+ events per second, implementing efficient windowed aggregation using Redis sorted sets with time buckets, and designing a Top K algorithm that maintains accurate rankings with minimal computational overhead. I'll focus on the data structures, caching strategies, and background processing that make this possible."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **View Recording**: Accept view events with sub-50ms latency at 10K+ events/second
- **Windowed Counting**: Aggregate views within sliding time windows (1 hour, 24 hours, 7 days)
- **Top K Calculation**: Compute trending videos per category efficiently
- **Real-time Push**: Stream trending updates to clients via SSE

### Non-Functional Requirements
- **Throughput**: 10,000+ view events per second at peak
- **Latency**: < 50ms for view recording, < 100ms for trending queries
- **Availability**: 99.9% uptime
- **Consistency**: Eventual consistency (5-second refresh acceptable)

### Scale Estimates
- **View events/second**: 10,000+ peak
- **Videos**: Millions in catalog
- **Categories**: 20-30 distinct categories
- **Active time buckets**: ~70 per category (60-minute window + buffer)

### Key Backend Questions
1. How fresh must trending data be? (Real-time vs. 5-second delay)
2. Should we deduplicate views per session?
3. What accuracy is acceptable (exact vs. approximate counting)?

## High-Level Backend Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Load Balancer                                │
│                      (nginx / HAProxy)                               │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
  ┌──────────┐        ┌──────────┐        ┌──────────┐
  │ API      │        │ API      │        │ API      │
  │ Server 1 │        │ Server 2 │        │ Server 3 │
  │ :3001    │        │ :3002    │        │ :3003    │
  └────┬─────┘        └────┬─────┘        └────┬─────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │                                   │
         ▼                                   ▼
 ┌───────────────┐                  ┌───────────────┐
 │    Redis      │                  │  PostgreSQL   │
 │               │                  │               │
 │ - Time        │                  │ - Videos      │
 │   buckets     │                  │ - Snapshots   │
 │ - Sorted sets │                  │ - View logs   │
 │ - Idempotency │                  │               │
 └───────────────┘                  └───────────────┘
```

### Component Responsibilities

1. **API Server**: Stateless Express servers handling view recording and trending queries
2. **TrendingService**: Background process computing Top K periodically
3. **Redis**: Time-bucketed sorted sets for windowed counting
4. **PostgreSQL**: Video metadata, historical snapshots, audit logs

## Deep Dive: Time-Bucketed View Counting (10 minutes)

### Core Data Structure: Redis Sorted Sets with Time Buckets

```typescript
class ViewCounter {
  private redis: Redis;
  private bucketSizeMs = 60000;   // 1-minute buckets
  private windowSizeMs = 3600000; // 1-hour window
  private expirationBuffer = 600000; // 10-minute buffer

  async recordView(
    videoId: string,
    category: string,
    sessionId?: string
  ): Promise<{ success: boolean; duplicate: boolean }> {
    // Step 1: Check idempotency (prevent duplicate views)
    if (sessionId) {
      const timeBucket = Math.floor(Date.now() / 10000); // 10-second buckets
      const idempotencyKey = `idem:view:${videoId}:${sessionId}:${timeBucket}`;

      const isNew = await this.redis.set(idempotencyKey, '1', {
        NX: true,  // Only set if not exists
        EX: 3600   // 1-hour TTL
      });

      if (!isNew) {
        return { success: true, duplicate: true };
      }
    }

    // Step 2: Calculate current time bucket
    const bucket = Math.floor(Date.now() / this.bucketSizeMs);
    const expireSeconds = Math.ceil(
      (this.windowSizeMs + this.expirationBuffer) / 1000
    );

    // Step 3: Increment counts in pipeline (atomic)
    const pipeline = this.redis.pipeline();

    // Increment in category-specific bucket
    const categoryKey = `views:bucket:${category}:${bucket}`;
    pipeline.zincrby(categoryKey, 1, videoId);
    pipeline.expire(categoryKey, expireSeconds);

    // Increment in 'all' category bucket
    const allKey = `views:bucket:all:${bucket}`;
    pipeline.zincrby(allKey, 1, videoId);
    pipeline.expire(allKey, expireSeconds);

    // Increment total views (for display)
    pipeline.hincrby('views:total', videoId, 1);

    await pipeline.exec();

    return { success: true, duplicate: false };
  }

  async getTopK(
    category: string,
    k: number,
    windowMs: number = this.windowSizeMs
  ): Promise<Array<{ videoId: string; viewCount: number }>> {
    const now = Date.now();
    const numBuckets = Math.ceil(windowMs / this.bucketSizeMs);

    // Collect all bucket keys for the window
    const bucketKeys: string[] = [];
    for (let i = 0; i < numBuckets; i++) {
      const bucket = Math.floor((now - i * this.bucketSizeMs) / this.bucketSizeMs);
      bucketKeys.push(`views:bucket:${category}:${bucket}`);
    }

    // Aggregate all buckets into a temporary sorted set
    const tempKey = `temp:topk:${category}:${Date.now()}:${Math.random()}`;

    if (bucketKeys.length > 0) {
      await this.redis.zunionstore(tempKey, bucketKeys.length, ...bucketKeys);
      await this.redis.expire(tempKey, 60); // Clean up after 1 minute
    }

    // Get top K from aggregated set
    const results = await this.redis.zrevrange(tempKey, 0, k - 1, 'WITHSCORES');

    // Parse results (alternating videoId, score)
    const topK: Array<{ videoId: string; viewCount: number }> = [];
    for (let i = 0; i < results.length; i += 2) {
      topK.push({
        videoId: results[i],
        viewCount: parseInt(results[i + 1], 10)
      });
    }

    return topK;
  }
}
```

### Why Time Buckets?

| Approach | Time Complexity | Memory | Accuracy | Use Case |
|----------|-----------------|--------|----------|----------|
| Global counter | O(1) | O(n) | High | All-time counts only |
| Per-view timestamps | O(m) scan | O(m) views | Perfect | Small scale |
| **Time buckets** | O(b log n) | O(b * n) | High | Production (chosen) |
| HyperLogLog | O(1) | O(1) | ~98% | Unique visitors |

Time buckets enable ZUNIONSTORE for O(b * n log n) aggregation where b is bucket count and n is video count.

### Bucket Size Trade-offs

```
┌─────────────────────────────────────────────────────────────────┐
│                    Bucket Granularity Trade-offs                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Fine-grained (1s)          Coarse-grained (5m)                 │
│  ◄────────────────────────────────────────────────────►         │
│                                                                  │
│  - Most accurate             - Fewer keys                        │
│  - 3600 keys/hour            - 12 keys/hour                      │
│  - Higher memory             - Lower memory                      │
│  - Smaller boundary          - Larger boundary                   │
│    effects                     effects                           │
│                                                                  │
│                  1-minute (CHOSEN)                               │
│                  - 60 keys/hour                                  │
│                  - Good accuracy                                 │
│                  - Acceptable memory                             │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Top K Algorithms (8 minutes)

### Min-Heap Based Exact Top K

```typescript
class MinHeap<T> {
  private items: Array<{ id: T; score: number }> = [];

  get size(): number {
    return this.items.length;
  }

  peek(): { id: T; score: number } | undefined {
    return this.items[0];
  }

  push(item: { id: T; score: number }): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): { id: T; score: number } | undefined {
    if (this.items.length === 0) return undefined;

    const min = this.items[0];
    const last = this.items.pop()!;

    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }

    return min;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.items[parentIndex].score <= this.items[index].score) break;
      [this.items[parentIndex], this.items[index]] =
        [this.items[index], this.items[parentIndex]];
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.items.length &&
          this.items[leftChild].score < this.items[smallest].score) {
        smallest = leftChild;
      }
      if (rightChild < this.items.length &&
          this.items[rightChild].score < this.items[smallest].score) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      [this.items[smallest], this.items[index]] =
        [this.items[index], this.items[smallest]];
      index = smallest;
    }
  }

  toSortedArray(): Array<{ id: T; score: number }> {
    return [...this.items].sort((a, b) => b.score - a.score);
  }
}

class TopK<T> {
  private k: number;
  private heap: MinHeap<T>;
  private itemMap: Map<T, number> = new Map();

  constructor(k: number) {
    this.k = k;
    this.heap = new MinHeap<T>();
  }

  update(id: T, score: number): void {
    if (this.heap.size < this.k) {
      this.heap.push({ id, score });
      this.itemMap.set(id, score);
    } else if (score > this.heap.peek()!.score) {
      const evicted = this.heap.pop()!;
      this.itemMap.delete(evicted.id);

      this.heap.push({ id, score });
      this.itemMap.set(id, score);
    }
  }

  getTop(): Array<{ id: T; score: number }> {
    return this.heap.toSortedArray();
  }
}
```

### Approximate Algorithms for Scale

**Count-Min Sketch** (Frequency estimation with bounded overcount):

```typescript
class CountMinSketch {
  private width: number;
  private depth: number;
  private table: number[][];
  private hashSeeds: number[];

  constructor(width: number = 10000, depth: number = 5) {
    this.width = width;
    this.depth = depth;
    this.table = Array(depth).fill(null).map(() => Array(width).fill(0));
    this.hashSeeds = Array(depth).fill(0).map(() => Math.random() * 0xFFFFFFFF);
  }

  private hash(key: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) % this.width;
  }

  increment(key: string, count: number = 1): void {
    for (let i = 0; i < this.depth; i++) {
      const index = this.hash(key, this.hashSeeds[i]);
      this.table[i][index] += count;
    }
  }

  estimate(key: string): number {
    let minCount = Infinity;
    for (let i = 0; i < this.depth; i++) {
      const index = this.hash(key, this.hashSeeds[i]);
      minCount = Math.min(minCount, this.table[i][index]);
    }
    return minCount; // May overestimate, never underestimates
  }
}
```

**Space-Saving** (Heavy hitters with guaranteed accuracy):

```typescript
class SpaceSaving {
  private capacity: number;
  private counters: Map<string, number> = new Map();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  increment(key: string): void {
    if (this.counters.has(key)) {
      this.counters.set(key, this.counters.get(key)! + 1);
    } else if (this.counters.size < this.capacity) {
      this.counters.set(key, 1);
    } else {
      // Find and replace minimum
      let minKey = '';
      let minCount = Infinity;

      for (const [k, v] of this.counters) {
        if (v < minCount) {
          minCount = v;
          minKey = k;
        }
      }

      this.counters.delete(minKey);
      this.counters.set(key, minCount + 1);
    }
  }

  getTopK(k: number): Array<[string, number]> {
    return [...this.counters.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }
}
```

### Algorithm Comparison

| Algorithm | Memory | Accuracy | Best For |
|-----------|--------|----------|----------|
| Exact (sorted sets) | O(n) | 100% | < 10M items |
| Count-Min Sketch | O(w * d) | ~99% | Frequency queries |
| Space-Saving | O(k) | Top K guaranteed | Heavy hitters only |
| HyperLogLog | O(1) | ~98% cardinality | Unique counts |

## Deep Dive: Background Trending Service (7 minutes)

### TrendingService with SSE Broadcasting

```typescript
interface TrendingResult {
  category: string;
  videos: Array<{
    videoId: string;
    title: string;
    viewCount: number;
    rank: number;
  }>;
  computedAt: Date;
}

class TrendingService {
  private viewCounter: ViewCounter;
  private redis: Redis;
  private db: Pool;
  private clients: Set<Response> = new Set();
  private cache: Map<string, TrendingResult> = new Map();
  private refreshIntervalMs = 5000; // 5 seconds
  private categories = ['all', 'music', 'gaming', 'sports', 'news', 'education'];

  async start(): Promise<void> {
    // Initial computation
    await this.computeAllTrending();

    // Periodic refresh
    setInterval(() => this.computeAndBroadcast(), this.refreshIntervalMs);

    console.log('TrendingService started');
  }

  private async computeAllTrending(): Promise<Map<string, TrendingResult>> {
    const results = new Map<string, TrendingResult>();

    // Compute trending for each category in parallel
    const computations = this.categories.map(async (category) => {
      const topK = await this.viewCounter.getTopK(category, 10, 3600000);

      // Enrich with video metadata
      if (topK.length > 0) {
        const videoIds = topK.map(v => v.videoId);
        const videos = await this.getVideoMetadata(videoIds);

        const enriched = topK.map((item, index) => ({
          videoId: item.videoId,
          title: videos.get(item.videoId)?.title || 'Unknown',
          viewCount: item.viewCount,
          rank: index + 1
        }));

        results.set(category, {
          category,
          videos: enriched,
          computedAt: new Date()
        });
      }
    });

    await Promise.all(computations);

    // Update cache
    for (const [category, result] of results) {
      this.cache.set(category, result);
    }

    return results;
  }

  private async computeAndBroadcast(): Promise<void> {
    try {
      const trending = await this.computeAllTrending();

      // Serialize for SSE
      const data = Object.fromEntries(trending);
      const message = `data: ${JSON.stringify(data)}\n\n`;

      // Broadcast to all connected clients
      for (const client of this.clients) {
        try {
          client.write(message);
        } catch (err) {
          // Client disconnected
          this.clients.delete(client);
        }
      }

      // Save snapshot periodically (every 5 minutes)
      if (Date.now() % 300000 < this.refreshIntervalMs) {
        await this.saveTrendingSnapshot(trending);
      }
    } catch (err) {
      console.error('Error computing trending:', err);
    }
  }

  handleSSEConnection(req: Request, res: Response): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Send initial data from cache
    const initialData = Object.fromEntries(this.cache);
    res.write(`data: ${JSON.stringify(initialData)}\n\n`);

    // Register client
    this.clients.add(res);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    // Handle disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }

  private async getVideoMetadata(
    videoIds: string[]
  ): Promise<Map<string, { title: string; thumbnail: string }>> {
    const result = await this.db.query(
      'SELECT id, title, thumbnail_url FROM videos WHERE id = ANY($1)',
      [videoIds]
    );

    const map = new Map();
    for (const row of result.rows) {
      map.set(row.id, { title: row.title, thumbnail: row.thumbnail_url });
    }
    return map;
  }

  private async saveTrendingSnapshot(
    trending: Map<string, TrendingResult>
  ): Promise<void> {
    for (const [category, result] of trending) {
      await this.db.query(
        `INSERT INTO trending_snapshots (window_type, category, video_rankings, snapshot_at)
         VALUES ($1, $2, $3, $4)`,
        ['hourly', category === 'all' ? null : category, result.videos, new Date()]
      );
    }
  }
}
```

### Rate Limiting for View Fraud Prevention

```typescript
class ViewValidator {
  private redis: Redis;

  async isValidView(
    videoId: string,
    sessionId: string,
    ip: string
  ): Promise<{ valid: boolean; reason?: string }> {
    const pipeline = this.redis.pipeline();

    // Rate limit per session per video (5 views/hour)
    const sessionKey = `rate:session:${sessionId}:${videoId}`;
    pipeline.incr(sessionKey);
    pipeline.expire(sessionKey, 3600);

    // Rate limit per IP per video (10 views/minute)
    const ipKey = `rate:ip:${ip}:${videoId}`;
    pipeline.incr(ipKey);
    pipeline.expire(ipKey, 60);

    // Global rate limit per IP (100 views/minute across all videos)
    const globalIpKey = `rate:ip:${ip}:global`;
    pipeline.incr(globalIpKey);
    pipeline.expire(globalIpKey, 60);

    const results = await pipeline.exec();

    const sessionCount = results[0][1] as number;
    const ipCount = results[2][1] as number;
    const globalCount = results[4][1] as number;

    if (sessionCount > 5) {
      return { valid: false, reason: 'Session rate limit exceeded' };
    }
    if (ipCount > 10) {
      return { valid: false, reason: 'IP rate limit per video exceeded' };
    }
    if (globalCount > 100) {
      return { valid: false, reason: 'Global IP rate limit exceeded' };
    }

    return { valid: true };
  }
}
```

## Database Schema (3 minutes)

```sql
-- Videos table (core metadata)
CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  thumbnail_url VARCHAR(500),
  channel_name VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,
  duration_seconds INTEGER NOT NULL,
  total_views BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_videos_category ON videos(category);
CREATE INDEX idx_videos_total_views ON videos(total_views DESC);
CREATE INDEX idx_videos_created_at ON videos(created_at DESC);

-- View events (for audit, 7-day retention)
CREATE TABLE view_events (
  id BIGSERIAL PRIMARY KEY,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ DEFAULT NOW(),
  session_id VARCHAR(100),
  idempotency_key VARCHAR(255) UNIQUE
) PARTITION BY RANGE (viewed_at);

-- Create daily partitions
CREATE TABLE view_events_y2024m01d01 PARTITION OF view_events
  FOR VALUES FROM ('2024-01-01') TO ('2024-01-02');

-- Trending snapshots (for historical analysis)
CREATE TABLE trending_snapshots (
  id SERIAL PRIMARY KEY,
  window_type VARCHAR(50) NOT NULL,
  category VARCHAR(100),
  video_rankings JSONB NOT NULL,
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trending_snapshots_lookup
  ON trending_snapshots(window_type, category, snapshot_at DESC);

-- Trigger to update video total_views (optional sync)
CREATE OR REPLACE FUNCTION sync_total_views()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE videos SET total_views = total_views + 1
  WHERE id = NEW.video_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_views
  AFTER INSERT ON view_events
  FOR EACH ROW EXECUTE FUNCTION sync_total_views();
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Counting approach | Exact (Redis sorted sets) | Higher memory, accurate | Count-Min Sketch for ~2% error |
| Bucket granularity | 1-minute | 60 keys/hour, good accuracy | 5-minute for fewer keys |
| Real-time updates | SSE | Simple, unidirectional | WebSocket for bidirectional |
| Aggregation | ZUNIONSTORE | O(n log n), exact | Pre-aggregated keys |
| Idempotency | Redis SETNX | Extra Redis calls | Accept duplicates |
| Persistence | PostgreSQL snapshots | Historical analysis | Redis persistence only |

### When to Switch Algorithms

```
Views/second:     100    1K     10K    100K    1M
                   │      │       │       │      │
Algorithm:    ─────┴──────┴───────┴───────┴──────┘
              │ Exact Redis  │ Space-Saving │ CMS+TopK
              │ sorted sets  │ or HLL       │ distributed
```

## Monitoring and Observability (2 minutes)

### Key Metrics

```typescript
// Prometheus metrics
const viewsRecorded = new Counter({
  name: 'youtube_topk_views_recorded_total',
  help: 'Total views recorded',
  labelNames: ['category', 'duplicate']
});

const viewLatency = new Histogram({
  name: 'youtube_topk_view_recording_seconds',
  help: 'View recording latency',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1]
});

const trendingComputeLatency = new Histogram({
  name: 'youtube_topk_trending_compute_seconds',
  help: 'Trending computation latency',
  labelNames: ['category']
});

const sseClients = new Gauge({
  name: 'youtube_topk_sse_clients',
  help: 'Number of connected SSE clients'
});

const redisMemory = new Gauge({
  name: 'youtube_topk_redis_memory_bytes',
  help: 'Redis memory usage'
});
```

### Health Check Endpoint

```typescript
app.get('/health', async (req, res) => {
  const checks = {
    redis: await checkRedis(),
    postgres: await checkPostgres(),
    trendingService: trendingService.isRunning()
  };

  const healthy = Object.values(checks).every(Boolean);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});
```

## Closing Summary (1 minute)

"The YouTube Top K backend is built around three core mechanisms:

1. **Time-bucketed counting with Redis sorted sets** - Views are recorded in 1-minute buckets per category, enabling O(n log n) ZUNIONSTORE aggregation for any time window. Idempotency keys prevent duplicate counting.

2. **Background TrendingService with SSE push** - A single background process computes Top K every 5 seconds and broadcasts to all connected clients via Server-Sent Events, avoiding expensive per-request computation.

3. **Layered rate limiting** - Multi-level protection (per-session, per-IP, global) prevents view count manipulation while maintaining sub-50ms recording latency.

The key trade-off is accuracy vs. resource usage. Exact counting with Redis sorted sets works well up to 10M videos. Beyond that, I'd switch to Space-Saving for heavy hitters or Count-Min Sketch for approximate counts. For future improvements, I'd add geographic trending, anomaly detection for viral spikes, and A/B testing infrastructure for ranking algorithm experiments."
