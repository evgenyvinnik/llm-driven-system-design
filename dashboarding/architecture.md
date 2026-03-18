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

## Frontend Architecture

This section documents the React frontend implementation, covering component hierarchy, state management, routing, data fetching, and key UI patterns.

### Component Hierarchy

```
__root.tsx (RootLayout)
├── Navbar (components/Navbar.tsx)
│   └── Navigation links (Dashboards, Alerts, Metrics Explorer)
├── AlertBanner (components/AlertBanner.tsx)
│   └── Persistent banner showing currently firing alerts
├── index.tsx (Dashboard List)
│   └── Dashboard cards with name, description, create/delete actions
├── dashboard.$dashboardId.tsx (Dashboard View)
│   ├── TimeRangeSelector (components/TimeRangeSelector.tsx)
│   │   └── Preset buttons (15m, 1h, 6h, 24h, 7d) + refresh interval
│   └── DashboardGrid (components/DashboardGrid.tsx)
│       └── DashboardPanel (components/DashboardPanel.tsx) [repeated per panel]
│           ├── PanelChart (line, area, bar via Recharts)
│           ├── GaugePanel (radial gauge visualization)
│           └── StatPanel (single large number with label)
├── alerts.tsx (Alert Management)
│   ├── AlertRuleForm (components/alerts/AlertRuleForm.tsx)
│   │   └── Form for creating rules: metric, condition, threshold, severity
│   ├── AlertRuleList (components/alerts/AlertRuleList.tsx)
│   │   └── AlertRuleCard (components/alerts/AlertRuleCard.tsx) [repeated]
│   │       └── Rule summary, enable/disable toggle, evaluate, delete
│   └── AlertHistoryTable (components/alerts/AlertHistoryTable.tsx)
│       └── Table of alert instances with status, value, timestamps
├── metrics.tsx (Metrics Explorer)
│   └── Metric name selector, tag filter, time range, query results chart
```

### Zustand Stores

The frontend uses two Zustand stores:

**`useDashboardStore`** (`stores/dashboardStore.ts`) -- Manages dashboard UI state: the list of all dashboards, the currently selected dashboard, the active time range (default: `1h`), the auto-refresh interval (default: 10 seconds / 10000ms), and loading/error states. This store holds UI state only -- it does not make API calls directly. Instead, route components fetch data via the API module and push results into the store via `setDashboards` and `setCurrentDashboard`.

**`useAlertStore`** (`stores/alertStore.ts`) -- Manages alert-related state: alert rules, alert instances (firing and historical), currently firing alerts (filtered subset), and loading/error states. Like the dashboard store, it provides setters for data pushed in by the `useAlerts` hook rather than making API calls itself.

### Custom Hooks

**`useAlerts`** (`hooks/useAlerts.ts`) -- A custom React hook that encapsulates all alert data fetching and CRUD operations. On mount, it fetches alert rules and instances in parallel via `Promise.all`, then sets up a 30-second polling interval for live updates. It exposes `createRule`, `deleteRule`, `toggleRule` (enable/disable), and `evaluateRule` (manual test) actions. Each mutation triggers a full data re-fetch to ensure consistency. This hook owns the loading and error state independently from the Zustand store, giving the alerts page self-contained data management.

### Routing

The frontend uses TanStack Router with file-based routing:

- `/` -- Dashboard list page showing all accessible dashboards with create/delete actions
- `/dashboard/$dashboardId` -- Dashboard view with time range selector and panel grid (dynamic route segment)
- `/alerts` -- Alert rule management with creation form, rule list, and firing history
- `/metrics` -- Metrics explorer for ad-hoc querying and visualization

The root layout renders the `Navbar` and `AlertBanner` above all child routes. The `AlertBanner` is always visible across all pages, providing persistent visibility of firing alerts regardless of which page the user is on.

### Data Fetching

API communication uses a function-based module (`services/api.ts`) rather than a class. Each function is independently importable and typed:

- **Dashboard API**: `getDashboards`, `getDashboard`, `createDashboard`, `updateDashboard`, `deleteDashboard`
- **Panel API**: `createPanel`, `updatePanel`, `deletePanel`, `getPanelData` (fetches time-series data for rendering)
- **Metrics API**: `queryMetrics`, `getMetricNames`, `getMetricDefinitions`, `getMetricLatest`, `getMetricStats`, `ingestMetrics`
- **Alerts API**: `getAlertRules`, `createAlertRule`, `updateAlertRule`, `deleteAlertRule`, `getAlertInstances`, `evaluateAlertRule`

All functions use a shared `fetchJson` wrapper that handles JSON serialization, error extraction, and 204 No Content responses. The dashboard view page uses the `refreshInterval` from the dashboard store to set up periodic re-fetching of panel data, implementing the 10-second polling described in the architecture.

### Key UI Patterns

- **Polling-based refresh**: The dashboard view polls for panel data at the interval set in the dashboard store (default 10 seconds). This matches the architecture decision to use HTTP polling over WebSocket. Each poll benefits from Redis query caching on the backend.
- **Time range as global state**: The `TimeRangeSelector` component updates the dashboard store's `timeRange`, which all panels read from. Changing the time range triggers a re-fetch of all panel data simultaneously, providing a synchronized view across all visualizations.
- **Multiple chart types**: Panels support five visualization types: `line` (time-series trends), `area` (filled time-series), `bar` (comparison), `gauge` (radial progress toward a threshold), and `stat` (single large number). The `DashboardPanel` component dispatches to `PanelChart`, `GaugePanel`, or `StatPanel` based on the panel's `panel_type` field.
- **Persistent alert banner**: The `AlertBanner` component sits between the navbar and content area on every page. When alerts are firing, it displays a warning banner that cannot be dismissed by navigation. This ensures operators are always aware of active incidents.
- **Alert evaluation feedback**: The `evaluateRule` action in the `useAlerts` hook manually triggers alert evaluation on the backend and displays the result (should_fire + current_value) via a browser alert dialog. This enables testing alert rules against live data without waiting for the periodic evaluation cycle.
- **Separated state ownership**: Dashboard and alert stores hold only UI state (selections, lists, flags), while data fetching logic lives in route components and the `useAlerts` hook. This separation keeps stores simple and testable.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers who may be encountering these concepts for the first time.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles rather than individual users, and users are assigned one or more roles. Instead of checking "can user X create a dashboard?" the system checks "does user X have a role that includes the create-dashboard permission?"

In this project, there are three roles: `viewer`, `editor`, and `admin`. Viewers can see dashboards and query metrics but cannot change anything. Editors can create and edit their own dashboards and alert rules. Admins have full control including user management and system configuration. When a request arrives, the auth middleware extracts the user's role from their session and checks whether that role permits the requested operation.

The key advantage over per-user permission lists is simplicity: with thousands of monitoring users, you manage 3 role definitions instead of per-user ACLs. The `editor` role also includes ownership checks -- editors can only modify dashboards they created, not dashboards owned by other editors. This combines role-based and resource-based authorization for finer-grained control without per-user complexity.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application code is responsible for managing the cache. On every read, the application first checks the cache. If the data is there (a "cache hit"), it returns immediately. If not (a "cache miss"), the application fetches from the database, stores the result in the cache with a TTL (time-to-live), and then returns it.

In this project, cache-aside is used for query results with a two-tier TTL strategy: live data (queries covering the last hour) gets a 10-second TTL because the data changes rapidly, while historical data (queries for time ranges older than one hour) gets a 5-minute TTL because the data is immutable. Cache keys are deterministic SHA-256 hashes of the query parameters, ensuring identical queries always hit the same cache entry.

With 5K queries/second from dashboards polling every 10 seconds, caching provides a 10-100x reduction in database load. Multiple dashboards displaying the same metric at the same time range all share a single cached result. The trade-off is that live data may be up to 10 seconds stale, but for a monitoring system where dashboards refresh every 10 seconds, this staleness is invisible.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing service from being called repeatedly, giving it time to recover. It works like an electrical circuit breaker: when failures exceed a threshold, the breaker "opens" and immediately rejects all requests for a cooldown period, rather than letting them pile up and make the problem worse.

The circuit breaker has three states. In the **closed** state (normal operation), requests flow through to the downstream service. If failures exceed a configured threshold (40% error rate in this project), the breaker transitions to the **open** state. In the open state, all requests are immediately rejected without contacting the downstream service, returning an error or fallback response. After a configured timeout (60 seconds), the breaker enters the **half-open** state, where it allows a small number of test requests through. If those succeed, the breaker closes again; if they fail, it reopens.

In this project, circuit breakers (via the Opossum library) wrap database queries and external notification endpoints (webhooks for alert notifications). Separate breakers are used for different operation types (query, ingest, dashboard CRUD). When the database is slow or unreachable, the query circuit breaker opens and dashboard panels show an error state rather than timing out. This prevents slow queries from accumulating and exhausting the connection pool. The ingestion path has its own breaker so that query failures do not affect metric ingestion, and vice versa.

### Structured Logging

Structured logging means emitting log entries as machine-parseable data (typically JSON objects) rather than free-form text strings. Instead of `console.log('Query took 2.5s for metric cpu_usage')`, structured logging produces `{"level":"warn","metric":"cpu_usage","queryDuration":2500,"timeRange":"7d","timestamp":"..."}`.

This project uses Pino with pino-http for automatic request logging. Every HTTP request generates a log entry with method, path, status code, duration, and user ID. Health check requests (`/health/*`) are filtered from logs to reduce noise -- on a 10-second polling interval, health check logs would overwhelm actual operational data. Log levels are assigned by severity: `error` for unhandled exceptions, `warn` for rate limit hits and slow queries (>2s), `info` for request completions, `debug` for query plans and cache operations.

A dashboarding system monitoring itself is a meta-scenario where good logging is especially important. When a dashboard query is slow, the structured log entry contains the exact metric name, time range, and query duration, enabling direct correlation with the performance issue the dashboard is trying to visualize.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical metrics from applications by periodically "scraping" an HTTP endpoint (typically `/metrics`). The application exposes counters, histograms, and gauges in a text format that Prometheus understands, and Prometheus stores and queries this data over time.

This project's self-monitoring aspect is unique: the dashboarding system uses the same metrics infrastructure it provides to its users. The three main metric types are:
- **Counters**: Values that only go up (e.g., `ingest_requests_total`, `ingest_points_total`, `cache_hits_total`). Useful for computing rates (ingestion throughput, cache hit ratio).
- **Histograms**: Track the distribution of values (e.g., `ingest_latency_seconds`, `query_latency_seconds`). Enable percentile monitoring -- "are 95% of queries completing within 500ms?"
- **Gauges**: Values that go up or down (e.g., `queue_depth`, `db_connections_active`, `alerts_firing`). Show current state -- for example, connection pool saturation.

The `db_connections_active`, `idle`, and `total` gauges provide visibility into connection pool health, which is critical for a system that handles both high-throughput ingestion writes and concurrent query reads on the same database pool.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. It protects the system from abuse, prevents any single client from monopolizing resources, and ensures fair resource distribution.

This project implements rate limiting using Redis sorted sets for a sliding window algorithm. Unlike fixed window counters (which can allow burst traffic at window boundaries), sliding windows count requests over a continuously moving time window:
- Ingestion: 10,000 requests/minute per IP (high limit because agents send frequent metric batches)
- Query API: 100 requests/minute per user (prevents expensive queries from monopolizing database resources)
- Login: 5 attempts/minute per IP with lockout (brute force protection)

The sliding window works by storing each request's timestamp in a Redis sorted set. When checking the limit, the system removes timestamps older than the window, counts the remaining entries, and allows or rejects the request. This is more accurate than fixed window counters but uses slightly more memory (one entry per request vs. one counter per window).

For the ingestion endpoint, a high limit (10K/min per IP) is appropriate because metrics agents typically send batches every 10-30 seconds. A legitimate agent sending 100 metrics per batch at 10-second intervals would use only 600 requests/minute. The 10K limit provides headroom for burst scenarios without exposing the system to abuse.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a dashboarding system, this is important at the metrics ingestion layer -- if a metrics agent retries a failed batch submission, the system should not double-count data points.

This project achieves idempotency through the ingestion pipeline design. Metric data points are identified by the combination of `(metric_id, time, value)`. If the same data point is inserted twice (due to a retry), the database handles it based on the insert method. For batch COPY ingestion, duplicate timestamps for the same metric create additional rows, but aggregation queries (AVG, MAX, MIN) over time windows produce correct results because the duplicate values are identical.

Dashboard and alert rule operations use UUID primary keys. Creating the same dashboard twice (via a client retry) would generate a new UUID each time, but this is acceptable because dashboards are user-created entities -- the user simply deletes the duplicate. Alert rule evaluation is naturally idempotent: evaluating the same rule twice in the same 10-second window produces the same firing/not-firing result because it reads the same underlying metric data.

### Health Checks

Health checks are HTTP endpoints that report whether a service is alive and ready to handle traffic. They are consumed by load balancers, container orchestrators (Kubernetes), and monitoring systems to make automated decisions about routing and restarts.

This project implements three health check endpoints:
- **`/health`** (liveness): Returns 200 if the process is running. No dependency checks.
- **`/health/live`** (K8s liveness probe): Simple OK response. If this fails, the orchestrator should restart the container.
- **`/health/ready`** (readiness probe): Checks TimescaleDB and Redis connectivity. If TimescaleDB is unreachable, both ingestion and queries will fail, so the instance should be removed from the load balancer. If Redis is unreachable, the system degrades (uncached queries, no rate limiting) but can still function.

The readiness check is particularly important for a dashboarding system because TimescaleDB is a single point of failure -- without it, neither metric ingestion nor query serving works. Redis failure is treated as degraded but not down, because the system can fall back to direct database queries (at higher latency). Health check requests are filtered from Pino logs to prevent log flooding from frequent liveness probes.

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
