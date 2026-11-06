# Track Hazard Detection - Development with Claude

## Project Context

The prompt: "Design a railroad sensor monitoring and incident detection platform. It ingests camera, vibration and temperature data, identifies track hazards, alerts personnel, and provides an operator dashboard. Connectivity is intermittent, and critical alerts must reach people within seconds."

**Signal: candidate report, not verified.** A firsthand Reddit account from a Senior/Staff Infrastructure Engineer candidate at BNSF Railway describes this prompt. It surfaced in a second research pass and was not opened or verified by us.

**Not the same project as [`railcar-health/`](../railcar-health/).** That one monitors *cars* (bearings, brakes) from wayside detectors as trains pass. This one monitors the *track and right-of-way*: rockfall, crossing obstructions, high water, rail-buckling risk. Both share the edge/cloud safety split: the field device protects trains by itself (a fence interlock drops a signal; a detector radios the crew), the cloud correlates, routes and records.

Public figures used: BNSF route miles (FY2025 10-K) and "Eyes on AI" volumes. Everything else (sensor counts, thresholds, confidences, heat bands, ack deadlines, slow-order speeds) is an illustrative assumption and is labeled so in the docs.

The design is in [architecture.md](./architecture.md) and the event catalog in [events.md](./events.md). This file records how it was built, what changed and what's open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Edge ingest (inbox + outbox), reads, hazard commands, ops, SSE |
| Relay | 3014 (metrics) | `backend/src/relay/index.ts` | Outbox → streams, priority order, leader lock, LISTEN/NOTIFY |
| Correlator | 3010 (metrics) | `backend/src/correlator/index.ts` | CEP: evidence, windows, watermarks, heat trend, coverage; tick (leader) |
| Alerting | 3011 (metrics) | `backend/src/alerting/index.ts` | Level-triggered process manager; durable timers (leader) |
| Projector | 3012 (metrics) | `backend/src/projector/index.ts` | Four replayable projections + train view; live notices |
| Notifier | 3013 (metrics) | `backend/src/notifier/index.ts` | Simulated console/pager/radio/phone; async delivery; sweeper |
| Simulator | - | `backend/src/simulator/index.ts` | Gateways, PTC feed, scripted afternoon (`scenario.ts`) |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to 3000 |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | - | Service named `redis` in docker-compose for the repo scripts |

## Development Phases

1. **Domain and events first.** Two subdivisions (Canyon MP 100-180, Prairie MP 180-260), 10-mile segments with one gateway each, 63 sensors. The envelope, the six edge event schemas (camera v1 and v2 with an upcaster), the domain event schemas, and the pure `reduceHazard` fold were written before any service.
2. **Write path.** Event store with per-stream versions and an append-only trigger; ingest as inbox + outbox in one transaction; the relay with lane priority and a leader lock.
3. **Consumer runtime.** One `StreamConsumer` for every group: priority lanes, ack after commit, in-place retry with backoff, DLQ, own-PEL recovery, XAUTOCLAIM, lag gauges.
4. **Correlator.** Rules as pure functions, an engine over a `CorrelatorStore` interface with a PostgreSQL and an in-memory implementation (so the order-independence and late-data tests run without a database), heat trend, coverage, the watermark tick.
5. **Process manager, projector, notifier.** Reconcile as one level-triggered function; projections as pure reducers shared by live apply and replay.
6. **API and UI.** Read models, commands with command ids and seen versions, SSE notices; the strip map, hazard detail (correlation chart, evidence, timeline), queue, restrictions, latency, event log, ops.
7. **Simulator and verification.** The scripted afternoon in real time, curl drills (duplicates, republish, kill -9 mid-backlog, redrive, replay, stale clear), Playwright screenshots, then the docs.

## Key Implementation Decisions (and why)

- **Hazards are event-sourced; telemetry is state + outbox.** The hazard stream is the audit trail and the timeline; raw readings are 25M/day in production and nobody folds them.
- **The correlator decides from the evidence set, not arrival order.** Join an open hazard if one covers the evidence, otherwise cluster unattached evidence in ±30 s / ±0.5 mi of event time, noisy-OR per sensor. The engine test shuffles a scenario 25 times and compares standing hazards (history may differ: Detected+Upgraded vs Detected-at-confirmed; that's why replay checks state, not history).
- **Corroboration that changes nothing appends nothing.** A second wire on the same fence, or the same water sensor reporting again, attaches the evidence row but emits no `HazardEvidenceAdded`. Without this the high-water hazard grew an event every 30 s.
- **Train-explained vibration** uses interpolation between PTC fixes, or extrapolation at the reported speed for up to 30 s. Train positions are written to `train_positions` at ingest, so the correlator sees them regardless of which topic it reads first; a late position explains spikes retroactively (`onTrainPosition`).
- **Downgrades never close.** A hazard whose evidence was all explained drops to LOW/unconfirmed but stays open; the alert keeps escalating until a person closes it.
- **The segment watermark is monotonic** and advances on processing time when a gateway is idle (`correlator/tick.ts`), so a reconnecting gateway's backlog is late by the stream-processing definition, not just "older than 30 s".
- **Halo locks**: the correlator takes advisory locks on every segment within the radius of the evidence (sorted, so no deadlocks), which is what makes partitioning by segment safe at boundaries.
- **The process manager is level-triggered** (`alerting/reconcile.ts`): every wake-up folds the stream and appends only what is missing. Timers, train movements and domain events share one function; redelivery is naturally a no-op. Severity raised re-issues the alert and clears the acknowledgment.
- **Commands check rules on the folded stream, not version equality.** Ack ignores the version; clear/false alarm refuse with 409 only if *material* events (evidence, upgrade) arrived after the seen version.
- **Projection idempotency is the stream version** (`projection_versions`), so the projector needs no processed-events table; replay checksums `key || doc::text` over the whole table.
- **The heat projection may raise the band by one step only.** Otherwise a fast trend alone produced "critical" at RNT + 23°F.
- **Notifier delivers after commit, asynchronously**, with deliveries keyed `event:channel:recipient`; train warnings go out one after another in ETA order.
- **Gateway sequence numbers survive restarts.** The simulator seeds them from the clock (a real gateway persists its counter).
- **Unknown sensor is transient, bad schema is permanent.** The former retries in place then dead-letters and is redriven after registration; the latter dead-letters at once.

## Deviations from Repo Defaults

- No Kafka: Valkey Streams with four partitions per topic, static partition ownership per instance, XAUTOCLAIM instead of rebalancing. Mapped to Kafka in architecture.md.
- One PostgreSQL for the inbox, event store, consumer state and read models; production would move raw telemetry to a columnar store.
- No chart library: the strip map, correlation chart and latency histogram are hand-written SVG.
- Six backend processes instead of the usual one or two, because each consumer group is the point of the exercise.

## Iteration & Repair Log

1. **Background simulator ingested nothing.** A restarted simulator started gateway sequences at 1 again, and ingest correctly dropped every event as a duplicate of the earlier run's `(gateway, seq)`. Fix: sequences seeded from the clock, as a persisted counter would behave; documented in `gateway.ts`.
2. **Rail temperature "projected 195°F".** The heat profile switched on as a step (+10°F to +30°F over RNT in one sample), and the 15-minute regression read it as a 6°F/min trend. Fix: continuous profiles from the start of the scenario, and the projection capped at one band above the current temperature.
3. **Tunnel hazard not upgraded by the late spike.** Camera 0.58 + spike 0.445 combine to 0.77, below the 0.8 confirm threshold. Retuned the scenario (0.66 + 0.47 → 0.82) rather than the threshold.
4. **Burst demo never saw its fence trip.** The second run tripped the same fence while the first run's hazard was still open, so the trip was absorbed as corroboration with no event. The demo now times the correlator's evidence row instead of a hazard event.
5. **Strip map labels clipped** ("ophone", "il temp"): left padding too small for the sensor-row labels.
6. **Timeline showed "+0 ms" on every row**: domain events default `occurred_at` to the append time. The delta is shown only when there is one (edge-triggered events).
7. **Critical-lane p99 of 3 s on the latency page** came from the deliberate `kill -9` drill (critical events waiting for the restart). Kept as an honest outlier; the screenshots come from a run without the drill.

## Verification Notes

- Verified with native PostgreSQL 16 and redis-server 7.0 (no Docker daemon available, so `docker-compose.yml` was written but not run).
- Drills run with curl: duplicate batch (accepted 0, duplicates 1), republished stream entry (consumer outcome `duplicate`), `kill -9` of the correlator during a 5,000-event backlog (exactly 5,000 processed rows, one hazard event for the fence trip), dead letters redriven after registering `GEO-118.9`, `npm run replay -- all` (all four MATCH), stale clear (409), cross-territory ack (403), retried command id (`replayed: true`).
- 48 vitest tests: upcasting, lane policy, correlation rules, order-independence, late upgrade, train-explained downgrade, redelivery no-ops, process-manager idempotency/escalation/compensation, replay equivalence with redeliveries, DLQ routing, API guards.

## Open Questions / Next Steps

- **Batch the bulk path** in the correlator (one transaction per 20 readings) before adding instances; it's the first thing to break in a reconnect storm.
- **Group-managed partitions** instead of static `CORRELATOR_PARTITIONS`.
- **An offline command queue for inspector tablets** (IndexedDB, command ids already in place, 409 review flow).
- **Image evidence**: store detection frames in object storage and show them on the hazard page.
- **Quarantine a misbehaving sensor** (a geophone that spikes constantly) instead of explaining it away train by train.
- **Downgrade noise**: a late PTC batch can produce several `HazardDowngraded` events in a row, one per position; coalescing them per batch would read better on the timeline.
