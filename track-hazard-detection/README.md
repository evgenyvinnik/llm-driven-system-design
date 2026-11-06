# Design a Railroad Track Hazard Detection Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,788 |
| Source Files | 167 |
| .ts | 7,478 |
| .tsx | 1,945 |
| .md | 1,668 |
| .sql | 319 |
| .json | 181 |

## Overview

An event-driven sensor monitoring and incident detection platform for the **track and right-of-way**. Edge gateways beside the track forward camera, vibration (geophone), slide-fence, rail-temperature and water-level events over links that drop out. The platform correlates them into hazards, alerts the dispatcher who owns the territory within seconds, warns approaching trains, tracks slow orders and inspector dispatch, and keeps every incident as an auditable event stream.

The field tier protects trains on its own: a broken slide-fence wire drops the protecting signal to red through a local interlock, with or without the cloud. This platform adds what no single device can do:

- **Correlation in event time.** A camera obstruction plus a vibration spike within 30 s and 0.5 mi is one confirmed hazard; five sensors seeing one rockfall are one hazard. Vibration from passing trains is explained by interpolated train positions, retroactively when a PTC report is late. The same events in any order give the same hazards.
- **Store-and-forward edge, watermarks, late data.** Gateways buffer with sequence numbers and send critical events first; a silent gateway's segment watermark advances on processing time, so its backlog arrives *late*, is processed anyway, and can upgrade or downgrade a hazard.
- **A priority lane at every hop.** Gateway, ingest, outbox relay, topics and consumers all put critical events first: with a 4,300-event bulk backlog outstanding, a new fence trip is acted on in ~60 ms.
- **A hazard-response process manager.** Alerts routed to the territory's desk with durable ack-deadline timers and escalation; CRITICAL hazards warn approaching trains nearest first; standing heat orders for rail-buckling risk; compensation (lift slow orders, release trains) when a hazard closes.
- **Event-driven throughout.** Hazards are event-sourced streams in a PostgreSQL event store; edge telemetry is an inbox with a transactional outbox. An outbox relay publishes to partitioned Valkey streams (standing in for Kafka, keyed by track segment) consumed by idempotent consumer groups: correlator, process manager, projector, notifier. Dead letters with redrive, schema upcasting (camera v1 → v2), consumer lag and replayable projections.

This project is not [`railcar-health/`](../railcar-health/), which monitors railcars (bearings and brakes) from wayside detectors. Here the subject is the track itself.

See [architecture.md](./architecture.md) for the design, [events.md](./events.md) for the event catalog, and [CLAUDE.md](./CLAUDE.md) for how it was built and what broke along the way.

## Architecture

```
gateways (store-and-forward) ─┐
PTC train positions ──────────┤
                              ▼
                   Ingest API ──(inbox + outbox, one txn)──▶ PostgreSQL
                                                              │ outbox relay: critical > domain > trains > bulk
                                                              ▼
                 th:edge.critical · th:edge.bulk · th:trains · th:domain   (Valkey Streams, 4 partitions each)
                       │                │                         │
                   correlator ◀─────────┘            alerting (process manager), projector, notifier
                       │ hazard events → event store + outbox → th:domain
                       ▼
                 API + SSE ──▶ React dashboard (strip map, hazard timeline, alert queue, slow orders, latency, ops)
```

| Process | Default port | Entry point |
|---------|--------------|-------------|
| API (ingest, reads, commands, SSE) | 3000 | `backend/src/api/index.ts` |
| Outbox relay | 3014 (metrics) | `backend/src/relay/index.ts` |
| Correlator (CEP) | 3010 (metrics) | `backend/src/correlator/index.ts` |
| Alerting (process manager) | 3011 (metrics) | `backend/src/alerting/index.ts` |
| Projector | 3012 (metrics) | `backend/src/projector/index.ts` |
| Notifier (simulated channels) | 3013 (metrics) | `backend/src/notifier/index.ts` |
| Simulator | - | `backend/src/simulator/index.ts` |
| Frontend | 5173 | `frontend/` (Vite proxies `/api` to 3000) |

## Tech Stack

- **Backend:** Node.js 20+, Express, TypeScript (ESM), pg, ioredis, zod, pino, prom-client, vitest
- **Frontend:** React 19, Vite, TanStack Router, Zustand, Tailwind CSS (hand-written SVG for the strip map and charts)
- **Infrastructure:** PostgreSQL 16 (event store, inbox, outbox, read models), Valkey 7 (Streams as Kafka, sessions, pub/sub)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (Option A) or PostgreSQL 16 and Valkey/Redis 7 installed natively (Option B)

### Option A: Docker Compose (recommended)

```bash
cd track-hazard-detection
docker-compose up -d

cd backend
npm install
npm run db:migrate
npm run db:seed          # reference data, users, a few days of closed hazards; wipes the streams
npm run dev              # api, relay, correlator, alerting, projector, notifier

# new terminal
cd frontend && npm install && npm run dev      # http://localhost:5173

# new terminal: the scripted afternoon (about 7 real minutes), then background traffic
cd backend && npm run simulate -- --duration 1800
```

Useful commands: `docker-compose down` (stop), `docker-compose down -v` (stop and delete data).

### Option B: Native services (no Docker)

```bash
# macOS
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey

psql postgres -c "CREATE ROLE hazard LOGIN PASSWORD 'hazard_password' CREATEDB"
psql postgres -c "CREATE DATABASE track_hazard OWNER hazard"
pg_isready && valkey-cli ping
```

Then run the backend, frontend and simulator steps from Option A.

### Sign in

All passwords are `password123`.

| User | Role | Sees |
|------|------|------|
| `alice` | Dispatcher, West desk (Canyon Sub) | Board, alert queue for her desk, acts on Canyon hazards |
| `dan` | Dispatcher, East desk (Prairie Sub) | Same for the Prairie Sub |
| `bob`, `erin` | Track inspectors | Their dispatches; can clear or call a false alarm |
| `carol` | Platform operator (admin) | Everything, plus DLQ redrive, sensor registry and replay |

### Environment variables

```bash
DATABASE_URL=postgresql://hazard:hazard_password@localhost:5432/track_hazard
REDIS_URL=redis://localhost:6379
PORT=3000                      # API
CORRELATOR_PORT=3010 ALERTING_PORT=3011 PROJECTOR_PORT=3012 NOTIFIER_PORT=3013 RELAY_PORT=3014
API_URL=http://localhost:3000  # where the simulator posts
INGEST_TOKEN=local-dev-ingest-token
STREAM_PARTITIONS=4
CORRELATOR_PARTITIONS=0-3      # static partition ownership per instance (e.g. 0,1 and 2,3 for two instances)
VITE_PORT=5173                 # frontend; API_URL also sets the Vite proxy target
```

Thresholds (correlation window, confidence thresholds, heat bands, ack deadlines) are in `backend/src/shared/config.ts`, each overridable by an environment variable. All are illustrative.

### Running more instances

```bash
npm run dev:server1      # API on 3001
npm run dev:server2      # API on 3002
CORRELATOR_PARTITIONS=0,1 CORRELATOR_CONSUMER=correlator-1 CORRELATOR_PORT=3010 npx tsx src/correlator/index.ts
CORRELATOR_PARTITIONS=2,3 CORRELATOR_CONSUMER=correlator-2 CORRELATOR_PORT=3020 npx tsx src/correlator/index.ts
```

The relay and the timer sweep elect a leader in Valkey, so extra instances are standbys.

## The Scenario

`npm run simulate` plays a scripted afternoon on two subdivisions (MP 100-260, 16 segments, 63 sensors, 4 trains), all in real time:

| t (s) | What happens | What to look for |
|-------|--------------|------------------|
| 0 | Hot afternoon: rail temperature climbs on PRA-3 and PRA-4 | Heat risk elevated → MEDIUM alert + automatic 40 mph order; PRA-3 later critical → 25 mph |
| 20 | GEO-122.0 dies | Gateway reports SensorHeartbeatMissed → coverage gap hatched at MP 121-123 |
| 45 | Tunnel camera sees debris (0.66) | HIGH obstruction, alert to alice |
| 55-175 | GW-CAN-4 loses its link, buffers a confirming spike | Segment shown "GW SILENT"; on reconnect the spike arrives late and upgrades the hazard to CRITICAL; one batch is delivered twice |
| 90 | Rockfall at MP 147.8: two fence wires + a geophone | One CRITICAL hazard, C-COALWB warned |
| 150 | GW-PRA-1 uploads a 3,000-event backlog | Bulk lag on the ops page; critical lane unaffected |
| 153-159 | Vehicle on the Hwy 9 crossing (0.71), then a spike | HIGH, then CRITICAL; two trains warned nearest first; a lost reply makes the gateway resend (duplicates) |
| 230-260 | Malformed water reading, readings from an unregistered geophone, a v3 camera event | Three dead letters (SCHEMA_INVALID, UNKNOWN_SENSOR after retries, UNSUPPORTED_VERSION) |
| 270-370 | Q-CANEXP's PTC reports are held back while it passes two geophones | Suspected rockfall (HIGH); when the late positions arrive it is downgraded to LOW, never closed automatically |
| 280+ | Bridge 171.2 water rises | High water HIGH |

Unacknowledged alerts escalate on their deadlines (CRITICAL 60 s): desk dispatcher → chief dispatcher → manager of operations.

## Events: replay, redrive, failure drills

```bash
# Rebuild projections from position 0 and compare checksums with the live tables
npm run replay -- all          # or: hazards | alerts | restrictions | coverage
#   hazards  replayed 79 events in 86 ms | live 12 rows 763396e67d67 | rebuilt 12 rows 763396e67d67 | MATCH

# Priority lane: a 5,000-event backlog, then a critical fence trip
npm run demo:burst -- --backlog 5000
#   correlator decided on the fence trip 56 ms after it occurred
#   correlator bulk lane backlog at that moment: 4316

# Redrive: register the unknown sensor (ops page "Register sensor"), then "Redrive" its dead letter.
# Kill a consumer mid-stream: kill -9 the correlator during demo:burst and restart it; it reprocesses
# its own pending entries first, and processed_events makes the committed ones no-ops.
```

## API

```bash
# Gateway ingest (idempotent on (gateway, seq))
curl -X POST localhost:3000/api/v1/ingest/batches -H 'Content-Type: application/json' \
  -H 'X-Ingest-Token: local-dev-ingest-token' -d @batch.json
# {"accepted":1,"duplicates":0,"critical":1,"late":0}    first time
# {"accepted":0,"duplicates":1,"critical":0,"late":0}    the same batch again

# Sign in, read, command
curl -c c.txt -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"dan","password":"password123"}'
curl -b c.txt localhost:3000/api/v1/board
curl -b c.txt -X POST localhost:3000/api/v1/hazards/<id>/commands -H 'Content-Type: application/json' \
  -d '{"commandId":"<uuid>","seenVersion":4,"command":{"kind":"acknowledge"}}'
# 201 {"appended":["AlertAcknowledged"],"replayed":false,...}; the same commandId again → 200 replayed:true
# clear with a stale seenVersion → 409 HAZARD_CHANGED; a West-desk dispatcher on a Prairie hazard → 403 NOT_YOUR_TERRITORY
```

The full endpoint list is in [architecture.md](./architecture.md#api-design).

## Development

```bash
# Backend
cd backend && npm run type-check && npm test && npm run lint

# Frontend
cd frontend && npm run type-check && npm run build && npm run lint

# Screenshots and smoke tests (from the repository root, stack running and the scenario simulated)
npm run screenshots track-hazard-detection
npm run test:smoke track-hazard-detection
```

## Screenshots

| | |
|-|-|
| ![Operator board](screenshots/02-operator-board.png) | ![Hazard correlation](screenshots/03-hazard-correlation.png) |
| ![Event timeline](screenshots/04-hazard-timeline.png) | ![Alert queue](screenshots/05-alert-queue.png) |
| ![Latency budget](screenshots/07-latency-budget.png) | ![Streams and DLQ](screenshots/08-streams-dlq.png) |

## Architecture Documentation

- [architecture.md](./architecture.md): production design, edge/cloud boundary, correlation, watermarks, process manager, Kafka mapping, implementation notes
- [events.md](./events.md): every event, producer, consumers, key, schema and version history
- [system-design-answer-backend.md](./system-design-answer-backend.md), [frontend](./system-design-answer-frontend.md), [fullstack](./system-design-answer-fullstack.md): 45-minute interview answers
