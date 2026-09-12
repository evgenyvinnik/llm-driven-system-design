# Airbnb — Vacation Rental Marketplace

A local learning project for a two-sided rental marketplace. Guests browse places,
select dates, request or instantly confirm a booking, message hosts, and review
completed stays. Hosts can create listings and respond to reservation requests.

The useful system design problem is the boundary between discovery and commitment:
a search result may be stale, but two guests must not acquire the same property
for overlapping nights. The implementation demonstrates a transactional booking
path and also contains gaps that make this invariant worth studying.

This is a teaching application, not Airbnb's implementation. There is no payment
processor, map UI, identity verification service, or complete host editing workflow.
The production design and the source-grounded implementation assessment are in
[architecture.md](./architecture.md).

## What is implemented

| Area | Current behavior |
|------|------------------|
| Discovery | Listing cards, destination suggestions, PostGIS radius search, filters and sorting |
| Listing details | Photos, amenities, host information, visible reviews, date selector and price preview |
| Reservations | Instant or host-approved bookings, guest trips, host reservations, cancellation and completion APIs |
| Host tools | Become a host, create a listing, view owned listings, confirm or decline requests |
| Communication | Stored conversations and messages fetched when opened; no live delivery or polling |
| Reviews | Completed-stay reviews; a database trigger reveals reviews after both parties submit |
| Infrastructure | PostgreSQL/PostGIS, Valkey sessions and caches, RabbitMQ publishing and worker prototypes |
| Diagnostics | Pino request logs, audit records, Prometheus endpoint, health/readiness/liveness endpoints |

The listing creation wizard currently navigates to an edit route that does not
exist. The host list's Edit and Calendar links open the public listing page.
Listing updates, photo uploads, and availability changes are available through the
API, but do not have complete corresponding host screens. An admin role exists in
the schema and seed; there is no admin dashboard or admin route group.

## Stack and layout

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS and date-fns.
- **Backend:** TypeScript, Node.js, Express, node-postgres and cookie sessions.
- **Infrastructure:** PostgreSQL 16 with PostGIS 3.4, Valkey 7, RabbitMQ 3 management image in Compose.
- **Images:** Local files under `backend/uploads/listings`; seed images use external Picsum URLs.

| Location | Purpose |
|----------|---------|
| [frontend/src/routes](./frontend/src/routes) | Guest and host pages |
| [frontend/src/services/api.ts](./frontend/src/services/api.ts) | Central fetch wrapper and API clients |
| [backend/src/routes](./backend/src/routes) | HTTP business operations |
| [backend/src/db/init.sql](./backend/src/db/init.sql) | Schema, indexes, functions and triggers |
| [backend/src/shared](./backend/src/shared) | Cache, circuit breaker, queue, logging, audit and metrics helpers |
| [backend/src/workers](./backend/src/workers) | Incomplete booking, notification and analytics consumers |

## Local setup

Use Node.js 20 or newer and npm. Run commands from the stated directories. Choose
one infrastructure option; both use the same application connection defaults.

### Option A: Docker Compose (recommended)

From the repository root:

```bash
cd airbnb
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U airbnb -d airbnb
docker compose exec redis redis-cli ping
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
```

Compose loads `backend/src/db/init.sql` when it initializes an **empty** PostgreSQL
volume. There is no `db:migrate` npm script. The schema contains ordinary table
creation statements; replaying it against an initialized database is not a migration.

To stop services while retaining data:

```bash
docker compose down
```

For an intentional clean reset, `docker compose down -v` removes all three service
volumes and their data. Starting Compose again recreates the schema.

### Option B: Native installation (no Docker, macOS)

Homebrew's current PostGIS formula supports PostgreSQL 17/18, so this native example
uses PostgreSQL 17; Compose remains the reproducible PostgreSQL 16 setup. Check the
[PostGIS formula](https://formulae.brew.sh/formula/postgis) if that packaging changes.
Do not start a second PostgreSQL service on an already occupied port 5432.

```bash
brew install postgresql@17 postgis valkey rabbitmq
export PATH="$(brew --prefix postgresql@17)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
brew services start postgresql@17
brew services start valkey
brew services start rabbitmq
pg_isready -h localhost -p 5432
valkey-cli ping
rabbitmq-diagnostics -q ping
```

Create the application role and database once, using the local PostgreSQL
administrator account established by Homebrew:

```bash
psql postgres -c "CREATE ROLE airbnb LOGIN PASSWORD 'airbnb_dev_password';"
createdb -O airbnb airbnb
psql airbnb -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
```

From the repository root, initialize the fresh database:

```bash
PGPASSWORD=airbnb_dev_password psql -h localhost -U airbnb -d airbnb -v ON_ERROR_STOP=1 -f airbnb/backend/src/db/init.sql
```

Create the RabbitMQ account and grant access to the default virtual host:

```bash
rabbitmqctl add_user airbnb airbnb_dev
rabbitmqctl set_permissions -p / airbnb '.*' '.*' '.*'
rabbitmqctl set_user_tags airbnb management
```

Verify both data services with the application credentials:

```bash
PGPASSWORD=airbnb_dev_password psql -h localhost -U airbnb -d airbnb -c 'SELECT PostGIS_Version();'
rabbitmqctl list_permissions -p /
```

No object storage bucket is required. Uploads are local disk files.

### Install, seed, and start the backend

From the repository root:

```bash
cd airbnb/backend
npm install
npm run seed
npm run dev
```

`seed` is for a disposable demo database: it **deletes existing listings**, creates
eight example listings and sample accounts, and adds a past completed stay with
reviews. Existing user passwords are not reset by its upsert, and cached listing
or search data is not invalidated. Prefer seeding a fresh database before browsing.

For newly created demo accounts, the password is `password123`:

| Account | Persona |
|---------|---------|
| `guest1@example.com` | Guest |
| `host1@example.com`, `host2@example.com` | Hosts |
| `admin@example.com` | Schema-level admin role; no admin UI |

Start the backend from `airbnb/backend` so the upload writer and static file server
agree on the directory. The API listens at [localhost:3000](http://localhost:3000).

### Start the frontend

In another terminal, from the repository root:

```bash
cd airbnb/frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). Vite proxies `/api` and `/uploads` to
port 3000. Explore a seeded destination without dates first; date-filtered search
has a known query defect described below.

| Page | Purpose |
|------|---------|
| `/`, `/search`, `/listing/$id` | Discovery and listing details |
| `/login`, `/register`, `/become-host` | Account flows |
| `/trips`, `/booking/$id`, `/messages` | Guest reservations, reviews and conversations |
| `/host/listings`, `/host/listings/new`, `/host/reservations` | Implemented host pages |

### Environment variables

Defaults are defined directly in source. The backend does not load a `.env` file;
export overrides in the shell before starting it.

| Variable | Default | Used for |
|----------|---------|----------|
| `PORT` | `3000` | HTTP listener |
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` | PostgreSQL address |
| `DB_USER`, `DB_PASSWORD` | `airbnb`, `airbnb_dev_password` | PostgreSQL credentials |
| `DB_NAME` | `airbnb` | Database |
| `REDIS_URL` | `redis://localhost:6379` | Sessions, cache and consumer markers |
| `RABBITMQ_URL` | `amqp://airbnb:airbnb_dev@localhost:5672` | Broker |
| `FRONTEND_URL` | `http://localhost:5173` | Credentialed CORS origin |
| `NODE_ENV`, `LOG_LEVEL` | `development`, `info` | Cookies and logging behavior |

RabbitMQ management is at [localhost:15672](http://localhost:15672), using
`airbnb` / `airbnb_dev`.

## Commands and verification

In `airbnb/backend`:

```bash
npm run type-check
npm run build
npm test
```

`npm run start` runs source through `tsx`; it does not execute the compiled output.
`dev:server1`, `dev:server2`, and `dev:server3` start API instances on ports
3001–3003 against shared infrastructure. No load balancer is supplied, and the
frontend proxy still targets port 3000 until reconfigured.

In `airbnb/frontend`, `npm run build` performs TypeScript checking and a Vite build.
Backend Vitest route tests mock the database, authentication and shared services;
they do not prove real transaction isolation or broker delivery.

For the page smoke tests, first start and seed the backend. From `airbnb`:

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

The Playwright configuration can start the frontend, but not the database or API.
The tests primarily check page rendering and login, not concurrent reservations.

| Diagnostic endpoint | Actual scope |
|---------------------|--------------|
| `GET /live` | Process responds |
| `GET /ready` | PostgreSQL query succeeds |
| `GET /health` | Database/cache checks and diagnostic queue/breaker data; not a worker readiness check |
| `GET /metrics` | Metrics collected in this API process |
| `GET /debug/circuit-breakers` | Registered circuit breaker state |

Worker commands exist (`dev:worker:booking`, `dev:worker:notification`,
`dev:worker:analytics`, `dev:workers`), but the consumers are incomplete: they do
not connect their Redis client and reference tables absent from `init.sql`.
Do not treat starting them as working email delivery or analytics processing.

This documentation review traced the source and configuration; it did not run the
application stack or claim passing build, integration, or concurrency tests.

## Known limitations worth studying

- **Reservation integrity:** creation locks the listing and checks conflicts in one transaction. Host response, cancellation and calendar edits do not follow one shared locking/state-transition protocol; a confirm-after-cancel race can leave a confirmed booking unblocked.
- **Search correctness:** the count query misnumbers date parameters. Its breaker can return HTTP 200 with an empty fallback, which the UI presents as no results. Anonymous search cache keys truncate encoded parameters and can collide across filters.
- **Calendar and pricing:** the browser treats checkout boundaries inclusively, unlike the backend. Host range splitting compares database Date objects with request strings. Price overrides are stored but ignored by booking calculations; there is no payment collection or automatic pending-request expiry.
- **Delivery guarantees:** database changes and RabbitMQ publication are separate. Consumer deduplication is shared across queues, and requeued messages do not receive the incremented retry count. There is no reliable outbox/replay workflow.
- **Product completeness:** search has no map or pagination controls; host editing is incomplete; messages do not refresh automatically; reviews have no timed reveal; authorization, upload handling and session expiry need hardening.

See the final Implementation Notes in [architecture.md](./architecture.md) for
source links and concrete failure cases. These are documented limitations, not
fixes made during the documentation review.

## Interview versions

- [Frontend](./system-design-answer-frontend.md): search state, date selection, booking feedback and host editing.
- [Backend](./system-design-answer-backend.md): inventory invariants, geographic search and recoverable side effects.
- [Full stack](./system-design-answer-fullstack.md): the complete search-to-reservation journey.
