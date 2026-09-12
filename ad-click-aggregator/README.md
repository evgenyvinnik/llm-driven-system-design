# Ad Click Aggregator

A local learning project that records advertising clicks, flags suspicious activity,
and displays time-series analytics. It demonstrates the interaction between a
transactional audit store, a columnar analytics database, and temporary Redis state.

The implementation uses **PostgreSQL, ClickHouse, and Valkey/Redis together**.
It is useful for exploring aggregation and failure scenarios, but its current
multi-store write path does **not** guarantee exactly-once counts or billing accuracy.

## What you can use

- Submit a single click or a batch of up to 1,000 clicks through the API.
- Inspect raw events, campaigns, ads, and system statistics from PostgreSQL.
- Query ClickHouse minute, hour, and day rollups by time range and entity IDs.
- Group analytics by country and device type.
- Inspect rule-based fraud flags and generate synthetic clicks in the dashboard.
- Observe JSON logs, Prometheus metrics, and dependency readiness checks.

There is no authentication, advertiser authorization, invoice generation, Kafka
pipeline, or implemented archival/reconciliation worker. Fraud flags are teaching
heuristics; flagged clicks remain included in total click counts.

## Local architecture

```
┌──────────────────┐       ┌──────────────────────┐
│ React dashboard  │──────▶│ Express API          │
│ Vite :5173       │       │ :3000 by default     │
└──────────────────┘       └────┬──────┬──────┬───┘
                               │      │      │
                    ┌──────────┘      │      └─────────┐
                    ▼                 ▼                ▼
             ┌────────────┐    ┌────────────┐    ┌────────────┐
             │ PostgreSQL │    │ Valkey     │    │ ClickHouse │
             │ raw + ads  │    │ dedup/state│    │ analytics  │
             └────────────┘    └────────────┘    └────────────┘
```

The backend is one Express process with ingestion, analytics, and admin route groups.
Ingestion writes PostgreSQL first, then Redis state, then submits a ClickHouse insert.
Those steps do not form one transaction. Analytics reads ClickHouse; there is no
fallback to the older PostgreSQL aggregate tables.

The frontend uses React 19, Vite, TanStack Router, Zustand, Tailwind CSS, and Recharts.
The home dashboard refreshes every **30 seconds**. ClickHouse insertion also has its
own buffering delay, so successful ingestion need not appear in a chart immediately.

## Prerequisites

Use Node.js 20+ and npm. Run commands from `ad-click-aggregator` unless another
working directory is specified. Choose one infrastructure option below.

## Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
```

[The Compose file](./docker-compose.yml) configures these services and named volumes:

| Service | Host ports | Development credentials | Database |
|---------|------------|-------------------------|----------|
| PostgreSQL 16 | 5432 | `adclick` / `adclick123` | `adclick_aggregator` |
| Valkey 7 | 6379 | No password | Default logical database |
| ClickHouse 23.8 | 8123 HTTP, 9000 native | `adclick` / `adclick123` | `adclick` |

The PostgreSQL schema is mounted for first-volume initialization. After services
are ready, explicitly apply both idempotent schemas to cover existing volumes too:

```bash
docker compose exec -T postgres psql -U adclick -d adclick_aggregator -v ON_ERROR_STOP=1 < backend/src/db/init.sql
docker compose exec -T clickhouse clickhouse-client --user adclick --password adclick123 --multiquery < backend/db/clickhouse-init.sql
```

Create one consistent advertiser/campaign/ad hierarchy for the test page:

```bash
docker compose exec -T postgres psql -U adclick -d adclick_aggregator -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO advertisers (id, name) VALUES ('adv_001', 'Demo advertiser') ON CONFLICT DO NOTHING;
INSERT INTO campaigns (id, advertiser_id, name) VALUES ('camp_001', 'adv_001', 'Demo campaign') ON CONFLICT DO NOTHING;
INSERT INTO ads (id, campaign_id, name) VALUES ('ad_001', 'camp_001', 'Demo ad') ON CONFLICT DO NOTHING;
SQL
```

Verify connectivity and tables:

```bash
docker compose exec postgres psql -U adclick -d adclick_aggregator -c 'SELECT count(*) FROM ads;'
docker compose exec redis redis-cli ping
docker compose exec clickhouse clickhouse-client --user adclick --password adclick123 --query 'SHOW TABLES FROM adclick'
```

Stop the services with `docker compose down`. To deliberately remove the project's
stored development data as well, use `docker compose down -v`. An ordinary container
restart preserves named-volume data; it is not a database backup strategy.

## Option B: Native installation on macOS (no Docker)

Install PostgreSQL, Valkey, and the
[ClickHouse Homebrew cask](https://formulae.brew.sh/cask/clickhouse):

```bash
brew install postgresql@16 valkey
brew install --cask clickhouse
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
brew services start postgresql@16
brew services start valkey
```

For a fresh local PostgreSQL installation, create the project role and database.
Use the installation's existing administrative account if it differs from your
macOS account; skip creation when the role/database already exist.

```bash
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE adclick LOGIN PASSWORD 'adclick123';"
createdb -O adclick adclick_aggregator
PGPASSWORD=adclick123 psql -h localhost -U adclick -d adclick_aggregator -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
```

Start ClickHouse in a dedicated terminal and data directory. The native binary can
run a persistent server from its current directory, as described in the
[ClickHouse local setup guide](https://clickhouse.com/docs/get-started/setup/self-managed/quick-install).

```bash
mkdir -p /tmp/adclick-native-clickhouse
cd /tmp/adclick-native-clickhouse
clickhouse server
```

From a second terminal in the project directory, initialize the schema and create
the application user using the fresh server's local default administrator:

```bash
clickhouse client --multiquery < backend/db/clickhouse-init.sql
clickhouse client --multiquery <<'SQL'
CREATE USER IF NOT EXISTS adclick IDENTIFIED WITH sha256_password BY 'adclick123';
GRANT ALL ON adclick.* TO adclick;
SQL
```

Homebrew installs its available ClickHouse version, which may differ from the
Compose image. Use the Compose option when reproducing behavior specific to 23.8.
For an existing native server, use its configured administrative credentials and
ports instead of assuming an unauthenticated default account.

Create demo metadata and verify the native services:

```bash
PGPASSWORD=adclick123 psql -h localhost -U adclick -d adclick_aggregator -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO advertisers (id, name) VALUES ('adv_001', 'Demo advertiser') ON CONFLICT DO NOTHING;
INSERT INTO campaigns (id, advertiser_id, name) VALUES ('camp_001', 'adv_001', 'Demo campaign') ON CONFLICT DO NOTHING;
INSERT INTO ads (id, campaign_id, name) VALUES ('ad_001', 'camp_001', 'Demo ad') ON CONFLICT DO NOTHING;
SELECT count(*) FROM ads;
SQL
valkey-cli ping
clickhouse client --user adclick --password adclick123 --query 'SHOW TABLES FROM adclick'
```

## Start the application

In one terminal, from the project directory:

```bash
cd backend
npm install
npm run dev
```

The backend defaults to [localhost:3000](http://localhost:3000). Startup requires
ClickHouse connectivity and attempts to apply its schema. Schema-application errors
are logged without necessarily blocking startup, so verify actual tables as above.

In another terminal, from the project directory:

```bash
cd frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). The Vite `/api` proxy targets backend
port 3000. The backend has no `db:migrate` script; use the SQL files shown above.

### Environment configuration

These are the connection variables actually read by the backend:

| Variable | Default |
|----------|---------|
| `PORT` | `3000` |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5432` |
| `POSTGRES_DB` | `adclick_aggregator` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | `adclick` / `adclick123` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` |
| `CLICKHOUSE_HOST` | `http://localhost:8123` |
| `CLICKHOUSE_DATABASE` | `adclick` |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `adclick` / `adclick123` |
| `NODE_ENV` | `development` |

The dev script does not automatically load a `.env` file. Export overrides in the
terminal, or load a trusted local `.env` before starting the backend:

```bash
set -a
source .env
set +a
npm run dev
```

## Exercise the system

Open [Test Clicks](http://localhost:5173/test), select the demo ad, and send a single
click or batch. The dashboard pages are `/`, `/analytics`, `/campaigns`, `/clicks`,
and `/test`. A single manual API call is also enough to populate the ingestion path:

```bash
curl -X POST http://localhost:3000/api/v1/clicks \
  -H 'Content-Type: application/json' \
  -d '{"ad_id":"ad_001","campaign_id":"camp_001","advertiser_id":"adv_001","device_type":"mobile","country":"US"}'
curl http://localhost:3000/health/ready
```

A new single click returns 202; a click-ID duplicate detected in Redis returns 200.
The optional `Idempotency-Key` header caches a response for five minutes. Stable
client-generated `click_id` values are useful when exploring retries, but the current
implementation has the consistency gaps described below.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/clicks/batch` | Sequential processing of up to 1,000 events, with per-event results |
| `GET /api/v1/analytics/aggregate` | Required ISO `start_time`/`end_time`; optional entity filters, granularity, and grouping |
| `GET /api/v1/analytics/realtime?minutes=60` | Recent ClickHouse minute rollups |
| `GET /api/v1/analytics/realtime/global` | Redis counters, a separate data source |
| `GET /api/v1/analytics/campaign/:id/summary` | ClickHouse campaign totals and breakdowns; requires time range |
| `GET /api/v1/admin/stats` | PostgreSQL event and entity counts |
| `GET /api/v1/admin/recent-clicks` | PostgreSQL raw events with limit and optional fraud filter |
| `GET /api/v1/admin/campaigns`, `/ads`, `/advertisers` | List metadata under the admin prefix |
| `GET /health`, `/health/live` | Process responses; do not verify all tables |
| `GET /health/ready` | PostgreSQL, Redis, and ClickHouse connectivity |
| `GET /metrics` | Prometheus exposition endpoint |

For multiple API instances, run `npm run dev:server1`, `dev:server2`, and
`dev:server3` from separate backend terminals. They use ports 3001–3003 and share
stores; update the frontend proxy or provide a load balancer to route UI requests
to them. No load balancer is included.

## Known implementation limits

- Dedup is an `EXISTS` check followed later by `SETEX`, so concurrent requests can
  pass together. PostgreSQL's unique click ID prevents duplicate rows there, but
  downstream counters and ClickHouse writes still run after an ignored insert.
- PostgreSQL, Redis, and ClickHouse can diverge after partial failure. There is no
  outbox, replay worker, reconciliation job, or PostgreSQL analytics fallback.
- ClickHouse uses asynchronous inserts without waiting for flush. An API success
  does not confirm that its analytics copy is durable or queryable.
- Distinct-user values are not correctly composable in the current rollups. Do not
  interpret their sums as an exact distinct count for an entire campaign or range.
- Fraud rules flag IP/user velocity, timestamps at millisecond 0 or 500, and missing
  device/OS/browser metadata. These can produce false positives and do not reject
  requests. Batch clicks do not receive the single route's automatic IP hash.
- The API is open, permits broad CORS, trusts forwarded client addresses, and has
  ClickHouse queries built with interpolated filters. It needs security work before
  exposure to untrusted traffic.
- The historical [seed file](./backend/db-seed/seed.sql) writes only PostgreSQL and
  contains an overlong `country='unknown'` value for a `VARCHAR(3)` column. Use the
  minimal metadata setup and API-generated clicks above for this documented flow.

For local source checks, use `npm run type-check` in the backend and `npm run build`
in the frontend. The project-level Playwright suite requires the running stack;
there is no backend unit-test script. This documentation review checked source and
configuration, not runtime throughput or billing correctness.

See [architecture.md](./architecture.md) for the proposed production design and a
source-based account of the local implementation. Interview walkthroughs:
[frontend](./system-design-answer-frontend.md),
[backend](./system-design-answer-backend.md),
[fullstack](./system-design-answer-fullstack.md).
Development history is in [CLAUDE.md](./CLAUDE.md).
