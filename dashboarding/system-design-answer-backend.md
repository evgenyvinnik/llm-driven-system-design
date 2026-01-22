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
- 1M unique metrics (combinations of metric_name + tags)
- Report interval: 10 seconds
- Ingestion: 1M / 10 = 100,000 metrics/second
- Each data point: timestamp (8 bytes) + value (8 bytes) + metric_id (8 bytes) = ~24 bytes
- Ingestion bandwidth: 100K * 24 = 2.4 MB/second

**Storage (15-day detailed retention):**
- Data points per metric per day: 86,400 / 10 = 8,640
- Daily raw data: 1M * 8,640 * 24 bytes = 207 GB/day
- 15-day retention: 207 * 15 = ~3 TB

**Downsampled Storage (2-year retention):**
- Hourly rollups: 1M * 24 * 365 * 2 * 24 bytes = ~420 GB
- Much smaller due to aggregation

**Database Connections:**
- Write workers: 10 workers * 10 connections = 100 write connections
- Query nodes: 5 nodes * 20 connections = 100 query connections
- Connection pooling is critical"

---

## Step 3: High-Level Backend Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Sources                                  │
│  (Servers, Containers, Applications with Metric Agents)             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Push metrics (gzip compressed)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Ingestion Layer (Stateless)                      │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │ Ingestion Node 1│    │ Ingestion Node 2│    │ Ingestion Node N│  │
│  │  - Validation   │    │  - Validation   │    │  - Validation   │  │
│  │  - Metric ID    │    │  - Metric ID    │    │  - Metric ID    │  │
│  │    lookup/cache │    │    lookup/cache │    │    lookup/cache │  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘  │
└───────────┼──────────────────────┼──────────────────────┼───────────┘
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   │ Publish to queue
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Message Queue (RabbitMQ)                         │
│                Topics: metrics.ingest, metrics.dlq                   │
│                - Durable queues with disk backing                    │
│                - Dead letter queue for failed messages               │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Write Worker 1 │    │ Alert Evaluator │    │   Downsampler   │
│  - Batch buffer │    │  - Rule engine  │    │  (Continuous    │
│  - COPY insert  │    │  - State track  │    │   Aggregates)   │
│  - Retry logic  │    │  - Dedupe       │    │                 │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TimescaleDB (PostgreSQL)                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │  metrics_raw    │  │  metrics_1min   │  │  metrics_1hour  │      │
│  │  (hypertable)   │  │  (cont. agg)    │  │  (cont. agg)    │      │
│  │  7-day retain   │  │  30-day retain  │  │  1-year retain  │      │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘      │
│  ┌─────────────────┐  ┌─────────────────┐                           │
│  │ metric_defs     │  │ dashboards,     │                           │
│  │ (lookup table)  │  │ panels, alerts  │                           │
│  └─────────────────┘  └─────────────────┘                           │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Query Layer                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │  Query Node 1   │    │  Query Node 2   │    │  Query Node N   │  │
│  │  - Table select │    │  - Table select │    │  - Table select │  │
│  │  - Cache check  │    │  - Cache check  │    │  - Cache check  │  │
│  │  - Circuit break│    │  - Circuit break│    │  - Circuit break│  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Redis (Cache Layer)                              │
│  - Query result cache (TTL: 10s live, 5min historical)              │
│  - Metric ID lookup cache                                            │
│  - Alert state tracking                                              │
│  - Rate limiting counters                                            │
│  - Session storage                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 4: Database Schema Design

### TimescaleDB Hypertable for Raw Metrics

```sql
-- Metric definitions (metadata, cached in Redis)
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

-- Raw metrics hypertable (automatically partitioned by time)
CREATE TABLE metrics_raw (
    time            TIMESTAMPTZ NOT NULL,
    metric_id       INTEGER NOT NULL REFERENCES metric_definitions(id),
    value           DOUBLE PRECISION NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb
);

-- Convert to hypertable with 1-day chunks
SELECT create_hypertable('metrics_raw', 'time',
    chunk_time_interval => INTERVAL '1 day');

-- Critical indexes for query performance
CREATE INDEX idx_metrics_raw_metric_time ON metrics_raw(metric_id, time DESC);
CREATE INDEX idx_metrics_raw_tags ON metrics_raw USING GIN(tags);

-- Enable compression on chunks older than 1 day
ALTER TABLE metrics_raw SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'metric_id',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('metrics_raw', INTERVAL '1 day');
```

### Continuous Aggregates for Downsampling

```sql
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

-- Refresh policy: Update every minute, looking back 1 hour
SELECT add_continuous_aggregate_policy('metrics_1min',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
);

-- 1-hour continuous aggregate (built on 1-min aggregate)
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
```

### Retention Policies

```sql
-- Automatic data cleanup
SELECT add_retention_policy('metrics_raw', INTERVAL '7 days');
SELECT add_retention_policy('metrics_1min', INTERVAL '30 days');
SELECT add_retention_policy('metrics_1hour', INTERVAL '365 days');
```

### Alert Rules Schema

```sql
CREATE TABLE alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    query           TEXT NOT NULL,
    condition       VARCHAR(20) NOT NULL,  -- gt, lt, eq, ne
    threshold       DOUBLE PRECISION NOT NULL,
    duration        INTERVAL NOT NULL DEFAULT '5 minutes',
    severity        VARCHAR(20) DEFAULT 'warning',
    enabled         BOOLEAN DEFAULT true,
    notification    JSONB NOT NULL,  -- {type: 'email'|'webhook', target: '...'}
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE alert_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id),
    status          VARCHAR(20) NOT NULL,  -- firing, resolved
    value           DOUBLE PRECISION,
    triggered_at    TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX idx_alert_events_rule_time ON alert_events(rule_id, triggered_at DESC);
```

---

## Step 5: Ingestion Pipeline

### Metric Agent (Client-Side)

```typescript
// Agent running on each monitored server
class MetricAgent {
  private buffer: MetricPoint[] = [];
  private batchSize = 100;
  private flushIntervalMs = 10000;

  record(name: string, value: number, tags: Record<string, string> = {}): void {
    this.buffer.push({
      name,
      value,
      tags,
      timestamp: Date.now(),
    });

    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.batchSize);

    // Compress payload for network efficiency
    const payload = gzipSync(JSON.stringify(batch));

    try {
      await fetch(this.endpoint, {
        method: 'POST',
        body: payload,
        headers: {
          'Content-Encoding': 'gzip',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      // Re-add to buffer for retry (with limit)
      if (this.buffer.length < this.batchSize * 10) {
        this.buffer.unshift(...batch);
      }
      logger.error('Metric flush failed', { error });
    }
  }
}
```

### Ingestion Node API

```typescript
// POST /api/v1/metrics
async function ingestMetrics(req: Request, res: Response): Promise<void> {
  // Rate limiting check
  const clientIp = req.ip;
  const rateLimitKey = `ratelimit:ingest:${clientIp}`;
  const allowed = await checkRateLimit(rateLimitKey, 10000, 60);

  if (!allowed) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  // Decompress if gzipped
  let body = req.body;
  if (req.headers['content-encoding'] === 'gzip') {
    body = JSON.parse(gunzipSync(req.body).toString());
  }

  // Validate and enrich metrics
  const validated: EnrichedMetric[] = [];
  for (const metric of body) {
    if (!validateMetric(metric)) {
      continue; // Skip invalid metrics, don't fail entire batch
    }

    // Get or create metric_id (cached in Redis)
    const metricId = await getOrCreateMetricId(metric.name, metric.tags);

    validated.push({
      metric_id: metricId,
      value: metric.value,
      timestamp: metric.timestamp || Date.now(),
      tags: metric.tags || {},
    });
  }

  // Publish to RabbitMQ (async, don't wait for DB write)
  await rabbitChannel.publish('metrics.ingest', JSON.stringify(validated));

  // Track ingestion metrics
  ingestPointsCounter.inc(validated.length);

  // Return immediately - processing is async
  res.status(202).json({ accepted: validated.length });
}

// Metric ID lookup with caching
async function getOrCreateMetricId(name: string, tags: Record<string, string>): Promise<number> {
  const cacheKey = `metric:id:${name}`;

  // Check Redis cache first
  const cached = await redis.get(cacheKey);
  if (cached) return parseInt(cached, 10);

  // Check database
  const existing = await pool.query(
    'SELECT id FROM metric_definitions WHERE name = $1',
    [name]
  );

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await redis.setex(cacheKey, 3600, id.toString());
    return id;
  }

  // Create new metric definition
  const result = await pool.query(
    `INSERT INTO metric_definitions (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name]
  );

  const id = result.rows[0].id;
  await redis.setex(cacheKey, 3600, id.toString());
  return id;
}
```

### Write Worker (Batch Consumer)

```typescript
class WriteWorker {
  private batch: EnrichedMetric[] = [];
  private batchSize = 10000;
  private flushIntervalMs = 100;
  private flushTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    // Consume from RabbitMQ
    await rabbitChannel.consume('metrics.ingest', async (msg) => {
      if (!msg) return;

      const metrics: EnrichedMetric[] = JSON.parse(msg.content.toString());
      this.batch.push(...metrics);

      // Batch is full, flush immediately
      if (this.batch.length >= this.batchSize) {
        await this.flush();
      } else if (!this.flushTimer) {
        // Set timer for small batches
        this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
      }

      rabbitChannel.ack(msg);
    });
  }

  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const toWrite = this.batch.splice(0, this.batchSize);

    try {
      // Use COPY for maximum insert performance (10x faster than INSERT)
      await this.bulkInsert(toWrite);
      writeLatencyHistogram.observe(Date.now() - startTime);
    } catch (error) {
      // Send to dead letter queue for manual inspection
      await rabbitChannel.publish('metrics.dlq', JSON.stringify(toWrite));
      logger.error('Write failed, sent to DLQ', { error, count: toWrite.length });
    }
  }

  private async bulkInsert(metrics: EnrichedMetric[]): Promise<void> {
    const client = await pool.connect();

    try {
      // Create writable stream for COPY command
      const copyStream = client.query(copyFrom(
        `COPY metrics_raw (time, metric_id, value, tags) FROM STDIN`
      ));

      for (const m of metrics) {
        const line = `${new Date(m.timestamp).toISOString()}\t${m.metric_id}\t${m.value}\t${JSON.stringify(m.tags)}\n`;
        copyStream.write(line);
      }

      await new Promise<void>((resolve, reject) => {
        copyStream.on('finish', resolve);
        copyStream.on('error', reject);
        copyStream.end();
      });
    } finally {
      client.release();
    }
  }
}
```

---

## Step 6: Query Engine

### Table Selection Based on Time Range

```typescript
interface QueryParams {
  metricName: string;
  tags?: Record<string, string>;
  start: Date;
  end: Date;
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count';
  step?: string; // e.g., '1m', '5m', '1h'
}

function selectTable(start: Date, end: Date): { table: string; resolution: string } {
  const rangeMs = end.getTime() - start.getTime();
  const rangeHours = rangeMs / (1000 * 60 * 60);

  if (rangeHours <= 1) {
    return { table: 'metrics_raw', resolution: '1 second' };
  } else if (rangeHours <= 24) {
    return { table: 'metrics_1min', resolution: '1 minute' };
  } else {
    return { table: 'metrics_1hour', resolution: '1 hour' };
  }
}

async function executeQuery(params: QueryParams): Promise<QueryResult> {
  const { table, resolution } = selectTable(params.start, params.end);

  // Check cache first
  const cacheKey = generateCacheKey(params);
  const cached = await redis.get(cacheKey);
  if (cached) {
    cacheHitsCounter.inc();
    return JSON.parse(cached);
  }
  cacheMissesCounter.inc();

  // Build query based on table type
  let sql: string;
  const queryParams: (string | number | Date)[] = [];

  if (table === 'metrics_raw') {
    sql = `
      SELECT
        time_bucket($1, time) AS bucket,
        ${params.aggregation}(value) AS value
      FROM metrics_raw m
      JOIN metric_definitions md ON m.metric_id = md.id
      WHERE md.name = $2
        AND m.time >= $3
        AND m.time < $4
    `;
    queryParams.push(params.step || '1 minute', params.metricName, params.start, params.end);
  } else {
    // Use pre-aggregated value from continuous aggregate
    const valueColumn = params.aggregation === 'count' ? 'sample_count' : `${params.aggregation}_value`;
    sql = `
      SELECT
        time_bucket($1, bucket) AS bucket,
        ${params.aggregation === 'avg' ? 'AVG' : params.aggregation.toUpperCase()}(${valueColumn}) AS value
      FROM ${table} m
      JOIN metric_definitions md ON m.metric_id = md.id
      WHERE md.name = $2
        AND bucket >= $3
        AND bucket < $4
    `;
    queryParams.push(params.step || resolution, params.metricName, params.start, params.end);
  }

  // Add tag filters if provided
  if (params.tags && Object.keys(params.tags).length > 0) {
    sql += ` AND m.tags @> $${queryParams.length + 1}`;
    queryParams.push(JSON.stringify(params.tags));
  }

  sql += ` GROUP BY bucket ORDER BY bucket`;

  // Execute with circuit breaker protection
  const result = await queryCircuitBreaker.fire(async () => {
    return pool.query(sql, queryParams);
  });

  const data = result.rows.map(row => ({
    time: row.bucket,
    value: parseFloat(row.value),
  }));

  // Cache result
  const isHistorical = params.end < new Date(Date.now() - 60000);
  const ttl = isHistorical ? 300 : 10; // 5 min for historical, 10s for live
  await redis.setex(cacheKey, ttl, JSON.stringify({ data, meta: { table, resolution } }));

  return { data, meta: { table, resolution } };
}
```

### Circuit Breaker for Database Protection

```typescript
import CircuitBreaker from 'opossum';

const queryCircuitBreaker = new CircuitBreaker(async (fn: () => Promise<unknown>) => fn(), {
  timeout: 10000,           // 10 second timeout
  errorThresholdPercentage: 40, // Open after 40% errors
  resetTimeout: 60000,      // Try again after 1 minute
  volumeThreshold: 10,      // Minimum calls before tripping
});

queryCircuitBreaker.on('open', () => {
  logger.warn('Query circuit breaker opened - database under stress');
  circuitBreakerState.set({ state: 'open' });
});

queryCircuitBreaker.on('close', () => {
  logger.info('Query circuit breaker closed - database recovered');
  circuitBreakerState.set({ state: 'closed' });
});

queryCircuitBreaker.fallback(() => {
  return { rows: [], fallback: true };
});
```

---

## Step 7: Alerting Engine

### Alert Evaluator Service

```typescript
class AlertEvaluator {
  private evaluationIntervalMs = 10000; // 10 seconds

  async start(): Promise<void> {
    setInterval(() => this.evaluateAll(), this.evaluationIntervalMs);
  }

  async evaluateAll(): Promise<void> {
    const rules = await pool.query(
      'SELECT * FROM alert_rules WHERE enabled = true'
    );

    for (const rule of rules.rows) {
      await this.evaluateRule(rule);
    }
  }

  async evaluateRule(rule: AlertRule): Promise<void> {
    try {
      // Execute the query for this alert
      const result = await executeQuery({
        metricName: rule.query,
        start: new Date(Date.now() - parseDuration(rule.duration)),
        end: new Date(),
        aggregation: 'avg',
      });

      if (result.data.length === 0) return;

      const latestValue = result.data[result.data.length - 1].value;
      const conditionMet = this.checkCondition(latestValue, rule.condition, rule.threshold);

      // Get current alert state from Redis
      const stateKey = `alert:state:${rule.id}`;
      const currentState = await redis.hgetall(stateKey);

      if (conditionMet) {
        if (!currentState.first_triggered) {
          // First time condition is true - start tracking
          await redis.hset(stateKey, {
            first_triggered: Date.now().toString(),
            current_value: latestValue.toString(),
          });
          await redis.expire(stateKey, 3600);
        } else {
          // Check if duration threshold met
          const triggerTime = parseInt(currentState.first_triggered, 10);
          const durationMs = parseDuration(rule.duration);

          if (Date.now() - triggerTime >= durationMs) {
            await this.fireAlert(rule, latestValue);
          }
        }
      } else {
        // Condition no longer met - resolve if firing
        if (currentState.firing === 'true') {
          await this.resolveAlert(rule);
        }
        await redis.del(stateKey);
      }
    } catch (error) {
      logger.error('Alert evaluation failed', { ruleId: rule.id, error });
      alertEvaluationErrors.inc();
    }
  }

  private checkCondition(value: number, condition: string, threshold: number): boolean {
    switch (condition) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
      case 'eq': return value === threshold;
      case 'ne': return value !== threshold;
      default: return false;
    }
  }

  async fireAlert(rule: AlertRule, value: number): Promise<void> {
    const stateKey = `alert:state:${rule.id}`;
    const currentState = await redis.hgetall(stateKey);

    // Deduplication - don't fire if already firing
    if (currentState.firing === 'true') {
      return;
    }

    // Mark as firing
    await redis.hset(stateKey, { firing: 'true', fired_at: Date.now().toString() });

    // Record alert event
    await pool.query(
      `INSERT INTO alert_events (rule_id, status, value, triggered_at)
       VALUES ($1, 'firing', $2, NOW())`,
      [rule.id, value]
    );

    // Send notification
    await this.sendNotification(rule, value);

    alertsFiringGauge.inc();
    logger.info('Alert fired', { ruleId: rule.id, ruleName: rule.name, value });
  }

  async resolveAlert(rule: AlertRule): Promise<void> {
    // Update alert event
    await pool.query(
      `UPDATE alert_events SET status = 'resolved', resolved_at = NOW()
       WHERE rule_id = $1 AND status = 'firing'`,
      [rule.id]
    );

    // Clear state
    await redis.del(`alert:state:${rule.id}`);

    alertsFiringGauge.dec();
    logger.info('Alert resolved', { ruleId: rule.id, ruleName: rule.name });
  }

  async sendNotification(rule: AlertRule, value: number): Promise<void> {
    const notification = rule.notification;

    if (notification.type === 'email') {
      await emailService.send({
        to: notification.target,
        subject: `[${rule.severity.toUpperCase()}] ${rule.name}`,
        body: `Alert fired: ${rule.name}\nValue: ${value}\nThreshold: ${rule.threshold}`,
      });
    } else if (notification.type === 'webhook') {
      await webhookCircuitBreaker.fire(async () => {
        await fetch(notification.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alert: rule.name,
            severity: rule.severity,
            value,
            threshold: rule.threshold,
            timestamp: new Date().toISOString(),
          }),
        });
      });
    }
  }
}
```

---

## Step 8: Caching Strategy

### Query Result Cache

```typescript
// Redis cache structure
interface CacheConfig {
  // Query results
  'cache:query:{hash}': {
    ttlLive: 10,      // 10 seconds for recent data
    ttlHistorical: 300, // 5 minutes for historical data
  };
  // Metric ID lookup
  'cache:metric:id:{name}': {
    ttl: 3600,        // 1 hour
  };
  // Alert state
  'alert:state:{ruleId}': {
    ttl: 3600,        // 1 hour
  };
}

function generateCacheKey(params: QueryParams): string {
  const normalized = {
    metric: params.metricName,
    start: Math.floor(params.start.getTime() / 10000) * 10000, // Round to 10s
    end: Math.floor(params.end.getTime() / 10000) * 10000,
    agg: params.aggregation,
    step: params.step,
    tags: JSON.stringify(params.tags || {}),
  };

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex')
    .substring(0, 16);

  return `cache:query:${hash}`;
}

async function getOrLoad<T>(
  key: string,
  loader: () => Promise<T>,
  ttl: number
): Promise<T> {
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const result = await loader();
  await redis.setex(key, ttl, JSON.stringify(result));
  return result;
}
```

### Rate Limiting with Sliding Window

```typescript
async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);

  // Remove old entries
  await redis.zremrangebyscore(key, 0, windowStart);

  // Count current entries
  const count = await redis.zcard(key);

  if (count >= limit) {
    return false;
  }

  // Add new entry
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, windowSeconds);

  return true;
}
```

---

## Step 9: Observability

### Prometheus Metrics

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

const register = new Registry();

// Ingestion metrics
const ingestPointsCounter = new Counter({
  name: 'dashboarding_ingest_points_total',
  help: 'Total data points ingested',
  registers: [register],
});

const ingestLatencyHistogram = new Histogram({
  name: 'dashboarding_ingest_latency_seconds',
  help: 'Ingestion API latency',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Query metrics
const queryLatencyHistogram = new Histogram({
  name: 'dashboarding_query_latency_seconds',
  help: 'Query execution latency',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const cacheHitsCounter = new Counter({
  name: 'dashboarding_cache_hits_total',
  help: 'Redis cache hits',
  registers: [register],
});

const cacheMissesCounter = new Counter({
  name: 'dashboarding_cache_misses_total',
  help: 'Redis cache misses',
  registers: [register],
});

// Alert metrics
const alertsFiringGauge = new Gauge({
  name: 'dashboarding_alerts_firing',
  help: 'Number of currently firing alerts',
  registers: [register],
});

// Database metrics
const dbConnectionsGauge = new Gauge({
  name: 'dashboarding_db_connections_active',
  help: 'Active database connections',
  registers: [register],
  collect() {
    this.set(pool.totalCount - pool.idleCount);
  },
});

// Expose /metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});
```

### Health Checks

```typescript
app.get('/health', async (req, res) => {
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
    rabbitmq: await checkRabbitMQ(),
  };

  const allHealthy = Object.values(checks).every(c => c.status === 'up');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'unhealthy',
    version: process.env.npm_package_version,
    uptime: process.uptime(),
    checks,
  });
});

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'up', latency_ms: Date.now() - start };
  } catch (error) {
    return { status: 'down', error: error.message };
  }
}
```

---

## Step 10: Scalability Strategies

### Horizontal Scaling Path

```
1. API Servers (stateless)
   - Add more instances behind load balancer
   - No session affinity needed
   - Scale based on CPU/request count

2. Write Workers
   - Add more RabbitMQ consumers
   - RabbitMQ distributes messages automatically
   - Scale based on queue depth

3. Query Layer
   - Read replicas for query load
   - Route writes to primary, reads to replicas
   - Scale based on query latency

4. TimescaleDB
   - Vertical scaling (more CPU/RAM) up to ~10TB
   - Read replicas for query distribution
   - TimescaleDB multi-node for beyond 10TB

5. Redis
   - Redis Cluster for sharding
   - Sentinel for high availability
```

### Cardinality Management

```typescript
// Prevent high-cardinality tags from degrading performance
async function validateTags(tags: Record<string, string>): Promise<boolean> {
  // Limit tag count per metric
  if (Object.keys(tags).length > 10) {
    return false;
  }

  // Check for known high-cardinality patterns
  const highCardinalityPatterns = ['request_id', 'trace_id', 'uuid', 'timestamp'];
  for (const key of Object.keys(tags)) {
    if (highCardinalityPatterns.some(p => key.includes(p))) {
      logger.warn('High-cardinality tag rejected', { tagKey: key });
      return false;
    }
  }

  return true;
}

// Monitor cardinality per metric
async function checkCardinalityHealth(): Promise<void> {
  const result = await pool.query(`
    SELECT md.name, COUNT(DISTINCT m.tags) as cardinality
    FROM metrics_raw m
    JOIN metric_definitions md ON m.metric_id = md.id
    WHERE m.time > NOW() - INTERVAL '1 hour'
    GROUP BY md.name
    HAVING COUNT(DISTINCT m.tags) > 10000
  `);

  for (const row of result.rows) {
    logger.warn('High cardinality metric detected', {
      metric: row.name,
      cardinality: row.cardinality,
    });
    highCardinalityAlert.fire(row.name, row.cardinality);
  }
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Time-series DB | TimescaleDB | InfluxDB, VictoriaMetrics | SQL power, single DB for all data |
| Message Queue | RabbitMQ | Kafka | Simpler for this scale, DLQ support |
| Downsampling | Continuous aggregates | Batch jobs | Real-time, automatic, no application code |
| Compression | TimescaleDB built-in | External (Zstandard) | Transparent, 10x reduction |
| Alerting | Pull-based evaluation | Push from ingestion | Decoupled, easier to scale |
| Cache | Redis | Memcached | More data structures (sorted sets for rate limiting) |

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
