# Bitly: URL shortening and click analytics

A local learning project for creating short links, resolving them through a cache, and processing click events in a separate worker. It includes a React dashboard and administrative controls. It is an independent implementation, not a description of Bitly's private infrastructure.

The useful system-design questions are who owns the short-code namespace, how expiration interacts with caching, and what an analytics count actually guarantees. The implementation demonstrates these paths but has correctness gaps described below and in [architecture.md](./architecture.md#implementation-notes).

## What you can try

- Create a link anonymously or while signed in, with an optional custom code and expiration in days. Anonymous links have no account management or later claim flow.
- Open the returned backend URL to receive a 302 redirect. The frontend is not involved in resolving short links.
- Sign in to view your links, copy them, request deletion, and open basic click totals, daily activity, referrers, and device breakdowns.
- Use an administrator account to inspect system statistics, search links, toggle their active flag, change user roles, and add keys to the pool. The user and link views fetch at most 50 rows and have no pagination controls.

The UI uses simple tables and bars. There is no live analytics subscription, alias-availability check, target editor, QR-code flow, offline mode, or production abuse-scanning system.

## Stack and documents

| Layer | Checked-in implementation |
|-------|---------------------------|
| Browser | React 18, TypeScript, Vite 5, TanStack Router, Zustand 4, Tailwind CSS |
| API | Node.js 20+, Express 4, TypeScript through tsx in development |
| Data | PostgreSQL 16; Valkey 7 for mapping and session caches |
| Analytics | RabbitMQ and a separate Node worker; individual SQL writes |
| Operations | Pino, prom-client, Opossum database breaker, health endpoints |

The backend package does not declare ESM; its NodeNext TypeScript build currently emits CommonJS. Source imports still use `.js` suffixes.

Read the [architecture](./architecture.md) for production proposals and their local mapping. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers are separate 45-minute interview discussions. [CLAUDE.md](./CLAUDE.md) records historical work; current source takes precedence over historical claims.

## Infrastructure

Start in the repository root and choose one infrastructure option below. Its first command enters `bitly`; run subsequent setup commands there unless another directory is stated. Stop other projects that occupy ports 5432, 6379, 5672, or 15672.

### Option A: Docker Compose (recommended)

```bash
cd bitly
docker compose up -d
docker compose ps
```

PostgreSQL runs [src/db/init.sql](./backend/src/db/init.sql) when its data volume is first created. It creates five tables and approximately 10,000 pool keys, but no login accounts. An existing volume does not rerun initialization automatically. There is no `db:migrate` package script.

| Service | Connection | Development credentials |
|---------|------------|-------------------------|
| PostgreSQL | localhost:5432, database bitly | bitly / bitly_password |
| Valkey | localhost:6379 | No authentication |
| RabbitMQ | localhost:5672 | guest / guest |
| Broker management | [localhost:15672](http://localhost:15672) | guest / guest |

Valkey enables append-only persistence. RabbitMQ has no persistent volume in this Compose file: queue data is not retained across ordinary container replacement.

```bash
docker compose down
# Also delete PostgreSQL and Valkey data when intentionally resetting this demo:
docker compose down -v
```

### Option B: Native installation on macOS

```bash
cd bitly
brew install postgresql@16 valkey rabbitmq
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
psql postgres -c "CREATE USER bitly WITH PASSWORD 'bitly_password';"
createdb -O bitly bitly
PGPASSWORD=bitly_password psql -h localhost -U bitly -d bitly -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
pg_isready -h localhost -p 5432
valkey-cli ping
rabbitmq-diagnostics -q ping
```

These native commands assume the current macOS account can administer the Homebrew PostgreSQL instance. Skip role/database creation if those objects already exist. The schema can be reapplied, but each execution also attempts to add 10,000 more pool keys. The native [Homebrew RabbitMQ formula](https://formulae.brew.sh/formula/rabbitmq) currently installs a newer major version than the Compose image. Its local default guest account works over loopback; the application declares the `click-events` queue when it connects.

### Optional sample data

The [SQL fixture](./backend/db-seed/seed.sql) adds three accounts, nine links, and 1,146 randomized click events. Use it once on a fresh schema.

Docker:

```bash
docker compose exec -T postgres psql -U bitly -d bitly -v ON_ERROR_STOP=1 < backend/db-seed/seed.sql
```

Native:

```bash
PGPASSWORD=bitly_password psql -h localhost -U bitly -d bitly -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
```

Alice (`alice@example.com`) and Bob (`bob@example.com`) use `password123`. The fixture's administrator hash does **not** match the formerly documented `admin123`; it also does not match `password123`. These comparisons were checked with bcrypt in isolation. Initialization itself creates no administrator.

For a local administrator, first run the fixture and install backend dependencies as below, then run this explicit password reset from `bitly/backend`. It updates only the fixture's `admin@bitly.local` account and prints the affected row count:

```bash
node <<'NODE'
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'bitly',
  user: process.env.DB_USER || 'bitly',
  password: process.env.DB_PASSWORD || 'bitly_password',
});
(async () => {
  try {
    const hash = await bcrypt.hash('password123', 10);
    const result = await pool.query(
      "UPDATE users SET password_hash = $1 WHERE email = 'admin@bitly.local'",
      [hash],
    );
    console.log(`Updated ${result.rowCount} local administrator account(s)`);
  } finally { await pool.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
```

After one updated row, the administrator password is `password123`. Rerunning the fixture retains existing users and URLs but appends another 1,146 click events without increasing the preset URL counters. It is not an idempotent analytics seed.

## Run the application

Start infrastructure first. Use separate terminals for API, worker, and frontend.

API, from `bitly`:

```bash
cd backend
npm install
npm run dev
```

Worker, from `bitly`:

```bash
cd backend
npm run dev:worker
```

Frontend, from `bitly`:

```bash
cd frontend
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). The API listens on port 3000, and Vite proxies `/api` there. Generated short URLs point directly to port 3000. Registration is available if you skipped the fixture; use the seeded Alice account for the existing smoke tests.

The API can start without RabbitMQ and attempts click writes after the response when no queue connection exists. Use the worker for the normal queued path. This fallback is best effort and does not make analytics lossless.

### Environment variables

Configuration reads exported environment variables; there is no `.env` loader. Defaults match Compose:

```bash
export DB_HOST=localhost DB_PORT=5432 DB_NAME=bitly
export DB_USER=bitly DB_PASSWORD=bitly_password
export REDIS_HOST=localhost REDIS_PORT=6379
export RABBITMQ_URL=amqp://guest:guest@localhost:5672
export PORT=3000 HOST=0.0.0.0 BASE_URL=http://localhost:3000
export CORS_ORIGIN=http://localhost:5173
export NODE_ENV=development
```

`SERVER_ID` defaults to `server-<process ID>` and labels allocated pool keys. `NODE_ENV=production` enables secure session cookies, requiring HTTPS for browser login. Production builds alone do not set this variable.

To study multiple API processes, run `dev:server1`, `dev:server2`, and `dev:server3` in separate backend terminals. They listen on 3001–3003 and share the databases. **Set `BASE_URL` explicitly**: changing `PORT` does not change returned short URLs. A common public address requires a separately configured load balancer; none is included, and Vite still targets 3000. Worker variants `dev:worker1` and `dev:worker2` compete on the same queue.

## Verify the local setup

```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/ready
curl -s http://localhost:3000/health/detailed
curl -s http://localhost:3000/metrics
curl -s -X POST http://localhost:3000/api/v1/urls \
  -H 'Content-Type: application/json' \
  -d '{"long_url":"https://example.com"}'
```

Request the returned `short_url` with `curl -i` to inspect its 302 and `Location` header without following the target. Open an owned link's analytics after a redirect to exercise the worker. Queue reconnection currently does not reattach a consumer; restart the worker after a broker interruption.

Both backend and frontend provide `npm run build`, `npm run type-check`, and `npm run lint`. The backend has no unit-test script. From the repository root, `npm run test:smoke bitly` runs four Playwright page checks against a running backend and seeded Alice account. Its admin check logs in as Alice and accepts a rendered `main` after redirection; it does not establish administrator access. Page smoke checks do not verify cache invalidation or analytics recovery.

## Important implementation limits

- Cached mappings contain only the destination for 24 hours. They bypass expiration and active-status checks. Owner deletion invalidates the cache, but expiration edits and administrator changes do not consistently do so; a concurrent old lookup can also refill a deleted entry.
- The UI/API accept custom codes of 4–20 characters, but the database accepts at most 10. Use 4–10 and avoid `metrics` and `ready`, which collide with backend routes. The configured 365-day default expiration is unused; omission means no expiration.
- The creation-specific limiter and idempotency middleware are mounted after the creation handler and do not protect ordinary creation requests. Only the general, per-process 200 API requests/minute limiter is active.
- Queued clicks can be lost or counted more than once. There are no publisher confirms, event IDs, deduplication, transactional event-plus-counter writes, or restored consumers after reconnect.
- Analytics endpoints require login but do not check link ownership, including the raw event endpoint. Anonymous detail lookups can expose inactive or expired mappings. This is not a private analytics deployment.
- Deletion is a soft update. The owner's list still includes inactive rows and omits their status, so a deleted row can reappear after reload. Cached auth and outstanding browser requests also have incomplete expiry, logout, and account-change handling.

The documentation review checked source, configuration, seed hashes, and document structure. It did not start this application's infrastructure, run its browser suite, or measure production targets. See [Implementation Notes](./architecture.md#implementation-notes) for the precise behavior behind these limits.
