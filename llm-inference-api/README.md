# Design an LLM Inference API

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 9,393 |
| Source Files | 113 |
| .ts | 5,915 |
| .md | 1,646 |
| .tsx | 1,323 |
| .json | 175 |
| .sql | 128 |

## Overview

A multi-tenant developer API in front of a language model, with the machinery a real one needs between the API key and the GPU. It answers a set of Anthropic candidate-reported prompts (self-reported, not verified): an API exercise on batching and request orchestration, a batching round (one accelerator that processes up to 100 inputs at a time, an exercise assumption) and a routing round with sticky assignment. See [CLAUDE.md](./CLAUDE.md).

The interesting parts:

- **A product contract before any GPU.**
  - Three modes: sync (one JSON), stream (SSE in the Messages API shape) and async (202, fetch later from any server).
  - The edge assigns the request id, and the id owns the work. Sync and stream requests are cancelled when their client disconnects; async requests survive.
- **Admission by cost, not by request count.**
  - Each request reserves estimated input tokens + `max_tokens` from its org's token bucket, in one atomic Lua script, and the unused part is refunded when it finishes.
  - A tenant over its own limit gets `429` with an exact `Retry-After`; a full queue gets `529 overloaded_error`.
  - Rejections never write to PostgreSQL.
- **Fairness that holds under a flood.** Each tenant gets a share of each queue. Deficit round robin by cost, weighted by tier, picks across tenants. Interactive and bulk lanes are separate, and bulk has a guaranteed minimum and a capped maximum share of slots.
- **Batching with three triggers.** A batch leaves when it is full, when its oldest request hits max wait, or when a deadline is close. The mock replicas batch continuously, and can be switched to static batching to compare.
- **Routing for cache reuse, not correctness.**
  - Consistent hashing with bounded load on the prompt prefix; drains for rolling version changes.
  - A request can move between replicas until its first token, never after: a mid-stream crash fails the started request, and queued ones re-route.
- **One atomic transition per state change** (`queued → running → completed | cancelled | failed`). A cancel racing completion has exactly one winner, and the caller is told which.
- **The latency split everywhere**: queue time, time to first token, tokens/s. A long queue never looks like a slow model.

![Admin console](./screenshots/05-admin.png)

| | |
|---|---|
| ![Streaming in the developer console](./screenshots/03-console-stream.png) | ![A request that failed mid-stream](./screenshots/04-request-failed-midstream.png) |
| ![Routing: ring shares and what moves](./screenshots/06-routing.png) | ![Console and history](./screenshots/02-console.png) |

## Architecture

```
clients / console ──▶ gateways (3000, 3001) ── auth · cost estimate · admission (Lua) · record · SSE
                              │  charge + enqueue          │ insert / guarded transitions
                              ▼                            ▼
                Valkey: buckets, interactive|bulk lanes,   PostgreSQL: orgs, keys, tiers,
                in-flight set, per-request event logs      requests (state), usage, batches
                              ▲                            ▲
                              └──── dispatcher (3100) ─────┘  batch policy · DRR · router · relay · sweeps
                                         │
                       mock replicas b1 (3101) · b2 (3102) · b3 (3103)
                       slots · continuous batching · prefix cache · versions · chaos
```

| Process | Default port | Command |
|---------|--------------|---------|
| Gateway | 3000 | `npm run dev:gateway` |
| Second gateway | 3001 | `npm run dev:server1` |
| Dispatcher | 3100 (health, metrics) | `npm run dev:dispatcher` |
| Standby dispatcher | 3110 | `npm run dev:dispatcher2` |
| Mock backends | 3101, 3102, 3103 | `npm run dev:backend1` … `dev:backend3` |
| Frontend | 5173 | `cd frontend && npm run dev` |

Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Infrastructure:** PostgreSQL 16, Valkey 7

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd llm-inference-api
docker-compose up -d                 # PostgreSQL :5432 (inference/inference_password), Valkey :6379

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # tiers, 4 orgs, 3 users, 5 API keys, some history
npm run dev                          # gateway, dispatcher, three mock backends

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173

cd ../backend && npm run load        # optional: traffic for the admin console (~60 s)
```

`docker-compose down` stops the services; `docker-compose down -v` also deletes the data. Host ports can be moved with `INFERENCE_PG_PORT` and `INFERENCE_VALKEY_PORT`.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey            # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE inference LOGIN PASSWORD 'inference_password';"
psql postgres -c "CREATE DATABASE llm_inference OWNER inference;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                       # or: redis-cli ping → PONG
```

Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16` and `redis-server` (or `valkey`) from your package manager.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://inference:inference_password@localhost:5432/llm_inference` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `KEY_PREFIX` | `inf:` | Prefix for every Valkey key |
| `PORT` | `3000` | Gateway port |
| `DISPATCHER_PORT` | `3100` | Dispatcher health/metrics |
| `BACKEND_URLS` | `b1=http://localhost:3101,b2=…:3102,b3=…:3103` | Where the dispatcher and admin API reach the backends |
| `BACKEND_ID`, `BACKEND_PORT` | `b1`, `3101` | Identity and port of a mock backend |
| `BACKEND_SLOTS`, `BACKEND_TOKENS_PER_SECOND`, `BACKEND_TTFT_MS`, `BACKEND_PREFILL_MS_PER_TOKEN` | `8`, `40`, `120`, `0.3` | Mock capacity and timing |
| `BACKEND_BATCHING` | `continuous` | `static` to compare |
| `BACKEND_VERSION` | `mock-large-2026-10` | Model version a backend starts with |
| `BATCH_MAX_SIZE`, `INTERACTIVE_MAX_WAIT_MS`, `BATCH_MAX_WAIT_MS` | `4`, `25`, `1500` | Batch policy defaults (live-editable in the admin console) |
| `INTERACTIVE_QUEUE_LIMIT`, `BATCH_QUEUE_LIMIT` | `48`, `400` | Queue bounds per lane (over them → 529) |
| `BATCH_MIN_SHARE`, `BATCH_MAX_SHARE` | `0.25`, `0.5` | Bulk lane's guaranteed and maximum share of slots |
| `SYNC_TIMEOUT_MS` | `120000` | Sync deadline (then cancelled, 504) |
| `VITE_PORT`, `API_TARGET` (frontend) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |

### Running more instances

```bash
npm run dev:server1        # second gateway on :3001; any gateway serves any request id
npm run dev:dispatcher2    # standby dispatcher; stop the first and it takes over within ~3 s
```

To try the exercise's numbers: `BATCH_MAX_SIZE=100 BACKEND_SLOTS=100 npm run dev`.

## Demo accounts and API keys

Console passwords are all `password123`.

| User | Sees |
|------|------|
| `alice` | Acme Robotics (scale) and Initech (free): developer console, her orgs' requests |
| `bob` | Globex Labs (build) |
| `admin` | Admin console and routing page; member of Acme |

Local-only API keys (seeded, in `backend/src/db/fixtures.ts`):

| Key | Org | Tier |
|-----|-----|------|
| `sk-inf-local-acme-production`, `sk-inf-local-acme-staging` | Acme Robotics | scale: 200k tokens/min |
| `sk-inf-local-globex-default` | Globex Labs | build: 40k tokens/min |
| `sk-inf-local-initech-hackday` | Initech | free: 6k tokens/min |
| `sk-inf-local-umbrella-bulk` | Umbrella Data | scale (the load generator's noisy tenant) |

## API

```bash
K=sk-inf-local-acme-production

# Sync
curl -s localhost:3000/v1/messages -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"model":"mock-large","max_tokens":128,"messages":[{"role":"user","content":"Hello"}]}'

# Stream (SSE, Messages API events + inference_status)
curl -N localhost:3000/v1/messages -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"model":"mock-large","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'

# Async: 202 + id, then fetch from any gateway, or attach to its events
ID=$(curl -s localhost:3000/v1/messages/async -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"model":"mock-large","max_tokens":128,"messages":[{"role":"user","content":"Hello"}]}' | jq -r .id)
curl -s localhost:3001/v1/requests/$ID -H "x-api-key: $K"
curl -N localhost:3001/v1/requests/$ID/events -H "x-api-key: $K"

# Cancel: the response says whether the cancel won
curl -s -X POST localhost:3000/v1/requests/$ID/cancel -H "x-api-key: $K"

# Over the free tier's budget → 429 with Retry-After
for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' localhost:3000/v1/messages/async \
  -H 'x-api-key: sk-inf-local-initech-hackday' -H 'content-type: application/json' \
  -d '{"model":"mock-large","max_tokens":2000,"messages":[{"role":"user","content":"Hi"}]}'; done
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Things to try

| Scenario | How | What to look at |
|----------|-----|-----------------|
| Fairness under a flood | `npm run load -- --phases high` | Admin: Umbrella fills the bulk lane; others keep sub-second queue times |
| 429 vs 529 | `npm run load -- --phases capacity` (drains b2 and b3 for 12 s) | Admin usage table: 429s and 529s in separate columns |
| Batch fill at low and high traffic | `npm run load -- --phases low,high` | Admin batch fill: max-wait batches of 1 at low traffic, full batches under load |
| Prefix-cache affinity | Console: send the long "Support assistant" prompt twice | The second run shows "primary, 1,500 cached prefix tokens" and a much shorter first-token segment |
| Cancel race | Console, stream mode: cancel near the end | The timeline says "Cancel won" or "Cancel lost: already completed" |
| Sync disconnect vs async survival | Console: Cancel in sync mode; Detach in async mode | Sync turns cancelled; async keeps running and completes |
| Drain and rolling upgrade | Admin: Drain or "Roll to …" on a backend while streaming | The in-flight stream finishes; new work for its prefixes goes elsewhere; the version flips with a cold cache |
| Mid-stream crash | Admin: arm "Crash mid-stream" on a backend, then stream to it | The started request fails with "cannot move"; prefilling ones re-route (2 tries) |
| Static vs continuous batching | Admin: "Use static" on a backend under load | Slots read full while sequences have finished |
| What adding a backend moves | Routing page | ~25% of keys move with consistent hashing vs ~75% with mod N |

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # 66 tests: engine, router, fairness, batch policy, buckets, registry, API
TEST_DATABASE_URL=postgresql://inference:inference_password@localhost:5432/llm_inference npm test   # + cancel/complete race on PostgreSQL
npm run load                                       # load generator

# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running)
node scripts/screenshots.mjs llm-inference-api
npm run test:smoke llm-inference-api
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs and implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): signal, development phases, decisions, repair log, open questions
