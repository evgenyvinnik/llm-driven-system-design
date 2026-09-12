# Ad Click Aggregator — Architecture

## System Overview

An advertising analytics service receives click events, records evidence, assigns
fraud signals, and serves time-bucketed reports. Its central problem is keeping
counts explainable under retries, partial failures, late events, and corrections.
Fast dashboard queries and authoritative accounting have different requirements.

This document separates a **proposed production design** from the **implemented local
system**. The production sections describe desired behavior; the final Implementation
Notes trace the current Express, PostgreSQL, Redis, and ClickHouse code. The local
system is an analytics demonstration and does not guarantee exactly-once counting,
a complete audit history, or billing-ready reports.

## Requirements

### Functional requirements — production design

- Accept clicks with stable event identity, event time, and ad/campaign context.
- Return a durable acceptance result that can be retrieved safely after retries.
- Report total, flagged, and eligible clicks by supported dimensions and time range.
- Distinguish provisional dashboard data from reconciled reporting periods.
- Preserve raw evidence and versioned fraud decisions so reports can be corrected.
- Support advertiser-scoped queries and administrative diagnostics.

### Non-functional requirements — proposed targets

| Concern | Target or invariant |
|---------|---------------------|
| Ingestion | 10,000 events/second sustained as a planning workload |
| Acceptance latency | p95 below 50 ms on an agreed deployment and payload profile |
| Query latency | p95 below 200 ms for bounded, pre-aggregated queries |
| Freshness | Typical dashboard data available within one minute |
| Availability | 99.9% ingestion, 99.5% reporting as initial SLOs |
| Durability | Acknowledge only after the authoritative record commits under the chosen replication policy |
| Correctness | A repeated event has one logical counting effect; corrections retain history |

These are design objectives, not measured local capabilities. Durability must name
its failure model: a local disk acknowledgement alone does not survive losing a
whole region. Impression tracking, auctions, conversion attribution, and ML training
are outside this design's initial scope.

## Capacity Estimation

At a sustained 10,000 events/second, daily volume is 864 million events. At an
illustrative 500 bytes per event, that is 432 GB/day, about 13 TB per 30 days, and
5 MB/second before replication, indexes, protocol overhead, or compression. If
10,000/second is only the peak, daily volume must instead use the average rate.

A five-minute dedup cache at that rate holds up to three million IDs. At an assumed
100 bytes per entry it needs roughly 300 MB before additional overhead, replication,
and fraud state. This cache estimate does not define the durable replay window.

Aggregate volume depends on active combinations of campaign, ad, country, device,
time bucket, and any sharding dimension. Precomputing every combination can explode
cardinality; define a small supported query set and measure sparsity.

### Local development scale

Run one to three Express instances with one PostgreSQL, one Valkey, and one ClickHouse
container. The UI defaults to a one-hour chart and refreshes every 30 seconds. There
is no measured 10,000-RPS capacity result or queue-backed burst buffer in the source.

## High-Level Architecture

```
┌───────────────────┐      ┌───────────────────┐
│ Trusted click SDK │─────▶│ Edge + collectors │
└───────────────────┘      └─────────┬─────────┘
                                    │ durable acceptance transaction
                                    ▼
                          ┌─────────────────────┐
                          │ Event records       │
                          │ + transactional outbox│
                          └──────────┬──────────┘
                                     │ relay; retries allowed
                                     ▼
                          ┌─────────────────────┐
                          │ Durable event stream│
                          └──────────┬──────────┘
                            ┌────────┴────────┐
                            ▼                 ▼
                  ┌─────────────────┐ ┌─────────────────┐
                  │ Fraud + rollups │ │ Raw archive     │
                  │ durable progress│ │ replay evidence │
                  └────────┬────────┘ └─────────────────┘
                           │ versioned aggregate snapshots
                           ▼
                  ┌─────────────────┐   ┌─────────────────┐
                  │ ClickHouse      │──▶│ Query service   │
                  │ read projection │   └────────┬────────┘
                  └─────────────────┘            ▼
                                        ┌─────────────────┐
                                        │ Dashboard       │
                                        └─────────────────┘
```

PostgreSQL is a candidate for authoritative event acceptance and metadata. At the
planning volume, partitioning, batching, retention, and potentially sharding need
measurement; a single unpartitioned local table is not the production sizing plan.
Redis is optional acceleration and fraud state, outside the durable acceptance
invariant. A queue does not replace idempotency at the projection boundary.

## Core Components / Request Flows

### Acceptance and replay

1. Validate the caller, event identity, timestamp bounds, and permitted ad hierarchy.
2. Map ad ownership from trusted metadata rather than trusting arbitrary advertiser IDs.
3. In one authoritative-store transaction, create the unique event and its outbox record.
4. If the identity already exists, compare the canonical payload and return its result;
   reject conflicting reuse rather than silently accepting different data under one key.
5. Return acceptance after commit. This does not mean the dashboard already contains it.
6. Relay committed outbox records to the stream, retrying safely after ambiguous sends.

A relay can publish twice if it crashes between send and progress update. Consumers
must expect replay. Marking a Redis key before a durable commit cannot safely stand
in for this transaction: it can suppress recovery of an event that was never stored.

### Fraud and aggregation

A consumer records an event's processed identity and updates its authoritative
aggregate state atomically, or uses a stream processor with an equivalent durable
state/checkpoint contract. A repeated delivery does not add another contribution.
Fraud decisions include rule version and reason; later reclassification produces
a correction rather than silently replacing the evidence.

To avoid retrying an additive insert into the analytics sink, publish versioned
absolute bucket snapshots. The logical key includes every grouping dimension and
any partial-aggregation shard. Queries select the latest revision for each logical
key before combining buckets. Replaying an identical revision is harmless; an older
revision must not overwrite a newer one. This is a proposed sink contract, not the
current SummingMergeTree implementation.

Keep raw data independently available for reconciliation and rebuild. Do not sum
multiple snapshot revisions or replay raw events into additive rollups without
first addressing their existing contribution.

### Time and distinct-user semantics

Store both event time and received time. Event time determines the reporting bucket;
received time supports lag measurements and plausibility checks. Use UTC internally
and half-open query intervals, with explicit timezone conversion at the API boundary.

A watermark describes expected completeness, not certainty that no event will ever
arrive later. Recent buckets remain provisional. Beyond a defined lateness horizon,
route events and fraud changes through versioned corrections and reconciled reports.

Click counts are additive over disjoint event sets. Distinct users are not: a user
who clicks in two hours is still one user for the two-hour interval. Store mergeable
sets/sketch states when union queries are required, or compute distinct counts from
canonical raw events. Label approximate results; do not add scalar distinct counts.

## Database Schema

The complete **implemented** DDL is in
[PostgreSQL init.sql](./backend/src/db/init.sql) and
[ClickHouse clickhouse-init.sql](./backend/db/clickhouse-init.sql).
These files, not illustrative snippets, define local tables and retention.

### Local PostgreSQL model

| Table | Key fields and constraints | Current role |
|-------|----------------------------|--------------|
| `advertisers` | `id` PK, name | Metadata |
| `campaigns` | `id` PK, advertiser FK, status | Metadata |
| `ads` | `id` PK, campaign FK, creative URL, status | Metadata |
| `click_events` | Unique `click_id`; optional unique idempotency key; event/fraud metadata | Raw event rows |
| `click_aggregates_minute/hour/day` | Unique bucket/ad/country/device combination | Legacy tables, not maintained by current ingestion |

Raw click ad/campaign/advertiser columns do not have foreign keys to the metadata
hierarchy. Their presence does not prove that a caller supplied a consistent chain.
The event's `processed_at` is set at PostgreSQL insertion, before downstream work
finishes, so it is not a reliable projection-completion marker.

The durable uniqueness constraints actually include:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_click_events_idempotency_key
ON click_events(idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

A unique `click_id` is also declared on the raw table. These protect rows in that
database; they do not make external Redis increments or ClickHouse inserts atomic.

### Local ClickHouse model

| Table | Engine/aggregation | Declared TTL |
|-------|--------------------|--------------|
| `click_events` | MergeTree, monthly partitions, ordered by campaign/ad/time/click | 90 days |
| `click_aggregates_minute` | SummingMergeTree plus insert-triggered MV | 7 days |
| `click_aggregates_hour` | SummingMergeTree plus insert-triggered MV | 30 days |
| `click_aggregates_day` | SummingMergeTree plus insert-triggered MV | 365 days |
| `campaign_daily_summary` | SummingMergeTree; breakdown arrays initialized empty | 365 days |

Each time-granularity view reads raw inserted blocks directly; hourly and daily
views are not cascades of the minute view. The analytics service reads these
rollups, and campaign summaries use the hourly table. TTL deletion happens through
ClickHouse's lifecycle processing, not an exact per-row deletion timer.

The existing minute/hour/day target engines sum only `click_count` and `fraud_count`.
Their `unique_users` column contains a block-local `uniqExact` result but is neither
a grouping key nor a summed/mergeable state. Background merges can retain an
arbitrary value for that column. Summing its surviving values in queries does not
recover distinct users. See [SummingMergeTree semantics](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/summingmergetree).

`advertiser_id` is grouped in the view but omitted from the target sorting key. If
an inconsistent caller reuses an ad/campaign under another advertiser, merges can
also collapse that attribution. Production validation and complete keys are needed.

### Production additions — not implemented

The proposal needs event/request payload fingerprints, transactional outbox records,
durable consumer progress, versioned fraud decisions, aggregate revisions, and
report-completeness metadata. Keeping these additions explicit avoids implying that
the current raw table is already a full audit ledger or a replay protocol.

## API Design

### Implemented endpoints

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/v1/clicks` | Zod validation; optional `Idempotency-Key`; 202 or 200 when click-ID duplicate is detected |
| POST | `/api/v1/clicks/batch` | 1–1,000 events processed sequentially; 202 with per-event outcomes |
| GET | `/api/v1/analytics/aggregate` | ISO range, entity filters, minute/hour/day granularity, country/device grouping |
| GET | `/api/v1/analytics/realtime` | ClickHouse minute rollups for requested lookback |
| GET | `/api/v1/analytics/realtime/global` | Redis global counter hash |
| GET | `/api/v1/analytics/realtime/campaign/:id` | Redis campaign counter hash |
| GET | `/api/v1/analytics/realtime/ad/:id` | Redis ad counter hash |
| GET | `/api/v1/analytics/campaign/:id/summary` | ClickHouse hourly totals and breakdowns |
| GET | `/api/v1/admin/stats` | PostgreSQL raw-event and metadata counts |
| GET | `/api/v1/admin/recent-clicks` | PostgreSQL event log |
| GET | `/api/v1/admin/campaigns`, `/api/v1/admin/ads`, `/api/v1/admin/advertisers` | Metadata lists |

Single-click input requires nonempty ad, campaign, and advertiser IDs. `country` is
an optional string of at most three characters, not validated as an ISO code.
`device_type` is optional but, when supplied, must be desktop, mobile, or tablet.
Validation errors contain `error` and `details`; this is not a flattened form-error API.

An aggregate response contains `data` rows with `time_bucket`, optional country/device,
`clicks`, `unique_users`, and `fraud_rate`, plus totals and service-measured
`query_time_ms`. That duration includes application work, not only database execution.
There is no country-equality filter, billing total, projection watermark, or report
revision in the current contract. `granularity` selects the time table; `group_by`
adds country/device dimensions.

### Proposed reporting contract

Production responses should identify the requested interval, timezone, data-complete
through time, report revision, metric definitions, and approximation status. Totals
should describe the whole requested set, independently of chart downsampling or row
pagination. An accepted test event should show “awaiting analytics” until projection
visibility is established rather than optimistically increasing an authoritative KPI.

## Key Design Decisions

### Durable acceptance before derived stores

A synchronous multi-store write is easy to follow locally, but failure after the
first write leaves partially applied effects. Running those writes in parallel
would not supply a distributed transaction either. The proposed outbox adds relay
and replay complexity in exchange for a durable record of work still to be done.
Redis may accelerate retries, but its TTL cannot define accounting correctness.

### Separate operational data from analytical reads

PostgreSQL provides transactional constraints and metadata relationships. ClickHouse
organizes scans and rollups for analytical access patterns. This workload distinction
motivates the split; it does not mean PostgreSQL cannot aggregate, ClickHouse cannot
join, or ordinary ClickHouse merges inherently lose raw data. Performance must be
measured against actual queries, dimensions, batching, and hardware.

The cost is managing a projection and its lag. At lower volume, PostgreSQL-only
aggregation may be a better starting point. At sustained high volume, a separate
analytics path can isolate reporting scans from acceptance writes.

### Explainable initial fraud rules with correction support

Velocity and missing-metadata rules are a useful starting point because their inputs
and reasons are inspectable. They can still flag legitimate shared-IP traffic and
miss distributed abuse. Store the evidence and rule version, keep “flagged” distinct
from final billing eligibility, and evaluate false positives. ML is an extension
when evidence and operational needs justify it, not automatically too slow or
inherently unexplainable.

## Consistency and Idempotency

The current system's guarantees are narrower than the production requirements:

| Boundary | What current code does | Consequence |
|----------|------------------------|-------------|
| Request key | Read/caches response in Redis for 300 seconds | No atomic request claim or payload comparison |
| Click ID | Redis `EXISTS`, then later `SETEX` | Concurrent requests can both proceed |
| PostgreSQL row | `ON CONFLICT (click_id) DO NOTHING` | At most one raw row for a click ID |
| Downstream effects | Run even if PostgreSQL inserted no row | Duplicate Redis/ClickHouse counts remain possible |
| Completion | Redis click marker precedes ClickHouse insertion | A retry can skip a missing analytics write |
| ClickHouse acknowledgement | `async_insert=1`, `wait_for_async_insert=0` | Buffered acknowledgement does not confirm persistence |

The ClickHouse return-mode distinction is documented in its
[asynchronous-insert reference](https://clickhouse.com/docs/concepts/features/operations/insert/asyncinserts).
The Compose image is 23.8; newer version-specific deduplication features must not be
assumed to exist or be configured in this local system.

If an idempotency response expires and a retry uses a new click ID with the same
request key, the PostgreSQL unique request-key index can raise a conflict. The code
only handles click-ID conflicts, so it does not recover the original result.

Flagged events contribute to `click_count` as well as `fraud_count`. The current
system does not exclude them from a billable ledger. Neither approximate dashboard
counts nor a total-minus-flags expression is a substitute for reconciled eligibility.

## Security / Auth

Production needs authenticated ingestion, advertiser-scoped authorization, trusted
metadata resolution, bounded/parameterized queries, and explicit proxy trust.
The local API has no authentication or tenant isolation. `cors()` is unrestricted,
`trust proxy` is true, and ClickHouse filters interpolate caller-provided strings.
Zod type validation does not make interpolated SQL safe.

The single-click route derives a simple noncryptographic IP hash when one is not
provided; it is not SHA-256 or a claim of anonymization. Clients may provide their
own hash. Batch ingestion does not perform the same server-side enrichment. Treat
these as demo fraud inputs, not trustworthy identity or compliance guarantees.

## Observability

Implemented Pino logging and prom-client metrics cover requests, ingestion outcomes,
PostgreSQL queries/pool state, some Redis operations, and health checks. Request logs
carry request IDs, while ingestion creates its own service logger rather than
propagating a request-scoped logger through every function.

`/health` returns an unconditional process status. `/health/live` adds uptime and
memory. `/health/ready` pings the three stores, but successful connectivity does not
validate schema completeness or count agreement.

Queue gauges and alert thresholds are declared in
[shared/metrics.ts](./backend/src/shared/metrics.ts) and
[shared/config.ts](./backend/src/shared/config.ts). There is no queue worker populating
queue depth/lag, no Prometheus scraping service in Compose, and no configured alert
rules. Exporting threshold values is not the same as deploying alerts.

Production should measure durable acceptance, oldest unprojected event, projection
lag, reconciliation mismatches, and late corrections. Dedup cache hit rate should
reflect retry traffic; a healthy stream of new clicks should mostly miss that cache.

## Failure Handling

| Failure | Current behavior | Required production behavior |
|---------|------------------|------------------------------|
| Redis unavailable | Some cache helpers swallow errors, but dedup/fraud/counter calls can fail ingestion | Explicit degraded policy backed by durable event identity |
| PostgreSQL write fails | Single route returns 500; later writes do not run | Retryable acceptance failure; no false success |
| Failure after PostgreSQL commit | Partial raw/counter/analytics state possible | Outbox replay completes pending projection |
| ClickHouse unavailable at boot | Server startup fails on connection initialization | Read/ingest failure domains separated where appropriate |
| ClickHouse schema application fails | Error logged; server may still start | Schema validation before readiness |
| Analytics query fails | Error response; no PostgreSQL fallback | Explicit unavailable/stale data, never fabricated zero |
| Aggregate correction | No rebuild worker or atomic publication procedure | Build a new revision and switch readers after validation |

ClickHouse does not automatically read missing events from PostgreSQL after recovery.
A proposed rebuild should use a stable input boundary, reconcile counts, account for
concurrent arrivals, and publish a new version. Deleting active aggregate ranges and
blindly replaying while live writes continue can lose or double-count contributions.

## Scalability Considerations

Measure collector latency, authoritative-store write pressure, stream lag, and query
cost separately. At sustained high volume, use batched projection writes, retention
management, and partitions appropriate to query access. Read replicas do not increase
a PostgreSQL primary's write capacity.

Hot campaigns can dominate one aggregation key. Partial aggregation across stable
subkeys can distribute additive work, with a final combine step; distinct states
must be unioned, not summed. Sharding only by campaign can still leave the hottest
campaign on one worker.

Limit query time ranges, grouping cardinality, result sizes, and concurrent work.
For charts, return an appropriate time resolution instead of all raw clicks. Start
with polling at a cadence supported by data freshness; push transport cannot make
an unprocessed event appear in a report.

## Trade-offs Summary

| Decision | Chosen in production proposal | Alternative | Rationale |
|----------|-------------------------------|-------------|-----------|
| Acceptance | Authoritative transaction plus outbox | Direct writes to several stores | Preserve retryable work across partial failure |
| Analytics | Rebuildable ClickHouse projection | PostgreSQL-only reporting | Isolate analytical access at sustained volume |
| Sink updates | Versioned absolute bucket snapshots | Replayed additive increments | Make retries and late revisions distinguishable |
| Distinct users | Mergeable state or canonical distinct query | Sum scalar per-bucket counts | Preserve set-union semantics |
| Fraud | Versioned rules with later corrections | Treat a live flag as final billing | Retain evidence and allow false-positive review |
| Dashboard updates | Poll with freshness metadata | Immediate push of every click | Match aggregate freshness and bound UI work |

## Implementation Notes

### What actually runs

One [Express entry point](./backend/src/index.ts) serves all route groups. PostgreSQL,
Valkey, and ClickHouse are single instances with named volumes in
[docker-compose.yml](./docker-compose.yml). The backend default is port 3000; explicit
multi-instance scripts use 3001–3003. Vite serves 5173 and proxies `/api` to 3000.

[click-ingestion.ts](./backend/src/services/click-ingestion.ts) performs this sequence:
request-cache lookup, click-ID check, fraud assessment, PostgreSQL insert, Redis
processed marker, Redis counters/HLL, ClickHouse insertion, then response caching.
The PostgreSQL write is not parallel with ClickHouse and its affected-row result is
not used to gate later steps.

```typescript
// Existing row-level protection; later effects still run after this call.
await storeClickEvent(clickEvent, idempotencyKey);
await markClickProcessed(clickId);
```

The transaction helper in [database.ts](./backend/src/services/database.ts) is not
used to make this ingestion sequence atomic. The batch route loops through events
sequentially and catches individual errors; its HTTP 202 can contain failed results.

### Implemented patterns and their boundaries

| Pattern | Source | Why it matters and local limit |
|---------|--------|--------------------------------|
| Row uniqueness and response caching | `services/click-ingestion.ts`, `services/redis.ts` | Reduce common retries; do not cover all side effects |
| Fraud velocity counters | `services/fraud-detection.ts`, `services/redis.ts` | Explainable signals; fixed expiry from first event, not a sliding window |
| Columnar rollups | `backend/db/clickhouse-init.sql` | Avoid repeated raw scans; current distinct-user representation is incorrect |
| Structured logging | `shared/logger.ts` | Searchable service/request context; no complete cross-service trace |
| Prometheus exposition | `shared/metrics.ts`, `src/index.ts` | Observable local request behavior; no deployed collector or alerts |
| Input schemas | `routes/clicks.ts`, `routes/analytics.ts` | Validate payload shape; no complete ownership or SQL-safety enforcement |

Fraud thresholds are hard-coded at more than 100 IP clicks or 50 user clicks within
a 60-second first-event expiry window. Timing checks flag millisecond values 0 and
500, not repeated inter-click intervals. Missing device, OS, and browser together
also trigger a signal. Known-bad sets are process-local. The generic rate-limit
helper is unused by the routes; fraud flags do not reject traffic.

Redis HLL keys are per ad/minute with a two-hour TTL. Real-time counters are hashes
whose whole-key TTL is renewed on every event; old bucket fields can remain as long
as a key stays active. Declared retention constants do not trim those fields or
schedule PostgreSQL archival.

### Frontend behavior

[dashboardStore.ts](./frontend/src/stores/dashboardStore.ts) refreshes five sources
concurrently: PostgreSQL stats, ClickHouse recent rollups, campaign/ad metadata, and
PostgreSQL recent events. Each fetch catches its own errors. A later successful
fetch can clear a prior error, and `lastUpdated` advances even after a partial failure;
it is a client refresh timestamp, not a data-completeness watermark.

The [home route](./frontend/src/routes/index.tsx) refreshes every 30 seconds and uses
a whole-store subscription. [ClickChart](./frontend/src/components/ClickChart.tsx)
is a Recharts line chart with local-time tick labels; it has no implemented zoom,
LTTB downsampling, or chart-specific accessibility summary. The analytics route owns
its own form/results state and supports country/device grouping. Campaign selection
fetches a seven-day summary. The test component sends a single event or a fixed-size
batch, not a continuously rate-controlled stream.

### Setup and omitted pieces

PostgreSQL's first-start schema and the explicit SQL paths are documented in
[README.md](./README.md). There is no backend migration or unit-test script. The
historical seed populates PostgreSQL only and contains a country value longer than
the raw table allows; the README uses minimal valid entity inserts followed by
API-generated events so the documented demo does not depend on that seed.

No Kafka, outbox, durable retry worker, projection reconciliation, fraud revision
ledger, archival pipeline, authentication, circuit breaker, or automatic analytics
fallback is wired into the local app. Single-node ClickHouse data persists through
ordinary container restarts via its volume, but replication and backups are absent.
Its SQL TTLs, not the unused longer-duration constants, govern analytics retention.

This review traced source and configuration. It did not run the stack or establish
throughput, latency, durability, billing correctness, or successful failure recovery.
