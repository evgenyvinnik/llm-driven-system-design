# Health Data Pipeline - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design a health data pipeline like Apple Health, which collects metrics from multiple devices, deduplicates overlapping data, and generates actionable health insights while maintaining strict privacy. The key challenges are handling data from diverse sources with different formats, accurately deduplicating overlapping measurements from multiple devices, and protecting highly sensitive health information.

From a backend perspective, the core technical challenges are building a priority-based deduplication algorithm that handles overlapping time ranges, implementing efficient time-series storage with TimescaleDB hypertables, designing idempotent ingestion for unreliable mobile networks, and ensuring HIPAA-compliant data retention policies."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Ingest**: Collect data from multiple devices (Apple Watch, iPhone, third-party)
- **Process**: Aggregate, deduplicate, normalize data
- **Store**: Persist with encryption in time-series database
- **Query**: Fast access to historical data
- **Share**: Controlled data sharing with providers

### Non-Functional Requirements
- **Privacy**: All data encrypted, minimal exposure, HIPAA compliance
- **Reliability**: Zero data loss, idempotent ingestion
- **Latency**: < 1 second for recent data queries
- **Durability**: 7-year retention for health records

### Scale Estimates
- Millions of users with health data
- Each user has 2-5 devices syncing data
- ~1,500 samples per day per user (heart rate at 1/min = 1,440)
- Years of historical data per user
- Write-heavy workload: 90% writes, 10% reads

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                      Data Sources                          |
|   Apple Watch | iPhone | Third-Party (scales, BP, etc.)   |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                  Ingestion Service (REST API)              |
|    Validation | Normalization | Idempotency Check          |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|              Message Queue (RabbitMQ)                      |
|      health-aggregation | health-insights queues           |
+----------------------------------------------------------+
                           |
          +----------------+----------------+
          v                                 v
+-------------------+             +-------------------+
| Aggregation Worker|             |  Insights Worker  |
| - Deduplication   |             | - Trend Detection |
| - Time Bucketing  |             | - Alert Generation|
+-------------------+             +-------------------+
          |                                 |
          v                                 v
+----------------------------------------------------------+
|                     Storage Layer                          |
|    TimescaleDB (hypertables) | Valkey (cache, sessions)    |
|              MinIO (exports, archives)                     |
+----------------------------------------------------------+
```

### Core Backend Components
1. **Ingestion Service** - Validates, normalizes, and inserts samples with idempotency
2. **Aggregation Worker** - Consumes queue, deduplicates, and computes aggregates
3. **Insights Worker** - Analyzes aggregates for trends and alerts
4. **Query API** - Serves samples, aggregates, and summaries with caching

## Deep Dive: Database Schema (8 minutes)

### TimescaleDB Hypertables

TimescaleDB provides automatic time-based partitioning for efficient range queries on health data.

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Device registry with priority ranking
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type VARCHAR(50) NOT NULL,
  device_name VARCHAR(100),
  device_identifier VARCHAR(255),
  priority INTEGER DEFAULT 50,  -- Higher = preferred for deduplication
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_identifier)
);

-- Priority values: apple_watch=100, iphone=80, ipad=70,
-- third_party_wearable=50, third_party_scale=40, manual_entry=10

-- Raw health samples (converted to hypertable)
CREATE TABLE health_samples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  value DOUBLE PRECISION,
  unit VARCHAR(20),
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  source_device VARCHAR(50),
  source_device_id UUID REFERENCES user_devices(id),
  source_app VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('health_samples', 'start_date', if_not_exists => TRUE);

-- Indexes for common query patterns
CREATE INDEX idx_samples_user_type ON health_samples(user_id, type, start_date DESC);
CREATE INDEX idx_samples_device ON health_samples(source_device_id);
CREATE INDEX idx_samples_type_date ON health_samples(type, start_date DESC);
```

### Pre-Computed Aggregates

```sql
-- Aggregated data (also a hypertable)
CREATE TABLE health_aggregates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  period VARCHAR(10) NOT NULL,  -- 'hour', 'day', 'week', 'month'
  period_start TIMESTAMP NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  sample_count INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, type, period, period_start)
);

SELECT create_hypertable('health_aggregates', 'period_start', if_not_exists => TRUE);
CREATE INDEX idx_aggregates_user_type ON health_aggregates(user_id, type, period, period_start DESC);

-- Insights generated from aggregates
CREATE TABLE health_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20),
  direction VARCHAR(20),
  message TEXT,
  recommendation TEXT,
  data JSONB,
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_insights_user ON health_insights(user_id, created_at DESC);
CREATE INDEX idx_insights_unread ON health_insights(user_id, acknowledged)
  WHERE acknowledged = false;
```

### Compression Policy

```sql
-- Compress chunks older than 90 days (TimescaleDB feature)
SELECT add_compression_policy('health_samples', INTERVAL '90 days');
SELECT add_compression_policy('health_aggregates', INTERVAL '90 days');

-- Compression ratio: ~10:1 for numeric health data
-- Query latency increases from ~5ms to ~50ms for compressed chunks
```

## Deep Dive: Ingestion with Idempotency (8 minutes)

### Device Sync Endpoint

```javascript
// POST /api/v1/devices/:deviceId/sync
router.post('/devices/:deviceId/sync', async (req, res) => {
  const { deviceId } = req.params;
  const { samples } = req.body;
  const userId = req.session.userId;

  // Check idempotency key (from header or generate from content)
  const idempotencyKey = req.headers['x-idempotency-key'] ||
    generateIdempotencyKey(userId, deviceId, samples);

  const cached = await checkIdempotencyKey(idempotencyKey);
  if (cached) {
    return res.json(cached.response);
  }

  // Process sync
  const result = await deviceSyncService.syncFromDevice(userId, deviceId, samples);

  // Cache response for 24 hours
  await storeIdempotencyResponse(idempotencyKey, userId, result);

  res.json(result);
});

function generateIdempotencyKey(userId, deviceId, samples) {
  const hash = crypto.createHash('sha256');
  hash.update(userId + deviceId + JSON.stringify(samples));
  return hash.digest('hex');
}
```

### Batch Insert with UPSERT

```javascript
class DeviceSyncService {
  async syncFromDevice(userId, deviceId, samples) {
    const validSamples = [];
    const errors = [];

    // Validate and normalize each sample
    for (const sample of samples) {
      try {
        const healthSample = new HealthSample({
          ...sample,
          userId,
          sourceDevice: deviceId
        });
        healthSample.validate();
        validSamples.push(healthSample);
      } catch (error) {
        errors.push({ sample, error: error.message });
      }
    }

    // Batch insert with conflict handling
    if (validSamples.length > 0) {
      await this.batchInsert(validSamples);
    }

    // Queue for aggregation processing
    await this.queue.publish('health-aggregation', {
      userId,
      sampleTypes: [...new Set(validSamples.map(s => s.type))],
      dateRange: this.getDateRange(validSamples)
    });

    return {
      synced: validSamples.length,
      errors: errors.length,
      errorDetails: errors
    };
  }

  async batchInsert(samples) {
    const values = samples.map(s => [
      s.id, s.userId, s.type, s.value, s.unit,
      s.startDate, s.endDate, s.sourceDevice, s.sourceApp,
      JSON.stringify(s.metadata)
    ]);

    // UPSERT handles duplicate sample IDs from retries
    await db.query(`
      INSERT INTO health_samples
        (id, user_id, type, value, unit, start_date, end_date,
         source_device, source_app, metadata)
      VALUES ${this.buildPlaceholders(values)}
      ON CONFLICT (id) DO NOTHING
    `, values.flat());
  }
}
```

### Idempotency Key Table

```sql
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash VARCHAR(64) NOT NULL,
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_idempotency_user ON idempotency_keys(user_id);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- Cleanup job runs daily
DELETE FROM idempotency_keys WHERE expires_at < NOW();
```

## Deep Dive: Deduplication Algorithm (8 minutes)

### Priority-Based Overlap Resolution

When the same metric comes from multiple devices (steps from Apple Watch and iPhone), we must deduplicate to avoid double-counting.

```javascript
class AggregationPipeline {
  constructor() {
    // Device priority (higher = more trusted sensors)
    this.devicePriority = {
      'apple_watch': 100,
      'iphone': 80,
      'ipad': 70,
      'third_party_wearable': 50,
      'third_party_scale': 40,
      'manual_entry': 10
    };
  }

  async deduplicateSamples(samples, type) {
    // Sort by priority (highest first)
    const sorted = samples.sort((a, b) =>
      this.getDevicePriority(b.sourceDevice) -
      this.getDevicePriority(a.sourceDevice)
    );

    const result = [];
    const coveredRanges = [];  // Already accounted time ranges

    for (const sample of sorted) {
      const overlap = this.findOverlap(
        sample.startDate,
        sample.endDate,
        coveredRanges
      );

      if (!overlap) {
        // No overlap - include full sample
        result.push(sample);
        coveredRanges.push({ start: sample.startDate, end: sample.endDate });
      } else if (overlap.partial) {
        // Partial overlap - adjust sample proportionally
        const adjusted = this.adjustForOverlap(sample, overlap, type);
        if (adjusted) {
          result.push(adjusted);
          coveredRanges.push({ start: adjusted.startDate, end: adjusted.endDate });
        }
      }
      // Full overlap: skip (higher priority already covers this time)
    }

    return result;
  }

  findOverlap(start, end, coveredRanges) {
    for (const range of coveredRanges) {
      if (start < range.end && end > range.start) {
        const overlapStart = Math.max(start, range.start);
        const overlapEnd = Math.min(end, range.end);

        if (overlapStart === start && overlapEnd === end) {
          return { full: true };  // Completely covered
        }

        return {
          partial: true,
          overlapStart,
          overlapEnd
        };
      }
    }
    return null;
  }

  adjustForOverlap(sample, overlap, type) {
    const config = HealthDataTypes[type];
    const totalDuration = sample.endDate - sample.startDate;
    const overlapDuration = overlap.overlapEnd - overlap.overlapStart;
    const remainingDuration = totalDuration - overlapDuration;

    if (remainingDuration <= 0) return null;

    // For sum-based metrics (steps, calories), adjust value proportionally
    if (config.aggregation === 'sum') {
      const ratio = remainingDuration / totalDuration;
      return {
        ...sample,
        value: sample.value * ratio,
        startDate: overlap.overlapEnd > sample.startDate
          ? sample.startDate : overlap.overlapEnd,
        endDate: overlap.overlapStart < sample.endDate
          ? sample.endDate : overlap.overlapStart
      };
    }

    return sample;  // For averages, keep full value
  }
}
```

### Aggregation Strategies by Metric Type

```javascript
// Configuration for each health data type
const HealthDataTypes = {
  STEPS: { unit: 'count', aggregation: 'sum' },
  DISTANCE: { unit: 'meters', aggregation: 'sum' },
  HEART_RATE: { unit: 'bpm', aggregation: 'average' },
  RESTING_HEART_RATE: { unit: 'bpm', aggregation: 'average' },
  WEIGHT: { unit: 'kg', aggregation: 'latest' },
  BODY_FAT: { unit: 'percent', aggregation: 'latest' },
  SLEEP_ANALYSIS: { unit: 'minutes', aggregation: 'sum' },
  ACTIVE_ENERGY: { unit: 'kcal', aggregation: 'sum' },
  BLOOD_GLUCOSE: { unit: 'mg/dL', aggregation: 'average' },
  OXYGEN_SATURATION: { unit: 'percent', aggregation: 'average' }
};

function aggregate(values, type) {
  switch (type) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'average':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'latest':
      return values[values.length - 1];
    default:
      return values[0];
  }
}
```

### Store Aggregates with UPSERT

```javascript
async storeAggregates(userId, type, aggregates, period) {
  for (const agg of aggregates) {
    await db.query(`
      INSERT INTO health_aggregates
        (user_id, type, period, period_start, value, min_value, max_value, sample_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, type, period, period_start)
      DO UPDATE SET
        value = EXCLUDED.value,
        min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value,
        sample_count = EXCLUDED.sample_count,
        updated_at = NOW()
    `, [
      userId, type, period, agg.periodStart,
      agg.value, agg.minValue, agg.maxValue, agg.sampleCount
    ]);
  }
}
```

## Deep Dive: Insights Engine (5 minutes)

### Trend Detection with Linear Regression

```javascript
class InsightsEngine {
  async analyzeHeartRate(userId) {
    // Get 30 days of resting heart rate
    const data = await db.query(`
      SELECT period_start, value
      FROM health_aggregates
      WHERE user_id = $1
        AND type = 'RESTING_HEART_RATE'
        AND period = 'day'
        AND period_start >= NOW() - INTERVAL '30 days'
      ORDER BY period_start
    `, [userId]);

    if (data.rows.length < 7) return null;

    const values = data.rows.map(r => r.value);
    const trend = this.calculateTrend(values);

    if (Math.abs(trend.slope) > 0.5) {
      return {
        type: 'HEART_RATE_TREND',
        direction: trend.slope > 0 ? 'increasing' : 'decreasing',
        magnitude: Math.abs(trend.slope),
        message: trend.slope > 0
          ? 'Your resting heart rate has increased over the past month'
          : 'Your resting heart rate has decreased over the past month',
        data: {
          startValue: values[0],
          endValue: values[values.length - 1],
          change: values[values.length - 1] - values[0]
        }
      };
    }

    return null;
  }

  // Linear regression for trend detection
  calculateTrend(values) {
    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, val, i) => sum + i * val, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
  }
}
```

### Activity Comparison Query

```sql
-- Compare this week to 4-week average
WITH this_week AS (
  SELECT COALESCE(SUM(value), 0) as total
  FROM health_aggregates
  WHERE user_id = $1
    AND type = 'STEPS'
    AND period = 'day'
    AND period_start >= DATE_TRUNC('week', NOW())
),
monthly_avg AS (
  SELECT COALESCE(AVG(weekly_total), 0) as avg
  FROM (
    SELECT DATE_TRUNC('week', period_start) as week,
           SUM(value) as weekly_total
    FROM health_aggregates
    WHERE user_id = $1
      AND type = 'STEPS'
      AND period = 'day'
      AND period_start >= NOW() - INTERVAL '4 weeks'
      AND period_start < DATE_TRUNC('week', NOW())
    GROUP BY week
  ) weekly
)
SELECT
  this_week.total as current_week,
  monthly_avg.avg as monthly_average,
  ((this_week.total - monthly_avg.avg) / NULLIF(monthly_avg.avg, 0)) * 100 as percent_change
FROM this_week, monthly_avg;
```

## Deep Dive: Share Token System (3 minutes)

```sql
-- Share tokens for controlled data sharing
CREATE TABLE share_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255),
  recipient_id UUID REFERENCES users(id),
  data_types TEXT[] NOT NULL,
  date_start DATE,
  date_end DATE,
  expires_at TIMESTAMP NOT NULL,
  access_code VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

CREATE INDEX idx_shares_code ON share_tokens(access_code) WHERE revoked_at IS NULL;
```

```javascript
async getSharedData(tokenId, recipientId) {
  // Validate share token
  const token = await db.query(`
    SELECT * FROM share_tokens
    WHERE id = $1 AND recipient_id = $2
      AND expires_at > NOW() AND revoked_at IS NULL
  `, [tokenId, recipientId]);

  if (token.rows.length === 0) {
    throw new Error('Invalid or expired share token');
  }

  const shareInfo = token.rows[0];

  // Fetch only authorized data types in authorized date range
  const data = await db.query(`
    SELECT type, period_start, value
    FROM health_aggregates
    WHERE user_id = $1
      AND type = ANY($2)
      AND period_start >= $3
      AND period_start <= $4
      AND period = 'day'
    ORDER BY type, period_start
  `, [
    shareInfo.user_id,
    shareInfo.data_types,
    shareInfo.date_start,
    shareInfo.date_end
  ]);

  return data.rows;
}
```

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Time-series DB | TimescaleDB | InfluxDB | SQL compatibility, PostgreSQL ecosystem, familiar query language |
| Aggregation | Pre-computed | On-demand | Query performance for dashboards (O(1) vs O(n)), write-heavy workload absorbs compute |
| Deduplication | Priority-based | Time-based (latest wins) | Apple Watch sensors more accurate than iPhone; consistent, predictable behavior |
| Sync | Batch with idempotency | Real-time streaming | Battery efficiency on mobile, network reliability, simpler recovery |
| Encryption | Per-user keys | Single system key | HIPAA compliance, selective sharing, breach isolation |
| Queue | RabbitMQ | Kafka | Simpler for single-consumer patterns, built-in retry/DLQ |

### Storage Tiering Trade-offs

**Hot Storage (90 days uncompressed)**
- Pro: Fast queries (~5ms)
- Con: More storage (~5MB per user per 90 days)

**Warm Storage (compressed chunks)**
- Pro: 10:1 compression ratio
- Con: Slower queries (~50ms), cannot update compressed chunks

**Cold Storage (MinIO archive)**
- Pro: Cheapest storage
- Con: Minutes to restore

### Pre-computation vs On-demand

**Chose: Pre-computed aggregates**
- Dashboards refresh frequently (every page load)
- Aggregation logic is stable (sum, avg, latest)
- Background workers absorb compute cost
- Storage is cheap; user wait time is expensive

## Data Retention and HIPAA Compliance (2 minutes)

| Data Type | Hot | Warm | Delete After |
|-----------|-----|------|--------------|
| Raw samples | 90 days | 2 years | 7 years |
| Hourly aggregates | 90 days | N/A | 2 years |
| Daily aggregates | Forever | N/A | Never |
| Insights | 90 days | N/A | 2 years |
| Share tokens | Until expiry | N/A | 30 days after expiry |

```sql
-- Daily retention job
DELETE FROM health_samples WHERE start_date < NOW() - INTERVAL '7 years';
DELETE FROM health_aggregates
  WHERE period = 'hour' AND period_start < NOW() - INTERVAL '2 years';
DELETE FROM health_insights WHERE created_at < NOW() - INTERVAL '2 years';
DELETE FROM share_tokens WHERE expires_at < NOW() - INTERVAL '30 days';
```

## Closing Summary (1 minute)

"The health data pipeline backend is built around three key principles:

1. **Priority-based deduplication** - When the same metric comes from multiple devices, we prioritize by sensor quality (Apple Watch > iPhone > third-party). Overlapping time ranges are proportionally adjusted for sum-based metrics.

2. **Idempotent ingestion** - Mobile devices on unreliable networks can safely retry sync requests. Content-based idempotency keys prevent duplicate processing without requiring client-side key management.

3. **Tiered storage with pre-computed aggregates** - TimescaleDB hypertables provide efficient time-series queries. Pre-computed hourly and daily aggregates enable fast dashboard rendering. Automatic compression reduces storage costs for older data.

The main trade-off is complexity for accuracy. Priority-based deduplication with overlap handling is more complex than simply taking the latest value, but it ensures accurate totals for metrics like steps where double-counting would mislead users about their health."
