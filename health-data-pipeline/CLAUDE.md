# Health Data Pipeline — Development with Claude

## Project Context

The defining problem of a health platform isn't ingest volume — it's that **the same real-world event arrives multiple times from devices that disagree**. A user wearing an Apple Watch while carrying an iPhone walks 1,000 steps; both devices report it. Naively summing gives 2,000 steps, which is not a rounding error but a wrong answer to the only question the user cares about. And it can't be fixed by deduplicating on a key, because the two records aren't identical: they cover overlapping-but-not-equal time ranges, with different values, from sources of different trustworthiness.

So the core of this system is a **priority-ranked, time-range-aware deduplication pass**: sources are ranked (Apple Watch 100 > iPhone 80 > iPad 70 > third-party wearable 50 > scale 40 > manual entry 10), samples are walked highest-priority-first, and each sample is either accepted whole, *clipped* to the portion of its time range not already covered by a better source, or dropped entirely. A partially-overlapping sample has its value scaled proportionally to the surviving duration. That's `deduplicateSamples` / `adjustForOverlap` in `backend/src/services/aggregationService.ts`, and it's the piece worth understanding before anything else here.

The second theme is that health data is time-series data with a brutal read/write asymmetry: it's written continuously in small batches by devices and read in aggregate windows ("my daily steps for the past year"). Answering that from raw samples means scanning millions of rows per chart, so aggregates are precomputed at hourly and daily grain, and the raw table lives in a TimescaleDB hypertable so time-ranged scans touch only the relevant chunks.

**Learning goals:** multi-source deduplication with conflict rules that produce a defensible single truth, time-series storage and precomputed rollups, idempotent batch ingestion from unreliable clients, and deriving actionable insight from noisy longitudinal data.

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API server** (`backend/src/index.ts`, port **3000**) | `npm run dev` (`tsx watch`) | Single Express process; `dev:server1/2/3` pin 3001–3003 for multi-instance testing |
| **TimescaleDB** (`timescale/timescaledb:latest-pg16`, 5432) | `docker-compose.yml` | Not plain Postgres: `health_samples` and `health_aggregates` are **hypertables** partitioned on time, with compression policies after 90 days. Everything else (`users`, `user_devices`, `health_insights`, `share_tokens`, `sessions`) is ordinary relational |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Session store and the query cache (`cache.set` defaults to a 300s TTL); invalidated wholesale per user on any sync |

The pipeline is four services under `backend/src/services/`: `deviceSyncService.ts` (validate → batch insert → trigger aggregation), `aggregationService.ts` (dedup + hourly/daily rollups), `healthQueryService.ts` (reads), and `insightsService.ts` (trend detection). Domain rules live in `backend/src/models/healthTypes.ts` — the `DevicePriority` table, per-metric aggregation strategy (`sum` for steps, `average` for heart rate, `latest` for weight), and unit conversions — and `models/healthSample.ts` owns validation. Ingest is idempotent via `shared/idempotency.ts` backed by the `idempotency_keys` table.

Frontend is React 19 + TanStack Router + Zustand + **Recharts**, with `routes/Dashboard.tsx`, `Metrics.tsx`, `Devices.tsx`, and `Admin.tsx`, plus `HealthChart`, `MetricCard`, and `InsightCard` components. Vite proxies `/api` → `localhost:3000`.

## Key Design Decisions

### 1. Deduplication by device priority with time-range clipping, not by dropping duplicates
Samples are sorted by device priority descending, then each is compared against the set of already-covered time ranges. Full overlap → discard. No overlap → accept whole. Partial overlap → clip to the uncovered portion and scale the value by the surviving fraction of the duration.

The obvious alternative — dedupe on `(user, type, timestamp)` — fails because devices don't sample on the same boundaries. The Watch reports a 10-minute activity block; the phone reports three overlapping 4-minute blocks. No key matches, so every record survives and the day's total is inflated by 60–100%. The other obvious alternative — pick one device per metric per day — throws away real data: if the Watch was on the charger from 2pm to 4pm, the phone's steps for that window are the *only* record of them, and a "trust one source" rule reports a two-hour hole as zero activity.

What clipping gives up is **value fidelity on the clipped portion**. Scaling a 4-minute, 400-step sample down to the 90 seconds not already covered assumes the steps were evenly distributed across those 4 minutes. They weren't. This is a defensible approximation for cumulative metrics like steps and distance, and it is *wrong* for instantaneous ones — which is why `getAggregationType` routes heart rate to `average` and weight to `latest`, where clipping doesn't apply the same way. The deeper cost is that the whole scheme is only as good as the priority table, which is a static, hardcoded ranking rather than anything learned from observed accuracy.

### 2. Aggregates are precomputed on write, not computed on read
Every sync calls `queueAggregation`, which recomputes hourly and daily rollups for the affected types and date range and upserts them into `health_aggregates` (unique on `user_id, type, period, period_start`).

Computing on read is tempting because it's always correct and needs no invalidation. It collapses under the actual access pattern: a year-long steps chart over raw samples means scanning roughly 100K+ rows *and* running the full deduplication pass over all of them before a single point can be plotted — dedup is O(n log n) with an overlap scan per sample, so it's not something you want between a user and a chart render. Precomputing moves that cost to write time, where it's bounded by the size of one sync batch, and turns the read into an indexed range scan on `(user_id, type, period, period_start DESC)`.

The costs are twofold and real. First, the aggregation runs **synchronously inside the sync request** — `queueAggregation` is named for an intent that isn't implemented; it calls `processAggregation` directly with a comment admitting a job queue is what this wants. A device uploading a month of backfilled data blocks its own HTTP request through the entire rollup. Second, a change to the dedup rules or the priority table invalidates every stored aggregate, which is why `POST /api/v1/admin/users/:userId/reaggregate` exists as an escape hatch.

### 3. TimescaleDB rather than plain PostgreSQL
`health_samples` and `health_aggregates` are converted with `create_hypertable(...)` on their time columns, with `add_compression_policy(..., INTERVAL '90 days')`.

This is a documented deviation from the repo's PostgreSQL default, and it earns its place on one property: automatic time-based chunking means a query for last week's samples touches one or two chunks instead of planning against a single ever-growing table. On plain Postgres the equivalent is hand-rolled declarative partitioning with a cron job creating next month's partition — which works, but is exactly the kind of operational chore that gets forgotten until inserts start failing because no partition exists for today's date. Compression is the other half: health samples are highly repetitive columnar data (same user, same type, monotonic timestamps), so old chunks compress dramatically, and a personal health archive is data you keep for years but read rarely.

What we give up: a non-standard extension in the dependency chain, and hypertables come with constraints — most notably that unique constraints must include the partitioning column. The schema hedges against the extension being absent, wrapping the compression policies in a `DO $$ ... EXCEPTION WHEN OTHERS` block that degrades to a `RAISE NOTICE` so the schema still loads on stock Postgres, just without compression.

### 4. Ingest is idempotent, because device sync retries are guaranteed
Sync requests carry an idempotency key checked against the `idempotency_keys` table before any insert, and `batchInsert` additionally uses client-supplied UUIDs with `ON CONFLICT (id) DO NOTHING`.

This is not defensive over-engineering — it's the defining constraint of the client. A phone syncing over cellular loses the connection mid-upload constantly, and it cannot know whether the server committed the batch, so it must retry. Without idempotency, a retried batch of 500 samples inserts 500 duplicates, and those duplicates go straight into the deduplication pass, where they *look like a second legitimate source* covering the identical range from the same device. The user's step count silently doubles for that window. Two independent layers guard it: the key stops the whole batch, the row UUIDs stop individual samples.

The trade-off is that correctness now depends on the client generating stable UUIDs across retries. A client that regenerates IDs on each attempt defeats the second layer entirely, leaving only the request-level key — which is why the response is cached and replayed rather than the request merely being rejected.

### 5. Insights are simple linear regression, deliberately
`insightsService.ts` fits a least-squares line over 30 days of resting heart rate, 14 days of sleep, 4 weeks of activity, and 30 days of weight, and fires an insight when the slope exceeds a fixed threshold (`|slope| > 0.5` for heart rate, escalating to `high` above 1.0).

A model would be better at detection and much worse at everything else that matters here. The output of this system is a sentence shown to a person about their body — "your resting heart rate has been trending up over the past month" is a claim that must be explainable, reproducible, and defensible. A slope over a named window is all three; an anomaly score from a model is none of them, and a false positive isn't a bad recommendation, it's a person worrying about their heart. Linear regression also degrades honestly: with fewer than two points it returns a zero slope rather than a confident guess.

What it can't do is obvious — no seasonality, no correlation between metrics, no distinction between a genuine trend and a step change from switching devices mid-window (a new tracker with a different resting-HR calibration reads as a trend).

## Current State

Runs end to end. `docker-compose up -d` starts TimescaleDB (schema auto-loaded from `backend/src/db/init.sql`) and Valkey; `npm run dev` starts the API on 3000. Working: registration/login with bcrypt and Redis-backed sessions, device registration with automatic priority assignment by device type, idempotent batch sync (`POST /api/v1/devices/:deviceId/sync`) with per-sample validation and per-sample error reporting, priority-based deduplication with overlap clipping, hourly and daily aggregation, query endpoints for samples/aggregates/daily and weekly summaries/latest values/per-type history, insight generation and acknowledgement, an admin surface (system stats, user list, per-user detail, forced reaggregation, data-type config), Prometheus metrics including samples-ingested and sync-duration, Pino structured logging, health checks, and retention utilities in `shared/retention.ts` backed by the `retention_jobs` audit table. The frontend renders real Recharts time-series over the seeded data.

Seeded logins, all with password `password123`: `alice@example.com`, `bob@example.com`, `carol@example.com`, and `admin@health.local` (admin). The seed is built to exercise the dedup path specifically — Alice has an Apple Watch (priority 100), an iPhone (80), and a smart scale (40), so her step data has genuinely overlapping sources rather than one clean feed. `backend/scripts/generate-sample-data.ts` produces additional synthetic history.

Simplified or omitted: **sharing is schema-only** — `share_tokens` exists with recipient, data-type scoping, expiry, and revocation columns, but no routes create or redeem tokens. Aggregation runs inline in the request rather than through a job queue. There is no real HealthKit or Google Fit integration; devices are registered records and samples arrive over the REST sync endpoint. No export (CSV/JSON), no consent management, no encryption at rest beyond what the database provides.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old checklist marked **"Phase 3: Aggregation — COMPLETED"** and **"Phase 4: Access — COMPLETED"** while, inside that same "completed" Phase 4, sharing was an unchecked box annotated "(share tokens implemented in schema)" — which is the actual truth for sharing, but sat under a COMPLETED heading. The checklist also gave no hint that the priority-clipping dedup algorithm is the entire point of the project.
- **Idempotency added to sync (`shared/idempotency.ts` + `idempotency_keys` table):** retried device batches previously inserted duplicate samples that the dedup pass then treated as a legitimate second source, doubling totals. Now guarded at both the batch level (idempotency key) and the row level (client UUID + `ON CONFLICT DO NOTHING`).
- **Compression policies made non-fatal:** `add_compression_policy` calls are wrapped in a `DO $$ ... EXCEPTION WHEN OTHERS THEN RAISE NOTICE` block, so the schema loads against stock PostgreSQL instead of aborting when the TimescaleDB extension is absent — which previously left the database with zero tables and made seeding fail silently.
- **Partial index on unread insights:** `idx_insights_unread ON health_insights(user_id, acknowledged) WHERE acknowledged = false` — the predicate is a constant comparison and therefore immutable, which is what index predicates require. (The sibling `imessage` project hit the failure mode this avoids: a predicate calling `NOW()` is not immutable and aborts schema load.)
- **Metric aggregation strategy moved into `healthTypes.ts`:** summing heart rate is meaningless and averaging steps is wrong, so strategy is a property of the metric type (`getAggregationType`) rather than a branch inside the aggregation loop.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the TimescaleDB/Redis services these tests need). Verification is local: `npm run type-check`, then `npm run triage health-data-pipeline`.

## Open Questions

1. `queueAggregation` doesn't queue — it processes inline, so a device backfilling a month of history blocks its own request through the full rollup. Is the fix a real job queue (correct, but the user's dashboard then shows stale aggregates for an unbounded window after sync), or a bounded synchronous path that only recomputes the current day and defers older ranges?
2. The priority table is static and hardcoded. Should priority be per-metric rather than per-device — a chest strap beats a watch for heart rate but is useless for steps — and if so, how does a user express that without a settings screen nobody will use?
3. Clipping scales a partially-overlapping sample's value linearly with duration, assuming uniform distribution within the sample. For steps over a 4-minute window that's roughly fine; for an interval workout it isn't. Is there a cheap correction, or is the honest answer to mark clipped aggregates as estimates in the UI?
4. `share_tokens` models scoped, expiring, revocable access but nothing implements it. Redemption is the hard half: does a recipient see a live view (needs ongoing authorization checks on every read) or a frozen snapshot taken at share time (simpler, but immediately stale and duplicative of storage)?

## Resources

- [TimescaleDB hypertables](https://docs.timescale.com/use-timescale/latest/hypertables/) — the partitioning model behind `create_hypertable`
- [TimescaleDB compression](https://docs.timescale.com/use-timescale/latest/compression/) — the 90-day policy in `init.sql`
- [Apple HealthKit](https://developer.apple.com/documentation/healthkit) — where the multi-source priority problem and its vocabulary come from
- [HealthKit: sample types and units](https://developer.apple.com/documentation/healthkit/hkquantitytype) — the model `healthTypes.ts` mirrors
- [Recharts](https://recharts.org/) — the charting library in `HealthChart.tsx`
