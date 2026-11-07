# Design a Webhook Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 9,030 |
| Source Files | 136 |
| .ts | 5,164 |
| .md | 1,704 |
| .tsx | 1,600 |
| .json | 180 |
| .sql | 163 |

## Overview

Customers register callback URLs, and the platform sends them signed HTTP notifications when events occur. It retries failures with backoff, keeps every attempt and supports replay. The payment-system and stripe projects deliver webhooks as one component; here delivery is the whole product. It answers a webhook-platform prompt attributed to OpenAI (community attribution, not verified); see [CLAUDE.md](./CLAUDE.md).

The interesting parts:

- **At-least-once, said out loud.** Every attempt carries a stable `Webhook-Id` (the event id). The bundled mock receiver dedupes on it. The demo shows both lost-ack paths: a receiver that processes and drops the connection, and a worker killed mid-request. Each produces a retry the receiver flags as a duplicate. Nothing here claims exactly-once.
- **Nothing lost between components.**
  - The emit is one PostgreSQL transaction (event + one delivery per matching endpoint + outbox rows), idempotent on `Idempotency-Key`.
  - A publisher relays the outbox to a RabbitMQ quorum queue with confirms.
  - Queue messages are pointers that workers claim conditionally, so duplicate, stale and redelivered tickets are harmless.
  - Stopping the publisher, or RabbitMQ itself, mid-run loses nothing.
- **One customer's outage stays theirs.**
  - Retries wait in PostgreSQL (`next_attempt_at`), never in the shared queue.
  - Each endpoint has a fleet-wide in-flight limit (a Valkey semaphore); work beyond it is parked in the database in milliseconds.
  - Measured: Acme's p50 stayed at ~10-19 ms while Globex's endpoint hung for 30 s per request.
- **Failures classified, not just retried.**
  - Full-jitter backoff, with `Retry-After` honoured on 429 and the endpoint paused until then.
  - 410, invalid URL and SSRF-blocked stop at once and disable the endpoint; other 4xx fail that delivery only.
  - The retry window opens at the first attempt; when it runs out the endpoint is disabled and the customer notified.
- **Signed and rotatable.** HMAC-SHA256 over `t.body`, with two signatures during a rotation overlap and a 5-minute replay window. A verification snippet is in [architecture.md](./architecture.md#7-signatures-and-rotation).
- **SSRF-safe.** Every resolved address is vetted at connection time (IPv4, IPv6, IPv4-mapped, NAT64, 6to4), the socket is pinned to the vetted IP, and redirects are never followed.
- **Replay** creates new attempts for the same event id (one delivery, or "all failed since T"). **Ordering** isn't guaranteed; per-key sequence numbers let receivers discard stale updates.

![Delivery attempts with jittered backoff](./screenshots/04-delivery-retries.png)

| | |
|---|---|
| ![Endpoints](./screenshots/02-endpoints.png) | ![Disabled endpoint](./screenshots/03-endpoint-disabled.png) |
| ![Mock receiver: duplicate detected](./screenshots/07-receiver.png) | ![Operations: one endpoint probing, others unaffected](./screenshots/10-ops.png) |
| ![Exhausted delivery](./screenshots/05-delivery-exhausted.png) | ![Notifications](./screenshots/08-notifications.png) |

## Architecture

```
producers ──POST /events + Idempotency-Key──▶ API ── one txn: event + deliveries + outbox ──▶ PostgreSQL
                                                                                                │
        ┌──────────────── unpublished outbox rows ◀─────────────────────────────────────────────┤
        ▼                                                                                       │
  outbox publisher ──tickets {deliveryId, dispatchSeq}──▶ RabbitMQ quorum queue (due work only) │
                                                                  │                             │
                                                                  ▼                             │
  delivery workers: claim ─▶ endpoint slot (Valkey) ─▶ sign ─▶ vet + pin IP ─▶ POST ─▶ record ──┤
                                                                  │                             │
                                                                  ▼                             │
                                                          mock receiver (:3300)                 │
  retry scheduler: due retries ─▶ outbox (fair, per endpoint) ◀───────────────────────────────┘
  console (React) ──▶ API: endpoints, delivery log, replay, secrets, receiver toggles, ops
```

| Process | Default port | Command |
|---------|--------------|---------|
| API (intake + console) | 3000 | `npm run dev:api` (`dev:server1`/`dev:server2` add 3001/3002) |
| Outbox publisher | 3100 (metrics) | `npm run dev:publisher` |
| Delivery workers | 3101, 3102 (metrics) | `npm run dev:worker1`, `npm run dev:worker2` |
| Retry scheduler | 3103 (metrics) | `npm run dev:scheduler` |
| Mock receiver | 3300 | `npm run dev:receiver` |
| Frontend | 5173 | `cd frontend && npm run dev` |

`npm run dev` in `backend/` starts all six backend processes. Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, amqplib, ioredis, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Infrastructure:** PostgreSQL 16, RabbitMQ 3.13 (quorum queue, management UI), Valkey 7

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd webhook-platform
docker-compose up -d                 # PostgreSQL :5432 (webhooks/webhooks_password), RabbitMQ :5672 + UI :15672 (guest/guest), Valkey :6379

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # orgs Acme + Globex, users, API keys, 5 endpoints on the mock receiver
npm run dev                          # api, publisher, scheduler, 2 workers, mock receiver

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

Host ports are overridable: `WEBHOOK_PG_PORT=5462 WEBHOOK_AMQP_PORT=5682 WEBHOOK_AMQP_MGMT_PORT=15682 WEBHOOK_VALKEY_PORT=6409 docker-compose up -d`. Useful commands: `docker-compose down` stops the services, and `docker-compose down -v` also deletes the data.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 rabbitmq valkey      # or: brew install redis
brew services start postgresql@16
brew services start rabbitmq                    # management UI at http://localhost:15672 (guest/guest)
brew services start valkey                      # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE webhooks LOGIN PASSWORD 'webhooks_password';"
psql postgres -c "CREATE DATABASE webhook_platform OWNER webhooks;"

# Verify
pg_isready -h localhost -p 5432
rabbitmq-diagnostics -q ping
valkey-cli ping                                 # or: redis-cli ping → PONG
```

Homebrew's RabbitMQ enables the management plugin by default; if not, run `rabbitmq-plugins enable rabbitmq_management`. Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16`, `rabbitmq-server` and `redis-server` (or `valkey`) from your package manager.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://webhooks:webhooks_password@localhost:5432/webhook_platform` | PostgreSQL |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | Broker |
| `RABBITMQ_MGMT_URL` | `http://guest:guest@localhost:15672` | Queue depth for the operator page |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `PORT` | `3000` | API port |
| `PUBLISHER_PORT` / `WORKER_PORT` / `SCHEDULER_PORT` | `3100` / `3101` / `3103` | Health and metrics ports |
| `WORKER_ID`, `WORKER_CONCURRENCY` | `worker-<pid>`, `16` | Worker name and prefetch |
| `RECEIVER_PORT`, `RECEIVER_URL` | `3300`, derived | Mock receiver; seeded endpoint URLs use `RECEIVER_URL` |
| `API_URL` | derived from `PORT` | Where the mock receiver fetches its secrets and demo scripts call |
| `SSRF_ALLOWLIST` | `localhost:<RECEIVER_PORT>,127.0.0.1:<RECEIVER_PORT>` | `host:port` pairs reachable despite blocked ranges (production: empty) |
| `SSRF_ALLOW_HTTP` | `true` | Allow plain http (production: https only) |
| `RETRY_BASE_MS` / `RETRY_CAP_MS` / `RETRY_HORIZON_SECONDS` | `1000` / `20000` / `180` | Backoff and retry window (production: 30 s / 6 h / 3 days) |
| `DELIVERY_TIMEOUT_MS`, `DELIVERY_LEASE_MS` | `5000`, `15000` | Per-attempt deadline; in-flight lease |
| `PROBE_AFTER_FAILURES`, `MAX_RETRY_AFTER_SECONDS` | `5`, `60` | Probe mode threshold; Retry-After clamp |
| `ROTATION_OVERLAP_SECONDS`, `SIGNATURE_TOLERANCE_SECONDS` | `120`, `300` | Rotation overlap default; receiver replay window |
| `INTERNAL_TOKEN` | `local-internal-token` | Mock receiver ↔ API |
| `VITE_PORT`, `API_TARGET` (frontend) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |

## Demo accounts

All passwords are `password123`.

| User | Who | Sees |
|------|-----|------|
| `alice` | Acme Corp (customer) | Acme's endpoints, events, deliveries, receiver paths, notifications |
| `bob` | Globex Inc (customer) | Globex's; nothing of Acme's |
| `admin` | Platform operator | Queue depth, outbox lag, in-flight per endpoint, success rate; no payloads |

Producer API keys (local only): `whk_test_acme_local_0000000000000000` and `whk_test_globex_local_000000000000000`.

## Things to try

```bash
cd backend
npm run demo:story     # drives every interesting state through the real pipeline (~1 min with a 45 s window)
npm run demo:load      # two customers at 8 events/s; halfway through, Globex's endpoint hangs; prints Acme's p50/p95 per phase
```

`demo:story` leaves behind:

- a dropped acknowledgment, with the duplicate flagged at the receiver;
- 500 → 500 → 500 → 200 with jittered backoff;
- a 429 whose Retry-After was honoured;
- a 410 that disabled an endpoint, then re-enable and replay;
- an endpoint disabled after exhausting its window, with a notification;
- a secret rotation in progress (two signatures per request).

From the console you can also:

- flip the **Mock receiver** toggles per path (500, slow, drop ack, 429, 410; for the next N requests or until changed);
- **Emit** an event and then **Retry last (same key)** to see idempotent intake;
- **Rotate** a secret and watch the receiver log show two `v1` signatures;
- **Replay** a failed delivery and see a new attempt for the same event id;
- watch **Operations** while `demo:load` runs: the hung endpoint sits at its slot limit while the queue stays at zero.

## API

```bash
# Emit (a retry with the same Idempotency-Key → 200 + Idempotent-Replayed: true, same event)
curl -X POST localhost:3000/api/v1/events \
  -H 'Authorization: Bearer whk_test_acme_local_0000000000000000' \
  -H 'Idempotency-Key: order-1042-created' -H 'Content-Type: application/json' \
  -d '{"type":"order.created","orderingKey":"order_1042","data":{"orderId":"1042","amount":4200}}'

# Sign in and read the delivery log
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login
curl -b jar localhost:3000/api/v1/endpoints/ep_acme_orders/deliveries
curl -b jar localhost:3000/api/v1/deliveries/<dlv_id>                       # every attempt

# Make the receiver drop the next acknowledgment, then emit and watch the duplicate get flagged
curl -b jar -X PUT -H 'Content-Type: application/json' -d '{"mode":"drop_ack","remaining":1}' localhost:3000/api/v1/receiver/paths/acme-orders
curl -b jar localhost:3000/api/v1/receiver

# Replay all failed deliveries of an endpoint since a time (same event ids)
curl -b jar -X POST -H 'Content-Type: application/json' -d '{"since":"2026-11-06T00:00:00Z"}' localhost:3000/api/v1/endpoints/ep_acme_audit/replay

# SSRF: rejected at registration, and again at every connection
curl -b jar -H 'Content-Type: application/json' -d '{"url":"http://169.254.169.254/latest/meta-data/"}' localhost:3000/api/v1/endpoints   # 422 SSRF_BLOCKED
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # 74 tests: signing/rotation, SSRF, backoff/jitter, classification, sender, receiver, API

# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running, after `npm run demo:story`)
node scripts/screenshots.mjs webhook-platform
npm run test:smoke webhook-platform
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs, failure handling and implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): signal, development phases, decisions, repair log, open questions
