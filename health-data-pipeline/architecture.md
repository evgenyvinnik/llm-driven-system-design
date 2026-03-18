# Design Health Data Pipeline - Architecture

## System Overview

A health data aggregation pipeline collecting metrics from multiple devices, processing and deduplicating data, and generating health insights while maintaining strict privacy. Core challenges involve multi-source ingestion, data quality, and privacy protection.

**Learning Goals:**
- Build multi-source data ingestion
- Design data deduplication algorithms
- Implement privacy-preserving processing
- Handle time-series health data at scale

## Requirements

### Functional Requirements

1. **Ingest** - Collect health data from multiple devices (wearables, phones, third-party sensors) via batch sync API
2. **Process** - Aggregate, deduplicate, and normalize data from overlapping sources using device priority ranking
3. **Store** - Persist time-series data with encryption, tiered retention, and compression
4. **Query** - Fast access to historical data, pre-computed aggregates, and daily summaries
5. **Insights** - Generate health trend analysis, sleep deficit alerts, and activity change notifications
6. **Share** - Controlled, time-limited data sharing with doctors and family via share tokens

### Non-Functional Requirements

| Requirement | Target (Production) |
|-------------|-------------------|
| Privacy | All data encrypted at rest and in transit, per-user encryption keys |
| Reliability | Zero data loss -- sync acknowledgment only after durable write |
| Query latency (p99) | < 100ms for aggregated data, < 1s for raw sample queries |
| Ingestion throughput | 50,000 samples/second across all users |
| Availability | 99.99% for read path, 99.9% for write path |
| Compliance | HIPAA-ready architecture with 7-year retention for raw samples |
| Data freshness | Aggregates updated within 60 seconds of sync |

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Users | 10M active |
| Samples per user per day | ~1,500 (heart rate 1/min + hourly steps + daily vitals) |
| Total daily ingest | ~15B samples |
| Raw sample size | ~100 bytes average |
| Daily storage growth | ~1.5 TB (raw) + ~50 GB (aggregates) |
| Hot storage (90 days) | ~135 TB raw + ~4.5 TB aggregates |
| Read QPS (dashboards) | ~100K (dominated by aggregate queries) |
| Write QPS (syncs) | ~50K samples/s during peak sync windows |

### Local Development Scale

| Metric | Estimate |
|--------|----------|
| Users | 2-5 seeded |
| Samples per user | ~500 seeded |
| Storage | < 50 MB |
| Concurrent requests | 1-3 |

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
                              │ HTTPS (encrypted batch sync)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / Load Balancer                    │
│         (TLS termination, rate limiting, auth)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Ingestion API  │ │  Query API      │ │  Admin API      │
│  (write path)   │ │  (read path)    │ │  (ops)          │
│                 │ │                 │ │                 │
│ - Validation    │ │ - Samples       │ │ - User mgmt    │
│ - Normalize     │ │ - Aggregates    │ │ - Reaggregate   │
│ - Idempotency   │ │ - Summaries     │ │ - Stats         │
│ - Batch upsert  │ │ - History       │ │ - Retention     │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   │                   │
┌─────────────────┐          │                   │
│  Message Queue  │          │                   │
│  (RabbitMQ)     │          │                   │
│                 │          │                   │
│ - aggregation   │          │                   │
│ - insights      │          │                   │
│ - dead-letter   │          │                   │
└────────┬────────┘          │                   │
         │                   │                   │
         ▼                   │                   │
┌─────────────────┐          │                   │
│  Workers        │          │                   │
│  (Background)   │          │                   │
│                 │          │                   │
│ - Deduplication │          │                   │
│ - Aggregation   │          │                   │
│ - Insight gen   │          │                   │
│ - Retention     │          │                   │
└────────┬────────┘          │                   │
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Data Layer                                    │
│                                                                   │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────┐       │
│  │  TimescaleDB    │  │  Redis /     │  │  Object Store │       │
│  │  (PostgreSQL)   │  │  Valkey      │  │  (S3 / MinIO) │       │
│  │                 │  │              │  │               │       │
│  │ - Hypertables   │  │ - Sessions   │  │ - Archives    │       │
│  │ - Compression   │  │ - Agg cache  │  │ - Exports     │       │
│  │ - Partitioned   │  │ - Idempotency│  │ - Backups     │       │
│  └─────────────────┘  └──────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### Data Types and Validation

The system supports 16 health data types across 4 categories, each with a defined unit and aggregation strategy:

| Category | Types | Unit | Aggregation |
|----------|-------|------|-------------|
| Activity | Steps, Distance, Active Energy | count, meters, kcal | sum |
| Vitals | Heart Rate, Resting HR, BP Systolic, BP Diastolic, Blood Glucose, SpO2 | bpm, mmHg, mg/dL, % | average |
| Body | Weight, Body Fat | kg, % | latest |
| Sleep | Sleep Analysis, Sleep State | minutes, enum | sum |

Each incoming sample is validated: type must be recognized, unit must match the type's canonical unit (with automatic conversion if needed), and timestamps must be reasonable (not in the future, not more than 1 year old).

### Device Sync Service

Handles batch sync from mobile devices. The sync protocol:

1. Device sends a batch of samples with an `X-Idempotency-Key` header
2. Server checks idempotency cache (Redis) -- if key exists, return cached response
3. Each sample is validated and normalized to canonical units
4. Valid samples are bulk-inserted with `ON CONFLICT (id) DO NOTHING` to handle duplicates
5. Aggregation jobs are queued for affected date ranges and data types
6. Response includes count of synced samples, errors, and error details

Error handling is per-sample: one invalid sample does not reject the entire batch. This is critical for mobile sync where network conditions cause retries.

### Deduplication Algorithm

When multiple devices measure the same metric (e.g., Apple Watch and iPhone both count steps), the deduplication algorithm resolves overlaps using device priority:

1. **Priority ranking**: Apple Watch (100) > iPhone (80) > iPad (70) > Third-party wearable (50) > Third-party scale (40) > Manual entry (10)
2. **Sort all samples** for a given type and time range by source device priority (highest first)
3. **For each sample**, check against already-covered time ranges:
   - **No overlap**: Include the full sample
   - **Full overlap**: Skip (higher-priority source already covers this period)
   - **Partial overlap**: Proportionally adjust the value for the non-overlapping portion

This approach is deterministic and idempotent -- re-running deduplication on the same data produces the same result regardless of order of insertion.

### Aggregation Pipeline

After deduplication, samples are aggregated into hourly and daily buckets:

| Strategy | Metrics | Computation |
|----------|---------|-------------|
| `sum` | Steps, Distance, Calories, Sleep | Total for the period |
| `average` | Heart Rate, Blood Pressure, SpO2 | Mean value with sample count |
| `latest` | Weight, Body Fat | Most recent value in the period |

Aggregates are stored with `ON CONFLICT DO UPDATE` so re-aggregation (after a bug fix or late-arriving data) atomically replaces old values. Both `min_value` and `max_value` are tracked alongside the primary aggregate for range queries.

### Insights Engine

Analyzes aggregated data to generate health recommendations using simple statistical methods:

1. **Heart Rate Trend** - Linear regression over 30 days of resting heart rate. Alerts if slope exceeds +/- 0.5 bpm/day (clinically significant sustained change)
2. **Sleep Deficit** - Average sleep over 14 days. Alerts if below 6 hours (medium severity) or 5 hours (high severity)
3. **Activity Change** - Compares current week's steps to 4-week rolling average. Alerts on > 20% change in either direction
4. **Weight Change** - Detects > 3% body weight change over 30 days

Insights are stored in the `health_insights` table with severity, direction, message, and supporting data. Users can acknowledge insights to dismiss them from the dashboard.

### Privacy Layer

Health data requires defense-in-depth privacy protection:

- **Encryption at rest**: PostgreSQL `pgcrypto` for column-level encryption of sensitive values; TimescaleDB transparent data encryption for the storage layer
- **Per-user encryption keys**: Derived from user credentials, enabling data to be shared only with explicit key derivation for recipients
- **Share tokens**: Time-limited, scope-limited (specific data types, date ranges) tokens with access codes. Revocable at any time
- **Minimal exposure**: API responses never include data outside the authenticated user's scope. Admin endpoints show only aggregate statistics, never individual health data

## Database Schema

### Core Tables

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type VARCHAR(50) NOT NULL,
  device_name VARCHAR(100),
  device_identifier VARCHAR(255),
  priority INTEGER DEFAULT 50,
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_identifier)
);

CREATE INDEX idx_devices_user ON user_devices(user_id);
```

### Health Data Tables (TimescaleDB Hypertables)

```sql
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

SELECT create_hypertable('health_samples', 'start_date', if_not_exists => TRUE);
CREATE INDEX idx_samples_user_type ON health_samples(user_id, type, start_date DESC);
CREATE INDEX idx_samples_device ON health_samples(source_device_id);

CREATE TABLE health_aggregates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  period VARCHAR(10) NOT NULL,
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
```

### Insights and Sharing

```sql
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
CREATE INDEX idx_insights_unread ON health_insights(user_id, acknowledged) WHERE acknowledged = false;

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

CREATE INDEX idx_shares_user ON share_tokens(user_id);
CREATE INDEX idx_shares_recipient ON share_tokens(recipient_id, expires_at);
CREATE INDEX idx_shares_code ON share_tokens(access_code) WHERE revoked_at IS NULL;
```

### Operational Tables

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash VARCHAR(64) NOT NULL,
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE TABLE health_data_types (
  type VARCHAR(50) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  unit VARCHAR(20),
  aggregation VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  description TEXT
);

CREATE TABLE retention_jobs (
  id SERIAL PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  samples_deleted INTEGER DEFAULT 0,
  aggregates_deleted INTEGER DEFAULT 0,
  insights_deleted INTEGER DEFAULT 0,
  tokens_deleted INTEGER DEFAULT 0,
  sessions_deleted INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'running'
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT NOW(),
  checksum VARCHAR(64)
);
```

### TimescaleDB Compression Policies

```sql
-- Automatically compress chunks older than 90 days
SELECT add_compression_policy('health_samples', INTERVAL '90 days');
SELECT add_compression_policy('health_aggregates', INTERVAL '90 days');
```

### Functions and Triggers

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Applied to: users, health_aggregates
```

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login with email/password |
| POST | `/api/v1/auth/logout` | Destroy session |
| GET | `/api/v1/auth/me` | Get current user profile |

### Device Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/devices` | List user's registered devices |
| POST | `/api/v1/devices` | Register a new device |
| PUT | `/api/v1/devices/:id` | Update device name/priority |
| DELETE | `/api/v1/devices/:id` | Remove device |
| POST | `/api/v1/devices/:id/sync` | Batch sync health samples from device |

### Health Data Queries

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health/samples` | Raw samples (type, date range, limit) |
| GET | `/api/v1/health/aggregates` | Pre-computed aggregates (types, period, date range) |
| GET | `/api/v1/health/summary` | Daily summary across all metrics |
| GET | `/api/v1/health/history` | Historical trend data for charts |
| GET | `/api/v1/health/insights` | User's health insights |
| PUT | `/api/v1/health/insights/:id/acknowledge` | Dismiss an insight |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/stats` | System statistics (users, samples, devices) |
| GET | `/api/v1/admin/users` | List all users with sample counts |
| POST | `/api/v1/admin/reaggregate` | Trigger reaggregation for date range |

## Key Design Decisions

### On-Device Processing First

**Chosen:** Process and aggregate on device when possible before syncing.

**Why:** Minimizes sensitive data leaving the device. A heart rate reading of 72 bpm at 14:32:15 is more revealing than a daily average of 68 bpm. By aggregating on-device, we reduce the data surface exposed to the server. This also reduces server load -- the device does the O(n) aggregation, and the server only stores O(1) hourly summaries.

**Trade-off:** Aggregation logic must be duplicated (device and server). When the server-side algorithm changes (e.g., fixing a deduplication bug), we cannot retroactively fix on-device aggregations. We mitigate this by storing raw samples alongside aggregates, enabling server-side reaggregation.

### Source Priority for Deduplication

**Chosen:** Apple Watch > iPhone > Third-party, with deterministic overlap resolution.

**Why:** When a user goes for a walk, both their Apple Watch and iPhone count steps. Without deduplication, daily step counts would be double-reported. Priority-based deduplication uses the most accurate sensor (wrist-worn > pocket) and proportionally adjusts overlapping time ranges.

**Alternative:** Time-based "first writer wins" would be simpler but produces worse results. If the iPhone syncs first with lower-accuracy pedometer data, the more accurate Apple Watch data would be discarded. Priority-based deduplication always prefers the better sensor regardless of sync order.

### TimescaleDB for Time-Series

**Chosen:** TimescaleDB extension on PostgreSQL for health data storage.

**Why:** Health data is fundamentally time-series: queries are almost always time-bounded (`WHERE start_date BETWEEN ? AND ?`), and data arrives roughly in chronological order. TimescaleDB automatically partitions data into time-based chunks, making range queries fast and enabling transparent compression of older chunks (10:1 ratio for repetitive numeric health data). Critically, it is 100% PostgreSQL-compatible -- we keep familiar SQL, pg_dump, and the entire PostgreSQL ecosystem.

**Alternative:** InfluxDB offers better write throughput for pure time-series workloads, but requires learning InfluxQL/Flux, cannot join with relational metadata tables, and adds operational complexity. Since our health data has strong relational properties (user -> device -> sample), PostgreSQL compatibility outweighs InfluxDB's raw performance advantage.

### Pre-Computed Aggregation

**Chosen:** Compute hourly and daily aggregates immediately after sync, store in a dedicated table.

**Why:** Health dashboards are read-heavy. Every page load queries the same aggregated data (today's steps, this week's heart rate trend). Pre-computation converts this from O(n) at query time (scanning thousands of raw samples) to O(1) lookup of a pre-computed row. The dashboard loads in < 100ms instead of > 1s.

**Trade-off:** Storage overhead is ~2x raw data size (hourly + daily aggregates alongside raw samples). Aggregation adds a processing delay of up to 60 seconds after sync. But storage is cheap and 60-second freshness is imperceptible for health dashboards that users check a few times per day.

## Consistency and Idempotency

### Sync Idempotency

Mobile devices operate on unreliable networks. A sync request might succeed on the server but the response is lost, causing the device to retry. Without idempotency, this produces duplicate data that corrupts aggregates.

The idempotency layer works as follows:
1. Client sends `X-Idempotency-Key` header (or server generates from `userId + deviceId + SHA256(samples)`)
2. Server checks Redis for existing key
3. If found: return cached response immediately (no re-processing)
4. If new: process request, cache response with 24-hour TTL
5. Database-level `ON CONFLICT (id) DO NOTHING` provides a second layer of protection

### Aggregation Idempotency

Aggregation uses `ON CONFLICT (user_id, type, period, period_start) DO UPDATE`, making it safe to re-run. Reaggregation after a bug fix simply overwrites old values with corrected ones.

## Security

- Session-based auth with token stored in PostgreSQL `sessions` table
- bcrypt password hashing
- Per-user data isolation enforced at the query layer (every query includes `WHERE user_id = ?`)
- Share tokens are scoped to specific data types and date ranges, with expiration and revocation
- Admin endpoints check `role = 'admin'` at the middleware level

## Observability

### Metrics (Prometheus via prom-client)
- `health_pipeline_http_request_duration_seconds` - Request latency histograms by route
- `health_pipeline_samples_ingested_total` - Ingestion rate by type
- `health_pipeline_sync_duration_seconds` - Device sync performance
- `health_pipeline_db_pool_size` - Connection pool health
- Default Node.js metrics (CPU, memory, event loop, GC)

### Structured Logging (Pino)
- JSON output with request IDs for correlation
- Redaction of sensitive fields (authorization headers, passwords, tokens)
- Pretty printing in development, machine-parseable JSON in production

### Health Checks
- `GET /health` - Liveness probe (is process alive?)
- `GET /ready` - Readiness probe (database + Redis connected?)
- `GET /health/deep` - Debugging endpoint with memory and pool statistics

## Failure Handling

### Ingestion Resilience
- Per-sample error handling: one invalid sample does not reject the batch
- Idempotency keys prevent duplicate processing on retry
- Failed aggregation jobs go to dead-letter queue with 24-hour retention for debugging

### Data Retention and Recovery
- **Hot tier** (0-90 days): Uncompressed TimescaleDB chunks, fast read/write
- **Warm tier** (90 days - 2 years): Compressed in-place, ~10:1 ratio, 10x slower reads
- **Archive**: Monthly Parquet exports to object storage before deletion
- Reaggregation can replay from raw samples for any date range

### Graceful Shutdown
- SIGTERM/SIGINT handlers stop accepting new requests
- In-flight requests complete within 30-second timeout
- Database and Redis connections closed after request draining

## Scalability Considerations

### Write Path Scaling
- Ingestion API servers are stateless; scale horizontally behind load balancer
- RabbitMQ distributes aggregation work across multiple workers
- TimescaleDB chunk partitioning prevents write hotspots on recent data
- Bulk `COPY` or multi-row INSERT for high-throughput sync (not row-by-row)

### Read Path Scaling
- Pre-computed aggregates eliminate expensive real-time calculations
- Redis caches recent aggregates (7-day window) with 1-hour TTL
- PostgreSQL read replicas for query API servers at scale
- TimescaleDB continuous aggregates could replace batch aggregation for real-time views

### What Breaks First
1. **Single TimescaleDB instance** - At 10M users, a single PostgreSQL instance cannot handle 50K writes/s. Solution: horizontal sharding by user_id (range or hash), or TimescaleDB multi-node
2. **Aggregation backlog** - Flash syncs (millions of devices syncing at 8 AM) create queue spikes. Solution: auto-scaling workers with queue depth-based triggers
3. **Redis memory** - Caching aggregates for 10M users exceeds single-instance memory. Solution: Redis Cluster with consistent hashing

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Primary storage | TimescaleDB | InfluxDB | SQL compatibility, relational joins, compression |
| Aggregation | Pre-computed on sync | On-demand at query time | Dashboard loads in < 100ms vs > 1s |
| Encryption | Per-user keys | Single system key | Enables selective sharing, limits blast radius |
| Sync protocol | Batch REST | Real-time streaming | Battery-efficient, works offline, simpler retry |
| Deduplication | Priority-based | Time-based first-writer-wins | Data accuracy from best sensor regardless of sync order |
| Queue | RabbitMQ | Kafka | Simpler operations, sufficient for aggregation workload |
| Session storage | PostgreSQL sessions table | Redis sessions | Fewer dependencies, acceptable for auth-only reads |

## Implementation Notes

### Local Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser                                    │
│   React + TanStack Router + Zustand + Recharts + Tailwind        │
│   http://localhost:5173                                           │
└──────────────────────────┬───────────────────────────────────────┘
                           │ fetch (proxied)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Express API Server                                │
│                 http://localhost:3000                              │
│                                                                   │
│  Routes: auth, devices (sync), health (queries), admin           │
│                                                                   │
│  Services: deviceSyncService, aggregationService,                │
│            insightsService, healthQueryService, authService       │
│                                                                   │
│  Shared: logger, metrics, health, idempotency, retention         │
└──────┬───────────────────────────────────────────┬───────────────┘
       │                                           │
       ▼                                           ▼
┌──────────────────────┐              ┌────────────────────────┐
│  TimescaleDB         │              │   Valkey (Redis)       │
│  PostgreSQL :5432    │              │   :6379                │
│                      │              │                        │
│  health_data DB      │              │   Sessions             │
│  (users, devices,    │              │   Idempotency cache    │
│   samples [hyper],   │              │   Aggregate cache      │
│   aggregates [hyper],│              │                        │
│   insights, shares,  │              │                        │
│   sessions)          │              │                        │
└──────────────────────┘              └────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | File | Why It Matters |
|---------|------|----------------|
| Structured Logging (Pino) | `src/shared/logger.ts` | JSON logs with request IDs, redaction of auth headers/passwords. Enables log aggregation for HIPAA audit trails. |
| Prometheus Metrics | `src/shared/metrics.ts` | HTTP duration histograms, ingestion counters by type, sync duration, DB pool gauge. Enables SLO monitoring. |
| Health Checks (liveness + readiness) | `src/shared/health.ts` | `/health` for liveness, `/ready` for dependency checks, `/health/deep` for debugging. Required for load balancer and container orchestration. |
| Data Retention | `src/shared/retention.ts` | Tiered retention (90-day hot, 2-year warm, 7-year archive). Automated cleanup jobs with audit logging in `retention_jobs` table. |
| Idempotency | `src/shared/idempotency.ts` | Content-based key generation from userId + deviceId + SHA256(samples). Redis-cached with 24h TTL. Prevents duplicate processing on mobile retry. |
| Deduplication | `src/services/aggregationService.ts` | Priority-based overlap resolution with proportional value adjustment for partial overlaps. |
| Insights Engine | `src/services/insightsService.ts` | Linear regression for trends, rolling averages for sleep/activity. Generates actionable health recommendations. |

### Simplifications

| Production Design | Local Substitute | Why Acceptable |
|-------------------|------------------|----------------|
| RabbitMQ for aggregation queue | In-process aggregation after sync | Avoids queue infrastructure; aggregation is fast for small datasets |
| Per-user encryption keys | No field-level encryption | Demonstrates schema support for encryption; actual crypto would require KMS |
| MinIO for cold storage archival | No archival implemented | Retention policies and archive schema defined; MinIO not deployed |
| Multiple API instances + workers | Single Express server | All services (ingestion, query, admin, aggregation) in one process |
| Redis Cluster | Single Valkey instance | Sufficient for < 5 users in development |
| Real device SDKs (HealthKit, Google Fit) | Seeded data + manual sync API calls | Focuses on pipeline logic rather than SDK integration |

### Omitted

- Real HealthKit / Google Fit / Fitbit device integration
- End-to-end encryption with user-managed keys
- Differential privacy for aggregate analytics
- GDPR data export and deletion workflows
- CDN and multi-region deployment
- Kubernetes orchestration
- Kafka for high-throughput ingestion
- ML-based anomaly detection for health data
- Family sharing with consent management
- Healthcare provider portal

---

## Frontend Architecture

### Component Hierarchy

```
Root Layout (Navbar + main content area)
├── Login (email/password login form)
├── Register (registration form)
├── Dashboard (/) (health overview)
│   ├── MetricCard (individual metric: steps, heart rate, sleep, etc.)
│   ├── HealthChart (Recharts line/bar chart for trend visualization)
│   └── InsightCard (health insight with severity, recommendation, acknowledge button)
├── Metrics (/metrics) (detailed metric history)
│   └── HealthChart (per-metric time-series charts)
├── Devices (/devices) (device management)
│   └── (device list with sync status, priority, last sync time)
└── Admin (/admin) (system administration)
    └── (user list, sample counts, reaggregation controls)
```

### Zustand Stores

**`useAuthStore`** (`stores/authStore.ts`) -- Authentication state with persistence:

- **`user`**: Current user (email, name, role) or null
- **`token`**: Session token persisted in localStorage
- **`isAuthenticated`**: Derived from token presence and validation
- **Persistence**: Uses Zustand's `persist` middleware to store the token in localStorage, surviving page refreshes. On app load, `checkAuth()` validates the stored token against the server.
- **Actions**: `login(email, password)`, `register(email, password, name)`, `logout()`, `checkAuth()`

**`useHealthStore`** (`stores/healthStore.ts`) -- Health data state:

- **`dailySummary`**: Today's aggregated metrics (steps, heart rate, sleep, calories)
- **`weeklySummary`**: 7-day rolling summary for trend cards
- **`latestMetrics`**: Most recent value for each metric type
- **`insights[]`**: Active health insights with severity (low/medium/high), direction (improving/declining), message, and recommendation
- **`history`**: A `Record<string, HealthAggregate[]>` keyed by metric type, storing time-series data for charts. Each fetch appends to this record, so multiple metric histories can be loaded without overwriting each other.
- **`devices[]`**: Registered devices with sync status and priority
- **Actions**: `fetchDailySummary(date?)`, `fetchWeeklySummary()`, `fetchLatestMetrics()`, `fetchInsights()`, `fetchHistory(type, days)`, `fetchDevices()`, `analyzeHealth()` (triggers server-side insight generation), `acknowledgeInsight(id)` (optimistically updates local state)

### Routing

TanStack Router with programmatic route definition (not file-based):

| Route | File | Description |
|-------|------|-------------|
| `/` | `routes/Dashboard.tsx` | Health overview with metric cards, charts, and insights |
| `/login` | `routes/Login.tsx` | Login form |
| `/register` | `routes/Register.tsx` | Registration form |
| `/metrics` | `routes/Metrics.tsx` | Detailed metric history with per-type charts |
| `/devices` | `routes/Devices.tsx` | Device management (register, sync, configure priority) |
| `/admin` | `routes/Admin.tsx` | System stats, user management, reaggregation triggers |

Routes are defined programmatically in `routes/index.tsx` using `createRootRoute` and `createRoute` with lazy component loading via dynamic `import()`. The root layout renders a `Navbar` component that provides navigation links and authentication status.

### Data Fetching

All data fetching goes through a centralized API service (`services/api.ts`) organized by domain:

- **`api.auth`**: login, register, logout, session validation
- **`api.health`**: dailySummary, weeklySummary, latest metrics, insights, history, analyze, acknowledgeInsight
- **`api.devices`**: list, register, update, delete, sync (batch health sample upload)
- **`api.admin`**: system stats, user list, reaggregation trigger

The API service includes the session token in request headers for authentication. Each store action calls the corresponding API method, updates local state on success, and sets error state on failure. There is no client-side caching layer -- health data should always reflect the latest sync.

### Key UI Patterns

- **Recharts for data visualization**: Line charts for time-series data (heart rate trends, step history), bar charts for daily aggregates. Recharts provides responsive, declarative React charting components
- **Metric cards**: Each MetricCard displays a metric name, current value, unit, and optionally a trend indicator (arrow up/down with color coding)
- **Insight cards with acknowledge**: InsightCards show severity-coded health recommendations. Acknowledging an insight optimistically removes it from the active list without waiting for the server response
- **Lazy-loaded routes**: Route components use dynamic `import()` for code splitting, reducing the initial bundle size. The dashboard loads first; metrics, devices, and admin pages load on navigation
- **Token persistence**: The auth store persists only the session token to localStorage (not the full user object), and re-validates it on page load via `checkAuth()`

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and when you would use it.

### Prometheus Metrics (prom-client)

**What it is**: Prometheus is a monitoring system that collects numerical time-series data from applications. The application exposes a `/metrics` HTTP endpoint that Prometheus periodically scrapes. The `prom-client` library provides four metric types: Counter (only goes up), Gauge (goes up and down), Histogram (distribution of values in configurable buckets), and Summary (similar to histogram with quantile calculation).

**How it works**: The application creates metric objects at startup. During operation, the application records observations. In this project, key metrics include: `health_pipeline_http_request_duration_seconds` (histogram of request latency by route), `health_pipeline_samples_ingested_total` (counter of ingested samples by type -- steps, heart_rate, etc.), `health_pipeline_sync_duration_seconds` (histogram of device sync operation duration), and `health_pipeline_db_pool_size` (gauge of active database connections). Default Node.js metrics (CPU usage, memory, event loop lag, garbage collection) are also collected automatically.

**Why it matters**: For a health data pipeline, the most critical metric is ingestion throughput (`samples_ingested_total`). If the ingestion rate drops suddenly, it could mean devices are failing to sync, the API is rejecting valid samples, or the database is overloaded. The sync duration histogram reveals whether batch inserts are becoming slower as the database grows. Without these metrics, operators would only discover ingestion problems when users report missing health data -- potentially hours after the issue began. For HIPAA compliance, monitoring and audit trails are not optional; they are required.

**When to use it**: In any production system, but especially in systems handling sensitive data like health records, where compliance frameworks require monitoring and alerting capabilities.

### Structured Logging (Pino)

**What it is**: Structured logging produces log entries as machine-parseable JSON objects rather than human-readable text strings. Each log entry includes consistent field names, enabling automated parsing, filtering, indexing, and alerting.

**How it works**: Pino produces JSON log entries with severity level, timestamp, and contextual fields. In this project, a critical feature is **field redaction**: authorization headers, passwords, and session tokens are automatically stripped from log output. This prevents sensitive credentials from appearing in log files, log aggregation systems, or debug outputs. The `pino-http` middleware logs every HTTP request with method, path, status code, and duration. Domain-specific events (device syncs, aggregation completions, insight generation) include user IDs and metric types but never raw health data values.

**Why it matters**: Health data systems operate under strict privacy regulations (HIPAA in the US, GDPR in Europe). Logging a patient's heart rate or blood glucose value in a debug log could constitute a compliance violation. Pino's redaction feature ensures that even when verbose logging is enabled for debugging, sensitive fields are automatically stripped. Request IDs enable tracing a sync operation from device upload through deduplication, aggregation, and insight generation without exposing the health data itself.

**When to use it**: Always in production environments, and especially in systems handling personally identifiable information (PII) or protected health information (PHI). The redaction feature should be configured at project setup, not added later as an afterthought.

### Idempotency

**What it is**: Idempotency means that performing the same operation multiple times produces the same result as performing it once. For health data sync, idempotency prevents duplicate samples from corrupting aggregated metrics.

**How it works**: This project implements a two-layer idempotency system:
1. **Request-level**: The client sends an `X-Idempotency-Key` header with each sync request. The server generates this key from `userId + deviceId + SHA256(samples)`, making it content-based. The server checks Redis for the key: if found, it returns the cached response from the first processing. If not found, it processes the sync, caches the response with a 24-hour TTL, and returns the result.
2. **Record-level**: Each health sample has a UUID primary key. The database insert uses `ON CONFLICT (id) DO NOTHING`, so even if the same sample appears in two different sync batches, it is inserted only once.

**Why it matters**: Mobile health apps sync over unreliable cellular networks. A device might upload 500 heart rate samples, the server processes them all, but the HTTP response is lost to a network timeout. The device retries the entire batch. Without idempotency, those 500 samples would be counted twice, making the user's daily average heart rate appear higher than it actually is. For health data, accuracy is not just a user experience issue -- incorrect aggregates could lead to false health alerts or missed warnings. The content-based key generation (SHA-256 of the samples) is particularly important: even if the client does not include an idempotency header, the server can detect duplicate batches by their content hash.

**When to use it**: For any operation that has side effects, especially when clients operate over unreliable networks (mobile apps, IoT devices). Health data sync is a textbook use case because the consequences of duplicate data are both subtle (slightly wrong averages) and serious (false medical insights).

### Health Checks

**What it is**: Health checks are dedicated HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers, container orchestrators, and monitoring systems.

**How it works**: This project implements three health check endpoints:
- **`/health`** (liveness): Returns 200 if the process is alive. Checks nothing beyond the ability to respond to HTTP. Used by Kubernetes to decide whether to restart the container.
- **`/ready`** (readiness): Returns 200 only if the TimescaleDB database responds to a query and Redis responds to PING. Used by load balancers to decide whether to route traffic to this instance. A freshly started instance that has not yet established its database connection pool reports "not ready."
- **`/health/deep`** (diagnostic): Returns detailed status including memory usage, database connection pool statistics (active, idle, waiting connections), and dependency versions. Used by operators for debugging without SSH access.

**Why it matters**: The readiness check is especially important for health data pipelines because a server that cannot reach its database will accept sync requests but fail to store them -- silently losing health data. The readiness check prevents this by ensuring the load balancer only routes traffic to instances that can actually persist data. The deep health check helps diagnose connection pool exhaustion, which can happen during peak sync windows (e.g., millions of devices syncing when their users wake up in the morning).

**When to use it**: Every production service needs liveness and readiness checks. The deep diagnostic check is valuable for systems with complex dependency chains (database, cache, queue, external services). For health data systems, readiness checks should verify write path dependencies (database) because accepting data that cannot be stored violates the "zero data loss" requirement.

### Rate Limiting

**What it is**: Rate limiting restricts the number of requests a client can make within a time window. It protects the service from abuse by rejecting excess requests with HTTP 429 (Too Many Requests) responses before they consume server resources.

**How it works**: The server maintains request counters per client identifier (IP address or authenticated user ID). When a request arrives, the counter is checked against the configured limit. If within limits, the request proceeds. If exceeded, the request is rejected with a 429 response and a `Retry-After` header. For the health data pipeline, rate limiting is applied per-user on sync endpoints, preventing a malfunctioning device from overwhelming the ingestion path.

**Why it matters**: A buggy health app or a compromised device could send thousands of sync requests per second, each containing hundreds of samples. Without rate limiting, this would exhaust database connections, fill up storage, and delay aggregation for all other users. Rate limiting on the sync endpoint ensures that even a malfunctioning client cannot degrade the service for others. It also provides a simple defense against denial-of-service attacks targeting the ingestion path.

**When to use it**: On every externally-facing API, with particular attention to write-heavy endpoints (sync, upload) where each request triggers significant server-side processing (validation, deduplication, aggregation).
