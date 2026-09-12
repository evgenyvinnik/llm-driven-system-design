# Dashboarding: metrics, charts, and alert evaluation

This learning project collects numeric time-series samples, stores them in TimescaleDB, and displays them in a React dashboard and metrics explorer. It includes dashboard/panel APIs, a small alert-rule interface, and an in-process evaluator. The useful design questions are how to preserve metric meaning while aggregating, keep many panels responsive, and distinguish unavailable telemetry from a healthy system.

Read [architecture.md](./architecture.md) for the proposed production design and the actual source behavior. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers are separate 45-minute discussions.

## What the implementation does

| Area | Current behavior |
|------|------------------|
| Ingestion | Public HTTP batch endpoint; resolves series IDs and inserts arrays directly into TimescaleDB |
| Storage | Raw `metrics` hypertable, one-day chunks, seven-day retention policy |
| Queries | Time buckets and exact tag-map containment filters; results remain separate per complete series |
| Dashboard | Public seeded dashboard with line, area, bar, gauge, and stat panels; each panel polls every ten seconds |
| Explorer | Metric-name selection, definition/tag display, and a chart of the first returned series |
| Configuration | Dashboard create/delete controls; panel configuration through the API; no drag/resize editor |
| Alerts | Public rule CRUD, manual predicate test, history, and a banner polling every 30 seconds |
| Accounts | Backend email/password session APIs and admin-only registration; no seeded accounts or login UI |

**The main correctness limitations are part of this demo:**

- An open ingestion circuit breaker returns an empty fallback, after which the service still reports the input points as accepted. Retried samples also have no database uniqueness or deduplication guarantee.
- Queries longer than six hours select missing `metrics_hourly` or `metrics_daily` tables. Errors initially return failures; after the shared query breaker opens, requests can return and cache empty results. Empty does not always mean no measurements exist.
- Charts zip series by array index rather than timestamp and substitute zero for missing samples. Uneven series can therefore be displayed at the wrong time. Gauge/stat panels use the last bucket of the first returned series.
- Alert windows are aggregation windows, not a requirement that the condition stay true for that duration. Missing data can resolve an active alert, averages can be weighted incorrectly, and count evaluation counts returned buckets. Webhooks are logged as a proposed action; no webhook or email is sent.
- Authentication/ownership checks cover some dashboard operations, but metrics and alerts are public. Single-panel reads lack private-dashboard checks, and panel update/delete checks can use a different dashboard from the target panel. This is not a tenant-isolated monitoring service.
- There are no rollups, active Kafka ingestion, rate limiting, metric-cardinality limits, live agent process, shared refresh coordinator, or panel error boundaries. The two Zustand stores are defined but unused by the current routes/components.

These findings were checked against source and selected isolated functions. Application code was not changed, and the documentation review did not run the full stack. See [Implementation Notes](./architecture.md#implementation-notes) for details.

## Stack and local addresses

Use Node.js 20 or later and npm. The frontend uses React 19, TypeScript, TanStack Router, Tailwind CSS, and Recharts. The Express backend uses `pg`, `ioredis`, Zod, Pino, Opossum, and `prom-client`.

| Service | Address | Development credentials |
|---------|---------|-------------------------|
| Frontend | http://localhost:5173 | No login screen |
| API | http://localhost:3000 | Session cookie on protected routes |
| TimescaleDB / PostgreSQL 16 in Compose | localhost:5432, database `metricsdb` | `metrics` / `metrics123` |
| Valkey 7 | localhost:6379 | No password |

Compose uses the moving image tag `timescale/timescaledb:latest-pg16`. It defines Kafka and Zookeeper behind the `kafka` profile, but no application source consumes them. There is no RabbitMQ, Mailhog, Prometheus server, or Grafana container in this project.

## Option A: Docker Compose (recommended)

From `dashboarding`:

```bash
docker compose up -d
docker compose ps
```

Wait for TimescaleDB and Valkey to become healthy. A fresh PostgreSQL volume automatically runs [backend/db/init.sql](./backend/db/init.sql). There is no `db:migrate` script. To apply the consolidated schema to an existing database without deleting its data:

```bash
docker compose exec -T postgres psql -U metrics -d metricsdb -v ON_ERROR_STOP=1 < backend/db/init.sql
```

The schema is guarded for reapplication; this is not a versioned migration system. It creates only the raw hypertable and metadata tables, not the rollups referenced by longer queries.

### Seed a fresh demo

Use the SQL seed once from the project directory:

```bash
docker compose exec -T postgres psql -U metrics -d metricsdb -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

On a fresh schema it creates 18 series: six metric names across three production hosts. It adds 361 ten-second samples per series, a public **Infrastructure Overview** dashboard with six panels, and three console alert rules. No users are created. Sample values are synthetic; they are not measurements of this computer or its services.

Rerunning the SQL seed appends measurements for all definitions matching its six names, while preserving existing fixed-ID dashboard/panel/rule records. It is not a reset. The alternative `npm run db:seed` generates 36 series across production and staging, inserts 12,996 samples in batches, then creates the same fixed-ID dashboard. That script is not rerunnable once the dashboard exists, can append points before failing, and does not close its Redis connection on successful completion. Choose one seed path for a fresh demo.

### Run the applications

In one terminal:

```bash
cd backend
npm install
npm run dev
```

In another terminal, starting from the project directory:

```bash
cd frontend
npm install
npm run dev
```

Open [the dashboard list](http://localhost:5173) and the seeded [Infrastructure Overview](http://localhost:5173/dashboard/11111111-1111-1111-1111-111111111111). The default one-hour view uses the existing raw table. Use a range of six hours or less while the rollup path remains incomplete.

Panels poll every ten seconds; alerts are evaluated at API startup and every 30 seconds. The seed does not keep producing new measurements, so recent windows eventually empty. The page-level Refresh button reloads dashboard metadata; its “Updated” time is not a guarantee that every panel has refreshed. Explorer refresh is manual.

Dashboard create/delete requires a session even though the UI has no login flow. Public viewing, metric queries, and alert management can be explored without one. The alert form currently needs a nonempty description: its empty-description path sends `null`, which the backend's optional-string validation rejects.

### Verify dependencies and stop them

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

`/health` checks PostgreSQL and Redis and returns HTTP 200 for Redis-only degradation. `/health/ready` checks PostgreSQL only. `/health/live` is process liveness. These endpoints do not verify rollup availability or alert correctness.

```bash
docker compose down
```

This retains named volumes. To intentionally delete this project's stored database and cache for a new demo:

```bash
docker compose down -v
```

## Option B: Native installation (macOS, no Docker)

TimescaleDB is required; plain PostgreSQL cannot execute the hypertable schema or `time_bucket` queries. The current [official Homebrew formula](https://github.com/timescale/homebrew-tap/blob/main/timescaledb.rb) builds against PostgreSQL 18, so this native alternative uses 18 while Compose uses 16. The application/schema have not been runtime-tested on that native combination during this review. Check the formula if installing later, since its PostgreSQL dependency changes over time.

For a fresh local Homebrew setup with port 5432 available:

```bash
brew install postgresql@18 valkey
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"
brew tap timescale/tap
brew install timescaledb
timescaledb_move.sh
brew services start postgresql@18
```

As the local PostgreSQL administrator, enable extension preloading, then restart the service. This example assumes a fresh configuration with no other preload libraries to preserve.

```bash
psql postgres -c "ALTER SYSTEM SET shared_preload_libraries = 'timescaledb';"
brew services restart postgresql@18
brew services start valkey
```

Create the application role/database and install the extensions as the local administrator:

```bash
psql postgres -c "CREATE ROLE metrics LOGIN PASSWORD 'metrics123';"
createdb -O metrics metricsdb
psql metricsdb -c 'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
```

From the `dashboarding` directory, apply the schema and seed once as the application role:

```bash
PGPASSWORD=metrics123 psql -h localhost -U metrics -d metricsdb -v ON_ERROR_STOP=1 -f backend/db/init.sql
PGPASSWORD=metrics123 psql -h localhost -U metrics -d metricsdb -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
PGPASSWORD=metrics123 psql -h localhost -U metrics -d metricsdb -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
valkey-cli ping
```

Run the API and frontend using the same npm steps as Option A. Stop native services with `brew services stop postgresql@18` and `brew services stop valkey`.

## Configuration and multiple instances

The backend reads environment variables directly. It does not load `.env`; export overrides in each process's shell.

| Variable | Default |
|----------|---------|
| `PORT` | `3000` |
| `NODE_ENV` | `development` |
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `metricsdb`, `metrics`, `metrics123` |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `SESSION_SECRET` | `dashboarding-secret-key-change-in-production` |
| `DISABLE_REDIS` | Unset; setting `true` changes session storage to in-process memory |
| `LOG_LEVEL` | `debug` in development, `info` in production |
| `SERVICE_NAME` | Logger: `dashboarding-api`; metric label: `api` |

`DISABLE_REDIS=true` does not disable Redis cache or health-check calls. It also makes sessions local to each API process. Session cookies last 24 hours and use `secure: true` in production mode; ordinary local HTTP uses development mode.

The backend's `dev:server1`, `dev:server2`, and `dev:server3` scripts correctly start ports 3001–3003 in separate terminals. Vite still proxies `/api` to **3000**, so those scripts do not by themselves provide a browser load balancer. Every API instance starts its own uncoordinated alert evaluator, which can create duplicate incidents.

## API examples

The public ingestion endpoint accepts at most 10,000 points per request. Timestamps are Unix milliseconds; omitted timestamps use receipt time. This returns `{ accepted }` with HTTP 200, subject to the open-breaker limitation above.

```bash
curl http://localhost:3000/api/v1/metrics/ingest -H 'Content-Type: application/json' -d '{"metrics":[{"name":"demo.temperature","value":22.5,"tags":{"room":"lab"}}]}'
```

Query a recent window with current timestamps, rather than a fixed historical date:

```bash
node -e 'const end=Date.now(); console.log(JSON.stringify({metric_name:"demo.temperature",start_time:end-3600000,end_time:end,aggregation:"avg",interval:"1m"}))' | curl http://localhost:3000/api/v1/metrics/query -H 'Content-Type: application/json' --data-binary @-
```

Other useful routes include `/api/v1/metrics/names`, `/api/v1/metrics/definitions`, `/api/v1/dashboards`, `/api/v1/alerts/rules`, and `/api/v1/alerts/instances`. Full route details and access limitations are in [API Design](./architecture.md#api-design). The first account must be provisioned directly in the database: `/api/v1/auth/register` requires an existing admin, and neither seed supplies one. That bootstrap and the missing browser login screen are unfinished product paths.

## Verification and source map

| Command | Scope |
|---------|-------|
| `npm run build` in `backend` | Compile to `dist`; `npm start` runs `dist/index.js` |
| `npm run type-check` in `backend` | TypeScript checking without emission |
| `npm run build` in `frontend` | TypeScript build check followed by Vite |
| `npm run type-check` in `frontend` | TypeScript checking without emission |
| `npm run lint` in either package | Existing ESLint command |
| `npm run test:e2e` in `dashboarding` | Four Playwright page/heading smoke tests; needs the backend and seeded database |

There is no backend test script or unit-test suite. The smoke tests do not verify sample alignment, aggregation, delivery, or alert transitions. This documentation review inspected source and ran isolated checks with mocked dependencies; it did not execute builds, seed a real database, start the stack, or reproduce browser flows.

Start with [API startup](./backend/src/index.ts), [ingestion](./backend/src/services/metricsService.ts), [query routing](./backend/src/services/queryService.ts), [alert evaluation](./backend/src/services/alertService.ts), [schema](./backend/db/init.sql), and [chart transformation](./frontend/src/components/PanelChart.tsx). [CLAUDE.md](./CLAUDE.md) records earlier development history; some historical statements differ from current source.

## Recorded codebase statistics

These are the repository's previously recorded figures, not recalculated measurements for this documentation revision.

| Metric | Value |
|--------|-------|
| Total SLOC | 10,442 |
| Source files | 69 |
| TypeScript | 5,931 |
| TSX | 2,092 |
| Markdown | 1,769 |
| SQL | 302 |
| JSON | 155 |
