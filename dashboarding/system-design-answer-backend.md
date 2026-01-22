# Dashboarding System (Metrics Monitoring) - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## Introduction

"Today I'll design a metrics monitoring and visualization system similar to Datadog or Grafana. This system collects time-series metrics from thousands of servers, stores them efficiently, and provides real-time dashboards and alerting. As a backend engineer, I'll focus on the high-throughput ingestion pipeline, time-series database design, query optimization, and the alerting engine."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core backend functionality:

1. **Metrics Ingestion**: High-throughput API accepting metrics from agents
2. **Time-Series Storage**: Store billions of data points with automatic partitioning
3. **Query Engine**: Fast aggregation queries with time bucketing
4. **Downsampling**: Automatic rollups for storage efficiency
5. **Alerting Engine**: Evaluate rules and trigger notifications
6. **Retention Policies**: Automatic cleanup of old data"

### Non-Functional Requirements

"For a monitoring system backend:

- **Ingestion Rate**: 100K metrics/second at production scale
- **Query Latency**: p95 < 500ms for 24-hour ranges
- **Availability**: 99.9% - monitoring must be more reliable than what it monitors
- **Durability**: No data loss - metrics are critical for debugging outages
- **Consistency**: Eventual consistency acceptable (seconds-level lag)"

---

## Step 2: Scale Estimation

"Let me work through the numbers:

**Ingestion Rate:**
- 1M unique metrics, 10s report interval = 100K metrics/second
- Each point: ~24 bytes (timestamp + value + metric_id)
- Bandwidth: ~2.4 MB/second

**Storage (15-day detailed retention):**
- Points per metric per day: 8,640
- Daily raw data: ~207 GB/day, 15 days = ~3 TB

**Downsampled Storage (2-year):**
- Hourly rollups: ~420 GB (much smaller due to aggregation)"

---

## Step 3: High-Level Backend Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│            Data Sources (Servers with Metric Agents)             │
└───────────────────────────┬──────────────────────────────────────┘
                            │ Push metrics (gzip)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Ingestion Layer (Stateless)                      │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│   │ Ingest Node │    │ Ingest Node │    │ Ingest Node │         │
│   │ - Validate  │    │ - Validate  │    │ - Validate  │         │
│   │ - ID lookup │    │ - ID lookup │    │ - ID lookup │         │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
└──────────┼──────────────────┼──────────────────┼─────────────────┘
           └──────────────────┼──────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     RabbitMQ (metrics.ingest, metrics.dlq)       │
└───────────────────────────┬──────────────────────────────────────┘
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
   ┌───────────────┐ ┌─────────────┐ ┌──────────────┐
   │ Write Worker  │ │ Alert Eval  │ │ Downsampler  │
   │ - Batch+COPY  │ │ - Rules     │ │ (Cont. Agg)  │
   └───────┬───────┘ └──────┬──────┘ └──────┬───────┘
           └────────────────┼────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                         TimescaleDB                              │
│  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ metrics_raw  │  │ metrics_1min│  │metrics_1hour│             │
│  │ (hypertable) │  │ (cont. agg) │  │ (cont. agg) │             │
│  └──────────────┘  └─────────────┘  └─────────────┘             │
└───────────────────────────┬──────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                         Query Layer                              │
│  - Table selection by time range                                 │
│  - Cache check, circuit breaker                                  │
└───────────────────────────┬──────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│           Redis (cache, alert state, rate limits)                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 4: Database Schema Design

### TimescaleDB Hypertables

```
┌──────────────────────────────────────────────────────────────────┐
│                    metric_definitions                            │
├──────────────────────────────────────────────────────────────────┤
│  id           │ SERIAL PRIMARY KEY                               │
│  name         │ VARCHAR(255) UNIQUE                              │
│  description  │ TEXT                                             │
│  unit         │ VARCHAR(50)                                      │
│  type         │ 'gauge' | 'counter' | 'histogram'                │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                    metrics_raw (hypertable)                      │
├──────────────────────────────────────────────────────────────────┤
│  time         │ TIMESTAMPTZ NOT NULL                             │
│  metric_id    │ INTEGER FK metric_definitions                    │
│  value        │ DOUBLE PRECISION NOT NULL                        │
│  tags         │ JSONB DEFAULT '{}'                               │
├──────────────────────────────────────────────────────────────────┤
│  Chunk interval: 1 day                                           │
│  INDEX: (metric_id, time DESC)                                   │
│  INDEX: GIN(tags)                                                │
│  Compression: after 1 day, segmentby=metric_id                   │
└──────────────────────────────────────────────────────────────────┘
```

### Continuous Aggregates for Downsampling

```
┌──────────────────────────────────────────────────────────────────┐
│  metrics_1min (continuous aggregate)                             │
│  - bucket, metric_id, tags                                       │
│  - avg_value, min_value, max_value, sample_count                 │
│  - Refresh: every 1 min, looking back 1 hour                     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  metrics_1hour (from metrics_1min)                               │
│  - Same fields, rolled up from minute aggregates                 │
│  - Refresh: every 1 hour, looking back 1 day                     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Retention: raw=7d, 1min=30d, 1hour=365d                         │
└──────────────────────────────────────────────────────────────────┘
```

### Alert Schema

```
┌──────────────────────────────────────────────────────────────────┐
│  alert_rules: id, name, query, condition, threshold, duration,   │
│               severity, enabled, notification {type, target}     │
│  alert_events: id, rule_id, status (firing/resolved), value,     │
│                triggered_at, resolved_at                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 5: Ingestion Pipeline

### Metric Agent (Client-Side)

```
┌──────────────────────────────────────────────────────────────────┐
│                        MetricAgent                               │
│  Buffer → batch when full or timer fires → gzip → POST           │
│  On failure: re-add to buffer if under limit                     │
└──────────────────────────────────────────────────────────────────┘
```

### Ingestion Node Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                   POST /api/v1/metrics                           │
│                                                                  │
│  1. Rate limit check (10K req/60s per IP)                        │
│     └── Exceeded? Return 429                                     │
│  2. Decompress if gzipped                                        │
│  3. Validate & enrich each metric:                               │
│     └── Get/create metric_id (Redis → DB)                        │
│  4. Publish to RabbitMQ (async)                                  │
│  5. Return 202 Accepted                                          │
└──────────────────────────────────────────────────────────────────┘
```

### Metric ID Caching

```
┌──────────────────────────────────────────────────────────────────┐
│              getOrCreateMetricId(name)                           │
│                                                                  │
│  1. Check Redis cache → hit? return                              │
│  2. Query PostgreSQL → found? cache 1hr, return                  │
│  3. INSERT ON CONFLICT → cache 1hr, return                       │
└──────────────────────────────────────────────────────────────────┘
```

### Write Worker (Batch Consumer)

```
┌──────────────────────────────────────────────────────────────────┐
│                        WriteWorker                               │
│                                                                  │
│  Accumulate messages until batch=10K or 100ms timer              │
│                                                                  │
│  flush():                                                        │
│  └── COPY metrics_raw FROM STDIN (10x faster than INSERT)        │
│  └── On error: send to DLQ                                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Query Engine

### Table Selection

```
┌──────────────────────────────────────────────────────────────────┐
│  Time Range      │ Table           │ Resolution                  │
├──────────────────┼─────────────────┼─────────────────────────────┤
│  <= 1 hour       │ metrics_raw     │ 1 second                    │
│  <= 24 hours     │ metrics_1min    │ 1 minute                    │
│  > 24 hours      │ metrics_1hour   │ 1 hour                      │
└──────────────────────────────────────────────────────────────────┘
```

### Query Execution Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                   executeQuery(params)                           │
│                                                                  │
│  1. Select table based on time range                             │
│  2. Check cache (SHA256 of normalized params)                    │
│  3. Build SQL: time_bucket + aggregation + tag filter            │
│  4. Execute with circuit breaker                                 │
│  5. Cache: 10s for live, 5min for historical                     │
│  6. Return { data, meta: { table, resolution } }                 │
└──────────────────────────────────────────────────────────────────┘
```

### Circuit Breaker

```
┌──────────────────────────────────────────────────────────────────┐
│  Config: 10s timeout, 40% error threshold, 60s reset             │
│                                                                  │
│  CLOSED ──(40% errors)──▶ OPEN ──(60s)──▶ HALF-OPEN             │
│    ▲                                           │                 │
│    └──────────(success)────────────────────────┘                 │
│                                                                  │
│  Fallback: return { rows: [], fallback: true }                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Alerting Engine

### Alert Evaluator (Every 10 seconds)

```
┌──────────────────────────────────────────────────────────────────┐
│  For each enabled rule:                                          │
│  1. Query over rule.duration window                              │
│  2. Check condition (gt/lt/eq/ne/gte/lte)                        │
│  3. Get state from Redis: alert:state:{rule.id}                  │
│                                                                  │
│  If condition met:                                               │
│  └── First time? Set first_triggered                             │
│  └── Duration exceeded? fireAlert()                              │
│                                                                  │
│  If condition NOT met:                                           │
│  └── Was firing? resolveAlert(), clear state                     │
└──────────────────────────────────────────────────────────────────┘
```

### Alert Firing

```
┌──────────────────────────────────────────────────────────────────┐
│  fireAlert(rule, value):                                         │
│  1. Check Redis - if already firing, return (dedupe)             │
│  2. Mark firing in Redis                                         │
│  3. Insert alert_events record                                   │
│  4. Send notification (email/webhook with circuit breaker)       │
│                                                                  │
│  resolveAlert(rule):                                             │
│  1. Update alert_events: status='resolved'                       │
│  2. Delete Redis state                                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Caching Strategy

### Cache Configuration

```
┌─────────────────────────┬────────┬─────────────────────────────┐
│ Cache Key Pattern       │ TTL    │ Use Case                    │
├─────────────────────────┼────────┼─────────────────────────────┤
│ cache:query:{hash}      │ 10s    │ Live/recent data queries    │
│ cache:query:{hash}      │ 5min   │ Historical data queries     │
│ cache:metric:id:{name}  │ 1hr    │ Metric ID lookups           │
│ alert:state:{ruleId}    │ 1hr    │ Alert state tracking        │
└─────────────────────────┴────────┴─────────────────────────────┘

Historical detection: params.end < (now - 60 seconds)
```

### Rate Limiting (Sliding Window)

```
┌──────────────────────────────────────────────────────────────────┐
│  Using Redis sorted set for O(log N) operations:                 │
│  1. ZREMRANGEBYSCORE (remove old entries)                        │
│  2. ZCARD (count current)                                        │
│  3. If count >= limit: reject                                    │
│  4. ZADD + EXPIRE                                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 9: Observability

### Prometheus Metrics

```
┌──────────────────────────────────────────────────────────────────┐
│  Ingestion:                                                      │
│  ├── dashboarding_ingest_points_total (Counter)                  │
│  └── dashboarding_ingest_latency_seconds (Histogram)             │
│                                                                  │
│  Query:                                                          │
│  ├── dashboarding_query_latency_seconds (Histogram)              │
│  ├── dashboarding_cache_hits_total (Counter)                     │
│  └── dashboarding_cache_misses_total (Counter)                   │
│                                                                  │
│  Alerting: dashboarding_alerts_firing (Gauge)                    │
│  Database: dashboarding_db_connections_active (Gauge)            │
└──────────────────────────────────────────────────────────────────┘
```

### Health Checks

```
┌──────────────────────────────────────────────────────────────────┐
│  GET /health                                                     │
│  { status, version, uptime, checks: { db, redis, rabbitmq } }    │
│  HTTP 200 if healthy, 503 if any down                            │
└──────────────────────────────────────────────────────────────────┘
```

---

## Step 10: Scalability Strategies

### Horizontal Scaling

```
┌──────────────────────────────────────────────────────────────────┐
│  1. API Servers: stateless, scale on CPU/requests                │
│  2. Write Workers: add RabbitMQ consumers, scale on queue depth  │
│  3. Query Layer: read replicas, route reads to replicas          │
│  4. TimescaleDB: vertical to ~10TB, then multi-node              │
│  5. Redis: Cluster for sharding, Sentinel for HA                 │
└──────────────────────────────────────────────────────────────────┘
```

### Cardinality Protection

```
┌──────────────────────────────────────────────────────────────────┐
│  validateTags(tags):                                             │
│  - Reject if > 10 tag keys                                       │
│  - Reject high-cardinality patterns: request_id, trace_id, uuid │
│                                                                  │
│  Periodic health check: query for metrics with >10K tag combos   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Time-series DB | TimescaleDB | InfluxDB, VictoriaMetrics | SQL power, single DB for all data |
| Message Queue | RabbitMQ | Kafka | Simpler for this scale, DLQ support |
| Downsampling | Continuous aggregates | Batch jobs | Real-time, automatic, no app code |
| Compression | TimescaleDB built-in | External | Transparent, 10x reduction |
| Alerting | Pull-based evaluation | Push from ingestion | Decoupled, easier to scale |
| Cache | Redis | Memcached | More data structures (sorted sets) |

---

## Summary

"To summarize the backend architecture for this dashboarding system:

1. **Ingestion Pipeline**: Agents batch metrics, API validates and publishes to RabbitMQ, write workers use COPY for bulk inserts

2. **Storage**: TimescaleDB hypertables with automatic partitioning, compression, and continuous aggregates for downsampling

3. **Query Engine**: Intelligent table selection based on time range, circuit breaker protection, aggressive caching

4. **Alerting**: Pull-based evaluation every 10 seconds, deduplication in Redis, multi-channel notification with circuit breaker

5. **Observability**: Prometheus metrics, structured logging, comprehensive health checks

The key backend insights are:
- COPY is 10x faster than INSERT for bulk time-series data
- Continuous aggregates eliminate application-level rollup code
- Circuit breakers prevent cascade failures from slow queries
- Metric ID caching reduces database lookups during high-throughput ingestion

What aspect would you like me to elaborate on?"
