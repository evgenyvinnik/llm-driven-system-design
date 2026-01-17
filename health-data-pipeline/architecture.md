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
