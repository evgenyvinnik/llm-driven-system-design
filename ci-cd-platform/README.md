# Design a CI/CD Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 13,291 |
| Source Files | 173 |
| .ts | 8,467 |
| .tsx | 2,384 |
| .md | 1,644 |
| .sql | 390 |
| .json | 179 |

## Overview

Repository events trigger workflows made of dependent jobs. Runners execute them, people watch live logs and download artifacts, and a burst of pushes on one repository doesn't starve the others. It extends the [job scheduler](../job-scheduler/) and answers ROADMAP [#11](../ROADMAP.md#11-cicd-platform). The trap in this problem is designing only the queue, so most of the work here is execution boundaries, credentials and repeatability.

The interesting parts:

- **Signed intake, deduplicated.** One webhook URL per repository, HMAC verified over the raw bytes before anything parses them. The delivery id is a unique constraint: ten concurrent copies across two API instances make one run, and all of them get its id back.
- **Immutable runs.** A run pins the commit SHA and the workflow file's SHA, and the definition is copied onto job rows that a trigger makes immutable. Push v2, re-run v1, and it still runs v1. Parsing is strict: cycles, unknown `needs` and unknown fields reject the workflow, with the error on the run. A typo in `idempotent: false` can't silently turn off a protection.
- **Readiness in the completion transaction.** No events and no poller. The transaction that finishes a job decides what becomes ready, under a row lock on the run, which is what closes the fan-in race. Tested against real PostgreSQL with simultaneous completions: the dependent is never missed and never enqueued twice.
- **PostgreSQL as the queue.** `SKIP LOCKED` on a repository row, then an exact per-repository limit, round robin between repositories, and label matching, all atomic with the lease and the audit row. In a 48-push burst on a saturated fleet, the burst's worst queue wait was 9.2 s and a second repository's was 1.4 s.
- **Leases, fencing and write-ahead intent.** A step's row says `running` before its process exists. Every runner write is checked against a fencing token. SIGKILL a runner mid-build and a new attempt finishes the job. SIGSTOP one and, when it wakes, its heartbeat is refused and it kills its own step.
- **`needs_attention`.** A runner vanishes after a non-idempotent step started. Did production change? The platform can't know, so it says so: outcome unknown, downstream held, never retried automatically, and a person records what happened. If the lost runner reports back later, that report is rejected as truth and kept as evidence.
- **Secrets at the claim.** Scoped to a repository or environment, AES-256-GCM at rest, never returned by any API, delivered only in the claim response, every release audited with its run, job and attempt. Pull requests from forks never receive them and can't enter a protected environment, even with a forged approval row in the database. Environments support branch rules and required approval.
- **Masking across chunks.** A value split across two log chunks, arriving out of order at different API instances, still comes out as `***`. Runners mask, and the API masks again.
- **Resumable logs.** Numbered chunks, idempotent and tolerant of reordering, assembled into contiguously numbered lines. SSE `Last-Event-ID` is the line offset: reconnect to any API instance and get exactly the missing lines. Valkey only says "look now". After completion the log moves to MinIO, and the same endpoint keeps serving it with the same ids.
- **Attempts.** Re-run one job, the failed jobs, or everything: new attempt numbers in the same run, against the same pins, with every old attempt's log still readable. Re-running a non-idempotent job needs explicit confirmation. Cancel kills the running step's whole process group.

![A run whose deploy has an unknown outcome](./screenshots/09-run-needs-attention.png)

| | |
|---|---|
| ![Runs](./screenshots/03-runs.png) | ![A diamond DAG with artifacts](./screenshots/04-run-success-dag.png) |
| ![Failed, downstream skipped](./screenshots/05-run-failed-skipped.png) | ![Attempt history](./screenshots/07-job-attempt-history.png) |
| ![Waiting for approval](./screenshots/08-run-waiting-approval.png) | ![Lost runner, new attempt](./screenshots/11-job-lease-expired.png) |
| ![Fork pull request](./screenshots/12-run-fork-withheld.png) | ![Masked logs](./screenshots/14-job-masked-logs.png) |
| ![Rejected workflow](./screenshots/15-run-invalid.png) | ![Secrets and the release audit](./screenshots/16-secrets.png) |
| ![Runners and leases](./screenshots/18-runners.png) | ![Operations and burst behaviour](./screenshots/23-admin-ops.png) |

## A substitution you should know about

**Locally, steps run as child processes, not containers. This is not a real security boundary.** A child process shares the runner's filesystem, network and user. In production every job gets an ephemeral VM or container, destroyed afterwards, with fork jobs on a separate pool.

What's still enforced locally: a fresh temporary workspace per attempt, removed afterwards; a scrubbed environment built from nothing; a per-step timeout; `ulimit` limits on file size, CPU time and open files (`ulimit -v` isn't available on macOS, so memory isn't limited there); and a kill of the whole process group on cancel or timeout. Runners execute **only the project's own fixture workflows**: the fixture panel selects a scenario by name from a catalog in the code, and a signed webhook can only name a commit already in the fixture store. Don't point this at code you don't trust.

## Architecture

```
Git host ─signed webhook─▶ API (×2) ─one transaction: delivery, pins, run, jobs, readiness─▶ PostgreSQL
                             │  ▲                                                               ▲  ▲
browser ─REST, polling──────▶│  │ SSE by line offset ◀─ reads lines ─────────────────────────────┘  │
        ◀─live logs──────────┘  │ ◀─ nudge ─ Valkey                                                  │
                                │                                                  scheduler: lease expiry,
runners (×2, HTTP only) ────────┘ claim, heartbeat, intent, chunks, complete       log archive, retention
   │  fenced by token                                                                                │
   └─ child process per step ─artifacts, via API─▶ MinIO ◀──────────── archived logs ────────────────┘
```

| Process | Default port | Command |
|---------|--------------|---------|
| API | 3000 (and 3001) | `npm run dev:api` (`dev:server1` adds 3001) |
| Scheduler | 3100 (metrics) | `npm run dev:scheduler` |
| Runners | 3101, 3102 (metrics) | `npm run dev:runners` (supervised: a killed runner comes back) |
| Frontend | 5173 | `cd frontend && npm run dev` |

`npm run dev` in `backend/` starts the API, the scheduler and the runners. Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, minio, yaml, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router (file-based), TanStack Virtual, Zustand, Tailwind CSS
- **Infrastructure:** PostgreSQL 16 (also the queue), Valkey 7 (sessions, log wake-ups), MinIO (artifacts, archived logs)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd ci-cd-platform
docker-compose up -d                 # PostgreSQL :5432 (cicd/cicd_password, db ci_cd_platform), Valkey :6379, MinIO :9000/:9001

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # users, repositories, secrets and 14 runs materialized through the real engine
npm run dev                          # API, scheduler, 2 supervised runners

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

Host ports are overridable: `CICD_PG_PORT=5442 CICD_VALKEY_PORT=6389 CICD_MINIO_PORT=9010 CICD_MINIO_CONSOLE_PORT=9011 docker-compose up -d`. `docker-compose down` stops the services; `docker-compose down -v` also deletes the data.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey minio/stable/minio     # or: brew install redis
brew services start postgresql@16
brew services start valkey                               # or: brew services start redis
minio server ~/minio-data --console-address ":9001" &    # the API creates its bucket on first use

# Create the role and database
psql postgres -c "CREATE ROLE cicd LOGIN PASSWORD 'cicd_password';"
psql postgres -c "CREATE DATABASE ci_cd_platform OWNER cicd;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                                          # or: redis-cli ping → PONG
curl -s http://localhost:9000/minio/health/live -o /dev/null -w "%{http_code}\n"   # → 200
```

Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16` and `redis-server` (or `valkey`) from your package manager, and MinIO from its release binary.

### Sign in

Password for everyone: `password123`.

| User | Sees |
|------|------|
| `alice` | Maintainer of `acme/web-app` and `acme/payments-api` |
| `carol` | The same repositories, read-only |
| `bob` | Maintainer of `globex/portal`, in another organization; sees nothing of Acme |
| `admin` | Reads everything; can use the runner kill switch |

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://cicd:cicd_password@localhost:5432/ci_cd_platform` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `MINIO_ENDPOINT`, `MINIO_PORT` | `localhost`, `9000` | MinIO (`MINIO_ENDPOINT` also takes `host:port`) |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` | `minioadmin`, `minioadmin`, `ci-cd-platform` | MinIO credentials and bucket |
| `PORT`, `SELF_URL` | `3000`, `http://localhost:$PORT` | API port; where the fixture generator sends webhooks |
| `CICD_MASTER_KEY` | a development key | Encrypts secrets and webhook keys. **The default is for local use only** |
| `RUNNER_REGISTRATION_TOKEN` | `dev-runner-registration-token` | What a runner presents to register |
| `LEASE_MS`, `HEARTBEAT_MS`, `MAX_AUTO_REQUEUES` | `6000`, `1000`, `2` | Lease length, renewal interval, retries before a job counts as poison |
| `SCHEDULER_PORT`, `SWEEP_MS`, `ARCHIVE_MS` | `3100`, `1000`, `1500` | Scheduler metrics port and sweep intervals |
| `API_URLS` | `http://localhost:$PORT` | Comma-separated API instances a runner rotates through |
| `RUNNER_NAME`, `RUNNER_LABELS`, `RUNNER_SLOTS`, `RUNNER_PORT` | `runner-<pid>`, `linux,x64`, `2`, `3101` | One runner's identity and capacity |
| `RUNNER_COUNT`, `RUNNER_PORT_BASE`, `RUNNER_RESTART_MS` | `2`, `3101`, `8000` | The local supervisor |
| `RUNNER_WORKSPACE_ROOT`, `RUNNER_FILE_SIZE_MB`, `RUNNER_CPU_SECONDS`, `RUNNER_OPEN_FILES` | system temp dir, `64`, `60`, `1024` | Workspaces and step limits |
| `VITE_PORT`, `API_TARGET` | `5173`, `http://localhost:3000` | Frontend port and API proxy target |

## Trying It

Everything can be driven from the **Fixture panel** in the browser:

1. **Duplicate delivery.** Send *Push: diamond DAG*, then *Send again* on that delivery. The run's header says "received 2×, one run".
2. **Lost runner, safe.** *Push: long idempotent build*, with *kill runner*. After about 6 s, attempt 1 is `lease expired` and attempt 2 finishes elsewhere.
3. **Lost runner, unknown outcome.** *Push: deploy to production*, with *kill runner on "Deploy"*. Approve it on the run page. After the lease expires, the run needs attention. Choose what happened.
4. **Fork.** *Fork pull request*. The log prints `NPM_TOKEN is [not set]`, and its deploy job is denied.
5. **Resume.** *Push: slow logs*. Open the job and press *Drop connection*. The note says which lines it resumed from.
6. **Burst.** The Operations page has a burst button, and `npm run load:burst` does the same from outside.

`npm run demo:story` tells the whole story against a live stack with real runners, leaving runs behind. `npm run load:burst` fires a burst and prints a report, exiting non-zero if a limit was broken (`BURST_COUNT`, `OTHER_COUNT`, `API_URL`).

A signed webhook by hand, against a commit already in the store:

```bash
BODY='{"ref":"refs/heads/main","after":"<sha>","repository":{"full_name":"acme/web-app"},"sender":{"login":"alice"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac whsec_dev_acme_web_app | sed 's/^.* //')"
curl -i localhost:3000/api/v1/webhooks/acme/web-app -H "X-GitHub-Event: push" -H "X-GitHub-Delivery: demo-1" -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

## Testing

```bash
cd backend
npm test                                                     # unit tests
TEST_DATABASE_URL=postgresql://cicd:cicd_password@localhost:5432/ci_cd_platform npm test   # adds the race tests, against real PostgreSQL
npm run lint && npm run type-check && npm run build
```

Unit tests cover workflow parsing and cycle detection, readiness and downstream cancellation, the lease-expiry decision, secret eligibility, masking across chunks, process-group kills, and the HTTP surface. The race tests cover the fan-in race, exact limits, fairness, the step-start versus expiry race, fencing, the fork path through the claim, attempt numbering, concurrent duplicates and log assembly. Generated Playwright smoke tests are in `tests/`.

## Documents

- [architecture.md](./architecture.md): the production design and the local mapping
- [system-design-answer-backend.md](./system-design-answer-backend.md), [frontend](./system-design-answer-frontend.md), [fullstack](./system-design-answer-fullstack.md): 45-minute interview answers
- [CLAUDE.md](./CLAUDE.md): how this was built and what changed when it ran
