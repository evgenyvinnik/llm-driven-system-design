# Rate Limiter - Architecture Design

## System Overview

An API rate limiting service to prevent abuse, implementing multiple algorithms for different use cases.

## Requirements

### Functional Requirements

- **Request Counting** - Track number of requests per client/API key
- **Multiple Algorithms** - Support different rate limiting strategies:
  - Fixed Window Counter
  - Sliding Window Counter
  - Sliding Window Log
  - Token Bucket
  - Leaky Bucket
- **Distributed Limiting** - Work across multiple API servers consistently
- **Custom Rules** - Configure different limits per endpoint, user tier, API key
- **Response Headers** - Return remaining quota and reset time to clients

### Non-Functional Requirements

- **Low Latency** - Rate check must add <5ms to request processing
- **High Availability** - Must not become a single point of failure
- **Accuracy** - Limits should be respected within 1-5% tolerance
- **Scalability** - Handle 100K+ requests per second per Redis instance

### Out of Scope

- DDoS protection (layer 3/4 attacks)
- Geographic-based limiting
- Machine learning-based anomaly detection

## Capacity Estimation

### Assumptions
- 100,000 API customers
- 1 million requests per second across all APIs
- Average customer makes 100 requests/second during peak
- 10 API gateway nodes

### Storage Estimates
- Rate limit state per customer: ~100 bytes
- 100,000 customers x 100 bytes = 10 MB
- With sliding window buckets: ~50 MB total

### Latency Budget
- Total API latency target: 100ms
- Rate limiting overhead: <5ms (5% of budget)
- Network round-trip to Redis: ~1ms within same datacenter

## High-Level Architecture

```
┌──────────────┐     ┌───────────────────────────────────────────────────┐
│   Client     │────▶│                  API Gateway                      │
│              │     │  ┌─────────────┐  ┌──────────┐  ┌─────────────┐  │
└──────────────┘     │  │ Auth        │──│  Rate    │──│  Route to   │  │
                     │  │ Middleware  │  │  Limiter │  │  Backend    │  │
                     │  └─────────────┘  └────┬─────┘  └─────────────┘  │
                     └────────────────────────┼──────────────────────────┘
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     │                        │                        │
              ┌──────▼──────┐         ┌───────▼───────┐        ┌───────▼───────┐
              │ API Gateway │         │ API Gateway   │        │ API Gateway   │
              │   Node 1    │         │   Node 2      │        │   Node N      │
              └──────┬──────┘         └───────┬───────┘        └───────┬───────┘
                     │                        │                        │
                     └────────────────────────┼────────────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │   Redis Cluster   │
                                    │  (Rate Counters)  │
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │    PostgreSQL     │
                                    │  (Configuration)  │
                                    └───────────────────┘
```

### Core Components

1. **Rate Limiter Middleware** - Express middleware that intercepts requests
2. **Algorithm Factory** - Creates appropriate rate limiter based on configuration
3. **Redis Client** - Manages distributed state
4. **Metrics Collector** - Tracks performance and usage metrics
5. **Configuration Service** - Loads rules from PostgreSQL (future)

## Data Model

### Redis Keys Structure

```
# Fixed Window
ratelimit:fixed:{identifier}:{window_start}  -> count (integer)

# Sliding Window
ratelimit:sliding:{identifier}:{window_number}  -> count (integer)

# Sliding Log
ratelimit:log:{identifier}  -> sorted set (timestamp -> request_id)

# Token Bucket
ratelimit:token:{identifier}  -> hash {tokens: float, last_refill: timestamp}

# Leaky Bucket
ratelimit:leaky:{identifier}  -> hash {water: float, last_leak: timestamp}

# Metrics
metrics:{minute}  -> hash {total, allowed, denied, latency_sum}
metrics:latencies:{minute}  -> list of latency values
```

### PostgreSQL Schema (Future)

```sql
CREATE TABLE rate_limit_rules (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    endpoint_pattern VARCHAR(255),
    identifier_type VARCHAR(50),
    user_tier       VARCHAR(50),
    algorithm       VARCHAR(50) NOT NULL,
    limit_value     INTEGER NOT NULL,
    window_seconds  INTEGER NOT NULL,
    burst_capacity  INTEGER,
    refill_rate     DECIMAL(10,2),
    leak_rate       DECIMAL(10,2),
    priority        INTEGER DEFAULT 0,
    enabled         BOOLEAN DEFAULT true
);
```

## API Design

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ratelimit/check` | POST | Check rate limit and consume token |
| `/api/ratelimit/state/:id` | GET | Get current state without consuming |
| `/api/ratelimit/reset/:id` | DELETE | Reset rate limit for identifier |
| `/api/ratelimit/batch-check` | POST | Check multiple identifiers |
| `/api/metrics` | GET | Get aggregated metrics |
| `/api/metrics/health` | GET | Health check endpoint |
| `/api/algorithms` | GET | List available algorithms |

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1704067260
X-RateLimit-Algorithm: sliding_window
Retry-After: 60  (only when rate limited)
```

## Key Design Decisions

### Distributed Counting with Redis

All rate limiting state is stored in Redis, which provides:
- Atomic operations (INCR, ZADD)
- Sub-millisecond latency
- Built-in expiration
- Lua scripting for complex atomic operations

### Algorithm Selection

| Algorithm | Accuracy | Memory | Burst Handling | Use Case |
|-----------|----------|--------|----------------|----------|
| Fixed Window | Low | Very Low | Allows 2x at boundary | Simple quotas |
| Sliding Window | ~98% | Low | Smooth | General purpose (default) |
| Sliding Log | 100% | High | Perfect | Exact counting |
| Token Bucket | N/A | Low | Controlled bursts | Traffic shaping |
| Leaky Bucket | N/A | Low | No bursts | Smooth output rate |

### Fail-Open Strategy

When Redis is unavailable, requests are allowed to pass (fail-open) because:
- Rate limiting protects against sustained abuse, not individual requests
- Temporary failures should not block legitimate users
- Aggressive alerting compensates for the risk

## Technology Stack

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: Redis 7 (primary), PostgreSQL 16 (configuration)
- **Caching Layer**: Redis (same as data layer)
- **Frontend**: React 19 + Vite + Tailwind CSS + Zustand

## Scalability Considerations

### Horizontal Scaling

1. **API Servers**: Stateless, scale horizontally behind load balancer
2. **Redis**: Use Redis Cluster for sharding by identifier hash
3. **Local Caching**: Implement in-memory cache with periodic sync for hot paths

### Performance Optimizations

1. **Lua Scripts**: Atomic multi-step operations for Token/Leaky Bucket
2. **Pipelining**: Batch Redis operations where possible
3. **Connection Pooling**: Reuse Redis connections

## Trade-offs and Alternatives

### Trade-off 1: Centralized vs. Local Rate Limiting

**Chose**: Centralized Redis for accuracy
**Trade-off**: Adds 1-2ms latency; Redis becomes critical dependency
**Alternative**: Pure local limiting (faster but limits can be exceeded)

### Trade-off 2: Exact vs. Approximate Counting

**Chose**: Sliding window counter (approximate)
**Trade-off**: ~1-2% error tolerance acceptable for most use cases
**Alternative**: Sliding log for exact counting (10x more memory)

## Monitoring and Observability

### Key Metrics

- `rate_limit_checks_total` - Total checks by result (allowed/denied)
- `rate_limit_latency` - Histogram of check latencies
- `rate_limit_remaining` - Gauge of remaining quota per identifier

### Alerting Rules

- High denial rate (>10% in 5 minutes)
- Rate limiter latency p99 > 10ms
- Redis connection failures

## Security Considerations

- Validate identifiers to prevent injection
- Rate limit the rate limiter API itself
- Use secure Redis connections in production
- Implement IP-based fallback for missing API keys

## Async Queue/Stream for Background Jobs

### Queue Architecture

For background jobs and fanout operations, we use RabbitMQ as the message broker. This handles async workloads without impacting the critical path of rate limit checks.

```
┌─────────────────┐     ┌────────────────┐     ┌──────────────────┐
│  API Gateway    │────▶│   RabbitMQ     │────▶│  Worker Nodes    │
│  (Publishers)   │     │   (Broker)     │     │  (Consumers)     │
└─────────────────┘     └────────────────┘     └──────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
              ┌─────▼─────┐        ┌──────▼──────┐
              │  Metrics  │        │   Audit     │
              │  Queue    │        │   Queue     │
              └───────────┘        └─────────────┘
```

### Queue Types and Purpose

| Queue Name | Purpose | Delivery Semantics | TTL |
|------------|---------|-------------------|-----|
| `ratelimit.metrics.aggregate` | Batch metrics for PostgreSQL | At-least-once | 1 hour |
| `ratelimit.audit.events` | Rate limit decision audit log | At-least-once | 24 hours |
| `ratelimit.rules.sync` | Config change fanout to API nodes | At-most-once | 5 minutes |
| `ratelimit.alerts.trigger` | Threshold breach notifications | At-least-once | 30 minutes |

### Message Schemas

**Metrics Aggregation Message:**
```json
{
  "message_id": "uuid-v4",
  "timestamp": 1704067200,
  "window_minute": "2024-01-01T00:00:00Z",
  "metrics": {
    "total_checks": 15420,
    "allowed": 14893,
    "denied": 527,
    "p50_latency_ms": 0.8,
    "p99_latency_ms": 3.2
  },
  "node_id": "gateway-1"
}
```

**Audit Event Message:**
```json
{
  "message_id": "uuid-v4",
  "idempotency_key": "check:{identifier}:{timestamp_ms}",
  "event_type": "rate_limit_decision",
  "identifier": "api_key_abc123",
  "algorithm": "sliding_window",
  "allowed": false,
  "remaining": 0,
  "limit": 100,
  "timestamp": 1704067200123
}
```

### Delivery Semantics and Backpressure

**At-least-once delivery** for metrics and audit:
- Publisher confirms enabled (`channel.confirmSelect()`)
- Consumer sends ACK only after successful processing
- Dead-letter queue (DLQ) for messages that fail 3 retries

**Backpressure handling:**
- Prefetch limit of 100 messages per consumer
- Queue length alarm at 10,000 messages triggers scaling
- Circuit breaker on queue publish after 5 consecutive failures

### Local Development Setup

```yaml
# docker-compose.yml addition
rabbitmq:
  image: rabbitmq:3.12-management
  ports:
    - "5672:5672"   # AMQP
    - "15672:15672" # Management UI
  environment:
    RABBITMQ_DEFAULT_USER: ratelimit
    RABBITMQ_DEFAULT_PASS: ratelimit_dev
  volumes:
    - rabbitmq_data:/var/lib/rabbitmq
```

**Native installation (macOS):**
```bash
brew install rabbitmq
brew services start rabbitmq
# Create vhost and user
rabbitmqctl add_vhost ratelimit
rabbitmqctl add_user ratelimit ratelimit_dev
rabbitmqctl set_permissions -p ratelimit ratelimit ".*" ".*" ".*"
```

## Failure Handling

### Retry Strategy with Idempotency Keys

All retryable operations use idempotency keys to prevent duplicate processing.

**Idempotency Key Format:**
```
{operation}:{identifier}:{timestamp_bucket}
```

Example: `check:api_key_abc123:1704067200000` (1-second bucket for rate checks)

**Retry Configuration:**
```typescript
const retryConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
  jitterFactor: 0.25  // 25% random jitter
};
```

**Retry Flow:**
1. First attempt fails -> wait 100ms (+ 0-25ms jitter)
2. Second attempt fails -> wait 200ms (+ 0-50ms jitter)
3. Third attempt fails -> wait 400ms (+ 0-100ms jitter)
4. After 3 failures -> fail-open for rate checks, DLQ for async jobs

### Circuit Breaker Pattern

Each external dependency has its own circuit breaker:

| Dependency | Failure Threshold | Recovery Timeout | Half-Open Requests |
|------------|------------------|------------------|-------------------|
| Redis Primary | 5 failures in 30s | 10 seconds | 3 |
| Redis Replica | 10 failures in 60s | 30 seconds | 5 |
| PostgreSQL | 5 failures in 60s | 30 seconds | 2 |
| RabbitMQ | 5 failures in 30s | 15 seconds | 3 |

**Circuit Breaker States:**
```
CLOSED -> (failures exceed threshold) -> OPEN
OPEN -> (recovery timeout) -> HALF_OPEN
HALF_OPEN -> (success) -> CLOSED
HALF_OPEN -> (failure) -> OPEN
```

**Implementation (using opossum library):**
```typescript
import CircuitBreaker from 'opossum';

const redisBreaker = new CircuitBreaker(redisOperation, {
  timeout: 3000,           // 3s operation timeout
  errorThresholdPercentage: 50,
  resetTimeout: 10000,     // 10s before trying again
  volumeThreshold: 5       // Minimum requests before opening
});

redisBreaker.on('open', () => {
  logger.warn('Redis circuit opened - failing open for rate checks');
  metrics.increment('circuit_breaker.redis.open');
});

redisBreaker.fallback(() => ({
  allowed: true,           // Fail-open
  fallback: true,
  remaining: -1,
  resetAt: Date.now() + 60000
}));
```

### Disaster Recovery (Local Development Simulation)

For learning purposes, we simulate multi-region behavior with multiple local instances.

**Simulated Setup:**
```
┌────────────────────────────────────────────────────────────────┐
│ Local Machine                                                  │
│                                                                │
│  "Region A" (Primary)          "Region B" (Replica)           │
│  ┌─────────────────┐           ┌─────────────────┐            │
│  │ Redis :6379     │◀─────────▶│ Redis :6380     │            │
│  │ (Master)        │  Replicate│ (Slave)         │            │
│  └─────────────────┘           └─────────────────┘            │
│  ┌─────────────────┐           ┌─────────────────┐            │
│  │ API :3001       │           │ API :3002       │            │
│  └─────────────────┘           └─────────────────┘            │
│  ┌─────────────────┐           ┌─────────────────┐            │
│  │ PostgreSQL :5432│◀─────────▶│ PG Read :5433   │            │
│  │ (Primary)       │ Streaming │ (Replica)       │            │
│  └─────────────────┘           └─────────────────┘            │
└────────────────────────────────────────────────────────────────┘
```

**Failover Procedure (manual for learning):**
1. Detect primary failure (health check fails 3 times)
2. Promote Redis replica: `redis-cli -p 6380 REPLICAOF NO ONE`
3. Update API config to point to new primary
4. Promote PostgreSQL replica if needed
5. Verify state consistency

**Backup and Restore Testing:**

Redis backup (RDB snapshot):
```bash
# Create backup
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb ./backups/redis-$(date +%Y%m%d).rdb

# Restore (stop Redis first)
cp ./backups/redis-20240101.rdb /var/lib/redis/dump.rdb
redis-server
```

PostgreSQL backup:
```bash
# Backup
pg_dump -h localhost -U ratelimit -d ratelimit_db > ./backups/pg-$(date +%Y%m%d).sql

# Restore
psql -h localhost -U ratelimit -d ratelimit_db < ./backups/pg-20240101.sql
```

**Backup Testing Schedule (for learning):**
- Weekly: Practice Redis failover
- Monthly: Practice full restore from backup
- Document recovery time and any issues encountered

## Data Lifecycle Policies

### Redis TTL Strategy

All rate limit keys have explicit TTLs to prevent unbounded growth.

| Key Pattern | TTL | Rationale |
|-------------|-----|-----------|
| `ratelimit:fixed:*` | 2x window size | Covers full window + buffer |
| `ratelimit:sliding:*` | 2x window size | Covers current + previous window |
| `ratelimit:log:*` | window size + 1 minute | Sliding log entries auto-expire |
| `ratelimit:token:*` | 24 hours | Reset daily inactive buckets |
| `ratelimit:leaky:*` | 24 hours | Reset daily inactive buckets |
| `metrics:*` | 1 hour | Aggregated to PostgreSQL |
| `metrics:latencies:*` | 15 minutes | Short-lived detailed data |

**Implementation:**
```typescript
// Set TTL when writing
await redis.setex(key, ttlSeconds, value);

// For hash keys
await redis.hset(key, field, value);
await redis.expire(key, ttlSeconds);
```

### PostgreSQL Data Retention

| Table | Hot Storage | Warm Storage | Cold Storage | Delete |
|-------|-------------|--------------|--------------|--------|
| `rate_limit_rules` | Indefinite | N/A | N/A | Manual |
| `metrics_hourly` | 7 days | 30 days (compressed) | 1 year | After 1 year |
| `audit_events` | 24 hours | 7 days | 30 days | After 30 days |
| `alert_history` | 7 days | 30 days | 90 days | After 90 days |

**Archival Schema:**
```sql
-- Hot table (current data)
CREATE TABLE metrics_hourly (
    id SERIAL PRIMARY KEY,
    hour_bucket TIMESTAMP NOT NULL,
    identifier VARCHAR(255),
    total_checks BIGINT,
    allowed BIGINT,
    denied BIGINT,
    p50_latency_ms DECIMAL(8,2),
    p99_latency_ms DECIMAL(8,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Warm table (compressed, older data)
CREATE TABLE metrics_hourly_archive (
    id SERIAL PRIMARY KEY,
    hour_bucket TIMESTAMP NOT NULL,
    data JSONB NOT NULL,  -- Compressed aggregates
    created_at TIMESTAMP DEFAULT NOW()
);

-- Partition by month for easier archival
CREATE TABLE audit_events (
    id BIGSERIAL,
    event_time TIMESTAMP NOT NULL,
    identifier VARCHAR(255),
    event_data JSONB
) PARTITION BY RANGE (event_time);

CREATE TABLE audit_events_2024_01 PARTITION OF audit_events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

**Archival Cron Job (runs daily at 3 AM):**
```bash
#!/bin/bash
# archive_old_data.sh

# Archive metrics older than 7 days
psql -c "
INSERT INTO metrics_hourly_archive (hour_bucket, data)
SELECT hour_bucket, jsonb_build_object(
    'total_checks', SUM(total_checks),
    'allowed', SUM(allowed),
    'denied', SUM(denied)
)
FROM metrics_hourly
WHERE hour_bucket < NOW() - INTERVAL '7 days'
GROUP BY hour_bucket;

DELETE FROM metrics_hourly
WHERE hour_bucket < NOW() - INTERVAL '7 days';
"

# Drop partitions older than 30 days
psql -c "DROP TABLE IF EXISTS audit_events_$(date -d '30 days ago' +%Y_%m);"
```

### Cold Storage (MinIO/S3 for Local Dev)

For audit logs and historical metrics beyond warm storage:

```yaml
# docker-compose.yml addition
minio:
  image: minio/minio
  ports:
    - "9000:9000"
    - "9001:9001"
  environment:
    MINIO_ROOT_USER: ratelimit
    MINIO_ROOT_PASSWORD: ratelimit_dev
  command: server /data --console-address ":9001"
  volumes:
    - minio_data:/data
```

**Cold Storage Structure:**
```
s3://ratelimit-archive/
├── metrics/
│   └── year=2024/month=01/metrics-2024-01-01.parquet
├── audit/
│   └── year=2024/month=01/day=01/audit-2024-01-01.jsonl.gz
└── backups/
    ├── redis/
    │   └── dump-2024-01-01.rdb.gz
    └── postgres/
        └── backup-2024-01-01.sql.gz
```

### Backfill and Replay Procedures

**Scenario 1: Replay missed audit events**
```bash
# Identify gap
psql -c "SELECT MIN(event_time), MAX(event_time) FROM audit_events;"

# Replay from RabbitMQ DLQ
# 1. Move messages from DLQ back to main queue
rabbitmqctl eval 'rabbit_amqqueue:move_messages(<<"audit_dlq">>, <<"audit_events">>).'

# 2. Or replay from cold storage
aws s3 cp s3://ratelimit-archive/audit/year=2024/month=01/day=15/ ./replay/
gunzip ./replay/*.gz
# Import via worker script
node scripts/replay-audit.js ./replay/
```

**Scenario 2: Backfill metrics after outage**
```typescript
// scripts/backfill-metrics.ts
async function backfillMetricsFromRedis(startTime: Date, endTime: Date) {
  // Scan Redis for metrics keys in time range
  const keys = await redis.keys(`metrics:${formatMinute(startTime)}*`);

  for (const key of keys) {
    const data = await redis.hgetall(key);
    await insertMetricsToPostgres({
      hour_bucket: parseHourFromKey(key),
      total_checks: parseInt(data.total),
      allowed: parseInt(data.allowed),
      denied: parseInt(data.denied),
      backfilled: true
    });
  }
}
```

**Scenario 3: Restore rate limit state after Redis failure**
```bash
# If Redis data is lost, rate limits reset naturally
# No backfill needed - counters start fresh
# Log the incident for audit purposes

# For token/leaky bucket, you may want to restore from backup
# to preserve accumulated tokens/water levels
redis-cli -p 6379 --rdb ./backups/redis-latest.rdb
```

### Data Cleanup Commands

```bash
# Manual cleanup commands for local development

# Clear all rate limit keys (testing)
redis-cli KEYS "ratelimit:*" | xargs -r redis-cli DEL

# Clear metrics older than 1 hour
redis-cli KEYS "metrics:*" | while read key; do
  if [[ $(redis-cli TTL "$key") -lt 0 ]]; then
    redis-cli DEL "$key"
  fi
done

# Vacuum PostgreSQL after large deletes
psql -c "VACUUM ANALYZE metrics_hourly;"
```

## Future Optimizations

1. **Local Caching**: Hybrid approach with local counters synced periodically
2. **Rule Engine**: Dynamic rules from PostgreSQL with caching
3. **Analytics**: Historical analysis of rate limit patterns
4. **Distributed Tracing**: OpenTelemetry integration
5. **Prometheus Export**: Native Prometheus metrics endpoint
