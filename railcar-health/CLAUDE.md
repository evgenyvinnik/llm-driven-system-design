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
| API | 3000 | `backend/src/api/index.ts` | Ingest (fact log + outbox), commands on case/car aggregates, read APIs, timelines, ops, SSE |
| Analyzer | 3010 (metrics) | `backend/src/analyzer/index.ts` | Consumer group `analyzer` (live lane first); detector-health job |
| Workers | 3011 (metrics) | `backend/src/workers/index.ts` | Relay; notifier; workorder-sync; ack-process + durable timers; four projections (`WORKER_ROLES`) |
| Replay | - | `backend/src/replay/index.ts` | `npm run replay -- <projection|all|swap-case>` |
| Simulator | - | `backend/src/simulator/index.ts` | Posts to the API; publishes the sim clock to Valkey |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to 3000 |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | - | Service named `redis` in docker-compose for the repo scripts |

## Development Phases

1. **Domain model and network.** A fictional railroad (Plains & Northern, invented reporting marks), one 240-mile line in three subdivisions under two dispatcher desks, 16 HBDs ~15 mi apart (5 with AEI, 2 in braking zones), 3 yards. Car-relative geometry (axle 1 at the B-end, sides facing A from B) written first with an inverse function, and unit-tested both ways.
2. **Ingest and schema.** Idempotent passes keyed by `(detector_id, pass_id)`, raw readings immutable with derived identity columns, retry-driven publish plus a republish sweep (replaced by the transactional outbox in phase 8).
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
8. **Event-driven rework** (second round, to make the project a reference example of an event-driven application):
   - **Event store** (`events` table): append-only (trigger), per-stream versions, expected-version appends, global positions in commit order, correlation/causation, tags for cross-stream timelines. The same table is the outbox for state-based writes.
   - **Aggregates**: the case (`domain/case.ts`: alert or audit plus the yard response) and the car (`domain/car.ts`: component history) are event-sourced; `alerts`, `car_holds`, `work_orders`, `findings`, `notifications`, `component_installs` became projections. Raw readings stay a fact log (volume, no invariants), announced by `PassRecorded` and the claim-check `AxleReadingsRecorded` in the ingest transaction.
   - **Relay → Valkey streams per family → consumer groups**, with a shared runtime (`events/consumer.ts`): processed-events dedupe and checkpoint in the effect's transaction, ack after commit, XCLAIM redelivery, bounded retries, a dead-letter stream with redrive, fault injection.
   - **Choreography** for integrations (notifier, workorder-sync, projections); **one process manager** (`workers/ack-process.ts`) for acknowledgment deadlines, escalation, approaching-yard warnings, handoffs and hold moves, on durable timers polled with `SKIP LOCKED`. Handoffs moved out of the analyzer into it.
   - **Schema evolution**: `InspectionFindingRecorded` v1 → v2 (`source`, `supersedesFindingId`) with an upcaster; seeded findings older than 30 days are stored as v1.
   - **Replay**: projections rebuilt from position 0 into a `replay` schema and compared row by row inside one snapshot; `swap-case` re-derives the wheelset-swap decision from events in two orders.
   - **Frontend**: `/timeline?car=|case=` (envelope, two clocks, lineage, payload, causation chain) and `/ops` (lag, staleness, events/s, dead letters with redrive, fault injector).
   - **Docs**: `events.md`, the Event-Driven Design section of architecture.md, an event-driven deep dive in each answer.

## Key Implementation Decisions (and why)

- **Per-bearing state is recomputed from the trip's observations on every pass** rather than kept incrementally. At ≤16 points per bearing it is free, and late, duplicated and re-resolved data all give the in-order answer.
- **The tier is the maximum over every event-time prefix** of a bearing's observations, not the score of the latest one. Alerts never de-escalate, so this is exactly what in-order processing would have decided (see the repair log, item 6).
- **Medians are computed over every car in the pass**, before install filtering, so dropping a replaced wheelset's readings doesn't move the train-side baseline.
- **A per-trip PostgreSQL advisory lock** stands in for Kafka partitioning by trip: two analyzers in one consumer group can't interleave a trip's passes.
- **Readings travel by claim check.** Broker messages carry full event envelopes, except that `AxleReadingsRecorded` names the fact-log rows `(detectorId, passId)` instead of carrying ~700 readings; the analyzer reads them from PostgreSQL. (Before the rework, every stream message was such a pointer.)
- **Brake alerts are per car** (position `CAR`): a stuck brake heats all eight wheels, and eight alerts for one car was the first run's result.
- **A stale acknowledgment is refused only when a decision changed.** Originally the alert row's `version` moved only on decisions. Since the rework the version is the case stream's version, which also moves on bookkeeping (notifications, deliveries, timers); the acknowledgment rule rebases over those and returns 409 only for decision events, so a dispatcher still doesn't 409 every time a page is delivered.
- **A simulation clock in Valkey** (`rh:sim:clock`): the simulator anchors it so the scenario ends at about real time, then hands back to 1×. The API stamps `received_at` with it, and the UI computes ages from the server's clock in every response. Operational timestamps (`inserted_at`, `processed_at`) stay on database time.
- **Every pass carries its train id** (simplification); production matches non-AEI passes to trains by train-movement positions.
- **SSE carries ids only**; pages refetch. No client-side alert store mutated by deltas.
- **ESLint `react-refresh` config** allows the `Route` export name, and route components are exported, because plugin 0.5 flags local components in files that export a non-component.

### Event-driven decisions (second round)

- **One table for the event store and the outbox.** One relay, one ordering, one place for timelines. The stream type says which role an event plays (`case`/`car`/`detector` = source of truth; `pass`/`trip` = outbox).
- **Global positions under a short advisory lock** taken in `EventBatch.commit`, the last step of every transaction, so positions become visible in commit order and the relay can tail by position without gap handling. Writers stage events during the transaction and commit the batch at the end.
- **`case_index` is a write-side table, not a projection**: one open alert per bearing per trip, one audit per trip, and the outbound hold check (a stale projection could let a held car out). Updated in the same transaction as the case's events by `syncCaseIndex`.
- **The analyzer reads car streams directly** (`loadCars`) for install cutoffs: decisions read aggregates, never projections.
- **Case streams hold decisions only.** Per-pass feature refreshes are `BearingTrendUpdated` on the trip stream, so a case's version moves on decisions plus bookkeeping (notifications, deliveries, timers), and the acknowledgment rule rebases over bookkeeping (`DECISION_EVENTS` in `events/catalog.ts`).
- **Projections are deterministic and commutative across families**: values only from events (ids generated by deciders, times from `occurred_at`), and the one cross-family update (trend telemetry) is last-writer-wins by global position in its own table. That is what lets `replay` compare row for row.
- **SSE notices are sent by projectors after they commit**, enriched with yard/desk from the read model so the per-viewer filter works; commands answer from the aggregate (read-your-writes).
- **Causation**: a decision's consequences (hold, work order, notifications; a finding's hold release and closure; a timer's notification) are caused by the decision event, not by the triggering message, so the chain reads PassRecorded → AxleReadingsRecorded → AlertRaised → CarHoldPlaced.
- **The seed writes history as events** through the same deciders, bootstraps projections by catch-up from the store, writes checkpoints for every group at the head, and starts the relay after the history (new consumers bootstrap from the store, not from broker retention).
- **Redrive addresses one group** (`redriveFor`): other groups on the stream skip the message, and processed-events makes a repeat harmless anyway.
- **Fault injection lives in Valkey (`rh:faults`)**, per group and matching a substring of the raw event; `crash_after_commit` kills the consumer between commit and XACK to demonstrate redelivery. Demo tooling, off by default.
- **An audit that finds a defect does not place a hold** (as before the rework); the superseding-finding rule re-holds alert cases only.

### Tests migrated in the rework (and why)

The 79 original tests still pass, except where the behaviour they pinned was replaced on purpose:
- `api/services/ingest.test.ts`: "publishes on retry if the first attempt committed but crashed before publishing" was removed: with the outbox there is no publish step to crash before. Replaced by "no separate publish step that can be lost: if the transaction fails, neither the pass nor its events exist". The other ingest tests now assert staged outbox events (and their claim check and causation) instead of `publishPass` calls.
- `api/app.test.ts`: the acknowledgment, finding and outbound-check tests mocked SQL against the old mutable tables. They now run the real store, repositories and deciders against an in-memory event store (`events/testing.ts`) and assert appended events; the stale-version test also checks the change list, and new tests cover rebasing, the two-tablet rule and admin-only ops routes. The outbound-check test asserts it reads `case_index`, not `car_holds`.
- New: `events/envelope.test.ts` (upcasting), `events/consumer.test.ts` (idempotent redelivery, crash after commit, DLQ routing, redrive), `domain/case.test.ts` and `domain/car.test.ts` (folds, deciders, conflict rules, replay equivalence of the fold), `analyzer/swap-replay.test.ts` (the swap decision from facts, order-independent).

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
8. **Seeded history looked like consumer lag.** After the rework, the Ops page showed the work-order integration "2 min behind" on the seeded routine findings, which were never published. Fix: the seed writes checkpoints at the head for every group, not just projections.
9. **Previous-wheelset notices for normal readings** cluttered the car timeline (+2°F readings "set aside"). Fix: `BearingTrendUpdated` with `previousComponent` is emitted only for readings at or above the elevated threshold.
10. **"Caused by an event in another stream"** on most timeline rows: the cause (a readings event) isn't tagged with the car. Fix: the API returns each event's `causeType`.
11. **The simulator never exited** after "scenario complete": importing `shared/cache` opens a shared Valkey client that kept the event loop alive (also true before the rework). Fix: explicit `process.exit(0)`.
12. **A route file became a TanStack template stub.** Editing `routes/ops.tsx` by truncate-and-write while `vite` was running let the router plugin see an empty file and write its "Hello /ops" template. Write route files atomically (write elsewhere, then move) while the dev server runs.

## Verification Environment Notes

- Verified with native PostgreSQL 16 (`initdb` as the `postgres` user) and redis-server 7.0 on non-default ports passed through `DATABASE_URL`, `REDIS_URL`, `PORT`, `ANALYZER_PORT`, `WORKERS_PORT`, `VITE_PORT` and `API_URL`. No Docker daemon was available, so `docker-compose.yml` was written but not run. Use a short PostgreSQL data path or `unix_socket_directories=''`: socket paths over 107 bytes stop the server.
- `node scripts/sloc.mjs railcar-health --summary` was used for the README stats.

## Open Questions / Next Steps

- **Detector-fault quarantine.** Bias detection is implemented; automatically quarantining a faulty detector's absolute-only alerts into one maintenance ticket is described but not built.
- **A real model** behind the priority score, trained on findings weighted for how each car came to be inspected (alert, audit, routine, teardown).
- **Teardown ingestion** from bearing shops (the finding source exists).
- **Train matching for non-AEI passes** from train-movement data instead of trusting a train id on every pass.
- **WILD, acoustic and vision** detectors as additional evidence for the same bearing and wheel identities.
- **Alert-storm guard** per detector and per desk (rate limits on pages, not on alerts).
- **An audit finding a defect should bad-order the car** (place a hold) and stay open until repaired; today it closes on the finding.
- **Event-store housekeeping**: prune relayed `pass-*`/`trip-*` outbox rows past topic retention, prune `processed_events` past the redelivery horizon, snapshot long car streams.
- **Partitions**: the local Valkey streams are single-partition; a real Kafka mapping would key readings by trip, cases by case and car history by car (see architecture.md), and drop the per-trip advisory lock.
- **A `--rebuild` mode for replay** that swaps the shadow tables in and resets the group's checkpoints and processed events, for fixing a projection bug in place.
