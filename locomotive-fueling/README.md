# Design a Locomotive Fueling Planner

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,238 |
| Source Files | 141 |
| .ts | 7,543 |
| .tsx | 1,684 |
| .md | 1,322 |
| .sql | 315 |
| .json | 176 |

## Overview

A freight railroad's fuel desk needs to know, for every train, **where to stop for fuel and how many gallons each locomotive should take**. The inputs are live fuel level, GPS and PTC milepost, the route ahead, burn rate and fuel prices. This project builds that system end to end, from noisy onboard telemetry to a fuel desk dashboard and a crew tablet view. It answers a candidate-reported BNSF Railway interview prompt (Glassdoor, not verified); see [CLAUDE.md](./CLAUDE.md).

The interesting parts:

- **Telemetry you can't trust, made trustworthy.**
  - Readings arrive duplicated, out of order and hours late after dark territory, and are deduped at two layers.
  - A per-locomotive estimator (notch-predicted, median-filtered, tilt-compensated, Kalman-style) turns hundreds of gallons of slosh into a usable level.
  - It detects fueling, leaks while stationary, units burning far above their consist-mates, and sensor faults (then it dead-reckons).
  - Low-fuel and can't-reach-next-fuel alarms fire from telemetry alone, even with the planner down.
- **A real optimizer.**
  - A DP over (station, consist fuel headroom) minimizes total trip cost: fuel, truck fees, dwell and queue time, stop penalties, cancellations, minus credit for fuel carried to the destination.
  - Every unit's reserve at every station is a hard constraint.
  - The classic greedy "gas station" answer is computed alongside for comparison.
  - The DP has a time budget with labelled fallbacks (greedy, then last good plan).
- **Plans with a lifecycle.**
  - Recommended → accepted (fuel desk or crew) → executing → fueled.
  - Only accepted stops reserve a pad bay or order a truck.
  - A cheaper plan after acceptance becomes a proposal the fuel desk must confirm.
  - A station going down voids the accepted plan, cancels the truck and alerts.
  - Hysteresis everywhere, so instructions don't flip.
- **A vendor that can leave you not knowing.** DTL truck orders are idempotent on the stop key. A timeout is "outcome unknown", resolved by looking the order up before retrying. Tickets are reconciled against what telemetry saw, catching short fills.
- **Uncertainty on screen.** Stale data and burn drift widen the safety margin, and every plan shows its confidence, assumptions, reason for changing, and full version history.

![Fleet board](./screenshots/02-fleet.png)

| | |
|---|---|
| ![Train plan](./screenshots/03-train-plan.png) | ![Proposal after acceptance](./screenshots/04-proposal.png) |
| ![DTL orders](./screenshots/05-orders.png) | ![Anomalies](./screenshots/06-anomalies.png) |
| ![Prices and model](./screenshots/07-prices.png) | ![Crew view](./screenshots/08-crew.png) |

## Architecture

```
onboard units ──▶ API (ingest) ──▶ Valkey streams p0..p3 (Kafka stand-in, keyed by locomotive)
 (simulator)                              │
                                          ▼
                                   processor ── latest state (Valkey) · history (PostgreSQL)
                                          │        alerts · re-plan triggers (coalesced)
                                          ▼
                                   planner ── DP + fallbacks + hysteresis → plan versions,
                                          │   proposals, bay reservations, DTL orders
                                          ▼
                                   order worker ──▶ mock DTL vendor ──▶ ticket webhook
                                          │
                     API (REST + SSE) ◀───┘ ──▶ React fuel desk · crew view · admin
```

| Process | Default port | Command |
|---------|--------------|---------|
| API (ingest, REST, SSE) | 3000 | `npm run dev:api` |
| Processor (stream consumer) | 3100 (metrics) | `npm run dev:processor` |
| Planner + order worker + reconciliation | 3200 (metrics) | `npm run dev:planner` |
| Mock DTL vendor | 3300 | `npm run dev:vendor` |
| Simulator (fleet, crews, pads, dispatch, prices) | 3400 (control) | `npm run dev:simulator` |
| Frontend | 5173 | `cd frontend && npm run dev` |

Details: [architecture.md](./architecture.md).

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, zod, pino, prom-client, bcryptjs; vitest + supertest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS, hand-rolled SVG charts
- **Infrastructure:** PostgreSQL 16, Valkey 7 (sessions, streams, latest state, pub/sub)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker Desktop (Option 1) or Homebrew (Option 2)

### Option 1: Docker Compose (recommended)

```bash
cd locomotive-fueling
docker-compose up -d                 # PostgreSQL :5432 (fueling/fueling_password), Valkey :6379

cd backend
npm install
npm run db:migrate                   # applies src/db/init.sql (idempotent)
npm run db:seed                      # network, 10 trains / 34 locomotives, users, starting state
npm run dev                          # api, processor, planner, vendor, simulator

cd ../frontend                       # in another terminal
npm install
npm run dev                          # http://localhost:5173
```

Useful commands: `docker-compose down` stops the services, and `docker-compose down -v` also deletes the data. Stop the backend before re-running `npm run db:seed`.

### Option 2: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey     # or: brew install redis
brew services start postgresql@16
brew services start valkey            # or: brew services start redis

# Create the role and database
psql postgres -c "CREATE ROLE fueling LOGIN PASSWORD 'fueling_password';"
psql postgres -c "CREATE DATABASE locomotive_fueling OWNER fueling;"

# Verify
pg_isready -h localhost -p 5432
valkey-cli ping                       # or: redis-cli ping → PONG
```

Then run the backend and frontend steps from Option 1. On Linux, install `postgresql-16` and `redis-server` (or `valkey`) from your package manager.

### Environment variables

Every variable has a local default, so no `.env` file is needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://fueling:fueling_password@localhost:5432/locomotive_fueling` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Valkey/Redis |
| `KEY_PREFIX` | `lf:` | Prefix for every Valkey key |
| `PORT` | `3000` | API port |
| `PROCESSOR_PORT` / `PLANNER_PORT` / `VENDOR_PORT` / `SIMULATOR_PORT` | `3100` / `3200` / `3300` / `3400` | Worker health/metrics, vendor, simulator control |
| `API_URL`, `VENDOR_URL` | derived from the ports | Where the simulator, vendor and planner call |
| `PROCESSOR_PARTITIONS` | all | Partitions this processor owns, e.g. `0,1` |
| `TELEMETRY_PARTITIONS` | `4` | Number of partition streams |
| `SIM_SPEEDUP` | `180` | Simulated seconds per real second |
| `SIM_FAULTS` / `SIM_SCENARIOS` | `on` | Network faults (duplicates, reordering, dark territory) / scripted scenarios |
| `VENDOR_TIMEOUT_MS` | `2500` | How long the order worker waits before "outcome unknown" |
| `DEVICE_TOKEN`, `INTEGRATION_TOKEN` | local defaults | Shared tokens for devices and integrations |
| `VITE_PORT`, `API_TARGET` (frontend) | `5173`, `http://localhost:3000` | Dev server port and API proxy target |

### Running more instances

```bash
npm run dev:server1                    # second API on :3001 (sessions are in Valkey)
npm run dev:processor1                 # partitions 0,1 on :3101
npm run dev:processor2                 # partitions 2,3 on :3102 (stop dev:processor first)
```

## Demo accounts

All passwords are `password123`.

| User | Role | Sees |
|------|------|------|
| `alice` | Fuel desk | Everything; accepts plans, confirms proposals, cancels orders, drives vendor fault switches |
| `bob` | Crew of S-KCKBAR | Their train only (cab tablet view); can accept their train's recommendation |
| `carol` | Admin | Prices, facility closures, model parameters |

## Things to try

The simulator runs scripted scenarios at simulated-hour offsets. You can also fire any of them at any time with `curl -X POST localhost:3400/scenarios/<name>`.

| Scenario | When | What to look at |
|----------|------|-----------------|
| Heavier than planned (Q-KCKBAR, +28% tons) | from the start | "burn running ×1.2 vs model", margin widened, medium confidence |
| `leak` (unit 7302) | +1 h | Leak alert on Anomalies; that unit's share and fuel grow in the plan |
| `price_change` (Belen pad $2.57 → $3.05) | +2 h | Plans move to Clovis; accepted plans get proposals instead |
| `reroute` (Q-KCKBAR2 via Fort Worth) | when it passes Emporia | Re-plan on a longer path |
| `sensor_fault` (unit 6260 reads +450 gal) | +2.5 h | Sensor-fault alert, raw vs smoothed chart, dead reckoning |
| `vendor_timeout` then `dtl_discount` (Gallup DTL $2.42) | +2.9 h, +3 h | An order goes "outcome unknown" → lookup → confirmed |
| `vendor_reject` | +4 h | Order refused → option excluded → plan voided → re-accept |
| `station_down` / `station_up` | +4.5 h / +7.5 h | An accepted pad stop goes away: plan voided, alert, truck cancelled |
| `short_fill` (15%) | +6 h | Ticket discrepancy alert in Orders and Anomalies |

From the UI you can also:

- arm vendor faults on **DTL orders**;
- change a price or close a facility as `carol` on **Prices & model**;
- set **Optimizer budget** to `0` to see "Greedy fallback" plans;
- confirm or reject a proposal on a train page.

## API

```bash
# Telemetry from an onboard unit; repeat the same batchId → 200 {"duplicate": true}
curl -X POST localhost:3000/api/v1/telemetry/batch -H 'Content-Type: application/json' -H 'X-Device-Token: local-device-token' \
  -d '{"batchId":"demo-batch-0001","readings":[{"locomotiveId":"4700","seq":1,"recordedAt":1793950000000,"lat":39.08,"lon":-94.65,"milepost":0,"speedMph":0,"notch":0,"fuelGal":3000,"engineState":"idle"}]}'

# Sign in and read the fleet
curl -c jar -H 'Content-Type: application/json' -d '{"username":"alice","password":"password123"}' localhost:3000/api/v1/auth/login
curl -b jar localhost:3000/api/v1/fleet
curl -b jar localhost:3000/api/v1/trains/T01

# Accept the current recommendation (409 SLOT_TAKEN if every bay is reserved)
curl -b jar -X POST localhost:3000/api/v1/trains/T01/plans/1/accept

# Make the next DTL order time out, then watch it go pending → unknown → confirmed
curl -b jar -X PUT -H 'Content-Type: application/json' -d '{"timeoutNext":1}' localhost:3000/api/v1/admin/vendor
curl -b jar localhost:3000/api/v1/orders
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # 58 tests: optimizer, lifecycle, estimator, orders, vendor, API

# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running)
node scripts/screenshots.mjs locomotive-fueling
npm run test:smoke locomotive-fueling
```

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs and implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
- [CLAUDE.md](./CLAUDE.md): signal, development phases, decisions, repair log, open questions
