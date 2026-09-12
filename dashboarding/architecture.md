# Dashboarding architecture

## System Overview

A metrics dashboard collects observations, answers time-series queries, displays comparable charts, and evaluates alert conditions. Its central responsibility is preserving meaning: a missing sample is not zero, an unavailable query is not a healthy service, and an acknowledged batch must have crossed a defined durability boundary.

This document separates the **proposed production system** from the **current local implementation**. Production targets and mechanisms below are design proposals, not measured capabilities. The schema/API sections describe existing code, and the final Implementation Notes trace its actual behavior and limitations.

## Requirements

### Functional requirements — proposed production system

- Accept authenticated metric batches with stable retry identity, timestamp validation, and explicit sample semantics.
- Discover series by metric name and labels within an authorized tenant.
- Query bounded time ranges, filters, grouping, and aggregations at a stated resolution.
- View and configure dashboards containing time-series charts, gauges, and numeric summaries.
- Evaluate versioned alert rules with separate query windows, sustained-condition durations, and missing-data behavior.
- Keep incident history and deliver identifiable notifications through a repairable pipeline.
- Retain raw observations briefly and useful aggregate states longer, with a defined late-data policy.

Initial scope includes scalar gauges and cumulative counters. Histograms require a distribution-aware representation before percentile queries are offered. Logs, traces, arbitrary panel plugins, PromQL compatibility, and sub-second browser streaming are extensions, not requirements of this first design.

### Non-functional requirements — proposed targets

| Concern | Target or contract |
|---------|--------------------|
| Ingestion | 100,000 points/second sustained under a benchmarked workload |
| Availability | 99.95% ingestion, 99.9% dashboard query service |
| Query latency | p95 <500 ms for bounded 24-hour queries; <2 seconds for bounded seven-day queries |
| Acceptance | Acknowledged batches are durable in the ingestion log; visibility occurs later |
| Retry effects | Redelivery of the same immutable batch does not add duplicate sample effects |
| Display | Explicit resolution, observation age, coverage, and partial/error status |
| Alerts | No transition to healthy solely because telemetry is missing or a query failed |
| Isolation | Tenant and metric authorization on every read and write path |

A target must specify series count, returned buckets, label cardinality, hardware, and latency percentiles. “100K points/second” alone cannot establish storage cost or query performance. Retention and maximum supported outage/replay duration bound the durability promise.

## Capacity Estimation

Assume one million active series reporting every ten seconds: 100,000 samples/second and 8.64 billion/day. Assume 10,000 concurrent viewers, ten panels each, and a ten-second refresh cadence: 10,000 panel queries/second before deduplication. Batching can reduce HTTP requests but does not automatically reduce distinct database work.

The following are logical payload estimates, not physical database measurements. Use 24 bytes per raw observation and 48 bytes per aggregate state as illustrative budgets; rows, indexes, labels, WAL, replicas, and compression change actual storage.

| Tier | Assumed observations/states | Retention | Approximate retained payload |
|------|----------------------------|-----------|------------------------------|
| Raw | 8.64 billion/day | 7 days | 1.45 TB |
| One-minute state | 1.44 billion/day if every series is active | 30 days | 2.07 TB |
| One-hour state | 24 million/day | 365 days | 420 GB |

Longer retention can make an aggregate tier larger than a shorter raw tier. Rollups do not imply an arbitrary compression ratio. Sparse series, label dictionaries, compression, and retention choices must be measured independently.

A 1,200-pixel chart cannot usefully show millions of raw samples. A proposed response budget might permit about 1,000 time buckets per series and a bounded number of series, with stricter total-point and query-cost limits. Exact exports are a separate workload.

### Local Development Scale

The SQL seed creates 18 series and 6,498 observations across the previous hour on a fresh schema. The TypeScript seed creates 36 series and 12,996 observations. Neither continues collecting data afterward. Six panels polling every ten seconds generate about 0.6 data requests/second, in addition to metadata and alert polling. This is substantially different from the production workload.

## High-Level Architecture

### Proposed production system

```text
┌──────────────────────┐       ┌───────────────────────────┐
│ Metric producers     │──────▶│ Authenticated ingest      │
└──────────────────────┘       │ Validate / quota          │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │ Durable log               │
                               │ Identified batches        │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
┌──────────────────────┐       ┌───────────────────────────┐
│ Browser              │       │ Storage workers           │
│ Refresh + charts     │       │ Samples + receipts        │
└───────────┬──────────┘       └─────────────┬─────────────┘
            │                                │
            ▼                                ▼
┌──────────────────────┐       ┌───────────────────────────┐
│ Query API            │◀─────▶│ Time-series storage       │
│ Plan / authorize     │       │ Raw + aggregate states    │
└──────────────────────┘       └─────────────┬─────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │ Alert evaluators          │
                               │ State + delivery log      │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │ Notification workers      │
                               └───────────────────────────┘
```

PostgreSQL stores dashboard, rule, tenant, and access metadata. TimescaleDB initially supplies time-series storage within the relational deployment; separate pools and resource budgets protect ingestion from analytical reads. Redis caches reusable query results and sessions. A CDN serves the browser assets. These supporting components need not occupy most of an interview whiteboard.

Kafka is a possible durable ingestion log at the assumed scale. Its presence in the local Compose profile does not implement this path. Independent database instances with application-level routing are a possible later scaling choice; do not plan around the old TimescaleDB multi-node feature, whose last supported release was 2.13. [TimescaleDB multi-node deprecation](https://github.com/timescale/timescaledb/blob/main/docs/MultiNodeDeprecation.md)

## Core Components / Request Flows

### Series identity and metric meaning

A series is identified by tenant, metric descriptor, and a canonical label map. Serialize names/labels unambiguously rather than joining arbitrary strings with delimiters. Enforce allowed labels, label length/count, new-series rate, and total active-series quotas before allocating unbounded metadata or cache entries.

The descriptor records type and unit. A gauge is an observed level; a cumulative counter needs reset-aware change over time before it becomes a rate. A distribution cannot be reduced to an average if later queries need percentiles. [Prometheus metric types](https://prometheus.io/docs/concepts/metric_types/)

Define whether an average means average observed samples, equal weighting of hosts, or time-weighted value. These are different calculations under irregular sampling. The initial gauge query supports sample averages with counts and coverage metadata; a time-weighted gauge operation requires additional interval semantics. Rate samples already expressed in requests/second must not be summed across time and still labeled requests/second.

The local schema stores names, tags, timestamps, and scalar values without descriptors, units, observation identity, or a metric-type distinction. Panel units are display strings, not enforced measurement semantics.

### Accept a batch

1. Authenticate the producer and resolve tenant scope independently of client-supplied labels.
2. Validate a bounded immutable batch: batch identity, payload digest, sample types, labels, timestamps, and quota usage.
3. Append it to the durable log with the required broker acknowledgement policy. Return accepted identity only after that boundary succeeds.
4. A storage worker consumes a bounded batch, resolves series identities, and writes observations and a durable processed-batch receipt in one database transaction.
5. After commit, advance the consumer checkpoint. Redelivery finds the same receipt and does not reapply observations.

Producers retry the same immutable batch identity and payload; repacking old observations under new identities is not part of this deduplication contract. The receipt is scoped by producer/epoch and retained longer than supported broker replay and client retry windows. A changed payload under an old identity is rejected. If storage is later sharded, each identified storage fragment must have a single transactional owner and a defined relationship to the accepted submission.

A broker outage returns an explicit retryable failure, not an accepted count. A database outage accumulates bounded log lag. When backlog approaches the retention/capacity limit, apply backpressure before accepting work the system cannot retain. No finite queue makes all bursts or outages harmless.

Local ingestion instead performs series resolution and a direct array insert in the HTTP request, returning HTTP 200. There is no active broker/worker/receipt path, and its open-breaker fallback can report acceptance without an insert.

### Query a dashboard

The browser chooses one absolute query window and a refresh generation for all visible panels. A coordinator deduplicates equivalent plans, limits concurrency, pauses hidden work, and distributes independent panel results. A batch HTTP endpoint is a transport optimization; authorization and cost checks still apply per plan.

The API validates tenant, metric scope, time bounds, aggregation, grouping, and result budget. It selects a source based on available retention, materialization coverage, and requested resolution—not just the duration of the request. A short range from last year cannot use a seven-day raw tier.

Return canonical series identity, UTC bucket timestamps, effective interval/bounds, coverage, observation age, and any approximation/degraded status. The browser aligns series by timestamps, leaves missing values absent, and formats time only at presentation. One panel's error must not replace successful sibling results or an old query with a new range's title.

The local browser has independent ten-second timers. The backend returns per-complete-series results, ignores `group_by`, and provides no resolution/coverage/error metadata on a successful empty fallback.

### Evaluate a rule and notify

Separate the query window from the required duration of a continuously true condition. A five-minute mean above 90 at one evaluation does not prove CPU stayed above 90 for five minutes.

Assign each rule/group instance to one fenced evaluator and use a consistent evaluation cutoff. Persist rule version, last accepted evaluation, pending-since time, and incident state. Track data quality separately: no-data or query-error cannot silently resolve a firing incident. Product policy can open a telemetry incident while preserving the original condition's uncertainty.

A transaction changes incident state and appends a notification obligation. Notification workers retry identifiable deliveries, track actual outcomes, and retain permanent failures for repair. At-least-once delivery may still duplicate an external effect unless the receiver honors the delivery identity. Disable/delete semantics and rule revisions explicitly determine what happens to open incidents.

The local evaluator starts in each API process, queries a moving window, and checks/creates firing rows without serialization. Webhooks only produce a log message, after which `notification_sent` is set true.

## Database Schema

### Current local schema

This is [backend/db/init.sql](./backend/db/init.sql), reproduced exactly. It creates seven tables, the raw hypertable, and a raw retention policy. It does not create rollups or the additional production records described afterward.

```sql
-- Dashboarding System Schema
-- TimescaleDB extension for time-series data

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ============================================================================
-- Users table (for authentication)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(100) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Metric definitions (cached in Redis for fast lookups)
-- ============================================================================
CREATE TABLE IF NOT EXISTS metric_definitions (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, tags)
);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_name ON metric_definitions(name);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_tags ON metric_definitions USING GIN(tags);

-- ============================================================================
-- Metrics (time-series hypertable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS metrics (
    time            TIMESTAMPTZ NOT NULL,
    metric_id       INTEGER NOT NULL REFERENCES metric_definitions(id),
    value           DOUBLE PRECISION NOT NULL
);

-- Convert to hypertable with 1-day chunks
SELECT create_hypertable('metrics', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_metrics_metric_time ON metrics(metric_id, time DESC);

-- ============================================================================
-- Dashboards
-- ============================================================================
CREATE TABLE IF NOT EXISTS dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    layout          JSONB NOT NULL DEFAULT '{"columns": 12, "rows": 8}'::jsonb,
    is_public       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboards_user ON dashboards(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_public ON dashboards(is_public);

-- ============================================================================
-- Panels (visualization widgets on dashboards)
-- ============================================================================
CREATE TABLE IF NOT EXISTS panels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    panel_type      VARCHAR(50) NOT NULL,
    query           JSONB NOT NULL,
    position        JSONB NOT NULL,
    options         JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON panels(dashboard_id);

-- ============================================================================
-- Alert Rules
-- ============================================================================
CREATE TABLE IF NOT EXISTS alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    metric_name     VARCHAR(255) NOT NULL,
    tags            JSONB DEFAULT '{}'::jsonb,
    condition       JSONB NOT NULL,
    window_seconds  INTEGER NOT NULL DEFAULT 300,
    severity        VARCHAR(20) DEFAULT 'warning',
    notifications   JSONB NOT NULL DEFAULT '[{"channel": "console", "target": "default"}]'::jsonb,
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_metric ON alert_rules(metric_name);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);

-- ============================================================================
-- Alert Instances (fired alerts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS alert_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'firing',
    value           DOUBLE PRECISION,
    fired_at        TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    notification_sent BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_alert_instances_rule ON alert_instances(rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_instances_status ON alert_instances(status);

-- ============================================================================
-- Retention policy for raw metrics (7 days)
-- ============================================================================
SELECT add_retention_policy('metrics', INTERVAL '7 days', if_not_exists => TRUE);
```

### Proposed production additions

| Record or invariant | Purpose |
|---------------------|---------|
| Tenant and metric descriptor | Scope access and define type/unit/aggregation meaning |
| Canonical series identity and cardinality accounting | Prevent ambiguous cache identity and uncontrolled series growth |
| Processed-batch receipt with digest | Couple repeatable ingestion effects to committed samples |
| Rollup states: sum, count, min, max, observation/coverage metadata | Support valid recombination and honest chart resolution |
| Materialization/retention coverage and data generation | Plan queries against data that actually exists |
| Versioned dashboard/panel configuration | Reject stale concurrent layout/query replacement |
| Rule version and serialized evaluation state | Separate pending duration, incident state, and data quality |
| Notification outbox and delivery attempts | Distinguish recorded incidents from actual delivery |
| Appropriate unique active-incident constraint | Prevent duplicate firing instances for one rule/group |

The current raw table has no observation uniqueness. Repeating one value can alter averages if only some samples are duplicated, and always changes the observation count; sums change when duplicated values have a nonzero total. UUID primary keys on dashboard creation do not deduplicate retries that generate new IDs.

## API Design

### Current routes

Business paths use `/api/v1`; operational paths below are absolute. Responses are route-specific objects, not a uniform shared envelope. Types are separately defined in frontend and backend, and Zod validation runs on selected backend routes only.

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | `/metrics/ingest` | Public; up to 10,000 scalar points; HTTP 200 `{ accepted }` |
| POST | `/metrics/query` | Public; returns `{ results }` for a name, tags, bounds, aggregation, interval |
| GET | `/metrics/latest/:metricName` | Latest raw value from one arbitrary matching definition |
| GET | `/metrics/stats/:metricName` | Raw min/max/avg/count across matching definitions |
| GET | `/metrics/names`, `/metrics/definitions` | Public discovery without pagination |
| GET | `/metrics/tags/keys`, `/metrics/tags/values/:key` | Public tag discovery |
| GET / POST | `/dashboards` | Public/owned list; create requires editor or admin |
| GET / PUT / DELETE | `/dashboards/:id` | Read with public/owner/admin check; mutation requires login and owner/admin helper |
| GET / POST | `/dashboards/:dashboardId/panels` | List with dashboard access check; create uses owner/admin helper |
| GET / PUT / DELETE | `/dashboards/:dashboardId/panels/:panelId` | Single read lacks dashboard privacy check; mutations lack target-parent binding |
| POST | `/dashboards/:dashboardId/panels/:panelId/data` | Checks target parent and dashboard access, then queries the stored panel plan |
| GET / POST | `/alerts/rules` | Public rule list/create |
| GET / PUT / DELETE | `/alerts/rules/:id` | Public rule read/update/delete |
| POST | `/alerts/rules/:id/evaluate` | Public predicate test; does not itself create/resolve an incident |
| GET | `/alerts/instances` | Public history with loosely parsed optional limit/status |
| POST | `/auth/login`, `/auth/logout` | Email/password session login and logout |
| GET | `/auth/me` | Authenticated current user |
| POST / GET | `/auth/register`, `/auth/users` | Admin account creation/listing |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics` | Operational endpoints on these absolute paths |

The ingestion body contains a `metrics` array with `name`, `value`, `tags`, and optional numeric timestamp. Omission uses receipt time; timestamp zero also takes that fallback. Names have a length check but no name regex; label cardinality, timestamp bounds, and query cost are not constrained. Query dates and intervals lack complete semantic validation.

For production, add explicit accepted-batch identity, per-plan partial/error status, canonical series IDs, coverage metadata, bounded pagination, and optimistic configuration versions. Distinguish unavailable queries from legitimate empty results. Validate that a panel belongs to the dashboard whose permissions were checked on every read and mutation.

## Key Design Decisions

### Durable batches versus direct writes

Direct writes are a good local teaching choice because the database can be the acceptance boundary without another service. They require reporting the actual write outcome and preserving retry identity. An empty read fallback is never evidence that a write succeeded.

At the proposed sustained load, a durable log can absorb bounded bursts and let storage batch work independently. The cost is visibility lag, consumer recovery, retention planning, and backpressure. It does not provide unlimited buffering or linear scaling: partition concurrency, database capacity, WAL, and series resolution can still limit throughput. There is no universal tenfold COPY improvement or thousandfold WAL reduction to promise without measurements.

### Aggregate states versus raw scans

Raw observations support precise re-querying, but long dashboard ranges should not repeatedly scan billions of rows. Store mergeable states, then choose a resolution aligned with the display and retention policy. For an average, combine sums and counts; do not average bucket averages unless their sample counts are equal.

For example, one bucket averaging 0 from one observation and another averaging 100 from nine observations combine to 90, not 50. Keep min/max if a chart must expose spikes. Percentiles need a compatible histogram/sketch or raw observations; averages and per-bucket percentiles cannot reconstruct a global percentile.

This saves repeated query work but gives up information. A coarse bucket cannot answer an exact sub-bucket range after raw data expires. Report adjusted bounds/resolution or reject an exact request. Do not manufacture high-resolution points from coarse states.

### Coordinated polling versus independent timers or push

A ten-second polling coordinator matches trend monitoring without a persistent browser stream. It shares an absolute time window, deduplicates plans, caps in-flight work, and keeps partial results. Push becomes useful when a tighter freshness requirement justifies subscription state, recovery, and backend fan-out.

Independent panel timers are small and convenient for six local panels, but drift, overlap, and multiply work as dashboards grow. Batching ten panels into one request reduces network overhead only; ten distinct queries still cost database work. Polling frequency, aggregation delay, ingestion lag, and cache age all contribute to visible freshness.

## Consistency and Idempotency

Production ingestion is at-least-once transport with repeatable database effects for an identified immutable batch. Consumer checkpoints advance after the samples/receipt transaction. Configuration updates use expected versions and durable mutation identity where retries could create duplicates. Alert state transitions and notification obligations commit together.

Production queries may be stale within the declared freshness budget, but must accurately describe that state. Use non-overlapping, half-open time intervals when joining tiers. Combine closed materialized buckets with an unmaterialized raw tail only at a known boundary; partial edge buckets require raw data or a disclosed coarser effective range.

Late observations and corrections mean historical data is not automatically immutable. Refresh policies need a lookback that covers supported lateness, a controlled backfill path for older changes, and cache invalidation or data-generation changes. Keep raw data until required rollups are verified. Refreshing an aggregate over a region whose raw data has already been removed can erase retained aggregate history. [Timescale continuous-aggregate refresh policies](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/refresh-policies.md)

## Security / Auth

Apply tenant/metric scope checks to direct queries, discovery, dashboards, panels, alert rules, history, and ingestion. A private dashboard does not protect its metrics if the same data is available from an unrestricted query endpoint. Mutations bind the target panel to the exact authorized dashboard in the database operation.

Production sessions require secure transport, regeneration at login, request-origin/CSRF protection, and appropriate revocation checks. Producer credentials and human sessions serve different access patterns. Quotas cover points, bytes, new series, query work, and active rules rather than request counts alone.

Local authentication is partial: protected middleware revalidates the user/role from PostgreSQL, but public metrics/alert routes bypass it. Optional authentication is a no-op. Dashboard read paths can rely on stale session role, and the owner helper permits null/unknown owners. No rate-limit middleware is installed. Helmet is enabled with CSP explicitly disabled.

## Observability

The production platform needs independent monitoring of itself: durable acceptance versus visible sample count, log age, duplicate rejection, series creation rate, query cost/coverage, rollup lag, evaluation lag, open incidents with missing telemetry, and actual delivery outcomes. Its own collection failure must remain detectable outside the same failing ingestion path.

Locally, [metrics.ts](./backend/src/shared/metrics.ts) exposes Prometheus HTTP, ingestion/query, cache, circuit-breaker, dashboard/panel, and process metrics. Pool gauges update every five seconds. This exposition is separate from the demo's stored observations; there is no automatic self-ingestion bridge or Prometheus server in Compose. `alerts_firing` is defined but never updated. Query cache-hit labels are guesses such as `unknown`/`possibly`, not measured hit decisions.

`/health` checks PostgreSQL and Redis; database failure yields 503 and Redis-only failure yields a degraded 200. `/health/ready` checks only PostgreSQL; `/health/live` is constant process liveness. None validates rollup existence or notification delivery. Breaker timeouts do not cancel underlying SQL, so database-side time limits and bounded queues are also needed.

## Failure Handling

| Failure | Proposed response | Current behavior |
|---------|-------------------|------------------|
| Broker unavailable | Retryable rejection before durable acceptance | Broker unused |
| Raw insert fails | Failure/unknown outcome resolved through identity | Actual SQL errors propagate; open breaker returns fallback and reports accepted points |
| Long-range source unavailable | Explicit unavailable/partial coverage | Missing rollup errors can open shared breaker; subsequent results become empty |
| Uneven series timestamps | Timestamp alignment and missing values | Array-position alignment and zero substitution |
| No telemetry for a firing rule | Preserve incident uncertainty; expose no-data state | Can resolve the incident |
| Evaluator overlaps or runs on multiple APIs | Fenced ownership and conditional transition | Duplicate firing records can race into existence |
| Notification fails | Retain delivery state and retry | Webhook is a log-only simulation; delivery flag still set |
| Redis unavailable | Bounded cache bypass; session policy explicit | Cache helpers catch errors; default session paths can fail |
| User changes dashboard/range during fetch | Discard obsolete response | No request-generation or cancellation guard |

## Scalability Considerations

First bound avoidable work: series discovery, matching definitions, response points, query spans, alert rules, and parallel cache misses. Current ingestion resolves every point concurrently and can issue repeated upserts for one uncached identity; deduplicate identities within a batch and cap lookup concurrency before adding API instances.

For dashboard reads, choose a shared aligned refresh anchor and normalize equivalent queries. Exact millisecond timestamps from independent clients currently defeat much cross-request cache reuse. Cache only within the authorized scope and declared data generation; do not hide a dependency failure inside a long-lived successful empty entry.

Separate ingestion, interactive query, rollup maintenance, and evaluator resource budgets. Read replicas can serve suitable historical work, but alerts and recent panels need a declared visibility boundary. If the measured workload exceeds one storage node, partition tenants/series with explicit ownership and cross-partition aggregation rules; adding workers cannot create database capacity by itself.

Scale rule evaluation by stable partitions and track scheduling delay. A timer in every HTTP process is not distributed scheduling. Rate-limit notification retries and preserve incident/delivery identities across ownership changes.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Production acceptance | Durable log acknowledgement | Best-effort buffering | Explicit retention and replay boundary |
| Local ingestion | Direct array insert | Unwired broker dependency | Simple demonstration if actual write success is honored |
| Retry semantics | Immutable batch identity + database receipt | Unconditional duplicate rows | Preserve sums/counts and selective-retry averages |
| Long-range queries | Mergeable aggregate states | Repeated raw scans | Bound cost while exposing lost precision |
| Browser refresh | Coordinated polling | One timer per panel | Shared window, bounded work, partial status |
| Missing telemetry | Separate quality state | Empty interpreted as healthy | Avoid false incident resolution |
| Alert delivery | Transactional outbox | Log/flag after best effort | Distinguish an incident from delivery success |
| Configuration | Versioned relational records | Unconditional replacement | Detect stale edits and preserve ownership boundaries |

## Implementation Notes

### Local topology, scripts, and seeds

[Compose](./docker-compose.yml) runs TimescaleDB on PostgreSQL 16 and Valkey 7 by default. Kafka/Zookeeper require an optional profile and are not imported by application source. No RabbitMQ, Mailhog, notification worker, Prometheus server, or Grafana is configured. The API defaults to port 3000, matching the Vite proxy. Instance scripts on 3001–3003 work but do not configure a load balancer.

[Backend startup](./backend/src/index.ts) reads shell environment directly, listens without waiting for dependency readiness, and starts alert evaluation immediately and every 30 seconds. There is no `.env` loader or migration script. The consolidated schema is mounted for fresh volumes; the README also gives a non-destructive explicit reapplication command. Backend TypeScript uses NodeNext without a package `type: module`, emits to `dist`, and has working build/start script paths; frontend/backend types are separate definitions.

The SQL seed creates 18 production series, a fixed public dashboard, six fixed panels, and three rules. Reapplication appends samples and skips fixed-ID configuration conflicts. The TypeScript seed creates 36 production/staging series, writes points before trying the fixed dashboard insert, then creates random-ID panels/rules. It can fail after partial seeding on a repeat and does not close Redis on success. Neither creates users or ongoing telemetry. Admin-only registration therefore has no first-user bootstrap, and the browser has no authentication screen.

### Ingestion and identity behavior

[metricsService.ts](./backend/src/services/metricsService.ts) looks up IDs through an unbounded process Map, Redis with a one-hour TTL, and a PostgreSQL upsert. Its key concatenates sorted `key=value` pairs without escaping. Distinct maps such as `{a: "x,b=y"}` and `{a: "x", b: "y"}` collide and can store observations under the wrong series ID. The isolated check returned the same ID with only one definition write. Clearing the process Map does not clear Redis IDs.

The batch uses `Promise.all` across points before one `INSERT ... SELECT FROM unnest(...)`. It uses neither COPY nor a queue. Definition upserts are outside the final insert transaction, so a failed batch can leave metadata. Requests validate up to 10,000 points and a 10 MB JSON body, but not label count/length, series quotas, timestamp age, or query cost. There is no raw sample uniqueness or idempotency receipt.

The service passes an empty result into [withCircuitBreaker](./backend/src/shared/circuitBreaker.ts), then unconditionally increments success counters and returns the input count. The wrapper only returns that fallback for an open-breaker error; ordinary database errors and timeouts propagate. The decisive existing branch is:

```typescript
if (error instanceof Error && error.message.includes('Breaker is open')) {
  logger.warn({ query: query.substring(0, 100) }, 'Query rejected - circuit breaker open');
  return fallback;
}
throw error;
```

A breaker can reduce pressure on a failing dependency, but its fallback must preserve the operation's success/failure meaning. The isolated actual-module check forced the ingestion breaker open and observed `accepted: 1` with zero sample insert calls. An Opossum timeout does not cancel a write that may later complete.

### Query selection, aggregation, and caching

[queryService.ts](./backend/src/services/queryService.ts) selects raw data for spans up to six hours, `metrics_hourly` up to seven days, and `metrics_daily` for longer spans. The latter tables do not exist. Table selection ignores requested age and actual retention/materialization coverage. Missing-table errors initially return errors; after failures open the shared query breaker, definition/data reads can instead return empty fallbacks. Those can be cached as successful results and affect unrelated raw queries and alerts using the same breaker.

`group_by` is included in the cache key but ignored during execution. Queries always return one series per full metric definition. Raw aggregation uses inclusive start/end bounds and `time_bucket`; malformed intervals default to one minute, while zero or huge numeric intervals remain possible. The proposed rollup branch averages `avg_value` without count weighting and expects columns such as `sum_value`; creating arbitrary tables with the referenced names would not make that logic correct.

Latest-value reads choose one matching definition with an unordered `LIMIT 1`, not the newest sample across all matches. Stats aggregate all raw matching observations. The seed's request-rate panel sums gauge-like rate samples across time, so its `req/s` display label does not describe the calculation correctly.

[cache.ts](./backend/src/shared/cache.ts) recursively canonicalizes parameter keys and uses the first 16 hex characters of SHA-256. Query keys include exact ISO bounds; the browser's independent millisecond anchors reduce reuse. TTL is ten seconds unless the query ends more than an hour ago, when it is 300 seconds. Late writes mean historical results can still change. Cache get/set errors are caught; writes happen asynchronously and there is no single-flight miss coordination. The nominal 1 MB entry limit measures string length, not encoded bytes. Metric invalidation is a no-op and dashboard invalidation has no active callers; dashboard CRUD is not cached through this helper.

### Alert semantics and notifications

[alertService.ts](./backend/src/services/alertService.ts) runs window queries with default one-minute buckets. It averages bucket averages without sample weights, and for `count` returns the number of returned buckets rather than summing their sample counts. An isolated result containing bucket counts 40 and 60 evaluated to 2, not 100. The condition applies across all matching series, not an independently tracked incident for every host.

There is no pending-duration state, hysteresis, data-quality state, Redis alert state, or rule-version binding. No results returns `shouldFire: false`; the periodic evaluator then resolves an active incident. The isolated no-data case confirmed that update. A query exception logs an evaluation error instead, making a breaker-open empty response materially different from an ordinary failure.

Every API process evaluates all enabled rules, and async interval callbacks may overlap even in one process. Checking for an existing firing row and inserting a new one are separate operations without a unique active-incident constraint. Repeated evaluations while firing do not update the recorded incident value; the evaluation counter also omits that already-firing/true branch. Disabled rules are skipped, so existing firing rows need not resolve. Deleting a rule cascades its history.

Manual Test only evaluates the predicate. Notifications log to console or log that a webhook would be sent; neither an HTTP webhook nor email is implemented. The code then sets `notification_sent = true`, even for an empty notification list. There is no retry queue, delivery outcome, or notification breaker. Failure after incident creation can leave delivery unrecorded without another notification attempt while it remains firing.

### Authentication and dashboard operations

[auth.ts](./backend/src/shared/auth.ts) hashes passwords with bcrypt cost 12 and rechecks user existence/role on protected requests. Registration/listing users requires admin. The schema's default `user` role differs from the viewer/editor/admin middleware roles. Login does not regenerate the session; cookies use HttpOnly, SameSite=Lax, and production-only Secure. The app has no explicit CSRF token or rate limiter. `DISABLE_REDIS=true` switches only sessions to process memory; caches/health still call Redis.

Dashboard creation requires editor/admin. Other dashboard mutations use an owner/admin helper that permits null or unknown owners and does not independently require editor role. The public seeded dashboard has no owner. Optional-auth reads do not revalidate a session's role against the database. Metrics and all alert routes are public, so the permission catalog is not a complete data-access boundary.

[Dashboard routes](./backend/src/routes/dashboards.ts) protect whole-dashboard and panel-list/data reads, but a single-panel GET omits the parent dashboard's privacy check. Panel update/delete authorizes the dashboard ID in the URL and then mutates by panel ID without verifying the relationship, allowing an authorized or nonexistent supplied parent to be used for another panel. Service CRUD uses direct pool queries, not the defined dashboard breaker. Configuration saves have no expected-version check, and dashboard/panel reads use separate queries rather than one consistent snapshot.

### Browser behavior

The generated routes render under a root outlet. Routes/hooks use React local state; both Zustand stores are unused. There is no panel plugin registry, Module Federation runtime, iframe integration, shared data coordinator, drag/resize editor, or panel error boundary. The table panel is a placeholder; supported visual renderers are line/area/bar charts, CSS gauge, and stat.

[PanelChart.tsx](./frontend/src/components/PanelChart.tsx) maps the first series' timestamps and takes each other series' value at the same array index, substituting zero when absent. An isolated run of this actual mapping placed a sample from 00:01 at 00:00 and created zero at 00:02. It does not align by timestamp. Series keys use concatenated tag values without names/escaping, and colors depend on result order. Labels show only `HH:mm`; the computed full timestamp is not used by the tooltip.

[GaugePanel.tsx](./frontend/src/components/GaugePanel.tsx) and [StatPanel.tsx](./frontend/src/components/StatPanel.tsx) display the last bucket of the first returned series, without declaring its complete identity or freshness. The gauge clamps its geometry to 0–100 regardless of unit, while the numeric label can exceed that range. The explorer also plots only the first returned series; tags are displayed as metadata but cannot be selected as query filters in that UI.

Each renderer polls independently every ten seconds with its own current-time anchor, no cancellation, no request generation, no backoff, and no hidden-tab suspension. Late results can replace a new range/dashboard's data. Errors replace a previously populated panel rather than showing a labeled stale snapshot. The dashboard Refresh action reloads metadata, while its “Updated” label can advance before panel data changes. Dashboard cards show zero panels because the list response does not include them. Grid coordinates are fixed and are not adapted to a narrow viewport.

The alert banner separately polls up to ten firing rows and all rules every 30 seconds. It displays the returned count, not an exact global active count, and retains old state silently on errors. The alerts page uses a separate local hook with its own polling; create/toggle/delete refetch after success, without optimistic rollback or shared banner invalidation. An empty description is sent as `null` and rejected by the backend's optional-string schema. Form failures can propagate a rejected handler promise; rule toggles/deletes lack pending guards. Dashboard list/view errors are not cleared by later successful fetches.

### Operational wiring and verification limits

Opossum settings differ by operation: query 10 seconds/40%/60-second reset with volume 3; ingestion 5 seconds/60%/30-second reset with volume 5. The dashboard breaker is created and instrumented but never used by CRUD. Cache and breaker helpers demonstrate useful patterns, with the limits above. Pino logs requests and errors; only exact `/health` and `/health/live` URLs are excluded from automatic request logs. There is no complete query plan, slow-query policy, or notification trace pipeline.

Shutdown calls `server.close` without awaiting HTTP drain, stops the interval without awaiting an active evaluation, then closes PostgreSQL and Redis and schedules process exit. The pool metric interval is not cleared. This is a cleanup attempt, not a verified graceful drain of all work.

The documentation audit read all five documents, application source, schema/seeds, configuration, and smoke tests. Isolated checks used the actual TypeScript services and Opossum with mocked database/cache/metrics, plus the chart mapping with a formatting stub; they verified identity collision, false acceptance, failure propagation, count/no-data alert behavior, and timestamp misalignment. No external systems were contacted by those checks. Builds, native installs, database/queue startup, browser interactions, real concurrency, and load tests were not run. Four existing Playwright tests check page headings, not these correctness properties.
