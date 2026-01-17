# Dashboarding System (Metrics Monitoring) - System Design Interview Answer

## Introduction

"Today I'll design a metrics monitoring and visualization system similar to Datadog or Grafana. This system collects time-series metrics from thousands of servers, stores them efficiently, and provides real-time dashboards and alerting. The interesting challenges here are around high-throughput ingestion, time-series storage, and fast aggregation queries."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core functionality:

1. **Metrics Ingestion**: Collect metrics from agents on servers (CPU, memory, custom app metrics)
2. **Time-Series Storage**: Store billions of data points efficiently
3. **Dashboards**: Real-time visualization with customizable charts
4. **Aggregations**: Support queries like 'avg CPU over last hour, grouped by host'
5. **Alerting**: Trigger notifications when metrics cross thresholds
6. **Retention**: Keep detailed data for 15 days, downsampled data for years

Should I focus on infrastructure metrics, or also include application traces and logs?"

### Non-Functional Requirements

"For a monitoring system:

- **Scale**: 1 million metrics, each reported every 10 seconds = 100K metrics/second
- **Latency**: Ingestion < 50ms, Query < 500ms for last-hour data
- **Availability**: 99.9% - monitoring must be more reliable than what it monitors
- **Durability**: No data loss - metrics are critical for debugging outages
- **Query Patterns**: Range queries (last hour, last day), aggregations, GROUP BY"

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
- Data points per metric per day: 86400 / 10 = 8,640
- Daily raw data: 1M * 8,640 * 24 bytes = 207 GB/day
- 15-day retention: 207 * 15 = ~3 TB

**Downsampled Storage (2-year retention):**
- Hourly rollups: 1M * 24 * 365 * 2 * 24 bytes = ~420 GB
- Much smaller due to aggregation

**Query Load:**
- Dashboard refreshes: 1000 concurrent users, refresh every 10 sec
- Query RPS: 1000 / 10 = 100 QPS
- Each query may scan millions of points (need fast aggregation)"

---

## Step 3: High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Sources                                  │
│  (Servers, Containers, Applications with Metric Agents)             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Push metrics
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Ingestion Layer                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │ Ingestion Node 1│    │ Ingestion Node 2│    │ Ingestion Node N│  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘  │
└───────────┼──────────────────────┼──────────────────────┼───────────┘
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Message Queue (Kafka)                            │
│                Topics: metrics, alerts-evaluation                    │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Write Workers  │    │ Alert Evaluator │    │  Downsampler    │
│  (to TSDB)      │    │                 │    │  (Background)   │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Time-Series Database                              │
│              (InfluxDB / TimescaleDB / VictoriaMetrics)             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Query Layer                                    │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │  Query Node 1   │    │  Query Node 2   │    │  Query Node N   │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API Gateway                                   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
    ┌───────────┐         ┌───────────┐         ┌───────────┐
    │ Dashboard │         │ Alert UI  │         │    API    │
    │    UI     │         │           │         │  Clients  │
    └───────────┘         └───────────┘         └───────────┘
```

---

## Step 4: Data Model

### Metric Data Point

```
{
  "metric_name": "cpu.usage",
  "tags": {
    "host": "server-001",
    "datacenter": "us-west-2",
    "environment": "production"
  },
  "timestamp": 1705334400000,  // Unix milliseconds
  "value": 78.5
}
```

### Time-Series Database Schema (TimescaleDB Example)

```sql
-- Metrics table (hypertable)
CREATE TABLE metrics (
    time        TIMESTAMPTZ NOT NULL,
    metric_id   INTEGER NOT NULL,
    value       DOUBLE PRECISION NOT NULL
);

-- Convert to hypertable (TimescaleDB feature)
SELECT create_hypertable('metrics', 'time',
    chunk_time_interval => INTERVAL '1 day');

-- Metric definitions (metadata)
CREATE TABLE metric_definitions (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    tags        JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, tags)
);

-- Create index for fast lookups
CREATE INDEX idx_metrics_id_time ON metrics (metric_id, time DESC);
CREATE INDEX idx_metric_defs_name ON metric_definitions (name);
CREATE INDEX idx_metric_defs_tags ON metric_definitions USING GIN (tags);
```

### Downsampled Rollups

```sql
-- Hourly rollups
CREATE TABLE metrics_hourly (
    time        TIMESTAMPTZ NOT NULL,
    metric_id   INTEGER NOT NULL,
    min_value   DOUBLE PRECISION,
    max_value   DOUBLE PRECISION,
    avg_value   DOUBLE PRECISION,
    count       INTEGER,
    PRIMARY KEY (metric_id, time)
);

-- Daily rollups
CREATE TABLE metrics_daily (
    time        TIMESTAMPTZ NOT NULL,
    metric_id   INTEGER NOT NULL,
    min_value   DOUBLE PRECISION,
    max_value   DOUBLE PRECISION,
    avg_value   DOUBLE PRECISION,
    count       INTEGER,
    PRIMARY KEY (metric_id, time)
);
```

---

## Step 5: Ingestion Pipeline

### Agent-Side

```python
class MetricAgent:
    def __init__(self, ingestion_endpoint):
        self.endpoint = ingestion_endpoint
        self.buffer = []
        self.batch_size = 100
        self.flush_interval = 10  # seconds

    def record(self, metric_name, value, tags):
        self.buffer.append({
            'name': metric_name,
            'value': value,
            'tags': tags,
            'timestamp': time.time_ns() // 1_000_000  # ms
        })

        if len(self.buffer) >= self.batch_size:
            self.flush()

    def flush(self):
        if not self.buffer:
            return

        # Compress batch for network efficiency
        payload = gzip.compress(json.dumps(self.buffer).encode())

        try:
            requests.post(
                self.endpoint,
                data=payload,
                headers={'Content-Encoding': 'gzip'},
                timeout=5
            )
            self.buffer = []
        except Exception as e:
            # Keep buffer, retry on next flush
            logger.error(f'Metric flush failed: {e}')
```

### Ingestion Node

```python
@app.post('/ingest')
async def ingest_metrics(request: Request):
    # Decompress if gzipped
    body = await request.body()
    if request.headers.get('Content-Encoding') == 'gzip':
        body = gzip.decompress(body)

    metrics = json.loads(body)

    # Validate and enrich
    validated = []
    for metric in metrics:
        if validate_metric(metric):
            metric['metric_id'] = get_or_create_metric_id(
                metric['name'], metric['tags']
            )
            validated.append(metric)

    # Push to Kafka (async, don't wait)
    kafka_producer.send('metrics', validated)

    return {'accepted': len(validated)}
```

### Write Worker

```python
class WriteWorker:
    def __init__(self):
        self.batch = []
        self.batch_size = 10000
        self.flush_interval = 1  # second

    async def run(self):
        async for message in kafka_consumer:
            self.batch.extend(message.value)

            if len(self.batch) >= self.batch_size:
                await self.flush_to_tsdb()

    async def flush_to_tsdb(self):
        if not self.batch:
            return

        # Bulk insert to TimescaleDB
        async with db.pool.acquire() as conn:
            await conn.copy_records_to_table(
                'metrics',
                records=[(m['timestamp'], m['metric_id'], m['value'])
                         for m in self.batch]
            )

        self.batch = []
```

---

## Step 6: Time-Series Database Selection

"Let me compare options:

### Option 1: TimescaleDB (PostgreSQL Extension)

**Pros:**
- SQL interface - familiar, powerful
- Automatic partitioning (hypertables)
- Good compression (90%+ for time-series)
- Built-in continuous aggregates (auto-rollups)
- Can colocate with relational data (dashboards, users)

**Cons:**
- Not as write-optimized as purpose-built TSDBs
- Scaling requires more effort than some alternatives

### Option 2: InfluxDB

**Pros:**
- Purpose-built for time-series
- InfluxQL is intuitive
- Good community, mature product

**Cons:**
- Clustering is enterprise-only
- Schema-on-write can be limiting

### Option 3: VictoriaMetrics

**Pros:**
- Prometheus-compatible
- Excellent compression and performance
- Easy to operate, single binary
- Free clustering

**Cons:**
- Newer, less battle-tested
- PromQL only (no SQL)

### My Choice: TimescaleDB

For this design, I'd choose TimescaleDB because:
1. SQL is powerful for complex dashboards
2. Can store metadata alongside metrics
3. Continuous aggregates handle downsampling automatically
4. PostgreSQL ecosystem (tools, knowledge, extensions)"

---

## Step 7: Query Engine

### Query Types

**1. Simple Time Range:**
```sql
SELECT time, value
FROM metrics
WHERE metric_id = 123
  AND time > NOW() - INTERVAL '1 hour'
ORDER BY time;
```

**2. Aggregation:**
```sql
SELECT time_bucket('5 minutes', time) AS bucket,
       AVG(value) as avg_value,
       MAX(value) as max_value
FROM metrics
WHERE metric_id = 123
  AND time > NOW() - INTERVAL '1 hour'
GROUP BY bucket
ORDER BY bucket;
```

**3. Multi-Metric with Tags:**
```sql
SELECT md.tags->>'host' as host,
       time_bucket('1 minute', m.time) AS bucket,
       AVG(m.value) as avg_cpu
FROM metrics m
JOIN metric_definitions md ON m.metric_id = md.id
WHERE md.name = 'cpu.usage'
  AND md.tags->>'environment' = 'production'
  AND m.time > NOW() - INTERVAL '1 hour'
GROUP BY host, bucket
ORDER BY bucket;
```

### Query Optimization

```python
class QueryOptimizer:
    def select_table(self, time_range):
        """Route to appropriate resolution table"""
        if time_range <= timedelta(hours=6):
            return 'metrics'  # Raw data
        elif time_range <= timedelta(days=7):
            return 'metrics_hourly'  # Hourly rollups
        else:
            return 'metrics_daily'  # Daily rollups

    def add_caching(self, query, time_range):
        """Add result caching for appropriate queries"""
        if time_range.end < datetime.now() - timedelta(hours=1):
            # Historical data won't change, cache heavily
            return CachedQuery(query, ttl=3600)
        else:
            # Recent data, short cache
            return CachedQuery(query, ttl=10)
```

---

## Step 8: Downsampling Pipeline

"Raw data at 10-second intervals is too expensive to keep forever. We downsample older data.

### Continuous Aggregates (TimescaleDB)

```sql
-- Create continuous aggregate for hourly rollups
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    metric_id,
    MIN(value) as min_value,
    MAX(value) as max_value,
    AVG(value) as avg_value,
    COUNT(*) as count
FROM metrics
GROUP BY bucket, metric_id;

-- Refresh policy
SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);
```

### Retention Policy

```sql
-- Drop raw data older than 15 days
SELECT add_retention_policy('metrics', INTERVAL '15 days');

-- Keep hourly for 90 days
SELECT add_retention_policy('metrics_hourly', INTERVAL '90 days');

-- Keep daily for 2 years
SELECT add_retention_policy('metrics_daily', INTERVAL '2 years');
```

### Trade-off

- **Pros**: Massive storage savings (100x compression)
- **Cons**: Lose granularity for old data (can't drill down to seconds for last-month data)
- **Mitigation**: Allow users to request archival if needed before rollup"

---

## Step 9: Alerting System

```
┌─────────────────┐
│  Alert Rules    │
│  (Configured by │
│    Users)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Alert Evaluator │◄─── Metrics Stream (Kafka)
│   (Streaming)   │
└────────┬────────┘
         │
         │ Alert Triggered
         ▼
┌─────────────────┐
│ Alert Manager   │
│ - Deduplication │
│ - Grouping      │
│ - Routing       │
└────────┬────────┘
         │
    ┌────┴────┬────────────┐
    ▼         ▼            ▼
┌───────┐ ┌───────┐  ┌───────────┐
│ Email │ │ Slack │  │ PagerDuty │
└───────┘ └───────┘  └───────────┘
```

### Alert Rule Definition

```yaml
name: High CPU Alert
metric: cpu.usage
condition: avg(value) > 90
window: 5 minutes
tags:
  environment: production
severity: critical
notification:
  - channel: slack
    target: "#ops-alerts"
  - channel: pagerduty
    target: "infrastructure"
```

### Alert Evaluation

```python
class AlertEvaluator:
    def __init__(self):
        self.rules = load_alert_rules()
        self.state = {}  # Track alert state per rule

    async def evaluate(self, metric):
        for rule in self.rules:
            if self.matches(metric, rule):
                window_data = self.get_window(rule.metric_id, rule.window)

                if self.condition_met(window_data, rule):
                    self.fire_alert(rule, metric)
                else:
                    self.resolve_alert(rule)

    def fire_alert(self, rule, metric):
        if rule.id not in self.state or self.state[rule.id] != 'firing':
            # New alert, send notification
            alert_manager.send_alert(Alert(
                rule=rule,
                value=metric['value'],
                fired_at=datetime.now()
            ))
            self.state[rule.id] = 'firing'
```

### Alert Deduplication

"We don't want to spam users with alerts.

```python
class AlertManager:
    def __init__(self):
        self.active_alerts = {}
        self.cooldown = timedelta(minutes=5)

    def send_alert(self, alert):
        key = (alert.rule.id, tuple(alert.tags.items()))

        if key in self.active_alerts:
            last_sent = self.active_alerts[key]
            if datetime.now() - last_sent < self.cooldown:
                return  # Deduplicate

        self.active_alerts[key] = datetime.now()
        self.dispatch(alert)
```"

---

## Step 10: Dashboard System

### Dashboard Data Model

```sql
CREATE TABLE dashboards (
    id          UUID PRIMARY KEY,
    user_id     UUID REFERENCES users(id),
    name        VARCHAR(255) NOT NULL,
    layout      JSONB NOT NULL,  -- Grid layout
    is_public   BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE panels (
    id          UUID PRIMARY KEY,
    dashboard_id UUID REFERENCES dashboards(id),
    title       VARCHAR(255),
    panel_type  VARCHAR(50),  -- line_chart, gauge, table
    query       TEXT NOT NULL,  -- The metric query
    position    JSONB NOT NULL,  -- x, y, width, height
    options     JSONB  -- Chart-specific options
);
```

### Real-Time Dashboard Updates

```javascript
// Frontend: Dashboard component
function Dashboard({ dashboardId }) {
    const [panels, setPanels] = useState([]);

    useEffect(() => {
        // Initial load
        fetchDashboard(dashboardId).then(setPanels);

        // Auto-refresh every 10 seconds
        const interval = setInterval(() => {
            refreshPanelData(panels).then(setPanels);
        }, 10000);

        return () => clearInterval(interval);
    }, [dashboardId]);

    return (
        <DashboardGrid>
            {panels.map(panel => (
                <Panel key={panel.id} {...panel} />
            ))}
        </DashboardGrid>
    );
}
```

### Query Caching for Dashboards

```python
class DashboardQueryCache:
    def __init__(self, redis):
        self.redis = redis

    async def get_panel_data(self, panel):
        cache_key = f"panel:{panel.id}:{hash(panel.query)}"

        # Check cache
        cached = await self.redis.get(cache_key)
        if cached:
            return json.loads(cached)

        # Execute query
        data = await execute_query(panel.query)

        # Cache with short TTL for real-time feel
        await self.redis.setex(cache_key, 10, json.dumps(data))

        return data
```

---

## Step 11: Scalability Considerations

### Ingestion Scaling

```
- Ingestion nodes are stateless, add more behind load balancer
- Kafka partitioned by metric_id for parallelism
- Write workers scale with Kafka partitions
```

### Storage Scaling

```
TimescaleDB Scaling Options:
1. Vertical: Bigger machine (works up to ~10TB)
2. Horizontal: TimescaleDB multi-node (enterprise)
3. Tiered: Hot data on SSD, warm on HDD, cold on S3
```

### Query Scaling

```
- Query nodes are stateless
- Read replicas for query load
- Result caching in Redis
- Pre-aggregation for common queries
```

### Hot Metrics Problem

"What if one metric gets 10x more queries than others?

**Solution:**
1. Identify hot metrics (query frequency tracking)
2. Pre-compute and cache their common aggregations
3. Route hot metric queries to dedicated cache tier"

---

## Step 12: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| TSDB | TimescaleDB | InfluxDB, VictoriaMetrics | SQL power, familiar ecosystem |
| Message Queue | Kafka | RabbitMQ | Higher throughput, replayability |
| Downsampling | Continuous aggregates | Batch jobs | Real-time, automatic |
| Dashboard Protocol | HTTP polling | WebSocket | Simpler, caching-friendly |
| Alert Evaluation | Streaming | Batch | Real-time alerts matter |

---

## Step 13: Monitoring the Monitoring System

"Meta, but important. We need to monitor our monitoring system with a separate, simpler system.

**What to monitor:**
- Ingestion lag (Kafka consumer lag)
- Write latency to TSDB
- Query latency percentiles
- Storage growth rate
- Alert delivery success rate

**How:**
- Use a lightweight, self-hosted solution (Prometheus + Grafana)
- Or a separate cloud service as backup
- Alerting on the monitoring system goes to a different channel"

---

## Summary

"To summarize my dashboarding system design:

1. **Ingestion**: Agents batch metrics, ingestion nodes push to Kafka, write workers bulk-insert to TSDB
2. **Storage**: TimescaleDB with hypertables, automatic downsampling via continuous aggregates
3. **Query**: SQL-based queries with intelligent table selection based on time range
4. **Alerting**: Streaming evaluation from Kafka, deduplication, multi-channel notification
5. **Dashboards**: Configurable panels with auto-refresh and result caching

The key insights are:
- Time-series data has unique patterns (immutable, time-ordered) that specialized storage exploits
- Downsampling is essential for long-term retention without breaking the bank
- Query performance depends heavily on reading from the right resolution table
- Alerting must be real-time and reliable - users depend on it

What would you like me to dive deeper into?"
