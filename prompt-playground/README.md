# Design a Prompt Playground

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 0 |

## Overview

A developer tool for working with a model API: edit a prompt with `{{variables}}`, pick a model and its parameters, run it, and watch the output stream in. You can compare up to three configs side by side, save immutable versions, share a version or a finished run as a read-only link, and keep shared presets without overwriting a teammate's edits. The model is a local mock service, so everything runs offline.

The interesting parts are not the editor. They are what makes results trustworthy and runs robust:

- **Every run is reproducible.** A run pins the exact prompt text it executed (a content-addressed snapshot) and a copy of its config, so later edits never change what a result means. That holds even for runs of unsaved drafts.
- **Runs outlive the page.** An executor, not the HTTP request, owns each run. Output goes to a per-run event log that any API instance can replay, so you can refresh, switch prompts or open a second tab mid-run without losing tokens or starting a duplicate generation.
- **Exactly one outcome per run.** PostgreSQL leases with an `attempt` fencing token, a sweeper for crashed executors, and an event log that closes on its first `end` event.
- **No silent overwrites.** Run creation is idempotent per click, version saves detect a moved head (`409 HEAD_MOVED`), and preset edits use `If-Match` revisions.

See [architecture.md](./architecture.md) for the design and its trade-offs, and [CLAUDE.md](./CLAUDE.md) for how it was built.

## Screenshots

| | |
|---|---|
| ![Prompt library](./screenshots/02-prompts.png) | ![Side-by-side comparison](./screenshots/03-playground-comparison.png) |
| Prompt library | Side-by-side comparison of two models on v3 |
| ![Streaming comparison](./screenshots/04-run-streaming.png) | ![Admin dashboard](./screenshots/06-admin.png) |
| Config A finished, config B still streaming | Run health: queue time vs TTFT, failures, executors, mock model controls |
| ![Presets](./screenshots/05-presets.png) | ![Shared run](./screenshots/07-shared-run.png) |
| Workspace presets (edits checked with `If-Match`) | Public read-only share link |

## Architecture

```
Browser (React, :5173) ──REST──▶ API (:3000) ──▶ PostgreSQL (source of truth)
        ▲                          │   │
        └──── SSE (resumable) ─────┘   └──▶ Valkey: run queue · per-run event logs · sessions · limits
                                                 ▲              ▲
                                    pull run ids │              │ append deltas / end
                                           Executor (:3200) ──streaming HTTP──▶ Mock model (:3100)
```

| Service | Path | Role |
|---------|------|------|
| API | `backend/src/api/` | REST endpoints and the SSE event stream; stateless |
| Executor | `backend/src/executor/` | Claims runs with a lease, streams from the model into the event log, finalizes; sweeper recovers crashed or stuck runs |
| Mock model | `backend/src/model/` | Streams deterministic tokens with realistic latency, a concurrency limit and injectable failures |
| Frontend | `frontend/src/` | Playground, history, presets, share page, admin dashboard |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS
- **Backend:** Node.js, Express, TypeScript (tsx), zod, opossum, prom-client, Pino
- **Data:** PostgreSQL 16, Valkey 7 (Streams, pub/sub, counters)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (Option 1), or PostgreSQL 16 and Valkey/Redis 7 installed natively (Option 2)

### Option 1: Docker Compose (recommended)

1. **Start PostgreSQL and Valkey:**
   ```bash
   cd prompt-playground
   docker-compose up -d
   ```

2. **Install, migrate and seed the backend:**
   ```bash
   cd backend
   npm install
   npm run db:migrate
   npm run db:seed          # --reset to wipe and reseed: npx tsx src/db/seed.ts --reset
   ```

3. **Start the API, executor and mock model together:**
   ```bash
   npm run dev
   ```

4. **Start the frontend (new terminal):**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

5. **Open http://localhost:5173** and sign in:

   | User | Password | Notes |
   |------|----------|-------|
   | `alice` | `password123` | Admin; workspace "Acme AI" |
   | `bob` | `password123` | Same workspace, to try conflicts from two browsers |
   | `carol` | `password123` | Alone in "Solo Labs", to see workspace isolation |

Stop with `docker-compose down` (add `-v` to delete the data).

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey

createuser playground
psql postgres -c "ALTER USER playground PASSWORD 'playground_password'"
createdb -O playground prompt_playground

psql -U playground -d prompt_playground -c 'SELECT 1'   # verify PostgreSQL
valkey-cli ping                                          # verify Valkey (or redis-cli ping)
```

Then follow steps 2-5 of Option 1.

### Environment variables

All have local defaults; set them only to override.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://playground:playground_password@localhost:5432/prompt_playground` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `PORT` | `3000` | API port |
| `EXECUTOR_PORT` / `EXECUTOR_ID` | `3200` / `executor-<pid>` | Executor health/metrics port and identity |
| `MODEL_PORT` / `MODEL_BASE_URL` | `3100` / `http://localhost:3100` | Mock model |
| `EXECUTOR_CONCURRENCY` | `8` | Runs one executor executes at once |
| `RUN_LEASE_SECONDS` / `RUN_HEARTBEAT_MS` | `15` / `5000` | Run ownership lease and renewal interval |
| `SWEEP_INTERVAL_MS` | `10000` | How often the sweeper looks for stuck runs |
| `REQUEUE_AFTER_SECONDS` / `QUEUE_TIMEOUT_SECONDS` | `30` / `300` | Re-enqueue lost doorbells; fail runs nobody picked up |
| `MAX_ACTIVE_RUNS_PER_USER` / `RUNS_PER_MINUTE_PER_USER` | `6` / `30` | Per-user limits |
| `EVENT_STREAM_TTL_SECONDS` | `3600` | How long a finished run's live log is kept |

### Running more instances

```bash
cd backend
npm run dev:api          # API only on :3000
npm run dev:executor     # one executor
npm run dev:model        # mock model
npm run dev:server1      # extra API instances on :3001, :3002, :3003
npm run dev:server2
npm run dev:server3
npm run dev:executor2    # a second executor (:3202): watch leases and the sweeper coordinate
```

Any API instance can serve any run's stream, because the event log lives in Valkey.

## Things to try

- **Refresh mid-run.** Start a `sim-quality` run and reload the page. The output replays from the start of the run's event log and keeps streaming. Nothing is re-submitted.
- **Leave while it runs.** Start a run, go back to the prompt list, and wait for the toast when it finishes. The header shows how many runs are in progress.
- **Stop.** The mock model stops generating as soon as the executor drops the connection; the partial output is kept.
- **Compare.** Add a second config and run both. Each column has its own run; history groups them.
- **Conflicts.** Open the same prompt as alice and bob in two browsers, edit in both, and save in both: the second save gets a banner saying who saved what, with "load theirs" or "keep my edits on top". Do the same with a preset.
- **Break things on purpose.** As alice, open Admin and set the failure rate to 100%, the latency to 5×, or the concurrent generations to 1. Then run a few prompts and watch errors, 429 retries and queue time on the dashboard.
- **Crash an executor.** Start two executors and a long run, then `kill -STOP` the one that owns it (see `lease_owner` in `runs`). Within about 25 seconds (15 s lease plus up to 10 s until the next sweep) the other executor's sweeper fails the run with `EXECUTOR_LOST`, keeping the partial output. `kill -CONT` the first one: it notices it lost the lease and writes nothing.

## API

Base path `/api/v1`. Full list and semantics in [architecture.md](./architecture.md#api-design).

```bash
# Sign in (cookie jar)
curl -c jar -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login

# Start a run: one Idempotency-Key per click; repeating it returns the same run (200)
curl -b jar -H 'Content-Type: application/json' -H 'Idempotency-Key: 1f6c…' \
  -d '{"promptId":"<id>","system":"You help with {{topic}}.","template":"Question: {{q}}",
       "variables":{"topic":"billing","q":"Why was I charged twice?"},
       "config":{"model":"sim-fast","temperature":0.7,"maxTokens":256,"topP":1}}' \
  localhost:3000/api/v1/runs

# Follow its output; resume after a disconnect with Last-Event-ID
curl -N -b jar localhost:3000/api/v1/runs/<runId>/events
curl -N -b jar -H 'Last-Event-ID: 1791852476817-0' localhost:3000/api/v1/runs/<runId>/events

# Stop it
curl -b jar -X POST localhost:3000/api/v1/runs/<runId>/cancel
```

## Development

```bash
# Backend
cd backend
npm run type-check
npm run lint
npm test                 # vitest: templates, hashing, SSE parsing, generator, API validation + idempotency

# Frontend
cd frontend
npm run type-check
npm run lint
npm run build
npm test                 # vitest: SSE parser

# Screenshots and smoke tests (from the repository root, stack running)
npm run screenshots prompt-playground
npm run generate-tests prompt-playground
```

Observability: `GET /metrics` on the API (:3000), executor (:3200) and mock model (:3100); `GET /health` and `GET /ready` on the API.

## Architecture Documentation

- [architecture.md](./architecture.md): production design, schema, API, trade-offs, and how the local build maps to it
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend-focused interview answer
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend-focused interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): iteration history and decisions made while building
