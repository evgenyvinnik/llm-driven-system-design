# Dashboarding System - Metrics Monitoring and Visualization - Architecture Design

## System Overview

A metrics monitoring and visualization system similar to Datadog or Grafana for collecting, storing, and visualizing time-series data. This design targets a local development/learning environment while demonstrating patterns that scale to production.

## Requirements

### Functional Requirements

- Metrics collection and ingestion via HTTP and batch APIs
- Time-series data storage with automatic partitioning
- Real-time dashboards and visualization (line, area, bar, gauge, stat charts)
- Alerting and notifications (email, webhook)
- Query and aggregation engine with PromQL-like syntax
- Custom dashboard creation with drag-and-drop panels
- Metric retention policies and automatic downsampling

### Non-Functional Requirements

- **Scalability**: Handle 1,000 metrics/second ingestion locally; design patterns support 100K+ in production
- **Availability**: 99.5% uptime target (allows ~43 minutes downtime/week for local dev)
- **Latency**: p95 query response < 500ms for 24-hour ranges, < 2s for 7-day ranges
- **Consistency**: Eventual consistency for metrics (seconds-level lag acceptable), strong consistency for dashboard/alert configurations

## Capacity Estimation

### Local Development Targets

| Metric | Target | Sizing Rationale |
|--------|--------|------------------|
| Metrics ingestion | 1,000/sec | 10 services x 100 metrics each |
| Data points/day | 86.4M | 1,000/sec x 86,400 sec/day |
| Raw storage/day | ~2 GB | 86.4M x 24 bytes avg per point |
| Query throughput | 50 queries/sec | 5 dashboards x 10 panels x 1 refresh/sec |
| Retention (raw) | 7 days | ~14 GB total raw data |
| Retention (1-min agg) | 30 days | ~1.5 GB aggregated |
| Retention (1-hour agg) | 1 year | ~300 MB aggregated |

### Component Sizing (Local Dev)

| Component | Resources | Justification |
|-----------|-----------|---------------|
| TimescaleDB | 2 GB RAM, 50 GB disk | Handles 14 GB raw + indexes + aggregates |
| Redis | 256 MB RAM | Cache ~10K query results x 25 KB avg |
| API Server | 512 MB RAM x 2 instances | Stateless, behind load balancer |
| Ingestion Worker | 256 MB RAM x 2 instances | Batch writes to reduce DB load |
| Alert Evaluator | 128 MB RAM | Runs every 10s, evaluates ~100 rules |

## High-Level Architecture

```
                                    +------------------+
                                    |   Prometheus /   |
                                    |   StatsD / Apps  |
                                    +--------+---------+
                                             |
                                             v
+------------------+              +----------+---------+
|                  |              |                    |
|  Load Balancer   +<-------------+  Metrics Ingestion |
|  (nginx:3000)    |              |  API (3001, 3002)  |
|                  |              |                    |
+--------+---------+              +----------+---------+
         |                                   |
         |                                   v
         |                        +----------+---------+
         |                        |                    |
         |                        |  RabbitMQ Queue    |
         |                        |  (metrics.ingest)  |
         |                        |                    |
         |                        +----------+---------+
         |                                   |
         v                                   v
+--------+---------+              +----------+---------+
|                  |              |                    |
|  Query API       |              |  Ingestion Worker  |
|  (3001, 3002)    |              |  (batch writer)    |
|                  |              |                    |
+--------+---------+              +----------+---------+
         |                                   |
         v                                   v
+--------+---------------------------+-------+---------+
|                                                      |
|              TimescaleDB (PostgreSQL)                |
|  +---------------+  +---------------+  +-----------+ |
|  | metrics_raw   |  | metrics_1min  |  | dashboards| |
|  | (hypertable)  |  | (cont. agg)   |  | alerts    | |
|  +---------------+  +---------------+  +-----------+ |
|                                                      |
+------------------------------+-----------------------+
                               |
                               v
+------------------+  +--------+---------+  +------------------+
|                  |  |                  |  |                  |
|  Redis Cache     |  |  Alert Evaluator |  |  React Frontend  |
|  (query results) |  |  (cron: 10s)     |  |  (Vite: 5173)    |
|                  |  |                  |  |                  |
+------------------+  +------------------+  +------------------+
```

### Request Flow: Metrics Ingestion

1. **Client** sends metrics batch to `/api/v1/metrics` (POST)
2. **Load Balancer** routes to available API server
3. **API Server** validates payload, enriches with timestamp if missing
4. **API Server** publishes to RabbitMQ `metrics.ingest` queue (fire-and-forget)
5. **API Server** returns 202 Accepted immediately
6. **Ingestion Worker** consumes batches, buffers for 100ms or 1000 points
7. **Ingestion Worker** bulk inserts to TimescaleDB via `COPY` command
8. **TimescaleDB** automatically routes to appropriate hypertable chunk

### Request Flow: Dashboard Query

1. **Frontend** requests `/api/v1/query` with metric name, time range, aggregation
2. **Load Balancer** routes to available API server
3. **API Server** generates cache key from query parameters
4. **API Server** checks Redis cache (TTL: 10s for live data, 5min for historical)
5. **Cache miss**: Query TimescaleDB using continuous aggregates when possible
6. **API Server** caches result, returns JSON response
7. **Frontend** renders chart with Recharts

## Data Model

### Database Schema (TimescaleDB)

```sql
-- Metric definitions (cached in Redis)
CREATE TABLE metric_definitions (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    unit            VARCHAR(50),
    type            VARCHAR(20) DEFAULT 'gauge',  -- gauge, counter, histogram
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name)
);
CREATE INDEX idx_metric_definitions_name ON metric_definitions(name);

-- Raw metrics (hypertable, partitioned by time)
CREATE TABLE metrics_raw (
    time            TIMESTAMPTZ NOT NULL,
    metric_id       INTEGER NOT NULL REFERENCES metric_definitions(id),
    value           DOUBLE PRECISION NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb
);
SELECT create_hypertable('metrics_raw', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX idx_metrics_raw_metric_time ON metrics_raw(metric_id, time DESC);
CREATE INDEX idx_metrics_raw_tags ON metrics_raw USING GIN(tags);

-- 1-minute continuous aggregate
CREATE MATERIALIZED VIEW metrics_1min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    metric_id,
    tags,
    AVG(value) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    COUNT(*) AS sample_count
FROM metrics_raw
GROUP BY bucket, metric_id, tags
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1min',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
);

-- 1-hour continuous aggregate (for longer time ranges)
CREATE MATERIALIZED VIEW metrics_1hour
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    metric_id,
    tags,
    AVG(avg_value) AS avg_value,
    MIN(min_value) AS min_value,
    MAX(max_value) AS max_value,
    SUM(sample_count) AS sample_count
FROM metrics_1min
GROUP BY time_bucket('1 hour', bucket), metric_id, tags
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1hour',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

-- Retention policies
SELECT add_retention_policy('metrics_raw', INTERVAL '7 days');
SELECT add_retention_policy('metrics_1min', INTERVAL '30 days');
SELECT add_retention_policy('metrics_1hour', INTERVAL '365 days');

-- Dashboards
CREATE TABLE dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    owner_id        INTEGER REFERENCES users(id),
    layout          JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Dashboard panels
CREATE TABLE panels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    type            VARCHAR(50) NOT NULL,  -- line, area, bar, gauge, stat
    query           TEXT NOT NULL,
    options         JSONB DEFAULT '{}'::jsonb,
    position        JSONB NOT NULL,  -- {x, y, w, h}
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_panels_dashboard ON panels(dashboard_id);

-- Alert rules
CREATE TABLE alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    query           TEXT NOT NULL,
    condition       VARCHAR(20) NOT NULL,  -- gt, lt, eq, ne
    threshold       DOUBLE PRECISION NOT NULL,
    duration        INTERVAL NOT NULL DEFAULT '5 minutes',
    severity        VARCHAR(20) DEFAULT 'warning',  -- info, warning, critical
    enabled         BOOLEAN DEFAULT true,
    notification    JSONB NOT NULL,  -- {type: 'email'|'webhook', target: '...'}
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Alert history
CREATE TABLE alert_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id),
    status          VARCHAR(20) NOT NULL,  -- firing, resolved
    value           DOUBLE PRECISION,
    triggered_at    TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX idx_alert_events_rule_time ON alert_events(rule_id, triggered_at DESC);

-- Users (for auth)
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'viewer',  -- viewer, editor, admin
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
    id              VARCHAR(255) PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Redis Cache Structure

```
# Query result cache
cache:query:{hash}          -> JSON result (TTL: 10s for live, 5min for historical)

# Metric ID lookup cache
cache:metric:name:{name}    -> metric_id (TTL: 1 hour)

# Session storage
session:{session_id}        -> {user_id, role, expires_at} (TTL: 24 hours)

# Rate limiting
ratelimit:ingest:{ip}       -> counter (TTL: 1 minute, max 10,000)
ratelimit:query:{user_id}   -> counter (TTL: 1 minute, max 100)

# Alert state (for duration tracking)
alert:state:{rule_id}       -> {first_triggered, current_value} (TTL: 1 hour)
```

## API Design

### Core Endpoints

```
# Metrics Ingestion
POST   /api/v1/metrics              # Bulk ingest metrics
  Body: [{name, value, tags?, timestamp?}, ...]
  Response: 202 Accepted

# Metrics Query
POST   /api/v1/query                # Execute query
  Body: {query, start, end, step?}
  Response: {data: [{time, value}, ...], meta: {...}}

GET    /api/v1/metrics              # List metric definitions
GET    /api/v1/metrics/:name/tags   # Get tag values for metric

# Dashboards
GET    /api/v1/dashboards           # List dashboards
POST   /api/v1/dashboards           # Create dashboard
GET    /api/v1/dashboards/:id       # Get dashboard with panels
PUT    /api/v1/dashboards/:id       # Update dashboard
DELETE /api/v1/dashboards/:id       # Delete dashboard

# Panels
POST   /api/v1/dashboards/:id/panels    # Add panel
PUT    /api/v1/panels/:id               # Update panel
DELETE /api/v1/panels/:id               # Delete panel

# Alerts
GET    /api/v1/alerts               # List alert rules
POST   /api/v1/alerts               # Create alert rule
PUT    /api/v1/alerts/:id           # Update alert rule
DELETE /api/v1/alerts/:id           # Delete alert rule
GET    /api/v1/alerts/:id/history   # Get alert history

# Admin
GET    /api/v1/admin/stats          # System statistics
POST   /api/v1/admin/retention      # Trigger retention cleanup
GET    /api/v1/admin/health         # Health check

# Auth
POST   /api/v1/auth/login           # Login
POST   /api/v1/auth/logout          # Logout
GET    /api/v1/auth/me              # Current user
```

## Key Design Decisions

### Time-series Database: TimescaleDB

**Decision**: Use TimescaleDB (PostgreSQL extension) over InfluxDB or Prometheus TSDB.

**Rationale**:
- SQL interface allows complex joins (metrics + dashboards + alerts in one DB)
- Hypertables automatically partition by time, transparent to application
- Continuous aggregates provide materialized rollups without application logic
- Built-in compression (10x reduction on older chunks)
- PostgreSQL ecosystem: pg_dump, replication, extensive tooling
- Single database simplifies local development

**Trade-offs**:
- Slightly higher write latency than specialized TSDBs
- Requires PostgreSQL expertise
- Cardinality limits (~10M unique series before performance degrades)

### Data Ingestion Pipeline

**Decision**: Async ingestion via RabbitMQ with batched writes.

**Flow**:
1. API accepts metrics, publishes to queue, returns 202 immediately
2. Worker consumes, buffers for 100ms or 1000 points
3. Worker uses `COPY` for bulk insert (10x faster than individual INSERTs)

**Rationale**:
- Decouples ingestion rate from database write speed
- Provides backpressure handling (queue depth monitoring)
- Enables horizontal scaling of workers
- Allows retry on transient DB failures

**Queue Configuration**:
```javascript
// RabbitMQ settings
{
  queue: 'metrics.ingest',
  durable: true,
  prefetch: 100,           // Worker processes 100 messages at a time
  ack: 'manual',           // Explicit ack after successful write
  deadLetter: 'metrics.dlq' // Failed messages go here
}
```

### Aggregation and Downsampling

**Decision**: Use TimescaleDB continuous aggregates for automatic rollups.

**Strategy**:
- Raw data: 1-second resolution, 7-day retention
- 1-minute aggregates: Automatic, 30-day retention
- 1-hour aggregates: Automatic, 1-year retention

**Query Routing Logic**:
```
Time range <= 1 hour:   Use metrics_raw (1s resolution)
Time range <= 24 hours: Use metrics_1min (1min resolution)
Time range > 24 hours:  Use metrics_1hour (1hour resolution)
```

**Benefits**:
- Zero application code for rollups
- Aggregates update incrementally (efficient)
- Queries automatically faster on longer ranges

### Alerting Engine

**Decision**: Pull-based evaluation with configurable intervals.

**Design**:
1. Alert Evaluator runs every 10 seconds
2. Queries each enabled rule against recent data
3. Tracks firing duration in Redis
4. Sends notification only after threshold duration met
5. Records event in alert_events table

**Alert States**:
```
pending  -> (condition true for duration)  -> firing
firing   -> (condition false)              -> resolved
resolved -> (condition true)               -> pending
```

**Notification Delivery**:
- Email: Via SMTP (Mailhog for local dev)
- Webhook: HTTP POST with retry (3 attempts, exponential backoff)

### Caching Strategy

**Decision**: Cache-aside pattern with short TTLs for live data.

**Rules**:
| Data Type | TTL | Invalidation |
|-----------|-----|--------------|
| Query results (live) | 10s | Time-based expiry |
| Query results (historical) | 5min | Time-based expiry |
| Metric definitions | 1 hour | On metric creation |
| Dashboard configs | 30s | On save (explicit delete) |

**Cache Key Generation**:
```javascript
function cacheKey(query) {
  const normalized = {
    query: query.query.trim().toLowerCase(),
    start: Math.floor(query.start / 10000) * 10000,  // Round to 10s
    end: Math.floor(query.end / 10000) * 10000,
    step: query.step
  };
  return `cache:query:${hash(JSON.stringify(normalized))}`;
}
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + Vite + TanStack Router | Fast dev experience, type-safe routing |
| **Visualization** | Recharts | React-native charts, good time-series support |
| **State Management** | Zustand | Lightweight, no boilerplate |
| **Styling** | Tailwind CSS | Rapid UI development |
| **API Layer** | Node.js + Express | Simple, well-understood, good async I/O |
| **Time-series DB** | TimescaleDB 2.x | SQL + automatic partitioning + aggregates |
| **Cache** | Redis 7.x / Valkey | Query caching, sessions, rate limiting |
| **Message Queue** | RabbitMQ | Reliable delivery, DLQ support |
| **Load Balancer** | nginx | Simple round-robin for local dev |
| **Dev Email** | Mailhog | Captures email locally |

## Security Considerations

### Authentication and Authorization

**Session-based Authentication**:
- Login returns session cookie (HttpOnly, Secure, SameSite=Strict)
- Sessions stored in Redis with 24-hour TTL
- Session ID: 32-byte random, base64-encoded

**Role-Based Access Control (RBAC)**:
| Role | Permissions |
|------|-------------|
| viewer | View dashboards, query metrics |
| editor | Create/edit own dashboards, create alerts |
| admin | All operations, user management, system config |

**Middleware Implementation**:
```javascript
// Auth middleware
async function requireAuth(req, res, next) {
  const sessionId = req.cookies.session;
  if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });

  const session = await redis.get(`session:${sessionId}`);
  if (!session) return res.status(401).json({ error: 'Session expired' });

  req.user = JSON.parse(session);
  next();
}

// RBAC middleware
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
```

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| Metrics ingestion | 10,000 req/min per IP | Sliding window |
| Query API | 100 req/min per user | Sliding window |
| Login | 5 attempts/min per IP | Fixed window + lockout |

**Implementation** (Redis + sliding window):
```javascript
async function rateLimit(key, limit, windowSec) {
  const now = Date.now();
  const windowStart = now - (windowSec * 1000);

  await redis.zremrangebyscore(key, 0, windowStart);
  const count = await redis.zcard(key);

  if (count >= limit) {
    return { allowed: false, retryAfter: windowSec };
  }

  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, windowSec);
  return { allowed: true, remaining: limit - count - 1 };
}
```

### Input Validation

- Metric names: Alphanumeric + underscores, max 255 chars
- Tag keys: Alphanumeric + underscores, max 64 chars
- Tag values: Any string, max 256 chars
- Queries: Sanitized to prevent SQL injection (parameterized)
- Timestamps: Must be within [now - 1 year, now + 5 minutes]

## Observability

### Metrics (Self-Monitoring)

The dashboarding system monitors itself using the same infrastructure:

| Metric | Type | Description |
|--------|------|-------------|
| `ingest_requests_total` | counter | Total ingestion requests |
| `ingest_points_total` | counter | Total data points ingested |
| `ingest_latency_ms` | histogram | Ingestion API latency |
| `query_requests_total` | counter | Total query requests |
| `query_latency_ms` | histogram | Query execution time |
| `cache_hits_total` | counter | Redis cache hits |
| `cache_misses_total` | counter | Redis cache misses |
| `queue_depth` | gauge | RabbitMQ queue size |
| `db_connections_active` | gauge | PostgreSQL connection pool usage |
| `alert_evaluations_total` | counter | Alert rule evaluations |
| `alerts_firing` | gauge | Currently firing alerts |

### Logging

**Structured JSON Logging**:
```javascript
// Log format
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "query-api",
  "request_id": "abc123",
  "user_id": 42,
  "message": "Query executed",
  "duration_ms": 150,
  "cache_hit": false,
  "metric_count": 1440
}
```

**Log Levels**:
- `error`: Unhandled exceptions, database failures
- `warn`: Rate limit hits, slow queries (> 2s), queue backpressure
- `info`: Request completion, significant state changes
- `debug`: Query plans, cache operations (disabled in production)

### Tracing

**Request ID Propagation**:
- Generate UUID for each incoming request
- Pass via `X-Request-ID` header to internal services
- Include in all log entries for correlation

**Key Spans** (for local tracing with console output):
- `http.request` - Full request lifecycle
- `db.query` - Database query execution
- `cache.get/set` - Redis operations
- `queue.publish` - RabbitMQ publish

### Health Checks

**Endpoint**: `GET /api/v1/admin/health`

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime_seconds": 3600,
  "checks": {
    "database": { "status": "up", "latency_ms": 5 },
    "redis": { "status": "up", "latency_ms": 1 },
    "rabbitmq": { "status": "up", "queue_depth": 42 }
  }
}
```

**Monitoring Alerts** (for the dashboarding system itself):
- `queue_depth > 10000` for 5 minutes: Ingestion backlog
- `cache_hit_rate < 50%` for 10 minutes: Cache ineffective
- `db_connections_active > 80%` for 5 minutes: Connection pool exhaustion
- `p99_query_latency > 5000ms` for 5 minutes: Query performance degradation

## Failure Handling

### Retry Strategies

| Operation | Strategy | Max Attempts | Backoff |
|-----------|----------|--------------|---------|
| DB write (worker) | Retry with backoff | 3 | 1s, 2s, 4s |
| Redis cache | Fail open (skip cache) | 1 | None |
| Alert notification | Retry with backoff | 3 | 30s, 60s, 120s |
| Query execution | No retry (return error) | 1 | None |

### Circuit Breaker Pattern

Applied to external notification endpoints (webhooks):

```javascript
const circuitBreaker = {
  state: 'closed',        // closed, open, half-open
  failures: 0,
  threshold: 5,           // Open after 5 failures
  resetTimeout: 60000,    // Try again after 1 minute
  lastFailure: null
};

async function sendWebhook(url, payload) {
  if (circuitBreaker.state === 'open') {
    if (Date.now() - circuitBreaker.lastFailure > circuitBreaker.resetTimeout) {
      circuitBreaker.state = 'half-open';
    } else {
      throw new Error('Circuit open');
    }
  }

  try {
    await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
    circuitBreaker.failures = 0;
    circuitBreaker.state = 'closed';
  } catch (error) {
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();
    if (circuitBreaker.failures >= circuitBreaker.threshold) {
      circuitBreaker.state = 'open';
    }
    throw error;
  }
}
```

### Dead Letter Queue (DLQ)

Failed ingestion messages go to `metrics.dlq`:
- Inspect with RabbitMQ Management UI (http://localhost:15672)
- Manual replay: Move messages back to main queue
- Auto-purge after 7 days

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Skip caching, queries hit DB directly |
| RabbitMQ down | API returns 503, buffer in memory (limited) |
| DB read replica down | Route to primary (higher latency) |
| Alert notification fails | Log error, mark alert as "notification_failed" |

### Backup and Recovery (Local Dev)

**Database Backup**:
```bash
# Daily backup (cron or manual)
pg_dump -Fc dashboarding > backup_$(date +%Y%m%d).dump

# Restore
pg_restore -d dashboarding backup_20240115.dump
```

**Data Recovery Priority**:
1. Dashboard/alert configurations (small, high value)
2. Metric definitions (small, needed for queries)
3. Recent raw metrics (last 24h, most valuable)
4. Aggregated data (can be regenerated from raw)

## Cost Trade-offs

### Storage Optimization

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| Compression (TimescaleDB) | ~10x on old chunks | Slight CPU overhead on reads |
| Aggressive retention | Linear with retention period | Less historical data |
| Skip continuous aggregates | ~20% storage | Slower long-range queries |
| JSONB tags vs normalized | Simpler schema | Higher storage, slower tag queries |

### Compute vs Storage

**Recommendation for local dev**: Optimize for simplicity, not cost.

- Keep all data in single TimescaleDB instance
- Use continuous aggregates (trade storage for query speed)
- Cache aggressively (trade memory for DB load)

### Queue Sizing

| Setting | Conservative | Aggressive |
|---------|--------------|------------|
| Message TTL | 1 hour | 24 hours |
| Queue max length | 100K messages | 1M messages |
| Disk backing | Yes | Yes |

**Recommendation**: Conservative settings for local dev to catch issues early.

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Add more instances behind load balancer (stateless)
2. **Ingestion Workers**: Add more consumers (RabbitMQ distributes)
3. **Read Replicas**: Add PostgreSQL replicas for query load
4. **Redis Cluster**: Shard cache by key hash (future)
5. **TimescaleDB Multi-node**: Distribute hypertable chunks (future)

### Cardinality Management

High-cardinality tags (like `request_id`) cause performance issues:

**Prevention**:
- Reject metrics with > 100 unique tag combinations per name
- Limit tag value length to 256 chars
- Monitor `SELECT COUNT(DISTINCT tags) FROM metrics_raw GROUP BY metric_id`

**Alerting**:
- Alert when any metric exceeds 10K unique tag combinations

## Future Optimizations

1. **WebSocket for real-time updates**: Replace polling for sub-second dashboards
2. **Query result streaming**: Large results sent incrementally
3. **Metric sharding**: Route by metric name hash to different DB nodes
4. **Pre-computed dashboards**: Background jobs render popular dashboards
5. **Anomaly detection**: ML-based alerting on metric deviations
6. **Multi-tenancy**: Isolate metrics by organization/team

## Local Development Setup

### Prerequisites

```bash
# macOS
brew install postgresql@16 timescaledb redis rabbitmq

# Or use Docker Compose (recommended)
docker-compose up -d
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  timescaledb:
    image: timescale/timescaledb:latest-pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: dashboarding
      POSTGRES_PASSWORD: dashboarding
      POSTGRES_DB: dashboarding
    volumes:
      - timescale_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: dashboarding
      RABBITMQ_DEFAULT_PASS: dashboarding

  mailhog:
    image: mailhog/mailhog
    ports:
      - "1025:1025"
      - "8025:8025"

volumes:
  timescale_data:
```

### Environment Variables

```bash
# .env
DATABASE_URL=postgresql://dashboarding:dashboarding@localhost:5432/dashboarding
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://dashboarding:dashboarding@localhost:5672
SMTP_HOST=localhost
SMTP_PORT=1025
SESSION_SECRET=local-dev-secret-change-in-prod
```

### Running the System

```bash
# Terminal 1: Infrastructure
docker-compose up -d

# Terminal 2: API servers
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002

# Terminal 3: Workers
npm run dev:worker

# Terminal 4: Alert evaluator
npm run dev:alerts

# Terminal 5: Frontend
cd frontend && npm run dev  # Port 5173
```

## Trade-offs and Alternatives

| Decision | Alternative | Why Not |
|----------|-------------|---------|
| TimescaleDB | InfluxDB | SQL flexibility, single DB for all data |
| TimescaleDB | ClickHouse | Overkill for local dev, complex setup |
| RabbitMQ | Kafka | Simpler for message queue use case |
| Redis | Memcached | Redis has more data structures (sorted sets for rate limiting) |
| Polling | WebSocket | Simpler, good enough for 10s refresh |
| Session auth | JWT | Simpler, immediate revocation |

## Implementation Notes

This section documents the key implementation decisions and explains WHY each pattern was chosen.

### Why Query Caching Reduces Database Load

Dashboard panels typically refresh every 10-30 seconds, and multiple users often view the same dashboard simultaneously. Without caching, each panel refresh triggers a full database query against large time-series tables, which can have millions of rows.

**Query caching provides:**

1. **Reduced database load**: Identical queries within the TTL window share results. If 10 users view the same dashboard, only 1 database query is executed instead of 10.

2. **Improved latency**: Cache hits return in <1ms compared to 100-500ms for database queries. This dramatically improves perceived dashboard responsiveness.

3. **Better scalability**: Redis can handle 10-100x more read operations than the database. Caching transforms database-bound scaling limits into memory-bound limits.

4. **Protection during traffic spikes**: When a popular dashboard goes viral (e.g., during an incident), the cache absorbs the sudden load increase, preventing database overload.

**Implementation details** (`src/shared/cache.ts`):
- Cache-aside pattern with `getOrLoad()` helper
- Deterministic cache keys from query parameters
- TTL strategy: 10s for live data (freshness), 5 minutes for historical data (performance)
- Size limits prevent caching extremely large results
- SHA-256 hash for fixed-length cache keys

### Why RBAC Enables Dashboard Sharing

Role-Based Access Control (RBAC) separates authorization from authentication, enabling fine-grained control over who can view versus edit dashboards.

**The problem without RBAC:**
- Either everyone can edit dashboards (risky - accidental modifications)
- Or dashboards are private-only (no sharing)

**How RBAC solves this:**

1. **Safe sharing across teams**: A DevOps engineer creates a critical production dashboard and shares it with the entire engineering team. Team members can VIEW but not accidentally modify or delete the dashboard.

2. **Separation of concerns**:
   - `viewer` role: Read-only access to public dashboards and metrics
   - `editor` role: Create/modify own dashboards and alerts
   - `admin` role: Manage any resource, system configuration

3. **Ownership model**: Dashboard creators maintain control. Only the owner (or admin) can modify or delete a dashboard, even when shared publicly.

**Implementation details** (`src/shared/auth.ts`):
- Permission-based authorization (e.g., `dashboard:update:own` vs `dashboard:update:any`)
- `requireOwnerOrAdmin()` middleware checks resource ownership
- Session stores role for fast authorization checks without database lookups

### Why Circuit Breakers Protect Against Slow Queries

Time-series databases can experience performance degradation under certain conditions: complex queries over long time ranges, high cardinality, or infrastructure issues. Without protection, these slow queries cause cascading failures.

**The cascade failure scenario:**
1. Database becomes slow (high load, complex query, network issue)
2. Queries accumulate, waiting for responses
3. Connection pool exhausts (all connections waiting on slow queries)
4. New requests can't get database connections
5. Entire API becomes unresponsive
6. Users retry, creating more load
7. System completely fails

**How circuit breakers prevent this:**

1. **Fast failure**: When the circuit opens, requests fail immediately instead of waiting for timeout. Users get an error in 1ms instead of 30 seconds.

2. **Database recovery time**: While the circuit is open, the database has time to complete pending queries and recover without new load.

3. **Automatic testing**: Half-open state periodically tests if the database recovered, automatically restoring normal operation.

4. **Metrics visibility**: Circuit breaker state is exposed via Prometheus metrics, enabling alerts before complete failure.

**Implementation details** (`src/shared/circuitBreaker.ts`):
- Opossum library provides battle-tested circuit breaker
- Separate breakers for different operation types (query, ingest, dashboard)
- Configurable thresholds: timeout (10s), error percentage (40%), reset timeout (60s)
- Fallback returns empty results instead of error when appropriate

### Why Ingestion Metrics Enable Capacity Planning

Ingestion metrics provide visibility into the data flow rate, which is essential for:

1. **Capacity planning**: By tracking points/second, operators can predict storage growth and plan infrastructure scaling before running out of capacity.

   Example calculation:
   - Current ingestion: 1,000 points/second
   - Point size: ~24 bytes
   - Daily storage: 1,000 * 86,400 * 24 = 2 GB/day
   - 30-day projection: 60 GB

2. **Anomaly detection**: A sudden drop in ingestion rate indicates data source failures. If monitoring agents stop sending metrics, the ingestion rate drops - this is often the first sign of infrastructure problems.

3. **Rate limiting decisions**: When ingestion rate approaches capacity limits, operators can make informed decisions about throttling or scaling.

4. **Cost forecasting**: In cloud environments, storage costs directly correlate with ingestion rate. Tracking ingestion enables accurate cost predictions.

**Implementation details** (`src/shared/metrics.ts` and `src/services/metricsService.ts`):
- `ingest_points_total`: Counter for total data points (throughput)
- `ingest_requests_total`: Counter with status label (success/error)
- `ingest_latency_seconds`: Histogram for batch write timing
- Prometheus `/metrics` endpoint for scraping
- Database connection pool metrics for capacity monitoring

### Shared Module Architecture

The implementation follows a shared module pattern for cross-cutting concerns:

```
backend/src/shared/
├── logger.ts         # Structured JSON logging with pino
├── metrics.ts        # Prometheus metrics and /metrics endpoint
├── health.ts         # Health check endpoints (/health, /health/live, /health/ready)
├── auth.ts           # Session auth and RBAC middleware
├── cache.ts          # Query result caching with Redis
└── circuitBreaker.ts # Database query protection
```

**Benefits:**
- Single source of truth for each concern
- Consistent behavior across all routes and services
- Easy to test and modify independently
- Clear separation between business logic and infrastructure
