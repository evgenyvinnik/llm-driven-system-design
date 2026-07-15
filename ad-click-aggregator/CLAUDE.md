# Ad Click Aggregator — Development with Claude

## Project Context

A real-time analytics pipeline that ingests ad-click events, deduplicates them, runs rule-based fraud detection, and serves aggregated metrics (by minute / hour / day, sliceable by campaign, ad, country, device). The interesting tension is a **1000:1 write-to-read ratio** against a **hard exactly-once-ish requirement**: clicks drive billing, so a double-counted or lost click is money.

**Learning goals:** high-volume write ingestion, real-time aggregation without a heavyweight stream processor, approximate vs exact counting trade-offs, and columnar OLAP for time-series.

## Architecture at a Glance (what actually runs)

Three datastores, each chosen for a specific access pattern — this is a *hybrid* design, not a single-DB one:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Raw click audit trail + metadata (campaigns, ads) | ACID durability for billing disputes — the provable record of every click |
| **ClickHouse** (`@clickhouse/client`) | Analytics: raw events + minute/hour/day rollups via materialized views | Columnar storage + MV auto-aggregation; 10–100× faster than PG for the dashboard's group-by queries |
| **Redis/Valkey** (`ioredis`) | Click-ID dedup (5-min TTL) + real-time counters | Sub-ms lookups on the ingestion hot path; HyperLogLog for unique-user counts |

Every ingested click is written to **both** PostgreSQL (audit) and ClickHouse (analytics) — the aggregation is done by ClickHouse materialized views, not application code.

Backend services: `click-ingestion`, `aggregation`, `fraud-detection`, `clickhouse`, `database`, `redis`. Routes: `clicks` (ingest), `analytics` (query), `admin` (stats). Frontend: React + TanStack Router + Zustand + Recharts.

## Key Design Decisions

### 1. Hybrid PostgreSQL + ClickHouse (not one or the other)
Raw clicks go to PostgreSQL for a transactionally-consistent audit trail (billing disputes need provable records that survive a ClickHouse merge/compaction), and to ClickHouse for analytics. Aggregations live only in ClickHouse, computed by materialized views on write. Trade-off: every click is a dual write, and the two stores can briefly diverge — acceptable because PG is the source of truth for billing and CH is the source of truth for dashboards, and they answer different questions.

### 2. Materialized-view aggregation over a stream processor
Minute/hour/day rollups are ClickHouse MVs (`click_aggregates_minute_mv` → `click_aggregates_minute`, etc.), not a Kafka/Flink job. For this scale it removes an entire moving part: aggregation happens synchronously as a side effect of the insert, with columnar storage doing the heavy lifting. The production doc notes where Kafka + Flink would take over at 10K+ clicks/sec.

### 3. Redis for dedup, not a DB uniqueness constraint
Deduplication uses a Redis key per click-ID with a 5-minute TTL. A unique constraint in PG would serialize the write path and grow unbounded; Redis gives an O(1) check that auto-expires. Trade-off: dedup is best-effort within the TTL window — a duplicate arriving after 5 minutes is not caught, which is the right window for retry storms but not for long-delayed replays.

### 4. Rule-based fraud detection
Velocity thresholds (100 clicks/min per IP, 50/min per user) plus pattern heuristics (missing device info, suspiciously regular timing). Fraudulent clicks are **flagged, not dropped** — stored for analysis so the rules can be tuned. ML-based detection is deliberately out of scope.

## Current State

All core paths are implemented and run end to end: click ingestion with Zod validation + Redis dedup, dual-write to PG/ClickHouse, MV-based rollups at three granularities, rule-based fraud flagging, the analytics query API, an admin/stats API, and a Recharts dashboard with a test-click generator.

Not built (intentionally, noted as production extensions): Kafka event streaming, watermarking for late-arriving clicks, geo-velocity ("impossible travel") fraud, ML fraud models, and raw-data archival/tiering.

## Iteration & Repair Log

- **2026-07 (schema self-heal):** `initClickHouse()` only *pinged* ClickHouse and relied entirely on the `docker-entrypoint-initdb.d` mount to create the schema. That mount runs only on a fresh volume, so a persisted or partially-initialized volume left the `click_aggregates_minute` table missing and analytics queries threw `Table adclick.click_aggregates_minute does not exist`. Fixed by applying the (idempotent, `CREATE ... IF NOT EXISTS`) schema on every boot from `initClickHouse()` — self-healing regardless of volume state.
- **2026-07 (doc drift):** this file previously claimed "PostgreSQL instead of ClickHouse for simplicity in local development." That was stale from an earlier PG-only prototype; the project uses ClickHouse (and Redis) alongside PostgreSQL. Corrected here to match `docker-compose.yml`, `backend/src/services/clickhouse.ts`, and `architecture.md`.

## Open Questions

1. Late-arriving clicks currently update aggregates immediately with no watermark — at what event-time skew does this need windowing?
2. When does exact ClickHouse counting need to give way to approximate sketches (Count-Min / HyperLogLog) on the query side, not just for unique-user counts?
3. Best archival strategy for raw PG click rows once they age past the billing-dispute window?

## Resources

- [ClickHouse Materialized Views](https://clickhouse.com/docs/en/materialized-view)
- [Redis HyperLogLog](https://redis.io/docs/data-types/hyperloglog/)
- [Apache Flink](https://flink.apache.org/) — the production streaming path this project deliberately avoids
