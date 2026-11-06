# Design a Railcar Health Monitoring System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 16,708 |
| Source Files | 222 |
| .ts | 11,087 |
| .tsx | 2,613 |
| .md | 2,056 |
| .sql | 530 |
| .json | 201 |

## Overview

Hot-bearing and hot/cold-wheel monitoring and predictive maintenance for a railcar fleet, built on wayside detector data. Wayside detectors measure every axle of every passing train, and each detector radios its own alarm to the crew when a bearing crosses its absolute threshold. That safety path stays local. This system adds what a single detector can't see:

- **Trending across detectors.** Each bearing is compared with the median of its own train side at every detector, and its rise per 15 miles is tracked. A failing bearing goes MEDIUM 175 miles before the detector's own alarm would fire (the pattern NTSB described at East Palestine).
- **Stable identity.** Axle N on the north rail becomes "car NRLX 304512, bearing R3", through stale consists, cars turned on a wye (corrected by AEI reads), trains rebuilt at a yard (consist versions by time) and wheelset replacements (component installs in event time).
- **Correct under bad delivery.** Store-and-forward gateways deliver at-least-once, out of order and hours late. Idempotent ingest, a live and a backfill lane, and order-independent per-bearing state give the same answer as perfect data.
- **Alerts with owners.** Opened → delivered → acknowledged → inspected → closed, with tier deadlines, escalation (desk → chief dispatcher → operations center), warnings when an unacknowledged car's train is approaching its yard, and handoffs across desks and yards.
- **The yard response.** Car holds that block outbound builds, work orders, an offline-tolerant tablet finding form, repairs recorded as wheelset installs, random audit inspections against label bias, and precision/recall from findings with a threshold backtest.
- **Bearings and brakes kept apart.** Hot bearings (journal bearing failure) vs hot wheels (stuck brake) and cold wheels (inoperative brake).
- **Event-driven throughout.** Alert cases and car component histories are event-sourced streams in a PostgreSQL event store, with expected-version appends and domain rules for conflicts (two offline tablets: the more severe finding wins). Raw readings are a fact log announced through a transactional outbox. A relay publishes every event to one Valkey stream per family (standing in for Kafka topics), consumed by idempotent consumer groups: the analyzer, a notifier, a yard work-order integration, a process manager with durable timers, and four replayable projections. Dead letters can be redriven from the Ops page; `npm run replay` rebuilds any projection from position 0 and compares it with the live table.

See [architecture.md](./architecture.md) for the design and trade-offs, [events.md](./events.md) for the event catalog, and [CLAUDE.md](./CLAUDE.md) for how it was built, the interview signal and sources, and what broke along the way.

## Architecture

```
simulator ──HTTP──▶ API (:3000) ── one transaction: fact rows + outbox events ──▶ PostgreSQL `events`
 5 trains, faults,   │  commands append to case/car streams (expected versions)        │ NOTIFY
 60× clock           │                                                                 ▼
                     │                              workers (:3011): relay ──XADD──▶ Valkey streams rh:ev:<family>
                     │                                                                 │ consumer groups
                     │        ┌─────────────────────────┬──────────────────────────────┼──────────────────────┐
                     │        ▼                         ▼                              ▼                      ▼
                     │   analyzer (:3010)         notifier · workorder-sync      ack-process +          projections:
                     │   identity, trends,        (yard maintenance tickets,     durable timers         alert-queue, car-history,
                     │   scoring, case events     repairs, audit cases)          (deadlines, handoffs)  detector-health, reliability
 browser (:5173) ◀───┤◀── SSE notices (after a projection commits) ◀──────────────────────────────────────────┘
   SSE + REST        │    reads projections; timelines read the event store; /ops shows lag and dead letters
```

| Process | Path | Role |
|---------|------|------|
| API | `backend/src/api/` | Ingest (fact log + outbox), commands on case and car aggregates, read APIs, timelines, ops, SSE |
| Analyzer | `backend/src/analyzer/` | Consumer group: live lane first, identity, trends, scoring, case decisions; detector-health job |
| Workers | `backend/src/workers/` | Relay, notifier, work-order integration, ack process manager with durable timers, projections |
| Replay | `backend/src/replay/` | Rebuild a projection from position 0 and compare; re-derive the wheelset-swap decision |
| Simulator | `backend/src/simulator/` | The scenario in compressed time; the component-swap demo |
| Frontend | `frontend/src/` | Alert queue, train heatmap, car trends, yard tablet, detector health, reliability, event timelines, Ops / Streams |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS, hand-written SVG charts
- **Backend:** Node.js, Express, TypeScript (tsx), zod, pg, ioredis, Pino, prom-client, bcryptjs
- **Data:** PostgreSQL 16 (event store and outbox, fact log, projections), Valkey 7 (Streams with consumer groups and a dead-letter stream, pub/sub, sessions)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (Option A), or PostgreSQL 16 and Valkey/Redis 7 installed natively (Option B)

### Option A: Docker Compose (recommended)

```bash
cd railcar-health
docker-compose up -d            # PostgreSQL 16 on 5432, Valkey 7 on 6379

cd backend
npm install
npm run db:migrate
npm run db:seed                 # rerunnable: wipes and reseeds reference data, users and history
npm run dev                     # API on :3000 + analyzer + workers (relay, consumers, projections)

# new terminal
cd frontend
npm install
npm run dev                     # http://localhost:5173

# new terminal: run the scenario (about 8 real minutes at 60×)
cd backend
npm run simulate                # or: npm run simulate:fast  (240×, about 2 minutes)
```

Stop with `docker-compose down` (add `-v` to delete the data).

### Option B: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey          # or: brew install redis
brew services start postgresql@16
brew services start valkey                 # or: brew services start redis

createuser railcar
psql postgres -c "ALTER USER railcar PASSWORD 'railcar_password'"
createdb -O railcar railcar_health
psql -U railcar -d railcar_health -c 'SELECT 1'   # verify PostgreSQL
valkey-cli ping                                   # verify Valkey (redis-cli ping for Redis)
```

Then follow the backend, frontend and simulator steps from Option A.

### Sign in

| User | Role | Notes |
|------|------|-------|
| `alice` | Dispatcher, West desk (Harlow and Prairie subs) | Alert queue, trains, detectors |
| `dan` | Dispatcher, East desk (Ridgeway sub) | |
| `bob` | Car inspector, Cedar Junction Yard | Yard queue, findings, holds |
| `erin` | Car inspector, Ridgeway Yard | |
| `carol` | Reliability engineer (admin) | Everything, plus thresholds and metrics |

Password for all: `password123`.

### Environment variables

| Variable | Default | Used by |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://railcar:railcar_password@localhost:5432/railcar_health` | API, analyzer, seed |
| `REDIS_URL` | `redis://localhost:6379` | All backend processes |
| `PORT` | `3000` | API |
| `ANALYZER_PORT` | `3010` | Analyzer health and metrics |
| `WORKERS_PORT` | `3011` | Workers health and metrics |
| `WORKER_ROLES` | `relay,projections,notifier,workorders,process` | Which workers a process runs |
| `API_URL` | `http://localhost:3000` | Simulator, Vite proxy target |
| `VITE_PORT` | `5173` | Frontend dev server |
| `INGEST_TOKEN` | `local-dev-ingest-token` | Gateways (`X-Ingest-Token`) |
| `CONSUMER_NAME` | `c-<pid>` | Consumer name within each group (a restart with the same name drains its own pending messages first) |
| `LATE_AFTER_MINUTES` | `15` | Live vs backfill lane, "late" badge |
| `OFFLINE_AFTER_MINUTES` | `25` | Detector offline (simulated minutes) |
| `APPROACH_WINDOW_MINUTES` | `30` | Warn the next yard about unacknowledged alerts |
| `STREAM_CLAIM_IDLE_MS` | `10000` | Retry or reclaim a pending message after this idle time |
| `STREAM_MAX_DELIVERIES` | `5` | Deliveries before a failing message is dead-lettered |
| `TIMER_POLL_MS` | `1000` | Process-manager timer poll interval |

### Running more instances

```bash
npm run dev:server1        # second API on :3001
npm run dev:worker1        # analyzer consumer "analyzer-1"
npm run dev:worker2        # analyzer consumer "analyzer-2": the group splits the lanes, the per-trip lock keeps one writer per trip
npm run dev:relay          # a relay alone (a second one waits as a hot standby)
npm run dev:projections    # projectors alone, e.g. to kill and restart them while events flow
```

## The Scenario

`npm run simulate` drives five trains over about eight simulated hours (60× by default; `--speed 240` for faster, `--api` to target another port):

| Train | What happens | Where to look |
|-------|--------------|---------------|
| M-HARRID EB | NRLX 304512 bearing R3 heats slowly: MEDIUM at MP 55, HIGH at MP 126, CRITICAL when the detector's own alarm fires at MP 230. The hold follows the train past Cedar Junction; the alert hands off from the West desk to the East desk at MP 160 | Alerts; train heatmap; car NRLX 304512 R3 |
| M-RIDHAR WB | NRLX 220187 was turned on a wye; the consist still has the old orientation. The AEI read at HBD-215 corrects it, earlier readings are re-mapped, and its warm L2 bearing matches its history (LOW) | Train view: "Orientation corrected by AEI"; car NRLX 220187 L2 across three trips |
| Q-HARCDJ EB | SVTX 961204 L1 jumps at HBD-112, whose gateway is offline. The batch arrives 70 minutes late, out of order, and is retried: a MEDIUM routed to Cedar Junction after the train arrived | Alerts (late badge); yard (bob) |
| G-RIDHAR WB | Stuck brake on PLNR 504433 (hot wheels, per-car brake alert). Four cars are set out at Cedar Junction: consist revision 2 | Alerts; heatmap |
| Z-HARRID EB | A warm-but-healthy bearing (LOW) and an inoperative brake on HPRX 377120 (cold wheels in both braking zones) | Alerts |

Detector faults: HBD-140 reads 20°F low (flagged biased), HBD-170 is silent (heartbeats fine, records nothing: a 30-mile coverage gap), HBD-112's gateway drops its link. About 5% of batches are re-sent to simulate lost acknowledgments. Nobody acknowledges in the simulation, so you'll see deadline escalations and approaching-yard warnings in each alert's timeline. Every arriving train gets one random audit inspection.

**Component-swap demo** (the "reading from 2 hours ago, wheelset replaced 1 hour ago" follow-up):

```bash
cd backend && npm run demo:component-swap
# 2. wheelset WS-2026-118842 installed on HPRX 555001 axle 2 ...
# 3. HBD-100 reconnects and uploads a pass measured 2 h ago (lag 120 min, backfill lane)
# 4. MEDIUM HPRX 555002 L2 ...   HPRX 555001: no alert. The reading predates its new wheelset.
```

## Events: replay, redrive, failure drills

Every state change is an event; [events.md](./events.md) lists them all. Useful commands and drills (run from `backend/`, stack up):

```bash
# Rebuild projections from position 0 and compare them row by row with the live tables
npm run replay -- alert-queue        # or car-history | detector-health | reliability | all
npm run replay -- all --keep         # leave the rebuilt tables in the `replay` schema to inspect

# Re-derive the "late reading after a wheelset swap" decision from events alone, in two orders
npm run demo:component-swap && npm run replay -- swap-case
```

**Dead letters and redrive** (as carol, or from the Ops / Streams page):

```bash
curl -s -c /tmp/carol -H 'Content-Type: application/json' -d '{"username":"carol","password":"password123"}' localhost:3000/api/v1/auth/login
# Make the yard integration fail for Ridgeway ("its maintenance system is down")
curl -s -b /tmp/carol -X PUT -H 'Content-Type: application/json' \
  -d '{"match":"\"yardId\":\"RDG\"","mode":"transient"}' localhost:3000/api/v1/ops/faults/workorder-sync
# ... run the scenario: Ridgeway work orders retry 5 times, then land in the dead-letter stream
curl -s -b /tmp/carol localhost:3000/api/v1/ops/dlq                          # error, attempts, raw event
curl -s -b /tmp/carol -X DELETE localhost:3000/api/v1/ops/faults/workorder-sync
curl -s -b /tmp/carol -X POST localhost:3000/api/v1/ops/dlq/<id>/redrive     # or POST /ops/dlq/redrive-all
```

**Kill a consumer between commit and ack** (the window at-least-once delivery exists for): set a `crash_after_commit` fault on `analyzer` matching one pass id, post passes, watch the analyzer die after committing, clear the fault, restart it. It drains its own pending messages first, finds the event in `processed_events`, and acks it as a duplicate: `rh_consumer_events_total{group="analyzer",outcome="duplicate"}` goes to 1 and no event is appended twice.

**Concurrent updates.** Acknowledge an alert with an old `version`: if only notifications or deliveries were appended since, the response says `rebasedOver: N`; if it escalated, you get 409 `STALE_ALERT` with `details.changed`. Record two different findings for one work order with two `clientSubmissionId`s: a defect after "no defect" supersedes it; "no defect" after a defect is 409 `FINDING_CONFLICT`.

## Demo Walkthrough

1. **alice** → **Alerts**: tier tabs, owner and ack-deadline badges, the late-data badge on SVTX 961204. Open NRLX 304512: the lifecycle stepper (delivered, not acknowledged), escalations, the handoff to the East desk, who was notified.
2. Click the train link: the heatmap's R3 column darkens detector by detector; HBD-112 is marked late, HBD-140 biased, and there is a "30 mi with no reading" break at the silent HBD-170.
3. Click **car history**: R3's trend crosses the LOW, MEDIUM and HIGH lines long before the critical reference. Try NRLX 220187 L2 for the cross-trip view.
4. **bob** → **Yard**: Cedar Junction's queue. Start the inspection on SVTX 961204 (that acknowledges it), record "journal bearing defect, bad order". The alert becomes *inspected* and the car stays held: try it in **Outbound build check**. Record a repair (finding "wheelset replaced") on another car to see it close.
5. **alice** → **Detectors**: the strip map, HBD-140 biased with its samples, HBD-170 silent with the trains it missed, coverage per detector.
6. **carol** → **Reliability**: precision by tier and by failure mode, the recall proxy, the audit defect rate, then change "MEDIUM level" to 45 and **Backtest against findings**.
7. **carol** → an alert → **case events**: the case's event stream with event time vs recorded time, the causation chain (PassRecorded → AxleReadingsRecorded → AlertRaised → hold, work order, notifications) and each payload. From a car page, **Event timeline** shows everything about the car; HPRX 555001 after the swap demo shows the old reading set aside.
8. **carol** → **Ops / Streams**: consumer lag and pending per group and topic, projection staleness, events per second, the dead-letter list with Redrive, and the fault injector.

## API

```bash
# Gateway ingest (idempotent). Demo train + payload helpers live in backend/scripts/.
cd backend
curl -s -H 'X-Ingest-Token: local-dev-ingest-token' -H 'Content-Type: application/json' \
  -d @scripts/consist-demo.json localhost:3000/api/v1/ingest/consists

NOW=$(curl -s localhost:3000/api/v1/clock | node -pe 'JSON.parse(require("fs").readFileSync(0)).now')
node scripts/make-batch.mjs HBD-025 0 0 $NOW > /tmp/fresh.json     # fresh pass
node scripts/make-batch.mjs HBD-010 90 2 $NOW > /tmp/late.json     # measured 90 min ago, car 2 hot

curl -s -H 'X-Ingest-Token: local-dev-ingest-token' -H 'Content-Type: application/json' -d @/tmp/fresh.json localhost:3000/api/v1/ingest/passes
# {"accepted":1,...,"lane":"live"}           -> 201
curl -s ... -d @/tmp/fresh.json ...          # same batch again
# {"accepted":0,"duplicates":1,...}          -> 200
curl -s ... -d @/tmp/late.json ...
# {"accepted":1,..."lagMinutes":90,"late":true,"lane":"backfill"}  -> a MEDIUM alert owned by the CDJ yard

# Sign in and use the read/workflow APIs
curl -s -c /tmp/bob -H 'Content-Type: application/json' -d '{"username":"bob","password":"password123"}' localhost:3000/api/v1/auth/login
curl -s -b /tmp/bob localhost:3000/api/v1/yards/CDJ/work-orders
curl -s -b /tmp/bob -H 'Content-Type: application/json' \
  -d '{"clientSubmissionId":"tablet-0001","finding":"no_defect_found","disposition":"release"}' \
  localhost:3000/api/v1/work-orders/<id>/finding          # 201; resend the same body -> 200 "replayed": true
```

Full endpoint list: [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend
npm run type-check && npm run lint && npm test     # 113 vitest tests: domain logic, aggregates, upcasting, consumer idempotency and DLQ routing, API

# Frontend
cd frontend
npm run type-check && npm run lint && npm run build

# Screenshots and smoke tests (from the repository root, stack running and the scenario simulated)
npm run screenshots railcar-health
npm run test:smoke railcar-health
```

## Screenshots

| | |
|---|---|
| ![Login](screenshots/01-login.png) | ![Alert queue](screenshots/02-alerts.png) |
| ![Train heatmap](screenshots/03-train-heatmap.png) | ![Car trend](screenshots/04-car-trend.png) |
| ![Yard inspection](screenshots/05-yard-inspection.png) | ![Detector health](screenshots/06-detectors.png) |
| ![Reliability](screenshots/07-reliability.png) | ![Car event timeline](screenshots/08-car-event-timeline.png) |
| ![Case timeline](screenshots/09-case-timeline.png) | ![Ops / Streams](screenshots/10-ops-streams.png) |

## Architecture Documentation

- [architecture.md](./architecture.md): production design, the event-driven design, trade-offs, implementation notes
- [events.md](./events.md): the event catalog (producers, consumers, keys, fields, versions, ordering, retention)
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
