# Design LLM Chat Analytics

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 9,705 |
| Source Files | 109 |
| .ts | 5,432 |
| .tsx | 2,004 |
| .md | 1,494 |
| .sql | 284 |
| .json | 188 |

## Overview

Near-real-time dashboards for a fictitious AI chat product: active users, conversations, time to first token and total response time, error and abandoned-generation rates, token usage and cost, and feature adoption. Every metric can be broken down by organization, model and feature. A traffic generator streams chat events (with duplicates and late arrivals) through Kafka into ClickHouse, and a React dashboard reads them through a query API.

What makes the numbers trustworthy:

- **Written definitions.** Conversation, active user, successful response and abandoned generation are defined once, in a catalog that the charts, drill-downs, exports and the Definitions page all read.
- **Duplicates never double-count.** Ingest claims each `event_id` in Valkey (keyed to the Kafka offset that carried it), inserts with a dedup token, and records how far each partition has been written.
- **Late events land where they happened.** Buckets are by event time. A per-stream "complete through" watermark says how far the data is verified, buckets after it are drawn as partial, and late arrivals that revise an earlier day are marked ↻.
- **Metrics that don't add up are stored as sketches.** Distinct users are HyperLogLog states and percentiles are t-digest states, so a week is a merge, never a sum of days.
- **Days are the org's days.** Daily rollups are keyed by the org-local date, including half-hour zones such as Asia/Kolkata.
- **Access and privacy are enforced by the API.** Cost is omitted from responses for roles without billing access. Breakdowns and drill-downs under 5 users are hidden. Events never carry message content.

See [architecture.md](./architecture.md) for the design and [CLAUDE.md](./CLAUDE.md) for how it was built. Interview answers: [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), [full-stack](./system-design-answer-fullstack.md).

## Screenshots

| | |
|---|---|
| ![Dashboard](./screenshots/02-dashboard.png) | ![Drill-down](./screenshots/03-drilldown.png) |
| Last 7 days vs previous week; today is partial and compared to the same time last week | Drill-down into one bar: the raw-event count reconciles with the bar |
| ![Cross-filter](./screenshots/04-cross-filter.png) | ![Not collected](./screenshots/05-not-collected.png) |
| Model and feature filters; conversations can't be split by feature, so the tile says n/a | Abandoned generations before tracking began: a labelled gap, not zeros |
| ![Backfill pending](./screenshots/06-backfill-pending.png) | ![Kolkata](./screenshots/08-kestrel-analyst-today.png) |
| A newer metric whose old rollups are not yet backfilled | UTC+5:30 org, analyst role: hours clipped at local midnight, no cost tiles |
| ![Definitions](./screenshots/09-definitions.png) | ![Pipeline](./screenshots/10-pipeline.png) |
| Metric definitions and the event contract | Partition positions, watermarks, duplicates, late and rejected events |

## Architecture

```
generator (plays the collector) ──▶ Kafka chat-events (3 partitions, key = org_id)
                                          │
                                          ▼
                     ingest: validate · dedup claim (Valkey) · late check · local date · cost
                                          │ insert with dedup token
                                          ▼
              ClickHouse events ──MV──▶ rollup_minute · rollup_hour · rollup_day_local
                                          │
Browser (React, :5173) ──REST──▶ API (:3000): catalog · planner · access · cache ──▶ PostgreSQL
        ▲                                                                            (orgs, roles,
        └──── export progress ◀── exporter (:3102) ◀── export_jobs ─────────────────  prices, jobs)
```

| Service | Path | Role |
|---------|------|------|
| API | `backend/src/api/` | Query widgets (overview, series, latency, breakdown, drill-down), meta, freshness, pipeline, exports, auth |
| Ingest | `backend/src/ingest/` | Kafka consumer: dedup, late classification, enrichment, ClickHouse insert, partition positions |
| Exporter | `backend/src/exporter/` | Background CSV exports with leases and progress |
| Generator | `backend/src/generator/` | Deterministic chat traffic; live, history, late-burst and duplicate modes |
| Frontend | `frontend/src/` | Dashboard, Definitions, Pipeline, Exports |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, TanStack Query, Zustand, Tailwind CSS, luxon, hand-built SVG charts
- **Backend:** Node.js, Express, TypeScript (tsx), kafkajs, @clickhouse/client, zod, luxon, prom-client, Pino
- **Data:** Kafka 3.8 (KRaft), ClickHouse 24.8, PostgreSQL 16, Valkey 7.2

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (Option 1), or the four services installed natively (Option 2)
- About 2.5 GB of free RAM for ClickHouse and Kafka

### Option 1: Docker Compose (recommended)

1. **Start the infrastructure:**
   ```bash
   cd llm-chat-analytics
   docker-compose up -d
   ```
   If another stack already holds a port, move it, for example `POSTGRES_PORT=5452 REDIS_PORT=6399 docker-compose up -d`. Then set `DATABASE_URL` and `REDIS_URL` to match (see below).

2. **Install, migrate and seed:**
   ```bash
   cd backend
   npm install
   npm run db:migrate      # PostgreSQL schema + ClickHouse tables and materialized views
   npm run db:seed         # orgs, users, prices, coverage; 35 days of history produced to Kafka
   ```

3. **Start the API, ingest, exporter and live generator:**
   ```bash
   npm run dev
   ```
   Ingest drains the seeded backlog in about 10 seconds; until then the freshness label says it is catching up.

4. **Start the frontend (new terminal):**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

5. **Open http://localhost:5173** and sign in (password `password123`):

   | User | Sees |
   |------|------|
   | `alice` | Admin at Larkspur Labs (Los Angeles, sees cost); analyst at Kestrel Health (Kolkata, UTC+5:30) |
   | `bob` | Analyst at Larkspur: no cost tiles, no cost columns |
   | `carol` | Admin at Kestrel and at Tiny Atelier (4 users: breakdowns and drill-downs are suppressed) |
   | `dana` | Support staff: every org, no cost, no conversation lists |

Stop with `docker-compose down` (add `-v` to delete the data). To start over with fresh history: stop the backend, then run `npm run db:seed -- --reset`.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey clickhouse kafka
brew services start postgresql@16
brew services start valkey
brew services start kafka          # KRaft mode in recent Homebrew formulas
clickhouse server --daemon         # or: brew services start clickhouse

createuser analytics
psql postgres -c "ALTER USER analytics PASSWORD 'analytics_password'"
createdb -O analytics chat_analytics

clickhouse client -q "CREATE USER IF NOT EXISTS analytics IDENTIFIED BY 'analytics_password'"
clickhouse client -q "GRANT ALL ON chat_analytics.* TO analytics"

psql -U analytics -d chat_analytics -c 'SELECT 1'   # verify PostgreSQL
valkey-cli ping                                     # verify Valkey
curl -s localhost:8123/ping                         # verify ClickHouse
kafka-topics --bootstrap-server localhost:9092 --list   # verify Kafka
```

`npm run db:migrate` creates the ClickHouse database if it is missing. Then follow steps 2–5 of Option 1.

### Environment variables

All have local defaults.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://analytics:analytics_password@localhost:5432/chat_analytics` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey |
| `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `http://localhost:8123` / `analytics` / `analytics_password` | ClickHouse |
| `KAFKA_BROKERS` / `KAFKA_TOPIC` | `localhost:9092` / `chat-events` | Kafka |
| `PORT` / `INGEST_PORT` / `EXPORTER_PORT` | `3000` / `3101` / `3102` | Service ports |
| `API_PORT` (frontend) | `3000` | Where Vite proxies `/api` |
| `SERVER_LATENESS_MS` / `CLIENT_LATENESS_MS` | `60000` / `600000` | Watermark allowances per stream |
| `MAX_LATENESS_HOURS` / `DEDUP_TTL_HOURS` | `72` / `96` | Seal buckets after; keep dedup claims for |
| `MIN_COHORT_USERS` | `5` | Suppression threshold |
| `DUPLICATE_RATE` / `LATE_RATE` | `0.02` / `0.03` | Live generator |
| `QUERY_DELAY_MS` | `0` | Demo: random delay per widget query, to watch aborts |
| `EXPORT_PAGE_DELAY_MS` | `250` | Demo: slows exports so progress is visible |

## Try the hard parts

```bash
cd backend
npm run generate:dupes -- --org larkspur --count 300   # re-send ingested events: counts don't move
npm run generate:late  -- --org larkspur --count 200   # yesterday afternoon, arriving now: yesterday changes, marked ↻
npm run rollups:rebuild -- --from 2026-10-01 --to 2026-10-30 --metric tokens_per_response   # backfill sealed days
QUERY_DELAY_MS=1500 npm run dev:api                    # click filter chips fast: superseded requests abort
```

Then open the dashboard and watch yesterday's bar, the freshness popover and the Pipeline page. Click a bar to see that the drill-down still adds up.

### Running more instances

```bash
npm run dev:server1      # API on :3001 (dev:server2, dev:server3)
npm run dev:ingest2      # second ingest consumer: partitions rebalance, the watermark stays honest
```

## Testing

```bash
cd backend && npm test        # 32 tests: dedup, late data, time-zone buckets, planner, watermarks, role gating
cd frontend && npm test       # 8 tests: range resolution, canonical keys, URL state
npm run type-check            # both packages
cd .. && npm run test:smoke llm-chat-analytics   # from the repo root, with the stack running
```
