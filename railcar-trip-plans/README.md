# Design Railcar Trip Plans and ETAs

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 10,592 |
| Source Files | 141 |
| .ts | 6,775 |
| .tsx | 1,606 |
| .md | 1,469 |
| .sql | 360 |
| .json | 184 |

## Overview

Every loaded railcar travels on a **trip plan**: an origin, a sequence of trains between yards, and a destination customer. AEI tag readers, yard systems, dispatch and other railroads report where cars actually are, at least once, often late, sometimes not at all. This project tracks every car against its plan, detects missed connections early, replans automatically, predicts ETAs from yard dwell (not distance over speed), and shows each shipper only its own cars.

It is a reference example of an **event-driven application**:

- **Facts and decisions are events.** Car and train movements are facts from producers (`CarSighted`, `CarArrivedYard`, `TrainDeparted`, `TrainDelayed`, `CarInterchanged`, ...). Decisions are events too (`ConnectionMissed`, `TripPlanRevised`, `EtaUpdated`, `ExceptionOpened`, `ShipperNotified`), each with event time, recorded time, correlation and causation. See [events.md](./events.md).
- **The event store is the source of truth and the outbox.** One append-only PostgreSQL table with per-stream versions and optimistic concurrency; a relay publishes committed rows to Valkey Streams partitioned by car id (and train run).
- **Idempotent consumers.** Five consumer groups (car-state, eta, exceptions, notifier, replanner) each handle a message in one transaction with an idempotency marker, and ack after commit. Redelivery is a no-op; a SIGKILL mid-stream doesn't double anything.
- **Car state is a projection folded by event time**, so missing, duplicated, late and out-of-order facts converge; a missed AEI read is inferred from train movement and flagged.
- **Trip plans are an event-sourced aggregate**, revised by an orchestrated **replanning saga** (reserve a seat → revise the plan → await the ETA → complete) with compensation when the chosen train is cancelled.
- **ETA from dwell**: a seeded Monte Carlo walk through the remaining yards and trains gives p10/p50/p90, recomputed on relevant events and on `ClockTicked` (time as an event).
- **Fan-out with batching**: one digest per shipper per window, collapsed per car.
- **DLQ with redrive, replay, schema evolution** (`CarSighted` v1 → v2 with an upcaster), consumer lag and projection staleness in the UI and in Prometheus.

See [architecture.md](./architecture.md) for the design and trade-offs, [events.md](./events.md) for the event catalog, and [CLAUDE.md](./CLAUDE.md) for how it was built.

## Architecture

```
simulator ──HTTP──▶ API :3000 ──append──▶ PostgreSQL (event store = outbox, projections, saga state)
                                               │
                                          relay ──XADD──▶ Valkey streams  tp:car:0..3 (key car id)
                                                                           tp:train:0..1 (key train run)
                    ┌──────────────┬───────────────┬──────────────┬────────┴──────┐
                 car-state        eta          exceptions      notifier        replanner
                    └──── decisions appended back in each consumer's own transaction ────┘
frontend (Vite :5173) ──/api──▶ API
```

| Process | Default port | Entry point |
|---------|--------------|-------------|
| API (ingest, reads, commands, streams ops) | 3000 | `backend/src/api/index.ts` |
| Outbox relay | 3011 (health/metrics) | `backend/src/relay/index.ts` |
| car-state consumer | 3012 | `backend/src/consumers/car-state/index.ts` |
| eta consumer (+ ClockTicked) | 3013 | `backend/src/consumers/eta/index.ts` |
| exceptions consumer (+ dwell sweep) | 3014 | `backend/src/consumers/exceptions/index.ts` |
| notifier consumer (+ digest flush) | 3015 | `backend/src/consumers/notifier/index.ts` |
| replanner (process manager) | 3016 | `backend/src/replanner/index.ts` |
| Frontend | 5173 | `frontend/src/main.tsx` |

## Quick Start

### Option A: Docker Compose (recommended)

```bash
cd railcar-trip-plans
docker-compose up -d              # PostgreSQL 16 + Valkey (service "redis")

cd backend
npm install
npm run db:migrate
npm run db:seed                   # shippers, users, network, dwell history, 320 cars
npm run dev                       # API, relay and the five consumers

# second terminal
cd backend && npm run simulate    # 72 simulated hours in ~2.4 minutes

# third terminal
cd frontend && npm install && npm run dev    # http://localhost:5173
```

Stop with `docker-compose down` (add `-v` to drop the volumes).

### Option B: Native installation (no Docker)

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey

createuser -s trips 2>/dev/null; psql postgres -c "ALTER USER trips PASSWORD 'trips_password'"
createdb -O trips trip_plans
pg_isready && valkey-cli ping     # verify both are up
```

Then follow the backend and frontend steps from Option A.

### Environment variables

```bash
DATABASE_URL=postgresql://trips:trips_password@localhost:5432/trip_plans
REDIS_URL=redis://localhost:6379
PORT=3000                         # API
API_URL=http://localhost:3000     # where the simulator posts
INGEST_TOKEN=local-dev-ingest-token
RELAY_PORT=3011 CAR_STATE_PORT=3012 ETA_PORT=3013 EXCEPTIONS_PORT=3014 NOTIFIER_PORT=3015 REPLANNER_PORT=3016
VITE_PORT=5173                    # frontend; API_URL also sets the Vite proxy target
DIGEST_QUIET_MS=8000 DIGEST_MAX_WINDOW_MS=30000 DIGEST_MIN_INTERVAL_MS=20000
CLAIM_IDLE_MS=3000 MAX_DELIVERIES=4 CLOCK_TICK_MINUTES=120
```

### Demo accounts (password `password123`)

| User | Role | Sees |
|------|------|------|
| `sam` | Shipper, Prairie Grain Co-op | Own cars, plans, timelines (redacted), digests |
| `priya` | Shipper, Coastal Export Partners | Own cars |
| `olivia` | Network operations | Everything; resolves exceptions; streams page (read-only) |
| `alex` | Platform admin | Everything, plus DLQ redrive and car registration |

## What the simulator does

A closed-loop discrete-event simulation of a fictional railroad (Plains & Northern) with four yards (Northgate, Midland, Sandoval, Port Terminal), seven daily trains, ten AEI sites, an interchange with a fictional foreign road (Lone Pine Southern) and 320 cars for 10 shippers. Yards build each train from the system's current plans, so replanned cars really ride their new trains. It injects:

- missed AEI reads and yard reports, and one yard-system outage (positions are inferred from train movement);
- `CarSighted` v1 from older readers next to v2;
- a gateway resending a batch (same event ids), and the foreign road's interchange feed arriving hours late, shuffled, partly duplicated and resent with new ids;
- a six-hour delay on an 88-car train (two delay updates) → predicted missed connections → 88 replans;
- three cars left behind at Midland and a bad-ordered car;
- cancellation of the priority train the replanner chose → 60 compensations and child sagas;
- an interchange record for a car the registry doesn't know → car-state dead-letters it.

## Try the event-driven guarantees

```bash
cd backend
npm run replay -- all                      # rebuild every projection from position 0 and compare
npm run replay -- eta --apply              # rebuild and swap in (after changing the ETA model)
npm run relay:republish -- 1200 1210       # publish stored events again: consumers count duplicates
npm test                                   # idempotent redelivery, replay equivalence, upcasting, DLQ routing, ...
```

On the **Streams & DLQ** page (as `alex`): register the unknown car, then redrive its dead letter. Redriving before registering sends it back to the DLQ after four more deliveries.

Duplicate and late facts by hand:

```bash
curl -s -H 'X-Ingest-Token: local-dev-ingest-token' -H 'Content-Type: application/json' \
  -d '{"events":[{"eventId":"5d2a1c66-0a7e-4c1b-9d3e-1f2e3d4c5b6a","type":"CarSighted","version":1,
       "occurredAt":"2026-11-04T06:12:00Z","producer":"aei:AEI-NGTMID",
       "payload":{"carId":"HPSX104217","siteId":"AEI-NGTMID"}}]}' \
  localhost:3000/api/v1/ingest/events     # run twice: accepted, then duplicate
```

## Commands

```bash
# backend/
npm run dev | start            # all services (watch / no watch)
npm run dev:api|dev:relay|dev:car-state|dev:eta|dev:exceptions|dev:notifier|dev:replanner
npm run simulate               # --speed 3600, --api http://localhost:3000
npm run db:migrate | db:seed | db:reset
npm run replay -- <car-state|eta|plans|exceptions|all> [--apply]
npm run relay:republish -- <fromPosition> [toPosition]
npm test | type-check | lint

# frontend/
npm run dev | build | type-check | lint

# repo root
npm run screenshots railcar-trip-plans
npm run test:smoke railcar-trip-plans
```

## Screenshots

| | |
|-|-|
| ![Shipper portal](screenshots/01-shipper-cars.png) | ![Plan versions](screenshots/02-car-plan-versions.png) |
| Shipper portal: status, observed/inferred, plan version, ETA range vs original plan | Car detail: ETA range, where the time goes, ETA history, plan versions with reasons |
| ![Causation chain](screenshots/03-car-timeline-causation.png) | ![Late interchange](screenshots/04-late-interchange-timeline.png) |
| Event timeline with the causation chain of a predicted missed connection | Arrival order: a 23-hour-late, out-of-order interchange record |
| ![Exceptions](screenshots/05-exceptions-board.png) | ![Sagas](screenshots/06-replanning-sagas.png) |
| Exceptions board | Replanning sagas, including compensated ones and their child sagas |
| ![Digests](screenshots/07-shipper-digests.png) | ![Streams](screenshots/08-streams-dlq.png) |
| One digest per shipper per window | Consumer lag, staleness, DLQ with redrive, schema versions, replays |

## Tech stack

TypeScript everywhere. Backend: Node.js, Express, pg, ioredis, zod, pino, prom-client, vitest. Frontend: React 19, Vite, TanStack Router, Zustand, Tailwind CSS. Infrastructure: PostgreSQL 16, Valkey 7.
