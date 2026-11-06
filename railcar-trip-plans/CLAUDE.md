# Railcar Trip Plans and ETAs - Development with Claude

## Project Context

ROADMAP entry #23. The prompt: "Each loaded car moves on a trip plan (origin, a sequence of yards and trains, destination). AEI readers and yard systems report where cars actually are. Track every car against its plan, detect missed connections early, predict ETAs, and show shippers their cars."

**Signal: practice extension.** Car visibility and trip plans are central to rail service, but this question is not known to have been asked in a BNSF interview loop. It was built as rehearsal material for rail-flavoured system design rounds, and as a reference example of an **event-driven application** (event store as outbox, idempotent consumers, projections with replay, a saga with compensation, schema evolution, DLQ with redrive).

Public figures used (BNSF FY2025 10-K): 32,500+ route miles; ~70,700 owned or leased freight cars. Everything else (event rates, dwell distributions, digest windows, the network, names and reporting marks) is an illustrative assumption.

The design is in [architecture.md](./architecture.md), the event catalog in [events.md](./events.md). This file records how it was built, what changed, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Ingest, waybill intake, reads, commands, streams ops |
| Relay | 3011 | `backend/src/relay/index.ts` | Outbox → Valkey partition streams; advisory-lock leader |
| car-state | 3012 | `backend/src/consumers/car-state/index.ts` | Projection; ConnectionMissed |
| eta | 3013 | `backend/src/consumers/eta/index.ts` | Dwell Monte Carlo; EtaUpdated; ClockTicked |
| exceptions | 3014 | `backend/src/consumers/exceptions/index.ts` | Board; event-time dwell sweep |
| notifier | 3015 | `backend/src/consumers/notifier/index.ts` | Per-shipper digest windows |
| replanner | 3016 | `backend/src/replanner/index.ts` | Process manager (saga) + sweeper |
| Simulator | - | `backend/src/simulator/index.ts` | Closed loop; publishes the sim clock |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` |

## Development Phases

1. **Event model first.** Zod schemas per (type, version), the envelope, the catalog (topic, stream, key per type), and the CarSighted v1 → v2 upcaster, before any service.
2. **Event store and relay.** Append with per-stream advisory lock, expected-version check, natural-key dedupe, log indexes in the same transaction; relay with `SKIP LOCKED` and LISTEN/NOTIFY.
3. **Consumer runner.** Partition leases, PEL recovery on start, XAUTOCLAIM, bounded retries, per-group DLQ and retry streams, idempotency marker in the handler's transaction, ack after commit.
4. **Domain.** Car fold (order-independent, observed vs inferred, missed reads), plan aggregate and planner with capacity, ETA Monte Carlo, digest builder. Pure functions, unit-tested.
5. **Consumers and the saga.** car-state (predicted and actual misses), eta, exceptions, notifier, replanner with compensation.
6. **Simulator.** Closed loop: yards build trains from the system's current plans. Injected incidents listed in README.
7. **API, replay, frontend.** Shipper-scoped reads, timeline with causation chains, streams/DLQ page; `npm run replay` with row-by-row comparison.
8. **Verification runs.** Three full scenario runs with an automated SIGKILL of the ETA consumer during the delay fan-out; curl checks of duplicates, late events, republish, DLQ redrive, optimistic concurrency and access control; replay after each run.

## Key Implementation Decisions (and why)

- **Car state is a projection, the trip plan an aggregate.** Facts can't be rejected, so the car is a fold sorted by event time; the plan is our decision with racing writers, so it gets expected-version appends. See architecture.md decision 1.
- **One table is the event store and the outbox.** Consumers append decisions in the same transaction as their read model and idempotency marker. No dual writes anywhere.
- **Car timeline = event_cars ∪ events of runs the car rode ∪ events of runs any plan version named.** Written as log indexes at append time, so a timeline query never misses a committed event, and replay sees the same timeline.
- **Every consumer reads the event store, not another consumer's projection.** eta refolds the car itself rather than reading `car_state`, so the two never wait on each other and each replays alone.
- **`asOf` covers exactly the event types that trigger an ETA recompute** (facts, relevant train events, plan events, ClockTicked). Anything else in it would make live and replay diverge.
- **Common random numbers for the ETA** (seed = car + plan version): successive recomputes only move when inputs move, and replay is exact.
- **ClockTicked from the event-time watermark**, not a wall-clock timer, so time-driven recomputes are in the log and replay reproduces them.
- **Partition leases with stable consumer names** (`CONSUMER_NAME`, default `<group>-1`): a restarted consumer re-acquires its partitions immediately and re-reads its own pending entries first.
- **A failed message doesn't block its partition.** Handlers are order-tolerant, so later messages continue while the failed one retries via XAUTOCLAIM.
- **A train event doesn't fail for an unknown car in its consist**; only the car's own fact dead-letters (otherwise one unknown car holds 100 cars' state hostage).
- **Redrive goes to the group's own retry stream**, so groups that already processed the event aren't bothered.
- **The plan read model is an inline projection** (same transaction as the plan event), so the replanner and car-state never read a plan older than the one just written; it is still rebuilt by `replay -- plans`.
- **Saga dedupe key includes the attempt** (`trip:version:leg#attempt`), so a compensated saga can retry the same leg while predicted and actual misses still collapse.
- **Simulation clock in Valkey** (`tp:sim:clock`): the API stamps `recorded_at` in simulated time so lateness means something at 1,800×; digest windows use wall-clock seconds. The simulator runs the clock out to the scenario end and hands back to 1× there.
- **ESLint `react-refresh`** allows the `Route` export; shared helpers live in `lib/` so component files export only components.

## Deviations from Repo Defaults

- **No Kafka**: Valkey Streams stand in (one stream per partition, leases for assignment). Mapping in architecture.md.
- **One PostgreSQL** holds the event store, projections and saga state.
- **Charts are hand-written SVG** (ETA band, ETA history, sparkline).
- **Polling instead of SSE** in the UI: projections converge on their own; documented as a decision in the frontend answer.

## Iteration & Repair Log

1. **Future-dated yard bookings rejected.** The simulator posted CarArrivedYard 20 minutes after the train arrival in the same batch; ingest rejects events from the future (against the simulated clock). Fix: schedule the booking as its own action at its own time.
2. **Simulated clock 20 hours ahead of real time.** The scenario kept running actions due after its end (placements), then handed the clock back at that point. Fix: the world freezes at the scenario end; the clock runs out to the end and hands back there.
3. **Replay mismatch on `event_count`.** car-state counted every timeline event, including ETA updates and digests it doesn't consume, so live rows lagged the rebuilt ones. Fix: count only consumed types; `replay -- car-state --apply` refreshed the live rows (a nice demo of replay after a projection change).
4. **ETA asOf included ConnectionMissed**, which is not an ETA trigger, so a replay could compute a different asOf. Found in review before it bit; asOf now covers exactly the trigger types.
5. **ETAs drifted into the past** for cars sitting in yards (the ETA was frozen at the last event). A wall-clock recompute would break replay equivalence; fix: ClockTicked events from the watermark.
6. **Waiting cars pushed off their trains.** Once ticks existed, conditioning yard time on time already waited made a car that was just waiting for tonight's train look unready, so its ETA jumped +9 h and back −11 h in consecutive digests. Fix: condition only once the planned train has gone; recalibrated the illustrative dwell table to ready-time values close to each yard's minimum connection.
7. **Spurious missed connections at origin yards.** The planner assumed a car is ready 4 h after release; the simulated yard needs the pull plus its minimum connection. Fix: ready = release + 3 h + minimum connection (departed-without-car sagas dropped from 21 to 4 per run).
8. **A bad-ordered car was replanned onto the next train while still on the repair track.** Fix: the fold carries `repairUntil`; ConnectionMissed's `availableAt` respects it.
9. **"+9 h vs original plan" for on-time cars.** The comparison used the plan's arrival at the destination yard against an ETA to placement. Fix: add the destination's median local time.
10. **EtaUpdated churn from Monte Carlo noise** (seeded by asOf, ~1,600 updates per run). Fix: common random numbers.
11. **Waybills attributed to `ops:olivia`.** The simulator sends both the ingest token and an ops cookie; the producer now comes from the token.

## Verification

Verified with native PostgreSQL 16 and redis-server 7.0 (no Docker daemon was available, so `docker-compose.yml` was written but not run):

- `npm run type-check`, `npm test` (47 tests), `npm run lint` in backend; `npm run type-check`, `npm run build`, `npm run lint` in frontend.
- Full scenario runs at 1,800×; ETA consumer SIGKILLed during the 88-car delay fan-out and restarted: 88 history rows, 88 EtaUpdated, one idempotency marker.
- Duplicates (same id, same natural key with a new id, stream republish), a 44-hour-late out-of-order fact, DLQ redrive (before and after registering the car), 409s for stale plan revisions and exception resolutions, shipper isolation (404/403, redacted consists).
- `npm run replay -- all`: car-state, eta, plans and exceptions identical to live after each run.
- `node scripts/sloc.mjs railcar-trip-plans --summary` for the README stats.

## Open Questions / Next Steps

- **Re-key stage for train events** (train event → per-car events on the car topic) to spread the hot-key fan-out.
- **Learn dwell distributions from the event store** per yard, block, day of week and season, and check calibration per yard (today's bands are conservative because the simulated yards are more regular than the seeded history).
- **Alternate routings and length/tonnage capacity** in the replanner, plus a cost function (delay vs priority train use).
- **Per-trip snapshots** of car state for long-lived cars; a precomputed timeline projection for the portal.
- **ClockTicked recomputes only for cars whose p10 has passed** (needs the rule itself to be replayable).
- **Notification delivery gateway** (email/EDI/webhooks) consuming ShipperNotified, idempotent on digest id; shipper quiet hours and channel preferences.
- **Schema registry** with compatibility checks in CI instead of code-only zod schemas.
