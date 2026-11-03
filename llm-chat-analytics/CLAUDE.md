# LLM Chat Analytics - Development with Claude

## Project Context

ROADMAP entry 4. The reported interview prompt is a dashboard for an AI chat product. It is often asked in frontend rounds, and the known trap is an excellent chart architecture with no account of where consistent numbers come from. So the build spends real effort on the pipeline that makes the numbers trustworthy:
- written metric definitions
- event-time bucketing with a watermark
- dedup that survives crashes
- mergeable sketches
- org-local days

The frontend then shows that honesty: partial buckets, revision marks, coverage gaps, a drill-down that reconciles with its bar, and server-side role gating.

The design is in [architecture.md](./architecture.md). The rehearsal target is [system-design-answer-frontend.md](./system-design-answer-frontend.md). This file records how the project was built, what broke along the way, and what is still open. It is a practice reconstruction with fictitious orgs, models and data.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Query widgets, meta, freshness, pipeline, exports, auth; `dev:server1..3` for 3001-3003 |
| Ingest | 3101 | `backend/src/ingest/index.ts` | Kafka consumer group `ingest`; `dev:ingest2` runs a second instance (partitions rebalance) |
| Exporter | 3102 | `backend/src/exporter/index.ts` | Leased export jobs from PostgreSQL |
| Generator | - | `backend/src/generator/index.ts live` | Live traffic with 2% duplicates and 3% late client events; also `late`, `dupes`, `history` modes |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to `API_PORT` (default 3000) |
| PostgreSQL 16 · Valkey 7.2 · ClickHouse 24.8 · Kafka 3.8 KRaft | 5432 · 6379 · 8123 · 9092 | `docker-compose.yml` | Host ports overridable with `POSTGRES_PORT`, `REDIS_PORT`, `CLICKHOUSE_PORT`, `KAFKA_PORT` |

`npm run dev` in `backend/` starts API, ingest, exporter and the live generator with `concurrently -k`.

## Development Phases

1. **Definitions and contract first.** `shared/contract.ts` (strict zod schema, content-key rejection) and `api/services/catalog.ts` were written before any query, so every later piece had one definition to compute.
2. **Pipeline, verified with real Kafka and ClickHouse.** Schema and materialized views, deterministic traffic model, ingest with three-layer dedup and watermarks. The 280K-event seed drained in about 10 s. Rollups were checked by hand against raw counts.
3. **Query API.** Planner, series with aligned comparisons, breakdowns with suppression, drill-down, role gating, cache keyed by scope and per-day revisions. Exercised with curl as alice (admin), bob (analyst), carol (tiny org) and dana (support).
4. **Frontend, verified in a browser.** URL state, resolved keys, cross-filtering, SVG charts, drill-down, exports. Several defects below were only visible there.
5. **Live checks, screenshots, smoke tests, docs.**

## Key Implementation Decisions (and why)

Build-time choices not obvious from architecture.md. These include deviations from the repository's default stack.

- **Kafka (KRaft, `apache/kafka:3.8.1`) instead of RabbitMQ.** The watermark relies on per-partition arrival order, rebuild stories rely on replay, and analytics streams typically have several consumers. A single KRaft broker has no ZooKeeper and starts in seconds. Client: `kafkajs`, which needs no native build.
- **ClickHouse 24.8 (LTS)**, raw table plus three `AggregatingMergeTree` rollups fed by materialized views. The repo's ad-click-aggregator stores `uniqExact` results in a `SummingMergeTree`, which sums distinct users across rows. This project stores `uniqCombined64` and `quantilesTDigest` *states* instead, so distinct users and percentiles merge correctly.
- **The ingest dedup uses `SET key value NX GET EX ttl`** (Redis/Valkey 7+): one pipelined round trip per chunk returns either nil (claimed) or the existing claim. The claim's value is the Kafka `partition:offset`, which is what tells a redelivery apart from a duplicate.
- **TanStack Query added to the frontend stack.** The repo default is Zustand only, and prompt-playground deliberately avoided a query cache. Here the core requirement is keyed server state with cancellation and keep-previous-data. That is exactly what a keyed query cache does, and the keyed cache is what makes stale paints impossible by construction. Zustand still holds session and watched exports.
- **Hand-rolled SVG charts** instead of a chart library. Partial hatching, the watermark line, coverage gaps, revision marks and clipped buckets are custom marks anyway. The bucket count is bounded at 1,500 by the API. Colors and mark specs follow the repo's data-viz palette, with separate dark-mode steps.
- **luxon on both sides** for zone arithmetic: local midnights, wall-clock week shifts and month clamping. The ingest hot path uses a cached `Intl.DateTimeFormat` for `local_date` instead.
- **The generator plays the collector**: it stamps `received_time` and produces to Kafka. History is produced in `received_time` order, and the live mode resumes from a cursor in Valkey, so a restart leaves no hole in the charts.
- **Deterministic traffic** (seeded PRNG per org-minute, event IDs derived from names). Re-running the generator for the same minutes produces the same event IDs, which dedup catches.
- **A query-delay knob** (`QUERY_DELAY_MS`) makes the abort and stale-response handling observable locally.

## Iteration & Repair Log

Defects found by running the stack, in order:

1. **Seed history arrived out of order.** History was produced hour by hour, but a conversation starting at 00:59 has replies at 01:20 that were produced in the 00:00 batch. Partition positions jumped ahead and 3 seeded events were classified late. Fix: each hour's batch is sorted by `received_time`, and events received after the hour carry over (`generator/produce.ts`).
2. **The freshness endpoint returned 500.** `SELECT toString(local_date) AS local_date … WHERE local_date >= …` made the WHERE clause compare the String alias with a Date. ClickHouse resolves aliases before columns. Fix: alias renamed to `day`.
3. **The "other" row in breakdowns summed distinct users.** Tiny Atelier's three model groups (4 people) pooled to "10 users" and passed the 5-user threshold. This is exactly the "metrics that don't add up" bug the project exists to avoid. Fix: the pooled row's users are computed by a second query that merges sketches over the small groups, and a single small group is never pooled (`breakdown`, `pooledRow`).
4. **Retried inserts double-counted rollups.** Inserting the same block twice with one `insert_deduplication_token` left one row in `events` but 2 in every rollup: the materialized views still fired. The rollup tables need their own `non_replicated_deduplication_window`. Fix: the setting is on every rollup table, plus `ALTER … MODIFY SETTING` for existing volumes. Verified: 1/1/1 after the retry, and a distinct token still inserts.
5. **Conversations filtered by feature read 0.** Conversations are counted at start, before any feature is used, so a feature filter silently produced a confident zero in the tile, the chart and the By-model breakdown. Fix: catalog metrics declare their dimensions. The API answers `422 DIMENSION_NOT_APPLICABLE` with the reason, and tiles show "n/a with a feature filter".
6. **Kolkata "Today, by hour" failed in every widget.** The range starts at 18:30 UTC, and the API required UTC-hour alignment. Fix: hour and minute ranges may start on any minute. Hour buckets stay UTC-aligned (that is how they are rolled up) and the edge buckets are clipped and computed by the planner from minute rollups or raw events.
7. **Drill-down rows showed "0 tokens, $0.000".** Rows aggregated only the matched events (`conversation_started` has no tokens). Fix: the page of conversations comes from the matched events, and each row's totals come from all of that conversation's events.
8. **The comparison line leaked small cohorts.** Suppression hid current-period buckets under 5 users, but the previous-week line still drew their exact values, and KPI tiles for a narrowed cohort weren't suppressed at all. Fix: the same rule applies to previous values, to-date comparisons and the whole overview (`isSmallCohort`). The latency card had also said "Nothing matches" when its buckets were hidden rather than empty; it now says how many are hidden.
9. **The insert token assumed identical chunks.** Raised while writing the backend interview answer: after a crash, Kafka can redeliver a batch with more messages than before, so the chunk could be cut at different offsets, giving a different token, and the window between insert and inserted-through would double-count. Fix: the chunk's offset range is recorded in `ingest:inflight` before the insert and cleared with inserted-through. The first chunk after a restart is cut at exactly that range.
10. **Tailwind opacity modifiers on CSS-variable colors** (`ring-series-1/30`) failed the build. Fix: dropped the modifiers. The tokens are plain `var()` colors so dark mode can redefine them.

## Verification Environment Notes

- Other sessions held the default ports, so this run used PostgreSQL 5452, Valkey 6399, API 3020 and Vite 5197 (`POSTGRES_PORT=5452 REDIS_PORT=6399 docker-compose up -d`, with `DATABASE_URL`/`REDIS_URL`/`PORT`/`API_PORT` set to match). ClickHouse 8123 and Kafka 9092 were free.
- Screenshots were taken with `SCREENSHOT_FRONTEND_PORT=5197 node scripts/screenshots.mjs llm-chat-analytics` against the running stack, without `--start`, which would stop containers and kill whatever holds the ports.
- Live checks (2026-11-02):
  - Duplicates: `generate:dupes` re-sent 288 already-ingested events and yesterday stayed at 288 (duplicates counter +288).
  - Late events: `generate:late` added 200 late conversations, and yesterday went 288 → 488 with `lateEvents` 200, `revisedAt` set and the watermark shown.
  - The drill-down reconciled at 488 = 488.
  - Rapid filter changes: under `QUERY_DELAY_MS=1500`, four chip clicks gave 16 requests, 12 of them aborted, and only the final filters painted.
  - `rollups:rebuild` refused unsealed days, and on sealed days left counts and distinct users identical (t-digest percentiles shifted slightly, as expected for an approximate structure).

## Open Questions / Next Steps

- **The dedup set is the first scaling limit.** At production rates a 96-hour window is ~80B claims. Options: a shorter window matched to client retry behavior, plus ReplacingMergeTree and nightly sealed-day rebuilds for the tail.
- **A push channel for freshness and revisions** (SSE per org), so widgets refetch only when their window changes.
- **Keyset pagination and virtualization** in the drill-down table.
- **An org time-zone change flow:** banner plus `rollups:rebuild --relocalize`. The flag exists; there is no UI.
- **Saved views and incident annotations** on the time axis.
- **Differential-privacy noise** instead of hard suppression, for tiny orgs that want some detail.
