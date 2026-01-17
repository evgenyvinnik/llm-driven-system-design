# YouTube Top K Videos - Architecture Design

## System Overview

A real-time analytics system for tracking video views and computing trending videos across different time windows and categories.

## Requirements

### Functional Requirements

- **View counting**: Track video views with high throughput
- **Trending calculation**: Compute top K trending videos within configurable time windows
- **Category-based trends**: Support trending by category (music, gaming, sports, etc.)
- **Real-time updates**: Push trending updates to connected clients

### Non-Functional Requirements

- **Scalability**: Handle high view rates (designed for 10K+ views/second)
- **Availability**: 99.9% uptime target
- **Latency**: < 100ms for trending queries, < 50ms for view recording
- **Consistency**: Eventual consistency acceptable for trending (5-second refresh)

## Capacity Estimation

*For a medium-scale deployment:*

- Daily Active Users (DAU): 1 million
- Average views per user per day: 10
- Peak traffic multiplier: 3x
- Requests per second (RPS):
  - Average: ~115 views/second
  - Peak: ~350 views/second
- Storage requirements:
  - PostgreSQL: ~10GB for video metadata
  - Redis: ~500MB for windowed counters

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│              React + TypeScript + Tanstack Router                   │
│                    + Zustand + Tailwind CSS                         │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ HTTP / SSE
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         API Gateway / LB                             │
│                      (nginx / HAProxy)                               │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
    ┌──────────┐           ┌──────────┐           ┌──────────┐
    │ API      │           │ API      │           │ API      │
    │ Server 1 │           │ Server 2 │           │ Server 3 │
    │ :3001    │           │ :3002    │           │ :3003    │
    └────┬─────┘           └────┬─────┘           └────┬─────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
              ▼                                   ▼
      ┌──────────────┐                   ┌──────────────┐
      │    Redis     │                   │  PostgreSQL  │
      │   :6379      │                   │    :5432     │
      │              │                   │              │
      │ - View       │                   │ - Videos     │
      │   counters   │                   │ - Snapshots  │
      │ - Time       │                   │ - Events     │
      │   buckets    │                   │              │
      └──────────────┘                   └──────────────┘
```

### Core Components

1. **API Server (Express.js)**
   - REST API for video CRUD and view recording
   - SSE endpoint for real-time trending updates
   - Stateless, horizontally scalable

2. **TrendingService**
   - Background process running on each API server
   - Periodically computes Top K from Redis aggregations
   - Notifies connected SSE clients of updates

3. **Redis (View Counter)**
   - Sorted sets for windowed counting
   - Time-bucketed keys (1-minute granularity)
   - Automatic TTL expiration for old buckets

4. **PostgreSQL (Persistent Storage)**
   - Video metadata
   - Historical snapshots (optional)
   - View event log (optional)

## Data Model

### PostgreSQL Schema

```sql
-- Videos table
CREATE TABLE videos (
  id UUID PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  thumbnail_url VARCHAR(500),
  channel_name VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,
  duration_seconds INTEGER NOT NULL,
  total_views BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- View events (for historical analysis)
CREATE TABLE view_events (
  id SERIAL PRIMARY KEY,
  video_id UUID REFERENCES videos(id),
  viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  session_id VARCHAR(100)
);

-- Trending snapshots (for historical trending)
CREATE TABLE trending_snapshots (
  id SERIAL PRIMARY KEY,
  window_type VARCHAR(50) NOT NULL,
  category VARCHAR(100),
  video_rankings JSONB NOT NULL,
  snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Redis Data Structures

```
# Windowed view counters (sorted sets)
views:bucket:all:1234567 -> { videoId1: 5, videoId2: 3, ... }
views:bucket:music:1234567 -> { videoId1: 2, videoId3: 1, ... }

# Total view counts (hash)
views:total -> { videoId1: 10000, videoId2: 5000, ... }
```

## API Design

### Core Endpoints

#### Videos
```
GET    /api/videos              - List videos with pagination
GET    /api/videos/:id          - Get video by ID
POST   /api/videos              - Create video
POST   /api/videos/:id/view     - Record a view
POST   /api/videos/batch-view   - Record multiple views
```

#### Trending
```
GET    /api/trending            - Get trending videos (?category=)
GET    /api/trending/all        - Get all categories
GET    /api/trending/categories - List categories
GET    /api/trending/stats      - Get statistics
POST   /api/trending/refresh    - Force refresh
```

#### Real-time
```
GET    /api/sse/trending        - SSE stream for updates
GET    /api/sse/heartbeat       - Heartbeat for testing
```

## Key Design Decisions

### 1. Windowed Counting with Time Buckets

**Problem:** Need to count views within a sliding time window efficiently.

**Solution:** Use Redis sorted sets with time-bucketed keys.

```javascript
// 1-minute buckets
const bucket = Math.floor(Date.now() / 60000);
const key = `views:bucket:${category}:${bucket}`;

// Increment view count
await redis.zIncrBy(key, 1, videoId);
await redis.expire(key, 3600 + 600); // Window + buffer

// Aggregate last 60 buckets for hourly trending
await redis.zUnionStore(tempKey, last60BucketKeys);
const topK = await redis.zRangeWithScores(tempKey, 0, k-1, { REV: true });
```

**Trade-offs:**
- Pro: O(log N) operations, native aggregation
- Pro: Exact counts within time window
- Con: More memory than approximate algorithms
- Con: Key proliferation (mitigated by TTL)

### 2. Top K Algorithm

**Implementation:** Min-heap based Top K

```javascript
class TopK {
  constructor(k) {
    this.k = k;
    this.heap = new MinHeap();
  }

  update(id, score) {
    if (this.heap.size < this.k) {
      this.heap.push({ id, score });
    } else if (score > this.heap.peek().score) {
      this.heap.pop();
      this.heap.push({ id, score });
    }
  }
}
```

**Alternative algorithms included:**
- **CountMinSketch**: Approximate frequency counting for high cardinality
- **SpaceSaving**: Heavy hitters with bounded error

### 3. Real-time Updates via SSE

**Why SSE over WebSocket:**
- Unidirectional (server → client) is sufficient
- Built-in reconnection
- Simpler implementation
- HTTP/2 multiplexing

## Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Frontend** | React 19 + TypeScript | Modern, type-safe UI |
| **Routing** | Tanstack Router | File-based, type-safe routing |
| **State** | Zustand | Lightweight, simple API |
| **Styling** | Tailwind CSS | Rapid development |
| **Backend** | Node.js + Express | Fast development, ecosystem |
| **Cache** | Redis | Native sorted sets, pub/sub |
| **Database** | PostgreSQL | Reliable, full-featured |

## Scalability Considerations

### Horizontal Scaling

1. **API Servers**: Stateless, add more behind load balancer
2. **Redis**: Can use Redis Cluster for sharding
3. **PostgreSQL**: Read replicas for queries, primary for writes

### High Traffic Optimizations

1. **Batch writes**: Aggregate views before Redis writes
2. **Local caching**: Cache trending results with short TTL
3. **Rate limiting**: Protect against abuse
4. **Circuit breakers**: Graceful degradation

### Approximate Counting at Scale

When exact counting becomes too expensive:

```javascript
// CountMinSketch for approximate frequency
const cms = new CountMinSketch(width=10000, depth=5);
cms.increment(videoId);
const estimate = cms.estimate(videoId); // May overestimate

// SpaceSaving for streaming heavy hitters
const ss = new SpaceSaving(k=100);
ss.increment(videoId);
const topK = ss.getTopK(10); // Guaranteed to include true top 10
```

## Trade-offs and Alternatives

| Decision | Trade-off | Alternative |
|----------|-----------|-------------|
| Redis sorted sets | Higher memory, exact counts | CountMinSketch for lower memory |
| 1-minute buckets | More keys, finer granularity | 5-minute for fewer keys |
| SSE | Simple, unidirectional | WebSocket for bidirectional |
| Single Redis | Simple, potential bottleneck | Redis Cluster for scale |

## Monitoring and Observability

### Metrics to Track

- View recording latency (p50, p95, p99)
- Trending query latency
- Redis memory usage
- SSE client count
- Error rates by endpoint

### Health Checks

```
GET /health → { status: "healthy", redis: "connected", postgres: "connected" }
```

## Security Considerations

1. **Rate limiting**: Prevent view count manipulation
2. **Input validation**: Sanitize video IDs and categories
3. **CORS**: Restrict to known origins
4. **Bot detection**: Filter automated traffic (future)

## Future Optimizations

1. **Geographic trending**: Trending by region
2. **Personalized trending**: Based on user preferences
3. **Trend velocity**: Rate of change detection
4. **Anomaly detection**: Identify unusual spikes
5. **A/B testing**: Experiment with ranking algorithms
