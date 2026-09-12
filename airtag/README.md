# AirTag — Item Tracking Simulation

A local web application for learning how item registration, rotating lookup
identifiers, encrypted report storage, maps, lost mode and background processing
fit together. Select a seeded device, inspect its location history, and click the
map to simulate another observation. An admin dashboard shows aggregate activity.

**The implementation trusts the server with locations and keys.** The backend stores
device master secrets, encrypts simulated observations, decrypts history, and caches
plaintext coordinates in Redis. It is not an end-to-end encrypted or server-blind
Find My implementation. It does not connect to Apple's network or physical trackers.

The proposed privacy-preserving design and the actual source behavior are separated
in [architecture.md](./architecture.md).

## What you can explore

| Feature | Current implementation |
|---------|------------------------|
| Accounts | Email/password registration and Redis-backed cookie sessions |
| Devices | Register, list, update and remove devices belonging to an account |
| Map | Leaflet/OpenStreetMap view of the selected device and an optional history line |
| Report simulation | Map coordinates sent to the backend, encrypted and stored synchronously |
| Report ingestion | Authenticated encrypted-report endpoint using RabbitMQ, with a synchronous fallback on publication error |
| Lost mode | Store a contact message and create notifications when the current identifier matches a lost device |
| Notifications | Database inbox and read/unread actions; fetched when the panel opens |
| Unwanted tracker detection | API-only sighting submission and a server-side heuristic; no background Bluetooth scanner |
| Admin | Aggregate statistics refreshed every 30 seconds; additional read APIs for users/devices/lost items |

The selected device's history refreshes every 30 seconds. Notification badges do
not continuously refresh, and Redis pub/sub has no connected browser delivery path.
Play Sound returns simulated success and displays a short UI state; it produces no
hardware or browser audio. Directions currently opens a fixed San Francisco location.

## Stack and source map

- **Frontend:** React 19, TypeScript, Vite, Zustand 5, Tailwind CSS, Leaflet and react-leaflet.
- **Backend:** Node.js, TypeScript, Express, PostgreSQL, ioredis and RabbitMQ/amqplib.
- **Diagnostics:** Pino/pino-http, prom-client, Redis-backed express-rate-limit.
- **Infrastructure:** PostgreSQL 16, Valkey 7 and RabbitMQ 3 in Compose; no PostGIS or object storage.

| Location | Responsibility |
|----------|----------------|
| [frontend/src/App.tsx](./frontend/src/App.tsx) | Authentication view, device selection and admin tab; no router |
| [frontend/src/stores/useStore.ts](./frontend/src/stores/useStore.ts) | Fetching and in-memory UI state |
| [backend/src/routes](./backend/src/routes) | Authenticated HTTP contracts |
| [backend/src/services](./backend/src/services) | Device, location, lost-mode, notification and sighting operations |
| [backend/src/utils/crypto.ts](./backend/src/utils/crypto.ts) | Demo identifier derivation and symmetric encryption |
| [backend/src/shared](./backend/src/shared) | Cache, idempotency, queue, rate limits, logs, metrics and health helpers |
| [backend/src/db/init.sql](./backend/src/db/init.sql) | Schema and indexes |

## Local setup

Use Node.js 20 or newer and npm. Choose one infrastructure option. Commands state
their working directory; the frontend and backend run in separate terminals.

### Option A: Docker Compose (recommended)

From the repository root:

```bash
cd airtag
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U findmy -d findmy
docker compose exec redis redis-cli ping
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
```

The PostgreSQL image loads `backend/src/db/init.sql` on first initialization of an
empty database volume. There is no `db:migrate` script. Although tables use
`IF NOT EXISTS`, indexes do not, so replaying the file is not a safe migration.

```bash
docker compose down
```

This stops the stack. PostgreSQL and Valkey have named persistent volumes; RabbitMQ
has no volume in this Compose file, so removing its container also removes its data.
For an intentional database/cache reset, `docker compose down -v` deletes their
volumes. Starting again initializes a fresh schema.

### Option B: Native installation (no Docker, macOS)

```bash
brew install postgresql@16 valkey rabbitmq
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
```

Using the local PostgreSQL administrator account established by Homebrew, create
the role and database once:

```bash
psql postgres -c "CREATE ROLE findmy LOGIN PASSWORD 'findmy_secret';"
createdb -O findmy findmy
```

From the repository root, initialize the fresh database and verify the services:

```bash
PGPASSWORD=findmy_secret psql -h localhost -U findmy -d findmy -v ON_ERROR_STOP=1 -f airtag/backend/src/db/init.sql
PGPASSWORD=findmy_secret psql -h localhost -U findmy -d findmy -c 'SELECT COUNT(*) FROM users;'
valkey-cli ping
rabbitmq-diagnostics -q ping
rabbitmqctl list_users
```

For local AMQP connections, the application defaults to RabbitMQ's `guest` / `guest`
account on the default `/` virtual host. If your broker has different credentials,
export `RABBITMQ_URL` before starting the API or workers. No buckets or spatial
extensions need to be created.

### Backend and seed data

From the repository root:

```bash
cd airtag/backend
npm install
npm run seed
npm run dev
```

The seed creates three accounts, seven fixed demo devices, thirteen timestamped
location reports and three notifications. Newly created accounts use `password123`:

| Account | Demo data |
|---------|-----------|
| `admin@findmy.local` | Five devices, notifications, lost AirPods and admin statistics |
| `alice@example.com` | Two devices |
| `bob@example.com` | Account without seeded devices |

Existing users and devices are left unchanged on conflict, so seeding does not reset
an existing password. Each run appends new location reports and notifications; it is
not idempotent. The historical SQL seed mentioned in older comments is not present;
the executable seed is [backend/src/db/seed.ts](./backend/src/db/seed.ts).

### Frontend

In a second terminal, from the repository root:

```bash
cd airtag/frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). Vite proxies `/api` to port 3000.
Sign in with a seeded account and select a device with history to exercise the map.
OpenStreetMap tiles and default marker assets require network access.

For a newly added device with no history, the current empty-state overlay can
intercept map clicks. Use the seeded devices for the map demo; this UI limitation
is recorded in the architecture review.

### Optional workers

Map-click simulation writes directly through the API and does not use the report
queue. To exercise the separate `POST /api/locations/report` path, run these in
additional terminals from `airtag/backend`:

```bash
npm run dev:worker
```

```bash
npm run dev:notification-worker
```

`dev:worker1` and `dev:worker2` start more location consumers. All location routes,
including report submission, require a logged-in session. The queue path lacks
publisher confirms, durable deduplication and a retry/dead-letter workflow; see the
limitations below before interpreting an HTTP 202 as a storage guarantee.

## Configuration

The backend reads shell environment variables directly; it does not load `.env`.

| Variable | Default |
|----------|---------|
| `PORT` | `3000` |
| `POSTGRES_HOST`, `POSTGRES_PORT` | `localhost`, `5432` |
| `POSTGRES_DB`, `POSTGRES_USER` | `findmy`, `findmy` |
| `POSTGRES_PASSWORD` | `findmy_secret` |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` |
| `SESSION_SECRET` | `findmy-dev-secret-change-in-production` |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `NODE_ENV` | Unset; development behavior |
| `LOG_LEVEL` | `debug`, or `info` when `NODE_ENV=production` |

RabbitMQ management is at [localhost:15672](http://localhost:15672) with
`guest` / `guest` in Compose. Session cookies are HTTP-only, last up to the configured
24-hour cookie lifetime, and use the secure flag in production mode.

## Checks and commands

In either `airtag/backend` or `airtag/frontend`:

```bash
npm run type-check
npm run build
```

After a backend build, `npm start` runs `dist/index.js`. Compiled worker entry points
are available through `start:worker` and `start:notification-worker`. API scripts
`dev:server1` through `dev:server3` use ports 3001–3003; there is no supplied load
balancer, and the frontend proxy continues to target port 3000.

| Endpoint | Actual diagnostic meaning |
|----------|---------------------------|
| `/health`, `/health/live` | HTTP process responds |
| `/health/ready` | Checks PostgreSQL and Redis; returns 200 degraded if only one fails |
| `/metrics` | Metrics from this API process; does not include separate worker registries |

There is no backend unit-test script or test suite. `airtag/package.json` supplies
Playwright page tests via `npm run test:e2e`; these need the API/database running,
and their login helper still uses `admin123`, unlike the current fresh seed's
`password123`. They require that correction before serving as a fresh-seed smoke check.
The Playwright configuration starts only the frontend.

This documentation pass inspected source and configuration. It did not start the
stack or claim passing application builds, browser tests or cryptographic audits.

## Important implementation limits

- **Privacy:** secrets and plaintext locations are available to the backend. Identifier rotation does not rotate the symmetric encryption key; the payload's ephemeral-key field is unused random data.
- **Authorization:** latest-location cache hits are returned before ownership is checked. Device/admin APIs also serialize stored device secrets. UUIDs do not replace access checks.
- **Ingestion:** the queue consumer inserts without deduplication. The synchronous path sets a Redis marker before the database write, can suppress unfinished work, and derives identity from server receipt time. There is no exactly-once guarantee.
- **Freshness:** identifier invalidation is a no-op. Default history requests generate new timestamp-based cache keys, while the latest cache can remain stale for a minute. Late responses can overwrite the selected device's history.
- **Detection:** manually submitted sightings use a count plus distance-or-duration heuristic. There is no cross-rotation identity linkage, background scanner, complete safety-action UI or validated detection performance.
- **Recovery:** no report retention job, queue dead-letter routing, consumer resubscription, offline cache, UWB/NFC integration or actual push delivery is implemented. Disabling a device changes a flag but does not stop report processing.

## Design discussions

- [Architecture](./architecture.md): proposed production boundaries and source-grounded local behavior.
- [Frontend interview](./system-design-answer-frontend.md): map state, privacy boundaries and safety feedback.
- [Backend interview](./system-design-answer-backend.md): opaque report storage, bounded retrieval and reliable ingestion.
- [Full-stack interview](./system-design-answer-fullstack.md): observation-to-map flow, recovery and unwanted-tracker protection.
