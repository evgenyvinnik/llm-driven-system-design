# Design a Freight Quote Service

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,981 |
| Source Files | 156 |
| .ts | 7,775 |
| .tsx | 1,942 |
| .md | 1,670 |
| .sql | 211 |
| .json | 185 |

## Overview

A freight rate inquiry service for carload rail: a shipper asks what it costs to move N cars of a commodity from A to B, and the price depends on four slow internal services (tariff and contract pricing, the weekly fuel surcharge, network capacity, car availability). The endpoint always answers within its deadline, and is honest about what it knows:

- **Firm or indicative.** When every input is confirmed, the quote is firm (`201`), pinned to the exact tariff or contract version, fuel week and snapshots it used, and bookable for 24 hours. When capacity or car supply is too slow, the quote is indicative (`202`): an estimate with a price band, each component labeled with its source and age, and the firm quote follows asynchronously by polling or a signed webhook.
- **A request path that can't be held hostage.** One propagated deadline with a budget per dependency, hedged requests to the slow-tail dependency (with a budget), a circuit breaker per dependency (opossum), single-flight coalescing of identical in-flight calls, load shedding by client class (re-quoting integrations first, people last) and per-customer rate limits.
- **Caching that's correct, not merely recent.** Tariffs and surcharges are cached under versioned keys and invalidated by events through monotonic version floors. Contract prices are keyed by contract id, resolved on the server, so they can never reach another customer.
- **An event-driven side.** A transactional outbox in PostgreSQL feeds partitioned Valkey Streams (standing in for Kafka). Idempotent consumers complete firm quotes (with retries, a DLQ and redrive), deliver signed callbacks at least once, invalidate caches and re-price open indicative quotes when a tariff is published, and build an analytics projection that replays from position 0. `QuoteIssued` evolved from v1 to v2 with an upcaster.
- **A coding exercise.** The reported screen began with implementing the quote service layer, so [coding-exercise.md](./coding-exercise.md) is a 45-minute practice brief with a stub, a 19-test suite and a reference solution.

Read [architecture.md](./architecture.md) for the design, [events.md](./events.md) for the event catalog, and [CLAUDE.md](./CLAUDE.md) for the interview signal, how it was built and what broke along the way. Interview answers: [backend](./system-design-answer-backend.md), [full-stack](./system-design-answer-fullstack.md), [frontend](./system-design-answer-frontend.md).

## Architecture

```
portal / API clients ──▶ Quote API (:3000) ──fan-out under one deadline──▶ mock dependencies (:3010)
                          │  admit · idempotency · breakers · hedge · single-flight      pricing · fuel · capacity · availability
                          │  component cache, floors, rate limits ──▶ Valkey                    │ TariffPublished / FuelSurchargeChanged
                          ▼                                                                    ▼
                    PostgreSQL: quotes + events (outbox) ──relay──▶ fq:events:p0..p3      fq:ext:pricing
                                                                       │        │          │
                                       completer (:3011) ◀─────────────┤        │          └──▶ invalidator (in completer)
                                       firm quotes, retries, DLQ        │        └──▶ projector (:3012) analytics
                                       webhooks ──signed──▶ receiver (:3020)
```

| Process | Path | Role |
|---------|------|------|
| Quote API | `backend/src/api/` | The synchronous path, ops/streams/analytics endpoints, outbox relay |
| Mock dependencies | `backend/src/deps/` | Four services with latency/failure/capacity knobs; the pricing system's publications |
| Completer | `backend/src/completer/` | Firm completion, webhooks, cache invalidation and re-pricing, expiry |
| Projector | `backend/src/projector/` | Analytics projection and replay |
| Receiver | `backend/src/receiver/` | A mock customer webhook endpoint (signature check, dedupe, fault knob) |
| Shared | `backend/src/shared/` | Events and upcasters, event store, streams and consumer framework, fan-out, composer, cache, breakers |
| Practice | `backend/src/practice/` | Coding exercise: types, starter, attempt, reference, suite |
| Frontend | `frontend/src/` | Portal, quote timeline, ops console, event log, streams/DLQ, analytics |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS, hand-written SVG chart
- **Backend:** Node.js, Express, TypeScript (tsx), zod, pg, ioredis, opossum, Pino, prom-client, bcryptjs
- **Data:** PostgreSQL 16 (quotes, outbox/event log, projections), Valkey 7 (Streams with consumer groups, cache, rate limits, settings, sessions)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (Option A), or PostgreSQL 16 and Valkey/Redis 7 installed natively (Option B)

### Option A: Docker Compose (recommended)

```bash
cd freight-quote
docker-compose up -d            # PostgreSQL 16 on 5432, Valkey 7 on 6379

cd backend
npm install
npm run db:migrate
npm run db:seed                 # rerunnable: wipes tables and fq:* keys; reseeds users and ~3 days of history
npm run dev                     # API :3000, deps :3010, completer :3011, projector :3012, receiver :3020

# new terminal
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Useful compose commands: `docker-compose down` (stop), `docker-compose down -v` (stop and delete data).

### Option B: Native installation (no Docker)

```bash
# macOS (Homebrew)
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey            # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE freight LOGIN PASSWORD 'freight_password';"
psql postgres -c "CREATE DATABASE freight_quote OWNER freight;"

# Verify
psql postgresql://freight:freight_password@localhost:5432/freight_quote -c "select 1"
valkey-cli ping                       # or: redis-cli ping
```

Then run the backend and frontend steps from Option A.

### Environment variables

All have local defaults; override to run on other ports.

```bash
DATABASE_URL=postgresql://freight:freight_password@localhost:5432/freight_quote
REDIS_URL=redis://localhost:6379
PORT=3000                 # quote API
DEPS_PORT=3010            DEPS_URL=http://localhost:3010
COMPLETER_PORT=3011
PROJECTOR_PORT=3012
RECEIVER_PORT=3020        RECEIVER_URL=http://localhost:3020   # seeded as the customers' webhook base URL
INSTANCE_ID=api-3000      # per API instance (ops page, breaker events)
COMPLETER_CONSUMER=completer-1
# frontend: VITE_PORT=5173 API_URL=http://localhost:3000
```

### Demo users (password `password123`)

| User | Role | Notes |
|------|------|-------|
| `pat` | Customer, Prairie Grain Co-op | Contract `CTR-PGC-2026` on KCK→CHI and MSP→PDX grain; webhook registered |
| `nina` | Customer, Northline Lumber | Public tariff pricing |
| `omar` | Ops | Ops page, knobs, streams, DLQ, verify replay |
| `ada` | Admin | Everything, plus publishing tariffs and fuel surcharges and rebuilding projections |

API keys for integrations (development only): `fq_dev_gpx_7d1c4e` (Gulf Plastics Exchange, contract on HOU→CHI plastics) and `fq_dev_sfl_93ab20` (Summit Freight Logistics).

```bash
curl -s localhost:3000/api/v1/quotes -H 'content-type: application/json' \
  -H 'X-Api-Key: fq_dev_gpx_7d1c4e' -H 'Idempotency-Key: gpx-demo-0001' \
  -d '{"origin":"HOU","destination":"CHI","commodity":"PLASTIC","equipment":"COVERED_HOPPER","quantity":12,"shipWeek":"2026-11-23"}'
```

## Things to Try

1. **Indicative → firm.** Sign in as `ada`, open Operations, set Network capacity to "Slow (2.5 s)". Sign in as `pat` in another window and request a quote: `202`, an indicative card with the capacity row labeled, then Firm a few seconds later. Open "Details & timeline".
2. **p99 → 8 s with hedging.** Apply the "p99 → 8 s" preset to capacity and watch hedges fire and win on the capacity card while its p99 stays near the budget. Toggle hedging off to compare.
3. **Breaker.** Set Car availability to "50% errors" or "Down" and send traffic; the circuit opens, quotes become indicative instantly, and `DependencyCircuitOpened` appears in the event log.
4. **Re-pricing.** With capacity down, request a tariff-priced quote (`nina`, PDX→LAX lumber), then publish that tariff as `ada`. The open indicative quote gets revision 2; the timeline shows the cause.
5. **DLQ and redrive.** Leave capacity down for ~15 s: the completer's retries (1, 2, 4, 8 s) exhaust and the quote shows "firm delayed". Restore capacity and click Redrive on Streams & DLQ.
6. **Poison message.** "Inject poison" on Streams & DLQ: dead-lettered on the first delivery, with the reason.
7. **Duplicate and late events.** As `ada`, `GET /api/v1/ops/pricing/events`, then `POST /api/v1/ops/pricing/events/<id>/resend` (duplicate → no-op), and publish an older version with `{"version": 7}` (late → recorded, not applied).
8. **Crash between commit and ack.** Start a completer with `CRASH_BEFORE_ACK_ONCE=1`, get an indicative quote, watch it exit after committing, restart it: the message is reclaimed and nothing is done twice.
9. **Replay.** `npm run replay -- analytics` (rebuild from position 0, then verify) or `npm run replay -- analytics --verify`.
10. **Webhook retries.** Streams & DLQ → "Receiver: fail next 3", then request a quote with the webhook option; watch attempts climb and the receiver keep it once.

## Load Testing

```bash
cd backend
npm run load -- hedging       # capacity with a 5% slow tail: p99 with hedging off vs on
npm run load -- coalescing    # bursts of identical requests vs a 4-worker capacity service
npm run load -- storm         # 60 integrations re-quoting with no backoff vs 2 portal users
npm run load -- all
```

It changes settings and knobs through the ops API and restores defaults afterwards. One run's results are in [architecture.md](./architecture.md#load-test-results-local-one-api-instance): p99 1,606 → 200 ms with hedging; 10% → 100% firm with coalescing; portal firm 13% → 63% with shedding → 100% with shedding plus rate limits.

## Coding Practice

```bash
cd backend
npm run practice:reset        # restore the stub in src/practice/attempt/quote-service.ts
npm run practice              # run the 19-test suite against your attempt
npm run practice:watch
```

Brief, hint ladder and grading notes: [coding-exercise.md](./coding-exercise.md). The reference solution is `src/practice/reference/quote-service.ts`; `npm test` runs the suite against it.

## Scripts

| Command (backend/) | What it does |
|--------------------|--------------|
| `npm run dev` | All five processes with hot reload |
| `npm run dev:server1` / `dev:server2` | Extra API instances on 3001 / 3002 (one relay leader) |
| `npm run dev:worker1` / `dev:worker2` | Two completers sharing the consumer groups |
| `npm run db:migrate` / `db:seed` | Apply `src/db/init.sql` / reseed |
| `npm run replay -- analytics [--verify]` | Rebuild or verify the analytics projection from position 0 |
| `npm run load -- <scenario>` | Load scenarios |
| `npm test` · `npm run type-check` · `npm run lint` | Vitest (65 tests, including the practice suite against the reference), tsc, eslint |

Frontend: `npm run dev`, `npm run build`, `npm run type-check`, `npm run lint`. Smoke tests (stack running): `npm run test:smoke freight-quote` from the repo root, or `npx playwright test` here.

## Screenshots

| | |
|-|-|
| ![Login](screenshots/01-login.png) | ![Indicative quote](screenshots/02-portal-indicative.png) |
| ![Firm quote](screenshots/03-portal-firm.png) | ![Quote timeline](screenshots/04-quote-timeline.png) |
| ![Operations](screenshots/05-ops.png) | ![Event log with upcast v1 events](screenshots/06-event-log.png) |
| ![Streams and DLQ](screenshots/07-streams-dlq.png) | ![Analytics](screenshots/08-analytics.png) |
