# Ad Click Aggregator - Architecture Design

## System Overview

A real-time analytics system for aggregating ad clicks with fraud detection capabilities. The system handles high-volume click events, deduplicates them for exactly-once semantics, detects fraudulent patterns, and provides real-time analytics through pre-computed aggregations. This project explores time-series data ingestion, OLAP query optimization, and billing-accuracy guarantees.

## Requirements

### Functional Requirements

1. **Click Tracking**: Record every ad click with metadata (ad_id, campaign_id, user_id, timestamp, geo, device)
2. **Real-time Aggregation**: Aggregate clicks by various dimensions (per ad, per campaign, per hour, per geo) with minute-level freshness
3. **Reporting API**: Query aggregated data for dashboards and billing reconciliation
4. **Fraud Detection**: Identify and filter suspicious click patterns based on velocity and behavioral signals

### Non-Functional Requirements

- **Throughput**: 10,000 clicks/second sustained ingestion across all collectors
- **Availability**: 99.9% uptime for ingestion path; 99.5% for analytics queries
- **Latency**: Writes p99 < 50ms; aggregation queries p95 < 200ms
- **Consistency**: Exactly-once semantics for click counting (billing accuracy)
- **Durability**: Zero data loss for raw click events; aggregates rebuildable from raw data

### Out of Scope

- Impression tracking and viewability measurement
- Real-time bidding (RTB) integration
- ML-based fraud detection (rule-based only)
- Multi-tenant advertiser isolation

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Daily Active Users (DAU) | 50M |
| Write RPS (peak) | 10,000 clicks/sec |
| Read RPS (analytics) | 100 queries/sec |
| Raw event size | ~500 bytes |
| Daily raw storage | ~430 GB |
| Monthly raw storage | ~13 TB |
| Inbound bandwidth | ~5 MB/s |

### Storage Breakdown

| Data Tier | Volume | Retention |
|-----------|--------|-----------|
| Raw clicks (hot) | ~3 TB (7 days) | 7 days in PostgreSQL |
| Raw clicks (warm) | ~13 TB (30 days) | 30 days compressed |
| Raw clicks (cold) | ~156 TB/year | 1 year in S3/MinIO (Parquet) |
| Minute aggregates | ~10 GB | 7 days (auto-TTL in ClickHouse) |
| Hourly aggregates | ~50 GB | 1 year |
| Daily aggregates | ~5 GB | Indefinite |
| Redis dedup keys | ~200 MB peak | 5-minute TTL |

## High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ad Servers    │     │   Ad Servers    │     │   Ad Servers    │
│ (Click Sources) │     │ (Click Sources) │     │ (Click Sources) │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                        ┌────────▼────────┐
                        │   CDN / L7 LB   │
                        │  (GeoDNS, TLS)  │
                        └────────┬────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼────────┐ ┌──────▼────────┐ ┌───────▼───────┐
     │ Click Collector │ │Click Collector│ │Click Collector│
     │   Instance 1    │ │  Instance 2   │ │  Instance N   │
     └────────┬────────┘ └──────┬────────┘ └───────┬───────┘
              │                 │                   │
    ┌─────────┴─────────────────┴───────────────────┘
    │
    ├──────────────────────────┐
    │                          │
    ▼                          ▼
┌─────────────────┐   ┌─────────────────┐
│  Redis Cluster  │   │  Kafka Cluster  │
│ (Dedup, Rate    │   │ (Event Stream)  │
│  Limit, HLL)    │   │                 │
└─────────────────┘   └────────┬────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
           ┌───────▼───────┐    ┌────────▼────────┐
           │  PostgreSQL   │    │   ClickHouse    │
           │  (Entities,   │    │  (Analytics,    │
           │   Audit Trail)│    │   Materialized  │
           └───────────────┘    │   Views)        │
                                └────────┬────────┘
                                         │
                                ┌────────▼────────┐
                                │  Query Service  │
                                │  (Analytics)    │
                                └────────┬────────┘
                                         │
                                ┌────────▼────────┐
                                │   Dashboard     │
                                │   (React)       │
                                └─────────────────┘
```

## Core Components

### 1. Click Collector Service

Stateless HTTP service that receives click events and feeds them into the pipeline.

**Request flow:**
1. Receive click event via `POST /api/v1/clicks`
2. Validate payload with schema validation (required fields, types, ranges)
3. Generate `click_id` if not provided by caller
4. Check Redis for duplicate `click_id` (SETEX with 5-minute TTL)
5. Run fraud detection rules (IP velocity, user velocity, device fingerprint)
6. If idempotency-key header present, check Redis for cached response
7. Write raw event to PostgreSQL (audit trail) and ClickHouse (analytics) in parallel
8. Return 202 Accepted with click metadata

**Scaling strategy:** Stateless instances behind a load balancer. Each instance connects to Redis for dedup and both databases for writes. At 10K clicks/sec, 5-10 collector instances handle the load with headroom.

### 2. Redis Cache Layer

Redis provides the sub-millisecond operations needed in the ingestion hot path.

| Operation | Key Pattern | TTL | Purpose |
|-----------|-------------|-----|---------|
| Deduplication | `dedup:{click_id}` | 5 min | Prevent double-counting |
| IP rate limit | `ratelimit:ip:{ip_hash}` | 1 min | Fraud velocity detection |
| User rate limit | `ratelimit:user:{user_id}` | 1 min | Fraud velocity detection |
| Unique users | `hll:{ad_id}:{hour}` | 2 hours | HyperLogLog cardinality |
| Idempotency cache | `idempotency:{key}` | 5 min | Cached responses for retries |

**Why Redis over in-memory:** Dedup state must be shared across all collector instances. An in-memory set per instance would allow duplicates when the same click hits different instances via the load balancer.

### 3. PostgreSQL (Relational Data + Audit Trail)

Stores business entities (advertisers, campaigns, ads) with referential integrity and raw click events for billing dispute resolution.

**Why PostgreSQL for raw clicks:** ACID transactions ensure every click is durably stored. The audit trail survives even if ClickHouse loses data during a merge or compaction. Billing disputes require provable, transactionally-consistent records.

### 4. ClickHouse (Time-Series Analytics)

Columnar OLAP database optimized for high-write throughput and aggregation queries.

**Key features leveraged:**
- **MergeTree engine**: Ordered data with efficient range scans on time columns
- **SummingMergeTree**: Automatic aggregation during background merges
- **Materialized views**: Real-time aggregation on insert (minute, hour, day)
- **LowCardinality**: Dictionary encoding for enum-like columns (device_type, country)
- **TTL**: Automatic data expiration per table (90 days for raw, 7 days for minute aggregates)
- **Partitioning**: Monthly partitions enable efficient pruning for time-range queries

### 5. Query Service

Reads from ClickHouse materialized views to serve dashboard and reporting queries. Supports flexible aggregation by time granularity, campaign, ad, country, and device type.

### 6. Dashboard (React + Recharts)

Real-time metrics display with time-series charts, campaign analytics, geographic distribution, and a test click generator for development.

## Database Schema

### PostgreSQL Schema

The complete schema is defined in `backend/src/db/init.sql`.

```sql
-- Core entity hierarchy: Advertiser → Campaign → Ad
CREATE TABLE advertisers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE campaigns (
    id VARCHAR(50) PRIMARY KEY,
    advertiser_id VARCHAR(50) NOT NULL REFERENCES advertisers(id),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',  -- 'active', 'paused', 'completed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE ads (
    id VARCHAR(50) PRIMARY KEY,
    campaign_id VARCHAR(50) NOT NULL REFERENCES campaigns(id),
    name VARCHAR(255) NOT NULL,
    creative_url TEXT,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Raw click events (audit trail for billing disputes)
CREATE TABLE click_events (
    id SERIAL PRIMARY KEY,
    click_id VARCHAR(50) UNIQUE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(100),
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    device_type VARCHAR(20),
    os VARCHAR(50),
    browser VARCHAR(50),
    country VARCHAR(3),
    region VARCHAR(50),
    ip_hash VARCHAR(64),
    is_fraudulent BOOLEAN DEFAULT FALSE,
    fraud_reason VARCHAR(255),
    idempotency_key VARCHAR(64),
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Aggregation tables (minute, hour, day) with UPSERT support
CREATE TABLE click_aggregates_minute (
    id SERIAL PRIMARY KEY,
    time_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    country VARCHAR(3),
    device_type VARCHAR(20),
    click_count BIGINT DEFAULT 0,
    unique_users BIGINT DEFAULT 0,
    fraud_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(time_bucket, ad_id, country, device_type)
);
-- Identical structure for click_aggregates_hour and click_aggregates_day
```

#### Index Strategy

| Index | Purpose |
|-------|---------|
| `UNIQUE(click_id)` on click_events | Database-level dedup (last line of defense) |
| `UNIQUE(idempotency_key) WHERE NOT NULL` | Partial index for request-level idempotency |
| `(advertiser_id, timestamp)` | Advertiser-scoped time-range queries |
| `(is_fraudulent, timestamp) WHERE is_fraudulent = true` | Fraud analysis on flagged clicks only |
| `(time_bucket)` on aggregation tables | Time-range aggregation queries |
| `(campaign_id)` on aggregation tables | Campaign-level filtering |
| `(created_at)` on all tables | Retention cleanup queries |

### ClickHouse Schema

Defined in `backend/db/clickhouse-init.sql`.

```sql
-- Raw events with columnar storage
CREATE TABLE click_events (
    click_id String,
    ad_id String,
    campaign_id String,
    advertiser_id String,
    user_id Nullable(String),
    timestamp DateTime64(3),
    device_type LowCardinality(String) DEFAULT 'unknown',
    country LowCardinality(String) DEFAULT 'unknown',
    is_fraudulent UInt8 DEFAULT 0,
    fraud_reason Nullable(String),
    processed_at DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (campaign_id, ad_id, timestamp, click_id)
TTL timestamp + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Auto-aggregation via materialized views
CREATE TABLE click_aggregates_minute (
    time_bucket DateTime,
    ad_id String,
    campaign_id String,
    advertiser_id String,
    country LowCardinality(String),
    device_type LowCardinality(String),
    click_count UInt64,
    unique_users UInt64,
    fraud_count UInt64
) ENGINE = SummingMergeTree((click_count, fraud_count))
PARTITION BY toYYYYMM(time_bucket)
ORDER BY (time_bucket, ad_id, campaign_id, country, device_type)
TTL time_bucket + INTERVAL 7 DAY;

CREATE MATERIALIZED VIEW click_aggregates_minute_mv
TO click_aggregates_minute
AS SELECT
    toStartOfMinute(timestamp) AS time_bucket,
    ad_id, campaign_id, advertiser_id, country, device_type,
    count() AS click_count,
    uniqExact(user_id) AS unique_users,
    countIf(is_fraudulent = 1) AS fraud_count
FROM click_events
GROUP BY time_bucket, ad_id, campaign_id, advertiser_id, country, device_type;

-- Similar tables and views for hour and day granularity
```

## API Design

### Click Ingestion

```
POST /api/v1/clicks
Headers: Idempotency-Key: <optional-uuid>
Body: { ad_id, campaign_id, advertiser_id, device_type, country, ... }
Response: 202 Accepted { click_id, is_duplicate, is_fraudulent }
```

### Analytics Query

```
GET /api/v1/analytics/aggregate
    ?campaign_id=camp_789
    &start_time=2024-01-15T00:00:00Z
    &end_time=2024-01-15T23:59:59Z
    &group_by=hour,country
    &granularity=hour
Response: { data: [...], total_clicks, query_time_ms }
```

### Admin and Monitoring

```
GET  /health              → Service health (database, redis, clickhouse)
GET  /health/ready        → Readiness probe
GET  /health/live         → Liveness probe
GET  /metrics             → Prometheus metrics
GET  /api/v1/admin/stats  → System statistics
```

## Key Design Decisions

### 1. Exactly-Once Semantics via Defense-in-Depth Idempotency

Ad click billing is based on click counts. A 1% duplicate rate on 10M daily clicks means 100K phantom clicks and significant overbilling. We implement three layers of deduplication:

1. **Idempotency-Key header (request level)**: Clients include a unique key per logical request. The key is stored in Redis with the response for 5 minutes. Subsequent requests with the same key return the cached response. This catches load balancer retries and network timeouts.

2. **click_id deduplication (click level)**: Redis SETEX with 5-minute TTL tracks processed click IDs. O(1) lookups in the hot path catch duplicate click IDs from different requests.

3. **PostgreSQL UPSERT (storage level)**: `ON CONFLICT (click_id) DO NOTHING` provides database-level idempotency. This catches edge cases where Redis TTL expires but the click exists in the DB.

**Why three layers:** Each layer covers a different failure mode. Redis covers the common case (fast, distributed). PostgreSQL covers the edge case where Redis TTL expires. The idempotency header covers the case where the same logical request is retried with a new click_id.

### 2. Hybrid PostgreSQL + ClickHouse Storage

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| Business entities | PostgreSQL | Referential integrity, ACID transactions, joins |
| Raw click events | PostgreSQL + ClickHouse | PG for audit/billing disputes, CH for analytics |
| Aggregations | ClickHouse (MVs) | Automatic aggregation, columnar storage, 10-100x faster |

**Why not ClickHouse for everything?** ClickHouse lacks foreign keys, transactions, and UPDATE semantics needed for business entity management. Advertiser account changes need ACID guarantees that ClickHouse cannot provide.

**Why not PostgreSQL for everything?** At 10K writes/sec, PostgreSQL aggregation queries over raw events would require seconds to minutes. ClickHouse's columnar storage and materialized views deliver sub-second aggregations at this scale with 10-100x compression.

### 3. Rule-Based Fraud Detection

**Detection rules:**
- IP velocity: > 100 clicks/minute from same IP hash flags as fraud
- User velocity: > 50 clicks/minute from same user flags as fraud
- Missing device info: clicks without device fingerprint are suspicious
- Regular timing: clicks at exact intervals suggest bot activity

**Why rule-based over ML:** Rule-based detection is deterministic, auditable, and explainable for billing disputes. ML models would improve detection rates but require training data, model serving infrastructure, and are harder to explain to advertisers disputing charges. Rule-based is the right starting point; ML is a future enhancement.

**Key design choice:** Fraudulent clicks are flagged but stored, never discarded. This preserves the audit trail and allows retroactive analysis if fraud rules are tuned.

## Consistency and Idempotency

### Idempotency Flow

```
Client Request
      │
      ▼
┌─────────────────┐     ┌─────────────────┐
│ Check Idempotency│────▶│ Redis: GET      │
│ Key Header       │     │ idempotency:{key}│
└────────┬────────┘     └────────┬────────┘
         │                       │
    (cache miss)            (cache hit)
         │                       │
         ▼                       ▼
┌─────────────────┐     Return cached
│ Check click_id  │     response
│ Redis dedup     │
└────────┬────────┘
         │
    (not duplicate)
         │
         ▼
┌─────────────────┐
│ Process click   │
│ PG + ClickHouse │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Cache response  │
│ in Redis        │
└─────────────────┘
```

### Consistency Guarantees

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Click ingestion | Exactly-once counting | 3-layer dedup (Redis + PG UPSERT + idempotency key) |
| Aggregation updates | Atomic increment | PostgreSQL UPSERT with ON CONFLICT; ClickHouse SummingMergeTree |
| Fraud flagging | Consistent with raw event | Written in same transaction as raw click storage |

## Security

- **IP hashing**: Raw IPs are never stored; SHA-256 hashes used for velocity tracking
- **Input validation**: Zod schemas validate all incoming click payloads
- **Rate limiting**: Per-client rate limits prevent ingestion abuse
- **CORS**: Configured for frontend origin only
- **Idempotency key validation**: Keys are length-limited and sanitized

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `clicks_received_total` | Counter | Total clicks received (pre-dedup) |
| `clicks_processed_total` | Counter | Successfully processed clicks |
| `clicks_deduplicated_total` | Counter | Duplicate clicks caught |
| `clicks_fraud_detected_total` | Counter | Fraudulent clicks flagged |
| `click_ingestion_duration_seconds` | Histogram | Ingestion latency distribution |
| `click_queue_size` | Gauge | Backpressure detection |
| `click_queue_lag_ms` | Gauge | Processing lag (oldest unprocessed) |
| `aggregation_updates_total` | Counter | Aggregation table updates by granularity |
| `aggregation_update_duration_seconds` | Histogram | Aggregation latency |
| `db_query_duration_seconds` | Histogram | Database query latency by operation |
| `db_pool_size` | Gauge | Connection pool utilization |
| `redis_operation_duration_seconds` | Histogram | Redis operation latency |
| `http_requests_total` | Counter | HTTP requests by method/path/status |
| `http_request_duration_seconds` | Histogram | HTTP request latency |

### Health Checks

```
GET /health → { status, services: { database, redis, clickhouse } }
GET /health/ready → readiness probe (all dependencies connected)
GET /health/live → liveness probe (process healthy)
```

### SLI/SLO Targets

| Metric | SLI | SLO Target | Alert Threshold |
|--------|-----|------------|-----------------|
| Ingestion latency | p95 of /api/v1/clicks | < 50ms | > 100ms for 5 min |
| Query latency | p95 of /api/v1/analytics | < 200ms | > 500ms for 5 min |
| Availability | Successful / total requests | 99.9% | < 99% for 5 min |
| Dedup accuracy | Duplicates caught / actual | > 99.9% | Audit weekly |
| Cache hit rate | Redis hits / (hits + misses) | > 95% | < 90% for 15 min |

## Failure Handling

### Redis Failure

**Impact:** Dedup and fraud velocity checks fail. Risk of duplicate counting.

**Mitigation:**
1. PostgreSQL UPSERT provides backup dedup via `ON CONFLICT (click_id) DO NOTHING`
2. Log warning and increment `redis_errors_total` metric
3. Continue ingestion with degraded dedup accuracy
4. On recovery, warm up Redis from recent PostgreSQL click_ids

### PostgreSQL Failure

**Impact:** Raw click storage and entity lookups fail.

**Mitigation:**
1. Return 503 to clients (clicks are retryable with idempotency keys)
2. If Kafka is present, buffer events in the topic for replay after recovery
3. ClickHouse continues receiving events independently

### ClickHouse Failure

**Impact:** Aggregation queries fail; materialized views stop updating.

**Mitigation:**
1. Aggregation queries fall back to PostgreSQL aggregation tables (slower but functional)
2. Raw events continue to PostgreSQL
3. On recovery, ClickHouse materialized views automatically catch up from buffered inserts

### Data Corruption Recovery

If aggregates drift from raw events (detected by reconciliation checks), rebuild aggregates from raw data:
1. Identify affected time range via `SUM(raw)` vs `SUM(aggregate)` comparison
2. Delete affected aggregates
3. Rebuild from raw events using INSERT...SELECT with GROUP BY
4. Verify counts match

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scaling Strategy | Bottleneck |
|-----------|-----------------|------------|
| Collectors | Stateless, add instances behind LB | Network I/O |
| Redis | Redis Cluster, shard by click_id hash | Memory |
| PostgreSQL | Read replicas for analytics; partition click_events by day | Write throughput |
| ClickHouse | ReplicatedMergeTree + sharding by campaign_id | Disk I/O |
| Query Service | Stateless, add instances | ClickHouse query capacity |

### What Breaks First

At 50K clicks/sec, PostgreSQL becomes the bottleneck for raw event writes. Mitigation: partition click_events by day, archive old partitions, consider write-ahead to Kafka with batch inserts.

At 100K clicks/sec, a single Redis instance hits memory limits for dedup keys. Mitigation: Redis Cluster with consistent hashing on click_id.

### Data Lifecycle

```
Raw Clicks ──▶ Hot (7 days, PG) ──▶ Warm (30 days, compressed) ──▶ Cold (1 year, S3 Parquet) ──▶ Delete
                    │
                    ▼
           Aggregates (permanent, ClickHouse MVs)
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Analytics DB | ClickHouse | PostgreSQL only | 10-100x faster OLAP, auto-aggregation via MVs |
| Relational DB | PostgreSQL | ClickHouse for all | ACID for business entities, referential integrity |
| Dedup strategy | Redis + PG UPSERT | Redis only | Defense-in-depth covers Redis TTL expiry edge case |
| Event processing | Synchronous | Kafka + Flink | Simpler; Kafka is the clear next step for >10K RPS |
| Fraud detection | Rule-based | ML model | Deterministic, auditable, explainable for billing disputes |
| Cache | Redis | In-memory | Shared state across collector instances |
| IP privacy | SHA-256 hash | Raw storage | GDPR compliance, sufficient for velocity tracking |

## Implementation Notes

This section maps the production architecture to what actually runs locally with Docker + Node.js + React.

### Local Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Local Machine                               │
│                                                                  │
│  ┌─────────────┐    ┌──────────────────────────────────────┐    │
│  │  Frontend    │    │         Backend (Express)             │    │
│  │  Vite :5173  │───▶│  :3001 (dev) or :3001-3003           │    │
│  │  React +     │    │                                      │    │
│  │  Recharts    │    │  Routes: clicks, analytics, admin     │    │
│  └─────────────┘    └──────────┬───────────┬───────────┬────┘    │
│                                │           │           │         │
│                       ┌────────▼──┐  ┌─────▼─────┐ ┌──▼───────┐ │
│                       │ PostgreSQL│  │   Redis   │ │ClickHouse│ │
│                       │   :5432   │  │   :6379   │ │  :8123   │ │
│                       │ adclick   │  │  (Valkey) │ │  :9000   │ │
│                       └───────────┘  └───────────┘ └──────────┘ │
│                                                                  │
│                       docker-compose up -d                       │
└─────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | File(s) | Description |
|---------|---------|-------------|
| Prometheus metrics (prom-client) | `src/shared/metrics.ts` | 20+ metrics covering ingestion, aggregation, cache, HTTP, and health. Exposed at `GET /metrics`. |
| Structured JSON logging (Pino) | `src/shared/logger.ts` | Request-scoped child loggers with structured fields (clickId, adId, campaignId, durationMs). Pretty-print in dev, JSON in production. |
| Idempotency (3-layer dedup) | `src/routes/clicks.ts`, `src/services/redis.ts`, `src/services/click-ingestion.ts` | Idempotency-Key header + Redis SETEX dedup + PostgreSQL UPSERT. |
| Fraud detection | `src/services/fraud-detection.ts` | IP and user velocity checks via Redis INCR with TTL. |
| Health checks | `src/index.ts` | `/health`, `/health/ready`, `/health/live` endpoints checking PG, Redis, and ClickHouse connectivity. |
| Configurable thresholds | `src/shared/config.ts` | Retention policies, alert thresholds, SLO targets, and idempotency config as typed constants. |
| ClickHouse materialized views | `backend/db/clickhouse-init.sql` | Auto-aggregation at minute, hour, and day granularity using SummingMergeTree. |
| Zod validation | `src/routes/clicks.ts` | Schema validation on all click ingestion payloads. |
| Multi-instance support | `package.json` scripts | `dev:server1` (:3001), `dev:server2` (:3002), `dev:server3` (:3003) for testing distributed behavior. |

### Simplifications from Production Design

| Production Design | Local Substitute | Impact |
|-------------------|-----------------|--------|
| CDN + L7 Load Balancer | Direct HTTP to Express | No TLS termination, no geographic routing |
| Kafka event stream | Synchronous writes | Higher per-request latency; no event replay |
| Redis Cluster (sharded) | Single Valkey instance (:6379) | No sharding; single point of failure |
| PostgreSQL with read replicas | Single PostgreSQL (:5432) | No read scaling; same instance for writes and analytics |
| ClickHouse cluster (ReplicatedMergeTree) | Single ClickHouse (:8123/:9000) | No replication; data loss risk on container restart |
| S3/MinIO for cold storage | Not implemented | No archival pipeline; all data stays in hot storage |
| Prometheus + Grafana dashboards | Metrics endpoint only | Metrics exposed but no scraping or visualization infrastructure |
| OAuth/JWT authentication | No authentication | API is open; no user/advertiser isolation |
| Circuit breakers (Opossum) | Not implemented | No automatic failure isolation for downstream calls |

### What Was Omitted

- **Kafka**: Would sit between collectors and databases, enabling async writes, replay, and backpressure. The clear next scaling step.
- **Stream processing (Flink/Spark)**: For complex aggregations, windowed fraud detection, and late-arriving event handling.
- **Multi-region deployment**: Geographic distribution with per-region collectors and cross-region replication.
- **Data archival pipeline**: S3/Parquet export for cold storage with partition management.
- **ML fraud detection**: Model training pipeline, feature engineering, and real-time scoring.
- **User authentication and authorization**: Advertiser-scoped access control and API key management.
- **Kubernetes/container orchestration**: Auto-scaling, rolling deployments, health-based routing.
- **Grafana dashboards**: Visual monitoring of the Prometheus metrics already being collected.
