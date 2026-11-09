# Design Yard Switch Lists

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 14,710 |
| Source Files | 152 |
| .ts | 10,318 |
| .tsx | 1,984 |
| .md | 1,613 |
| .sql | 426 |
| .json | 178 |

## Overview

A classification yard takes in inbound trains, sorts their cars into blocks on classification tracks, and builds outbound trains from those blocks. The switch list is the ordered set of moves that does this for a shift. This project produces that list and keeps it true while the yard changes under it.

**Signal.** This is a practice extension, not a reported interview question. BNSF publicly describes generating optimized switch lists with AI at its Alliance yard, but this prompt isn't known to have been asked in interviews. The yard, train symbols, schedule and figures here are invented. None of them come from BNSF or any railroad.

The trap in this prompt is spending the round on the optimization algorithm. Replanning, overrides and execution feedback are the product, so those are what this builds out.

- **Planner as a durable job.** A solve is a queued record with a time limit, reading an explicit yard-state version. A greedy heuristic and a local search that returns its best so far, measured against an exact search on small instances. A worker killed with SIGKILL mid-solve is recovered by lease, and no half-written plan can exist.
- **An independent validator.** It shares no code with the planner, and a test enforces that. It checks every plan, human or machine: track capacity, standing orders, departure times, train limits, hazmat placement and holds. It caught five real bugs during the build.
- **Immutable, versioned plans.** Draft → published → superseded, with a parent, an author, a reason and the yard-state version each was built on. A plan built on stale state is rejected at publish and recomputed. Diffs show moves kept, changed, added and removed, and why.
- **Replanning with stability.** Moves done or in progress are frozen. Moves inside a 30-minute horizon are kept. Each other change costs the objective. On the seeded 3-hour slip this disturbs 26 moves where a from-scratch replan disturbs 39. A train that now misses its departure is reported in a sentence, and the plan stops for a yardmaster.
- **Human override.** Drag to reorder or retarget, by mouse, touch or keyboard. Locks survive replans. An impossible lock surfaces a conflict that blocks publishing rather than being dropped. Operating rules can be overridden with a recorded reason. A hold never can. Two yardmasters get a version conflict, never a lost edit.
- **Holds from Railcar Health (#19).** The same event envelope, idempotent by event id and tolerant of duplicates and out-of-order delivery. A hold is rechecked at planning, publish, crew start and departure, so one landing at any moment can't slip through.
- **Crew reports are the truth.** A phone-width handheld with an offline queue and client-generated ids. Reports that sync out of order land every car where in-order delivery would. Track occupancy on the board is what crews reported.
- **Measuring the planner against the yardmaster.** Per-shift metrics from raw rows, and the same seeded shift replayed under three policies, with the limits of that comparison on the page.

![Yardmaster board](./screenshots/02-board.png)

| | |
|---|---|
| ![A replan after a 3-hour late train](./screenshots/03-replan-diff.png) | ![Plan versions and overrides](./screenshots/04-plans-overrides.png) |
| ![Heuristic, local search and exact](./screenshots/05-compare.png) | ![Metrics and replay](./screenshots/06-metrics.png) |
| ![Holds and the event feed](./screenshots/07-holds.png) | ![Simulator controls](./screenshots/08-simulator.png) |
| ![Crew handheld](./screenshots/10-crew-phone.png) | ![Sign in](./screenshots/01-login.png) |

## Architecture

```
 dispatch feed   Railcar Health events   yardmaster board     crew handhelds
      │                 │                      │                    │ (offline queue)
      ▼                 ▼                      ▼                    ▼
 simulator ──▶ Valkey stream ──▶ worker    API (x2) ◀───────────────┘
      │              (hold consumer)           │
      └────────────────────┬───────────────────┘
                           ▼
       PostgreSQL: yard state version, cars, tracks, plan versions, moves,
       executions, reports, locks, overrides, holds, solve jobs, triggers
                           ▲
                           │ one final transaction, fenced by a lease
                  planner worker ── coalescer → search → independent validator
```

| Process | Default port | Command |
|---------|--------------|---------|
| API | 3000 | `npm run dev:api` |
| Second API | 3001 | `npm run dev:server1` |
| Planner worker (coalescer, solves, analysis, hold consumer) | 3100 (metrics) | `npm run dev:worker` |
| Yard simulator (starts paused) | 3110 (control) | `npm run dev:simulator` |
| Frontend | 5173 | `cd frontend && npm run dev` |

Details: [architecture.md](./architecture.md). Interview answers: [backend](./system-design-answer-backend.md), [full-stack](./system-design-answer-fullstack.md), [frontend](./system-design-answer-frontend.md). History and decisions: [CLAUDE.md](./CLAUDE.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS, hand-rolled SVG chart
- **Infrastructure:** PostgreSQL 16, Valkey 7 (sessions and the hold-feed stream)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option A) or Homebrew (Option B)

### Option A: Docker Compose (recommended)

```bash
cd yard-switch-lists
docker-compose up -d                 # PostgreSQL :5432 (yard/yard_password), Valkey :6379

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # users, plus the whole demo story (about a minute)
npm run dev                          # api, planner worker, simulator

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

`npm run db:seed:plain` skips the demo story and gives a fresh shift, with its first solve queued for the worker.

Useful commands: `docker-compose down` stops the services, and `docker-compose down -v` also deletes the data. Stop the backend before reseeding.

Host ports can be moved: `YARD_PG_PORT=5462 YARD_VALKEY_PORT=6409 docker-compose up -d`.

### Option B: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey            # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE yard LOGIN PASSWORD 'yard_password';"
psql postgres -c "CREATE DATABASE yard_switch_lists OWNER yard;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                       # or: redis-cli ping → PONG
```

Then run the backend and frontend steps from Option A. The schema creates the `pgcrypto` extension, so the role needs to be allowed to do that, or create it once as a superuser with `psql yard_switch_lists -c "CREATE EXTENSION pgcrypto;"`.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://yard:yard_password@localhost:5432/yard_switch_lists` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `KEY_PREFIX` | `ysl:` | Prefix for every Valkey key |
| `PORT` | `3000` | API port |
| `WORKER_PORT` | `3100` | Worker health and metrics |
| `SIMULATOR_PORT` | `3110` | Simulator control |
| `API_URL`, `SIMULATOR_URL` | derived from the ports | Where the simulator and API call each other |
| `INTEGRATION_TOKEN` | `local-integration-token` | Shared token for the simulator and the hold webhook |
| `PLANNER_TIME_LIMIT_MS`, `PLANNER_ITERATIONS` | `2500`, `6000` | Default budget for a solve |
| `PLANNER_LEASE_MS`, `PLANNER_HEARTBEAT_MS` | `6000`, `1500` | How fast a dead worker's job is reclaimed |
| `COALESCE_QUIET_MS`, `COALESCE_MAX_WAIT_MS` | `1200`, `5000` | Replan trigger coalescing |
| `SIM_SEED`, `SIM_SPEED`, `SIM_TICK_MS`, `SIM_AUTOSTART` | `42`, `120`, `400`, off | Simulator |
| `SEED_PLAIN`, `SEED_SKIP_ANALYSIS` | off | Seed: no demo story; or no comparison and replay |
| `YARD_PG_PORT`, `YARD_VALKEY_PORT` (compose) | `5432`, `6379` | Host ports |
| `VITE_PORT`, `API_TARGET` (frontend) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |

### Running more instances

```bash
npm run dev:server1                    # second API on :3001 (sessions are in Valkey)
npm run dev:worker1                    # another planner worker; jobs are claimed with SKIP LOCKED
```

## Demo accounts

All passwords are `password123`.

| User | Role | Sees |
|------|------|------|
| `alice`, `carol` | Yardmaster | The board; edits, locks, publishes, resolves conflicts, drives the simulator |
| `dave` | Crew | The handheld: the published list only |
| `admin` | Admin | Everything a yardmaster sees |

## Things to try

The seeded yard is partway through shift 2, with a replan after a 3-hour late train, an override with a lock, a hold after coupling, a refused crew start, a crew exception and a lock conflict left open. From there, on the Simulator page:

| Do this | Then look at |
|---------|--------------|
| Press Reset yard, then +60 min | A clean shift being worked |
| Make a train 3 hours late | Board banner, then Plans → the new version: what changed, what was left alone, stable vs from scratch, any missed departure |
| Drag a move on the board, or focus it and press Alt+↑ | The reason dialog and the validator's answer; a sequence lock in Locks |
| Drop a move on a track lane outside its standing order | "Override and record" |
| Place a hold on a car in the next assemble move | The car leaves the plan; the handheld refuses a stale start |
| Block a track that a locked car lands on | A lock conflict that blocks Publish until you release it |
| On the handheld, Go offline, work a few moves, then Sync | The outbox, and the board catching up |
| Press Start at 120× | Crews, arrivals and departures with no hands |
| Compare → Run again; Metrics → Run replay | The gap, and three policies on the same seeds |

## Tests

```bash
cd backend
npm test            # validator rules, planner invariants, replanning, locks, holds, crew reports, metrics, API
npm run type-check && npm run lint && npm run build

cd ../frontend
npm test && npm run type-check && npm run lint && npm run build
```

Smoke tests are generated from `scripts/screenshot-configs/yard-switch-lists.json` into `tests/smoke.spec.ts`. Run them with the stack up, using `npm run test:smoke yard-switch-lists` from the repo root.

## Where rail practice is simplified

Real yards are far more intricate than this model. Read this before quoting anything here as railroad practice.

- **Hazmat rules are simplified from real rules.** At least five non-placarded cars behind the locomotive, and a couple of placard pairs that may not be adjacent. These are reductions of real position-in-train requirements (in the US, 49 CFR Part 174), which vary with hazard class, train length and movement. They aren't the regulation.
- **A track is a capacity in feet.** No ladders, leads, or in-track order. One block per classification track at a time, and a pull can arrange cars within a block.
- **Crews are queues.** One hump crew and one trim crew, with illustrative durations per move and per car. No engine moves, retarder tracks or crew rest.
- **Departure and brake-test timing is illustrative**, as are the objective weights and all train and yard data.
- **A held car stays where it stands**, or sets out to its block's track. A real yard sends it to a rip track.
