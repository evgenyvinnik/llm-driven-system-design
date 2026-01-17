# Ad Click Aggregator - Architecture Design

## System Overview

A real-time analytics system for aggregating ad clicks with fraud detection capabilities. The system handles high-volume click events, deduplicates them for exactly-once semantics, detects fraudulent patterns, and provides real-time analytics through aggregated data.

## Requirements

### Functional Requirements

1. **Click Tracking**: Record every ad click with metadata (ad_id, campaign_id, user_id, timestamp, geo, device)
2. **Real-time Aggregation**: Aggregate clicks by various dimensions (per ad, per campaign, per hour, per geo)
3. **Reporting API**: Query aggregated data for dashboards and billing
4. **Fraud Detection**: Identify and filter suspicious click patterns based on velocity and patterns

### Non-Functional Requirements

- **Scalability**: Design for 10,000 clicks/second (simplified for local dev)
- **Availability**: 99.9% uptime target
- **Latency**: Writes < 10ms, queries < 100ms for aggregations
- **Consistency**: Exactly-once semantics for accurate billing

## Capacity Estimation

For production scale targeting 10,000 clicks/second:

- **Daily Active Users (DAU)**: ~50M
- **Requests per second (RPS)**: 10,000 write, 100 read
- **Storage requirements**: ~430 GB/day raw, ~13 TB/month
- **Bandwidth requirements**: ~5 MB/s inbound

## High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ad Servers    │────▶│  Click API      │────▶│     Redis       │
│ (Click Sources) │     │  (Express)      │     │  (Dedup/Cache)  │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
          ┌─────────────────┐      ┌─────────────────┐
          │   Raw Storage   │      │   Aggregation   │
          │  (PostgreSQL)   │      │   Tables (PG)   │
          └─────────────────┘      └─────────────────┘
                                            │
                                            ▼
                                 ┌─────────────────┐
                                 │  Query Service  │
                                 │  (Analytics)    │
                                 └────────┬────────┘
                                          │
                                          ▼
                                 ┌─────────────────┐
                                 │   Dashboard     │
                                 │   (React)       │
                                 └─────────────────┘
```

### Core Components

1. **Click Collector Service** (Express API)
   - Receives click events via HTTP POST
   - Validates required fields using Zod
   - Enriches with server timestamp
   - Checks for duplicates via Redis
   - Runs fraud detection
   - Stores to database and updates aggregates

2. **Redis Cache Layer**
   - Deduplication: SETEX with 5-minute TTL for click IDs
   - Rate limiting: INCR with expiry for IP/user velocity
   - HyperLogLog: PFADD for unique user counting
   - Real-time counters: HSET for dashboard metrics

3. **PostgreSQL Storage**
   - Raw click events table for debugging/reconciliation
   - Aggregation tables (minute, hour, day granularity)
   - Uses UPSERT for atomic counter updates

4. **Query Service** (Analytics API)
   - Flexible aggregation queries
   - Filtering by campaign, ad, time range
   - Grouping by country, device type

5. **Dashboard** (React + Recharts)
   - Real-time metrics display
   - Time-series charts
   - Campaign analytics
   - Test click generator

## Data Model

### Raw Click Event

```json
{
  "click_id": "uuid-v4",
  "ad_id": "ad_12345",
  "campaign_id": "camp_789",
  "advertiser_id": "adv_456",
  "user_id": "hashed_user_id",
  "timestamp": "2024-01-15T14:30:00.123Z",
  "device_type": "mobile",
  "os": "iOS",
  "browser": "Safari",
  "country": "US",
  "region": "CA",
  "ip_hash": "sha256_of_ip",
  "is_fraudulent": false
}
```

### Database Schema

```sql
-- Raw click events
CREATE TABLE click_events (
    id SERIAL PRIMARY KEY,
    click_id VARCHAR(50) UNIQUE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    advertiser_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(100),
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    device_type VARCHAR(20),
    country VARCHAR(3),
    is_fraudulent BOOLEAN DEFAULT FALSE,
    fraud_reason VARCHAR(255)
);

-- Aggregation tables (minute, hour, day)
CREATE TABLE click_aggregates_hour (
    time_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    ad_id VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(50) NOT NULL,
    country VARCHAR(3),
    device_type VARCHAR(20),
    click_count BIGINT DEFAULT 0,
    unique_users BIGINT DEFAULT 0,
    fraud_count BIGINT DEFAULT 0,
    UNIQUE(time_bucket, ad_id, country, device_type)
);
```

## API Design

### Click Ingestion

```
POST /api/v1/clicks
Content-Type: application/json

{
  "ad_id": "ad_001",
  "campaign_id": "camp_001",
  "advertiser_id": "adv_001",
  "device_type": "mobile",
  "country": "US"
}

Response: 202 Accepted
{
  "success": true,
  "click_id": "uuid",
  "is_duplicate": false,
  "is_fraudulent": false
}
```

### Analytics Query

```
GET /api/v1/analytics/aggregate
  ?campaign_id=camp_789
  &start_time=2024-01-15T00:00:00Z
  &end_time=2024-01-15T23:59:59Z
  &group_by=hour,country
  &granularity=hour

Response:
{
  "data": [...],
  "total_clicks": 2500000,
  "query_time_ms": 45
}
```

## Key Design Decisions

### 1. Exactly-Once Semantics

**Implementation:**
- Click ID generated at source or by collector
- Redis SETEX for deduplication with 5-minute TTL
- PostgreSQL UPSERT for idempotent aggregation updates

### 2. Fraud Detection

**Rule-based detection:**
- IP velocity: > 100 clicks/minute flags as fraud
- User velocity: > 50 clicks/minute flags as fraud
- Suspicious patterns: Missing device info, regular timing

**Implementation:**
- Redis INCR with TTL for velocity tracking
- Fraudulent clicks are flagged but stored for analysis

### 3. Storage Strategy

**PostgreSQL chosen over ClickHouse for:**
- Simpler local development setup
- Familiar SQL interface
- Built-in UPSERT for aggregation updates

**Trade-off:**
- ClickHouse would be 10-20x faster for analytics at scale
- Consider migration path for production

## Technology Stack

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: PostgreSQL 16
- **Caching Layer**: Redis 7
- **Frontend**: React 19 + Vite + TanStack Router + Zustand + Tailwind CSS
- **Charts**: Recharts

## Scalability Considerations

### Horizontal Scaling

- **Collectors**: Stateless, scale behind load balancer
- **PostgreSQL**: Read replicas for analytics queries
- **Redis**: Cluster mode for deduplication at scale

### Future Enhancements

1. **Kafka**: Add for async event processing and higher throughput
2. **ClickHouse**: Migrate aggregations for better analytics performance
3. **Flink/Spark**: Stream processing for complex aggregations

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Database | PostgreSQL | ClickHouse | Simpler setup, UPSERT support |
| Cache | Redis | In-memory | Persistence, distributed ready |
| Processing | Sync | Kafka+Flink | Simpler for learning |
| Frontend | React | Vue | Ecosystem, TanStack Router |

## Monitoring and Observability

**Metrics to track:**
- Ingestion rate (clicks/sec)
- Deduplication rate
- Fraud detection rate
- Query latency (p50/p95/p99)
- Database connection pool utilization

**Health endpoint:**
```
GET /health
{
  "status": "healthy",
  "services": {
    "database": "connected",
    "redis": "connected"
  }
}
```

## Security Considerations

- IP hashing for privacy (never store raw IPs)
- Input validation with Zod schemas
- Rate limiting per client
- CORS configuration for frontend

## Data Lifecycle Policies

### Retention Policies

| Data Type | Hot Storage | Warm Storage | Cold/Archive | Total Retention |
|-----------|-------------|--------------|--------------|-----------------|
| Raw click events | 7 days (PostgreSQL) | 30 days (compressed) | 1 year (S3/MinIO) | 1 year |
| Minute aggregates | 24 hours | N/A | 7 days | 7 days |
| Hourly aggregates | 30 days | 90 days | 1 year | 1 year |
| Daily aggregates | 1 year | 2 years | Indefinite | Indefinite |
| Redis dedup keys | 5 minutes (TTL) | N/A | N/A | 5 minutes |
| Redis rate limit counters | 1 minute (TTL) | N/A | N/A | 1 minute |

### TTL Implementation

**PostgreSQL Partitioning (for raw clicks):**
```sql
-- Create partitioned table by day
CREATE TABLE click_events (
    id SERIAL,
    click_id VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    -- other columns...
) PARTITION BY RANGE (timestamp);

-- Create daily partitions (automate with pg_partman or cron)
CREATE TABLE click_events_2024_01_15 PARTITION OF click_events
    FOR VALUES FROM ('2024-01-15') TO ('2024-01-16');

-- Drop old partitions after archival
DROP TABLE click_events_2024_01_08;  -- 7 days old
```

**Automated Cleanup Script (run daily via cron):**
```bash
#!/bin/bash
# /scripts/cleanup-old-data.sh

# Archive raw clicks older than 7 days to MinIO/S3
psql -c "COPY (SELECT * FROM click_events WHERE timestamp < NOW() - INTERVAL '7 days') TO STDOUT WITH CSV HEADER" \
  | gzip > /tmp/clicks_archive_$(date +%Y%m%d).csv.gz

# Upload to MinIO
mc cp /tmp/clicks_archive_*.csv.gz minio/click-archives/

# Delete old minute aggregates
psql -c "DELETE FROM click_aggregates_minute WHERE time_bucket < NOW() - INTERVAL '7 days';"

# Delete old hourly aggregates
psql -c "DELETE FROM click_aggregates_hour WHERE time_bucket < NOW() - INTERVAL '1 year';"
```

### Archival to Cold Storage

**MinIO/S3 Archive Format:**
```
s3://click-archives/
├── raw/
│   ├── year=2024/
│   │   ├── month=01/
│   │   │   ├── day=15/
│   │   │   │   └── clicks_20240115.parquet.gz
```

**Archive Script (weekly):**
```bash
#!/bin/bash
# Convert CSV archives to Parquet for better compression and query performance
# Requires pyarrow: pip install pyarrow pandas

python3 << 'EOF'
import pandas as pd
from datetime import datetime, timedelta

archive_date = (datetime.now() - timedelta(days=7)).strftime('%Y%m%d')
df = pd.read_csv(f'/tmp/clicks_archive_{archive_date}.csv.gz')
df.to_parquet(f'/tmp/clicks_{archive_date}.parquet', compression='gzip')
EOF

mc cp /tmp/clicks_*.parquet minio/click-archives/raw/year=$(date +%Y)/month=$(date +%m)/
```

### Backfill and Replay Procedures

**Scenario 1: Re-aggregate after bug fix**
```sql
-- Step 1: Clear affected aggregates
DELETE FROM click_aggregates_hour
WHERE time_bucket BETWEEN '2024-01-15 00:00:00' AND '2024-01-15 23:59:59';

-- Step 2: Rebuild from raw events
INSERT INTO click_aggregates_hour (time_bucket, ad_id, campaign_id, country, device_type, click_count, unique_users, fraud_count)
SELECT
    date_trunc('hour', timestamp) as time_bucket,
    ad_id,
    campaign_id,
    country,
    device_type,
    COUNT(*) as click_count,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(*) FILTER (WHERE is_fraudulent) as fraud_count
FROM click_events
WHERE timestamp BETWEEN '2024-01-15 00:00:00' AND '2024-01-15 23:59:59'
GROUP BY date_trunc('hour', timestamp), ad_id, campaign_id, country, device_type
ON CONFLICT (time_bucket, ad_id, country, device_type)
DO UPDATE SET
    click_count = EXCLUDED.click_count,
    unique_users = EXCLUDED.unique_users,
    fraud_count = EXCLUDED.fraud_count;
```

**Scenario 2: Replay from S3 archive (for historical queries)**
```bash
#!/bin/bash
# Download archived data
mc cp minio/click-archives/raw/year=2024/month=01/day=15/clicks_20240115.parquet.gz /tmp/

# Load into temporary table
psql -c "CREATE TEMP TABLE click_events_replay (LIKE click_events);"
# Use COPY with parquet reader or convert to CSV first

# Rebuild aggregates from replay table
psql -f /scripts/rebuild-aggregates.sql
```

**Scenario 3: Redis cache warmup after restart**
```typescript
// Warm up Redis counters from PostgreSQL on service startup
async function warmupRedisCounters(): Promise<void> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Reload recent click IDs for deduplication
  const recentClicks = await db.query(
    'SELECT click_id FROM click_events WHERE timestamp > $1',
    [hourAgo]
  );

  for (const row of recentClicks.rows) {
    await redis.set(`dedup:${row.click_id}`, '1', 'EX', 300);
  }

  // Reload rate limit counters from recent activity
  const rateLimits = await db.query(`
    SELECT ip_hash, COUNT(*) as count
    FROM click_events
    WHERE timestamp > NOW() - INTERVAL '1 minute'
    GROUP BY ip_hash
  `);

  for (const row of rateLimits.rows) {
    await redis.set(`ratelimit:ip:${row.ip_hash}`, row.count, 'EX', 60);
  }
}
```

---

## Deployment and Operations

### Rollout Strategy

**Local Development (2-3 instances):**
```bash
# Start services in sequence
docker-compose up -d postgres redis  # Infrastructure first
sleep 5
npm run db:migrate                    # Apply migrations
npm run dev:server1 &                 # Port 3001
npm run dev:server2 &                 # Port 3002
npm run dev:server3 &                 # Port 3003
```

**Rolling Deployment (zero-downtime):**
1. Health check endpoint must pass before traffic routing
2. Deploy to 1 instance, verify metrics for 5 minutes
3. Continue to remaining instances one at a time
4. Keep 1 old instance running until new deployment is verified

**Deployment Checklist:**
```markdown
- [ ] Run migrations in dry-run mode first
- [ ] Verify Redis connectivity from new code
- [ ] Check that new API endpoints are backward compatible
- [ ] Confirm Prometheus metrics are being scraped
- [ ] Test rollback procedure on staging
```

### Schema Migration Strategy

**Migration File Naming:**
```
backend/src/db/migrations/
├── 001_create_click_events.sql
├── 002_create_aggregation_tables.sql
├── 003_add_fraud_reason_column.sql
├── 004_partition_click_events.sql
```

**Safe Migration Patterns:**

```sql
-- 003_add_fraud_reason_column.sql
-- SAFE: Adding nullable column (no table lock)
ALTER TABLE click_events ADD COLUMN fraud_reason VARCHAR(255);

-- 004_create_index_concurrently.sql
-- SAFE: Concurrent index creation (no blocking)
CREATE INDEX CONCURRENTLY idx_click_events_timestamp
ON click_events (timestamp);

-- UNSAFE patterns to avoid:
-- ALTER TABLE click_events ALTER COLUMN fraud_reason SET NOT NULL;  -- Locks table
-- CREATE INDEX idx_... ON click_events (...);  -- Without CONCURRENTLY
```

**Migration Execution:**
```bash
# Dry run (check SQL syntax and plan)
npm run db:migrate -- --dry-run

# Apply migrations with transaction
npm run db:migrate

# Verify migration success
psql -c "SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5;"
```

### Rollback Runbooks

**Runbook 1: Application Rollback**
```bash
#!/bin/bash
# /runbooks/rollback-application.sh

# Symptoms: High error rates, timeouts after deployment
# Impact: Click ingestion failures, dashboard unavailable

# Step 1: Identify current and previous versions
git log --oneline -5

# Step 2: Revert to previous version
git checkout <previous-commit-sha>
npm install
npm run build

# Step 3: Restart services
pm2 restart all  # or docker-compose up -d --build

# Step 4: Verify health
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health

# Step 5: Monitor for 15 minutes
# Check: ingestion rate, error rate, latency
```

**Runbook 2: Database Migration Rollback**
```bash
#!/bin/bash
# /runbooks/rollback-migration.sh

# Symptoms: Application errors after migration, data inconsistency

# Step 1: Identify the problematic migration
psql -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 3;"

# Step 2: Apply down migration (if exists)
npm run db:migrate:down -- --version=004

# Step 3: If no down migration, manual rollback:
# For 003_add_fraud_reason_column.sql
psql -c "ALTER TABLE click_events DROP COLUMN fraud_reason;"

# Step 4: Remove migration record
psql -c "DELETE FROM schema_migrations WHERE version = '003';"

# Step 5: Verify table structure
psql -c "\d click_events"
```

**Runbook 3: Redis Failure Recovery**
```bash
#!/bin/bash
# /runbooks/redis-recovery.sh

# Symptoms: Duplicate clicks processed, rate limiting not working

# Step 1: Check Redis status
redis-cli ping
redis-cli info | grep connected_clients

# Step 2: If Redis is down, restart
docker-compose restart redis
# or: brew services restart redis

# Step 3: Warmup cache from PostgreSQL
npm run cache:warmup

# Step 4: Verify deduplication is working
# Send same click twice, second should be rejected
curl -X POST http://localhost:3001/api/v1/clicks \
  -H "Content-Type: application/json" \
  -d '{"ad_id":"test","campaign_id":"test","advertiser_id":"test","click_id":"test-123"}'

# Step 5: Monitor duplicate rate metric
# Should return to near-zero within 5 minutes
```

**Runbook 4: Data Corruption Recovery**
```bash
#!/bin/bash
# /runbooks/data-corruption-recovery.sh

# Symptoms: Aggregate counts don't match raw events

# Step 1: Identify affected time range
psql -c "
SELECT date_trunc('hour', timestamp) as hour,
       COUNT(*) as raw_count,
       (SELECT click_count FROM click_aggregates_hour h
        WHERE h.time_bucket = date_trunc('hour', timestamp)) as agg_count
FROM click_events
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY date_trunc('hour', timestamp)
HAVING COUNT(*) != (SELECT click_count FROM click_aggregates_hour h
                    WHERE h.time_bucket = date_trunc('hour', timestamp));
"

# Step 2: Rebuild aggregates for affected hours
psql -f /scripts/rebuild-aggregates.sql

# Step 3: Verify counts match
psql -c "SELECT ... (same query as step 1, should return 0 rows)"
```

---

## Capacity and Cost Guardrails

### Alert Thresholds

**Prometheus Alert Rules (alerts.yml):**
```yaml
groups:
  - name: ad-click-aggregator
    rules:
      # Queue/Processing Lag
      - alert: HighIngestionLatency
        expr: histogram_quantile(0.95, rate(click_ingestion_duration_seconds_bucket[5m])) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Click ingestion p95 latency > 100ms"
          runbook: "/runbooks/high-latency.md"

      - alert: ClickProcessingBacklog
        expr: rate(clicks_received_total[1m]) - rate(clicks_processed_total[1m]) > 100
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Processing falling behind ingestion by >100 clicks/min"

      # Storage Growth
      - alert: DatabaseStorageHigh
        expr: pg_database_size_bytes{datname="ad_clicks"} > 10737418240  # 10GB
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Database size exceeds 10GB - consider archival"

      - alert: DatabaseStorageCritical
        expr: pg_database_size_bytes{datname="ad_clicks"} > 21474836480  # 20GB
        for: 30m
        labels:
          severity: critical
        annotations:
          summary: "Database size exceeds 20GB - archival required"

      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Redis memory usage > 80%"

      # Cache Performance
      - alert: LowCacheHitRate
        expr: rate(redis_keyspace_hits_total[5m]) / (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m])) < 0.9
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Redis cache hit rate below 90%"

      - alert: HighDeduplicationRate
        expr: rate(clicks_deduplicated_total[5m]) / rate(clicks_received_total[5m]) > 0.1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Duplicate click rate > 10% - possible client issue"

      # Fraud Detection
      - alert: HighFraudRate
        expr: rate(clicks_fraud_detected_total[5m]) / rate(clicks_received_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Fraud rate exceeds 5% - investigate traffic sources"

      # Service Health
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate exceeds 1%"

      - alert: DatabaseConnectionPoolExhausted
        expr: pg_stat_activity_count / pg_settings_max_connections > 0.9
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL connection pool > 90% utilized"
```

### SLI/SLO Targets

| Metric | SLI | SLO Target | Alert Threshold |
|--------|-----|------------|-----------------|
| Ingestion Latency | p95 latency of /api/v1/clicks | < 50ms | > 100ms for 5min |
| Query Latency | p95 latency of /api/v1/analytics | < 200ms | > 500ms for 5min |
| Availability | Successful requests / total requests | 99.9% | < 99% for 5min |
| Dedup Accuracy | Duplicate clicks caught / actual duplicates | > 99.9% | N/A (audit weekly) |
| Cache Hit Rate | Redis hits / (hits + misses) | > 95% | < 90% for 15min |

### Resource Limits (Local Development)

**Docker Compose Resource Limits:**
```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '1.0'
    environment:
      - POSTGRES_MAX_CONNECTIONS=50

  redis:
    image: redis:7-alpine
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: '0.5'
    command: redis-server --maxmemory 200mb --maxmemory-policy allkeys-lru

  backend:
    build: ./backend
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
```

### Cost Optimization Guidelines

**Storage Tiering:**
- Hot (PostgreSQL): Keep 7 days of raw data (~3GB at local dev scale)
- Warm (Compressed PG): Keep 30 days compressed (~500MB)
- Cold (MinIO/S3): Archive older data, query only when needed

**Cache Sizing:**
- Redis maxmemory: 200MB for local dev
- Dedup keys: ~100 bytes each, 5-min TTL = ~2M keys max = 200MB
- Rate limit keys: ~50 bytes each, 1-min TTL = negligible

**Query Optimization:**
```sql
-- Use materialized views for expensive dashboard queries
CREATE MATERIALIZED VIEW daily_campaign_summary AS
SELECT
    date_trunc('day', time_bucket) as day,
    campaign_id,
    SUM(click_count) as total_clicks,
    SUM(unique_users) as total_users,
    SUM(fraud_count) as total_fraud
FROM click_aggregates_hour
WHERE time_bucket > NOW() - INTERVAL '30 days'
GROUP BY date_trunc('day', time_bucket), campaign_id;

-- Refresh daily (not on every query)
REFRESH MATERIALIZED VIEW daily_campaign_summary;
```

### Monitoring Dashboard Panels

**Grafana Dashboard (dashboard.json):**
```
Row 1: Health Overview
- Service uptime (all instances)
- Current ingestion rate (clicks/sec)
- Error rate (%)
- Active database connections

Row 2: Performance
- Ingestion latency heatmap (p50/p95/p99)
- Query latency by endpoint
- Redis operations/sec
- Cache hit rate gauge

Row 3: Storage
- Database size over time
- Table sizes breakdown
- Redis memory usage
- Partition count and sizes

Row 4: Business Metrics
- Clicks by campaign (stacked area)
- Fraud detection rate (%)
- Top 10 advertisers by volume
- Geographic distribution
```

---

## Implementation Notes

This section documents the rationale behind key implementation decisions. Understanding the "why" behind these choices is critical for maintaining system correctness, especially for billing-critical analytics.

### Why Idempotency Prevents Duplicate Click Counting

**The Problem:**
In distributed systems, network failures, load balancer retries, and client bugs can cause the same click event to be submitted multiple times. Without proper handling, each submission would:
1. Increment the click counter
2. Update aggregation tables
3. Result in incorrect billing (advertisers charged for phantom clicks)

**The Solution:**
We implement defense-in-depth idempotency at multiple layers:

1. **Idempotency-Key Header (Request Level):**
   - Clients provide a unique key per logical request
   - Key is stored in Redis with the response for 5 minutes
   - Subsequent requests with the same key return the cached response
   - This catches load balancer retries and network timeouts

2. **click_id Deduplication (Click Level):**
   - Redis SETEX with 5-minute TTL tracks processed click IDs
   - Catches duplicate click IDs from different requests
   - Fast O(1) lookups in the hot path

3. **PostgreSQL UPSERT (Storage Level):**
   - `ON CONFLICT (click_id) DO NOTHING` ensures database-level idempotency
   - Catches edge cases where Redis TTL expires but click exists in DB
   - Last line of defense for data integrity

**Why This Matters:**
Ad click billing is typically based on click counts. A 1% duplicate rate on 10M daily clicks = 100K phantom clicks = significant overbilling. Idempotency ensures we charge exactly once per actual user click.

### Why Data Retention Balances Analytics vs Storage Costs

**The Problem:**
Raw click events at 10K/second generate ~430GB/day. Unlimited retention would:
1. Exhaust storage capacity within weeks
2. Degrade query performance as tables grow
3. Increase backup/recovery time
4. Violate data privacy regulations (GDPR requires data minimization)

**The Solution:**
Tiered retention with aggregation-first design:

```
Raw Clicks → Hot (7 days) → Warm (30 days) → Cold (1 year) → Delete
                  ↓
         Aggregates (permanent)
```

| Data Type | Hot Storage | Purpose |
|-----------|-------------|---------|
| Raw clicks | 7 days | Debugging, fraud investigation |
| Minute aggregates | 7 days | Real-time dashboards |
| Hourly aggregates | 1 year | Standard analytics |
| Daily aggregates | 5 years | Historical trends, billing reconciliation |

**Why This Matters:**
- **Analytics:** 99% of queries hit aggregates, not raw data. Hourly/daily granularity suffices for business decisions.
- **Cost:** 7 days of raw data = ~3GB (local dev) vs 430GB x 365 = 157TB/year for full retention.
- **Performance:** Aggregation queries on pre-computed tables are 100-1000x faster than scanning raw events.
- **Compliance:** Limited retention reduces PII exposure window.

### Why Queue Lag Alerts Enable Backpressure Detection

**The Problem:**
In high-throughput ingestion systems, processing can fall behind incoming traffic due to:
1. Database connection pool exhaustion
2. Redis latency spikes
3. CPU saturation
4. Downstream service degradation

Without monitoring, this creates:
- Growing memory usage (unbounded queues)
- Stale real-time metrics (dashboards show old data)
- Eventual OOM crashes or data loss

**The Solution:**
Queue lag metrics with tiered alerting:

```
Prometheus Metrics:
- click_queue_size: Current items waiting to process
- click_queue_lag_ms: Age of oldest unprocessed item
- click_ingestion_duration_seconds: Processing time histogram

Alert Thresholds:
- WARNING: Lag > 1 second, sustained 5 minutes
- CRITICAL: Lag > 5 seconds, sustained 2 minutes
```

**Why This Matters:**
- **Early Warning:** Lag alerts fire before OOM or data loss
- **Backpressure Signals:** Operators can shed load, scale up, or fix root cause
- **SLO Monitoring:** Lag directly impacts "freshness" SLO for real-time dashboards
- **Capacity Planning:** Lag trends reveal when horizontal scaling is needed

### Why Aggregation Metrics Enable Billing Accuracy

**The Problem:**
Advertisers pay per click. Billing disputes arise when:
1. Aggregated counts don't match raw event counts
2. Fraud filtering is applied inconsistently
3. Time zone handling differs between systems
4. Duplicates are counted in some views but not others

**The Solution:**
Comprehensive aggregation metrics with audit trail:

```
Prometheus Metrics:
- aggregation_updates_total{granularity}: Updates by table
- aggregation_update_duration_seconds: Processing time
- aggregation_errors_total: Failed updates

Audit Capabilities:
- All raw clicks stored with timestamps
- Aggregates can be rebuilt from raw data
- Fraud flags preserved in both raw and aggregate tables
```

**Why This Matters:**
- **Reconciliation:** If `SUM(clicks_processed_total)` != `SUM(aggregation_updates_total)`, we have a bug
- **Dispute Resolution:** Can replay raw events to prove billing accuracy
- **Fraud Accounting:** Track legitimate clicks vs filtered fraud separately
- **Latency Monitoring:** Slow aggregation updates = stale billing reports

### Implementation Checklist

| Feature | File(s) | Status |
|---------|---------|--------|
| Idempotency-Key header | `routes/clicks.ts`, `services/redis.ts` | Implemented |
| Redis deduplication | `services/redis.ts`, `services/click-ingestion.ts` | Implemented |
| PostgreSQL UPSERT | `services/click-ingestion.ts` | Implemented |
| Prometheus metrics | `shared/metrics.ts`, `/metrics` endpoint | Implemented |
| Structured JSON logging | `shared/logger.ts`, all services | Implemented |
| Retention configuration | `shared/config.ts` | Implemented |
| Alert thresholds | `shared/config.ts` | Implemented |
| Database migrations | `db/migrate.ts`, `db/migrations/` | Implemented |
| Health check endpoints | `/health`, `/health/ready`, `/health/live` | Implemented |

---

## Future Optimizations

1. Add Kafka for event streaming
2. Implement ML-based fraud detection
3. Add geo-velocity fraud detection (impossible travel)
4. Implement data archival to S3/Parquet
5. Add A/B testing analytics
6. Implement user authentication and authorization
