# Dashboarding System - Metrics Monitoring and Visualization - Architecture Design

## System Overview

A metrics monitoring and visualization system similar to Datadog or Grafana for collecting, storing, and visualizing time-series data. Core challenges involve high-throughput metrics ingestion, efficient time-series storage with automatic downsampling, real-time dashboard rendering, and alert evaluation.

**Learning Goals:**
- Design high-throughput time-series ingestion pipelines
- Implement automatic aggregation and downsampling
- Build real-time dashboards with multiple visualization types
- Design alert evaluation engines with state tracking

---

## Requirements

### Functional Requirements

- **Metrics Ingestion**: Collect metrics via HTTP batch API from applications and agents
- **Time-Series Storage**: Store raw metrics with automatic partitioning (hypertables)
- **Aggregation**: Automatic downsampling to 1-minute and 1-hour rollups
- **Dashboards**: Custom dashboard creation with multiple panel types (line, area, bar, gauge, stat)
- **Alerting**: Rule-based alerts with configurable thresholds, durations, and notification channels
- **Query Engine**: Flexible metric queries with time range selection and tag filtering
- **Retention**: Automatic data lifecycle management (raw → aggregated → purged)

### Non-Functional Requirements

- **Throughput**: 100K metrics/second ingestion at production scale
- **Query Latency**: p95 < 500ms for 24-hour ranges, p95 < 2s for 7-day ranges
- **Availability**: 99.95% uptime for ingestion, 99.9% for dashboards
- **Consistency**: Eventual consistency for metrics (seconds-level lag acceptable), strong consistency for dashboard/alert configurations
- **Retention**: Raw data 7 days, 1-min aggregates 30 days, 1-hour aggregates 1 year

---

## Capacity Estimation

### Production Scale

| Metric | Value | Rationale |
|--------|-------|-----------|
| Metrics ingestion | 100K/sec | 1000 services x 100 metrics each |
| Data points/day | 8.64B | 100K/sec x 86,400 sec/day |
| Raw storage/day | ~200 GB | 8.64B x 24 bytes avg per point |
| Active dashboards | 10K | Across all teams |
| Query throughput | 5K queries/sec | 10K dashboards x 10 panels x 0.05 refresh/sec |
| Alert rules | 50K | Across all services |
| Unique metric series | 10M | Cardinality across all tags |

### Storage Growth

| Tier | Resolution | Retention | Storage/Year |
|------|-----------|-----------|-------------|
| Raw | 1-second | 7 days | ~1.4 TB (rolling) |
| 1-minute aggregate | 1 minute | 30 days | ~150 GB (rolling) |
| 1-hour aggregate | 1 hour | 1 year | ~30 GB |

### Local Development Scale

| Metric | Target | Sizing Rationale |
|--------|--------|------------------|
| Metrics ingestion | 1,000/sec | 10 simulated services x 100 metrics each |
| Data points/day | 86.4M | 1,000/sec x 86,400 sec/day |
| Raw storage/day | ~2 GB | 86.4M x 24 bytes avg per point |
| Query throughput | 50 queries/sec | 5 dashboards x 10 panels x 1 refresh/sec |
| Retention (raw) | 7 days | ~14 GB total raw data |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Metrics Sources                                    │
│     (Applications, Prometheus exporters, StatsD agents)              │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway / Load Balancer                    │
│                  (Rate limiting, auth, routing)                       │
└──────────────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                                    ▼
     ┌──────────────┐                     ┌──────────────┐
     │  Ingestion   │                     │  Query API   │
     │  API (N)     │                     │  (N)         │
     │              │                     │              │
     │ POST /metrics│                     │ POST /query  │
     │  → 202       │                     │ GET /dash    │
     └──────┬───────┘                     └──────┬───────┘
            │                                    │
            ▼                                    │
     ┌──────────────┐                            │
     │  Message     │                            │
     │  Queue       │                            │
     │  (Kafka)     │                            │
     └──────┬───────┘                            │
            │                                    │
            ▼                                    │
     ┌──────────────┐                            │
     │  Ingestion   │                            │
     │  Workers (N) │                            │
     │              │                            │
     │  Batch COPY  │                            │
     │  to TSDB     │                            │
     └──────┬───────┘                            │
            │                                    │
            ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       TimescaleDB Cluster                            │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ metrics      │  │ metrics_1min │  │ metrics_1hr  │              │
│  │ (hypertable) │  │ (cont. agg)  │  │ (cont. agg)  │              │
│  │ 7-day retain │  │ 30-day       │  │ 1-year       │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ dashboards   │  │ panels       │  │ alert_rules  │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└──────────────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     ┌──────────────┐  ┌──────────────┐   ┌──────────────┐
     │  Redis       │  │  Alert       │   │  React       │
     │  (Query      │  │  Evaluator   │   │  Frontend    │
     │   cache +    │  │  (Periodic)  │   │              │
     │   sessions)  │  │              │   │  Recharts    │
     └──────────────┘  └──────────────┘   └──────────────┘
```

### Request Flow: Metrics Ingestion

```
1. Client sends POST /api/v1/metrics with batch of data points
2. API validates payload (metric names, tag constraints, timestamps)
3. API resolves metric definitions (cache metric IDs in Redis, 1-hour TTL)
4. API publishes batch to message queue (Kafka topic: metrics.ingest)
5. API returns 202 Accepted immediately (fire-and-forget)
6. Ingestion Worker consumes batch, buffers for 100ms or 1000 points
7. Worker bulk-inserts to TimescaleDB via COPY command (10x faster than INSERT)
8. TimescaleDB routes to appropriate hypertable chunk (1-day intervals)
9. Continuous aggregates automatically update 1-min and 1-hour rollups
```

### Request Flow: Dashboard Query

```
1. Frontend requests POST /api/v1/query with metric name, time range, aggregation
2. API generates deterministic cache key from query parameters (SHA-256)
3. API checks Redis cache:
   - Live data (last 1 hour): 10-second TTL
   - Historical data (> 1 hour ago): 5-minute TTL
4. Cache miss → route query to appropriate table:
   - Time range <= 1 hour: metrics (raw, 1s resolution)
   - Time range <= 24 hours: metrics_1min (1-min resolution)
   - Time range > 24 hours: metrics_1hour (1-hour resolution)
5. API caches result in Redis, returns JSON
6. Frontend renders chart with Recharts
```

### Request Flow: Alert Evaluation

```
1. Alert Evaluator runs every 10-30 seconds
2. Fetch all enabled alert rules from PostgreSQL
3. For each rule:
   a. Query recent metric data (window_seconds)
   b. Evaluate condition (gt, lt, eq, ne) against threshold
   c. If condition true:
      - Check Redis for existing alert state
      - If firing duration exceeds configured window: trigger notification
      - Record alert_instance in PostgreSQL
   d. If condition false and previously firing: resolve alert
4. Send notifications (email, webhook, console)
```

---

## Core Components

### 1. Ingestion API

Stateless HTTP API accepting metric batches. Validates metric names (alphanumeric + underscores, max 255 chars), tag constraints (max 64-char keys, max 256-char values), and timestamps (within [now - 1 year, now + 5 minutes]). Returns 202 Accepted after queueing.

### 2. Ingestion Workers

Consume from message queue, buffer data points, and bulk-insert to TimescaleDB using the COPY protocol (10x faster than individual INSERTs). Workers are horizontally scalable: adding more consumers increases throughput linearly.

### 3. Query API

Serves dashboard queries with automatic query routing: short time ranges hit raw data, medium ranges hit 1-minute aggregates, long ranges hit 1-hour aggregates. Results are cached in Redis with TTLs based on data freshness.

### 4. TimescaleDB (Time-Series Storage)

PostgreSQL extension providing hypertables (automatic time-based partitioning), continuous aggregates (materialized rollups), and retention policies (automatic chunk deletion). Single database for both time-series data and metadata (dashboards, alerts, users).

### 5. Alert Evaluator

Background process that periodically evaluates all enabled alert rules against recent metric data. Tracks alert state (pending → firing → resolved) with duration-based triggering to prevent flapping. Sends notifications via email (Mailhog for local) or webhooks.

### 6. Redis (Query Cache + Sessions)

Caches query results with short TTLs (10s for live, 5min for historical), metric definition IDs (1-hour TTL), and session data. Rate limiting uses sorted sets for sliding window implementation.

---

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Users
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(100) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Metric definitions (cached in Redis for fast lookups)
CREATE TABLE IF NOT EXISTS metric_definitions (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, tags)
);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_name ON metric_definitions(name);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_tags ON metric_definitions USING GIN(tags);

-- Raw metrics (hypertable with 1-day chunks)
CREATE TABLE IF NOT EXISTS metrics (
    time            TIMESTAMPTZ NOT NULL,
    metric_id       INTEGER NOT NULL REFERENCES metric_definitions(id),
    value           DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('metrics', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);
CREATE INDEX IF NOT EXISTS idx_metrics_metric_time ON metrics(metric_id, time DESC);

-- Dashboards
CREATE TABLE IF NOT EXISTS dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    layout          JSONB NOT NULL DEFAULT '{"columns": 12, "rows": 8}'::jsonb,
    is_public       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboards_user ON dashboards(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_public ON dashboards(is_public);

-- Panels
CREATE TABLE IF NOT EXISTS panels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    panel_type      VARCHAR(50) NOT NULL,  -- line, area, bar, gauge, stat
    query           JSONB NOT NULL,
    position        JSONB NOT NULL,  -- {x, y, w, h}
    options         JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON panels(dashboard_id);

-- Alert rules
CREATE TABLE IF NOT EXISTS alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    metric_name     VARCHAR(255) NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb,
    condition       JSONB NOT NULL,  -- {operator: 'gt', value: 90}
    window_seconds  INTEGER NOT NULL DEFAULT 300,
    severity        VARCHAR(20) DEFAULT 'warning',
    notifications   JSONB NOT NULL DEFAULT '[{"channel": "console", "target": "default"}]'::jsonb,
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_metric ON alert_rules(metric_name);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);

-- Alert instances (fired alerts)
CREATE TABLE IF NOT EXISTS alert_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'firing',
    value           DOUBLE PRECISION,
    fired_at        TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    notification_sent BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_alert_instances_rule ON alert_instances(rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_instances_status ON alert_instances(status);

-- Retention policy for raw metrics
SELECT add_retention_policy('metrics', INTERVAL '7 days', if_not_exists => TRUE);
```

### Redis Cache Structure

| Pattern | Type | TTL | Purpose |
|---------|------|-----|---------|
| `cache:query:{hash}` | String (JSON) | 10s / 5min | Query result cache (live vs historical) |
| `cache:metric:name:{name}` | String | 1 hour | Metric definition ID lookup |
| `session:{sessionId}` | Hash | 24 hours | User session data |
| `ratelimit:ingest:{ip}` | Sorted set | 1 minute | Ingestion rate limiting (10K/min) |
| `ratelimit:query:{userId}` | Sorted set | 1 minute | Query rate limiting (100/min) |
| `alert:state:{ruleId}` | String (JSON) | 1 hour | Alert firing duration tracking |

---

## API Design

### Core Endpoints

```
# Metrics Ingestion
POST   /api/v1/metrics              → Bulk ingest metrics (returns 202)

# Metrics Query
POST   /api/v1/query                → Execute time-series query
GET    /api/v1/metrics              → List metric definitions
GET    /api/v1/metrics/:name/tags   → Get tag values for metric

# Dashboards
GET    /api/v1/dashboards           → List dashboards
POST   /api/v1/dashboards           → Create dashboard
GET    /api/v1/dashboards/:id       → Get dashboard with panels
PUT    /api/v1/dashboards/:id       → Update dashboard
DELETE /api/v1/dashboards/:id       → Delete dashboard

# Panels
POST   /api/v1/dashboards/:id/panels    → Add panel
PUT    /api/v1/panels/:id               → Update panel
DELETE /api/v1/panels/:id               → Delete panel

# Alerts
GET    /api/v1/alerts               → List alert rules
POST   /api/v1/alerts               → Create alert rule
PUT    /api/v1/alerts/:id           → Update alert rule
DELETE /api/v1/alerts/:id           → Delete alert rule
GET    /api/v1/alerts/:id/history   → Get alert history
POST   /api/v1/alerts/:id/evaluate  → Manually evaluate alert

# Auth
POST   /api/v1/auth/login           → Login
POST   /api/v1/auth/logout          → Logout
GET    /api/v1/auth/me              → Current user
```

---

## Key Design Decisions

### TimescaleDB vs InfluxDB vs ClickHouse

**Chosen: TimescaleDB (PostgreSQL extension).**

The fundamental advantage is having a single database for both time-series data and metadata. Dashboards, alert rules, and user accounts live alongside metrics in the same PostgreSQL instance, enabling SQL joins (e.g., "show all alert rules for metrics on dashboard X") without cross-database coordination. Hypertables transparently partition by time, and continuous aggregates provide materialized rollups without application-level aggregation code.

InfluxDB offers higher raw write throughput, but its query language (InfluxQL/Flux) is less expressive than SQL and it would require a separate database for metadata. ClickHouse excels at OLAP analytics but is overkill for the monitoring use case and has a steeper operational learning curve.

The trade-off is write latency: TimescaleDB is slightly slower than purpose-built TSDBs for individual inserts. We mitigate this with batch COPY writes (10x faster than INSERT) via the ingestion worker pipeline. At 100K points/second, this is well within TimescaleDB's documented throughput ceiling.

### Async Ingestion via Message Queue

**Chosen: Fire-and-forget ingestion with queue-backed batch writes.**

The ingestion API returns 202 Accepted immediately after publishing to the message queue, decoupling ingestion rate from database write speed. This has three critical benefits:

1. **Backpressure handling**: If the database slows down, the queue absorbs the burst. Workers process at their own pace without dropping metrics.
2. **Write amplification**: Individual INSERTs at 100K/sec would create enormous WAL pressure. Batching 1000 points into a single COPY command reduces write amplification by 1000x.
3. **Horizontal scaling**: Adding more workers linearly increases write throughput without changing the API layer.

The cost is eventual consistency: metrics appear in queries a few hundred milliseconds after ingestion. For a monitoring system where dashboards refresh every 10 seconds, this latency is invisible.

### Polling vs WebSocket for Dashboard Updates

**Chosen: HTTP polling with 10-second intervals.**

WebSocket would reduce latency from ~10 seconds to sub-second, but monitoring dashboards do not require sub-second updates. The typical use case is watching trends over minutes and hours, not reacting to individual data points. Polling is dramatically simpler to implement, debug, and cache. Each poll is a standard HTTP request that benefits from Redis query caching, load balancer distribution, and standard observability tooling.

The trade-off is 6x higher request volume (polling every 10s vs a single WebSocket connection). At 5K dashboards with 10 panels each, this means 5K requests/second, which is easily handled by the stateless query API with Redis caching absorbing repeated identical queries.

---

## Aggregation and Downsampling

### Strategy

TimescaleDB continuous aggregates provide zero-application-code rollups:

| Tier | Resolution | Retention | Source | Update Interval |
|------|-----------|-----------|--------|-----------------|
| Raw (`metrics`) | 1 second | 7 days | Direct ingest | Real-time |
| 1-minute (`metrics_1min`) | 1 minute | 30 days | Continuous aggregate | Every 1 minute |
| 1-hour (`metrics_1hour`) | 1 hour | 1 year | Continuous aggregate | Every 1 hour |

### Query Routing Logic

The query API automatically selects the optimal table based on requested time range:

| Requested Range | Table Used | Resolution | Why |
|-----------------|-----------|------------|-----|
| <= 1 hour | `metrics` | 1 second | Full fidelity for recent data |
| <= 24 hours | `metrics_1min` | 1 minute | Sufficient resolution, 60x fewer rows |
| > 24 hours | `metrics_1hour` | 1 hour | Efficient for trends, 3600x fewer rows |

This routing is transparent to the frontend. A 7-day dashboard query scans ~168 rows per metric (7 days x 24 hours) instead of 604,800 raw rows.

---

## Security

### Authentication

Session-based authentication with Redis store (connect-redis). Sessions have 24-hour TTL. Cookies set with HttpOnly, Secure (in production), SameSite=Lax. Passwords hashed with bcrypt.

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| `viewer` | View dashboards, query metrics |
| `editor` | Create/edit own dashboards, create alerts |
| `admin` | All operations, user management, system configuration |

### Rate Limiting

| Endpoint | Limit | Window | Implementation |
|----------|-------|--------|----------------|
| Metrics ingestion | 10,000 req/min per IP | Sliding window | Redis sorted set |
| Query API | 100 req/min per user | Sliding window | Redis sorted set |
| Login | 5 attempts/min per IP | Fixed window + lockout | Redis counter |

### Input Validation

Metric names: alphanumeric + underscores, max 255 chars. Tag keys: alphanumeric + underscores, max 64 chars. Tag values: any string, max 256 chars. Timestamps: within [now - 1 year, now + 5 minutes]. All SQL queries use parameterized statements (Zod validation on API inputs).

---

## Observability

### Self-Monitoring Metrics

The dashboarding system monitors itself using the same infrastructure:

| Metric | Type | Purpose |
|--------|------|---------|
| `ingest_requests_total` | Counter | Total ingestion requests |
| `ingest_points_total` | Counter | Total data points ingested |
| `ingest_latency_seconds` | Histogram | Ingestion API latency |
| `query_requests_total` | Counter | Total query requests |
| `query_latency_seconds` | Histogram | Query execution time |
| `cache_hits_total` / `cache_misses_total` | Counter | Cache hit rate |
| `queue_depth` | Gauge | Message queue size |
| `db_connections_active` / `idle` / `total` | Gauge | Connection pool usage |
| `alert_evaluations_total` | Counter | Alert rule evaluations |
| `alerts_firing` | Gauge | Currently firing alerts |

### Structured Logging

Pino-based JSON logging with pino-http for automatic request logging. Health check requests are filtered from logs to reduce noise. Log levels: error (unhandled exceptions), warn (rate limits, slow queries > 2s), info (request completion), debug (query plans, cache operations).

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/health` | Liveness | Process running |
| `/health/live` | K8s liveness probe | Simple OK |
| `/health/ready` | Readiness probe | TimescaleDB + Redis connectivity |

---

## Failure Handling

### Retry Strategies

| Operation | Strategy | Max Attempts | Backoff |
|-----------|----------|--------------|---------|
| DB write (worker) | Retry with backoff | 3 | 1s, 2s, 4s |
| Redis cache | Fail open (skip cache) | 1 | None |
| Alert notification | Retry with backoff | 3 | 30s, 60s, 120s |
| Query execution | No retry (return error) | 1 | None |

### Circuit Breaker Pattern

Applied to database queries (Opossum library) and external notification endpoints (webhooks). Separate breakers for different operation types (query, ingest, dashboard CRUD). Configuration: timeout 10s, error percentage 40%, reset timeout 60s.

### Dead Letter Queue

Failed ingestion messages go to `metrics.dlq`. Inspectable via RabbitMQ Management UI. Auto-purge after 7 days.

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Skip caching, queries hit DB directly (higher latency) |
| Message queue down | API returns 503 for ingestion, queries still work |
| DB read replica down | Route to primary (higher latency) |
| Alert notification fails | Log error, mark alert as "notification_failed" |

### Cardinality Management

High-cardinality tags (e.g., `request_id`) cause performance degradation. Prevention: reject metrics with > 100 unique tag combinations per name, limit tag value length to 256 chars. Alert when any metric exceeds 10K unique tag combinations.

---

## Scalability Considerations

### Horizontal Scaling Path

1. **Ingestion API**: Add more stateless instances behind load balancer
2. **Ingestion Workers**: Add more queue consumers (Kafka distributes partitions)
3. **Query API**: Add more stateless instances (Redis absorbs cache hits)
4. **TimescaleDB**: Read replicas for query load, multi-node for distributed hypertable chunks
5. **Redis**: Redis Cluster for cache sharding

### What Breaks First

At 10x scale (1M metrics/sec):
- **Ingestion write throughput**: Single TimescaleDB node saturates. Solution: multi-node TimescaleDB with distributed hypertables, or separate write nodes.
- **Cardinality explosion**: 100M unique series degrades query performance. Solution: aggressive tag cardinality limits, pre-aggregation.
- **Alert evaluation latency**: 500K alert rules at 10-second intervals creates evaluation backlog. Solution: partition rules across multiple evaluator instances by metric name hash.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Time-series DB | TimescaleDB | InfluxDB | SQL flexibility, single DB for all data |
| Time-series DB | TimescaleDB | ClickHouse | Simpler setup, sufficient for monitoring |
| Message queue | Kafka | RabbitMQ | Better for high-throughput ingestion, partitioned consumers |
| Dashboard updates | Polling (10s) | WebSocket | Simpler, cacheable, sufficient for monitoring |
| Auth | Session + Redis | JWT | Immediate revocation, simpler |
| Cache | Redis (10s/5min TTL) | No cache | 10-100x query reduction |
| Aggregation | Continuous aggregates | Application-level rollups | Zero code, incremental updates |
| Alert evaluation | Pull-based (periodic) | Push-based (stream) | Simpler, configurable interval |

---

## Implementation Notes

This section maps the production architecture to the actual local implementation running on Docker + Node.js + Express.

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (Vite)                        │
│                  localhost:5173                           │
│                                                          │
│  Routes:                                                 │
│    / (dashboard list)                                    │
│    /dashboard/:id (dashboard view with panels)           │
│    /alerts (alert rule management + history)             │
│    /metrics (metrics explorer)                           │
│                                                          │
│  Components: Recharts (line, area, bar, gauge, stat)     │
│              TimeRangeSelector, DashboardGrid             │
│              AlertRuleForm, AlertRuleCard, AlertHistory   │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP (polling every 10s)
                            ▼
┌──────────────────────────────────────────────────────────┐
│              API Server (Express)                         │
│           localhost:3001 / 3002 / 3003                    │
│                                                          │
│  /api/v1/auth/*           Session auth                   │
│  /api/v1/metrics          Ingest + query + list          │
│  /api/v1/dashboards/*     CRUD + panels                  │
│  /api/v1/alerts/*         Rules + history + evaluate     │
│  /health, /health/live, /health/ready                    │
│  /metrics                 Prometheus endpoint            │
│                                                          │
│  Background: Alert evaluator (every 30s)                 │
└─────┬──────────────┬────────────────────────────────────┘
      │              │
      ▼              ▼
┌──────────┐  ┌──────────┐
│TimescaleDB│  │  Valkey   │
│  :5432   │  │  :6379   │
│          │  │          │
│  metrics │  │ Sessions │
│  metricsdb│ │ Cache    │
│  metrics123│ │ Alerts   │
└──────────┘  └──────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | File | Description |
|---------|------|-------------|
| Structured logging | `backend/src/shared/logger.ts` | Pino + pino-http, auto-filtered health check logs, startup/shutdown logging |
| Prometheus metrics | `backend/src/shared/metrics.ts` | HTTP latency histograms, ingestion counters, DB pool gauges, cache hit/miss counters |
| Circuit breakers | `backend/src/shared/circuitBreaker.ts` | Opossum-based breakers for DB queries, configurable thresholds, fallback handlers |
| Query caching | `backend/src/shared/cache.ts` | Redis cache-aside with TTL strategy (10s live, 5min historical), SHA-256 cache keys |
| Health checks | `backend/src/shared/health.ts` | `/health`, `/health/live`, `/health/ready` with TimescaleDB + Redis checks |
| RBAC auth | `backend/src/shared/auth.ts` | Session-based auth, role middleware (viewer/editor/admin), ownership checks |
| TimescaleDB hypertables | `backend/db/init.sql` | Automatic time-based partitioning, retention policy (7-day raw) |
| Alert evaluation | `backend/src/services/alertService.ts` | Periodic evaluator with state tracking, configurable interval |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT handlers, pool draining, Redis disconnect |
| Security headers | `backend/src/index.ts` | Helmet middleware, CORS, response compression |
| Input validation | `backend/src/routes/metrics.ts` | Zod schema validation for metric payloads |
| DB connection pooling | `backend/src/db/pool.ts` | pg Pool with periodic metric reporting |
| Metric ID caching | `backend/src/services/metricsService.ts` | In-memory + Redis cache for metric definition lookups |

### Simplifications for Local Development

| Production Design | Local Substitute | Why |
|-------------------|------------------|-----|
| Kafka for ingestion queue | Direct DB writes (synchronous) | No Kafka/Zookeeper overhead (Kafka in docker-compose only via profile) |
| Ingestion worker cluster | Inline writes in API handler | No separate worker process needed at 1K/sec |
| TimescaleDB multi-node | Single TimescaleDB instance | Sufficient for local data volume |
| Continuous aggregates | Not configured (query raw data) | Simpler, raw data small enough |
| Read replicas | Single database | Low query volume |
| Redis Cluster | Single Valkey instance | < 256 MB cache |
| CDN / edge cache | Direct Vite dev server | No CDN needed locally |
| API Gateway + LB | Direct connection on port 3001-3003 | No nginx needed |
| SMTP provider | Mailhog (docker-compose optional) | Captures emails locally |
| WebSocket for sub-second updates | HTTP polling (10s) | Simpler, sufficient |

### What Was Omitted

- CDN for static assets
- Multi-region deployment and geo-routing
- Kubernetes orchestration and auto-scaling
- OAuth/OIDC integration (uses session auth instead)
- WebSocket for real-time sub-second dashboard updates
- Query result streaming for large results
- Metric sharding across database nodes
- Pre-computed dashboard snapshots
- Anomaly detection (ML-based alerting)
- Multi-tenancy with organization isolation
- Drag-and-drop panel layout editing
- PromQL query language parser
- Continuous aggregates for automatic rollups
