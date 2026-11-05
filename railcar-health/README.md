# Design a Railcar Health Monitoring System

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,308 |
| Source Files | 169 |
| .ts | 7,233 |
| .tsx | 2,104 |
| .md | 1,197 |
| .sql | 356 |
| .json | 197 |

## Overview

Hot-bearing and hot/cold-wheel monitoring and predictive maintenance for a railcar fleet, built on wayside detector data. Wayside detectors measure every axle of every passing train, and each detector radios its own alarm to the crew when a bearing crosses its absolute threshold. That safety path stays local. This system adds what a single detector can't see:

- **Trending across detectors.** Each bearing is compared with the median of its own train side at every detector, and its rise per 15 miles is tracked. A failing bearing goes MEDIUM 175 miles before the detector's own alarm would fire (the pattern NTSB described at East Palestine).
- **Stable identity.** Axle N on the north rail becomes "car NRLX 304512, bearing R3", through stale consists, cars turned on a wye (corrected by AEI reads), trains rebuilt at a yard (consist versions by time) and wheelset replacements (component installs in event time).
- **Correct under bad delivery.** Store-and-forward gateways deliver at-least-once, out of order and hours late. Idempotent ingest, a live and a backfill lane, and order-independent per-bearing state give the same answer as perfect data.
- **Alerts with owners.** Opened → delivered → acknowledged → inspected → closed, with tier deadlines, escalation (desk → chief dispatcher → operations center), warnings when an unacknowledged car's train is approaching its yard, and handoffs across desks and yards.
- **The yard response.** Car holds that block outbound builds, work orders, an offline-tolerant tablet finding form, repairs recorded as wheelset installs, random audit inspections against label bias, and precision/recall from findings with a threshold backtest.
- **Bearings and brakes kept apart.** Hot bearings (journal bearing failure) vs hot wheels (stuck brake) and cold wheels (inoperative brake).

See [architecture.md](./architecture.md) for the design and trade-offs, and [CLAUDE.md](./CLAUDE.md) for how it was built, the interview signal and sources, and what broke along the way.

## Architecture

```
simulator ──HTTP──▶ API (:3000) ──▶ PostgreSQL (passes, readings, consists, alerts, holds, findings, installs)
 5 trains,           │   └─ XADD ──▶ Valkey streams  rh:passes:live  /  rh:passes:backfill
 faults, 60× clock   │                                │
                     │                                ▼
 browser (:5173) ◀───┤◀── pub/sub ◀───── analyzer: identity · trends · scoring · alerts
   SSE + REST        │                    detector health · ack-deadline sweeper · notifier
```

| Process | Path | Role |
|---------|------|------|
| API | `backend/src/api/` | Idempotent ingest, read APIs, yard workflow, admin, SSE, republish sweep |
| Analyzer | `backend/src/analyzer/` | Two-lane consumer group, identity resolution, trend features, risk scoring, alert lifecycle, detector health |
| Simulator | `backend/src/simulator/` | The scenario in compressed time; the component-swap demo |
| Frontend | `frontend/src/` | Alert queue, train heatmap, car trends, yard tablet, detector health, reliability |

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS, hand-written SVG charts
- **Backend:** Node.js, Express, TypeScript (tsx), zod, pg, ioredis, Pino, prom-client, bcryptjs
- **Data:** PostgreSQL 16, Valkey 7 (Streams with consumer groups, pub/sub, sessions)

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
npm run dev                     # API on :3000 + analyzer

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
| `API_URL` | `http://localhost:3000` | Simulator, Vite proxy target |
| `VITE_PORT` | `5173` | Frontend dev server |
| `INGEST_TOKEN` | `local-dev-ingest-token` | Gateways (`X-Ingest-Token`) |
| `ANALYZER_CONSUMER` | `analyzer-<pid>` | Consumer name in the group |
| `LATE_AFTER_MINUTES` | `15` | Live vs backfill lane, "late" badge |
| `OFFLINE_AFTER_MINUTES` | `25` | Detector offline (simulated minutes) |
| `APPROACH_WINDOW_MINUTES` | `30` | Warn the next yard about unacknowledged alerts |
| `STREAM_CLAIM_IDLE_MS` | `30000` | Reclaim pending messages from a dead consumer |

### Running more instances

```bash
npm run dev:server1        # second API on :3001
npm run dev:worker1        # analyzer consumer "analyzer-1"
npm run dev:worker2        # analyzer consumer "analyzer-2": the group splits the lanes, the per-trip lock keeps one writer per trip
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

## Demo Walkthrough

1. **alice** → **Alerts**: tier tabs, owner and ack-deadline badges, the late-data badge on SVTX 961204. Open NRLX 304512: the lifecycle stepper (delivered, not acknowledged), escalations, the handoff to the East desk, who was notified.
2. Click the train link: the heatmap's R3 column darkens detector by detector; HBD-112 is marked late, HBD-140 biased, and there is a "30 mi with no reading" break at the silent HBD-170.
3. Click **car history**: R3's trend crosses the LOW, MEDIUM and HIGH lines long before the critical reference. Try NRLX 220187 L2 for the cross-trip view.
4. **bob** → **Yard**: Cedar Junction's queue. Start the inspection on SVTX 961204 (that acknowledges it), record "journal bearing defect, bad order". The alert becomes *inspected* and the car stays held: try it in **Outbound build check**. Record a repair (finding "wheelset replaced") on another car to see it close.
5. **alice** → **Detectors**: the strip map, HBD-140 biased with its samples, HBD-170 silent with the trains it missed, coverage per detector.
6. **carol** → **Reliability**: precision by tier and by failure mode, the recall proxy, the audit defect rate, then change "MEDIUM level" to 45 and **Backtest against findings**.

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
npm run type-check && npm run lint && npm test     # 79 vitest tests (pure logic + supertest API tests)

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
| ![Reliability](screenshots/07-reliability.png) | |

## Architecture Documentation

- [architecture.md](./architecture.md): production design, trade-offs, implementation notes
- [system-design-answer-backend.md](./system-design-answer-backend.md): backend interview answer
- [system-design-answer-frontend.md](./system-design-answer-frontend.md): frontend interview answer
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md): full-stack interview answer
