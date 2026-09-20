# Health Data Pipeline Architecture

## System Overview

This project explores how to accept measurements from several devices, distinguish retries from overlapping observations, and turn imperfect time-series data into understandable personal reports. The difficult boundary is between “we saved your upload” and “this chart includes every accepted correction under a known aggregation policy.”

The production design below is a proposal for a nonclinical personal reporting product. The repository contains a smaller Express/TimescaleDB/Valkey prototype and a React dashboard. Its ingestion, aggregation, authentication, and rendering limitations are documented in the final [Implementation Notes](#implementation-notes). Capacity figures are design assumptions, not measurements of this implementation.

## Requirements

### Functional requirements — proposed product

- Register devices under an authenticated owner; ingest bounded batches with stable source sample IDs and explicit correction versions.
- Preserve original units, normalized values, source identity, capture intervals, and processing provenance.
- Produce hourly/daily reports with metric-specific rules, source coverage, reporting timezone, and visible freshness.
- Accept offline device backfills and recompute affected periods without double counting or allowing old jobs to replace newer results.
- Let users inspect sources and delete their data. Treat descriptive trend messages as optional, coverage-dependent summaries.

Real wearable integrations, clinical decision support, and clinician sharing are separate product scopes. A future sharing feature would require explicit metric/date grants and revocation checks; an unused token table does not implement it.

### Non-functional requirements — proposed targets

| Concern | Initial target / contract |
|---------|---------------------------|
| Availability | 99.9% monthly for ingestion and authorized report reads |
| Acceptance | p95 below 500 ms for a valid bounded batch, excluding client upload time |
| Report latency | p95 below 300 ms for a bounded aggregate query |
| Freshness | 99% of ordinary accepted batches reflected in reports within two minutes |
| Durability | A successful acceptance receipt follows a committed durable write |
| Correctness | Deterministic policy version; no duplicate effect from retries; explicit missing coverage |
| Privacy | Owner/device authorization, protected transport/storage, bounded access and deletion |

Backfills have a separate processing objective so a year of imported data cannot consume the entire interactive queue. Availability never permits one account to read another account's cached report.

## Capacity Estimation

Assume one million daily active users and 1,500 samples per user per day: 1.5 billion samples/day, about 17,400 samples/second on average. A 100,000-sample/second peak is a planning input. At 500 samples per full batch that is 200 batch requests/second, but small batches increase request overhead.

At an assumed 200 bytes per normalized sample, raw payload alone is 300 GB/day before indexes, replicas, metadata, and backups. This makes retention, batch efficiency, partition sizing, and user-based sharding important. It does not justify silently discarding provenance or keeping every resolution forever.

Daily charts should return hundreds of points, not millions of raw measurements. Query and worker load depends on the maximum accepted interval length, backfill age, number of overlapping devices, and requested resolution; bound those dimensions independently of request bytes.

### Local Development Scale

Compose provides one TimescaleDB and one Valkey process. One Express process performs ingestion, inline aggregation, queries, and auth. Additional API port scripts are available, but there is no provided load balancer or cross-instance aggregation coordinator. No throughput, resource-use, or availability target has been benchmarked here.

## High-Level Architecture

**Proposed production components:** draw the acceptance path first, then the asynchronous projection and reporting path. The database box represents a user shard containing relational control records and time-partitioned samples; it is not a promise that one server handles the estimated workload.

```
┌────────────────────────┐ batch  ┌────────────────────────┐        ┌────────────────────────┐
│ Sync client + journal  │        │ Ingestion API          │        │ Identity + grants      │
│ Saved batch/sample IDs │◀──────▶│ Validate + authorize   │◀──────▶│ User / device scope    │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                         ▲
                                                         │
atomic: samples, receipt, dirty buckets, outbox          │
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL / time-series partitions, sharded by user                                       │
│ Raw versions + source identity registry + receipts + dirty generations / outbox            │
│ Published bucket versions, provenance, policy version, access grants                       │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                       ▲                                  ▲                                ▲
                       │                                  │                                │
 inputs / publish      │           committed jobs         │          scoped reads          │
                       │                                  │                                │
                       ▼                                  ▼                                ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Rollup workers         │        │ Dispatcher + queue     │        │ Query API              │
│ Full affected buckets  │◀──────▶│ Retry / bounded jobs   │        │ Current authorization  │
│ Metric-specific rules  │        │ Outcome / retry state  │        │ Published versions     │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                                                           ▲
                                                                                           │
                                                                     reports / status      │
                                                                                           │
                                                                                           ▼
                                  ┌──────────────────────────────────────────────────────────┐
                                  │ Dashboard clients                                        │
                                  │ Charts, source coverage, accepted vs processed status    │
                                  └──────────────────────────────────────────────────────────┘
```

A device sends a bounded batch through authenticated ingestion. In one shard-local transaction, ingestion records the raw versions, a scoped receipt, affected bucket generations, and an outbox entry. Only then does it report acceptance.

The dispatcher delivers committed work to retryable workers. A worker reads complete affected bucket inputs, applies the metric policy, and publishes only if its input generation is still current. The query API checks current access and returns published results with coverage and processing status. A cache can accelerate these reads but cannot become the authority for access or acceptance.

The sync client's bounded journal retains the original batch/sample identities until an authorized receipt lookup resolves the upload; it is separate from the dashboard's report cache. Worker acknowledgements follow a durable publication or recorded supersession/retry outcome. A newer correction or deletion can invalidate an older job, so completing that job does not prove the latest requested report is ready. The dashboard observes the published version and its coverage before refreshing its matching query.

## Core Components / Request Flows

### 1. Authorize and accept a batch

Validate the session and verify ownership of the device before receipt lookup. Validate sample count, finite values, known units, timestamps, permitted backfill age, and interval duration. Reject unknown unit conversions instead of relabeling their numeric values.

Use a source identity registry keyed by owner, device/provider, source sample ID, and version. Its row points to the sample's time partition and records a content digest. This prevents a retry with a changed timestamp from evading identity checks. A correction is a new explicit version, not a silent overwrite or another unrelated UUID.

Receipt identity includes owner, device, and client batch key. A canonical digest includes every semantically relevant field. Reusing the same key with a different digest is a conflict. Valid samples and per-item validation failures can share one final batch receipt; unauthorized devices are rejected before processing any item.

The transaction commits raw versions, receipt outcome, dirty bucket generations, and outbox work together. An acknowledgment means durable acceptance, not completed aggregation. The SDK can retain an encrypted, bounded retry journal until that receipt is known; the browser report cache is a separate concern.

### 2. Resolve overlapping observations

Two equal sample IDs are a retry/correction problem. Two distinct samples from different sensors can legitimately describe the same activity. Preserve both raw records, and choose a documented per-metric projection policy.

For interval totals such as steps, resolve the union of covered intervals, then subtract all higher-priority coverage from lower-priority intervals. Split uncovered fragments at bucket boundaries. Duration-based allocation of an interval total is an estimate; preserve that fact because uniform activity within an interval is not known.

For point measurements such as weight, choose the latest eligible observation by measurement timestamp and a stable tie-breaker. Heart-rate aggregation must explicitly define observation weighting or time weighting; clipping an interval must not turn 100 bpm into 50 bpm. Sleep duration uses covered sleep intervals and a documented source/stage policy, not an indiscriminate sum of overlapping durations.

Source preference is a product policy with a version, not evidence that a particular branded device is medically more accurate. Raw observations remain available for inspection and recomputation while within retention.

### 3. Recompute and publish a complete period

Convert reporting-day boundaries from the user's IANA timezone to half-open UTC intervals. A day can differ from 24 hours around daylight-saving transitions. Store event instants with timezone-aware semantics and retain the reporting zone/policy used by each projection.

A job loads every relevant sample intersecting the affected period, including samples that began before it. For an old-to-new correction, dirty the union of the old and new intervals. Replacing a bucket requires a complete recomputation, including an explicit empty result when the final sample was deleted.

Each dirty bucket has a desired generation. Workers read an identified input snapshot and policy version. Publication compares that generation and the account's deletion/policy epoch with the current values. A stale worker discards its result and leaves the newest work pending. The check and publication happen in one transaction.

Publish related report buckets through a versioned report head when the product requires an internally consistent bundle. Otherwise expose per-bucket revisions and freshness. Do not describe a sequence of independent hourly/daily writes as one atomic report.

### 4. Read reports and show freshness

The query service authorizes each request, resolves the published report head, and reads bounded aggregate points. Versioned cache keys include owner, metric, range, resolution, reporting zone, policy, and publication version. A cached payload is reusable only after current access checks.

Responses distinguish measurement time, acceptance time, processing watermark, and source coverage. A device's “last sync” timestamp alone cannot prove that a chart contains all of its data. Poll processing status while a report is active and refresh when its published version changes; a persistent push connection is optional.

The browser owns metric/range controls and presentation state. The server owns normalized measurements and report semantics. Charts show gaps, units, provenance, and an equivalent data table. A shared query coordinator guards responses by account generation and complete query identity, so an old range or account cannot populate the current view.

## Database Schema

### Verified local schema

The following is the exact checked-in [init.sql](./backend/src/db/init.sql): **11 tables and 14 explicitly declared secondary indexes**, in addition to indexes created by primary/unique constraints and TimescaleDB. This is an implementation reference, not the complete proposed production schema.

`health_samples` uses `(id, start_date)` as its primary key; `health_aggregates` uses `(id, period_start)` plus a unique user/type/period/start tuple. The standalone generator's conflict target `(id)` does not match the raw table. Local timestamps are `TIMESTAMP` without time zone. The schema does not constrain finite measurement values, supported units, interval ordering, or device ownership through a composite foreign key.

```sql
-- ============================================================================
-- Health Data Pipeline - Consolidated Database Schema
-- ============================================================================
-- This file consolidates all migrations into a single init script.
-- Use this for fresh database setup or Docker initialization.
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Core Tables
-- ============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User devices
CREATE TABLE IF NOT EXISTS user_devices (
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

-- ============================================================================
-- Health Data Tables (TimescaleDB Hypertables)
-- ============================================================================

-- Raw health samples (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS health_samples (
  id UUID DEFAULT uuid_generate_v4(),
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
  created_at TIMESTAMP DEFAULT NOW(),
  -- TimescaleDB requires the partitioning column (start_date) to be part of
  -- every unique/primary-key constraint, so the PK is composite rather than id alone.
  PRIMARY KEY (id, start_date)
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('health_samples', 'start_date', if_not_exists => TRUE);

CREATE INDEX idx_samples_user_type ON health_samples(user_id, type, start_date DESC);
CREATE INDEX idx_samples_device ON health_samples(source_device_id);

-- Aggregated data (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS health_aggregates (
  id UUID DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  period VARCHAR(10) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  sample_count INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  -- Partitioning column (period_start) must be in every key constraint (TimescaleDB).
  PRIMARY KEY (id, period_start),
  UNIQUE(user_id, type, period, period_start)
);

SELECT create_hypertable('health_aggregates', 'period_start', if_not_exists => TRUE);

CREATE INDEX idx_aggregates_user_type ON health_aggregates(user_id, type, period, period_start DESC);

-- ============================================================================
-- User Insights & Sharing
-- ============================================================================

-- User insights
CREATE TABLE IF NOT EXISTS health_insights (
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

-- Share tokens for controlled data sharing
CREATE TABLE IF NOT EXISTS share_tokens (
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

-- ============================================================================
-- Authentication
-- ============================================================================

-- Sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ============================================================================
-- Reference Data
-- ============================================================================

-- Health data type definitions (reference table)
CREATE TABLE IF NOT EXISTS health_data_types (
  type VARCHAR(50) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  unit VARCHAR(20),
  aggregation VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  description TEXT
);


-- ============================================================================
-- Migration 001: Idempotency Keys
-- ============================================================================

-- Add idempotency tracking table for deduplicating sync requests
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash VARCHAR(64) NOT NULL,
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_idempotency_user ON idempotency_keys(user_id);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- Schema migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT NOW(),
  checksum VARCHAR(64)
);

-- ============================================================================
-- Migration 002: Retention Policies
-- ============================================================================

-- Add retention tracking table for audit purposes
CREATE TABLE IF NOT EXISTS retention_jobs (
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

CREATE INDEX idx_retention_jobs_date ON retention_jobs(started_at DESC);

-- Enable TimescaleDB compression policies (if TimescaleDB is available)
DO $$
BEGIN
  -- Check if TimescaleDB is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- Add compression policy for health_samples (compress after 90 days)
    PERFORM add_compression_policy('health_samples', INTERVAL '90 days', if_not_exists => true);

    -- Add compression policy for health_aggregates (compress after 90 days)
    PERFORM add_compression_policy('health_aggregates', INTERVAL '90 days', if_not_exists => true);

    RAISE NOTICE 'TimescaleDB compression policies added';
  ELSE
    RAISE NOTICE 'TimescaleDB not installed, skipping compression policies';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add compression policies: %', SQLERRM;
END $$;

-- ============================================================================
-- Functions and Triggers
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_aggregates_updated_at
  BEFORE UPDATE ON health_aggregates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Record applied migrations
-- ============================================================================

-- Seed data is in db-seed/seed.sql
```

The schema enables `uuid-ossp`, but assumes TimescaleDB already exists for its two unconditional hypertable calls. The [Timescale Docker entrypoint](https://github.com/timescale/timescaledb-docker/blob/main/docker-entrypoint-initdb.d/000_install_timescaledb.sh) creates that extension during fresh image initialization. The native README option explicitly removes the hypertable calls in a temporary copy for ordinary PostgreSQL.

The compression block catches errors and does not first enable compression on these tables. Its presence does not prove that compression policies work. Some indexes and triggers are unguarded, so this is a fresh-database initialization file, not a repeatable migration runner. The migration tracker and health type reference table are not populated.

### Additional records required by the proposed design

| Record | Key / important fields | Purpose |
|--------|------------------------|---------|
| Source identity registry | Owner, device/provider, source ID, version, digest, partition timestamp | Identity independent of event-time partitioning |
| Batch receipt | Owner, device, key, digest, per-item outcome, accepted time | Durable, scoped retry result |
| Raw sample version | Original/normalized value and unit, interval, source version, tombstone | Preserve provenance and corrections |
| Dirty bucket | Owner, metric, bucket, zone/policy, desired generation | Bound recomputation and fence old jobs |
| Outbox record | Job ID, affected scope, committed generation, delivery state | Recover work after acceptance |
| Published report | Bucket values, coverage, input generation, policy, publication version | Explain and consistently serve derived data |
| Account epoch / access grants | Current deletion/policy epoch, explicit recipient scope if added | Block revoked reads and stale republishing |

These are proposed additions; their names in this table do not identify existing application tables.

## API Design

### Actual routes

All health and device routes require authentication; admin routes also check the user's current admin role. Authentication middleware alone does not establish the missing device ownership check on sync.

| Method | Path | Actual behavior |
|--------|------|-----------------|
| POST | `/api/v1/auth/register`, `/login`, `/logout` | Account creation, opaque session creation, session deletion |
| GET | `/api/v1/auth/me` | Current user |
| GET / POST | `/api/v1/devices` | List owned devices / register a device |
| POST | `/api/v1/devices/:deviceId/sync` | Insert valid samples, update device, aggregate inline, cache receipt |
| GET | `/api/v1/health/types` | Read currently unseeded reference table |
| GET | `/api/v1/health/samples` | Raw samples; default limit 1,000 and offset pagination |
| GET | `/api/v1/health/aggregates` | Hourly/daily aggregate rows |
| GET | `/api/v1/health/summary/daily`, `/summary/weekly` | Daily or rolling-week summaries |
| GET | `/api/v1/health/latest`, `/history/:type` | Latest daily aggregates / daily metric history |
| GET | `/api/v1/health/insights` | Stored insights |
| POST | `/api/v1/health/insights/analyze` | Run illustrative analysis explicitly |
| POST | `/api/v1/health/insights/:insightId/acknowledge` | Mark an owned insight acknowledged |
| GET | `/api/v1/admin/stats`, `/users`, `/users/:userId` | Stats, users, individual details including recent insights |
| POST | `/api/v1/admin/users/:userId/reaggregate` | Inline reaggregation over a requested/default range |
| GET | `/api/v1/admin/config/types` | Code-defined metric configuration |
| GET | `/health`, `/ready`, `/health/deep`, `/metrics` | Public diagnostics |

Grouped paths share the prefix shown by the first path. There are no device update/delete, sharing, export, batch-status, or durable job APIs. Query limits and dates are not consistently bounded or validated; several bad inputs become server errors.

### Proposed contract changes

Ingestion should return a receipt ID, per-item validation outcomes, and acceptance/processing status. A repeated request with the same scoped key and payload returns that outcome; different content returns a conflict. Expose receipt status separately from report queries.

Report responses should include metric/unit, bucket boundaries, zone, resolution, value/coverage, source policy, publication revision, and pending-processing status. Use explicit null/missing states. An insight response should always return the persisted insight identity and the report version it summarizes. These richer contracts are not present in the local API.

## Key Design Decisions

### Durable acceptance before asynchronous aggregation

Store samples and outbox work transactionally, then process bounded jobs. A device can safely retry an uncertain upload without holding a request open for a year of recomputation. Inline aggregation couples acceptance latency to backfill size and can fail after data has already committed.

A broker-only acknowledgment is insufficient if the advertised receipt refers to database durability; a SQL write followed by an independent publish can lose work between those steps. An outbox makes recovery inspectable. The cost is worker operations, queue lag, and an explicitly eventual report rather than one deceptively synchronous response.

### Metric-specific fusion over universal overlap clipping

A single “prefer watch, clip phone” algorithm is appealing, but counts, rates, latest measurements, and sleep coverage have different meanings. Clipping a rate's value by duration changes its physical quantity; retaining a whole interval total after partial overlap double counts activity.

Use explicit policies with examples and versioned outputs. Keep raw observations so changed policies are reversible. The cost is more domain modeling and estimates that must be labeled. Avoid claiming a generic priority ranking proves clinical accuracy.

### Complete recomputation with guarded publication

At first, recompute complete affected buckets from retained inputs. This handles late arrivals, deletions, and corrections more transparently than a web of reversible increments. Blindly adding a batch double counts retries; replacing from only the batch erases prior data. Independent workers can still race, so generation checks are essential.

The cost is repeat reads and CPU for busy periods. Bound intervals, coalesce dirty jobs, and partition work before adopting incremental algorithms. Beyond raw-data retention, explain when a period can no longer be fully recomputed rather than pretending old aggregates preserve all source evidence.

## Consistency and Idempotency

The proposal provides at-least-once delivery with idempotent committed effects, not a claim of exactly-once networking. Scope receipts to the authenticated owner and device, bind them to content, and commit their final result with accepted rows and work records.

For concurrent retries, a database uniqueness constraint serializes receipt ownership. Other callers can wait briefly or receive pending status; only one logical acceptance is created. Expiring a response cache must not erase stable source identity. Different raw IDs can still represent overlapping observations, which is why sample identity and fusion are separate.

Deletion advances an account/data epoch, tombstones affected raw versions, invalidates publication heads, and schedules rebuilding or removal. Worker publication checks that epoch to prevent deleted data from reappearing. A fresh authorization decision precedes even an immutable cached report read.

## Security / Auth

The proposed product uses protected transport and storage, secure browser sessions, least-privilege administration, and explicit device ownership checks. Logs omit measurements, credentials, and sensitive query strings. Access events need a protected audit trail if that becomes a product requirement; ordinary application logs are insufficient.

The current app uses opaque Bearer tokens stored in browser localStorage and SQL/Valkey sessions. There is no configured application TLS, field encryption, external identity provider, request rate limiter, or security/compliance certification. The admin detail API can return individual health insights, so administration is not restricted to anonymous usage metrics.

Retention is a product and jurisdiction-specific decision. Do not describe the hardcoded seven-year raw-data interval as a HIPAA requirement: HHS states that the HIPAA Privacy Rule does not specify a medical-record retention period. See the [HHS retention FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/580/does-hipaa-require-covered-entities-to-keep-medical-records-for-any-period/index.html).

## Observability

For the proposal, measure receipt latency, accepted/rejected/duplicate sample counts, oldest pending work, bucket publication delay, stale-worker rejections, query coverage, and correction outcomes. Separate device capture lag from server processing lag; a disconnected device and a blocked worker require different action.

Local Pino middleware logs requests and named credential paths are redacted. HTTP/default runtime metrics, successful sync timing, and pool gauges are wired. Aggregation duration, database duration, active-user, and cache metrics are declared without corresponding instrumentation on the relevant paths. A metrics definition is not evidence of a functioning dashboard or alert.

`/health` is liveness. `/ready` checks PostgreSQL and Redis sequentially and can return 503; there is no overall timeout or schema verification. `/health/deep` exposes details and still returns 200 when degraded. Startup retries a simple database query, not schema or Redis readiness. See [health helpers](./backend/src/shared/health.ts), [metrics](./backend/src/shared/metrics.ts), and [logger](./backend/src/shared/logger.ts).

## Failure Handling

| Failure | Proposed behavior | Current implementation |
|---------|-------------------|------------------------|
| Response lost after acceptance | Retry same receipt identity | Optional Redis receipt, separate from SQL |
| Worker crash | Retry committed outbox job | Aggregation is awaited inside sync |
| New input while old job runs | Reject stale publication | No generation or publication guard |
| Redis unavailable | Preserve SQL correctness; deliberate bounded fallback | Session/cache/receipt calls can fail requests |
| Partial device coverage | Show gap and freshness | Missing values can look like zero or empty data |
| Logout/account change | Clear private state and fence late requests | Health store survives logout |
| Shutdown | Stop readiness, drain work, close all dependencies | HTTP/database close and force timeout; no Redis quit |

## Scalability Considerations

Scale by user ownership so raw data, receipts, and outbox mutations stay within one shard. Time partitions bound scans and lifecycle operations within a shard. Report reads favor compact projections; replicas need a version/freshness rule before claiming read-your-accepted-data behavior.

The first ingestion bottleneck is likely recomputation of dense overlap windows, not HTTP routing. Bound interval sizes and backfills, coalesce repeated dirty periods, and prioritize recent reports separately from history imports. Use stable jobs and fair queues to prevent one account from monopolizing workers.

As retained data grows, tier raw history only under an explicit restoration/recomputation contract. A deletion job must include derived data and caches. If sharing is added, grant checks belong ahead of cache reuse and download authorization. Multi-region writes would require an ownership/failover protocol; it is intentionally outside this first design.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Acceptance | SQL receipt + outbox | Inline aggregation | Durable retry result with bounded request latency |
| Fusion | Metric-specific versioned policy | Universal priority clipping | Preserve units and measurement meaning |
| Corrections | Complete bucket rebuild | Blind increment or partial replacement | Handle late input and deletion coherently |
| Publication | Generation-checked versions | Last worker wins | Prevent older inputs replacing newer reports |
| Report cache | Authorized versioned payloads | User-agnostic or TTL-only cache | Bound staleness and private-data reuse |
| Browser data | Account-scoped memory | Persistent health payload cache | Reduce retention and account-switch exposure |

## Implementation Notes

### Actual topology and source map

```
┌────────────────────────┐ HTTP   ┌────────────────────────┐        ┌────────────────────────┐
│ React dashboard        │        │ Express process        │        │ TimescaleDB            │
│ Zustand + Recharts     │◀──────▶│ Sync + inline rollups  │◀──────▶│ Samples and rollups    │
└────────────────────────┘        │ Queries + auth/admin   │        │ SQL sessions / users   │
                                  └────────────────────────┘        └────────────────────────┘
                                                         ▲
                                                         │
                                                         │
Session lookups, query cache, optional receipt cache     │
                                                         │
                                                         ▼
                                  ┌────────────────────────┐
                                  │ Valkey                 │
                                  │ Session + JSON cache   │
                                  └────────────────────────┘


No queue worker, sharing route, device SDK, archive store, or live status stream.
```

| Area | Source | Verified responsibility |
|------|--------|-------------------------|
| Server / configuration | [index.ts](./backend/src/index.ts), [config](./backend/src/config/index.ts) | Express routes, 10 MB body limit, environment defaults, startup/shutdown |
| Database / cache | [database.ts](./backend/src/config/database.ts), [redis.ts](./backend/src/config/redis.ts) | PostgreSQL pool, JSON cache, user invalidation helper |
| Ingestion | [deviceSyncService.ts](./backend/src/services/deviceSyncService.ts), [healthSample.ts](./backend/src/models/healthSample.ts) | Validation, unit normalization, bulk insert, inline rollups |
| Aggregation | [aggregationService.ts](./backend/src/services/aggregationService.ts), [healthTypes.ts](./backend/src/models/healthTypes.ts) | Priority clipping, hourly/daily UPSERTs, metric configuration |
| Queries / trends | [healthQueryService.ts](./backend/src/services/healthQueryService.ts), [insightsService.ts](./backend/src/services/insightsService.ts) | Reports, cache reads, illustrative statistical messages |
| Authentication | [authService.ts](./backend/src/services/authService.ts), [middleware](./backend/src/middleware/auth.ts) | SQL/Redis session lookup and current-role checks |
| Receipts / lifecycle | [idempotency.ts](./backend/src/shared/idempotency.ts), [retention.ts](./backend/src/shared/retention.ts) | Redis response helpers; unscheduled retention helpers |
| Browser | [routes](./frontend/src/routes/index.tsx), [health store](./frontend/src/stores/healthStore.ts), [auth store](./frontend/src/stores/authStore.ts) | Programmatic routing and global state |
| Charts / requests | [HealthChart.tsx](./frontend/src/components/HealthChart.tsx), [api.ts](./frontend/src/services/api.ts) | Recharts rendering and REST calls |

### Patterns implemented and their limits

**Batch insertion and retries.** The raw insert uses `ON CONFLICT (id, start_date) DO NOTHING`, which prevents a repeated identical key from creating another row. It does not bind that key to payload content or owner. Missing IDs receive fresh UUIDs. The reported synced count is the count of valid inputs, including rows ignored on conflict, not the count newly inserted.

The sequence is raw insert, device last-sync update, inline aggregation, cache invalidation, and Redis receipt storage. These are not one transaction. Failure after the insert can return an error despite committed samples, and there is no durable pending work to finish later.

**Operational hooks.** Request logging, HTTP metrics, successful-sync timing, readiness checks, and database startup retries provide useful entry points for diagnosing failures. They do not establish complete aggregation instrumentation, alerting, dependency deadlines, or a resilient queue. Several shared helper functions are never invoked.

**Simple authentication.** Sessions use UUID Bearer tokens with a hardcoded seven-day expiry. SQL and Redis writes/deletes are separate. A cache miss falls back to SQL; a Redis error does not. If logout deletes SQL but Redis deletion fails, the cached token can remain accepted. `SESSION_SECRET` and the configurable session max-age do not control this implementation.

### Ingestion, identity, and aggregation defects

Device sync overwrites the sample owner with the authenticated user and sets the path's device ID, but never verifies that device ownership matches. The foreign key checks only device existence. Sync also updates `last_sync` by device ID alone. Registration supports list/create only; repeat identifiers update name and last-sync without updating type/priority.

Explicit idempotency keys use a global Redis namespace. An authenticated caller reusing a key can receive another request's stored result, including raw invalid-sample details. Automatic keys use an order-sensitive 32-bit rolling hash over a subset of fields; units, IDs, source information, and metadata are omitted. Lookup/work/store is non-atomic, and the SQL idempotency table is unused.

Validation accepts unsupported units by leaving the number unchanged and assigning the canonical unit. For example, seven hours of sleep becomes seven minutes. It does not reject infinity, invalid end times, reversed intervals, future timestamps, or excessive backfills. The bulk insert also drops the sample's source-app field.

Aggregation fetches samples whose start times lie between the submitted batch's minimum and maximum start times, then replaces entire hourly/daily rows. A later single sample can therefore erase earlier contributions in that day. Intervals crossing bucket boundaries are assigned wholly to their start bucket. Host-local date operations and timezone-free SQL timestamps do not implement a user reporting timezone.

The clipping helper misses a lower-priority interval containing an existing covered interval, clips against only the first overlap, and never subtracts the full union of coverage. It duration-scales every metric, including rates and latest-value measurements. “Latest” selection follows the resulting priority order rather than the latest timestamp. Linear overlap scans can become quadratic.

Isolated source examples demonstrate the impact: a containing interval produces 120 instead of 90 units; a fragment overlapping two selected ranges produces 70 instead of 60; two 100-bpm samples become a 75-bpm average after clipping; an older lower-priority value can become the “latest” result. These are correctness defects, not intentional production trade-offs.

### Query, insight, and lifecycle limits

Query cache keys begin with `aggregates:` or `summary:`, while invalidation searches `user:<id>:*`. It matches neither family, leaving results stale for the five-minute TTL. Redis errors propagate instead of falling back to authoritative SQL. Other query methods are not cached merely because cache settings exist.

Raw reads use start-time filtering, offset pagination, and no hard maximum limit. Weekly summaries sum/average daily values across a rolling range without metric-specific weighting or complete-period coverage. “Latest” reads daily aggregates. History returns snake-case min/max/count fields while frontend types expect camel case.

Analysis runs only through the explicit API. Heart-rate regression uses observation index rather than elapsed dates. Sleep uses available rows without a missing-day denominator. Activity compares a partial current week with prior weekly totals. Weight has limited baseline validation. These examples are not clinically validated models.

Analysis stores insights but returns generated objects without the persisted IDs, creation times, or acknowledgment fields expected by the client. Duplicate detection is a non-unique recent lookup, so concurrent analysis can duplicate messages; existing acknowledgments and old creation times can survive updates. Conditions that disappear do not retire old messages automatically.

Retention functions are exported helpers without a scheduler or job command. They specify 2,555 days for raw samples, 730 for hourly aggregates/insights, and never delete daily aggregates; no archive precedes deletion. The retention audit table is not written. Sharing records have no consuming routes. Compression helpers are likewise not proof of an active compression system.

### Frontend behavior and limitations

The route definitions return a new Promise from an async import during component rendering. This is not the supported lazy route-component pattern; see [TanStack code splitting](https://tanstack.com/router/latest/docs/guide/code-splitting) and [React's cached Promise guidance](https://react.dev/reference/react/use). Isolated checks confirm the fresh-Promise behavior, but no browser navigation was run during this review.

The dashboard source has four summary cards, two 30-day charts, and five recent insights. The metric page offers ten metrics and 7/14/30/60/90-day ranges. Device UI lists and registers devices; it cannot edit, delete, or sync them. Admin UI shows stats and the first 50 users; it has no detail, pagination, or reaggregation controls.

History is keyed only by metric, so a late response for an older range replaces a newer range. Loading/error state is shared across unrelated requests. Logout clears auth but retains health state; late requests can also repopulate it after an account change. Auth initialization has no ready gate, and network errors can force logout. Health data is not persistently cached, but the Bearer token is in localStorage.

Charts use formatted month/day categories, can connect across missing dates, and do not supply an equivalent data table or explicit coverage information. Area mode ignores its min/max flag. Missing sleep can display as zero; some nullable values are treated as numbers. No request cancellation, live status stream, polling, offline health journal, chart downsampling, or optimistic sample sync is implemented.

The device modal lacks focus trapping and explicit label associations; navigation links disappear on small screens without a replacement menu. Errors are not consistently shown in dashboard, devices, or admin views. Acknowledgment updates local state after the server call, rather than optimistically.

### Setup, fixtures, and verification

Compose uses TimescaleDB `latest-pg16` on 5432 and Valkey 7 on 6379. Database credentials are `health_user` / `health_password`, database `health_data`. The backend loads `.env`, defaults to port 3000, and runs TypeScript source even for `npm start`. Vite proxies `/api` to 3000. The additional 3001–3003 scripts do not supply a load balancer.

The seed has seven invalid `dev...` UUIDs and matching raw references. The README provides a temporary fresh-demo copy using `dea...` instead. It contains four users, seven devices, 32 raw samples, 12 precomputed aggregates, five illustrative insights, and two unused shares. Inserted passwords were checked as `password123`. Seeded aggregate and insight semantics are not validated ground truth, and repeated seeding can duplicate rows.

The generator reads exported environment variables, uses a conflict target incompatible with the current composite raw key, holds generated data in memory, and bypasses normal overlap processing and cache invalidation. There is no backend migration, seed, or unit-test package script. Existing smoke/screenshot fixtures request `/dashboard` although the route is `/`, and ordinary-user admin checks can pass on a shared layout element.

The documentation review used 18 isolated checks against actual source with mocked infrastructure: 15 ingestion/query/seed checks and three frontend state/routing checks. These reproduced the limitations above. Documentation checks cover links, diagrams, shell syntax, exact local schema, and interview pacing. No migrations, setup recipes, complete build, browser flow, load test, or live-service integration test was executed.

The proposed outbox, source identity registry, correction protocol, policy generations, consistent publication, timezone model, privacy controls, and accessible report state are omitted locally. Historical iteration notes remain in [CLAUDE.md](./CLAUDE.md); setup belongs in the [README](./README.md).
