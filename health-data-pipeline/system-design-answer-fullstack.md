# Health Data Pipeline - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 📋 Opening Statement (1 minute)

"I'll design a health data pipeline like Apple Health, which collects metrics from multiple devices, deduplicates overlapping data, and generates actionable health insights while maintaining strict privacy. The key challenges are handling data from diverse sources with different formats, accurately deduplicating overlapping measurements from multiple devices, and protecting highly sensitive health information.

As a full-stack solution, I'll focus on the end-to-end data flow: from device sync APIs that handle unreliable mobile networks, through the aggregation pipeline that deduplicates and summarizes data, to the React dashboard that visualizes health trends. The integration points between frontend and backend - shared types, API contracts, and real-time sync status - are critical for a cohesive user experience."

---

## 🎯 Requirements Clarification (3 minutes)

### Functional Requirements
- **Ingest**: Collect data from multiple devices (Apple Watch, iPhone, third-party)
- **Process**: Aggregate, deduplicate, normalize data
- **Store**: Persist with encryption in time-series database
- **Query**: Fast access to historical data with caching
- **Visualize**: Dashboard with charts, insights, and goal tracking
- **Share**: Controlled data sharing with providers

### Non-Functional Requirements
- **Privacy**: HIPAA-compliant, per-user encryption
- **Reliability**: Zero data loss, idempotent ingestion
- **Latency**: < 1s for dashboard queries, < 100ms for cached data
- **Offline**: Cached data available when offline

### Scale Estimates
- Millions of users with health data
- ~1,500 samples per day per user
- Years of historical data
- Write-heavy: 90% writes, 10% reads

---

## 🏗️ High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                    React Frontend                         |
|  Dashboard | Trends | Insights | Devices | Sharing        |
+----------------------------------------------------------+
                           |
                    REST API + SSE
                           |
+----------------------------------------------------------+
|                    Express Backend                        |
|  +----------------+  +----------------+  +--------------+ |
|  | Ingestion API  |  |   Query API    |  |  Admin API   | |
|  | POST /sync     |  |  GET /summary  |  | GET /stats   | |
|  +----------------+  +----------------+  +--------------+ |
+----------------------------------------------------------+
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
+-------------+    +-------------+    +-------------+
|  RabbitMQ   |    |   Valkey    |    | TimescaleDB |
|  (queues)   |    |   (cache)   |    | (storage)   |
+-------------+    +-------------+    +-------------+
                           |
                           v
               +-------------------+
               | Aggregation Worker|
               | - Deduplication   |
               | - Time Bucketing  |
               | - Insights        |
               +-------------------+
```

### Core Components

| Component | Responsibility | Technology |
|-----------|----------------|------------|
| Ingestion API | Receive device sync, validate, store | Express + REST |
| Query API | Serve aggregates, summaries, insights | Express + Valkey |
| Aggregation Worker | Deduplicate, aggregate, generate insights | Node.js + RabbitMQ |
| Dashboard | Visualize metrics, trends, insights | React + Recharts |
| Device Sync | Handle offline/retry with idempotency | TanStack Query |

---

## 🔗 Shared Types Strategy (3 minutes)

### Type Contract Overview

```
+------------------+
|  shared/types/   |
|                  |
| HealthDataType   |  <-- Enum: STEPS, HEART_RATE, WEIGHT, etc.
| HealthSample     |  <-- Raw data from devices
| HealthAggregate  |  <-- Pre-computed summaries
| HealthInsight    |  <-- Generated recommendations
| DailySummary     |  <-- Dashboard display format
| METRIC_CONFIG    |  <-- Display names, units, goals
|                  |
+------------------+
         |
    +----+----+
    |         |
    v         v
+-------+  +--------+
|Backend|  |Frontend|
|       |  |        |
| Uses  |  | Uses   |
| for   |  | for    |
| API   |  | UI     |
| logic |  | render |
+-------+  +--------+
```

### Health Data Types

| Type | Display Name | Unit | Aggregation | Goal |
|------|--------------|------|-------------|------|
| STEPS | Steps | steps | sum | 10,000 |
| DISTANCE | Distance | meters | sum | - |
| HEART_RATE | Heart Rate | bpm | average | - |
| RESTING_HEART_RATE | Resting HR | bpm | average | - |
| WEIGHT | Weight | kg | latest | - |
| BODY_FAT | Body Fat | % | latest | - |
| SLEEP_ANALYSIS | Sleep | minutes | sum | - |
| ACTIVE_ENERGY | Calories | kcal | sum | 500 |
| OXYGEN_SATURATION | SpO2 | % | average | - |
| BLOOD_GLUCOSE | Glucose | mg/dL | average | - |

### Sample Data Structure

```
+----------------------+
|    HealthSample      |
+----------------------+
| id: UUID             |
| userId: string       |
| type: HealthDataType |
| value: number        |
| unit: string         |
| startDate: ISO 8601  |
| endDate: ISO 8601    |
| sourceDevice: string |
| sourceApp?: string   |
| metadata?: object    |
+----------------------+
```

### Aggregate Data Structure

```
+----------------------+
|   HealthAggregate    |
+----------------------+
| type: HealthDataType |
| period: hour/day/... |
| periodStart: ISO8601 |
| value: number        |
| minValue?: number    |
| maxValue?: number    |
| sampleCount: number  |
+----------------------+
```

---

## 📱 Deep Dive: Device Sync API (8 minutes)

### End-to-End Sync Flow

```
+----------+     +-------------+     +-------------+     +-------------+
|  Mobile  |     |   Backend   |     |   Valkey    |     | TimescaleDB |
|   App    |     |    API      |     |   (cache)   |     |  (storage)  |
+----------+     +-------------+     +-------------+     +-------------+
     |                 |                   |                   |
     | POST /sync      |                   |                   |
     | X-Idempotency   |                   |                   |
     |---------------->|                   |                   |
     |                 |                   |                   |
     |                 | Check idempotency |                   |
     |                 |------------------>|                   |
     |                 |                   |                   |
     |                 | Key not found     |                   |
     |                 |<------------------|                   |
     |                 |                   |                   |
     |                 | Validate samples  |                   |
     |                 | Normalize units   |                   |
     |                 |                   |                   |
     |                 | Batch UPSERT      |                   |
     |                 |---------------------------------------->|
     |                 |                   |                   |
     |                 | Store idempotency |                   |
     |                 | key (24h TTL)     |                   |
     |                 |------------------>|                   |
     |                 |                   |                   |
     |                 | Publish to queue  |                   |
     |                 | for aggregation   |                   |
     |                 |                   |                   |
     | 200 OK          |                   |                   |
     | synced: N       |                   |                   |
     |<----------------|                   |                   |
```

### Idempotency Key Generation

```
+-------------------------------------------+
|          Idempotency Key Sources          |
+-------------------------------------------+
|                                           |
|  Client-Generated (preferred):            |
|  +-------------------------------------+  |
|  | SHA-256(samples content)            |  |
|  |                                     |  |
|  | Hash of:                            |  |
|  | - sample types                      |  |
|  | - timestamps                        |  |
|  | - values                            |  |
|  +-------------------------------------+  |
|                                           |
|  Server-Generated (fallback):             |
|  +-------------------------------------+  |
|  | userId + deviceId + batchContent    |  |
|  +-------------------------------------+  |
|                                           |
+-------------------------------------------+

Storage in Valkey:
+---------------------------+
| Key: idempotency:{hash}   |
| Value: response JSON      |
| TTL: 24 hours             |
+---------------------------+
```

### Sample Validation Pipeline

```
For each sample in batch:

+-------------+     +----------------+     +----------------+
|   Receive   | --> | Type Validation| --> |Unit Conversion |
|   Sample    |     | (is type known)|     | (to standard)  |
+-------------+     +----------------+     +----------------+
                           |                      |
                     [Unknown type]          [Convert]
                           |                      |
                           v                      v
                    +------------+        +---------------+
                    | Add to     |        | Validated     |
                    | errors[]   |        | sample ready  |
                    +------------+        +---------------+
```

### Unit Conversion Examples

| Input | Standard | Conversion |
|-------|----------|------------|
| miles → meters | meters | × 1609.34 |
| km → meters | meters | × 1000 |
| lbs → kg | kg | × 0.453592 |
| °F → °C | °C | (°F - 32) × 5/9 |
| hours → minutes | minutes | × 60 |

### API Response Format

```
+----------------------------------+
|      DeviceSyncResponse          |
+----------------------------------+
| synced: number   (success count) |
| errors: number   (failure count) |
| errorDetails?: [                 |
|   { sample: {}, error: "..." }   |
| ]                                |
+----------------------------------+
```

---

## 📊 Deep Dive: Query API and Dashboard (8 minutes)

### Query Endpoints

| Endpoint | Purpose | Cache TTL |
|----------|---------|-----------|
| GET /users/me/summary?date= | Daily summary | 5 min |
| GET /users/me/aggregates?types=&period=&start=&end= | Historical data | 5 min |
| GET /users/me/insights | Unacknowledged insights | 1 min |

### Cache Strategy Flow

```
+----------+     +-------------+     +-------------+     +-------------+
|  React   |     |   Express   |     |   Valkey    |     | TimescaleDB |
|  Query   |     |    API      |     |   (cache)   |     |  (storage)  |
+----------+     +-------------+     +-------------+     +-------------+
     |                 |                   |                   |
     | GET /summary    |                   |                   |
     |---------------->|                   |                   |
     |                 |                   |                   |
     |                 | Check cache       |                   |
     |                 | summary:{user}    |                   |
     |                 | :{date}           |                   |
     |                 |------------------>|                   |
     |                 |                   |                   |
     |          [Cache HIT]          [Cache MISS]              |
     |                 |                   |                   |
     |                 v                   v                   |
     |           Return cached       Query DB                  |
     |                 |                   |------------------>|
     |                 |                   |                   |
     |                 |                   | Set cache (5 min) |
     |                 |                   |<------------------|
     |                 |                   |                   |
     | JSON response   |<------------------|                   |
     |<----------------|                   |                   |
```

### Dashboard Component Hierarchy

```
+--------------------------------------------------------+
|                     Dashboard                           |
|  +-----------------------------+  +-----------------+  |
|  |      Date Navigation        |  | Sync Status     |  |
|  | [< Prev] [Today] [Next >]   |  | [● Connected]   |  |
|  +-----------------------------+  +-----------------+  |
|                                                         |
|  +--------------------------------------------------+  |
|  |              Insights Banner (if any)             |  |
|  | [!] Your heart rate trend is increasing...        |  |
|  +--------------------------------------------------+  |
|                                                         |
|  Activity Section                                       |
|  +---------------+ +---------------+ +---------------+  |
|  | Steps         | | Distance      | | Calories      |  |
|  | 8,245 / 10K   | | 6.2 km        | | 412 / 500     |  |
|  | [=====>    ]  | | [========>]   | | [======>  ]   |  |
|  +---------------+ +---------------+ +---------------+  |
|                                                         |
|  Vitals Section                                         |
|  +---------------+ +---------------+ +---------------+  |
|  | Heart Rate    | | Resting HR    | | SpO2          |  |
|  | 72 bpm        | | 58 bpm        | | 98%           |  |
|  | [avg today]   | | [trend: ↓]    | | [normal]      |  |
|  +---------------+ +---------------+ +---------------+  |
|                                                         |
|  Body Section                                           |
|  +----------------------+ +----------------------+      |
|  | Weight               | | Sleep                |      |
|  | 72.5 kg              | | 7h 23m               |      |
|  | [trend: stable]      | | [last night]         |      |
|  +----------------------+ +----------------------+      |
+--------------------------------------------------------+
```

### React Query Configuration

| Query Key | Stale Time | Refetch Strategy |
|-----------|------------|------------------|
| dailySummary | 5 min | On focus, on mount |
| aggregates | 5 min | On focus |
| insights | 1 min | On focus, on mount |
| devices | 30 min | On focus |

### Sync Status SSE Connection

```
+----------+              +-------------+
|  React   |              |   Express   |
|  Client  |              |    SSE      |
+----------+              +-------------+
     |                          |
     | GET /sync-status         |
     | Accept: text/event-stream|
     |------------------------->|
     |                          |
     |   Headers:               |
     |   Content-Type: text/    |
     |   event-stream           |
     |   Connection: keep-alive |
     |                          |
     |   data: {"syncing":true} |
     |<-------------------------|
     |                          |
     |   data: {"syncing":false,|
     |    "lastSync": "..."}    |
     |<-------------------------|
     |                          |
     |   [Connection held open] |
     |                          |
```

---

## 🔄 Deep Dive: Aggregation Worker (8 minutes)

### Message Queue Job Structure

```
+--------------------------------+
|     AggregationJob Message     |
+--------------------------------+
| userId: string                 |
| sampleTypes: [STEPS, HEART_RATE] |
| dateRange: {                   |
|   start: "2024-01-15",         |
|   end: "2024-01-15"            |
| }                              |
+--------------------------------+
```

### Aggregation Pipeline

```
+-------------+     +---------------+     +-------------+
| Fetch Raw   | --> | Deduplicate   | --> | Aggregate   |
| Samples     |     | by Priority   |     | by Period   |
+-------------+     +---------------+     +-------------+
                                                 |
                    +----------------------------+
                    |
                    v
+-------------+     +---------------+     +-------------+
| Store       | --> | Invalidate    | --> | Generate    |
| Aggregates  |     | Cache Keys    |     | Insights    |
+-------------+     +---------------+     +-------------+
```

### Device Priority for Deduplication

| Device Type | Priority | Rationale |
|-------------|----------|-----------|
| Apple Watch | 100 | Medical-grade sensors |
| iPhone | 80 | Good sensors, always carried |
| iPad | 70 | Less often carried |
| Third-party wearable | 50 | Variable sensor quality |
| Third-party scale | 40 | Single measurement type |
| Manual entry | 10 | User estimates |

### Deduplication Algorithm

```
Input: Samples sorted by device priority (highest first)

For each sample:

+---------------------------------------------------+
|  Check overlap with covered time ranges           |
+---------------------------------------------------+
           |                    |                 |
      [No Overlap]        [Partial Overlap]   [Full Overlap]
           |                    |                 |
           v                    v                 v
    +-------------+    +----------------+   +-------------+
    | Include     |    | Adjust value   |   | Skip sample |
    | full sample |    | proportionally |   | (already    |
    +-------------+    | (for sum       |   | covered)    |
           |           | metrics only)  |   +-------------+
           |           +----------------+
           |                    |
           v                    v
    +--------------------------------------+
    |  Add time range to covered ranges   |
    +--------------------------------------+
```

### Overlap Detection Visual

```
Higher Priority Sample (Apple Watch):
|======================|
10:00               11:00

Lower Priority Sample (iPhone):
           |======================|
          10:30               11:30

Result:
- 10:00-10:30: Covered by Watch (kept)
- 10:30-11:00: Overlap (Watch takes precedence)
- 11:00-11:30: No overlap (iPhone fills gap)

For sum metrics (steps):
- iPhone value × (remaining_time / total_time)
- iPhone 1000 steps × (30min / 60min) = 500 steps
```

### Aggregation Strategy by Metric

| Metric Type | Strategy | Hourly | Daily |
|-------------|----------|--------|-------|
| STEPS | sum | ✓ | ✓ |
| DISTANCE | sum | ✓ | ✓ |
| HEART_RATE | average | ✓ | ✓ |
| WEIGHT | latest | - | ✓ |
| SLEEP_ANALYSIS | sum | - | ✓ |
| ACTIVE_ENERGY | sum | ✓ | ✓ |

### Cache Invalidation After Aggregation

```
After storing new aggregates:

+-------------------------------------------+
|  For each affected date in range:         |
|                                           |
|  DEL summary:{userId}:{date}              |
|                                           |
|  This forces next query to:               |
|  1. Miss cache                            |
|  2. Query fresh aggregates from DB        |
|  3. Re-populate cache                     |
+-------------------------------------------+
```

---

## 🔐 Deep Dive: Share Token System (5 minutes)

### Share Token Data Model

```
+----------------------------------+
|          share_tokens            |
+----------------------------------+
| id: UUID (PK)                    |
| user_id: UUID (FK)               |
| recipient_email: string          |
| data_types: [STEPS, HEART_RATE]  |
| date_start: date                 |
| date_end: date                   |
| expires_at: timestamp            |
| access_code: string (12 chars)   |
| revoked_at: timestamp (nullable) |
| created_at: timestamp            |
+----------------------------------+
```

### Share Token Flow

```
+--------+     +-------------+     +-------------+     +--------+
|  User  |     |   Backend   |     | TimescaleDB |     |Provider|
+--------+     +-------------+     +-------------+     +--------+
    |                |                   |                  |
    | Create Share   |                   |                  |
    | POST /tokens   |                   |                  |
    |--------------->|                   |                  |
    |                |                   |                  |
    |                | Generate access   |                  |
    |                | code (12 chars)   |                  |
    |                |                   |                  |
    |                | Store token       |                  |
    |                |------------------>|                  |
    |                |                   |                  |
    | Return URL     |                   |                  |
    | /shared/{code} |                   |                  |
    |<---------------|                   |                  |
    |                |                   |                  |
    | Send link to   |                   |                  |
    | provider       |                   |                  |
    |------------------------------------------->|         |
    |                |                   |                  |
    |                | GET /data/{code}  |                  |
    |                |<------------------------------------ |
    |                |                   |                  |
    |                | Validate token    |                  |
    |                | (not expired,     |                  |
    |                |  not revoked)     |                  |
    |                |------------------>|                  |
    |                |                   |                  |
    |                | Fetch authorized  |                  |
    |                | data only         |                  |
    |                |<------------------|                  |
    |                |                   |                  |
    |                | Return filtered   |                  |
    |                | health data       |                  |
    |                |------------------------------------->|
```

### Share Modal UI

```
+----------------------------------------+
|          Share Health Data             |
+----------------------------------------+
|                                        |
| Recipient Email:                       |
| +------------------------------------+ |
| | doctor@hospital.com                | |
| +------------------------------------+ |
|                                        |
| Data Types:                            |
| +--------+ +-------+ +--------+        |
| | Steps  | | Heart | | Weight |        |
| |  [x]   | |  [x]  | |  [ ]   |        |
| +--------+ +-------+ +--------+        |
| +--------+ +-------+                   |
| | Sleep  | | SpO2  |                   |
| |  [x]   | |  [ ]  |                   |
| +--------+ +-------+                   |
|                                        |
| Date Range:                            |
| +----------------+ +----------------+  |
| | Start: 1/1/24  | | End: 1/31/24   |  |
| +----------------+ +----------------+  |
|                                        |
| Link Expires In:                       |
| +------------------------------------+ |
| | 30 days                        [v] | |
| +------------------------------------+ |
|                                        |
| +----------------+ +----------------+  |
| |    Cancel      | | Create Link    |  |
| +----------------+ +----------------+  |
+----------------------------------------+
```

### Token Validation Rules

```
Token is valid if ALL conditions met:

+-------------------------------------------+
| 1. access_code exists in database         |
| 2. expires_at > NOW()                     |
| 3. revoked_at IS NULL                     |
+-------------------------------------------+

Data access is restricted to:

+-------------------------------------------+
| 1. Only data_types in token               |
| 2. Only dates within date_start/date_end  |
| 3. Only daily aggregates (not raw samples)|
+-------------------------------------------+
```

---

## ⚖️ Trade-offs and Alternatives (5 minutes)

### Architecture Decisions

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Time-series DB | ✅ TimescaleDB | ❌ InfluxDB | SQL compatibility, can join with users/devices tables |
| Aggregation | ✅ Pre-computed + queue | ❌ On-demand | Fast dashboard queries, background processing absorbs load |
| Deduplication | ✅ Priority-based | ❌ Latest-wins | Apple Watch sensors more accurate; consistent behavior |
| Sync | ✅ Batch with idempotency | ❌ Real-time streaming | Battery efficiency, network resilience, simpler retry logic |
| Caching | ✅ Valkey with invalidation | ❌ React Query only | Shared cache across API instances, faster cold loads |
| Charts | ✅ Recharts | ❌ D3.js | React-native, declarative API, good for time-series |

### Full-Stack Trade-off: Shared Types

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Monorepo with shared package | Single source of truth, TypeScript catches mismatches at build | More complex build setup | ✅ Chosen |
| Separate type definitions | Independent deployments | Types can drift, runtime errors | ❌ Rejected |
| Runtime validation only | Flexible schemas | No compile-time safety | ❌ Rejected |

### Full-Stack Trade-off: Cache Invalidation

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Backend-initiated invalidation | Cache always consistent after aggregation, fresh data | Slightly more complex worker | ✅ Chosen |
| TTL-only caching | Simpler implementation | Stale data shown for TTL duration | ❌ Rejected |
| Pub/sub invalidation | Real-time updates | Infrastructure complexity | ❌ Rejected |

### Full-Stack Trade-off: Sync Feedback

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| SSE for status updates | Real-time, efficient long-polling | Persistent connection overhead | ✅ Chosen |
| WebSocket | Bidirectional | Overkill for status-only | ❌ Rejected |
| Polling | Simpler | Battery drain, delayed feedback | ❌ Rejected |

---

## 🚀 Closing Summary (1 minute)

"The health data pipeline is built as a cohesive full-stack system with three key integration points:

**1. Shared Types** - TypeScript types for health samples, aggregates, and insights are shared between frontend and backend. The METRIC_CONFIG object defines display names, units, and aggregation strategies in one place. This catches API contract violations at build time.

**2. Idempotent Sync** - The device sync API uses content-based idempotency keys that can be generated on both client and server. This enables safe retries on unreliable mobile networks while preventing duplicate data. Keys are hashed from sample content.

**3. Cache Coordination** - The aggregation worker invalidates Valkey cache entries after computing new aggregates. React Query on the frontend respects staleTime for optimistic performance while the backend ensures cache consistency through explicit invalidation.

The main trade-off is complexity for correctness:
- Shared types require monorepo setup, but catch mismatches at compile time
- Priority-based deduplication is more complex than last-write-wins, but ensures accurate step counts when users carry both iPhone and Apple Watch
- Backend cache invalidation adds worker complexity, but guarantees users see fresh data after sync"
