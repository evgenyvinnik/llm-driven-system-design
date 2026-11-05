# Railcar Health - Development with Claude

## Project Context

The prompt: "Design a hot-bearing / hot-wheel monitoring and predictive maintenance system for a fleet of ~200,000 railcars using wayside detector data, including risk alerts and the yard response."

**Signal: candidate report, not verified.** A candidate reported this exact prompt in a BNSF Railway phone screen. BNSF publicly describes AI over wayside detector data for condition-based maintenance ("Eyes on AI").

Public sources the design leans on (cited in architecture.md, not independently verified):

- BNSF, "Eyes on AI": thermal sensors and machine vision over 1.5M+ wheels; 35M+ wayside readings/day processed by AI; 2M+ machine-vision images/day.
- AAR, March 2023 Class I commitments after East Palestine: HBDs on key routes at an average 15-mile spacing (max 20 miles where acoustic bearing detection exists); a standard for trend analysis of HBD readings; ~1,000 detectors added to ~6,000 in service.
- NTSB, East Palestine (2023): three HBDs in ~30 miles; the first two showed rising temperatures on the 23rd car below alarm thresholds; only the last reached critical.
- Railinc EHMS: routes detector-based alerts to car owners and railroads; ~10,000 wayside detectors, 36M train passes/yr. Most North American railcars are owned by lessors/shippers.
- BNSF Brake Health Effectiveness: thermal (hot/cold wheel) detectors judge brake health under an FRA test waiver; rail unions contest using it to replace manual inspections.

All other numbers (capacity, thresholds, ack deadlines, seeded precision) are illustrative assumptions. Alarm thresholds are configurable, never presented as regulatory values.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Ingest, read APIs, yard workflow, admin, SSE, republish sweep |
| Analyzer | 3010 (metrics) | `backend/src/analyzer/index.ts` | Two-lane consumer; health job; lifecycle sweeper |
| Simulator | - | `backend/src/simulator/index.ts` | Posts to the API; publishes the sim clock to Valkey |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to 3000 |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | - | Service named `redis` in docker-compose for the repo scripts |

## Development Phases

1. **Domain model and network.** A fictional railroad (Plains & Northern, invented reporting marks), one 240-mile line in three subdivisions under two dispatcher desks, 16 HBDs ~15 mi apart (5 with AEI, 2 in braking zones), 3 yards. Car-relative geometry (axle 1 at the B-end, sides facing A from B) written first with an inverse function, and unit-tested both ways.
2. **Ingest and schema.** Idempotent passes keyed by `(detector_id, pass_id)`, raw readings immutable with derived identity columns, retry-driven publish plus a republish sweep.
3. **Analyzer.** Identity resolution with AEI correction and re-resolution; trend features from per-bearing observation lists; explainable rule tiers; alert planning (open / escalate / refresh, never de-escalate); holds, work orders, notification outbox; late-data routing; detector health from neighbours and expected passes.
4. **Simulator.** Five trains with a heating bearing, a turned car with a stale consist, a late gateway batch delivered out of order and retried, a biased and a silent detector, and a stuck brake. Run at 240× and checked in SQL after each change.
5. **API and frontend.** Read APIs, SSE, the yard workflow; React pages for the queue, train heatmap, car trend, yard tablet, detectors and reliability.
6. **Mid-build requirements from the coordinator** (folded in after the first full run):
   - **Component lifecycle**: wheelset installs as events with event and processing time, an event-time filter in scoring and history, `component_replaced` closures, and `npm run demo:component-swap` for the "reading from 2 h ago, wheelset replaced 1 h ago" follow-up.
   - **Delivered ≠ acknowledged ≠ inspected ≠ closed**: owners, tier deadlines, an escalation chain, an approaching-yard warning, handoffs across desks and yards, an audit trail, a simulated notifier.
   - **Live and backfill lanes** chosen at ingest by lag, with per-detector coverage state for operators.
   - **What a prediction means**: inspection priority over the next-terminal horizon, rules as the floor, label bias handled by random audit inspections on every arrival (plus `routine` and `teardown` finding sources).
   - **Bearings vs brakes**: `hot_wheel` (stuck brake) and `cold_wheel` (inoperative brake, braking zones only) as per-car brake alerts with their own findings and actions.
   - **Consist versions by time** for trains rebuilt at a yard (G-RIDHAR sets out four cars at Cedar Junction).
7. **Tests, docs, screenshots.** 79 vitest tests; architecture and three interview answers; Playwright screenshots.

## Key Implementation Decisions (and why)

- **Per-bearing state is recomputed from the trip's observations on every pass** rather than kept incrementally. At ≤16 points per bearing it is free, and late, duplicated and re-resolved data all give the in-order answer.
- **The tier is the maximum over every event-time prefix** of a bearing's observations, not the score of the latest one. Alerts never de-escalate, so this is exactly what in-order processing would have decided (see the repair log, item 6).
- **Medians are computed over every car in the pass**, before install filtering, so dropping a replaced wheelset's readings doesn't move the train-side baseline.
- **A per-trip PostgreSQL advisory lock** stands in for Kafka partitioning by trip: two analyzers in one consumer group can't interleave a trip's passes.
- **Stream messages are pointers** (`detectorId`, `passId`); the analyzer reads the pass from PostgreSQL. Production would carry payloads.
- **Brake alerts are per car** (position `CAR`): a stuck brake heats all eight wheels, and eight alerts for one car was the first run's result.
- **Alert `version` changes only on decisions** (tier, status, owner), not on telemetry refreshes, so a dispatcher's acknowledgment doesn't 409 every time a new pass arrives.
- **A simulation clock in Valkey** (`rh:sim:clock`): the simulator anchors it so the scenario ends at about real time, then hands back to 1×. The API stamps `received_at` with it, and the UI computes ages from the server's clock in every response. Operational timestamps (`inserted_at`, `processed_at`) stay on database time.
- **Every pass carries its train id** (simplification); production matches non-AEI passes to trains by train-movement positions.
- **SSE carries ids only**; pages refetch. No client-side alert store mutated by deltas.
- **ESLint `react-refresh` config** allows the `Route` export name, and route components are exported, because plugin 0.5 flags local components in files that export a non-component.

## Deviations from Repo Defaults

- No Cassandra/ClickHouse/Kafka: PostgreSQL holds raw readings and Valkey Streams stand in for Kafka, to keep the local stack to two services. Documented in architecture.md Implementation Notes.
- No ML model: rules stand in for the rules tier, and a backtest re-scores stored features against findings.
- Charts are hand-written SVG (heatmap, trend, strip map) rather than a chart library, to keep the bundle small and the heatmap fast.

## Iteration & Repair Log

1. **Eight alerts for one stuck brake.** Wheel scoring ran per wheel position. Fix: aggregate brake alerts per car (hottest or coldest wheel speaks for it, "8 of 8 wheels hot" in the reasons).
2. **A MEDIUM's work order stayed at a yard the train had passed.** The sim train went through Cedar Junction uninspected and the work order still pointed there. Fix: re-point the hold and work order to the next yard, with an audit event. A later refactor tied this to yard-owned alerts only, which brought the bug back for an alert that escalated to dispatcher ownership (its hold stayed at CDJ). Found in a screenshot; fixed by re-pointing holds whoever owns the alert.
3. **Escalation events showed "to CRITICAL"** because the timeline reused the tier column for the escalation level. Fix: the drawer only labels tiers on opened/escalated events.
4. **Heatmap hid the very bearing it highlighted**: a 3 px column under a 1.2 px outline. Fix: rails on either side of the column, wider cells, the delta-vs-median view by default (above ambient made braking-zone rows dominate), and dashed "30 mi with no reading" breaks where a detector was silent.
5. **Late hot reading ignored.** A curl replay posted a fresh normal pass at HBD-025, then a 90-minute-old pass from HBD-010 with a +56°F bearing. Features were correct (order-independent), but scoring only the latest observation saw the normal reading, so no alert. On time, that reading would have opened a MEDIUM that never de-escalates. Fix: score the maximum over event-time prefixes; regression test in `risk.test.ts`.
6. **The component-swap demo polluted detector health.** Its demo trip skipped detectors, which counted as "missed trains". Fix: the demo runs westbound from Cedar Junction over contiguous detectors and posts an arrival.
7. **Holds table unreadable on a tablet**: long reason text in a narrow column. Fix: the reason moves to a tooltip.

## Verification Environment Notes

- Verified with native PostgreSQL 16 (`initdb` as the `postgres` user, port 54331) and redis-server 7.0 (port 63831); API on 3101, analyzer metrics on 3102, Vite on 5191. No Docker daemon was available, so `docker-compose.yml` was written but not run.
- `node scripts/sloc.mjs railcar-health --summary` was used for the README stats.

## Open Questions / Next Steps

- **Detector-fault quarantine.** Bias detection is implemented; automatically quarantining a faulty detector's absolute-only alerts into one maintenance ticket is described but not built.
- **A real model** behind the priority score, trained on findings weighted for how each car came to be inspected (alert, audit, routine, teardown).
- **Teardown ingestion** from bearing shops (the finding source exists).
- **Train matching for non-AEI passes** from train-movement data instead of trusting a train id on every pass.
- **WILD, acoustic and vision** detectors as additional evidence for the same bearing and wheel identities.
- **Alert-storm guard** per detector and per desk (rate limits on pages, not on alerts).
