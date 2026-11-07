# Design an LLM Eval Dashboard

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,928 |
| Source Files | 163 |
| .ts | 7,371 |
| .tsx | 2,316 |
| .md | 1,605 |
| .sql | 258 |
| .json | 176 |

## Overview

Versioned test datasets, prompt versions, model configs and scorers; asynchronous eval runs that execute every test case several times against a model; inspection of every output and score; and comparisons between runs that refuse to call a change an improvement until it actually is one. It extends the [prompt playground](../prompt-playground/)'s data model and answers ROADMAP [#10](../ROADMAP.md#10-llm-eval-dashboard): *the prompt, the dataset and the scoring function all changed; what information is required before a comparison can be called an improvement?* (answer: [architecture.md § 9](./architecture.md#9-provenance-and-the-improvement-claim)).

The interesting parts:

- **Immutable, pinned inputs.** Dataset versions (with a case-level diff), prompt versions, model configs and scorer versions are immutable, enforced by a PostgreSQL trigger. A run pins one of each plus a sample count; editing anything creates a new version, with `409` on a stale base.
- **A work queue in PostgreSQL, no broker.** A run fans out into case × sample rows in one transaction (idempotent on `Idempotency-Key`). Workers claim rows with `FOR UPDATE SKIP LOCKED`: round robin across runs, an exact per-run concurrency limit, leases with heartbeats, and lease-token fencing on every write. SIGKILL a worker mid-run: its tasks are re-claimed after the lease expires, with one row per (run, case, sample) and no duplicate scores.
- **Partial failures, never averaged away.** 429 (Retry-After honoured), overload, timeouts and broken streams retry with full-jitter backoff; context overflows and other 400s are recorded once. A run ends "completed, N errored": every aggregate excludes those tasks and shows the count, and **Retry errored** re-runs only them. **Cancel** aborts in-flight model calls in ~20 ms (LISTEN/NOTIFY + AbortController, with a 1 s poll and a sweeper as fallbacks).
- **Statistics that treat the case as the unit.** Mean ± 95% interval over per-case means (Student t, plus a seeded bootstrap), flaky cases, and the interval narrowing with samples (±0.130 → ±0.031 → ±0.020 for 1, 5, 10 samples). Comparisons are **paired by case**: mean difference, paired CI, wins/losses/ties, and "not significant" whenever the CI crosses zero.
- **Provenance before the number.** Every comparison lists the pins side by side and checks six requirements. Mixed dataset versions become an unpaired, "indicative only" comparison over unchanged shared cases. Scorer-version mismatches are blocked with a "re-score with vN" button. Prompt and model config changing together is flagged as confounded.
- **Re-scoring without generating.** Scores live in their own table keyed (output, scorer version). Fixing a regex or tightening a judge rubric scores the stored outputs again: new rows, old ones kept, zero model calls. The seeded orders run goes from 0.000 (strict JSON parse) to 0.806 (fences stripped) without a single call.
- **Human annotation.** A per-run queue (judge unsure, samples disagree, plus random spot checks), pass/fail labels, and judge-versus-human agreement split by source.
- **Mock model and mock judge** as separate processes: deterministic per (prompt version, case, sample, seed), varying across samples with temperature, quality that depends on the prompt (a better prompt wins some cases and loses others), context windows, and armed-count chaos switches with per-run call counters.

![Paired comparison: improvement](./screenshots/05-compare-improvement.png)

| | |
|---|---|
| ![Runs](./screenshots/02-runs.png) | ![Run with errored cases and a re-score](./screenshots/03-run-errored-rescored.png) |
| ![Not significant, with drill-down](./screenshots/06-compare-not-significant.png) | ![Mixed dataset versions](./screenshots/07-compare-mixed-datasets.png) |
| ![Scorer versions not comparable](./screenshots/08-compare-scorer-mismatch.png) | ![Two factors changed](./screenshots/09-compare-confounded.png) |
| ![Re-scored without generating](./screenshots/10-rescored-orders.png) | ![Annotation queue and agreement](./screenshots/11-annotation-queue.png) |
| ![Dataset version diff](./screenshots/12-dataset-diff.png) | ![Samples and attempts](./screenshots/04-run-samples.png) |

## Architecture

```
browser ──▶ API (×2) ── one txn: run + case×sample rows, NOTIFY ──▶ PostgreSQL ◀── claims (SKIP LOCKED),
              │  compare: provenance → paired statistics → verdict          │       heartbeats, fenced writes
              └─────────────────────────── reads ◀──────────────────────────┤
                                                                            ▼
                         eval workers (×2): claim → call model (SSE) → classify → write → score
                                   │                                          │
                             mock model (:3100)                         mock judge (:3105)
```

| Process | Default port | Command |
|---------|--------------|---------|
| API | 3000 (and 3001) | `npm run dev:api` (`dev:server1` adds 3001) |
| Eval workers | 3101, 3102 (metrics) | `npm run dev:worker1`, `npm run dev:worker2` |
| Mock model | 3100 | `npm run dev:model` |
| Mock judge | 3105 | `npm run dev:judge` |
| Frontend | 5173 | `cd frontend && npm run dev` |

`npm run dev` in `backend/` starts the API, both workers and both mocks. Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router (file-based), Zustand, Tailwind CSS
- **Infrastructure:** PostgreSQL 16 (also the work queue), Valkey 7 (sessions)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd llm-eval-dashboard
docker-compose up -d                 # PostgreSQL :5432 (evals/evals_password, db llm_eval), Valkey :6379

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # workspaces, users, datasets, prompts, scorers and 15 finished runs
npm run dev                          # api, 2 workers, mock model, mock judge

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

Host ports are overridable: `EVAL_PG_PORT=5462 EVAL_VALKEY_PORT=6409 docker-compose up -d`. `docker-compose down` stops the services; `docker-compose down -v` also deletes the data.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey            # or: brew install redis
brew services start postgresql@16
brew services start valkey                   # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE evals LOGIN PASSWORD 'evals_password';"
psql postgres -c "CREATE DATABASE llm_eval OWNER evals;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                              # or: redis-cli ping → PONG
```

Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16` and `redis-server` (or `valkey`) from your package manager.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://evals:evals_password@localhost:5432/llm_eval` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis (sessions, login rate limit) |
| `PORT` | `3000` | API port |
| `MODEL_PORT`, `MODEL_URL` | `3100`, derived | Mock model |
| `JUDGE_PORT`, `JUDGE_URL` | `3105`, derived | Mock judge |
| `WORKER_PORT`, `WORKER_ID`, `WORKER_CONCURRENCY` | `3101`, `worker-<pid>`, `8` | Worker metrics port, name, slots |
| `LEASE_MS` | `10000` | Task lease; heartbeats every third of it (production: minutes) |
| `MODEL_TIMEOUT_MS`, `JUDGE_TIMEOUT_MS` | `15000`, `10000` | Per-call deadlines |
| `MAX_ATTEMPTS`, `RETRY_BASE_MS`, `RETRY_CAP_MS` | `4`, `500`, `8000` | Retry budget per round; full-jitter backoff |
| `IDLE_POLL_MS`, `SWEEP_MS` | `300`, `2000` | Idle claim poll (NOTIFY wakes sooner); sweeper interval |
| `DEFAULT_RUN_CONCURRENCY`, `MAX_TASKS_PER_RUN` | `4`, `5000` | Run defaults and cap |
| `VITE_PORT`, `API_TARGET` (frontend) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |

## Demo accounts

All passwords are `password123`.

| User | Workspace | Sees |
|------|-----------|------|
| `alice` | Acme AI | Acme's datasets, prompts, scorers, runs and annotations |
| `carol` | Acme AI | The same workspace as alice |
| `bob` | Globex Labs | Only Globex's routing dataset and run |

## Things to try

The seed leaves finished runs that show each case (materialized with the same code the workers run, so a live run with the same pins reproduces them exactly):

| Open | What it shows |
|------|---------------|
| Runs → *Triage v1 baseline* | "completed, 5 errored" (a long log exceeds the small model's context), Exact label 0.000 because the prompt answers in prose, and *Label regex v2* added later by re-scoring |
| Compare *Triage v1 baseline* → *Triage v2* on *Label contains* | **Improvement**: Δ +0.218, 95% CI [+0.064, +0.373], 9/2/11 |
| Compare *Triage v2* → *Triage v3: few-shot* on *Exact label* | **Not significant**: Δ −0.082 [−0.190, +0.026]; few-shot helps some cases and biases account tickets |
| Compare *Triage v2 on dataset v1* → *Triage v2* | Mixed dataset versions: unpaired over the 17 unchanged cases, Δ exactly 0 |
| Compare *Triage v2* → *Triage v3* on *Label regex* | Scorer versions don't match: blocked, with "re-score with v2" |
| Compare *Triage v2* → *Triage v3 on large* | Prompt and model both changed: confounded |
| Run *Triage v2* | The same-pins table: ×1 ±0.130, ×5 ±0.031, ×10 ±0.020 |
| Run *Orders v1* | JSON shape v1 0.000 → v2 0.806 by re-scoring stored outputs |
| Annotate *Status v1* | Judge vs human agreement, split into spot checks and low-confidence items |

```bash
cd backend
npm run demo:story     # live pipeline: idempotent create, chaos retries, "2 errored" + retry, re-score with 0 model calls, cancel
```

From the UI you can also start a run (New run), cancel it mid-flight, arm chaos on **Mock model** (+1 rate_limit, +1 timeout, …) and watch the attempts, edit a dataset into a new version, save a scorer version and re-score an old run with it.

## API

```bash
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login

# Create a run (a retry with the same key → 200 + Idempotent-Replayed: true, same run)
curl -b jar -H 'Idempotency-Key: try-1' -H 'Content-Type: application/json' localhost:3000/api/v1/runs \
  -d '{"datasetVersionId":"dsv_triage_2","promptVersionId":"pv_triage_2","modelConfigId":"mc_small_t07","scorerVersionIds":["scv_exact_1"],"samplesPerCase":5}'

curl -b jar localhost:3000/api/v1/runs/<run_id>                       # progress, usage, aggregates ± CI, errored counts
curl -b jar -X POST localhost:3000/api/v1/runs/<run_id>/cancel
curl -b jar -X POST localhost:3000/api/v1/runs/run_triage_v1/retry-errored
curl -b jar -H 'Content-Type: application/json' -d '{"scorerVersionId":"scv_regex_2"}' localhost:3000/api/v1/runs/run_triage_v2/rescore
curl -b jar 'localhost:3000/api/v1/compare?a=run_triage_v1&b=run_triage_v2&scorer=sc_contains'
curl -s localhost:3100/admin/stats?runId=<run_id>                     # mock model call counter for one run
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # stats, aggregates, provenance, retry, scorers, mock model, judge, clients, API
TEST_DATABASE_URL=postgresql://evals:evals_password@localhost:5432/llm_eval npm test   # + queue race tests (stop the workers first)

# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running and seeded)
node scripts/screenshots.mjs llm-eval-dashboard
npm run test:smoke llm-eval-dashboard
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, the key question, trade-offs, failure handling and implementation notes
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [CLAUDE.md](./CLAUDE.md): development phases, decisions, repair log, open questions
