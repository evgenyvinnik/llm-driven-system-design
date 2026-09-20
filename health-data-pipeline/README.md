# Health Data Pipeline

A teaching prototype for combining health measurements from several device records into hourly and daily summaries. The main design problem is distinguishing a retried sample from two different sensors observing overlapping activity, then presenting the resulting data with honest provenance and freshness.

The backend implements registration/login, device registration, batch ingestion, synchronous aggregation, queries, illustrative trend analysis, and admin APIs. The React source contains dashboard, metric explorer, device-registration, and admin views. It does not connect to real wearables or provide a clinically validated health service.

Read [architecture.md](./architecture.md) for the proposed production design and the verified local implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers explain the system through early high-level diagrams and three focused trade-offs each.

## Implemented surfaces and boundaries

| Surface | What exists |
|---------|-------------|
| Accounts | Email/password registration, bcrypt, seven-day opaque Bearer sessions in PostgreSQL and Valkey |
| Devices | List and register device records; submit samples through REST |
| Ingestion | Validate individual samples, normalize known unit conversions, bulk insert, then aggregate inline |
| Reports | Raw samples, hourly/daily aggregates, daily/weekly summaries, latest daily values, metric history |
| Trend analysis | Explicit API-triggered statistical examples for heart rate, sleep, activity, and weight |
| Frontend components | Four dashboard cards, two history charts, metric/range selectors, device-registration modal, admin stats/user list |
| Diagnostics | Pino request logging, Prometheus metrics, liveness/readiness/deep-health routes |

The frontend's route components currently return fresh Promises from dynamic imports instead of using a supported lazy-component wrapper. That needs attention before treating browser navigation as verified. The documentation review did not run the app in a browser.

There is no device SDK integration, background queue, live sync-status stream, sharing API/UI, export, or configured field encryption. Device update/delete and admin reaggregation are not available as UI flows; update/delete routes are also absent. `share_tokens`, `idempotency_keys`, and `retention_jobs` tables do not establish working sharing, durable receipt storage, or scheduled retention.

Aggregation and access-control defects remain in the teaching implementation. In particular, a small later sync can replace a whole day's total with a partial total; overlap clipping is incomplete and also affects metrics that should not be duration-scaled. Use synthetic data for this demo. The displayed trend messages are illustrative rules, not validated clinical conclusions.

## Stack

| Component | Actual choice |
|-----------|---------------|
| API | Node.js 20+, TypeScript, Express |
| Database | TimescaleDB on PostgreSQL 16 in Docker Compose |
| Cache/session lookup | Valkey 7 through ioredis |
| Frontend | React 19, Vite, programmatic TanStack Router, Zustand, Tailwind CSS |
| Charts | Recharts line/area charts; admin also uses bar charts |

## Infrastructure

Run commands from this project's directory. Choose one infrastructure option so services do not compete for ports 5432 and 6379.

### Option A: Docker Compose (recommended)

```bash
docker compose up -d
docker compose ps
docker compose exec timescaledb pg_isready -U health_user -d health_data
docker compose exec redis redis-cli ping
docker compose exec timescaledb psql -U health_user -d health_data -c '\dt'
```

[Compose](./docker-compose.yml) uses database `health_data`, user `health_user`, password `health_password`, and Valkey without a password. It mounts [init.sql](./backend/src/db/init.sql) for a fresh database volume. The Timescale image initializes the extension before the project schema. An existing volume does not rerun initialization, and the schema is not a repeatable migration script.

The image tag `latest-pg16` is mutable. The schema creates two hypertables with composite primary keys containing their time columns. Compression-policy setup catches errors, so successful initialization alone does not prove compression is enabled.

```bash
docker compose down
# Destructive reset: removes this project's database and cache volumes.
docker compose down -v
```

### Option B: Native PostgreSQL and Valkey on macOS

For a lightweight native demo, use ordinary PostgreSQL tables. This omits TimescaleDB partitioning and compression. The original schema has two unconditional hypertable calls, so it does **not** run unchanged on stock PostgreSQL.

Install [PostgreSQL 16](https://formulae.brew.sh/formula/postgresql@16) and [Valkey](https://formulae.brew.sh/formula/valkey), then create a temporary native schema with only those two calls removed:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"

# Once, for a fresh local cluster:
psql postgres -c "CREATE ROLE health_user LOGIN PASSWORD 'health_password';"
createdb --owner=health_user health_data
export DATABASE_URL='postgres://health_user:health_password@localhost:5432/health_data'

health_native_sql="$(mktemp -t health-native-schema)"
python3 - "$health_native_sql" <<'PY'
from pathlib import Path
import sys
lines = Path('backend/src/db/init.sql').read_text().splitlines()
removed = [line for line in lines if line.startswith('SELECT create_hypertable(')]
assert len(removed) == 2
Path(sys.argv[1]).write_text('\n'.join(line for line in lines if line not in removed) + '\n')
PY
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$health_native_sql"
psql "$DATABASE_URL" -c 'SELECT 1;'
valkey-cli ping
```

Skip role/database creation if already present. Apply the schema only to a fresh database; its index and trigger statements are not all guarded against repeats. The temporary copy leaves the checked-in schema unchanged. A native TimescaleDB installation can instead run the original schema after enabling its extension and required PostgreSQL configuration.

## Start the application

Backend terminal, from the project directory:

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

Frontend terminal, from the project directory:

```bash
cd frontend
npm install
npm run dev
```

The API defaults to [localhost:3000](http://localhost:3000/health), and Vite to [localhost:5173](http://localhost:5173). The intended dashboard route is `/`, with `/login`, `/register`, `/metrics`, `/devices`, and `/admin`. There is no `/dashboard` route.

The frontend proxies `/api` to port 3000. The backend also has `dev:server1`, `dev:server2`, and `dev:server3` scripts for ports 3001–3003, but no load balancer is provided and Vite does not automatically switch ports.

### Environment settings

The backend loads `.env` from its working directory. The standalone sample generator does not load dotenv; it reads exported environment variables.

| Setting | Default / behavior |
|---------|--------------------|
| `DATABASE_URL` | `postgres://health_user:health_password@127.0.0.1:5432/health_data` |
| `REDIS_URL` | `redis://localhost:6379` |
| `PORT` | `3000` |
| `NODE_ENV` | `development`; also selects log level/format |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `SESSION_SECRET` | Defined in configuration but unused by the opaque-session implementation |

Session duration is hardcoded to seven days in the auth service. The commented `LOG_LEVEL` and retention variables in `.env.example` do not override the corresponding implementation values.

## Optional sample data

The checked-in [seed](./backend/db-seed/seed.sql) contains seven invalid device UUIDs beginning with `dev`. Its raw-sample references use those same IDs, so executing it unchanged fails. For a **fresh demo database**, create a temporary copy changing that UUID prefix to the valid hexadecimal prefix `dea`:

```bash
health_seed_sql="$(mktemp -t health-seed)"
python3 - "$health_seed_sql" <<'PY'
from pathlib import Path
import re, sys
source = Path('backend/db-seed/seed.sql').read_text()
fixed = re.sub(r"'dev([0-9]{5}-)", r"'dea\1", source)
assert fixed != source
Path(sys.argv[1]).write_text(fixed)
PY

# Docker option:
docker compose exec -T timescaledb psql -U health_user -d health_data \
  -v ON_ERROR_STOP=1 --single-transaction < "$health_seed_sql"

# Native alternative; run this instead of the Docker command:
# psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$health_seed_sql"
```

This adapts only the demo fixture's invalid identifiers. It does not validate the seeded aggregates or trend messages. The fixture contains four users, seven devices, 32 raw samples, 12 precomputed daily aggregates, five illustrative insights, and two unused sharing records. Repeating it can duplicate samples and insights; existing users with the same emails but different IDs can cause foreign-key failures.

All four seeded passwords are `password123`: `alice@example.com`, `bob@example.com`, `carol@example.com`, and admin `admin@health.local`. The actual inserted bcrypt hash was checked. Most daily aggregates are for previous days, so the metric explorer is more useful than today's cards immediately after seeding. The `health_data_types` reference table is not populated by either schema or seed.

The standalone [sample generator](./backend/scripts/generate-sample-data.ts) currently uses `ON CONFLICT (id)`, which does not match the raw table's composite key `(id, start_date)`. It also bypasses the normal deduplication path. Do not treat it as a working setup step without correcting those differences.

## Commands and verification

| Directory | Command | Purpose |
|-----------|---------|---------|
| `backend` | `npm run dev` / `npm start` | Run TypeScript source with tsx; dev watches changes |
| `backend` | `npm run build` | Compile source to `dist` |
| `backend` | `npm run type-check` | Check backend TypeScript |
| `frontend` | `npm run build` | TypeScript build check and Vite bundle |
| `frontend` | `npm run type-check` | Check frontend TypeScript |
| Either package | `npm run lint` / `npm run format` | Existing maintenance scripts |
| Project root | `npm run test:e2e` | Playwright smoke suite; backend/database must already be running |

There is no `db:migrate`, `db:seed`, or backend `test` package script. The existing smoke/screenshot configuration requests the nonexistent `/dashboard` route and visits admin as ordinary user Alice, then mostly checks the shared `main` element. It does not establish that the correct page, data, authorization, or aggregation result works.

The documentation review ran isolated source checks with mocked infrastructure. It did not run migrations, the temporary setup recipes, a complete build, browser flows, or load tests.

## Important implementation limits

- Authentication is required, but sync does not verify that the device belongs to the caller. Explicit idempotency headers use a global Redis key and can replay another request's cached response.
- Automatic receipt keys use a small rolling hash, not SHA-256, and omit units, sample IDs, and metadata. Receipt caching is not atomic with the SQL write.
- Unit conversion silently relabels unsupported units; validation omits finite values, valid end times, interval ordering, and time-range limits.
- Aggregation reads a narrow start-time range, clips only the first detected overlap, misses containing intervals, and assigns whole intervals to their start bucket. Reaggregation has no version guard or atomic publication across buckets.
- Query caches use prefixes that the invalidation helper does not match. Dashboard data can remain stale for the five-minute TTL.
- The frontend does not clear health state on logout or guard old requests by account/range. History response field names also differ from the chart's min/max expectations.
- Trend analysis uses observation index rather than elapsed days, compares partial periods, and returns generated objects without the stored IDs/timestamps expected by the client.
- Retention functions are unscheduled helpers; there is no archive pipeline or retention audit writer. Encryption and compliance claims are not established by the repository.

See [Implementation Notes](./architecture.md#implementation-notes) for the full source mapping and [CLAUDE.md](./CLAUDE.md) for historical development notes.
