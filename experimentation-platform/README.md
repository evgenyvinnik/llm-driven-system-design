# Design an Experimentation Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 12,430 |
| Source Files | 202 |
| .ts | 7,068 |
| .tsx | 2,668 |
| .md | 1,784 |
| .json | 341 |
| .sql | 211 |

## Overview

Feature flags and A/B experiments, end to end: a console to define them, deterministic assignment shared by the server and a JS SDK, versioned ruleset snapshots pushed to clients, a kill switch, render-time exposure logging, idempotent event ingest into ClickHouse, and an analysis page with confidence intervals, lift and a sample ratio mismatch check. ROADMAP entry 9, a practice extension aimed at growth-engineering roles; see [CLAUDE.md](./CLAUDE.md).

**The key question:** a user was assigned a treatment but never saw it. Is that an exposure? No. The SDK keeps the two apart: `useVariant()` / `evaluate()` record a diagnostic *assignment*, while `<Exposure>` logs an *exposure* only when the variant mounts (or scrolls into view), once per unit per experiment per config version. The analysis reads exposures only, and the results page shows both counts so you can see the dilution. In the demo, the Rewards-tab experiment assigns ~4,000 visitors and exposes ~480.

The interesting parts:

- **One evaluation module.** `sdk/src/core/` (MurmurHash3 into 10,000 buckets, ranges, targeting, evaluate) is imported by the SDK, the backend and the console. A parity test compares the hash with an independent BigInt implementation. The live e2e suite checks 900 (unit, flag) pairs: api-a, api-b and the SDK agree on all of them.
- **Stable ranges when weights change.** A 10% → 20% treatment ramp moves exactly 10% of units, all from control, and 0% of treatment goes back. The editor previews this before saving, next to the naive alternatives. Re-hashing would move ~26% and send ~80% of treatment back to control; re-partitioning from bucket 0 sends 100% of treatment to control on an enrolment ramp.
- **Anonymous → signed in.** The first anonymous id a user signs in from becomes their stable id (an identity alias). Visitors keep their variant at sign-in, and every later device converges on it. The e2e suite measured 0 of 300 signing-in visitors flipping; re-bucketing by user id would have flipped 51%.
- **Snapshots, not remote calls.**
  - The SDK evaluates locally from an immutable, versioned snapshot.
  - It revalidates with `If-None-Match` (304), gets `{version}` pushes over SSE from either API instance via Valkey pub/sub, and fetches that exact version.
  - It never blocks render: network → bootstrap → last known good in localStorage → safe coded defaults.
- **A kill switch measured end to end.** It went from the console on api-a to the SDK on api-b in p50 16-20 ms, max 28 ms (10 cycles × 3 runs). A lost pub/sub message is recovered by a 5 s reconcile loop (3.5-4.6 s measured). The live clients page shows each SDK's held version and how long the last update took to reach it.
- **Exactly counted, at-least-once delivered.**
  - Batch ids are deduped atomically with the enqueue (one Lua script).
  - The ingest worker inserts with `insert_deduplication_token`.
  - ReplacingMergeTree on `event_id` absorbs the rest.
  - The analysis uses only duplicate-insensitive aggregates.
  - Device clock skew is corrected per batch, and late events are included on the next read.
- **Honest analysis.**
  - Each unit counts from its first exposure, and a conversion counts only after it and within the attribution window.
  - Crossovers are excluded from rates; rates get Wilson intervals; the lift comes from a two-proportion z-test.
  - SRM uses the expected split *per config version*, so a ramp doesn't look broken.
  - A deliberately broken experiment trips SRM (p ≈ 10⁻¹¹) while its assignments stay balanced, which points straight at the logging bug.

![Results: exposed-only analysis with Wilson intervals and lift](./screenshots/05-results-lift.png)

| | |
|---|---|
| ![Editor: ramp preview with stable ranges vs naive strategies](./screenshots/04-ramp-preview.png) | ![SRM warning on the broken experiment](./screenshots/06-results-srm.png) |
| ![Live SDK clients and kill-switch propagation](./screenshots/08-live-clients.png) | ![Assigned vs exposed on a rarely opened tab](./screenshots/07-results-assigned-vs-exposed.png) |
| ![Storefront: exposure logged where the button renders](./screenshots/11-demo-product.png) | ![Storefront: broken treatment, assigned but never exposed](./screenshots/13-demo-cart-broken-exposure.png) |
| ![Storefront offline: starts from the cached snapshot](./screenshots/15-demo-offline-cached.png) | ![Storefront offline with no cache: coded defaults](./screenshots/16-demo-offline-defaults.png) |

## Architecture

```
console (React, polls) ──▶ api-a ── one txn: config v+1, history, audit, snapshot_version+1, compile ──▶ PostgreSQL
                              │ after commit: Valkey latest (forward-only) + PUBLISH {env, version}
                              ▼
               api-a ◀── Valkey pub/sub ──▶ api-b          (+ reconcile with PostgreSQL every 5 s)
                 │                            │
   SDK: GET /snapshot (ETag/304) · GET /snapshots/:v (immutable) · SSE hello/snapshot {version}
                 │                            │
   checkout-service (Node SDK)        storefront (browser SDK, demo-app) · traffic simulator (Node SDK)
                 └──────── POST /sdk/v1/events {batchId, sentAt, events} ────────┘
                                         │ Lua: SET NX batch id + XADD
                                         ▼
                         Valkey stream ──▶ ingest worker ── insert token ──▶ ClickHouse
                                                                                │
                              results: first exposure, window, Wilson, z-test, SRM ◀┘
```

| Process | Default port | Command |
|---------|--------------|---------|
| API instance A (console, SDK surface, storefront API) | 3000 | `npm run dev:a` |
| API instance B | 3001 | `npm run dev:b` |
| Ingest worker | 3100 (health, metrics) | `npm run dev:worker` |
| Admin console | 5173 (proxy → api-a) | `cd frontend && npm run dev` |
| Demo storefront | 5180 (proxy → api-b) | `cd demo-app && npm run dev` |
| Traffic simulator | n/a | `npm run simulate` |

`npm run dev` in `backend/` starts both API instances and the worker. Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, @clickhouse/client, zod, pino, prom-client, bcryptjs; vitest + supertest
- **SDK:** dependency-free TypeScript (browser and Node), optional React bindings; vitest + jsdom
- **Frontends:** React 19, Vite, TanStack Router (file routes), Zustand, Tailwind CSS (console and storefront)
- **Infrastructure:** PostgreSQL 16, Valkey 7 (AOF on), ClickHouse 24.8

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd experimentation-platform
docker-compose up -d               # PostgreSQL :5432, Valkey :6379, ClickHouse :8123/:9000 (experiments/experiments_password)

cd backend
npm install
npm run db:migrate                 # PostgreSQL init.sql + ClickHouse clickhouse-init.sql (idempotent)
npm run db:seed                    # users, dev/prod environments, 6 flags and experiments with a ramp and a kill in their history
npm run dev                        # api-a :3000, api-b :3001, ingest worker
npm run simulate                   # 4,000 virtual visitors through the SDK (≈ 2 s): significant lift, no effect, SRM

cd ../frontend && npm install && npm run dev     # console     http://localhost:5173
cd ../demo-app && npm install && npm run dev     # storefront  http://localhost:5180
```

The SDK needs no install for the apps (they compile it from `sdk/src`); run `cd sdk && npm install` to test or build it on its own.

Host ports are overridable: `EXP_PG_PORT=5452 EXP_VALKEY_PORT=6399 EXP_CH_HTTP_PORT=8133 EXP_CH_NATIVE_PORT=9031 docker-compose up -d`. Point the backend at them with `DATABASE_URL`, `REDIS_URL` and `CLICKHOUSE_URL`. Useful commands: `docker-compose down` stops the services, and `docker-compose down -v` also deletes the data.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey clickhouse      # or: brew install redis
brew services start postgresql@16
brew services start valkey                        # or: brew services start redis
clickhouse server --daemon                        # or run `clickhouse server` in its own terminal

# PostgreSQL role and database
psql postgres -c "CREATE ROLE experiments LOGIN PASSWORD 'experiments_password';"
psql postgres -c "CREATE DATABASE experimentation OWNER experiments;"

# ClickHouse user (the migration creates the database and tables)
clickhouse client --query "CREATE USER IF NOT EXISTS experiments IDENTIFIED BY 'experiments_password'"
clickhouse client --query "GRANT ALL ON *.* TO experiments"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                                   # PONG
curl -s localhost:8123/ping                       # Ok.
```

Turn on AOF in Valkey (`appendonly yes`) so accepted-but-not-yet-inserted events survive a restart. Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16`, `redis-server` (or `valkey`) and ClickHouse from its official repository.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://experiments:experiments_password@localhost:5432/experimentation` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB` | `http://localhost:8123`, `experiments`, `experiments_password`, `experimentation` | ClickHouse (HTTP) |
| `PORT`, `INSTANCE_ID` | `3000`, `api-<port>` | API port and name; `dev:a`/`dev:b` take `PORT_A`/`PORT_B` |
| `WORKER_PORT`, `WORKER_ID` | `3100`, `ingest-1` | Worker metrics port and consumer name |
| `SNAPSHOT_RECONCILE_MS` | `5000` | How often each instance checks PostgreSQL for a snapshot it missed |
| `SSE_HEARTBEAT_MS`, `CLIENT_TTL_SECONDS` | `15000`, `45` | Stream pings; live client view expiry |
| `INGEST_MAX_EVENTS`, `INGEST_BATCH_DEDUP_TTL_SECONDS`, `INGEST_MAX_EVENT_AGE_DAYS` | `500`, `86400`, `30` | Ingest limits and windows |
| `LATE_THRESHOLD_MS` | `3600000` | An event is "late" when it arrives this long after it happened |
| `SHOP_ENVIRONMENT`, `SHOP_ASSET_DELAY_MS` | `prod`, `3500` | Storefront environment; the slow image behind the deliberately broken banner |
| `VITE_PORT`, `API_TARGET` (console) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |
| `VITE_PORT`, `API_TARGET`, `VITE_CLIENT_KEY` (storefront) | `5180`, `http://localhost:3001`, prod client key | Dev server, proxy target, SDK key |

## Demo accounts

All passwords are `password123`.

| User | Where | Can |
|------|-------|-----|
| `alice` | Console | Admin: create, edit weights and targeting, change status, pull the kill switch |
| `maya` | Console | Admin (growth PM in the seeded history) |
| `bob` | Console | Viewer: sees everything, every control disabled, writes rejected with 403 |
| `carol`, `dave`, `erin` | Storefront | Shoppers (US free, CA pro, DE free) for sign-in and targeting |

Local-only SDK keys: `cli_prod_4f9a2c7e1b3d5a60` / `srv_prod_9e4a7c2f5b1d3e86`, `cli_dev_7d2e91c4a5b3f608` / `srv_dev_1c8b5e3a9f2d4e70`. Client keys are public by design; server keys are not.

## Things to try

- **Results:** after `npm run simulate`, open `checkout_cta` → Results. The treatment lift is significant among exposed units and diluted among everyone assigned. Then open `shipping_banner` (SRM warning) and `rewards_teaser` (assigned ≫ exposed).
- **Ramp preview:** on `checkout_cta`, type new weights. The bars and the "moves N% of units" line update before you save, next to what re-partitioning and re-hashing would do.
- **Kill switch:** open the storefront and the console's *Live SDK clients* page side by side. Pull the kill switch on `checkout_cta`, and the product page's button flips to "Add to cart". The client row shows the new version and how many milliseconds it took.
- **Assigned but not exposed:** in the storefront's inspector, every experiment shows "no (assigned)" until its surface renders. Open a product and `checkout_cta` turns to "yes". Open the Rewards tab and `rewards_teaser` turns to "yes". In the cart, the broken `shipping_banner` treatment stays "no (assigned)" until its slow image loads.
- **Sign in:** sign in as carol and the stable id stays this browser's anonymous id, so no variant changes. Sign in from a second browser: it adopts the first browser's id.
- **Offline:** use "Reload offline" in the inspector to start from the cached snapshot. "Clear SDK cache" (while offline) starts on coded defaults instead.

## API

```bash
# Snapshot with revalidation
curl -i -H 'X-Client-Key: cli_prod_4f9a2c7e1b3d5a60' localhost:3001/sdk/v1/snapshot                          # 200, ETag: "prod-v18"
curl -i -H 'X-Client-Key: cli_prod_4f9a2c7e1b3d5a60' -H 'If-None-Match: "prod-v18"' localhost:3001/sdk/v1/snapshot   # 304

# Server-side evaluation (same core as the SDK); a user id resolves to its stable id
curl -H 'X-Server-Key: srv_prod_9e4a7c2f5b1d3e86' -H 'Content-Type: application/json' \
  -d '{"context":{"stableId":"visitor-42","attributes":{"country":"US"}},"keys":["checkout_cta"]}' localhost:3001/sdk/v1/evaluate

# Ramp (If-Match = the config version you started from; stale → 409)
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login
curl -b jar -X PUT -H 'Content-Type: application/json' -H 'If-Match: "5"' \
  -d '{"weights":{"control":4000,"treatment":6000}}' localhost:3000/api/v1/flags/checkout_cta/environments/prod

# Kill switch (experiment → stopped, flag → paused)
curl -b jar -X POST -H 'Content-Type: application/json' -d '{"reason":"checkout errors"}' localhost:3000/api/v1/flags/checkout_cta/environments/prod/kill
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
cd backend  && npm run type-check && npm run lint && npm test && npm run build   # 40 tests: stats, SRM, analysis, allocation via core, compile, flag model, ingest batches, parity, API routes
cd sdk      && npm run type-check && npm run lint && npm test && npm run build   # 40 tests: hash vectors, stable ranges vs naive, evaluation, client (offline, ETag, push, dedup, retries, beacon), React exposure
cd frontend && npm run type-check && npm run lint && npm run build
cd demo-app && npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (repository root, stack running, after `npm run simulate`)
node scripts/screenshots.mjs experimentation-platform          # console screens 01-10
cd experimentation-platform/backend && npx tsx ../tests/demo-screenshots.mts   # storefront screens 11-16 (DEMO_URL)
npm run test:smoke experimentation-platform
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs, failure handling and implementation notes
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [CLAUDE.md](./CLAUDE.md): signal, development phases, decisions, repair log, open questions
