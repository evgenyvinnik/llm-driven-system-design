# Dashboarding System — Development with Claude

## Project Context

A metrics monitoring and visualization system in the Datadog/Grafana mold: ingest time-series points, store them efficiently, query them by arbitrary time range with server-side aggregation, render them in configurable dashboard panels, and evaluate alert rules on a schedule. The core hard problem is the **write-heavy ingestion path** (many points/second) coexisting with **read queries over huge time ranges** — the two want opposite storage optimizations, which is exactly what a time-series database with hypertables is built to reconcile.

**Learning goals:** time-series storage with TimescaleDB hypertables + retention, multi-tier caching of metric identity on the hot ingest path, time-range-aware query routing, cache-aside for dashboard reads, and periodic alert evaluation with fire/resolve state.

## Architecture at a Glance (what actually runs)

Two backing services run by default; a third is defined but gated off. This matches `docker-compose.yml` and `backend/package.json`:

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **TimescaleDB** (Postgres 16 + timescaledb) | `pg` | Everything: `metrics` hypertable (1-day chunks, 7-day retention), plus metric definitions, dashboards, panels, alert rules/instances, users | One SQL database for time-series *and* metadata — dashboards can join against alert rules with no cross-store coordination; `time_bucket()` does aggregation in the DB |
| **Valkey (Redis)** | `ioredis` + `connect-redis` | Session store, query-result cache-aside (TTL by range), and the shared tier of the metric-ID cache | Sub-ms lookups; shared across API instances so the metric-ID cache and sessions survive horizontal scaling |
| **Kafka + Zookeeper** | `kafkajs` (dependency present) | **Not wired in.** Defined in docker-compose behind a `kafka` compose profile; no `backend/src` file imports kafkajs | Kept as the documented production ingestion-queue path; local ingestion writes directly to the DB |

The backend is a **single Express app** (default port **3000**; `dev:server1/2/3` on 3001–3003), routes: `auth`, `metrics`, `dashboards`, `alerts`. A background alert evaluator loop runs in-process every 30s (`startAlertEvaluator(30)` in `index.ts`). Frontend: React 19 + TanStack Router + Zustand + **Recharts** (line/area/bar + gauge + stat panels) + date-fns; dashboards poll (panels 10s, alerts 30s) rather than using WebSockets.

## Key Design Decisions

### 1. TimescaleDB (single DB) over InfluxDB or a Postgres+separate-TSDB split
Metrics live in a hypertable; dashboards/alerts/users are plain relational tables in the same instance. The payoff is no cross-database coordination — an alert rule references a `metric_name` and the evaluator joins it to metric data in one query. Trade-off given up: a purpose-built TSDB (InfluxDB) or columnar store would push higher ingestion ceilings, but at the cost of a second datastore to operate and a second query language. For this scale, SQL + hypertables wins on simplicity.

### 2. Direct-write ingestion, not a Kafka queue (locally)
`POST /metrics/ingest` resolves each point's `metric_id`, then batch-inserts all points in a single `unnest(...)` statement wrapped in a circuit breaker. The production-ideal design puts Kafka between the API and the DB for buffering and partitioned consumers — that's why kafkajs and a `kafka` compose profile exist — but it is deliberately not wired in. Trade-off: a burst that outpaces the DB has no queue to absorb it; acceptable at local volume, and the direct path removes an entire moving part.

### 3. Three-tier metric-ID cache on the ingest hot path
Every point carries a `(name, tags)` identity that must map to an integer `metric_id`. Resolving that against the DB per point would dominate ingest cost, so `getOrCreateMetricId` checks an in-process `Map`, then Redis (1h TTL), then upserts into `metric_definitions` with `ON CONFLICT`. Trade-off: the in-process Map can go stale if definitions are mutated out-of-band (there's a `clearMetricIdCache()` for that), and it duplicates state across instances — but metric identity is effectively immutable, so staleness is a non-issue in practice.

### 4. Time-range-aware query routing + range-tuned cache TTL
`queryService.selectTable()` picks the data source by requested span, and cached query results get a short TTL for recent windows (near-real-time) and a long TTL for historical windows (immutable past). Reasoning: a 7-day dashboard should never scan raw per-second rows, and historical results never change so they can cache for minutes. **Caveat (see Iteration log):** the rollup tables the router selects for long ranges are not actually created locally.

### 5. Session auth, admin-gated user creation
Sessions in Redis (bcrypt, connect-redis, `DISABLE_REDIS=true` falls back to an in-memory store for Redis-less dev). `POST /auth/register` is guarded by `requireRole('admin')`. Trade-off: this is the right production posture (only admins provision accounts) but creates a first-user bootstrap gap locally — see Open Questions.

## Current State

Implemented and working: metric ingestion with three-tier ID caching and batch `unnest` insert; time-bucketed query API with Redis cache-aside and circuit-breaker protection; latest-value and min/max/avg/count stat queries; metric/tag discovery endpoints (names, tag keys, tag values via JSONB); dashboard + panel CRUD with JSONB layout/position; alert rule CRUD and an in-process evaluator (every 30s) that fires and resolves `alert_instances`; Recharts-based panels (line, area, bar, gauge, stat) with a time-range selector; polling-based refresh. Production hardening present: helmet, response compression, Opossum circuit breakers (ingest + query), prom-client metrics (incl. live DB-pool gauges), Pino structured logging, health/liveness endpoints, graceful shutdown, and Zod request validation.

Intentionally not built (documented as production extensions): Kafka-buffered ingestion with worker cluster, TimescaleDB continuous-aggregate rollups, WebSocket sub-second updates, multi-node/sharded storage, OAuth/OIDC, anomaly-detection alerting, and drag-and-drop panel layout editing.

## Iteration & Repair Log

- **Doc drift corrected (2026-07):** the previous CLAUDE.md was a generic "Phase 3/4 Not started" checklist that contradicted the code — it listed "Add user authentication" and "Implement retention policies" as *to-do* when both are implemented (session auth in `routes/auth.ts`; `add_retention_policy('metrics', INTERVAL '7 days')` in `init.sql`). Replaced with real decision/state history.
- **README migration step was broken (fixed in README):** the README told users to run `npm run db:migrate`, but no such script exists — the schema is applied by TimescaleDB's `docker-entrypoint-initdb.d` mount of `init.sql` on first boot. The step also claimed it creates "hourly and daily rollup tables," which it does not. Corrected to describe the initdb mount and the missing rollups.
- **Rollup tables referenced but never created (documented, code left as-is):** `queryService.selectTable()` routes ranges > 6h to `metrics_hourly` / `metrics_daily`, but no continuous aggregates create those tables. The query's circuit breaker catches the "relation does not exist" error and returns an empty result rather than crashing, so long-range panels render empty. Seed data spans one hour, so the raw-table path is what actually exercises. Flagged in `architecture.md` (Query Routing Logic) and README; materializing the aggregates is the first hardening step.

## Open Questions

1. **First-user bootstrap:** `register` requires an existing admin and the seed script creates no users. What's the intended path — a seeded admin, an env-driven bootstrap account, or a one-time open-registration flag?
2. **Rollups:** should the two continuous aggregates be added to `init.sql` (making `selectTable` correct), or should `selectTable` collapse to always-raw until they exist? The current state silently returns empty for long ranges.
3. **Cardinality:** `metric_definitions` is `UNIQUE(name, tags)`; a high-cardinality tag (e.g., request ID) would explode the definition table and the metric-ID caches. Where should cardinality limits be enforced — ingest validation or a definition-count guard?
4. **Ingestion backpressure:** with direct DB writes, what's the trigger to actually turn on the Kafka path — sustained ingest latency, or DB-pool saturation on the circuit breaker?

## Resources

- [TimescaleDB hypertables & continuous aggregates](https://docs.timescale.com/) — the rollup path this project stubs out
- [Grafana time-series data model](https://grafana.com/docs/grafana/latest/fundamentals/timeseries/)
- [Prometheus data model](https://prometheus.io/docs/concepts/data_model/) — the name+tags identity model mirrored here
