# App Store

A local app-marketplace learning project built around catalog discovery, ratings,
review heuristics, and a developer console. React talks to one Express API backed
by PostgreSQL, Valkey, Elasticsearch, RabbitMQ, and MinIO. This is a browser demo;
it does not integrate with Apple's App Store, install apps, or process payments.

See [architecture.md](./architecture.md) for the proposed production design and
source-backed implementation audit. The [frontend](./system-design-answer-frontend.md),
[backend](./system-design-answer-backend.md), and
[fullstack](./system-design-answer-fullstack.md) answers are interview walkthroughs.

## What you can explore

| Area | Current behavior |
|------|------------------|
| Discovery | Top free, paid, and new apps; categories; text search with price and sort controls |
| Details | Metadata, screenshots when available, ratings, published reviews, similar apps |
| Accounts | Registration and login; developer accounts see their console after login |
| Developer console | Create drafts, edit metadata, publish drafts directly, reply to reviews |
| Analytics | Total counters and estimated revenue; no time-series charts or payment ledger |
| API exercises | Review mutations, download recording, uploads, developer enrollment and submission |

The visible Get/price buttons have no action. Public review cards have no connected
vote handler or review-writing form. Search page-number buttons have no handlers;
category and review screens also show only the first page. There is no admin
moderation screen, checkout, library, package uploader, or install progress UI.

## Run locally

Use Node.js 20+ and npm. Choose one infrastructure option, then follow the common
application setup. Other repository projects share ports 3000 and 5173. This stack
runs five infrastructure services; Elasticsearch has a 512 MB JVM heap.

### Option A: Docker Compose (recommended)

From the repository root:

```bash
cd app-store
docker compose up -d
docker compose ps
```

Compose starts infrastructure only. PostgreSQL does **not** automatically execute
this project's schema. MinIO initialization creates three buckets and makes
icons/screenshots readable; packages remain private. Check initialization logs:
its shell can exit successfully even after an individual command fails.

```bash
docker compose logs minio-init elasticsearch
docker compose down
```

`docker compose down` retains named volumes. `docker compose down -v` additionally
deletes this project's database, index, queue, cache, and object data; use it only
when deliberately discarding the local demo.

### Option B: Native installation (no Docker)

Install services on macOS with Homebrew where available:

```bash
brew install postgresql@16 valkey rabbitmq minio minio-mc
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix)/sbin:$PATH"
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
```

For a fresh PostgreSQL instance, create and verify the project role/database:

```bash
psql postgres -c "CREATE ROLE appstore LOGIN PASSWORD 'appstore_pass';"
createdb -O appstore appstore
PGPASSWORD=appstore_pass psql -h localhost -U appstore -d appstore -c 'SELECT 1;'
valkey-cli ping
```

Reuse existing matching objects instead of rerunning creation commands. Configure
RabbitMQ's development account on its default vhost:

```bash
rabbitmq-diagnostics ping
rabbitmqctl add_user appstore appstore_pass
rabbitmqctl set_permissions -p / appstore '.*' '.*' '.*'
rabbitmqctl set_user_tags appstore management
rabbitmq-plugins enable rabbitmq_management
```

Homebrew may install a newer RabbitMQ than Compose's version 3 image. See
[RabbitMQ's Homebrew guide](https://www.rabbitmq.com/docs/install-homebrew) for
service and CLI locations.

Download the Elasticsearch macOS archive matching your CPU from the
[8.11.0 release page](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0).
Extract it, enter its directory, and run in a separate terminal:

```bash
ES_JAVA_OPTS='-Xms512m -Xmx512m' ./bin/elasticsearch \
  -Ediscovery.type=single-node \
  -Expack.security.enabled=false \
  -Enetwork.host=127.0.0.1
```

This reproduces the pinned development version. The [archive installation guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html)
explains its layout; the backend creates the `apps` index if absent.

Start MinIO in another terminal with a dedicated data directory:

```bash
mkdir -p "$HOME/.local/share/appstore-minio"
MINIO_ROOT_USER=minio_admin MINIO_ROOT_PASSWORD=minio_password \
  minio server "$HOME/.local/share/appstore-minio" --console-address ':9001'
```

Create buckets and verify the services:

```bash
mc alias set appstore-local http://localhost:9000 minio_admin minio_password
mc mb --ignore-existing appstore-local/app-packages
mc mb --ignore-existing appstore-local/screenshots
mc mb --ignore-existing appstore-local/icons
mc anonymous set download appstore-local/screenshots
mc anonymous set download appstore-local/icons
mc ls appstore-local
curl -fsS http://localhost:9000/minio/health/live
curl -fsS http://localhost:9200/_cluster/health
```

As checked in September 2026, Homebrew still supplies the deprecated
[MinIO server](https://formulae.brew.sh/formula/minio) and
[client package](https://formulae.brew.sh/formula/minio-mc), whose binary is `mc`.
The [community server repository](https://github.com/minio/minio) is archived.
These instructions reproduce the project's dependency, rather than selecting
storage for a new production deployment.

### Application setup — either infrastructure option

From the repository root:

```bash
cd app-store/backend
cp .env.example .env
npm install
npm run db:migrate
npm run seed
npm run dev
```

Run the seed **once on a fresh schema**. It creates three users, one developer,
10 top-level categories with subcategories, and 10 published apps, then indexes
those apps in Elasticsearch. Ratings, download totals, quality scores, and review
counts are randomized fixtures, not reconciled metrics. It uploads no package,
icon, or screenshot files.

The migration executes [init.sql](./backend/src/db/init.sql) using `CREATE TABLE IF
NOT EXISTS`; it does not upgrade conflicting old definitions. The TypeScript seed
is not safely repeatable: newly generated IDs can be used after an existing email
or slug was skipped, producing foreign-key errors. Do not mix it with the SQL seed.

| TypeScript-seeded account | Password | Purpose |
|--------------------------|----------|---------|
| `developer@appstore.dev` | `developer123` | Owns demo apps; use for the developer console |
| `user@appstore.dev` | `user123` | Ordinary user |
| `admin@appstore.dev` | `admin123` | Admin role, without a moderation UI or owned developer profile |

In another terminal, from the repository root:

```bash
cd app-store/frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). Vite proxies `/api` to port 3000.
After a full reload the UI loses its displayed login state: only the session ID
is persisted, and `fetchUser` has no caller. Sign in again for developer screens.
The server session may still exist independently of the UI.

The API creates the search index and ensures MinIO buckets before listening.
An Elasticsearch or MinIO failure can prevent startup. RabbitMQ connection failures
are logged and retried; failed event publication is not durably buffered.
Native bucket policies above are necessary because API startup only creates buckets.

### Alternative SQL fixture

[backend/db-seed/seed.sql](./backend/db-seed/seed.sql) is a different fixture for
screenshot automation. On a separate fresh migrated database, run it **instead of**
`npm run seed`, from `app-store`:

```bash
docker compose exec -T postgres psql -U appstore -d appstore -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

For native PostgreSQL, from the same directory:

```bash
PGPASSWORD=appstore_pass psql -h localhost -U appstore -d appstore -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

This fixture uses `password123` for `admin@appstore.dev`, `developer@appstore.dev`,
`alice@example.com`, and `bob@example.com`. It includes external placeholder
screenshots and user-download rows, but does not populate Elasticsearch. SQL
catalog browsing can work while text search is empty. There is no full reindex CLI.
Republishing an owned app indexes that app through the API, not the whole catalog.
Rerunning the SQL seed appends screenshots and reviews.

## Configuration and processes

The backend loads `.env` from its working directory; keep it in `backend`.

| Variable | Development default |
|----------|---------------------|
| `DATABASE_URL` | `postgresql://appstore:appstore_pass@localhost:5432/appstore` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `RABBITMQ_URL` | `amqp://appstore:appstore_pass@localhost:5672` |
| `MINIO_ENDPOINT`, `MINIO_PORT` | `localhost`, `9000` (endpoint excludes scheme/port) |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `minio_admin`, `minio_password` |
| `MINIO_USE_SSL` | `false` |
| `PORT`, `API_VERSION` | `3000`, `v1` |
| `NODE_ENV`, `LOG_LEVEL` | Example file: `development`, `debug` |

`SESSION_SECRET` is present but unused. Authentication uses 24-hour Redis sessions
with random UUID IDs, accepted as a cookie or bearer token. The frontend also
stores the token in localStorage. Changing `API_VERSION` requires updating the
browser's hardcoded `/api/v1` base.

| Command (from `backend`) | Purpose |
|--------------------------|---------|
| `npm run dev` | API on port 3000 |
| `npm run dev:server1` / `dev:server2` / `dev:server3` | APIs on 3001–3003; no load balancer supplied |
| `npm run dev:download-worker` | Optional download-event consumer |
| `npm run dev:review-worker` | Optional review-analysis consumer |
| `npm run build` / `npm run start` | Compile TypeScript / run compiled API |
| `npm run type-check` / `npm run lint` | Static checks |

Workers need separate terminals. The download worker queries two absent analytics
tables and catches those errors. The review worker cannot promote pending reviews
with its downward-only score adjustment. Starting them does not finish these flows.

```bash
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/health/ready
curl -fsS http://localhost:3000/metrics
curl -fsS http://localhost:9200/apps/_count
```

`/health` checks PostgreSQL, Redis, Elasticsearch and RabbitMQ, but not MinIO.
`/health/ready` checks PostgreSQL and Redis; `/health/live` reports process liveness.
Dependency health does not verify search contents or worker effects.

Frontend `npm run build` runs TypeScript and Vite. Both packages have lint/format
scripts. From `app-store`, install test dependencies and run `npm run test:e2e`
after the backend is available. Its five smoke tests use `admin123`; repository
screenshot configuration uses the SQL seed's `password123`. The tests mainly check
page shells, not business flows. There is no backend unit-test script.

## Current limitations and learning exercises

- **Reviews:** Creation queries `user_apps.id`, absent from the schema, and fails
  before insertion. Other mutations can leave rating counters inconsistent; cached
  review pages are not invalidated by the helper.
- **Publishing:** Drafts publish without approval or a binary. Submission moves a
  draft to pending with no approval path. Publishing a pending app can still index
  it because the controller ignores the failed transition. Public detail reads
  also lack a published-status filter.
- **Downloads:** The API increments counters and returns a placeholder URL without
  a scheme. It verifies neither payment nor a package. Its private-bucket path
  differs from the upload path; retries can count repeatedly.
- **Search and queues:** Search reranks within each fetched page. Database, index,
  and event writes can diverge. Outbox, circuit-breaker, and idempotency helpers
  are not connected to business requests.
- **Console:** Save/reply failures are mostly console-only; reply drafts clear
  before acknowledgement. Shared state has no request-context guards. Revenue is
  `price × recorded downloads × 0.7`, not money received.

The architecture explains these findings and proposed improvements. This review
checked source and documentation; it did not run the stack or repair the app code.
