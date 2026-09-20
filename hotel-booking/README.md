# Hotel Booking

A hotel reservation learning project with a React guest interface, property management screens,
and a Node.js API. It explores date-range inventory, temporary reservations, per-night prices,
search projections, and retry behavior. It is a local teaching implementation: confirmation is
a database update, and **no payment provider charges money**.

Read [architecture.md](./architecture.md) for the production proposal and the source-backed local
implementation. The [frontend](./system-design-answer-frontend.md),
[backend](./system-design-answer-backend.md), and
[fullstack](./system-design-answer-fullstack.md) answers explain proposed designs for interviews.

## What is implemented

| Area | Current behavior |
|---|---|
| Discovery | Elasticsearch hotel matching, filters, sorting, and optional PostgreSQL/Valkey availability enrichment |
| Hotel detail | Room types, date-specific totals, monthly availability calendar, and reviews |
| Reservation | PostgreSQL room-type row lock, nightly occupancy calculation, reserved booking, and default 15-minute hold |
| Booking management | Own booking list/detail, simulated confirmation, cancellation, and reviews |
| Property management | Create hotels, edit room types and inventory, set a price override for one date, inspect owned-hotel bookings |
| Operations | Request logging, Prometheus endpoint, dependency health checks, and an expiry sweep every minute per API process |

Several flows have known integration defects. Search returns `hotel_id` while cards expect `id`,
so result links can point to an undefined hotel. Search URLs are not restored into the search
store. Cached duplicate booking responses lose fields, and calendar/pricing date handling is
sensitive to the server timezone. These are documented limitations, not repaired by this review.
See [Implementation Notes](./architecture.md#implementation-notes) before treating a successful
page render as evidence that booking works end to end.

## Stack and prerequisites

- Node.js **20 or newer**, npm, and either Docker Compose or native infrastructure.
- React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS, and date-fns.
- Express, PostgreSQL 16, Valkey 7, and Elasticsearch 8.11.0.
- Pino and prom-client are wired; the Opossum breaker helpers are not used by request paths.

Run commands from the directory indicated. These projects share common ports, so another demo
using 5432, 6379, 9200, 3001, or 5173 may conflict.

## Option A: Docker Compose (recommended)

From `hotel-booking/`:

```bash
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U hotel_user -d hotel_booking
docker compose exec -T redis valkey-cli ping
curl --fail http://localhost:9200/_cluster/health
```

The PostgreSQL container initializes [backend/src/db/init.sql](./backend/src/db/init.sql) only
when its data directory is empty. There is no `db:migrate` script. This schema is for a fresh
installation; its table, index, and trigger statements are not safe to rerun over existing data.

| Service | Host ports | Local credentials |
|---|---|---|
| PostgreSQL | 5432 | `hotel_user` / `hotel_pass`, database `hotel_booking` |
| Valkey, Compose service `redis` | 6379 | No password |
| Elasticsearch | 9200 HTTP, 9300 transport | Security disabled for the demo |

`docker compose down` stops the stack. `docker compose down -v` also deletes this demo's database,
cache, and search volumes; use it only when intentionally discarding their contents.

## Option B: Native installation (no Docker)

On macOS, install and start PostgreSQL and Valkey with Homebrew. The role and database creation
commands assume they do not already exist:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -c "CREATE ROLE hotel_user LOGIN PASSWORD 'hotel_pass';"
createdb -O hotel_user hotel_booking
pg_isready -h localhost -p 5432
PGPASSWORD=hotel_pass psql -h localhost -U hotel_user -d hotel_booking -c 'SELECT current_database();'
valkey-cli ping
```

From `hotel-booking/`, initialize the empty database:

```bash
PGPASSWORD=hotel_pass psql -h localhost -U hotel_user -d hotel_booking \
  -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
```

For Elasticsearch, download the **8.11.0 macOS archive** matching your CPU from
[Elastic's release page](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0).
Extract it, enter the extracted directory, and start it in a separate terminal:

```bash
ES_JAVA_OPTS='-Xms512m -Xmx512m' ./bin/elasticsearch \
  -Ediscovery.type=single-node \
  -Enetwork.host=127.0.0.1 \
  -Expack.security.enabled=false \
  -Expack.security.enrollment.enabled=false
```

Verify with `curl --fail http://localhost:9200/_cluster/health`. These settings match the local
HTTP client. See the [8.11 archive guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html)
for installation details; this is a pinned learning stack, not a recommendation for a new deployment.

## Prepare sample data and start the API

From `hotel-booking/backend/`, after all three services are ready:

```bash
npm install
cp .env.example .env
npm run seed
npm run dev
```

The TypeScript seed creates three accounts, five hotels, and thirteen room types on a fresh
database, then indexes the hotels. It does not create bookings, reviews, or nightly overrides.
Repeating it resets passwords for matching emails and adds another set of hotels and rooms;
it is not a reset. An Elasticsearch failure can leave partially seeded SQL data.

| Account | Password | Use |
|---|---|---|
| `user@hotel-booking.com` | `user123` | Guest |
| `hotel@hotel-booking.com` | `hoteladmin123` | Owner of the seeded properties |
| `admin@hotel-booking.com` | `admin123` | Admin role; existing ownership checks still apply |

The API's startup calls index setup, so do not use `npm run setup-es`: its target file is absent.
Startup catches index setup failures and may still listen; verify actual search behavior, not
just the startup message.

### Optional SQL fixtures

[backend/db-seed/seed.sql](./backend/db-seed/seed.sql) is a separate screenshot/history fixture:
five users, five hotels, seventeen room types, nine bookings, twenty-two price overrides, and five
reviews on an empty database. Alice, Bob, Carol, and the property owner use `password123`;
`admin@example.com` uses `admin123`. These password hashes were checked independently.

These fixtures use fixed dates, many now in the past, and **do not populate Elasticsearch**.
They are not a substitute for the indexed TypeScript demo. Inserts mostly skip existing IDs;
image updates after the transaction can also affect other rows with empty or local image paths.
Do not mix the two seeds expecting identical accounts or a clean dataset.

To load this optional fixture into a prepared Docker database, from `hotel-booking/`:

```bash
docker compose exec -T postgres psql -U hotel_user -d hotel_booking \
  -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

The native equivalent is `PGPASSWORD=hotel_pass psql -h localhost -U hotel_user -d hotel_booking -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql`.
Search indexing of these extra properties requires a separate reindex operation; none is supplied
as a working package script.

## Start the frontend

In another terminal, from `hotel-booking/frontend/`:

```bash
npm install
npm run dev
```

Open [the UI](http://localhost:5173). Vite proxies `/api` to **3001**. Backend `dev` and
`dev:server1` explicitly set 3001; `dev:server2` and `dev:server3` use 3002 and 3003. They share
infrastructure and each runs an expiry timer. No load balancer is included.

For inspecting a hotel despite the search-card ID mismatch, its PostgreSQL UUID can be used in
`/hotel/<uuid>`. The normal booking path should still be evaluated against the documented defects.
A deployed frontend needs a same-origin API reverse proxy; Vite's development proxy is not part
of the built assets.

## Configuration

[backend/.env.example](./backend/.env.example) is loaded through dotenv from the backend working
directory. [config/index.ts](./backend/src/config/index.ts) determines the actual settings:

| Variable | Default / effect |
|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT` | `localhost`, `5432` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `hotel_user`, `hotel_pass`, `hotel_booking` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `PORT` | Source fallback `3000`; copied template and development script use 3001 |
| `NODE_ENV` | `development` |
| `RESERVATION_HOLD_MINUTES` | `15`; source does not validate bounds |
| `DATABASE_URL` | Present in the template but **not consumed**; use the `POSTGRES_*` variables |
| `SESSION_SECRET` | Read into config but unused by the opaque-token session implementation |

`npm start` runs TypeScript through tsx; it does not run the build output. Sessions have a hardcoded
24-hour lifetime. The UI stores a bearer token in localStorage, not an HTTP-only cookie.

## Checks and current limits

From the backend, `npm run type-check` checks types and `npm run build` emits JavaScript.
From the frontend, `npm run build` runs TypeScript and Vite. There is no frontend `type-check`
script or backend unit-test script.

The API exposes `/health`, `/health/live`, `/health/ready`, `/healthz`, and `/metrics` on port 3001.
Health probes check connectivity; they do not establish schema correctness, hotel-index readiness,
or booking safety. The current aggregation even accepts a degraded Elasticsearch result as ready.

Repository smoke tests use the SQL fixture's Alice account and require infrastructure/backend
availability. Their assertions do not verify search-to-reservation, payment, expiry races, or
concurrent inventory protection.

This documentation review used source inspection and nine isolated checks with mocked dependencies,
plus fixture password, link, schema, diagram, and shell-syntax checks. It did not start the stack,
run a full build, or exercise a browser. Major remaining gaps include missing payment verification,
weak retry receipts, stale availability caches, incomplete date validation, and owner inventory
edits that can reduce capacity below existing bookings. Details and source links are in
[architecture.md](./architecture.md).
