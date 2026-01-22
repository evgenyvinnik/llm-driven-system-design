# Health Data Pipeline - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Opening Statement (1 minute)

"I'll design a health data pipeline like Apple Health, which collects metrics from multiple devices, deduplicates overlapping data, and generates actionable health insights while maintaining strict privacy. The key challenges are handling data from diverse sources with different formats, accurately deduplicating overlapping measurements from multiple devices, and protecting highly sensitive health information.

From a backend perspective, the core technical challenges are building a priority-based deduplication algorithm that handles overlapping time ranges, implementing efficient time-series storage with TimescaleDB hypertables, designing idempotent ingestion for unreliable mobile networks, and ensuring HIPAA-compliant data retention policies."

---

## 🎯 Requirements Clarification (3 minutes)

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

---

## 🏗️ High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                      Data Sources                         |
|   Apple Watch | iPhone | Third-Party (scales, BP, etc.)  |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                  Ingestion Service (REST API)             |
|    Validation | Normalization | Idempotency Check         |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|              Message Queue (RabbitMQ)                     |
|      health-aggregation | health-insights queues          |
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
|                     Storage Layer                         |
|    TimescaleDB (hypertables) | Valkey (cache, sessions)   |
|              MinIO (exports, archives)                    |
+----------------------------------------------------------+
```

### Core Backend Components

| Component | Responsibility |
|-----------|----------------|
| Ingestion Service | Validates, normalizes, and inserts samples with idempotency |
| Aggregation Worker | Consumes queue, deduplicates, and computes aggregates |
| Insights Worker | Analyzes aggregates for trends and alerts |
| Query API | Serves samples, aggregates, and summaries with caching |

---

## 📊 Deep Dive: Database Schema (8 minutes)

### TimescaleDB Hypertables

TimescaleDB provides automatic time-based partitioning for efficient range queries on health data.

```
+------------------+       +-------------------+       +------------------+
|      users       |       |   user_devices    |       | health_samples   |
+------------------+       +-------------------+       +------------------+
| id (PK, UUID)    |<------| user_id (FK)      |       | id (PK, UUID)    |
| email            |       | device_type       |------>| user_id (FK)     |
| password_hash    |       | device_name       |       | type             |
| name             |       | device_identifier |       | value            |
| role             |       | priority          |       | unit             |
| created_at       |       | last_sync         |       | start_date       |
+------------------+       +-------------------+       | end_date         |
                                                       | source_device    |
                                                       | source_device_id |
                                                       | metadata (JSONB) |
                                                       +------------------+
                                                              |
                                            (hypertable, partitioned by start_date)
```

### Device Priority Ranking

Higher priority = more trusted sensors for deduplication:

| Device Type | Priority | Rationale |
|-------------|----------|-----------|
| Apple Watch | 100 | Direct skin contact, medical-grade sensors |
| iPhone | 80 | Motion sensors, CoreMotion integration |
| iPad | 70 | Similar to iPhone but less commonly carried |
| Third-party wearable | 50 | Variable sensor quality |
| Third-party scale | 40 | Single-purpose, less frequent |
| Manual entry | 10 | Prone to user error |

### Pre-Computed Aggregates

```
+----------------------+       +-------------------+
|  health_aggregates   |       |  health_insights  |
+----------------------+       +-------------------+
| id (PK)              |       | id (PK)           |
| user_id (FK)         |       | user_id (FK)      |
| type                 |       | type              |
| period (hour/day/wk) |       | severity          |
| period_start         |       | direction         |
| value                |       | message           |
| min_value            |       | recommendation    |
| max_value            |       | data (JSONB)      |
| sample_count         |       | acknowledged      |
+----------------------+       | created_at        |
       |                       +-------------------+
(hypertable, partitioned by period_start)
```

### Indexes for Query Patterns

| Index | Columns | Purpose |
|-------|---------|---------|
| idx_samples_user_type | (user_id, type, start_date DESC) | Dashboard queries |
| idx_samples_device | (source_device_id) | Device-specific filtering |
| idx_aggregates_user_type | (user_id, type, period, period_start DESC) | Chart data |
| idx_insights_unread | (user_id, acknowledged) WHERE acknowledged = false | Unread alerts |

### Compression Policy

```
                     Data Age Lifecycle
    +----------------+----------------+----------------+
    |    0-90 days   |  90 days-2 yr  |    2-7 years   |
    |      HOT       |      WARM      |      COLD      |
    +----------------+----------------+----------------+
    | Uncompressed   | Compressed     | MinIO Archive  |
    | ~5ms queries   | ~50ms queries  | Minutes to     |
    | Full updates   | Read-only      | restore        |
    +----------------+----------------+----------------+
                         |
            Compression ratio: ~10:1 for numeric health data
```

---

## 🔄 Deep Dive: Ingestion with Idempotency (8 minutes)

### Device Sync Flow

```
+--------+     POST /api/devices/:id/sync     +------------+
| Device |---------------------------------->| Ingestion  |
|        |     { samples: [...] }            | Service    |
+--------+     X-Idempotency-Key: abc123     +------------+
                                                   |
                   +-------------------------------+
                   |
                   v
        +-------------------+
        | Check Idempotency |
        | Key in Cache      |
        +-------------------+
               |
      +--------+--------+
      |                 |
   (cache hit)     (cache miss)
      |                 |
      v                 v
+-------------+   +---------------+
| Return      |   | Process Sync  |
| Cached      |   | - Validate    |
| Response    |   | - Normalize   |
+-------------+   | - Batch Insert|
                  +---------------+
                         |
                         v
                  +---------------+
                  | Store Response|
                  | in Cache      |
                  | (24h TTL)     |
                  +---------------+
                         |
                         v
                  +---------------+
                  | Queue for     |
                  | Aggregation   |
                  +---------------+
```

### Idempotency Key Generation

When client doesn't provide a key, generate from content:

```
Idempotency Key = SHA256(userId + deviceId + JSON(samples))
```

This ensures identical sync payloads produce the same key, preventing duplicate processing on retries.

### Batch Insert with UPSERT

```
         Batch Insert Flow
+--------------------------------+
|     Incoming Samples (N)       |
+--------------------------------+
               |
               v
+--------------------------------+
|   Validate Each Sample         |
|   - Type exists               |
|   - Value in valid range      |
|   - Dates are valid           |
+--------------------------------+
        |              |
   (valid)        (invalid)
        |              |
        v              v
+---------------+  +-------------+
| Valid Samples |  | Error List  |
| Array         |  | with reason |
+---------------+  +-------------+
        |
        v
+--------------------------------+
| Bulk INSERT with               |
| ON CONFLICT (id) DO NOTHING    |
+--------------------------------+
        |
        v
+--------------------------------+
| Return: { synced: X,          |
|           errors: Y }          |
+--------------------------------+
```

### Idempotency Key Storage

| Column | Type | Description |
|--------|------|-------------|
| key | VARCHAR(255) PK | SHA256 hash |
| user_id | UUID FK | Owner of the request |
| request_hash | VARCHAR(64) | Original payload hash |
| response | JSONB | Cached response |
| created_at | TIMESTAMP | When created |
| expires_at | TIMESTAMP | When to delete (24h) |

Daily cleanup job removes expired keys.

---

## 🔀 Deep Dive: Deduplication Algorithm (8 minutes)

### Priority-Based Overlap Resolution

When the same metric comes from multiple devices (steps from Apple Watch and iPhone), we must deduplicate to avoid double-counting.

```
           Deduplication Algorithm
+----------------------------------------+
|    Raw Samples for Time Window         |
|    (e.g., 9:00 AM - 10:00 AM)          |
+----------------------------------------+
                    |
                    v
+----------------------------------------+
| Sort by Device Priority (DESC)         |
| Apple Watch (100) first                |
+----------------------------------------+
                    |
                    v
+----------------------------------------+
| Initialize: covered_ranges = []        |
| Initialize: result = []                |
+----------------------------------------+
                    |
                    v
        +------------------------+
        | For each sample:       |
        +------------------------+
                    |
                    v
+----------------------------------------+
| Check overlap with covered_ranges      |
+----------------------------------------+
        |           |           |
   (no overlap)  (partial)  (full overlap)
        |           |           |
        v           v           v
+----------+  +------------+  +--------+
| Include  |  | Adjust for |  | Skip   |
| full     |  | non-overlap|  | sample |
| sample   |  | portion    |  |        |
+----------+  +------------+  +--------+
        |           |
        v           v
+----------------------------------------+
| Add time range to covered_ranges       |
+----------------------------------------+
```

### Overlap Types

```
Case 1: No Overlap
Apple Watch: |-------|
iPhone:                   |-------|
Result: Include both samples

Case 2: Partial Overlap
Apple Watch: |---------|
iPhone:           |---------|
Result: Include Watch fully, iPhone only for non-overlapping portion

Case 3: Full Overlap (iPhone completely covered)
Apple Watch: |-------------|
iPhone:         |-------|
Result: Include Watch only, skip iPhone entirely
```

### Value Adjustment for Partial Overlap

For sum-based metrics (steps, calories), adjust proportionally:

```
Original iPhone sample:
  Time: 9:30-10:30, Value: 2000 steps

Apple Watch covers 9:30-10:00 (50% overlap)

Adjusted iPhone sample:
  Time: 10:00-10:30, Value: 1000 steps (50% of original)
```

### Aggregation Strategies by Metric Type

| Metric Type | Strategy | Example |
|-------------|----------|---------|
| Steps | sum | Total steps for the day |
| Distance | sum | Total distance walked |
| Heart Rate | average | Average BPM for the hour |
| Resting Heart Rate | average | Average resting BPM |
| Weight | latest | Most recent measurement |
| Body Fat | latest | Most recent measurement |
| Sleep | sum | Total minutes asleep |
| Active Energy | sum | Total calories burned |
| Blood Glucose | average | Average reading |
| Oxygen Saturation | average | Average SpO2 |

### Store Aggregates with UPSERT

Aggregates are stored/updated using UPSERT to handle reprocessing:

```
INSERT ... ON CONFLICT (user_id, type, period, period_start)
DO UPDATE SET
  value = EXCLUDED.value,
  min_value = EXCLUDED.min_value,
  max_value = EXCLUDED.max_value,
  sample_count = EXCLUDED.sample_count,
  updated_at = NOW()
```

---

## 💡 Deep Dive: Insights Engine (5 minutes)

### Trend Detection with Linear Regression

```
         Insights Generation Pipeline
+------------------------------------------+
|    Aggregation Worker publishes to       |
|    health-insights queue                 |
+------------------------------------------+
                     |
                     v
+------------------------------------------+
|    Insights Worker consumes message      |
|    { userId, types: [...], dateRange }   |
+------------------------------------------+
                     |
    +----------------+----------------+
    |                |                |
    v                v                v
+--------+     +----------+     +--------+
| Heart  |     | Activity |     | Sleep  |
| Rate   |     | Analysis |     | Deficit|
| Trend  |     |          |     | Check  |
+--------+     +----------+     +--------+
    |                |                |
    +----------------+----------------+
                     |
                     v
+------------------------------------------+
|    Store insights in health_insights     |
|    table (if threshold exceeded)         |
+------------------------------------------+
```

### Heart Rate Trend Detection

Uses linear regression over 30 days of resting heart rate:

```
Linear Regression Formula:
slope = (n * ΣXY - ΣX * ΣY) / (n * ΣX² - (ΣX)²)

Where:
  X = day index (0, 1, 2, ... 29)
  Y = resting heart rate value
  n = number of data points

Alert triggered if |slope| > 0.5 BPM/day
```

### Activity Comparison Logic

```
+--------------------------------+
| Calculate this week's steps    |
| (SUM of daily aggregates)      |
+--------------------------------+
              |
              v
+--------------------------------+
| Calculate 4-week average       |
| (AVG of weekly totals)         |
+--------------------------------+
              |
              v
+--------------------------------+
| Percent change =               |
| (current - average) / average  |
+--------------------------------+
              |
      +-------+-------+
      |               |
   (> +20%)       (< -20%)
      |               |
      v               v
+------------+  +-------------+
| "Great job |  | "Activity   |
| - X% more  |  | down - X%   |
| active!"   |  | this week"  |
+------------+  +-------------+
```

### Insight Types

| Insight | Trigger Condition | Severity |
|---------|-------------------|----------|
| Heart Rate Trend | slope > 0.5 BPM/day for 30 days | medium |
| Sleep Deficit | avg < 6 hours for 14 days | high |
| Activity Change | > 20% change from 4-week avg | low |
| Weight Change | > 3% change over 30 days | medium |

---

## 🔒 Deep Dive: Share Token System (3 minutes)

```
+------------------+       +-------------------+
|   share_tokens   |       |  Shared Data      |
+------------------+       |  Access Flow      |
| id (PK)          |       +-------------------+
| user_id (FK)     |              |
| recipient_email  |              v
| recipient_id     |       +-------------------+
| data_types[]     |       | 1. Validate token |
| date_start       |       |    - Not expired  |
| date_end         |       |    - Not revoked  |
| expires_at       |       |    - Recipient OK |
| access_code      |       +-------------------+
| revoked_at       |              |
+------------------+              v
                           +-------------------+
                           | 2. Query only:    |
                           |    - Allowed types|
                           |    - Date range   |
                           |    - User's data  |
                           +-------------------+
                                  |
                                  v
                           +-------------------+
                           | 3. Return daily   |
                           |    aggregates     |
                           +-------------------+
```

### Share Token Fields

| Field | Purpose |
|-------|---------|
| data_types[] | Only these metric types accessible (e.g., ['HEART_RATE', 'WEIGHT']) |
| date_start/end | Only data within this range accessible |
| expires_at | Token becomes invalid after this time |
| access_code | Random 64-char string for URL sharing |
| revoked_at | If set, token is immediately invalid |

---

## ⚖️ Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Time-series DB | ✅ TimescaleDB | ❌ InfluxDB | SQL compatibility, PostgreSQL ecosystem, familiar query language |
| Aggregation | ✅ Pre-computed | ❌ On-demand | Query performance for dashboards (O(1) vs O(n)), write-heavy workload absorbs compute |
| Deduplication | ✅ Priority-based | ❌ Time-based (latest wins) | Apple Watch sensors more accurate than iPhone; consistent, predictable behavior |
| Sync | ✅ Batch with idempotency | ❌ Real-time streaming | Battery efficiency on mobile, network reliability, simpler recovery |
| Encryption | ✅ Per-user keys | ❌ Single system key | HIPAA compliance, selective sharing, breach isolation |
| Queue | ✅ RabbitMQ | ❌ Kafka | Simpler for single-consumer patterns, built-in retry/DLQ |

### Storage Tiering Trade-offs

| Tier | Pros | Cons |
|------|------|------|
| Hot (90 days uncompressed) | Fast queries (~5ms) | More storage (~5MB per user per 90 days) |
| Warm (compressed chunks) | 10:1 compression ratio | Slower queries (~50ms), read-only |
| Cold (MinIO archive) | Cheapest storage | Minutes to restore |

### Pre-computation vs On-demand

**Chose: Pre-computed aggregates**

| Factor | Pre-computed | On-demand |
|--------|--------------|-----------|
| Dashboard load | O(1) - single row lookup | O(n) - scan all samples |
| Storage cost | Higher (store aggregates) | Lower |
| Write complexity | Higher (background workers) | Lower |
| User experience | Instant | Potentially slow |

Decision: Storage is cheap; user wait time is expensive.

---

## 📅 Data Retention and HIPAA Compliance (2 minutes)

| Data Type | Hot | Warm | Delete After |
|-----------|-----|------|--------------|
| Raw samples | 90 days | 2 years | 7 years |
| Hourly aggregates | 90 days | N/A | 2 years |
| Daily aggregates | Forever | N/A | Never |
| Insights | 90 days | N/A | 2 years |
| Share tokens | Until expiry | N/A | 30 days after expiry |

### Daily Retention Job

```
Retention Cleanup (runs daily at 3 AM)
+----------------------------------------+
| DELETE health_samples                  |
| WHERE start_date < NOW() - 7 years     |
+----------------------------------------+
                |
                v
+----------------------------------------+
| DELETE health_aggregates               |
| WHERE period = 'hour'                  |
| AND period_start < NOW() - 2 years     |
+----------------------------------------+
                |
                v
+----------------------------------------+
| DELETE health_insights                 |
| WHERE created_at < NOW() - 2 years     |
+----------------------------------------+
                |
                v
+----------------------------------------+
| DELETE share_tokens                    |
| WHERE expires_at < NOW() - 30 days     |
+----------------------------------------+
```

---

## 🚀 Closing Summary (1 minute)

"The health data pipeline backend is built around three key principles:

1. **Priority-based deduplication** - When the same metric comes from multiple devices, we prioritize by sensor quality (Apple Watch > iPhone > third-party). Overlapping time ranges are proportionally adjusted for sum-based metrics.

2. **Idempotent ingestion** - Mobile devices on unreliable networks can safely retry sync requests. Content-based idempotency keys prevent duplicate processing without requiring client-side key management.

3. **Tiered storage with pre-computed aggregates** - TimescaleDB hypertables provide efficient time-series queries. Pre-computed hourly and daily aggregates enable fast dashboard rendering. Automatic compression reduces storage costs for older data.

The main trade-off is complexity for accuracy. Priority-based deduplication with overlap handling is more complex than simply taking the latest value, but it ensures accurate totals for metrics like steps where double-counting would mislead users about their health."
