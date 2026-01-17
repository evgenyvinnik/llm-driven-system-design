# Design Health Data Pipeline - Architecture

## System Overview

A health data aggregation pipeline collecting metrics from multiple devices, processing and deduplicating data, and generating health insights while maintaining strict privacy. Core challenges involve multi-source ingestion, data quality, and privacy protection.

**Learning Goals:**
- Build multi-source data ingestion
- Design data deduplication algorithms
- Implement privacy-preserving processing
- Handle time-series health data at scale

---

## Requirements

### Functional Requirements

1. **Ingest**: Collect data from multiple devices
2. **Process**: Aggregate, deduplicate, normalize
3. **Store**: Persist with encryption
4. **Query**: Fast access to historical data
5. **Share**: Controlled data sharing

### Non-Functional Requirements

- **Privacy**: All data encrypted, minimal exposure
- **Reliability**: Zero data loss
- **Latency**: < 1s for recent data queries
- **Compliance**: HIPAA-ready architecture

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Data Sources                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Apple Watch  │  │    iPhone     │  │ Third-Party   │       │
│  │               │  │               │  │   Devices     │       │
│  │ - Heart rate  │  │ - Steps       │  │ - Scales      │       │
│  │ - Workouts    │  │ - Distance    │  │ - BP monitors │       │
│  │ - ECG         │  │ - Flights     │  │ - Glucometers │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   On-Device Processing                           │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Collection   │  │  Local DB     │  │   Sync        │       │
│  │  Agent        │  │  (Encrypted)  │  │   Engine      │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │ Encrypted Sync
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Cloud Processing                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Ingestion    │  │  Aggregation  │  │   Insights    │       │
│  │  Service      │  │  Pipeline     │  │   Engine      │       │
│  │               │  │               │  │               │       │
│  │ - Validation  │  │ - Dedup       │  │ - Trends      │       │
│  │ - Normalize   │  │ - Merge       │  │ - Alerts      │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Storage Layer                                │
│    TimescaleDB (time-series) + PostgreSQL (metadata)            │
│              + Object Store (exports, backups)                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Data Types & Schema

**Health Data Types:**
```javascript
const HealthDataTypes = {
  // Quantity types (single value at point in time)
  STEPS: { unit: 'count', aggregation: 'sum' },
  DISTANCE: { unit: 'meters', aggregation: 'sum' },
  HEART_RATE: { unit: 'bpm', aggregation: 'average' },
  RESTING_HEART_RATE: { unit: 'bpm', aggregation: 'average' },
  BLOOD_PRESSURE_SYSTOLIC: { unit: 'mmHg', aggregation: 'average' },
  BLOOD_PRESSURE_DIASTOLIC: { unit: 'mmHg', aggregation: 'average' },
  WEIGHT: { unit: 'kg', aggregation: 'latest' },
  BODY_FAT: { unit: 'percent', aggregation: 'latest' },
  BLOOD_GLUCOSE: { unit: 'mg/dL', aggregation: 'average' },
  SLEEP_ANALYSIS: { unit: 'minutes', aggregation: 'sum' },
  ACTIVE_ENERGY: { unit: 'kcal', aggregation: 'sum' },
  OXYGEN_SATURATION: { unit: 'percent', aggregation: 'average' },

  // Category types (state at point in time)
  SLEEP_STATE: { values: ['asleep', 'awake', 'rem', 'deep', 'core'] },
  MENSTRUAL_FLOW: { values: ['none', 'light', 'medium', 'heavy'] },

  // Workout types
  WORKOUT: { hasRoute: true, hasSamples: true }
}

class HealthSample {
  constructor(data) {
    this.id = data.id || uuid()
    this.userId = data.userId
    this.type = data.type
    this.value = data.value
    this.unit = data.unit
    this.startDate = new Date(data.startDate)
    this.endDate = new Date(data.endDate)
    this.sourceDevice = data.sourceDevice
    this.sourceApp = data.sourceApp
    this.metadata = data.metadata || {}
    this.createdAt = new Date()
  }

  validate() {
    const typeConfig = HealthDataTypes[this.type]
    if (!typeConfig) {
      throw new Error(`Unknown health type: ${this.type}`)
    }

    if (typeConfig.unit && this.unit !== typeConfig.unit) {
      // Convert to standard unit
      this.value = this.convertUnit(this.value, this.unit, typeConfig.unit)
      this.unit = typeConfig.unit
    }

    return true
  }
}
```

### 2. Device Sync Service

**Multi-Device Data Collection:**
```javascript
class DeviceSyncService {
  async syncFromDevice(userId, deviceId, samples) {
    const validSamples = []
    const errors = []

    for (const sample of samples) {
      try {
        const healthSample = new HealthSample({
          ...sample,
          userId,
          sourceDevice: deviceId
        })

        healthSample.validate()
        validSamples.push(healthSample)
      } catch (error) {
        errors.push({ sample, error: error.message })
      }
    }

    // Batch insert with conflict handling
    if (validSamples.length > 0) {
      await this.batchInsert(validSamples)
    }

    // Queue for aggregation processing
    await this.queue.publish('health-aggregation', {
      userId,
      sampleTypes: [...new Set(validSamples.map(s => s.type))],
      dateRange: this.getDateRange(validSamples)
    })

    return {
      synced: validSamples.length,
      errors: errors.length,
      errorDetails: errors
    }
  }

  async batchInsert(samples) {
    // Use UPSERT to handle duplicates
    const values = samples.map(s => [
      s.id,
      s.userId,
      s.type,
      s.value,
      s.unit,
      s.startDate,
      s.endDate,
      s.sourceDevice,
      s.sourceApp,
      JSON.stringify(s.metadata)
    ])

    await db.query(`
      INSERT INTO health_samples
        (id, user_id, type, value, unit, start_date, end_date,
         source_device, source_app, metadata)
      VALUES ${this.buildPlaceholders(values)}
      ON CONFLICT (id) DO NOTHING
    `, values.flat())
  }

  getDateRange(samples) {
    const dates = samples.map(s => s.startDate.getTime())
    return {
      start: new Date(Math.min(...dates)),
      end: new Date(Math.max(...dates))
    }
  }
}
```

### 3. Aggregation Pipeline

**Data Deduplication & Aggregation:**
```javascript
class AggregationPipeline {
  async processAggregation(job) {
    const { userId, sampleTypes, dateRange } = job

    for (const type of sampleTypes) {
      await this.aggregateType(userId, type, dateRange)
    }
  }

  async aggregateType(userId, type, dateRange) {
    const typeConfig = HealthDataTypes[type]

    // Get all samples for this type in date range
    const samples = await this.getSamples(userId, type, dateRange)

    // Deduplicate overlapping samples from different sources
    const deduped = this.deduplicateSamples(samples, type)

    // Generate hourly aggregates
    const hourlyAggregates = this.aggregateByPeriod(
      deduped,
      'hour',
      typeConfig.aggregation
    )

    // Generate daily aggregates
    const dailyAggregates = this.aggregateByPeriod(
      deduped,
      'day',
      typeConfig.aggregation
    )

    // Store aggregates
    await this.storeAggregates(userId, type, hourlyAggregates, 'hour')
    await this.storeAggregates(userId, type, dailyAggregates, 'day')
  }

  deduplicateSamples(samples, type) {
    // Sort by source priority (Apple Watch > iPhone > Third-party)
    const prioritized = samples.sort((a, b) => {
      return this.getSourcePriority(b.sourceDevice) -
             this.getSourcePriority(a.sourceDevice)
    })

    const result = []
    const covered = [] // Time ranges already covered

    for (const sample of prioritized) {
      const overlap = this.findOverlap(
        sample.startDate,
        sample.endDate,
        covered
      )

      if (!overlap) {
        // No overlap, include full sample
        result.push(sample)
        covered.push({ start: sample.startDate, end: sample.endDate })
      } else if (overlap.partial) {
        // Partial overlap, include non-overlapping portion
        const adjusted = this.adjustForOverlap(sample, overlap)
        if (adjusted) {
          result.push(adjusted)
          covered.push({ start: adjusted.startDate, end: adjusted.endDate })
        }
      }
      // Full overlap: skip this sample (higher priority already covers it)
    }

    return result
  }

  getSourcePriority(device) {
    const priorities = {
      'apple_watch': 100,
      'iphone': 80,
      'ipad': 70,
      'third_party_wearable': 50,
      'third_party_scale': 40,
      'manual_entry': 10
    }
    return priorities[device] || 0
  }

  aggregateByPeriod(samples, period, aggregationType) {
    const buckets = new Map()

    for (const sample of samples) {
      const bucketKey = this.getBucketKey(sample.startDate, period)

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, [])
      }
      buckets.get(bucketKey).push(sample.value)
    }

    const aggregates = []
    for (const [key, values] of buckets) {
      aggregates.push({
        periodStart: new Date(key),
        period,
        value: this.aggregate(values, aggregationType),
        sampleCount: values.length
      })
    }

    return aggregates
  }

  aggregate(values, type) {
    switch (type) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0)
      case 'average':
        return values.reduce((a, b) => a + b, 0) / values.length
      case 'min':
        return Math.min(...values)
      case 'max':
        return Math.max(...values)
      case 'latest':
        return values[values.length - 1]
      default:
        return values[0]
    }
  }

  async storeAggregates(userId, type, aggregates, period) {
    for (const agg of aggregates) {
      await db.query(`
        INSERT INTO health_aggregates
          (user_id, type, period, period_start, value, sample_count)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, type, period, period_start)
        DO UPDATE SET
          value = $5,
          sample_count = $6,
          updated_at = NOW()
      `, [userId, type, period, agg.periodStart, agg.value, agg.sampleCount])
    }
  }
}
```

### 4. Insights Engine

**Trend Detection & Alerts:**
```javascript
class InsightsEngine {
  async analyzeUser(userId) {
    const insights = []

    // Heart rate trends
    const hrInsight = await this.analyzeHeartRate(userId)
    if (hrInsight) insights.push(hrInsight)

    // Sleep patterns
    const sleepInsight = await this.analyzeSleep(userId)
    if (sleepInsight) insights.push(sleepInsight)

    // Activity trends
    const activityInsight = await this.analyzeActivity(userId)
    if (activityInsight) insights.push(activityInsight)

    // Store insights
    for (const insight of insights) {
      await this.storeInsight(userId, insight)
    }

    return insights
  }

  async analyzeHeartRate(userId) {
    // Get last 30 days of resting heart rate
    const data = await db.query(`
      SELECT period_start, value
      FROM health_aggregates
      WHERE user_id = $1
        AND type = 'RESTING_HEART_RATE'
        AND period = 'day'
        AND period_start >= NOW() - INTERVAL '30 days'
      ORDER BY period_start
    `, [userId])

    if (data.rows.length < 7) {
      return null // Not enough data
    }

    const values = data.rows.map(r => r.value)
    const trend = this.calculateTrend(values)

    if (Math.abs(trend.slope) > 0.5) {
      // Significant trend detected
      return {
        type: 'HEART_RATE_TREND',
        direction: trend.slope > 0 ? 'increasing' : 'decreasing',
        magnitude: Math.abs(trend.slope),
        period: '30_days',
        message: trend.slope > 0
          ? `Your resting heart rate has been increasing over the past month`
          : `Your resting heart rate has been decreasing over the past month`,
        data: {
          startValue: values[0],
          endValue: values[values.length - 1],
          change: values[values.length - 1] - values[0]
        }
      }
    }

    return null
  }

  async analyzeSleep(userId) {
    // Get last 14 days of sleep
    const data = await db.query(`
      SELECT period_start, value
      FROM health_aggregates
      WHERE user_id = $1
        AND type = 'SLEEP_ANALYSIS'
        AND period = 'day'
        AND period_start >= NOW() - INTERVAL '14 days'
      ORDER BY period_start
    `, [userId])

    if (data.rows.length < 7) return null

    const avgSleep = data.rows.reduce((a, b) => a + b.value, 0) / data.rows.length
    const avgHours = avgSleep / 60

    if (avgHours < 6) {
      return {
        type: 'SLEEP_DEFICIT',
        severity: avgHours < 5 ? 'high' : 'medium',
        message: `You've been averaging ${avgHours.toFixed(1)} hours of sleep`,
        recommendation: 'Try to get 7-9 hours of sleep for optimal health',
        data: { averageHours: avgHours }
      }
    }

    return null
  }

  async analyzeActivity(userId) {
    // Compare this week to last 4 week average
    const thisWeek = await db.query(`
      SELECT COALESCE(SUM(value), 0) as total
      FROM health_aggregates
      WHERE user_id = $1
        AND type = 'STEPS'
        AND period = 'day'
        AND period_start >= DATE_TRUNC('week', NOW())
    `, [userId])

    const lastMonth = await db.query(`
      SELECT COALESCE(AVG(weekly_total), 0) as avg
      FROM (
        SELECT DATE_TRUNC('week', period_start) as week, SUM(value) as weekly_total
        FROM health_aggregates
        WHERE user_id = $1
          AND type = 'STEPS'
          AND period = 'day'
          AND period_start >= NOW() - INTERVAL '4 weeks'
          AND period_start < DATE_TRUNC('week', NOW())
        GROUP BY week
      ) weekly
    `, [userId])

    const currentTotal = thisWeek.rows[0].total
    const monthlyAvg = lastMonth.rows[0].avg

    if (monthlyAvg > 0) {
      const percentChange = ((currentTotal - monthlyAvg) / monthlyAvg) * 100

      if (Math.abs(percentChange) > 20) {
        return {
          type: 'ACTIVITY_CHANGE',
          direction: percentChange > 0 ? 'increased' : 'decreased',
          magnitude: Math.abs(percentChange),
          message: percentChange > 0
            ? `Great job! You're ${percentChange.toFixed(0)}% more active this week`
            : `Your activity is down ${Math.abs(percentChange).toFixed(0)}% this week`,
          data: { currentWeek: currentTotal, monthlyAverage: monthlyAvg }
        }
      }
    }

    return null
  }

  calculateTrend(values) {
    const n = values.length
    const sumX = (n * (n - 1)) / 2
    const sumY = values.reduce((a, b) => a + b, 0)
    const sumXY = values.reduce((sum, val, i) => sum + i * val, 0)
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
    const intercept = (sumY - slope * sumX) / n

    return { slope, intercept }
  }
}
```

### 5. Privacy Layer

**Data Protection:**
```javascript
class PrivacyService {
  async encryptSample(sample, userKey) {
    // Encrypt sensitive fields
    const sensitiveFields = ['value', 'metadata']

    const encrypted = { ...sample }
    for (const field of sensitiveFields) {
      if (sample[field] !== undefined) {
        encrypted[field] = await this.encrypt(
          JSON.stringify(sample[field]),
          userKey
        )
      }
    }

    return encrypted
  }

  async decryptSample(encrypted, userKey) {
    const sensitiveFields = ['value', 'metadata']

    const decrypted = { ...encrypted }
    for (const field of sensitiveFields) {
      if (encrypted[field] !== undefined) {
        const plaintext = await this.decrypt(encrypted[field], userKey)
        decrypted[field] = JSON.parse(plaintext)
      }
    }

    return decrypted
  }

  async createShareToken(userId, recipientId, permissions) {
    // Create limited access token for sharing
    const token = {
      id: uuid(),
      userId,
      recipientId,
      dataTypes: permissions.dataTypes,
      dateRange: permissions.dateRange,
      expiresAt: permissions.expiresAt,
      createdAt: new Date()
    }

    // Derive a sharing key from user's key
    const sharingKey = await this.deriveSharingKey(userId, token.id)

    await db.query(`
      INSERT INTO share_tokens
        (id, user_id, recipient_id, data_types, date_start, date_end,
         expires_at, encrypted_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      token.id,
      userId,
      recipientId,
      permissions.dataTypes,
      permissions.dateRange.start,
      permissions.dateRange.end,
      permissions.expiresAt,
      await this.encryptKey(sharingKey, recipientId)
    ])

    return token
  }

  async getSharedData(tokenId, recipientId) {
    // Validate share token
    const token = await db.query(`
      SELECT * FROM share_tokens
      WHERE id = $1 AND recipient_id = $2 AND expires_at > NOW()
    `, [tokenId, recipientId])

    if (token.rows.length === 0) {
      throw new Error('Invalid or expired share token')
    }

    const shareInfo = token.rows[0]

    // Fetch authorized data
    const data = await db.query(`
      SELECT * FROM health_aggregates
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
    ])

    return {
      userId: shareInfo.user_id,
      dataTypes: shareInfo.data_types,
      samples: data.rows
    }
  }
}
```

### 6. Query API

**Health Data Access:**
```javascript
class HealthQueryService {
  async getSamples(userId, options) {
    const { type, startDate, endDate, limit = 1000 } = options

    const samples = await db.query(`
      SELECT * FROM health_samples
      WHERE user_id = $1
        AND type = $2
        AND start_date >= $3
        AND start_date <= $4
      ORDER BY start_date DESC
      LIMIT $5
    `, [userId, type, startDate, endDate, limit])

    return samples.rows
  }

  async getAggregates(userId, options) {
    const { types, period, startDate, endDate } = options

    const aggregates = await db.query(`
      SELECT type, period_start, value, sample_count
      FROM health_aggregates
      WHERE user_id = $1
        AND type = ANY($2)
        AND period = $3
        AND period_start >= $4
        AND period_start <= $5
      ORDER BY type, period_start
    `, [userId, types, period, startDate, endDate])

    // Group by type
    const grouped = {}
    for (const row of aggregates.rows) {
      if (!grouped[row.type]) {
        grouped[row.type] = []
      }
      grouped[row.type].push({
        date: row.period_start,
        value: row.value,
        sampleCount: row.sample_count
      })
    }

    return grouped
  }

  async getSummary(userId, date) {
    const summary = await db.query(`
      SELECT type, value
      FROM health_aggregates
      WHERE user_id = $1
        AND period = 'day'
        AND period_start = DATE_TRUNC('day', $2::timestamp)
    `, [userId, date])

    const result = {}
    for (const row of summary.rows) {
      result[row.type] = row.value
    }

    return result
  }
}
```

---

## Database Schema

```sql
-- Raw health samples
CREATE TABLE health_samples (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL,
  value DOUBLE PRECISION,
  unit VARCHAR(20),
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  source_device VARCHAR(50),
  source_app VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Use TimescaleDB for efficient time-series queries
SELECT create_hypertable('health_samples', 'start_date');

CREATE INDEX idx_samples_user_type ON health_samples(user_id, type, start_date DESC);

-- Aggregated data
CREATE TABLE health_aggregates (
  user_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL,
  period VARCHAR(10) NOT NULL, -- hour, day, week, month
  period_start TIMESTAMP NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  sample_count INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, type, period, period_start)
);

SELECT create_hypertable('health_aggregates', 'period_start');

-- User insights
CREATE TABLE health_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20),
  message TEXT,
  data JSONB,
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_insights_user ON health_insights(user_id, created_at DESC);

-- Share tokens
CREATE TABLE share_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  recipient_id UUID NOT NULL,
  data_types TEXT[] NOT NULL,
  date_start DATE,
  date_end DATE,
  expires_at TIMESTAMP NOT NULL,
  encrypted_key BYTEA,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

CREATE INDEX idx_shares_recipient ON share_tokens(recipient_id, expires_at);

-- Devices
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  device_type VARCHAR(50) NOT NULL,
  device_name VARCHAR(100),
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON user_devices(user_id);
```

---

## Key Design Decisions

### 1. On-Device Processing First

**Decision**: Process and aggregate on device when possible

**Rationale**:
- Minimizes data leaving device
- Reduces server load
- Better privacy
- Works offline

### 2. Source Priority for Deduplication

**Decision**: Apple Watch > iPhone > Third-party

**Rationale**:
- Higher accuracy from dedicated sensors
- Consistent data source preference
- Predictable behavior

### 3. TimescaleDB for Time-Series

**Decision**: Use TimescaleDB extension for PostgreSQL

**Rationale**:
- Optimized for time-series queries
- Automatic partitioning
- Familiar SQL interface
- Compression support

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Primary storage | TimescaleDB | InfluxDB | SQL compatibility |
| Aggregation | Pre-computed | On-demand | Query performance |
| Encryption | Per-user keys | Single key | Privacy, sharing |
| Sync | Batch | Real-time | Battery efficiency |
| Deduplication | Priority-based | Time-based | Data accuracy |

---

## Cost Tradeoffs

### Storage Tiering

For a local development environment, we use a simplified two-tier storage model.

**Tier 1 - Hot Storage (TimescaleDB)**
- Stores last 90 days of raw samples and all aggregates
- Uncompressed for fast read/write access
- Target: < 500MB per user for 90 days of data
- Use case: Active queries, real-time aggregation, dashboard rendering

**Tier 2 - Warm Storage (Compressed TimescaleDB chunks)**
- Data older than 90 days compressed in-place using TimescaleDB native compression
- Compression ratio: ~10:1 for health data (repetitive numeric values)
- Query latency increases from ~5ms to ~50ms for compressed chunks
- Use case: Historical trend analysis, yearly reports

**Local Development Sizing (per user)**
| Data Type | Raw Samples/Day | Size/Day | 90 Days |
|-----------|-----------------|----------|---------|
| Heart rate | 1,440 (1/min) | 50 KB | 4.5 MB |
| Steps | 24 (hourly) | 1 KB | 90 KB |
| Sleep | 1 | 0.5 KB | 45 KB |
| Other vitals | ~100 | 4 KB | 360 KB |
| **Total** | ~1,565 | ~56 KB | **~5 MB** |

### Cache Sizing (Valkey/Redis)

**Session Cache**
- Size per session: ~500 bytes (user ID, device tokens, preferences)
- Target: 1,000 concurrent sessions for local testing
- Allocation: 1 MB for sessions
- TTL: 24 hours (sliding expiration on activity)

**Aggregate Cache**
- Cache recent aggregates (last 7 days) for dashboard performance
- Size per user: ~50 KB (7 days x 16 data types x 24 hourly values x 12 bytes)
- Target: 100 users cached
- Allocation: 5 MB for aggregates
- TTL: 1 hour (invalidated on new data sync)

**Total Valkey Memory: 16 MB** (comfortable for local development)

```javascript
// Cache configuration
const cacheConfig = {
  session: {
    prefix: 'session:',
    ttlSeconds: 86400,
    maxMemory: '1mb'
  },
  aggregates: {
    prefix: 'agg:',
    ttlSeconds: 3600,
    maxMemory: '5mb'
  },
  insights: {
    prefix: 'insight:',
    ttlSeconds: 300,
    maxMemory: '2mb'
  }
}
```

### Queue Retention

**RabbitMQ Configuration**
- Queue: `health-aggregation`
  - Max length: 10,000 messages
  - TTL: 1 hour (unprocessed messages expire)
  - Dead letter exchange: `health-aggregation-dlx`
  - Retention on DLX: 24 hours (for debugging failed jobs)

- Queue: `health-insights`
  - Max length: 1,000 messages
  - TTL: 4 hours (insights are less time-sensitive)
  - No dead letter (insights can be regenerated)

```javascript
// Queue declarations
const queueConfig = {
  aggregation: {
    name: 'health-aggregation',
    options: {
      durable: true,
      arguments: {
        'x-max-length': 10000,
        'x-message-ttl': 3600000,
        'x-dead-letter-exchange': 'health-aggregation-dlx'
      }
    }
  }
}
```

### Compute vs Storage Optimization

**Pre-computation Strategy (chosen)**
- Compute aggregates immediately after sync
- Store hourly + daily aggregates (24 + 1 = 25 rows/day/type)
- Query time: O(1) lookup
- Storage overhead: ~2x raw data size
- CPU spike: Brief burst during sync

**On-demand Calculation (alternative, not chosen)**
- Store only raw samples
- Compute aggregates at query time
- Query time: O(n) where n = samples in range
- Storage: 1x
- CPU: Constant load on every dashboard view

**Decision**: Pre-computation wins for health dashboards because:
1. Dashboards refresh frequently (every page load)
2. Aggregation logic is stable (sum, avg, latest)
3. Storage is cheap; user wait time is expensive
4. Background processing absorbs compute cost

---

## Data Lifecycle Policies

### Retention Rules

| Data Type | Hot Retention | Warm Retention | Delete After |
|-----------|---------------|----------------|--------------|
| Raw samples | 90 days | 2 years | 7 years |
| Hourly aggregates | 90 days | 1 year | 2 years |
| Daily aggregates | Forever | N/A | Never |
| Weekly/Monthly aggregates | Forever | N/A | Never |
| Insights | 90 days | 1 year | 2 years |
| Share tokens | Until expiry + 30 days | N/A | 30 days after expiry |
| Audit logs | 1 year | 6 years | 7 years |

### Automated Retention Jobs

```sql
-- Run daily: compress old chunks (TimescaleDB)
SELECT compress_chunk(c)
FROM show_chunks('health_samples', older_than => INTERVAL '90 days') c
WHERE NOT is_compressed(c);

-- Run weekly: delete expired raw samples
DELETE FROM health_samples
WHERE start_date < NOW() - INTERVAL '7 years';

-- Run daily: delete expired hourly aggregates
DELETE FROM health_aggregates
WHERE period = 'hour'
  AND period_start < NOW() - INTERVAL '2 years';

-- Run daily: cleanup expired share tokens
DELETE FROM share_tokens
WHERE expires_at < NOW() - INTERVAL '30 days';

-- Run daily: cleanup old insights
DELETE FROM health_insights
WHERE created_at < NOW() - INTERVAL '2 years';
```

**Cron Schedule (local dev with node-cron)**
```javascript
const cron = require('node-cron');

// Daily at 3 AM: compression and cleanup
cron.schedule('0 3 * * *', async () => {
  await compressOldChunks();
  await deleteExpiredTokens();
  await deleteOldInsights();
});

// Weekly on Sunday at 4 AM: deep cleanup
cron.schedule('0 4 * * 0', async () => {
  await deleteAncientSamples();
  await deleteOldHourlyAggregates();
  await vacuumAnalyze();
});
```

### Archival to Cold Storage

For local development, cold storage is simulated with MinIO (S3-compatible).

**Archive Format**
- Parquet files for columnar efficiency
- Partitioned by: `user_id/year/month/data_type.parquet`
- Compressed with Snappy (fast decompression)

**Archive Trigger**
```javascript
async function archiveToMinio(userId, year, month) {
  // Extract data for the month
  const samples = await db.query(`
    SELECT * FROM health_samples
    WHERE user_id = $1
      AND start_date >= $2
      AND start_date < $3
  `, [userId, `${year}-${month}-01`, `${year}-${month + 1}-01`]);

  // Convert to Parquet
  const parquetBuffer = await toParquet(samples.rows);

  // Upload to MinIO
  await minio.putObject(
    'health-archive',
    `${userId}/${year}/${month}/samples.parquet`,
    parquetBuffer
  );

  // Optionally delete from hot storage after verification
  // await deleteArchivedSamples(userId, year, month);
}
```

### Backfill and Replay Procedures

**Scenario 1: Aggregation Bug Fix**

When aggregation logic is fixed, replay affected date ranges:

```javascript
async function replayAggregation(userId, startDate, endDate) {
  // 1. Delete existing aggregates in range
  await db.query(`
    DELETE FROM health_aggregates
    WHERE user_id = $1
      AND period_start >= $2
      AND period_start <= $3
  `, [userId, startDate, endDate]);

  // 2. Re-queue aggregation job
  await queue.publish('health-aggregation', {
    userId,
    sampleTypes: Object.keys(HealthDataTypes),
    dateRange: { start: startDate, end: endDate },
    priority: 'low',
    isReplay: true
  });
}

// Bulk replay for all users (admin operation)
async function bulkReplayAggregation(startDate, endDate) {
  const users = await db.query('SELECT DISTINCT user_id FROM health_samples');

  for (const { user_id } of users.rows) {
    await replayAggregation(user_id, startDate, endDate);
    // Rate limit to avoid queue overload
    await sleep(100);
  }
}
```

**Scenario 2: Restore from Archive**

```javascript
async function restoreFromArchive(userId, year, month) {
  // 1. Download from MinIO
  const stream = await minio.getObject(
    'health-archive',
    `${userId}/${year}/${month}/samples.parquet`
  );

  // 2. Parse Parquet
  const samples = await fromParquet(stream);

  // 3. Insert into hot storage
  await batchInsertSamples(samples);

  // 4. Trigger reaggregation
  await replayAggregation(
    userId,
    new Date(year, month - 1, 1),
    new Date(year, month, 0)
  );
}
```

**Scenario 3: Device Re-sync (duplicate handling)**

When a device re-syncs historical data:
1. UPSERT handles duplicates at the sample level (same sample ID)
2. Deduplication handles overlapping time ranges from different sources
3. Aggregates are recomputed for affected date ranges

---

## Deployment and Operations

### Rollout Strategy

**Local Development (Single Instance)**
```bash
# Start all services
docker-compose up -d          # PostgreSQL, TimescaleDB, Valkey, RabbitMQ, MinIO
npm run dev                   # Start all Node services

# Individual services for debugging
npm run dev:ingestion         # Port 3001 - handles device sync
npm run dev:aggregation       # Background worker
npm run dev:api               # Port 3000 - query API
npm run dev:admin             # Port 3002 - admin interface
```

**Multi-Instance Testing (Simulated Production)**
```bash
# Run 3 API instances behind nginx
npm run dev:api1              # Port 3001
npm run dev:api2              # Port 3002
npm run dev:api3              # Port 3003
npm run dev:lb                # Port 3000 (nginx load balancer)

# Run 2 aggregation workers
npm run dev:worker1
npm run dev:worker2
```

**Rollout Checklist**
1. Run `npm run db:migrate` to apply schema changes
2. Start workers before API servers (process backlog)
3. Health check endpoints must return 200 before routing traffic
4. Monitor queue depth during rollout

### Schema Migrations

**Migration File Naming**
```
db/migrations/
├── 001_initial_schema.sql
├── 002_add_insights_table.sql
├── 003_add_compression_policy.sql
├── 004_add_share_tokens.sql
└── 005_add_audit_log.sql
```

**Migration Runner**
```javascript
// db/migrate.ts
async function runMigrations() {
  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  for (const file of files) {
    const version = parseInt(file.split('_')[0]);
    if (!applied.includes(version)) {
      console.log(`Applying migration: ${file}`);

      await db.query('BEGIN');
      try {
        const sql = await fs.readFile(`db/migrations/${file}`, 'utf8');
        await db.query(sql);
        await recordMigration(version, file);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
  }
}
```

**Migration Best Practices**
1. Always include both UP and DOWN in migration files
2. Never modify a deployed migration; create a new one
3. Test migrations against a copy of production data
4. Use transactions for DDL when possible

**Example Migration with Rollback**
```sql
-- 006_add_device_priority.sql

-- UP
ALTER TABLE user_devices ADD COLUMN priority INTEGER DEFAULT 50;

UPDATE user_devices SET priority = CASE
  WHEN device_type = 'apple_watch' THEN 100
  WHEN device_type = 'iphone' THEN 80
  WHEN device_type = 'ipad' THEN 70
  ELSE 50
END;

INSERT INTO schema_migrations (version, name, applied_at)
VALUES (6, '006_add_device_priority.sql', NOW());

-- DOWN (run manually if rollback needed)
-- ALTER TABLE user_devices DROP COLUMN priority;
-- DELETE FROM schema_migrations WHERE version = 6;
```

### Rollback Runbooks

**Runbook 1: Application Rollback**

*Trigger*: Error rate > 5% or P99 latency > 2s after deployment

```bash
# 1. Stop new deployments
# 2. Revert to previous container/code version
git checkout HEAD~1
npm install
npm run build
pm2 restart all

# 3. Verify health
curl http://localhost:3000/health
# Expected: {"status":"ok","version":"1.2.3"}

# 4. Monitor error rates for 10 minutes
# 5. Investigate root cause before re-deploying
```

**Runbook 2: Database Migration Rollback**

*Trigger*: Migration causes application errors or data corruption

```bash
# 1. Identify the problematic migration
npm run db:status
# Shows: Migration 006_add_device_priority.sql FAILED

# 2. Run the DOWN section manually
psql $DATABASE_URL < db/rollbacks/006_down.sql

# 3. Remove from migration history
psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = 6"

# 4. Fix the migration and retry
vim db/migrations/006_add_device_priority.sql
npm run db:migrate
```

**Runbook 3: Queue Backlog Recovery**

*Trigger*: Queue depth > 50,000 messages or processing stopped

```bash
# 1. Check queue status
curl -u guest:guest http://localhost:15672/api/queues/%2F/health-aggregation
# Look for: messages, consumers, message_stats

# 2. If workers are dead, restart them
pm2 restart aggregation-worker

# 3. If backlog is from bad data, move to DLQ
rabbitmqctl purge_queue health-aggregation
# Or selectively: move messages older than 1 hour to DLQ

# 4. Scale up workers temporarily
pm2 scale aggregation-worker 4

# 5. Monitor until queue depth returns to normal (< 100)
watch -n 5 'curl -s localhost:15672/api/queues/%2F/health-aggregation | jq .messages'
```

**Runbook 4: Cache Corruption Recovery**

*Trigger*: Stale or incorrect data appearing in dashboards

```bash
# 1. Flush specific cache prefix
redis-cli KEYS "agg:*" | xargs redis-cli DEL

# 2. Or flush all caches (nuclear option)
redis-cli FLUSHALL

# 3. Warm cache by hitting endpoints
curl http://localhost:3000/api/v1/users/me/summary?date=today

# 4. Monitor cache hit rate
redis-cli INFO stats | grep keyspace
```

**Runbook 5: Data Integrity Check**

*Trigger*: Weekly scheduled check or user reports inconsistent data

```sql
-- Check for orphaned aggregates (no source samples)
SELECT DISTINCT user_id, type, period_start
FROM health_aggregates a
WHERE NOT EXISTS (
  SELECT 1 FROM health_samples s
  WHERE s.user_id = a.user_id
    AND s.type = a.type
    AND s.start_date >= a.period_start
    AND s.start_date < a.period_start + INTERVAL '1 day'
);

-- Check for missing aggregates (samples exist, no aggregate)
SELECT user_id, type, DATE_TRUNC('day', start_date) as day, COUNT(*)
FROM health_samples s
WHERE NOT EXISTS (
  SELECT 1 FROM health_aggregates a
  WHERE a.user_id = s.user_id
    AND a.type = s.type
    AND a.period = 'day'
    AND a.period_start = DATE_TRUNC('day', s.start_date)
)
GROUP BY user_id, type, day;

-- Fix: trigger reaggregation for affected users/dates
```

### Health Check Endpoints

```javascript
// GET /health - basic liveness
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: process.env.VERSION });
});

// GET /ready - full readiness (dependencies checked)
app.get('/ready', async (req, res) => {
  const checks = {
    database: await checkDatabase(),
    cache: await checkCache(),
    queue: await checkQueue(),
    storage: await checkMinio()
  };

  const allHealthy = Object.values(checks).every(c => c.healthy);

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'degraded',
    checks,
    timestamp: new Date().toISOString()
  });
});

async function checkDatabase() {
  try {
    await db.query('SELECT 1');
    return { healthy: true, latencyMs: 1 };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}
```

---

## Implementation Notes

This section documents the production-ready modules implemented in `backend/src/shared/` and explains WHY each change improves the system's reliability, observability, and maintainability.

### 1. Structured Logging with Pino (`shared/logger.js`)

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| `console.log` outputs unstructured text | Pino emits JSON logs | Machine-parseable for log aggregation (ELK, Datadog) |
| No request correlation across services | Automatic `requestId` injection | Trace requests through distributed systems |
| Sensitive data in logs | Redaction of auth headers, passwords | HIPAA compliance, security |
| Inconsistent log levels | Structured severity levels | Proper alerting thresholds |

**Key features:**
- Request logging middleware adds timing, status codes, and user context
- Child loggers propagate request IDs through the call stack
- Pretty printing in development, JSON in production
- Redaction of sensitive fields (`authorization`, `password`, `token`)

**Usage:**
```javascript
import { logger, requestLoggingMiddleware } from './shared/logger.js';

app.use(requestLoggingMiddleware);
logger.info({ msg: 'User logged in', userId: user.id });
```

### 2. Prometheus Metrics (`shared/metrics.js`)

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| No visibility into request performance | HTTP duration histograms | P99 latency tracking, SLO monitoring |
| Unknown ingestion throughput | Sample counter by type/status | Capacity planning, anomaly detection |
| Database blind spots | Query duration histograms | Identify slow queries before they cause outages |
| No alerting data | Prometheus-compatible `/metrics` | Integrate with Grafana dashboards |

**Key metrics exported:**
- `health_pipeline_http_request_duration_seconds` - Request latency histograms
- `health_pipeline_samples_ingested_total` - Ingestion rate by type
- `health_pipeline_sync_duration_seconds` - Device sync performance
- `health_pipeline_db_pool_size` - Connection pool health
- Default Node.js metrics (CPU, memory, event loop, GC)

**Usage:**
```bash
# Scrape metrics with curl
curl http://localhost:3000/metrics

# View in Prometheus/Grafana
# health_pipeline_http_request_duration_seconds{route="/api/v1/devices/:id/sync"}
```

### 3. Health Check Endpoints (`shared/health.js`)

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| Load balancer sends traffic to unhealthy pods | `/ready` checks dependencies | No traffic until DB + Redis are up |
| Kubernetes restarts healthy services | `/health` is lightweight | Fast liveness checks avoid false restarts |
| No visibility into service state | `/health/deep` with pool stats | Debug degraded services |

**Endpoints:**
- `GET /health` - Liveness probe (is process alive?)
- `GET /ready` - Readiness probe (are dependencies healthy?)
- `GET /health/deep` - Debugging endpoint with memory/pool stats

**Kubernetes integration:**
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
```

### 4. Data Retention Configuration (`shared/retention.js`)

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| Unbounded storage growth | Tiered retention (hot/warm/delete) | Predictable storage costs |
| HIPAA requires defined retention | 7-year retention for samples | Regulatory compliance |
| Old data slows queries | 90-day hot tier, then compression | Fast dashboard queries |
| No way to restore old data | Archive to MinIO before deletion | Disaster recovery capability |

**Retention tiers:**
| Data Type | Hot (uncompressed) | Warm (compressed) | Delete |
|-----------|-------------------|-------------------|--------|
| Raw samples | 90 days | 2 years | 7 years |
| Hourly aggregates | 90 days | N/A | 2 years |
| Daily aggregates | Forever | N/A | Never |
| Insights | 90 days | N/A | 2 years |

**Automated cleanup:**
```javascript
import { runRetentionCleanup, compressOldChunks } from './shared/retention.js';

// Run daily via cron or scheduled job
await runRetentionCleanup();
await compressOldChunks();
```

### 5. Idempotency for Ingestion (`shared/idempotency.js`)

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| Mobile devices retry failed syncs | Idempotency key caching | No duplicate processing |
| Duplicate data corrupts aggregates | Content-based key generation | Accurate health metrics |
| Wasted compute on retries | Return cached response | Lower server load |
| Database constraint violations | Pre-check before insert | Cleaner error handling |

**How it works:**
1. Client sends `X-Idempotency-Key` header OR server generates from content hash
2. Server checks Redis for existing key
3. If found: return cached response immediately
4. If new: process request, cache response with 24h TTL

**Automatic key generation:**
```javascript
// Keys are automatically generated from:
// userId + deviceId + hash(samples)
// So identical payloads from the same device are detected
const key = generateIdempotencyKey(userId, deviceId, samples);
```

### 6. Database Migration Runner (`db/migrate.js`)

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| Schema changes break deployments | Version-controlled migrations | Reproducible deployments |
| No rollback capability | DOWN sections in migrations | Quick recovery from bad changes |
| Manual DDL is error-prone | Transaction-wrapped execution | Atomic schema changes |
| Unknown schema state | `schema_migrations` tracking | Know exactly what's applied |

**Migration workflow:**
```bash
# Check current status
npm run db:migrate:status

# Apply pending migrations
npm run db:migrate

# Rollback last migration
npm run db:migrate:down
```

**Migration file format:**
```sql
-- db/migrations/001_add_idempotency_keys.sql

-- UP
CREATE TABLE idempotency_keys (...);

-- DOWN
DROP TABLE idempotency_keys;
```

### 7. Graceful Shutdown

**WHY this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| Requests fail during restart | Stop accepting before closing | No dropped requests |
| Connection pool leaks | Explicit pool.end() | Clean resource cleanup |
| Hung shutdowns block deploys | 30-second force timeout | Reliable container restarts |

**Implementation in index.js:**
```javascript
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

---

## Summary of Production Readiness Improvements

| Category | Before | After |
|----------|--------|-------|
| **Logging** | `console.log` | Structured JSON with request IDs |
| **Metrics** | None | Prometheus histograms + counters |
| **Health** | Basic `/health` | Liveness + Readiness + Deep probes |
| **Retention** | Unbounded growth | Tiered with automated cleanup |
| **Idempotency** | `ON CONFLICT DO NOTHING` | Content-based duplicate detection |
| **Migrations** | Manual SQL | Version-controlled with rollback |
| **Shutdown** | None | Graceful with connection draining |

These changes collectively move the health data pipeline from a development prototype to a production-ready system that can:
- Scale horizontally behind load balancers
- Integrate with Kubernetes for auto-healing
- Feed monitoring dashboards for operations teams
- Meet HIPAA data retention requirements
- Handle unreliable mobile network conditions gracefully
