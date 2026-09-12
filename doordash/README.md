# DoorDash: food delivery coordination

A local learning project for a three-sided delivery marketplace: customers browse and order, restaurant owners advance preparation, and drivers receive assignments and report delivery. The useful design problems are coordinating those views, matching nearby drivers, estimating arrival time, and deciding which updates require durable consistency.

This is an independent teaching implementation, not DoorDash's production architecture. Read [architecture.md](./architecture.md) for the proposed production design and an exact account of the current implementation. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers explain a proposed design in a 45-minute interview format.

## What the application contains

| Surface | Implemented behavior | Current limits |
|---------|----------------------|----------------|
| Customer | Search by restaurant name, filter cuisine, view categorized menus, persist a single-restaurant cart, place orders, view history and status, cancel a placed order | Checkout generates random San Francisco coordinates; tracking shows coordinate text, not a map; history displays the first page |
| Restaurant | Select an owned restaurant, view active orders, confirm, start preparation, mark ready | Menu management is a placeholder; the open/closed toggle sends `is_open`, while the API expects `isOpen`, so it does not change the flag |
| Driver | Location reporting through browser geolocation, availability toggle, assigned orders, pickup/delivery controls, fee/tip statistics | Stats return camelCase profile fields while the UI reads snake_case; preparation updates do not reach its subscribed driver channel; background tracking is not provided |
| Backend | Session authentication, restaurant/menu CRUD, order routes, heuristic matching and ETA, local WebSocket broadcasts, Kafka producers, audit rows, metrics and health endpoints | No payment processing, dispatch offers, durable retry worker, replayable socket stream, reviews API, or separate admin interface |

The project demonstrates these mechanisms, but it does **not** currently guarantee atomic checkout, exclusive driver assignment, safe status transitions under concurrency, or authorized WebSocket subscriptions. Important source findings are collected in [Implementation Notes](./architecture.md#implementation-notes). Use synthetic data on a local machine.

## Stack and processes

- **Frontend:** React 19, TypeScript, Vite 6, TanStack Router, Zustand, Tailwind CSS.
- **Backend:** one Express 4/TypeScript process, `ws`, PostgreSQL via `pg`, node-redis, KafkaJS, Opossum, Pino, and `prom-client`.
- **Compose infrastructure:** PostgreSQL 16, Valkey 7 with AOF, and Confluent Kafka/ZooKeeper 7.5.0. PostgreSQL and Valkey have named volumes; Kafka and ZooKeeper have no configured data volumes.

Node.js **20 or newer** and npm are required. Infrastructure runs separately from the two application processes. Choose one infrastructure option; both use the same host ports.

## Option A: Docker Compose (recommended)

Run from this project's directory (`doordash/`):

```bash
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U doordash -d doordash
docker compose exec -T redis redis-cli ping
docker compose exec -T kafka kafka-topics --bootstrap-server localhost:9092 --list
```

Wait for the services to become healthy. Compose mounts [backend/src/db/init.sql](./backend/src/db/init.sql), which creates the schema **only when PostgreSQL initializes an empty data directory**. It does not load sample data. On a fresh schema, seed once:

```bash
docker compose exec -T postgres psql -U doordash -d doordash -v ON_ERROR_STOP=1 --single-transaction < backend/db-seed/seed.sql
```

The seed assumes fresh serial IDs for its users, restaurants, and driver. Its initial inserts are not repeatable; running it against an existing database can fail or associate records incorrectly. Inspect existing data before reseeding. There is no `db:migrate` or `db:seed` npm script.

To stop infrastructure while retaining PostgreSQL and Valkey volumes:

```bash
docker compose down
```

For an intentional reset of this project's development data, `docker compose down -v` removes those volumes. Kafka/ZooKeeper state is not protected by named volumes even with ordinary `down`.

## Option B: Native installation on macOS (no Docker)

Homebrew supplies [PostgreSQL 16](https://formulae.brew.sh/formula/postgresql@16), [Valkey](https://formulae.brew.sh/formula/valkey), and [Kafka](https://formulae.brew.sh/formula/kafka). Current Homebrew Kafka uses KRaft and initializes its local storage during installation; this differs from the ZooKeeper-based Compose setup. See the [formula's installation and service configuration](https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/k/kafka.rb). Native versions are not pinned to the Compose images.

```bash
brew install postgresql@16 valkey kafka
brew services start postgresql@16
brew services start valkey
brew services start kafka
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
pg_isready -h localhost -p 5432
valkey-cli ping
kafka-topics --bootstrap-server localhost:9092 --list
```

On a fresh local PostgreSQL cluster, create the application role and database. Use `doordash_dev` at the password prompt to match the development defaults:

```bash
createuser --pwprompt doordash
createdb --owner=doordash doordash
PGPASSWORD=doordash_dev psql -h localhost -U doordash -d doordash -v ON_ERROR_STOP=1 --single-transaction -f backend/src/db/init.sql
PGPASSWORD=doordash_dev psql -h localhost -U doordash -d doordash -v ON_ERROR_STOP=1 --single-transaction -f backend/db-seed/seed.sql
```

If the role/database already exist, inspect them rather than rerunning creation blindly. These schema and seed commands are for an empty project database. Kafka can auto-create the three producer topics; an explicit local setup is:

```bash
for topic in order-events location-updates dispatch-events; do
  kafka-topics --bootstrap-server localhost:9092 --create --if-not-exists --topic "$topic" --partitions 1 --replication-factor 1
done
```

Stop native services with `brew services stop kafka`, `brew services stop valkey`, and `brew services stop postgresql@16` when finished. The application can serve orders without Kafka, but publications made while the producer is unavailable are lost.

## Start the application

From `doordash/`, start the API in one terminal:

```bash
cd backend
npm install
npm run dev
```

In another terminal, also starting in `doordash/`:

```bash
cd frontend
npm install
npm run dev
```

Open [the application](http://localhost:5173). Vite proxies `/api` and `/ws` to port 3000. Redis must be reachable before the backend starts because its module awaits the connection. The backend does not load `.env` files; export variables in its shell when changing defaults.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP and WebSocket server |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed HTTP CORS origin |
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` | PostgreSQL server |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `doordash`, `doordash_dev`, `doordash` | PostgreSQL credentials/database |
| `REDIS_URL` | `redis://localhost:6379` | Valkey connection; no local password |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated broker addresses |
| `KAFKA_CLIENT_ID` | `doordash-api` | Producer client ID |
| `LOG_LEVEL`, `SERVICE_NAME`, `APP_VERSION` | `info`, `doordash-api`, `dev` | Pino configuration |

The database module reads the `DB_*` variables above, not `DATABASE_URL`. Kafka's Compose listener advertises `localhost:9092` for host-based clients; it is not an application-container networking configuration.

## Demo accounts and walkthrough

All four seeded accounts use **`password123`**; the bcrypt hash was verified against that password during the documentation review.

| Email | Role | Seeded resources |
|-------|------|------------------|
| `customer@example.com` | Customer | One sample order |
| `restaurant@example.com` | Restaurant owner | Five restaurants, 25 menu items |
| `driver@example.com` | Driver | One profile with a stored San Francisco location |
| `admin@example.com` | Admin | Role-based API privileges, no separate admin UI |

Use separate browser profiles for the three personas because they otherwise share a session cookie and persisted stores. Browse a restaurant, add enough items to meet its minimum, and place a customer order. Its address text is retained, but checkout creates random nearby coordinates rather than geocoding it. No card is charged.

The restaurant owner can advance an order through confirmed, preparing, and ready for pickup. Matching runs once during confirmation. A driver needs a fresh location within 5 km of the restaurant; browser permission and the actual device location affect the demo. If no candidate is found, there is no automatic rematching job. A fresh Redis database has an empty geo set even though SQL contains the seeded driver; an empty geo result does not trigger the SQL fallback.

The driver dashboard receives assignment events, but subsequent restaurant status broadcasts omit its driver channel. Reload it to see the current state before pickup. Reloading also exposes the stats field-name mismatch: the online indicator may not reflect SQL availability. Toggling online sets availability even for an assigned driver, so it is not a safe repair for dispatch state.

The pre-existing sample order is a **display fixture**, not a valid completed checkout: it is `PREPARING` at Burger Barn with an assigned driver still flagged available, an address shaped as street/city/state/zip rather than address/lat/lon, and totals inconsistent with its three line items. It has no ETA. Do not use it as proof that delivery calculations or financial totals work.

Registration alone does not create a driver profile. `POST /api/auth/become-driver` creates a profile for the current user but does not change their role; the dashboard requires role `driver`. The seeded driver avoids this onboarding gap.

## Verification and useful commands

Backend checks, from `backend/`:

```bash
npm run type-check
npm run build
npm run lint
```

Frontend checks, from `frontend/`:

```bash
npm run type-check
npm run build
npm run lint
```

Readiness and metrics, with the backend running:

```bash
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/health/ready
curl -fsS http://localhost:3000/health/live
curl -fsS http://localhost:3000/metrics
```

Readiness checks PostgreSQL and Redis, not successful Kafka delivery or WebSocket authorization. Metrics are per process and several business gauges drift; they are not authoritative order counts.

The project-root `npm run test:e2e` launches Playwright and can start Vite, but not the backend/infrastructure. [tests/smoke.spec.ts](./tests/smoke.spec.ts) uses `alice@example.com`, which the seed does not create, and asserts broad page visibility rather than a complete order journey. The repository's [screenshot configuration](../scripts/screenshot-configs/doordash.json) uses the actual seeded customer/driver/owner accounts; run `node scripts/screenshots.mjs --start doordash` from the repository root for that automation. Captured pages still do not establish transactional correctness.

Backend `dev:server1`, `dev:server2`, and `dev:server3` scripts use ports 3001–3003. There is no load balancer or cross-instance WebSocket relay, and Vite still targets 3000. Multiple processes illustrate those missing coordination boundaries; they are not a working horizontal deployment.

This documentation review traced source/configuration and ran isolated checks with mocked dependencies. It did not start the complete stack, run the builds, or claim a passing end-to-end delivery test.

## Source guide

| Area | Entry point |
|------|-------------|
| API setup and probes | [backend/src/index.ts](./backend/src/index.ts) |
| Schema and fixtures | [init.sql](./backend/src/db/init.sql), [seed.sql](./backend/db-seed/seed.sql) |
| Checkout, transitions, assignment | [order routes](./backend/src/routes/orders/index.ts) |
| Driver actions and location | [drivers.ts](./backend/src/routes/drivers.ts) |
| ETA | [geo.ts](./backend/src/utils/geo.ts) |
| Retry response cache | [idempotency.ts](./backend/src/shared/idempotency.ts) |
| Broadcast transport | [websocket.ts](./backend/src/websocket.ts), [useWebSocket.ts](./frontend/src/hooks/useWebSocket.ts) |
| Frontend API and cart | [api.ts](./frontend/src/services/api.ts), [cartStore.ts](./frontend/src/stores/cartStore.ts) |

[CLAUDE.md](./CLAUDE.md) contains historical collaboration notes; implementation claims there should be read alongside the source findings in the architecture.
