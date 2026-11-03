# LLM Chat Analytics - Architecture

## System Overview

Near-real-time dashboards for an AI chat product: active users, conversations, response latency (time to first token and total), error and abandoned-generation rates, token usage and cost, and adoption of product features, broken down by organization, model and feature. Customers' org admins and analysts use it to watch their own usage; internal support staff use it to see whether an org is healthy.

The charts are the easy part. The design is mostly about where trustworthy numbers come from:

- **Every metric has a written definition** and one implementation, shared by the charts, the drill-down and the exports.
- **Events arrive late and twice.** Ingest deduplicates by `event_id`, buckets by event time, and says honestly how far the data is complete ("complete through" watermark). Late events reopen closed buckets, so yesterday's number can change, and the dashboard shows that it did.
- **Some metrics don't add up.** Distinct users and percentiles are stored as mergeable sketches (HyperLogLog, t-digest), never as numbers that later get summed or averaged.
- **"Yesterday" means the org's yesterday.** Storage is UTC; daily buckets are calendar days in each org's time zone, including zones with half-hour offsets.
- **Privacy and access are enforced by the server.** Content never enters the pipeline, small cohorts are suppressed, and cost columns are left out of responses for roles that can't see them.

**Learning goals:** event-time vs processing-time bucketing, watermarks, mergeable aggregates, materialized-view rollups, query planning across rollup granularities, URL-driven dashboard state, request cancellation, and role-gated analytics.

## Requirements

### Functional Requirements

1. **Overview** of a date range: active users, conversations, successful-response rate, error rate, abandoned-generation rate, TTFT p95, tokens, and (admins only) cost and cost per conversation, each compared with the previous week or month.
2. **Time series** for any metric by minute, hour or day, with the comparison period aligned bucket by bucket and the open period marked partial.
3. **Breakdowns** by model and by feature (feature adoption = share of active users who used it), which **cross-filter** every other widget.
4. **Drill-down** from a bar to the conversations behind it: metadata only, produced by exactly the same query as the bar.
5. **Freshness:** a label that says how complete the data is, and which recent days late events revised.
6. **Exports** of daily metrics or conversation lists as background jobs with progress.
7. **Definitions page** generated from the metric catalog and the event contract.
8. **Pipeline page:** partition positions, watermarks, duplicates dropped, late and rejected events.

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Ingest throughput | 500K events/s peak, 20B events/day | Every user message produces 2–4 events |
| Freshness | p99 ingest-to-queryable < 60 s; watermark lag < 2 min (server) and < 15 min (client) | "Near real time" a support engineer can act on |
| Correctness | Duplicates never double-count; late events up to 72 h land in their own bucket | Numbers people compare across days must be stable and explainable |
| Dashboard query latency | p95 < 500 ms for 28 days of daily buckets, < 2 s for 90 days hourly | Filters change several times a second |
| Availability | 99.9% for queries; ingest may lag but must not lose events | Kafka retention absorbs warehouse outages |
| Privacy | Zero message content in the pipeline; breakdowns under 5 users suppressed | Analytics must not become a way to read or single out people |
| Access | Billing data never leaves the server for roles without `billing:read` | Hiding a column in the browser is not access control |

## Capacity Estimation

### Production Scale

| Quantity | Estimate |
|----------|----------|
| Daily active users | 50M across 200K orgs |
| Events per active user per day | ~400 (40 messages × conversation, message, response, plus client lifecycle) |
| Events per day | 20B → ~230K/s average, ~500K/s peak |
| Raw event size in ClickHouse | ~60 bytes compressed (LowCardinality columns, no content) |
| Raw storage | 20B × 60 B ≈ 1.2 TB/day; 400-day retention ≈ 480 TB across the cluster |
| Minute rollup rows | orgs × models × features active per minute ≈ 2M/min at peak; kept 3 days |
| Hour rollup rows | ~30M/day; kept 90 days |
| Day rollup rows | ~3M/day; kept indefinitely |
| Dashboard queries | 20K concurrent viewers × 8 widgets / 60 s refresh ≈ 3K queries/s, most served from the result cache |

A day-grain query reads one `rollup_day_local` row per (day, model, feature): about 28 × 3 × 5 = 420 rows for a 28-day org chart, regardless of how many billions of events sit underneath.

### Local Development Scale

The seed produces 35 days of history for four fictitious orgs: about 280K events (12K on a weekday). The live generator then adds about 8 events a minute in real time, with 2% duplicates and 3% late client events. One ingest instance drains the seeded backlog in about 10 seconds.

## High-Level Architecture

```
┌──────────────┐   ┌──────────────┐
│ Chat clients │   │ Chat servers │   (web, desktop, mobile)       (generation service)
└──────┬───────┘   └──────┬───────┘
       │ client events    │ server events (no content, ever)
       ▼                  ▼
┌─────────────────────────────────────┐
│ Collector (stateless, autoscaled)   │  validate schema · stamp received_time · key by org_id
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐
│ Kafka: chat-events                  │  partitioned by org_id · 7-day retention (replay, backfill)
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐      ┌───────────────────────────────┐
│ Ingest consumers (consumer group)   │─────▶│ Valkey/Redis                  │
│ dedup claim · late check · enrich   │      │ dedup claims (96 h) · per-    │
│ (org tz → local_date, price → cost) │◀─────│ partition positions · per-day │
└──────────────────┬──────────────────┘      │ revisions · result cache      │
                   │ insert (dedup token)    └───────────────┬───────────────┘
                   ▼                                         │
┌─────────────────────────────────────┐                      │
│ ClickHouse                          │                      │
│  events (ReplacingMergeTree)        │                      │
│   ├─MV─▶ rollup_minute (3 d)        │                      │
│   ├─MV─▶ rollup_hour   (90 d)       │                      │
│   └─MV─▶ rollup_day_local (∞)       │                      │
└──────────────────┬──────────────────┘                      │
                   ▼                                         │
┌─────────────────────────────────────┐      ┌───────────────┴───────────────┐
│ Query API (stateless)               │─────▶│ PostgreSQL                    │
│ catalog · planner · access · cache  │      │ orgs + time zones · users ·   │
│ drill-down · freshness              │      │ roles · prices · coverage ·   │
└──────────────────┬──────────────────┘      │ export jobs                   │
                   │                         └───────────────┬───────────────┘
        ┌──────────┴──────────┐                              │
        ▼                     ▼                              │
┌──────────────┐      ┌───────────────┐   claim jobs         │
│ CDN + SPA    │      │ Export workers│◀─────────────────────┘
│ (React)      │      │ CSV → object  │
└──────────────┘      │ storage       │
                      └───────────────┘
```

## Core Components

### 1. Metric definitions (the catalog)

The catalog (`backend/src/api/services/catalog.ts`) is the single place where a metric is defined: its plain-language definition, unit, kind (sum, ratio, distinct, percentile), which stream's watermark bounds it, its sensitivity, the dimensions it can be split by, what its drill-down lists, and its formula over aggregates. The definitions page renders it, the query API computes from it, and the export worker writes columns from it.

| Term | Definition |
|------|-----------|
| **Conversation** | One `conversation_started` event, counted in the bucket of its event time, whatever happens afterwards. A conversation is counted when it starts, so it cannot be split by feature (features are known per message). |
| **Active user** | A distinct user who sent at least one message (`message_sent`) in the period. Opening the app or receiving a response does not count. |
| **Response attempt** | Exactly one server-reported terminal event per generation: `response_completed`, `response_failed` or `response_abandoned`. |
| **Successful response** | `response_completed`: the model streamed to its natural end and the server delivered the final token. Success rate = completed / attempts. |
| **Abandoned generation** | `response_abandoned`: the user pressed Stop or disconnected after the request started and before the final token. Reported by the server, which sees the stream end, so a closed tab still counts and a client that crashed can't under-report. |
| **TTFT / total time** | Server-measured, over completed responses only. Percentiles come from merged t-digests. |
| **Cost** | Tokens × list price in effect at event time, computed at ingest from the versioned price table. Billing data. |

Two definitional traps are enforced in code:

- **Dimension applicability.** Filtering conversations by feature would silently return 0. The API answers `422 DIMENSION_NOT_APPLICABLE` with the reason, and the overview tile shows "n/a with a feature filter".
- **Coverage.** The server only started reporting abandoned generations on a known date. Buckets before that are `not_collected`, and the chart draws a labelled gap, not zeros. A newly added metric whose rollups haven't been recomputed for old days shows `backfill_pending` until `rollups:rebuild` runs (see [Backfill](#backfill-a-new-metric)).

### 2. Event contract

Schema version 1, shared by every producer and by ingest (`backend/src/shared/contract.ts`):

| Field | Notes |
|-------|-------|
| `event_id` | UUID generated by the producer; the dedup key |
| `schema_version` | `1` |
| `event_type` | `conversation_started`, `message_sent` (client); `response_completed`, `response_failed`, `response_abandoned` (server) |
| `source` | `client` or `server`; must match the event type |
| `org_id`, `user_id` | `user_id` is pseudonymous and stable per org, never an email or name |
| `conversation_id`, `generation_id` | `generation_id` on response events |
| `event_time` | When it happened, by the producer's clock. All bucketing uses this |
| `received_time` | Set by the collector. Never trusted from a device |
| `model`, `feature`, `platform` | Dimensions |
| `ttft_ms`, `latency_ms`, `input_tokens`, `output_tokens`, `error_code`, `abandon_reason` | Measures, by event type |

The schema is **strict**: an unknown key rejects the event. Keys that look like content (`content`, `text`, `prompt`, `message`, `completion`, …) are rejected with their own reason (`content_field`) so a leaking producer pages its owners. Rejected events are recorded as metadata (reason, partition, offset) without the payload.

### 3. Ingest: dedup, late data, enrichment

For each chunk of up to 2,000 messages from one partition (`backend/src/ingest/`):

1. **Skip already-inserted offsets.** If this partition's `inserted-through` offset is ahead of the message, the rows are already in ClickHouse from a run that crashed before committing.
2. **Validate** against the contract. Invalid → `rejected_events`.
3. **Re-stamp clock skew.** A client event more than 60 s in the future is moved to its `received_time`.
4. **Reject too-late events.** Older than 72 h on arrival → rejected: those buckets are sealed.
5. **Dedup claim.** `SET dedup:{event_id} {partition}:{offset} NX GET EX 96h` in one pipeline per chunk. Absent → claimed; present with this message's own `partition:offset` → a redelivery of the same message, keep it; present with any other value → a duplicate, drop it.
6. **Late check.** `is_late = event_time < watermark(stream)`: the event changes a bucket the dashboard has already called complete.
7. **Enrich.** `local_date` = the event's calendar date in the org's time zone; `cost_micros` from the price in effect at `event_time`.
8. **Insert** with `insert_deduplication_token = p{partition}-{first}-{last}`, after recording that range as in flight.
9. **Record** `inserted-through`, counters, and bump `rev:{org}[local_date]` for each day a late row touched.
10. **Commit** the Kafka offset.

### 4. Rollups

ClickHouse materialized views maintain three `AggregatingMergeTree` tables on every insert into `events`:

| Table | Bucket | Retention | Used for |
|-------|--------|-----------|----------|
| `rollup_minute` | UTC minute | 3 days | Minute charts, ragged edges of windows |
| `rollup_hour` | UTC hour | 90 days | Hour charts, sub-day parts of windows |
| `rollup_day_local` | Org-local date | Forever | Day charts, whole days of windows |

Counts and sums are `SimpleAggregateFunction(sum)`. Distinct users are `uniqCombined64` states (HyperLogLog-based), and latency percentiles are `quantilesTDigest(0.5, 0.95, 0.99)` states. Because states merge, the week's active users are `uniqCombined64Merge` over seven days of states, and a daily p95 is a merged digest. Neither is a sum of daily counts or an average of hourly percentiles.

### 5. Watermarks and freshness

Each ingest instance reports, every 2 s and per partition, a **position**: the newest `received_time` it has written to ClickHouse, or *now* if the partition has no backlog. Kafka keeps each partition in arrival order, so everything received before a partition's position has been ingested. The watermark for a stream is

```
watermark(stream) = min over all partitions(position) − allowance(stream)
allowance: server 1 min, client 10 min
```

A partition that never reported makes the watermark unknown. A partition whose owner stopped reporting holds it back. Both cases show up on the pipeline page, and the label turns red instead of lying. A metric's watermark is the minimum over the streams it reads (cost per conversation reads both).

The UI keeps two clocks apart: **"complete through"** (this watermark) and **"last refreshed"** (when the browser last fetched). A dashboard can refresh every 15 seconds while the data is an hour behind.

### 6. Query planning

A window like "this week so far" or "last week up to the same moment" does not align to any one table. The planner (`backend/src/api/services/planner.ts`) splits `[from, to)` into pieces:

```
[from ─────────────────────────────────────────────── to)
 │ raw │ minute │ hour… │      whole local days      │ hour… │ minute │ raw │
         (≤3 d)                (rollup_day_local)
```

Each piece yields the same set of states, so one query `UNION ALL`s them and merges once. In Asia/Kolkata (UTC+5:30), local midnight is 18:30 UTC, so the planner falls back to minute rollups for the half-hours. Day charts read `rollup_day_local` directly. Hour charts read UTC hours, clipping the first and last bucket at the range edge when the zone's day doesn't start on a UTC hour.

### 7. Comparisons

Week-over-week shifts each bucket back seven days in **local wall-clock time** (Monday 09:00 → previous Monday 09:00), so the DST change (Nov 1, 2026 in Los Angeles) doesn't misalign the week. Month-over-month shifts by a calendar month, clamping Mar 31 to Feb 28; clamped buckets are flagged. The **open bucket** is compared with the previous bucket *up to the same elapsed time*. KPI tiles compare `[from, now)` with `[shift(from), shift(now))`. That stops a half-finished day from looking like a 60% drop.

### 8. Drill-down

The drill request carries the chart's resolved query plus the bucket start. The server re-runs the same `filterClause` against `events FINAL`, bucketed the way the rollup bucketed it (`local_date = d` for day buckets, `event_time ∈ [start, end)` otherwise). It returns:

- `rollupCount`: the bar's own number, from the same rollup
- `matched`: the raw-event count (or exact distinct users)
- one page of conversations with metadata and each conversation's own totals

For exact metrics the panel shows "rows add up to the bar". A mismatch would mean a duplicate got past dedup into a rollup; the raw table collapses it at merge time and `rollups:rebuild` repairs the rollup. For HyperLogLog metrics the panel says the bar is an estimate and the list is exact.

### 9. Client

The React client keeps all dashboard state in the URL. It resolves relative ranges to absolute, bucket-aligned instants in the org's time zone and derives every widget's cache key from that resolved query. Each widget's breakdown excludes its own dimension (cross-filtering). Superseded requests are aborted, and the server echoes the canonical query so a late response for old filters is discarded. Each widget has its own loading, refreshing, empty, error, not-applicable, forbidden, partial and suppressed state. See `system-design-answer-frontend.md` for the full reasoning.

## Database Schema

### ClickHouse

```sql
CREATE TABLE chat_analytics.events (
    event_id UUID, schema_version UInt8,
    event_type LowCardinality(String), source LowCardinality(String),
    org_id LowCardinality(String), user_id String,
    conversation_id String, generation_id String DEFAULT '',
    event_time DateTime64(3, 'UTC'), received_time DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    local_date Date, org_tz LowCardinality(String),
    model LowCardinality(String), feature LowCardinality(String), platform LowCardinality(String) DEFAULT '',
    ttft_ms UInt32 DEFAULT 0, latency_ms UInt32 DEFAULT 0,
    input_tokens UInt32 DEFAULT 0, output_tokens UInt32 DEFAULT 0, cost_micros UInt64 DEFAULT 0,
    error_code LowCardinality(String) DEFAULT '', abandon_reason LowCardinality(String) DEFAULT '',
    lateness_ms UInt64 DEFAULT 0, is_late UInt8 DEFAULT 0
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (org_id, toDate(event_time), event_type, event_id)
TTL toDateTime(event_time) + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;

-- One of three identical-shaped rollups (minute, hour, day_local):
CREATE TABLE chat_analytics.rollup_day_local (
    local_date Date, org_id LowCardinality(String),
    model LowCardinality(String), feature LowCardinality(String),
    conversations SimpleAggregateFunction(sum, UInt64),
    messages SimpleAggregateFunction(sum, UInt64),
    responses_ok SimpleAggregateFunction(sum, UInt64),
    responses_failed SimpleAggregateFunction(sum, UInt64),
    responses_abandoned SimpleAggregateFunction(sum, UInt64),
    input_tokens SimpleAggregateFunction(sum, UInt64),
    output_tokens SimpleAggregateFunction(sum, UInt64),
    cost_micros SimpleAggregateFunction(sum, UInt64),
    late_events SimpleAggregateFunction(sum, UInt64),
    last_revised_at SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    active_users AggregateFunction(uniqCombined64, String),
    ttft AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32),
    latency AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt32)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(local_date)
ORDER BY (org_id, local_date, model, feature)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW chat_analytics.rollup_day_local_mv TO chat_analytics.rollup_day_local AS
SELECT local_date, org_id, model, feature,
       countIf(event_type = 'conversation_started') AS conversations,
       -- … the other counts and sums …
       uniqCombined64StateIf(user_id, event_type = 'message_sent') AS active_users,
       quantilesTDigestStateIf(0.5, 0.95, 0.99)(ttft_ms, event_type = 'response_completed') AS ttft,
       quantilesTDigestStateIf(0.5, 0.95, 0.99)(latency_ms, event_type = 'response_completed') AS latency
FROM chat_analytics.events GROUP BY local_date, org_id, model, feature;
```

Full DDL: `backend/db/clickhouse-init.sql`. Note the `StateIf` order: `-If` wraps `-State`, so the state type is `AggregateFunction(uniqCombined64, String)` and merges with states built anywhere else.

### PostgreSQL

```sql
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, time_zone TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
                    display_name TEXT NOT NULL, is_staff BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE memberships (user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
                          role TEXT NOT NULL CHECK (role IN ('admin', 'analyst')), PRIMARY KEY (user_id, org_id));
CREATE TABLE model_prices (model TEXT, effective_from TIMESTAMPTZ, input_micros_per_mtok BIGINT NOT NULL,
                           output_micros_per_mtok BIGINT NOT NULL, PRIMARY KEY (model, effective_from));
CREATE TABLE metric_coverage (metric TEXT PRIMARY KEY, collected_from DATE NOT NULL, available_from DATE NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE export_jobs (
    id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily_metrics', 'conversations')),
    query JSONB NOT NULL, columns TEXT[] NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
    rows_total BIGINT, rows_done BIGINT NOT NULL DEFAULT 0, file_path TEXT, file_bytes BIGINT, error TEXT,
    attempts INT NOT NULL DEFAULT 0, worker_id TEXT, lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX export_jobs_claim_idx ON export_jobs (status, created_at);
```

### Valkey keys

| Key | Type | Purpose |
|-----|------|---------|
| `dedup:{event_id}` | string, TTL 96 h | `partition:offset` of the message that claimed the event |
| `ingest:inserted-through` | hash partition → offset | Offsets already in ClickHouse |
| `ingest:inflight` | hash partition → `first-last` | Chunk whose insert started but wasn't recorded; rebuilt identically after a crash |
| `ingest:positions` | hash partition → `{position, updatedAt, lag}` | Watermark inputs |
| `ingest:counters` | hash | accepted, duplicates, late, already_inserted, rejected:* |
| `rev:{org}` | hash local_date → n | Bumped when late events land; part of every cache key |
| `q:{sha1}` | string, TTL 10 s / 600 s | Cached widget responses |
| `session:{id}` | string, TTL 7 d | Session |

## API Design

All query endpoints take the same canonical filter params: `org`, `from`, `to` (ISO instants: local midnights in the org's zone for day grain, any whole minute for hour and minute grain, whose edge buckets are clipped), `grain` (`minute|hour|day`), `models`, `features` (comma lists), and `compare` (`none|wow|mom`).

```
POST /api/v1/auth/login                  → { user, orgs: [{ orgId, timeZone, role, permissions }] }
POST /api/v1/auth/logout
GET  /api/v1/auth/me

GET  /api/v1/query/overview?…            → KPI tiles: value, previous, delta, coverage, notApplicable
GET  /api/v1/query/series?…&metric=      → buckets: value, count, partial, open, coverage, suppressed,
                                           lateEvents, revisedAt, previous {value, toDate, clamped}, clipped
GET  /api/v1/query/latency?…             → p50/p95/p99 TTFT and total per bucket
GET  /api/v1/query/breakdown?…&metric=&dim=model|feature
                                         → rows {key, value, users, share, suppressed}, hiddenGroups
GET  /api/v1/query/drilldown?…&metric=&bucket=&offset=&limit=
                                         → rollupCount, matched, users, conversations, rows (metadata)

GET  /api/v1/meta                        → metric catalog, event contract, dimensions, coverage
GET  /api/v1/freshness?org=              → watermarks per stream, backlog, revised days
GET  /api/v1/pipeline                    → partitions, counters, rejections, rows per minute

POST /api/v1/exports  (Idempotency-Key)  → 202 job | 200 existing job for the same key
GET  /api/v1/exports                     → the user's jobs
GET  /api/v1/exports/:id                 → status, rowsDone / rowsTotal
GET  /api/v1/exports/:id/download        → CSV (permissions re-checked)
```

Every query response carries `echo`: the canonical query string. Example series bucket:

```json
{
  "start": "2026-11-02T08:00:00.000Z", "end": "2026-11-03T08:00:00.000Z", "key": "2026-11-02",
  "value": 876, "count": 876, "partial": true, "open": true, "coverage": "ok", "suppressed": false,
  "lateEvents": 20, "revisedAt": "2026-11-03T04:15:12.080Z",
  "previous": { "start": "2026-10-26T07:00:00.000Z", "value": 1028, "clamped": false, "toDate": 929 }
}
```

Error codes the UI branches on: `401 UNAUTHENTICATED`, `403 FORBIDDEN` / `METRIC_FORBIDDEN`, `404 ORG_NOT_FOUND` (also for orgs you aren't in), `400 UNALIGNED_RANGE` / `TOO_MANY_BUCKETS`, `422 DIMENSION_NOT_APPLICABLE`.

## Key Design Decisions

### 1. Dedup at ingest, before the materialized views

Materialized views fire on every insert into `events`, so a duplicate that reaches the table is counted in every rollup. Dedup therefore has to happen before the insert. Each event_id is claimed in Valkey with the `partition:offset` of the message that carries it. A different message with the same id is a duplicate. The *same* message coming back is Kafka redelivering after a crash, and is kept. Two more layers cover the crash windows:

- **The insert token.** A deterministic `insert_deduplication_token` makes a retried insert of the same chunk a no-op. That includes the materialized views, but only when each rollup table also has `non_replicated_deduplication_window`. Testing found that without it, the raw table dropped the retry while the views counted it twice.
- **The inserted-through offset.** It skips chunks that made it to ClickHouse before the crash.
- **The in-flight range.** The token only matches if the retried chunk is identical. Kafka can redeliver more messages after a crash than the original batch held, so the chunk's `first-last` offsets are recorded before the insert, and the next owner cuts its first chunk at exactly that range.

The alternative, ReplacingMergeTree alone, deduplicates the raw table *eventually* (at merge time) and the rollups never. It remains the backstop: `events FINAL` is the truth that drill-downs and rebuilds read. The cost is a Valkey round trip per chunk and ~100 bytes per event for 96 hours.

### 2. Event time with a watermark, not processing time

Bucketing by arrival time would make numbers stable but wrong. A phone that was offline for an hour would move a 09:00 conversation into 10:00, and a backfill would land a week of history in one minute. Bucketing by event time makes numbers right but means past buckets change. The watermark is how the UI stays honest about that: before it, the data is complete; after it, the buckets are hatched as partial. Late events are flagged, counted per bucket and revision-stamped, so "why did yesterday change?" has a visible answer: "+200 late events at 20:18".

### 3. Sketch states in rollups, not finished numbers

Storing `unique_users UInt64` per hour (what the ad-click project does) makes daily active users impossible to compute: a user active in five hours is counted five times. The same goes for p95. Storing HyperLogLog and t-digest states costs more bytes per row, and the numbers are approximate (about ±1% for distinct counts). In exchange, any combination of buckets merges correctly: a week, a filter, the hour rollup plus a raw edge. The UI marks these values with ≈ and says why the drill-down's exact count can differ.

### 4. Daily rollups keyed by the org's local date

The alternative is to keep only UTC hours and group them into local days at query time. That works for whole-hour offsets, breaks for India (+5:30), Nepal (+5:45) and Newfoundland (−3:30), and needs 24 hour-rows per day per dimension combination. Instead, ingest computes `local_date` from the org's time zone and the daily rollup groups by it. The cost: a time-zone change only applies to new events; old days are re-localized by `rollups:rebuild --relocalize`.

### 5. One planner for every window

Tiles, comparisons to date, clipped hour buckets and breakdowns all ask for arbitrary windows. Rather than special-casing each, the planner decomposes any window into day, hour, minute and raw pieces with identical state columns. This is what makes "this week so far vs last week up to the same moment" exact in any time zone.

### 6. Access applied on the server, and part of the cache key

Billing metrics are never computed for a caller without `billing:read`. The overview omits the tiles entirely, the series endpoint returns 403, and drill-down and export rows have no cost column. The result cache key includes the caller's permission scope. Without it, an analyst could be served an admin's cached response for the same query, cost and all; a test asserts this can't happen.

### 7. Kafka between the collector and the warehouse

Kafka absorbs warehouse outages (7-day retention), lets several consumer groups read the same stream (real-time ingest, a future fraud or alerting consumer), and is the replay source for rebuilds. Partitioning by `org_id` keeps one org's events in order, which the per-partition watermark relies on.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Event ingest | Effectively once per event_id within 96 h | Valkey claim per event_id + insert token + inserted-through offset |
| Retried insert of a chunk | No double count, raw or rollup | `insert_deduplication_token` with a dedup window on every table |
| Late event | Lands in its own bucket; visible revision | `is_late`, `late_events`, `last_revised_at`, `rev:{org}[date]` |
| Event later than 72 h | Rejected, recorded | `too_late` in `rejected_events` |
| Export creation | One job per click | `UNIQUE (user_id, idempotency_key)` |
| Export processing | One owner at a time | `FOR UPDATE SKIP LOCKED` claim, 30 s lease, writes fenced on `worker_id` |
| Rollup rebuild | No race with live ingest | Only sealed days (older than 72 h); refuses newer days |

**Design Review Checklist**

1. **Source of truth.** The `events` table (`FINAL`) for numbers; PostgreSQL for configuration and jobs. A write succeeds when the ClickHouse insert returns and inserted-through is recorded; the Kafka commit follows.
2. **Client retries after losing the response.** Producers retry with the same `event_id` and the duplicate is dropped. A retried export POST with the same Idempotency-Key returns the original job.
3. **Failure between two steps.** Crash after the dedup claim but before the insert: the redelivered message carries the same claim and is kept. Crash after the insert, before the commit: the inserted-through offset skips it. Crash between those two: the insert token makes the retried chunk a no-op, because the chunk's offset range was recorded as in flight before the insert and the new owner rebuilds exactly that range. Export worker dies mid-file: the lease expires, another worker reclaims the job, and the old worker's fenced writes fail.
4. **Ordering.** Only per-partition order is needed, and only for the watermark. Rollups are commutative merges, so event order inside a bucket doesn't matter.
5. **Access with caches and jobs.** Permissions are re-read from PostgreSQL per request, are part of the cache key, are fixed into export columns at creation and are re-checked at download. Breakdowns and drill-downs under 5 users are suppressed before the response is built.
6. **What breaks first.** The Valkey dedup set (memory grows with events/s × 96 h) and the per-org hot partition. Evidence: `analytics_ingest_batch_seconds` p99 and Valkey `used_memory`. See Scalability Considerations.

### Execution traces

**Success, a late event revising yesterday.** (1) A phone that was offline sends `conversation_started` for 14:05 yesterday (Los Angeles); the collector stamps `received_time` = now. (2) Ingest validates it; lateness is 30 h, under 72 h. (3) `SET dedup:… NX GET` returns nil, so the event is claimed. (4) Yesterday is behind the client watermark, so `is_late = 1`. (5) `local_date` = yesterday in America/Los_Angeles. (6) The insert's materialized views add 1 to yesterday's `conversations` and `late_events` and set `last_revised_at`. (7) Ingest bumps `rev:larkspur[yesterday]`. (8) The next dashboard query has a new cache key, misses, and reads 489 instead of 488. The bar shows ↻, and the freshness popover lists "+201 late". (9) Drilling into the bar still reconciles, 489 = 489.

**Failure, an ingest crash mid-chunk with a client retry.** (1) A client sends event E; the acknowledgement is lost; it retries, so Kafka holds E at offsets 100 and 140. (2) Ingest claims E for `0:100`, inserts the chunk 100–199 with token `p0-100-199`, and is killed before writing inserted-through. (3) A new consumer gets the partition at committed offset 100 and rebuilds the same chunk. E at offset 100 finds its own claim and is kept. E at offset 140 finds `0:100` and is dropped as a duplicate. (4) The insert with token `p0-100-199` is ignored by `events` and by all three rollups. (5) Inserted-through and the commit advance. The count is unchanged, and the pipeline page shows one more duplicate.

## Security / Auth

- **Sessions:** an opaque session ID in an httpOnly cookie; session data in Valkey.
- **Roles per org:** `admin` (metrics, billing, drill-down, export), `analyst` (no billing), and internal `support` (all orgs, metrics only: no billing, no conversation lists). Roles are re-read on every request.
- **Org isolation:** every query is scoped by `org_id`. Orgs you don't belong to return 404, not 403.
- **Privacy:** the strict schema rejects content-like fields; `user_id` is pseudonymous; drill-downs show metadata only. Suppression covers breakdown rows, filtered series buckets and drill-downs under 5 distinct users. Small groups are pooled into "other" only when the *merged* distinct count reaches 5 (summing distinct counts across groups over-counts people), and never when there is exactly one small group.
- **Rate limiting** (production, not implemented locally): a per-user query budget at the gateway and a cap on concurrent exports per user.

## Observability

Prometheus metrics (`backend/src/shared/metrics.ts`):

```
analytics_events_ingested_total{stream,late}
analytics_events_dropped_total{reason}           # duplicate | already_inserted | schema | content_field | too_late | unknown_org
analytics_ingest_batch_seconds                   # dedup + insert + commit per chunk
analytics_watermark_lag_seconds{stream}          # now − watermark: the freshness SLO
analytics_query_cache_total{widget,result}
analytics_query_seconds{widget}
analytics_export_jobs_total{status}
```

**Alerts** (production; not wired locally): watermark lag > 5 min for server events; any `content_field` rejection (page the producing team); duplicate rate > 10% (a client retry storm); a stalled partition.

Logs are Pino JSON, with a chunk summary whenever duplicates, late or rejected events occur. Each service has `/health` and `/metrics`; the API also has `/ready`, which checks PostgreSQL, Valkey and ClickHouse.

## Failure Handling

| Failure | Effect | Handling |
|---------|--------|----------|
| ClickHouse down | Ingest stalls; Kafka buffers | Inserts retried with the same token; the watermark freezes and the label turns red; queries return errors per widget |
| Ingest instance dies | Its partitions stop reporting | Rebalance; the watermark holds at the last position until the new owner reports; redelivery handled by claims and tokens |
| Valkey loses dedup keys | Duplicates within 96 h could slip through | ReplacingMergeTree collapses raw duplicates; drill-down reconciliation exposes the mismatch; `rollups:rebuild` repairs sealed days |
| Producer sends content | Event rejected | `content_field` counter and alert; payload never stored |
| Device clock wrong | Future-dated events | Re-stamped to `received_time` |
| Slow query | One widget times out | `max_execution_time`, per-widget error with Retry; other widgets unaffected |
| User changes filters mid-query | Wasted warehouse work | Browser aborts; the API passes the abort to ClickHouse |
| Export worker dies | Job stuck in running | Lease expiry → reclaimed (3 attempts) |

## Scalability Considerations

- **Ingest** scales with partitions: one consumer per partition per instance. At 500K events/s, use 256 partitions with ~20 consumers.
- **Hot orgs.** Partitioning by `org_id` puts a giant org on one partition, and because the watermark is a minimum over all partitions, one lagging partition holds back freshness for every org. Key by `(org_id, hash(user_id) % N)` for the largest orgs. Per-org ordering isn't needed for correctness; only the watermark uses partition order, and it takes the minimum anyway.
- **Dedup state** at 230K events/s × 96 h is about 80B claims, too many for one Valkey. Production options:
  - shard the claims by event_id across a Valkey cluster;
  - shorten the window to the client retry horizon (minutes) and rely on ReplacingMergeTree plus nightly sealed-day rebuilds for the long tail;
  - dedup inside ClickHouse with a `Join`/`Set` engine keyed on event_id per day.

  This is what breaks first.
- **ClickHouse:** shard `events` by `cityHash64(org_id)` across nodes, two replicas each (ReplicatedMergeTree, which also makes insert dedup native). Rollups are tiny and can be replicated everywhere.
- **Queries:** the result cache absorbs repeated dashboards. Day-grain queries read hundreds of rows; the expensive path is the planner's raw edges, which are bounded to minutes.
- **Multi-region:** collectors per region, one Kafka per region mirrored to the analytics region. The watermark becomes the minimum across mirrors.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Dedup | Valkey claim per event_id + insert token | ReplacingMergeTree only | Rollups never see a duplicate; RMT stays as backstop |
| Bucketing | Event time + watermark | Processing time | Right numbers, honestly labelled as partial |
| Distinct users / percentiles | HLL and t-digest states | Stored counts / p95s | Merge across any buckets; ≈ about ±1% |
| Daily buckets | `local_date` at ingest | Group UTC hours at query time | Works for half-hour zones; tz change needs rebuild |
| Windows | Planner over day/hour/minute/raw | Fixed grains only | Exact "to-date" comparisons in any zone |
| Broker | Kafka | RabbitMQ | Replay, multiple consumers, per-partition order |
| Warehouse | ClickHouse MVs | Stream processor (Flink) + KV store | Fewer moving parts; MVs update on insert |
| Access | Server omits billing; scope in cache key | Hide columns in the UI | The browser is not a boundary |
| Small cohorts | Suppress < 5, pool only via merged distinct | Show everything | Prevents singling out individuals |
| Exports | Background job + lease + progress | Stream CSV from the API | Survives navigation; resumable; bounded load |
| Backfill | Rebuild sealed days from raw | Replay Kafka | Raw retention is 400 days vs Kafka's 7 |

## Implementation Notes

### Local architecture

| Process | Port | Entry point | Role |
|---------|------|-------------|------|
| API | 3000 | `backend/src/api/index.ts` | Query, meta, exports, auth |
| Ingest | 3101 (health) | `backend/src/ingest/index.ts` | Kafka consumer → ClickHouse |
| Exporter | 3102 (health) | `backend/src/exporter/index.ts` | Export jobs |
| Generator | - | `backend/src/generator/index.ts live` | Simulated chat traffic (plays the collector) |
| Frontend | 5173 | `frontend/src/main.tsx` | React dashboard |
| PostgreSQL 16, Valkey 7.2, ClickHouse 24.8, Kafka 3.8 (KRaft) | 5432, 6379, 8123, 9092 | `docker-compose.yml` | Infrastructure |

### Production-grade patterns actually implemented

- **Three-layer dedup** (`ingest/pipeline.ts`, `ingest/index.ts`): the Valkey claim with `SET NX GET`, the insert token, and the inserted-through offset. Unit-tested for duplicates in one batch, across batches, Kafka redelivery and already-inserted offsets. A live run re-sent 288 already-ingested events and the count didn't move.

  ```ts
  for (const { key, value } of items) pipeline.call('SET', key, value, 'EX', ttlSeconds, 'NX', 'GET')
  // null → claimed now; own partition:offset → redelivery, keep; anything else → duplicate
  ```

- **Watermarks** (`shared/watermark.ts`): per-partition positions, missing and stalled partitions, and per-stream allowances.
- **Mergeable rollups and the planner** (`db/clickhouse-init.sql`, `api/services/planner.ts`, `api/services/sql.ts`).
- **Role gating and a scope-aware cache key** (`api/services/query-service.ts`, `api/services/query-spec.ts`), with a test that an analyst never receives an admin's cached response.
- **Small-cohort suppression** with merged pooled counts (`breakdown`, `drilldown`).
- **Export jobs** with idempotency keys, `SKIP LOCKED` leases and fenced progress (`exporter/index.ts`).
- **Prometheus metrics, Pino logs, health checks** on every process.

### Simplified or substituted

- **The generator plays the collector.** It stamps `received_time` and writes to Kafka directly. There is no HTTP collector.
- **Single-node everything:** one Kafka broker (3 partitions), one non-replicated ClickHouse. Insert dedup uses `non_replicated_deduplication_window` instead of ReplicatedMergeTree's native block dedup.
- **Exports** write to a local directory instead of object storage with signed URLs.
- **Session auth** instead of SSO.

### Omitted

CDN, multi-region mirroring, a gateway rate limiter, a stream processor, differential-privacy noise for small cohorts, alert delivery, and Grafana dashboards.

### Verified locally

`backend`: 32 vitest tests (dedup, late data, time-zone bucketing including DST and UTC+5:30, the planner, watermarks, role gating, scope-aware caching, dimension applicability). `frontend`: 8 tests (range resolution, canonical keys matching the server, URL round-trip). Both `tsc` and `vite build` pass. Live Docker run (2026-11-02):

- 288 re-sent duplicates left the count unchanged.
- 200 late events moved yesterday from 288 to 488, with `lateEvents` 200 and a revision timestamp.
- Drill-down reconciled (488 = 488).
- Rapid chip toggles under a 1.5 s simulated warehouse delay aborted 12 superseded requests, and only the final filters painted.
- The rollup rebuild left counts and distinct users identical.
