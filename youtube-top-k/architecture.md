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

## Data Lifecycle Policies

### Retention and TTL Strategy

| Data Type | Retention Period | TTL Mechanism | Rationale |
|-----------|------------------|---------------|-----------|
| **Redis time buckets** | 70 minutes | `EXPIRE` on each key | 60-minute window + 10-minute buffer for aggregation |
| **Redis total views** | Permanent | None | Synced from PostgreSQL, cleared on restart |
| **view_events table** | 7 days | Daily cron job | Short-term debugging, not needed for trending |
| **trending_snapshots** | 30 days | Daily cron job | Historical analysis and debugging |
| **videos table** | Permanent | None | Core metadata, manual deletion only |

### Local Development Implementation

```bash
# Cleanup script: backend/scripts/cleanup-old-data.sh
#!/bin/bash
# Run daily via cron: 0 3 * * * /path/to/cleanup-old-data.sh

# Delete view events older than 7 days
psql $DATABASE_URL -c "DELETE FROM view_events WHERE viewed_at < NOW() - INTERVAL '7 days';"

# Delete trending snapshots older than 30 days
psql $DATABASE_URL -c "DELETE FROM trending_snapshots WHERE snapshot_at < NOW() - INTERVAL '30 days';"

# Vacuum to reclaim space
psql $DATABASE_URL -c "VACUUM ANALYZE view_events; VACUUM ANALYZE trending_snapshots;"
```

### Archival Strategy (Local Development)

For learning purposes, implement a simple file-based archive before deletion:

```sql
-- Archive view_events before cleanup (run manually or via script)
COPY (
  SELECT * FROM view_events
  WHERE viewed_at < NOW() - INTERVAL '7 days'
) TO '/tmp/view_events_archive.csv' WITH CSV HEADER;

-- Archive trending_snapshots monthly
COPY (
  SELECT * FROM trending_snapshots
  WHERE snapshot_at < NOW() - INTERVAL '30 days'
) TO '/tmp/trending_snapshots_archive.csv' WITH CSV HEADER;
```

### Backfill and Replay Procedures

**Scenario 1: Redis data lost (restart without persistence)**

```bash
# 1. Check if Redis data is gone
redis-cli KEYS "views:*" | head -5

# 2. Rebuild total view counts from PostgreSQL
psql $DATABASE_URL -c "SELECT id, total_views FROM videos WHERE total_views > 0;" > /tmp/views.txt

# 3. Load into Redis (script: backend/scripts/rebuild-redis.ts)
npm run rebuild-redis
```

**Scenario 2: Replay historical views for testing**

```javascript
// backend/scripts/replay-views.ts
import { pool } from '../src/shared/db';
import { redis } from '../src/shared/cache';

async function replayViews(hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  const result = await pool.query(
    'SELECT video_id, viewed_at FROM view_events WHERE viewed_at >= $1 ORDER BY viewed_at',
    [cutoff]
  );

  for (const row of result.rows) {
    const bucket = Math.floor(new Date(row.viewed_at).getTime() / 60000);
    await redis.zIncrBy(`views:bucket:all:${bucket}`, 1, row.video_id);
  }
  console.log(`Replayed ${result.rows.length} views`);
}
```

**Scenario 3: PostgreSQL restored from backup**

```bash
# 1. Restore PostgreSQL from pg_dump backup
pg_restore -d youtube_topk /path/to/backup.dump

# 2. Clear Redis to avoid stale data
redis-cli FLUSHDB

# 3. Rebuild Redis from PostgreSQL
npm run rebuild-redis

# 4. Verify data integrity
npm run verify-data
```

---

## Deployment and Operations

### Local Development Rollout Strategy

For a learning project with multiple API servers:

```bash
# 1. Rolling restart: One server at a time (no downtime)
# Terminal 1: Keep server 2 and 3 running
npm run dev:server1  # Stop with Ctrl+C, make changes, restart

# 2. Wait for health check before proceeding
curl http://localhost:3001/health

# 3. Repeat for server 2, then server 3
npm run dev:server2
npm run dev:server3
```

### Schema Migration Workflow

**Migration file naming convention:**
```
backend/src/db/migrations/
├── 001_initial_schema.sql
├── 002_add_category_index.sql
├── 003_add_view_events_partition.sql
└── 004_add_trending_snapshots.sql
```

**Migration runner (backend/src/db/migrate.ts):**

```typescript
import { pool } from '../shared/db';
import fs from 'fs';
import path from 'path';

async function migrate() {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // Get applied migrations
  const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const appliedVersions = new Set(applied.rows.map(r => r.version));

  // Read and apply pending migrations
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0]);
    if (appliedVersions.has(version)) continue;

    console.log(`Applying migration ${version}: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await pool.query('COMMIT');
      console.log(`  Migration ${version} applied successfully`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`  Migration ${version} failed:`, err);
      throw err;
    }
  }
}
```

**Run migrations:**
```bash
npm run db:migrate        # Apply pending migrations
npm run db:migrate:status # Show applied vs pending
```

### Rollback Runbook

**Situation 1: Bad code deployment**

```bash
# 1. Identify the issue
tail -f backend/logs/error.log

# 2. Git revert to last known good state
git log --oneline -5
git checkout <last-good-commit>

# 3. Restart affected servers
npm run dev:server1
npm run dev:server2
npm run dev:server3

# 4. Verify functionality
curl http://localhost:3001/api/trending
```

**Situation 2: Bad database migration**

```sql
-- Each migration should have a corresponding rollback file
-- backend/src/db/migrations/002_add_category_index.sql
CREATE INDEX idx_videos_category ON videos(category);

-- backend/src/db/rollbacks/002_add_category_index.rollback.sql
DROP INDEX IF EXISTS idx_videos_category;
```

```bash
# Run rollback manually
psql $DATABASE_URL -f backend/src/db/rollbacks/002_add_category_index.rollback.sql

# Update migrations table
psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = 2;"
```

**Situation 3: Redis corruption or wrong data**

```bash
# Option A: Flush and rebuild (safest)
redis-cli FLUSHDB
npm run rebuild-redis

# Option B: Selective cleanup (for testing)
redis-cli KEYS "views:bucket:*" | xargs redis-cli DEL
# Trending will rebuild on next refresh cycle
```

**Situation 4: Full system recovery**

```bash
# 1. Stop all services
pkill -f "node.*server"

# 2. Reset databases
docker-compose down -v
docker-compose up -d

# 3. Run migrations
npm run db:migrate

# 4. Seed initial data (if needed)
npm run db:seed

# 5. Start services
npm run dev
```

---

## Capacity and Cost Guardrails

### Key Metrics and Thresholds

| Metric | Warning Threshold | Critical Threshold | Action |
|--------|-------------------|-------------------|--------|
| Redis memory usage | 400MB (80% of 500MB budget) | 450MB (90%) | Clear old buckets, check for key leaks |
| PostgreSQL connections | 8 (80% of pool) | 9 (90%) | Check for connection leaks |
| view_events table size | 100K rows | 500K rows | Run cleanup script |
| trending_snapshots size | 50K rows | 100K rows | Run cleanup script |
| SSE client count | 50 | 100 | Consider adding server instances |
| View recording latency p95 | 40ms | 50ms | Check Redis connectivity |
| Trending query latency p95 | 80ms | 100ms | Optimize aggregation |

### Redis Memory Monitoring

```bash
# Check current memory usage
redis-cli INFO memory | grep used_memory_human

# Check key count by pattern
redis-cli KEYS "views:bucket:*" | wc -l

# Find largest keys
redis-cli --bigkeys

# Expected: ~70 bucket keys per category (60 min window + buffer)
# If significantly more, TTL may not be working
```

### PostgreSQL Monitoring Queries

```sql
-- Table sizes
SELECT
  relname AS table,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  n_live_tup AS row_count
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Connection usage
SELECT count(*) as active_connections,
       max_conn as max_allowed,
       count(*) * 100.0 / max_conn as usage_percent
FROM pg_stat_activity,
     (SELECT setting::int as max_conn FROM pg_settings WHERE name = 'max_connections') mc
GROUP BY max_conn;

-- Slow queries (requires pg_stat_statements extension)
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### Cache Hit Rate Targets

| Cache | Target Hit Rate | Measurement | Action if Below |
|-------|-----------------|-------------|-----------------|
| Redis view counters | N/A (write-heavy) | N/A | N/A |
| Trending results (in-memory) | > 95% | Requests served from 5s cache | Increase cache TTL |
| Video metadata | > 80% | `redis-cli INFO stats` | Add Redis caching layer |

### Alerting Setup (Local Development)

Create a simple health check script for local monitoring:

```bash
#!/bin/bash
# backend/scripts/health-check.sh
# Run via: watch -n 10 ./health-check.sh

echo "=== YouTube Top K Health Check ==="
echo ""

# Redis memory
REDIS_MEM=$(redis-cli INFO memory | grep used_memory_human | cut -d: -f2 | tr -d '[:space:]')
echo "Redis Memory: $REDIS_MEM (warn: 400MB, crit: 450MB)"

# Redis key count
BUCKET_KEYS=$(redis-cli KEYS "views:bucket:*" 2>/dev/null | wc -l | tr -d '[:space:]')
echo "Redis Bucket Keys: $BUCKET_KEYS (expected: ~70-100)"

# PostgreSQL connections
PG_CONN=$(psql $DATABASE_URL -t -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();")
echo "PostgreSQL Connections: $PG_CONN (max: 10)"

# Table row counts
VIEW_EVENTS=$(psql $DATABASE_URL -t -c "SELECT count(*) FROM view_events;")
SNAPSHOTS=$(psql $DATABASE_URL -t -c "SELECT count(*) FROM trending_snapshots;")
echo "view_events rows: $VIEW_EVENTS (warn: 100K)"
echo "trending_snapshots rows: $SNAPSHOTS (warn: 50K)"

# API health
for port in 3001 3002 3003; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health 2>/dev/null || echo "DOWN")
  echo "API Server :$port - $STATUS"
done

echo ""
echo "=== End Health Check ==="
```

### Cost Optimization Tips (Local Development)

1. **Reduce Redis memory**: Lower bucket granularity from 1-minute to 5-minute for testing
   ```javascript
   const bucket = Math.floor(Date.now() / 300000); // 5-minute buckets
   ```

2. **Limit view_events logging**: Only log 10% of views in development
   ```javascript
   if (Math.random() < 0.1) {
     await logViewEvent(videoId, sessionId);
   }
   ```

3. **Disable trending snapshots**: Skip persistence for faster iteration
   ```javascript
   if (process.env.ENABLE_SNAPSHOTS === 'true') {
     await saveTrendingSnapshot(trending);
   }
   ```

4. **PostgreSQL connection pooling**: Use 5 connections instead of 10 for local dev
   ```javascript
   const pool = new Pool({ max: parseInt(process.env.PG_POOL_SIZE || '5') });
   ```

---

## Future Optimizations

1. **Geographic trending**: Trending by region
2. **Personalized trending**: Based on user preferences
3. **Trend velocity**: Rate of change detection
4. **Anomaly detection**: Identify unusual spikes
5. **A/B testing**: Experiment with ranking algorithms
