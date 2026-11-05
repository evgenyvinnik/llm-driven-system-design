# Design a Storage Misconfiguration Remediation System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 12,131 |
| Source Files | 165 |
| .ts | 7,861 |
| .tsx | 1,979 |
| .md | 1,662 |
| .sql | 248 |
| .json | 177 |

## Overview

An enterprise runs tens of thousands of cloud storage accounts. Many still allow anonymous blob access, accept shared-key or SAS authentication, accept TLS below 1.2, are reachable from the whole internet, or lack soft delete and diagnostic logs. Finding them is easy. Fixing them is risky: some application, somewhere, depends on every one of those settings, and "just flip the setting" breaks production.

This project builds the system that finds and fixes these settings safely, against a simulated Azure-shaped control plane. It is also the repository's worked example of the **existing system review** interview round (see [existing-system-review.md](./existing-system-review.md)).

The interesting parts:

- **Impact analysis before any change.** Access logs (StorageBlobLogs, by AuthenticationType, TLS version, protocol and caller IP) classify every finding as *safe to fix*, *needs owner migration* or *insufficient evidence*. No logs is never treated as no usage.
- **Campaigns in waves.** Non-production before production, a canary per ring spread across subscriptions, geometric growth, a failure budget per wave that pauses the campaign by itself.
- **Bake-time verification and automatic rollback.** After each write the executor re-reads the property and watches the account's authorization failures against its own baseline. A dependency the logs missed (the seeded quarter-end batch job last ran 45 days ago, outside the 30-day window) triggers a rollback to the recorded original value.
- **Fleet-scale execution.** Per-subscription token buckets shared through Valkey, Retry-After honored, AIMD slow-down after a 429, bounded retries, If-Match on every write, re-read and revalidate before every write, and reconciliation against actual state after a 5xx or a lost response.
- **Crash-safe and idempotent.** Intent (before-value, etag, baseline, operation ID) is recorded in PostgreSQL before the write; claims carry a lease and a fence. Kill the executor right after a write and before it is recorded, restart it, and the account still received exactly one write.
- **Prevention after burn-down.** Controls map to Azure Policy effects; switching to deny is refused below 95% compliance, because deny also rejects redeploys of non-compliant accounts and the system's own rollbacks.
- **Exceptions with expiry, owner workflow, audit trail.** Risk acceptance needs an approver who is not the requester and always expires; the finding reopens on its own.

Design: [architecture.md](./architecture.md). Build history and decisions: [CLAUDE.md](./CLAUDE.md). Interview answers: [backend](./system-design-answer-backend.md), [frontend](./system-design-answer-frontend.md), [full-stack](./system-design-answer-fullstack.md).

## Architecture

```
Browser (React, :5173) ──REST + SSE──▶ API (:3000) ──▶ PostgreSQL (inventory, findings, evidence,
                                          │               campaign step state, exceptions, audit)
                                          └──▶ Valkey (sessions, task stream, token buckets, live events)

Scanner (:3200) ── Resource Graph pages, change feed, child GETs, log queries ──▶ Cloud simulator (:3100)
Executor (:3300) ── GET / PATCH If-Match, metrics during bake, rollback ────────▶ Cloud simulator (:3100)
```

| Process | Default port | Entry point | Job |
|---------|--------------|-------------|-----|
| Cloud simulator | 3100 | `backend/src/cloud-sim/index.ts` | ARM, Resource Graph, change feed, Azure Policy, Monitor metrics, Log Analytics; 1,500 accounts in 50 subscriptions; throttling, lag, 5xx, hidden dependencies |
| API | 3000 | `backend/src/api/index.ts` | Session auth, posture, findings, accounts, campaigns (SSE), exceptions, controls, audit |
| Scanner | 3200 | `backend/src/scanner/index.ts` | Full scans, change feed, evidence, owner workflow, exception expiry, posture snapshots |
| Executor | 3300 | `backend/src/executor/index.ts` | Coordinator, workers, verifier, rollback |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to the API |

## Tech Stack

- **Frontend:** TypeScript, Vite, React 19, TanStack Router, Zustand, Tailwind CSS
- **Backend:** Node.js 22, Express, TypeScript (ESM), tsx, zod, pino, prom-client
- **Data:** PostgreSQL 16 (source of truth), Valkey 7 (sessions, stream, buckets, events)

## Getting Started

### Prerequisites

- Node.js 20 or later
- Docker (Option A) or Homebrew (Option B)

### Option A: Docker Compose (recommended)

```bash
cd storage-remediation
docker-compose up -d                  # PostgreSQL 16 on 5432, Valkey on 6379

cd backend
npm install
npm run db:migrate                    # applies src/db/init.sql
npm run db:seed                       # users, the simulated fleet, first scan, exceptions, history
npm run dev                           # cloud-sim, api, scanner, executor

cd ../frontend
npm install
npm run dev                           # http://localhost:5173
```

Stop with `docker-compose down`; `docker-compose down -v` also deletes the data.

### Option B: Native services (no Docker)

```bash
# macOS (Homebrew)
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey            # or: brew install redis && brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE remediation LOGIN PASSWORD 'remediation_password';"
psql postgres -c "CREATE DATABASE storage_remediation OWNER remediation;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                       # PONG
```

On Linux without Docker, `initdb` refuses to run as root; run it as the `postgres` user (`su postgres -c "initdb -D /path/to/data"`), start with `pg_ctl -D /path/to/data -o "-p 5432" start`, then create the role and database as above. Then continue with `npm install`, `db:migrate`, `db:seed` and `npm run dev` as in Option A.

### Sign in

Every password is `password123`.

| User | Role | Sees and does |
|------|------|---------------|
| `alice` | Security engineer | Whole fleet; creates and runs campaigns; changes policy effects |
| `bob` | Resource owner (payments) | Only accounts tagged `owner=payments`; fix now; request exceptions |
| `carol` | Approver | Whole fleet, read-only; approves or rejects exceptions |
| `dave` | Resource owner (data-platform) | Only data-platform accounts |

### Environment variables

Every value has a default that matches docker-compose and the port conventions.

| Variable | Default | Used by |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://remediation:remediation_password@localhost:5432/storage_remediation` | api, scanner, executor, seed |
| `REDIS_URL` | `redis://localhost:6379` | api, scanner, executor |
| `PORT` | `3000` | api |
| `SIM_PORT` / `CLOUD_SIM_URL` | `3100` / `http://localhost:3100` | cloud-sim / everyone else |
| `SCANNER_PORT` / `EXECUTOR_PORT` | `3200` / `3300` | health and `/metrics` |
| `SIM_STATE_FILE` | `.sim-state/fleet.json` | cloud-sim, seed (the simulated cloud's persisted state) |
| `FLEET_SEED`, `FLEET_SUBSCRIPTIONS`, `FLEET_ACCOUNTS` | `20261105`, `50`, `1500` | cloud-sim, seed |
| `SHARD_INDEX` / `SHARD_COUNT` | `0` / `1` | scanner (subscriptions sharded by hash) |
| `EVIDENCE_LOOKBACK_DAYS` / `EVIDENCE_MIN_DAYS` | `30` / `14` | scanner |
| `EXECUTOR_CONCURRENCY` | `6` | executor worker slots |
| `SUB_BUCKET_CAPACITY` / `SUB_BUCKET_REFILL_PER_SEC` | `3` / `1` | executor's own per-subscription write budget |
| `EXECUTOR_MAX_ATTEMPTS` / `EXECUTOR_MAX_THROTTLES` | `5` / `12` | bounds on server-error and 429 retries per target |
| `ROLLBACK_MIN_ERRORS`, `ROLLBACK_BASELINE_MULTIPLIER`, `ROLLBACK_MIN_ERROR_RATE` | `5`, `3`, `0.02` | bake-time rollback trigger |
| `EXECUTOR_CRASH_AFTER_WRITES` | `0` (off) | test hook: exit right after the Nth write, before recording it |
| `VITE_PORT` / `VITE_API_TARGET` | `5173` / `http://localhost:3000` | frontend dev server |

### Running more instances

```bash
npm run dev:executor2      # a second executor; leases and fences keep them apart
SHARD_INDEX=0 SHARD_COUNT=2 npm run dev:scanner   # and SHARD_INDEX=1 in another terminal
npm run dev:server1        # a second API on 3001 (stateless apart from Valkey sessions)
```

## Things to try

1. **Burn-down with a rollback.** As alice, Campaigns → New campaign → SA-02 *Disable shared key*, non-production, safe-to-fix only. The canary hits one of the seeded quarter-end jobs and rolls it back automatically; wave 2 hits two more, exceeds its failure budget of 1 and pauses itself. Open a rolled-back account: its evidence now says *needs owner migration*, because the job's failed run is in the logs.
2. **Throttling.** `curl -X PUT localhost:3100/admin/faults -H 'content-type: application/json' -d '{"writeCapacity":2,"writeRefillPerSec":0.25}'`, then run a fleet-wide SA-06 soft-delete campaign. Watch *429s honored* climb while every target still lands once.
3. **Crash between the write and its record.** Restart the executor with `EXECUTOR_CRASH_AFTER_WRITES=60`. When it exits, restart it normally: the targets whose writes landed show `recovered`, and `POST /admin/writes` on the simulator shows one write each.
4. **A hidden dependency on any account.** `curl -X POST localhost:3100/admin/inject -H 'content-type: application/json' -d '{"resourceId":"<account id>"}'`, then fix that account: 403s appear during the bake and it rolls back.
5. **Exception expiry.** The seed approves an SA-03 exception that expires four minutes later. Watch the finding reopen and the owner get notified.
6. **Prevention.** Controls → SA-02 → deny is refused below 95% compliance. Set SA-01 to modify, then `curl -X POST localhost:3100/admin/drift -d '{"count":5}' -H 'content-type: application/json'`: new accounts arrive with public access already off.

## API

```bash
# Sign in (cookie jar)
curl -c jar -H 'content-type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login

# Preview, then create a campaign; repeating the Idempotency-Key returns the same campaign
curl -b jar -H 'content-type: application/json' -d '{"name":"SA-02 nonprod","controlId":"SA-02","scope":{"environments":["dev","test","sandbox"]}}' localhost:3000/api/v1/campaigns/preview
curl -b jar -H 'content-type: application/json' -H 'Idempotency-Key: sa02-nonprod-1' -d '{"name":"SA-02 nonprod","controlId":"SA-02","scope":{"environments":["dev","test","sandbox"]}}' localhost:3000/api/v1/campaigns

# Start, pause, resume, kill (repeating a transition is a no-op)
curl -b jar -X POST localhost:3000/api/v1/campaigns/<id>/start

# Follow progress; resume after a disconnect with Last-Event-ID
curl -N -b jar localhost:3000/api/v1/campaigns/<id>/events
```

| Area | Endpoints |
|------|-----------|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Posture | `GET /posture` |
| Findings | `GET /findings`, `GET /findings/facets` |
| Accounts | `GET /accounts/:name`, `POST /accounts/:name/fix` |
| Campaigns | `GET /campaigns`, `POST /campaigns/preview`, `POST /campaigns`, `GET /campaigns/:id`, `POST /campaigns/:id/{start,pause,resume,kill}`, `GET /campaigns/:id/events` (SSE) |
| Exceptions | `GET /exceptions`, `POST /exceptions`, `POST /exceptions/:id/{approve,reject,revoke}` |
| Governance | `GET /controls`, `PUT /controls/:id/policy`, `GET /audit`, `GET /notifications`, `POST /admin/scan` |

All paths are under `/api/v1`. Every service also has `/health` and `/metrics` (Prometheus).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test   # 89 tests (vitest)

# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running)
npm run screenshots storage-remediation
npm run test:smoke storage-remediation
```

## Screenshots

| | |
|---|---|
| ![Login](./screenshots/01-login.png) | ![Posture](./screenshots/02-posture.png) |
| ![Findings](./screenshots/03-findings.png) | ![Account](./screenshots/04-account.png) |
| ![Campaign with rollbacks](./screenshots/05-campaign-rollback.png) | ![Exceptions](./screenshots/06-exceptions.png) |
| ![Audit log](./screenshots/07-audit.png) | |

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs, and how the local build maps to it
- [existing-system-review.md](./existing-system-review.md): presenting this system in an existing-system review round
- [CLAUDE.md](./CLAUDE.md): development history, decisions, open questions
