# YouTube Top K Videos - Architecture Design

## System Overview

A real-time analytics system for tracking video views and computing trending videos across configurable time windows and categories. The system ingests high-throughput view events, aggregates them using time-bucketed counters in Redis, computes top-k rankings using heap-based algorithms, and pushes updates to connected clients via Server-Sent Events.

**Learning Goals:**
- Design high-throughput event ingestion with idempotency
- Implement windowed aggregation using Redis sorted sets
- Build top-k algorithms (MinHeap, CountMinSketch, SpaceSaving)
- Handle real-time streaming updates via SSE

---

## Requirements

### Functional Requirements

- **View counting**: Track video views with high throughput and duplicate prevention
- **Trending calculation**: Compute top K trending videos within configurable time windows
- **Category-based trends**: Support trending by category (music, gaming, sports, etc.)
- **Real-time updates**: Push trending updates to connected clients via SSE
- **View simulation**: Generate synthetic view traffic for testing and demos

### Non-Functional Requirements

- **Scalability**: Handle 10K+ views/second at production scale
- **Availability**: 99.9% uptime target
- **Latency**: < 100ms for trending queries, < 50ms for view recording
- **Consistency**: Eventual consistency acceptable for trending (5-second refresh cycle)
- **Data retention**: View events kept 7 days, trending snapshots kept 30 days

---

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Daily Active Users | 100M |
| Average views per user per day | 20 |
| Peak traffic multiplier | 5x average |
| Views per second (average) | ~23K |
| Views per second (peak) | ~115K |
| Unique videos | 500M |
| Active videos (viewed in last hour) | ~5M |
| Categories | 15-20 |
| Redis memory (counters) | ~10GB |
| PostgreSQL (video metadata) | ~500GB |
| View event log (7-day) | ~15TB |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Seeded videos | ~50 |
| Categories | 7 |
| Simulated views/sec | 10-100 |
| Redis memory | < 50MB |
| PostgreSQL storage | < 100MB |
| SSE clients | 1-5 |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                │
│        Web Dashboard  │  Mobile App  │  API Consumers                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTP / SSE
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway / CDN                              │
│          (Load balancing, rate limiting, SSE routing)                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  API Server 1    │ │  API Server 2    │ │  API Server N    │
│                  │ │                  │ │                  │
│ - View ingestion │ │ - View ingestion │ │ - View ingestion │
│ - Trending API   │ │ - Trending API   │ │ - Trending API   │
│ - SSE streaming  │ │ - SSE streaming  │ │ - SSE streaming  │
│ - Trending       │ │ - Trending       │ │ - Trending       │
│   Service (bg)   │ │   Service (bg)   │ │   Service (bg)   │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                      │
         └────────────────────┼──────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│    Redis     │    │   PostgreSQL     │    │ Message Queue│
│              │    │                  │    │  (Kafka)     │
│ - View       │    │ - Video metadata │    │              │
│   counters   │    │ - View events    │    │ - View event │
│ - Time       │    │ - Trending       │    │   ingestion  │
│   buckets    │    │   snapshots      │    │ - Async      │
│ - Idempotency│    │ - Schema         │    │   processing │
│   keys       │    │   migrations     │    │              │
└──────────────┘    └──────────────────┘    └──────────────┘
```

At production scale, a message queue (Kafka) sits between view ingestion and Redis/PostgreSQL writes to absorb traffic spikes. The local implementation writes directly to Redis and PostgreSQL.

---

## Core Components

### 1. View Ingestion

The view recording endpoint accepts view events, deduplicates them using idempotency keys, and updates counters in Redis:

1. Client sends `POST /api/videos/:id/view` with optional `session_id`
2. Generate idempotency key: `{videoId}:{sessionId}:{timeBucket}` (10-second buckets)
3. Redis `SETNX` with 1-hour TTL: if key exists, skip (duplicate)
4. If new view: increment Redis sorted set for the current time bucket
5. Increment total view count in Redis hash
6. Optionally log to `view_events` table for historical analysis

**Batch endpoint**: `POST /api/videos/batch-view` accepts multiple views in a single request, reducing HTTP overhead during high-traffic periods.

### 2. Windowed View Counting

Redis sorted sets store view counts in time-bucketed keys:

```
views:bucket:{category}:{minuteBucket}  →  { videoId: count, ... }
```

- **Bucket granularity**: 1 minute (configurable via `BUCKET_SIZE_MINUTES`)
- **Window size**: 60 minutes (configurable via `WINDOW_SIZE_MINUTES`)
- **TTL**: Window size + 10-minute buffer for aggregation overlap
- **Aggregation**: `ZUNIONSTORE` combines the last 60 bucket keys into a temporary sorted set

**Why 1-minute buckets**: Finer granularity (e.g., 10 seconds) creates too many Redis keys (360 per category per hour). Coarser granularity (e.g., 15 minutes) makes trending scores change in jumpy steps rather than smooth curves. 1-minute buckets provide smooth score transitions with ~70 keys per category.

### 3. Top K Algorithm

The trending service computes top-k videos using a min-heap:

1. Aggregate last 60 time buckets via `ZUNIONSTORE`
2. Get all video scores from the aggregated sorted set
3. Push each `{videoId, score}` into a min-heap of size K
4. If heap is full and new score > heap minimum, replace the minimum
5. Result: top K videos in O(N log K) time, O(K) space

**Alternative implementations included in codebase:**
- **CountMinSketch**: Approximate frequency counting for high cardinality (O(1) per update, bounded overestimation)
- **SpaceSaving**: Streaming heavy hitters with guaranteed top-k accuracy (O(1) amortized per update)

**When to switch**: MinHeap is exact but requires seeing all scores. At 5M+ active videos, iterating all scores becomes expensive. SpaceSaving processes events in a streaming fashion without the aggregation step, making it better for extreme scale.

### 4. Trending Service

A background process running on each API server instance:

1. Every 5 seconds (configurable), compute top-k for each category
2. Compare with previous results; if changed, broadcast to SSE clients
3. Optionally save snapshots to `trending_snapshots` table for historical analysis
4. Track heap operation metrics for algorithm optimization decisions

The trending service uses an in-memory cache with a 5-second TTL. API requests hitting `/api/trending` serve from this cache, avoiding repeated Redis aggregation.

### 5. Real-Time Streaming (SSE)

Server-Sent Events push trending updates to connected clients:

- **Endpoint**: `GET /api/sse/trending`
- **Event types**: `trending-update` (new rankings), `heartbeat` (keep-alive)
- **Reconnection**: Built-in browser auto-reconnect with `Last-Event-ID` support
- **Scaling concern**: Each API server maintains its own SSE connections. At scale, a Redis pub/sub layer broadcasts trending updates to all servers, which then push to their connected clients.

**Why SSE over WebSocket**: The data flow is unidirectional (server to client). SSE provides auto-reconnection, works with HTTP/2 multiplexing, and requires no special protocol upgrade. WebSocket would add bidirectional capability that is unused here while complicating the proxy and load balancer configuration.

---

## Database Schema

### PostgreSQL Schema

```sql
-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Videos table (core metadata)
CREATE TABLE IF NOT EXISTS videos (
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

CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
CREATE INDEX IF NOT EXISTS idx_videos_total_views ON videos(total_views DESC);

-- View events (historical log, 7-day retention)
CREATE TABLE IF NOT EXISTS view_events (
  id SERIAL PRIMARY KEY,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  session_id VARCHAR(100),
  idempotency_key VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_view_events_video_id ON view_events(video_id);
CREATE INDEX IF NOT EXISTS idx_view_events_viewed_at ON view_events(viewed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_view_events_idempotency_key
  ON view_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_view_events_viewed_at_for_cleanup
  ON view_events(viewed_at)
  WHERE viewed_at < NOW() - INTERVAL '7 days';

-- Trending snapshots (historical rankings, 30-day retention)
CREATE TABLE IF NOT EXISTS trending_snapshots (
  id SERIAL PRIMARY KEY,
  window_type VARCHAR(50) NOT NULL,
  category VARCHAR(100),
  video_rankings JSONB NOT NULL,
  snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trending_snapshots_window
  ON trending_snapshots(window_type, snapshot_at);
```

### Redis Data Structures

```
# Windowed view counters (SORTED SET, 70-min TTL)
views:bucket:all:{minuteBucket}      →  { videoId: viewCount, ... }
views:bucket:music:{minuteBucket}    →  { videoId: viewCount, ... }
views:bucket:gaming:{minuteBucket}   →  { videoId: viewCount, ... }

# Total view counts (HASH, no TTL, synced from PostgreSQL)
views:total  →  { videoId: totalViews, ... }

# Idempotency keys (STRING, 1-hour TTL)
idem:view:{videoId}:{sessionId}:{timeBucket}  →  "1"
```

---

## API Design

### Video Endpoints

```
GET    /api/videos              → List videos with pagination
GET    /api/videos/:id          → Get video by ID
POST   /api/videos              → Create video
POST   /api/videos/:id/view     → Record a view (with idempotency)
POST   /api/videos/batch-view   → Record multiple views
```

### Trending Endpoints

```
GET    /api/trending             → Get trending videos (?category=)
GET    /api/trending/all         → Get all categories' trending
GET    /api/trending/categories  → List available categories
GET    /api/trending/stats       → Get statistics (cache hit rate, update count)
POST   /api/trending/refresh     → Force trending refresh
```

### Real-Time Endpoints

```
GET    /api/sse/trending         → SSE stream for trending updates
GET    /api/sse/heartbeat        → Heartbeat stream for testing
```

### Operations Endpoints

```
GET    /health                   → Simple health check
GET    /health/ready             → Readiness probe (PG + Redis + TrendingService)
GET    /health/live              → Liveness probe (process uptime)
GET    /health/detailed          → Detailed health with metrics and alert thresholds
GET    /metrics                  → Prometheus metrics
```

---

## Key Design Decisions

### 1. Redis Sorted Sets vs Approximate Counting

**Decision**: Use Redis sorted sets for exact windowed view counting.

**Why it works for our scale**: Sorted sets provide O(log N) increment and O(N log N) aggregation via ZUNIONSTORE. With ~5K active videos per category, aggregating 60 time buckets completes in < 10ms. The exact counts ensure trending rankings are precise, which matters for credibility (users notice if a less-viewed video appears above a more-viewed one).

**Why approximate counting (CountMinSketch) fails here**: CMS provides O(1) updates and bounded overestimation, but the overestimation can cause incorrect rankings. A video with true count 100 might be estimated at 120, while a video with true count 110 might be estimated at 115, reversing their order. For a "Top K" display, ranking accuracy matters more than counting accuracy.

**When to switch**: At 5M+ active videos per category, the ZUNIONSTORE aggregation becomes the bottleneck (O(N * K) where N is videos and K is buckets). At that scale, SpaceSaving with streaming updates avoids the aggregation step entirely. The codebase includes both algorithms for comparison.

**What we give up**: Higher Redis memory usage. Each sorted set key stores all active videos with their scores. With 15 categories and 70 buckets each, that is ~1050 sorted sets. At 5K members each, this is ~5M entries total, using roughly 500MB of Redis memory. CMS would use fixed ~1MB regardless of cardinality.

### 2. 1-Minute Time Buckets vs Finer/Coarser Granularity

**Decision**: 1-minute bucket granularity with 60-minute sliding window.

**Why this granularity**: Finer buckets (10 seconds) create 360 keys per category per hour, increasing Redis KEYS overhead and ZUNIONSTORE input set size. Coarser buckets (15 minutes) cause trending scores to change in visible steps every 15 minutes, making the UI feel "jumpy" rather than smooth. 1-minute buckets provide smooth score transitions with ~70 keys per category.

**Memory bound**: ~70 keys per category * 15 categories = ~1050 sorted set keys. Each key expires automatically via TTL (70 minutes), so no manual cleanup is needed.

**Configuration**: Bucket size, window size, and expiration buffer are configurable via environment variables, enabling tuning without code changes.

### 3. SSE vs WebSocket vs Polling

**Decision**: Server-Sent Events for real-time trending updates.

**Why SSE**: The data flow is strictly server-to-client: trending rankings change and clients need to see them. SSE provides auto-reconnection, works natively with HTTP/2 multiplexing, and requires no special proxy configuration. The browser's `EventSource` API handles reconnection with `Last-Event-ID` out of the box.

**Why WebSocket fails here**: WebSocket adds bidirectional capability (client-to-server messages) that is unused. It also requires explicit reconnection logic, a WebSocket-aware proxy configuration, and protocol upgrade handling. The complexity cost is not justified for unidirectional updates.

**Why polling fails here**: At 5-second trending update intervals, polling would require each client to send a request every 5 seconds. With 100K connected clients, that is 20K requests/second of pure overhead. SSE maintains a single persistent connection per client with near-zero overhead between updates.

**What we give up**: SSE connections are unidirectional. If we later need client-to-server communication (e.g., user votes on trending topics), we would need a separate mechanism or a switch to WebSocket.

---

## Consistency and Idempotency

### View Count Idempotency

Duplicate view prevention uses Redis-based idempotency keys:

1. Generate key from request context: `idem:view:{videoId}:{sessionId}:{timeBucket}`
2. `SETNX` with 1-hour TTL: if key already exists, the view is a duplicate
3. Time bucketing (10-second windows) allows for clock drift while preventing abuse
4. Session-based keys mean the same user can legitimately view again after TTL expires

**Why this matters**: Without idempotency, network retries, double-clicks, and client bugs would inflate view counts. A video could accumulate 2-3x its real views, corrupting trending rankings and eroding user trust.

**Metrics**: `youtube_topk_duplicate_views_total` tracks prevented duplicates. A high duplicate rate may indicate client bugs or coordinated abuse.

### Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| View recording (Redis) | Eventual | Counters may briefly lag; 5-second refresh absorbs the gap |
| Trending computation | Eventual | 5-second cache; rankings are approximate by nature |
| Video metadata (PG) | Strong | CRUD operations use standard transactions |
| View event logging (PG) | Eventual | Historical log; missed events are acceptable |
| Trending snapshots (PG) | Eventual | Analytics data; minor gaps are tolerable |

---

## Security Considerations

1. **Rate limiting**: Prevent view count manipulation via automated scripts
2. **Input validation**: Sanitize video IDs (UUID format) and category strings
3. **CORS**: Restrict to known origins in production
4. **Bot detection**: Filter automated traffic (future enhancement)
5. **Idempotency keys**: Prevent replay attacks on view counts

---

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `youtube_topk_view_recording_duration_seconds` | Histogram | - | View ingestion latency |
| `youtube_topk_trending_query_duration_seconds` | Histogram | - | Trending API latency |
| `youtube_topk_heap_operations_total` | Counter | operation (push, pop, rebuild) | Algorithm performance |
| `youtube_topk_heap_operation_duration_seconds` | Histogram | operation | Heap operation latency |
| `youtube_topk_duplicate_views_total` | Counter | - | Idempotency effectiveness |
| `youtube_topk_cache_hit_rate` | Gauge | cache_type | Cache efficiency |
| `youtube_topk_sse_clients_connected` | Gauge | - | SSE connection count |
| `youtube_topk_redis_memory_bytes` | Gauge | - | Redis memory usage |
| `youtube_topk_table_row_count` | Gauge | table | PostgreSQL table sizes |
| `youtube_topk_pg_active_connections` | Gauge | - | Connection pool usage |

### Structured Logging (Pino)

JSON logs with request IDs, correlation, and context:

```
{"level":"info","method":"POST","path":"/api/videos/abc/view","statusCode":200,"durationMs":12,"requestId":"req-123"}
```

### Health Checks

- `/health` - Simple liveness for load balancer probes
- `/health/ready` - Readiness (PostgreSQL, Redis, TrendingService all healthy)
- `/health/live` - Liveness (process running, uptime, PID, memory)
- `/health/detailed` - Full diagnostic with metrics, alert thresholds, and active alerts

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Redis memory | 400MB (80%) | 450MB (90%) | Clear old buckets, check key leaks |
| PostgreSQL connections | 8 (80% of pool) | 9 (90%) | Check for connection leaks |
| `view_events` rows | 100K | 500K | Run cleanup script |
| `trending_snapshots` rows | 50K | 100K | Run cleanup script |
| SSE client count | 50 | 100 | Add server instances |
| View recording p95 | 40ms | 50ms | Check Redis connectivity |
| Trending query p95 | 80ms | 100ms | Optimize aggregation |

---

## Failure Handling

### Redis Failure

If Redis becomes unavailable:
- View recording fails (returns 503); trending data is stale but served from in-memory cache
- Trending service continues serving cached results until cache expires
- Recovery: flush Redis and rebuild total view counts from PostgreSQL

### PostgreSQL Failure

If PostgreSQL becomes unavailable:
- View events are not logged (acceptable; Redis still counts views)
- Video metadata reads fail; trending API returns cached results
- Recovery: standard PostgreSQL restart; no data loss if WAL is enabled

### Trending Service Stall

If the background trending loop stalls:
- SSE clients stop receiving updates
- `/api/trending` serves stale cached results
- Health check `/health/ready` reports `trendingService: not_started`

### Data Recovery Procedures

| Scenario | Procedure |
|----------|-----------|
| Redis data lost | Rebuild total view counts from PostgreSQL `videos.total_views` |
| View events corrupted | Truncate `view_events`; trending unaffected (uses Redis counters) |
| Trending snapshots lost | Rebuild by replaying view events through time buckets |

---

## Scalability Considerations

### Horizontal Scaling

1. **API servers**: Stateless; add instances behind a load balancer
2. **Redis**: Redis Cluster for sharding sorted sets by category
3. **PostgreSQL**: Read replicas for trending/video queries; primary for writes
4. **SSE distribution**: Redis pub/sub broadcasts trending updates to all API servers

### High Traffic Optimizations

1. **Batch writes**: Aggregate views in memory before Redis writes (reduce ZINCRBY calls)
2. **Local caching**: In-memory trending cache with 5-second TTL avoids repeated aggregation
3. **Rate limiting**: Per-IP and per-session limits prevent abuse
4. **Connection pooling**: PostgreSQL pool size tuned to available connections

### Bottleneck Analysis

| Component | Breaks at | Solution |
|-----------|-----------|----------|
| Redis ZUNIONSTORE | ~5M members per sorted set | Switch to SpaceSaving streaming algorithm |
| Single Redis instance | ~1M writes/sec | Redis Cluster with sharding by category |
| PostgreSQL view_events writes | ~10K inserts/sec | Kafka buffer + batch inserts |
| SSE connections per server | ~10K connections | Dedicated SSE servers with Redis pub/sub |
| Trending service compute | ~100 categories | Parallelize per-category computation |

---

## Data Lifecycle Policies

### Retention

| Data | Retention | Mechanism | Rationale |
|------|-----------|-----------|-----------|
| Redis time buckets | 70 minutes | `EXPIRE` on each key | 60-min window + 10-min buffer |
| Redis total views | Permanent | None (cleared on restart) | Synced from PostgreSQL |
| `view_events` table | 7 days | Daily cleanup script | Short-term debugging only |
| `trending_snapshots` | 30 days | Daily cleanup script | Historical analysis |
| `videos` table | Permanent | Manual deletion | Core metadata |

### Cleanup

Daily cron job deletes expired data:
```sql
DELETE FROM view_events WHERE viewed_at < NOW() - INTERVAL '7 days';
DELETE FROM trending_snapshots WHERE snapshot_at < NOW() - INTERVAL '30 days';
VACUUM ANALYZE view_events;
VACUUM ANALYZE trending_snapshots;
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| View counting | Redis sorted sets (exact) | CountMinSketch (approximate) | Ranking accuracy matters more than memory |
| Bucket granularity | 1-minute | 10-second / 5-minute | Balance key count vs score smoothness |
| Real-time updates | SSE | WebSocket / Polling | Unidirectional, auto-reconnect, HTTP/2 compatible |
| Top-k algorithm | MinHeap (exact) | SpaceSaving (streaming) | Exact at current scale; switch at 5M+ videos |
| View dedup | Redis SETNX + TTL | PostgreSQL unique constraint | Redis is faster for hot-path dedup |
| Trending cache | In-memory, 5s TTL | No cache / longer TTL | Absorbs request spikes without stale data |
| Event logging | Direct PG write | Kafka queue | Sufficient at local scale; Kafka for production |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + Express + React.

### Local Architecture

```
┌────────────────────────────────────────────────────────┐
│              React Frontend (:5173)                    │
│  TanStack Router + Zustand + Tailwind CSS              │
│  TrendingList, CategoryFilter, StatsPanel, VideoCard   │
│  useSSE hook for real-time updates                     │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP + SSE
                           ▼
┌────────────────────────────────────────────────────────┐
│       Express Backend (:3000 / :3001-3003)             │
│  /api/videos, /api/trending, /api/sse                  │
│  /health, /health/ready, /health/live,                 │
│  /health/detailed, /metrics                            │
└──────────┬───────────────────────┬─────────────────────┘
           │                       │
           ▼                       ▼
   ┌──────────────┐        ┌──────────────┐
   │    Valkey     │        │  PostgreSQL  │
   │   (:6379)    │        │   (:5432)    │
   │              │        │              │
   │ - View       │        │ - videos     │
   │   buckets    │        │ - view_      │
   │   (sorted    │        │   events     │
   │    sets)     │        │ - trending_  │
   │ - Total      │        │   snapshots  │
   │   views      │        │ - schema_    │
   │   (hash)     │        │   migrations │
   │ - Idempotency│        │              │
   │   keys       │        │              │
   └──────────────┘        └──────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | Library/Approach | File | Purpose |
|---------|-----------------|------|---------|
| Idempotency | Custom + Redis SETNX | `backend/src/services/idempotency.ts` | Duplicate view prevention |
| Windowed counting | Redis sorted sets | `backend/src/services/redis.ts` | Time-bucketed view aggregation |
| Top-k algorithms | Custom (MinHeap, CMS, SpaceSaving) | `backend/src/utils/topk.ts` | Trending computation with algorithm comparison |
| Trending service | Background loop | `backend/src/services/trendingService.ts` | Periodic top-k computation + SSE broadcast |
| SSE streaming | Native Express | `backend/src/routes/sse.ts` | Real-time trending pushes to clients |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | Latency, cache hits, Redis memory, PG stats, alerts |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with request IDs |
| Health checks | Custom (4 levels) | `backend/src/index.ts` | Liveness, readiness, detailed diagnostics with thresholds |
| Configuration | Custom | `backend/src/shared/config.ts` | Centralized config with environment overrides and alert thresholds |
| Database migrations | Custom runner | `backend/src/db/init.sql` | Consolidated schema with migration tracking |

### Simplifications and Substitutions

| Production Design | Local Substitute | Reason |
|-------------------|------------------|--------|
| Kafka for view event ingestion | Direct Redis + PG writes | < 100 views/sec fits direct write path |
| Redis Cluster (sharded by category) | Single Valkey instance | All data fits in < 50MB |
| CDN / API Gateway | Express middleware (CORS) | Single process handles routing |
| Redis pub/sub for SSE distribution | Per-instance SSE connections | 1-3 server instances, no cross-server broadcast needed |
| Dedicated cleanup workers | Manual cleanup scripts | Low data volume, no automated retention |
| Load balancer (nginx/HAProxy) | Direct port access (:3001-3003) | Manual multi-instance testing |
| Bot detection / fraud prevention | Simple idempotency keys | No real traffic abuse to defend against |

### What Was Omitted

- **CDN and edge caching**: No static asset optimization or geographic distribution
- **Kafka event pipeline**: Direct writes instead of async message queue
- **Redis Cluster**: Single Valkey instance
- **Kubernetes orchestration**: Docker Compose for PostgreSQL and Valkey
- **Geographic trending**: No per-region trending
- **Personalized trending**: No per-user trending recommendations
- **Anomaly detection**: No spike detection or view fraud algorithms
- **A/B testing**: Single algorithm, no experimentation framework
- **Load testing**: No formal performance benchmarking suite

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (layout shell)
└── index.tsx (Home Page - single-page application)
    ├── Header (app title, SSE connection indicator, last update time)
    ├── CategoryFilter (horizontal tab bar for category selection)
    ├── TrendingList (ranked list of trending videos)
    │   └── VideoCard (individual video with rank, title, view count, category badge)
    └── StatsPanel (cache hit rate, update count, SSE connection status)
```

### Zustand Store

**`useTrendingStore`** (`stores/trendingStore.ts`) -- Manages all trending dashboard state:

- **`trending`**: A `Record<string, { videos: Video[] }>` keyed by category name. Updated atomically when an SSE message arrives, ensuring all categories refresh simultaneously.
- **`stats`**: Cache hit rate, total updates, and trending computation metrics from the `/api/trending/stats` endpoint.
- **`selectedCategory`**: Currently active category filter (defaults to `'all'`). Changing this re-derives the displayed video list without a network request.
- **`isConnected`**: Whether the SSE connection is active. Displayed in the Header as a live/disconnected indicator.
- **`lastUpdate`**: Timestamp of the most recent trending update, shown in the UI to indicate data freshness.
- **`getSelectedVideos()`**: Derived getter that returns the video array for the currently selected category. Avoids redundant state by computing from `trending` and `selectedCategory`.

### Routing

TanStack Router with file-based routing. This project uses a single route:

| Route | File | Description |
|-------|------|-------------|
| `/` | `routes/index.tsx` | Full dashboard with trending list, category filter, and stats |

The root layout (`__root.tsx`) provides the page shell. There is no admin route -- all functionality is on one page since the system is a real-time analytics dashboard.

### Data Fetching

Data arrives through two channels:

1. **SSE (Server-Sent Events)** via the `useSSE` hook (`hooks/useSSE.ts`) -- The primary data source. On mount, the hook opens an `EventSource` connection to `/api/sse/trending`. When the backend computes new trending rankings (every 5 seconds), it pushes a `trending-update` event containing all categories' top-k videos. The hook parses the JSON payload and calls `setTrending()` on the store. On connection error, the hook closes the connection and retries after 5 seconds, providing automatic resilience to transient network issues.

2. **REST API** via `services/api.ts` -- Used for initial data load and stats polling. The API service provides functions for fetching trending data (`/api/trending`), video details (`/api/videos`), and statistics (`/api/trending/stats`). This is the fallback when SSE is not connected.

**No client-side caching layer** is needed because the SSE connection pushes fresh data every 5 seconds. The Zustand store itself acts as the cache -- components read from the store, and the store is updated by SSE events.

### Key UI Patterns

- **Real-time updates without polling**: The SSE connection replaces the traditional fetch-on-interval pattern. The UI updates reactively when the store changes, with no manual refresh needed
- **Category filtering without network requests**: All category data arrives in each SSE update. Switching categories is an instant local state change (updating `selectedCategory`), not a new API call
- **Connection status indicator**: The Header displays whether the SSE connection is active, giving users confidence that the data is live. The `isConnected` state toggles on SSE open/error events
- **Automatic reconnection**: The `useSSE` hook implements reconnection with a 5-second delay on error, matching the browser's native `EventSource` retry behavior but with explicit control

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and when you would use it.

### Prometheus Metrics (prom-client)

**What it is**: Prometheus is a monitoring system that collects numerical time-series data from applications. The application exposes a `/metrics` HTTP endpoint that Prometheus periodically scrapes (typically every 15-30 seconds). The `prom-client` library provides four metric types: Counter (only goes up), Gauge (goes up and down), Histogram (distribution of values in configurable buckets), and Summary (similar to histogram with quantile calculation).

**How it works**: The application creates metric objects at startup (e.g., a Histogram for view recording latency, a Counter for heap operations, a Gauge for SSE client count). During operation, the application records observations: `viewRecordingDuration.observe(0.012)` records a 12ms view ingestion, `heapOperations.inc({operation: "push"})` counts a heap insertion. Prometheus scrapes the `/metrics` endpoint and stores the time-series data. Grafana dashboards visualize trends, and alerting rules trigger notifications when metrics cross thresholds (e.g., view recording P95 exceeds 50ms).

**Why it matters**: Logs tell you what happened to individual requests; metrics tell you what is happening to the system as a whole. In this project, metrics are critical for understanding whether the trending algorithm is keeping up with view ingestion. If the `youtube_topk_heap_operation_duration_seconds` histogram shows increasing latency, it signals that the number of active videos is approaching the threshold where you should switch from MinHeap to SpaceSaving. The `youtube_topk_cache_hit_rate` gauge tells you whether the 5-second in-memory trending cache is effective. Without metrics, you would not know the system was degrading until users reported stale trending data.

**When to use it**: In any production system. Metrics are the foundation of observability and are required for SLO-based operations. Even in development, metrics help identify performance bottlenecks and validate that optimizations (like switching top-k algorithms) actually improve performance.

### Structured Logging (Pino)

**What it is**: Structured logging produces log entries as machine-parseable JSON objects rather than human-readable text strings. Each log entry is a flat or nested JSON object with consistent field names, enabling automated parsing, filtering, indexing, and alerting by log aggregation systems.

**How it works**: Instead of writing `console.log('View recorded for video abc in 12ms')`, structured logging produces `{"level":"info","method":"POST","path":"/api/videos/abc/view","statusCode":200,"durationMs":12,"requestId":"req-123"}`. Every log entry includes a severity level, a timestamp, and contextual fields. The `pino-http` middleware automatically logs every HTTP request with method, path, status code, response time, and request ID. Developers add domain-specific fields (like `videoId`, `category`, `viewCount`) when logging business events.

**Why it matters**: In production, an application might produce millions of log lines per hour. Text-based logs require regular expressions to extract useful information, which is fragile and slow. JSON logs can be directly indexed by systems like Elasticsearch, Datadog, or CloudWatch, enabling queries like "show me all view recording requests that took longer than 50ms for the gaming category" in seconds. Request IDs link related log entries across services, enabling end-to-end request tracing across API servers, trending workers, and SSE connections.

**When to use it**: Always in production environments. Text-based "pretty" logging is appropriate only during local development (Pino supports both modes). Structured logging is especially critical when running multiple API server instances, as it enables correlating logs across instances using request IDs.

### Idempotency

**What it is**: Idempotency means that performing the same operation multiple times produces the same result as performing it once. In the context of APIs, an idempotent operation can be safely retried without causing duplicate side effects (double counting views, duplicate records).

**How it works**: For view recording, the system generates an idempotency key from the request context: `{videoId}:{sessionId}:{timeBucket}`. The `timeBucket` is a 10-second window (e.g., the current timestamp rounded down to the nearest 10 seconds). The server performs a Redis `SETNX` (Set if Not eXists) with this key and a 1-hour TTL. If the key already exists, the view is considered a duplicate and is skipped. If the key does not exist, it is created and the view is processed. The 10-second bucketing allows for clock drift between client and server while still preventing abuse -- the same user cannot artificially inflate a video's view count by refreshing the page repeatedly.

**Why it matters**: Without idempotency, network retries, double-clicks, and client bugs would inflate view counts. A video could accumulate 2-3x its real views, corrupting trending rankings. If a video with 100 real views is counted as 200 due to duplicates, it would incorrectly outrank a video with 150 real views. The `youtube_topk_duplicate_views_total` metric tracks prevented duplicates -- a high rate may indicate client bugs or coordinated view manipulation.

**When to use it**: For any operation that has side effects that should not be repeated. View counting, payment processing, message sending, and similar operations all need idempotency. Read-only operations (GET requests) are naturally idempotent. Operations that are inherently idempotent by their data model (like UPSERT with absolute values rather than increments) may not need explicit keys.

### Health Checks

**What it is**: Health checks are dedicated HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators (Kubernetes), and monitoring systems to make automated decisions about routing traffic and restarting failed instances.

**How it works**: This project implements four levels of health checks:
- **`/health`** (simple): Returns 200 if the process is running. Used as a basic liveness signal.
- **`/health/ready`** (readiness): Returns 200 only if PostgreSQL responds to queries, Redis responds to PING, and the TrendingService background loop is running. If any dependency fails, the endpoint returns 503 with details about which dependency is unhealthy. Used by load balancers to remove unhealthy instances from rotation.
- **`/health/live`** (liveness): Returns process metadata (uptime, PID, memory usage). Used by Kubernetes to decide whether to restart the container.
- **`/health/detailed`** (diagnostic): Returns comprehensive status including all dependency checks, current metric values (Redis memory, PG connections, table row counts), alert threshold evaluations, and active alerts. Used by operators for debugging and capacity planning.

**Why it matters**: Without health checks, a load balancer has no way to know if a server instance is healthy. It would continue sending traffic to a server whose Redis connection is broken, resulting in failed view recordings and stale trending data. The TrendingService readiness check is particularly important: if the background trending loop stalls, the SSE clients stop receiving updates, but the API server itself is still "alive." The readiness check catches this by verifying that the trending service has started and is actively computing rankings.

**When to use it**: Every production service needs at least liveness and readiness checks. The liveness check should be trivially simple (return 200). The readiness check should verify that all critical dependencies are reachable. The detailed check is optional but extremely valuable for debugging production issues without SSH access.
