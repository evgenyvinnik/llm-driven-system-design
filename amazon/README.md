# Amazon — E-Commerce Learning Project

A local storefront for studying catalog search, cart reservations, checkout,
order history, reviews and recommendations. React pages call one Express API backed
by PostgreSQL, Valkey and Elasticsearch. Seller and admin operations are exposed
through APIs; there is no seller portal or admin dashboard in the frontend.

The project demonstrates a reserved-stock model, but **the current transaction code
does not guarantee against overselling**. Payments are simulated. The architecture
explains both a proposed production design and the implementation's correctness gaps.

## What is implemented

| Area | Current behavior |
|------|------------------|
| Catalog | Product cards, category hierarchy, attributes, images and price comparisons |
| Search | Elasticsearch text search, category/price/rating/stock filters and aggregations; limited PostgreSQL fallback |
| Cart | PostgreSQL cart lines with reservation timestamps and quantity changes |
| Checkout | One address form, demo payment, order creation and order-detail navigation |
| Orders | Account order history, details and customer cancellation; admin status API |
| Reviews | Read reviews and mark helpful in the UI; creation/update/delete APIs |
| Recommendations | Seeded co-purchase relationships and an hourly in-process recomputation |
| Operations | Pino logging, Prometheus endpoint, health probes and scheduled cleanup helpers |

Attributes such as size and color are descriptive JSON, not separately purchasable
variants. Order statuses do not imply a shipping integration. “Low stock” is an admin
report, not a notification service. There is no Kafka, payment worker, WebSocket,
service worker, offline cart or real card charge.

## Stack and source map

- **Frontend:** React 19, TypeScript, Vite 6, TanStack Router, Zustand 5 and Tailwind CSS 4.
- **Backend:** Node.js 20+, TypeScript/tsx, Express, pg, node-redis, Elasticsearch client and Opossum.
- **Compose:** PostgreSQL 16, Valkey 7 with AOF, Elasticsearch 8.11.0 with a 512 MB heap.

| Source | Purpose |
|--------|---------|
| [backend/src/index.ts](./backend/src/index.ts) | API startup, middleware, health and job scheduling |
| [backend/src/routes](./backend/src/routes) | Catalog, cart, order, review and administration operations |
| [backend/src/services/backgroundJobs.ts](./backend/src/services/backgroundJobs.ts) | Reservation cleanup, recommendations and rating aggregation |
| [backend/src/shared](./backend/src/shared) | Idempotency, payment breaker, retry, audit and archival helpers |
| [backend/src/db/init.sql](./backend/src/db/init.sql) | Complete schema and indexes |
| [frontend/src/routes](./frontend/src/routes) | Storefront pages |
| [frontend/src/stores](./frontend/src/stores) | Auth and cart state |

## Local setup

Use Node.js 20 or newer and npm. Choose one infrastructure option, then follow the
shared seed and application steps. Default ports may conflict with other projects.

### Option A: Docker Compose (recommended)

From the repository root:

```bash
cd amazon
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U amazon -d amazon_ecommerce
docker compose exec redis redis-cli ping
curl -fsS http://localhost:9200/_cluster/health
```

An empty PostgreSQL volume runs `backend/src/db/init.sql` automatically. It creates
schema only, not demo accounts. Wait for the service checks to succeed before seeding.
Elasticsearch exposes HTTP port 9200 and transport port 9300; the API uses 9200.

```bash
docker compose down
```

Stopping this way preserves named data volumes. For an intentional reset,
`docker compose down -v` deletes PostgreSQL, Valkey and Elasticsearch data; start
again and repeat the seed/index steps. This is not a migration workflow.

### Option B: Native installation (no Docker, macOS)

Install and start PostgreSQL and Valkey:

```bash
brew install postgresql@16 valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
brew services start postgresql@16
brew services start valkey
psql postgres -c "CREATE ROLE amazon LOGIN PASSWORD 'amazon_secret';"
createdb -O amazon amazon_ecommerce
```

Create the role/database once using your local PostgreSQL administrator account.
From the repository root, initialize the database:

```bash
PGPASSWORD=amazon_secret psql -h localhost -U amazon -d amazon_ecommerce -v ON_ERROR_STOP=1 -f amazon/backend/src/db/init.sql
PGPASSWORD=amazon_secret psql -h localhost -U amazon -d amazon_ecommerce -c 'SELECT COUNT(*) FROM users;'
valkey-cli ping
```

For Elasticsearch, use the official archive matching the repository's 8.11.0 version
and your Mac architecture. The following runs from a separate directory of your
choice, outside the repository. Set `AMAZON_ES_ARCH=x86_64` for an Intel Mac or
`AMAZON_ES_ARCH=aarch64` for Apple silicon:

```bash
AMAZON_ES_ARCH=aarch64
curl -fLO "https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-8.11.0-darwin-${AMAZON_ES_ARCH}.tar.gz"
curl -fLO "https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-8.11.0-darwin-${AMAZON_ES_ARCH}.tar.gz.sha512"
shasum -a 512 -c "elasticsearch-8.11.0-darwin-${AMAZON_ES_ARCH}.tar.gz.sha512"
tar -xzf "elasticsearch-8.11.0-darwin-${AMAZON_ES_ARCH}.tar.gz"
cd elasticsearch-8.11.0
ES_JAVA_OPTS='-Xms512m -Xmx512m' ./bin/elasticsearch -Ediscovery.type=single-node -Enetwork.host=127.0.0.1 -Expack.security.enabled=false -Expack.security.autoconfiguration.enabled=false
```

Leave this terminal running; verify from another with
`curl -fsS http://localhost:9200/_cluster/health`. These loopback-only, unauthenticated
settings match the local demo client. The pinned 8.11 series is no longer updated;
this setup reproduces the project, not a maintained production deployment.
[Elastic 8.11 archive instructions](https://www.elastic.co/guide/en/elasticsearch/reference/8.11/targz.html),
[8.11.0 downloads](https://www.elastic.co/downloads/past-releases/elasticsearch-8-11-0).

### Load demo data — required for either option

The SQL seed creates accounts, categories, sellers, four warehouses, twelve products,
sample orders, reviews, carts and recommendations. It is separate from `npm run seed`.

For Docker, from `amazon`:

```bash
docker compose exec -T postgres psql -U amazon -d amazon_ecommerce -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

For native PostgreSQL, from the repository root:

```bash
PGPASSWORD=amazon_secret psql -h localhost -U amazon -d amazon_ecommerce -v ON_ERROR_STOP=1 -f amazon/backend/db-seed/seed.sql
```

Run the SQL seed once for a fresh demo. It preserves existing user passwords and
product slugs, but rerunning adds warehouses, seller records, orders and reviews.
Its `ON CONFLICT` clauses do not make the whole script idempotent. Reserved quantities
are illustrative fixture values, not a reconciliation of all seeded cart lines.

| Account | Role and useful demo data | New-account password |
|---------|---------------------------|----------------------|
| `alice@example.com` | Buyer with cart, orders and reviews | `password123` |
| `bob@example.com` | Buyer with an order | `password123` |
| `admin@amazon.local` | Admin APIs | `password123` |
| `seller@amazon.local` | Product creation APIs | `password123` |

The stale `admin123` comment in the SQL file does not match its current password
hash. Existing accounts are not reset by the seed. Some sample cart lines expire
after 30 minutes; the API's cleanup job removes expired lines.

### Backend and search index

From the repository root:

```bash
cd amazon/backend
cp .env.example .env
npm install
npm run seed
npm run sync-es
npm run dev
```

`npm run seed` is optional extra catalog data: it adds up to twelve differently
named products, skipping existing titles. It relies on the accounts/categories/
warehouses created by the SQL seed. Running it alone on an empty schema leaves
those prerequisites absent and cannot create the documented demo accounts.

`sync-es` copies active products to the `products` index. Its helpers swallow some
indexing errors, so verify the index rather than treating the success log as proof:

```bash
curl -fsS http://localhost:9200/products/_count
curl -fsS 'http://localhost:3000/api/health/ready'
```

The API retries database/Redis initialization, then starts even if Elasticsearch
is unavailable. Without ES, only nonempty text searches attempt PostgreSQL fallback;
filter-only browsing through `/api/search` can return an empty list.

### Frontend

In another terminal, from the repository root:

```bash
cd amazon/frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). The API listens on port 3000 and Vite
proxies `/api` there. Product images are external URLs and require network access.
See the known limitations below if search or a product-detail page fails.

## Configuration and checks

The backend loads `.env` from its working directory via `dotenv/config`.

| Variable | Default or meaning |
|----------|--------------------|
| `DATABASE_URL` | `postgresql://amazon:amazon_secret@localhost:5432/amazon_ecommerce` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `PORT` | `3000` |
| `CART_RESERVATION_MINUTES` | `30` for API cart writes |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` for the idempotency helper |
| `SIMULATE_PAYMENT_FAILURES` | `true` enables a 10% random failure in the payment mock |
| `NODE_ENV` | Unset by default; `.env.example` sets `development` |
| `LOG_LEVEL` | `debug`, or `info` in production mode |

`SESSION_SECRET` appears in `.env.example` but is unused. Sessions are random IDs in
Valkey with seven-day TTL, sent in `X-Session-Id` and stored in browser localStorage.
The database `sessions` table is not the auth store or a fallback.

| Check | Command / behavior |
|-------|--------------------|
| Backend types | `npm run type-check` in `amazon/backend` |
| Frontend types/build | `npm run type-check` and `npm run build` in `amazon/frontend` |
| Backend start | `npm start` runs TypeScript through tsx; no backend build script |
| Multiple APIs | `dev:server1`, `dev:server2`, `dev:server3` use 3001–3003; every process starts jobs |
| Liveness | `/api/health` and `/api/health/live` |
| Readiness | `/api/health/ready` checks PostgreSQL and Valkey, not Elasticsearch |
| Diagnostics | `/api/health/detailed` and `/metrics` |

There is no backend unit-test suite. The five Playwright smoke tests in `amazon/tests`
use Alice's SQL-seeded account and check page shells. Run `npm install` and
`npm run test:e2e` from `amazon` after starting the API and infrastructure; the
Playwright config can start the frontend. Install Playwright's Chromium first if
needed with `npx playwright install chromium`. These tests do not verify inventory,
payment recovery or search correctness.

## Known implementation limits

- **Inventory:** availability reads and later writes are not one guarded stock operation. Updates apply each line's full quantity to every warehouse. Cleanup can race with renewed or checked-out carts; schema constraints do not prevent negative stock or over-reservation.
- **Checkout:** the browser sends no stable idempotency key. The server helper uses Redis as its primary claim, permits work on errors, does not scope supplied keys to an account/payload, and lacks a unique order constraint. Payment “queued” is a return value, with no processing queue or reconciliation worker.
- **Catalog/search:** the product lookup reuses one SQL parameter for integer ID and text slug. Search serialization includes literal `undefined` values; the fallback's in-stock SQL is malformed and drops the rating filter. ES errors and legitimate empty results are conflated.
- **Freshness:** catalog caches and ES stock/rating values are not kept current by all writes. Price buttons issue two competing URL updates. Request races can display stale search/cart data; checkout does not clear the client cart badge.
- **Authorization/lifecycle:** seller update APIs check role but not product ownership. A retention-stats endpoint is registered without an admin guard. Admin status edits accept any allowed value rather than enforcing transitions. Archival attempts to null a required shipping address and therefore rolls back against the supplied schema.

These are findings from source inspection, not fixed implementation behavior. This
documentation review did not run application builds or a database/browser stack.

## Design documents

- [Architecture](./architecture.md): production proposal, request flows and actual source behavior.
- [Frontend interview](./system-design-answer-frontend.md): discovery, cart state and recoverable checkout.
- [Backend interview](./system-design-answer-backend.md): stock invariants, payment recovery and search projections.
- [Full-stack interview](./system-design-answer-fullstack.md): connecting those guarantees to the customer journey.
