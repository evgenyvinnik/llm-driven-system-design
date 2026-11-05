# Locomotive Fueling - Development with Claude

## Project Context

**Prompt.** "Design a backend system for BNSF locomotives that uses real-time fuel level, GPS location, route information, fuel consumption rate, and fuel prices to recommend where the locomotive should stop for fuel and how much fuel it should purchase."

**Signal.** A candidate report: a Glassdoor interview review attributed to BNSF Railway. It is self-reported and not verified, and the team, date and round are unknown. Two related prompts appear in the same source set, also unverified and treated here as follow-ups:

- "a high-throughput location ping receiver for streaming telemetry from thousands of moving locomotives";
- "a scalable ingestion system for sensor data from 3,000+ trains".

No fleet, tank, burn or price figure in this project comes from BNSF or any railroad. They are labelled illustrative assumptions throughout.

Midway through the build, the coordinator added requirements. All are implemented and covered in the docs:

1. Recommendation ≠ acceptance ≠ execution.
2. Shared station capacity with reservations on acceptance.
3. Widened margins and visible confidence for stale or uncertain inputs.
4. Optimizer-timeout and station-down fallbacks.
5. Follow-ups the answers must handle: what is minimized and which constraints are hard; an accepted plan when a cheaper option appears; an optimizer timeout; a station going down after acceptance.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Ingest, integrations, REST, SSE; `dev:server1/2` add 3001/3002 |
| Processor | 3100 (metrics) | `backend/src/processor/index.ts` | `PROCESSOR_PARTITIONS=0,1` + `PROCESSOR_PORT` to split partitions across instances |
| Planner | 3200 (metrics) | `backend/src/planner/index.ts` | Re-plan consumer, order worker, ticket reconciliation, reservation expiry, order-window sweep |
| Mock DTL vendor | 3300 | `backend/src/vendor/index.ts` | Fault switches: timeout, 500, refuse, short fill |
| Simulator | 3400 (control) | `backend/src/simulator/index.ts` → `run.ts` | 180× speed; scripted scenarios; `POST /scenarios/:name` |
| Frontend | 5173 | `frontend/` | `VITE_PORT` and `API_TARGET` override the port and proxy |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | — | Named `redis` in docker-compose for the repo scripts |

## Development Phases

1. **Domain and optimizer first.** The network, consumption model, DP, greedy and plan simulator, with tests before any I/O: the DP must equal greedy on per-gallon-only routes (60 random cases), beat it with fees, and never breach reserve.
2. **Estimator.** Median plus Kalman-style filter, fueling, fault and leak detection, calibration, with tests for slosh, gaps, duplicates and redelivery idempotency.
3. **Pipeline.** Ingest with two-layer dedup, partition streams, a processor that acks after commit, latest state behind a Lua sequence guard, alerts with dedup keys, coalesced triggers.
4. **Planner service, order state machine, mock vendor, reconciliation, simulator.** Then run it all together and iterate on what the live run showed (repair log below).
5. **Coordinator's added requirements.** Lifecycle (recommended / accepted / proposed), stop commitments with bay capacity and expiry, confidence and widened margins, time-budgeted optimizer with greedy and last-good fallbacks, station-down handling.
6. **Frontend.** Board, plan view, orders, anomalies, prices, crew view, with one EventSource and coalesced refetch. Screenshots taken from scripted states and inspected.
7. **API tests** (supertest, mocked db and cache), **docs**, final verification.

## Key Implementation Decisions (and why)

- **Valkey streams with N partition streams, not one stream with a consumer group.** A consumer group hands entries to any consumer, which breaks per-locomotive ordering. Separate streams, routed by an FNV hash of locomotive id and assigned to processor instances, behave like Kafka partitions.
- **The processor saves estimator state before acking, and the estimator is forward-only on a sequence watermark.** Redelivery after a crash then recomputes the same values deterministically, and history inserts collide.
- **Train calibration is published by the processor and copied by the planner as its baseline.** Earlier the planner stored its own per-unit mean, which never matched the processor's Σactual/Σforecast, so the burn-deviation trigger fired every few seconds (92 triggers in 2 simulated hours). With the same number on both sides, it fires only on real drift.
- **Headroom (one dimension) instead of a DP over every unit's level.** Per-unit targets fall out of one level; a leaking unit's larger share gets it more fuel automatically.
- **Suffix-minimum inner loop.** The stop cost is affine in the fill level, so the DP is O(nodes × levels × options), a few milliseconds per train.
- **Terminal credit at the destination price minus $0.25/gal.** With the full posted price, the DP tankered fuel into Barstow at $3.14 because Barstow's pad is $3.39. Defensible (railroads do tanker into California), but it made plans look odd. The discount says the next trip can buy elsewhere.
- **Hysteresis on the safety check itself (keep-margin 5 points below the planning margin).** Without it, accepting a plan triggered a re-plan that judged the just-created plan unsafe: DP plans buy exactly enough, so they sit on the boundary. Versions climbed by one per acceptance.
- **Emergency plans go through the same decision logic.** Initially every emergency run forced a switch, so a leaking train got a new version on every trigger.
- **One pending proposal per train, kept when the stops are the same.** Re-evaluations used to re-write identical proposals; T02 reached v15.
- **Orders only for accepted stops, placed by a sweep when the 12 h window opens.** At first orders were only placed during planner runs, so an accepted stop could enter the window and never get a truck until some unrelated trigger fired.
- **Simulated time everywhere in the domain, wall time for infrastructure.** ETAs, lead times, plan timestamps and alerts use the sim clock (Valkey `sim:clock`); leases and retry backoff use the wall clock.
- **The simulator plays the crew:** it accepts a recommendation once the first stop is within 8 h and stops only for accepted plans. Speed is power-limited: a heavy train slows on grades instead of burning more than notch 8 allows. Without that, the "heavier than planned" scenario barely showed in burn.
- **Grade (tilt) compensation in the processor.** The simulated sensor reads high on climbs, as a real end-mounted sensor would. Without compensation, calibration read 30-60% low on mountain segments.
- **SSE invalidations, not data payloads; no TanStack Query.** Pages refetch through the same role-checked endpoints, a crew stream is filtered server-side, and `useRefresh` provides coalescing, a polling fallback and a localStorage cache for the crew tablet.
- **Hand-rolled SVG charts** following the repo's dataviz guidance: one series per chart, a labelled reserve threshold, crosshair tooltips, text never in series colour.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ / Kafka | Valkey streams as Kafka | One fewer service; partitions modelled with separate streams |
| TimescaleDB / Cassandra for time series | PostgreSQL table with the same key | Local scale is small; the key design is what matters |
| Wall-clock time | Simulated clock at 180× | A 34-hour trip in about 11 minutes |
| TanStack Query | Small `useRefresh` hook + Zustand | Live invalidation semantics and an offline cache in ~100 lines |

## Iteration & Repair Log

Bugs found by running the stack, in order:

1. **Out-of-order delivery wasn't simulated.** The held-back batch was released after the next batch of *any* train, and batches were sent concurrently. It now holds back per train and sends sequentially. Late readings went from 0 to ~3% of traffic.
2. **In-batch duplicates were counted as "late"** in metrics. They're now classified by first occurrence.
3. **Burn-deviation trigger storm.** Mismatched calibration baselines (see decisions).
4. **Dark territory was a whole 240-mile segment**, a 5-hour blackout. It's now the middle 40 miles of a segment flagged dark.
5. **Calibration biased low.** The simulator capped burn at notch 8 without slowing the train, and the sensor tilt was uncompensated. Fixed in the simulator (power-limited speed) and the processor (tilt offset).
6. **Calibration noise early in a trip.** Trusted only after ~250 gal of forecast evidence per unit.
7. **Reconciliation waited forever on small top-ups** below the fueling detector's 150-gal jump. It now compares only units with ≥ 200 gal billed.
8. **Accept → unsafe → new version loop.** Safety-check hysteresis (see decisions).
9. **Emergency plans always switched.** Now decided by hysteresis.
10. **Duplicate proposals.** Kept when the stops are unchanged.
11. **Accepted DTL stops never ordered** until an unrelated trigger. Fixed with the order-window sweep.
12. **Logout crashed the current page for a frame** (`user!` while the store cleared). Pages now read the role null-safely.
13. **The sensor chart overflowed its card.** The width observer never attached because the component's first render was a placeholder. Fixed with a callback ref, and `minmax(0, 1fr)` grid columns so an SVG can't widen its column.
14. **Old "plan voided" alerts stayed open** after the replacement was accepted. Acceptance now resolves voided, proposal and slot-conflict alerts for the train.
15. **Fleet tile showed a negative "net fuel cost"** (it netted the destination credit). It now shows fuel still to buy.

## Open Questions

- **Joint bay assignment** at congested pads (MILP or column generation) vs the current per-train plan with acceptance-time conflict resolution.
- **DTL truck capacity per order** (~8-9k gal) and amending orders when gallons change. Neither is modelled; one order can imply two trucks.
- **Unit isolation** (shutting down a trailing unit to save fuel) and planning deliberately unbalanced consists; the headroom model assumes balanced units.
- **An event-time reorder buffer** for small shuffles, instead of treating every late reading as history-only.
- **Valuing leftover fuel** by the next trip's likely route rather than a flat discount.
- **Calibration attribution.** The model is ~5-10% pessimistic against the simulator's physics. Calibration absorbs it, but a fleet-wide prior per locomotive model would converge faster.

## Verification Environment Notes

- Verified without Docker. Native PostgreSQL 16 (initdb as the `postgres` user) on port 54332 and `redis-server` on 63832, with services on 3201-3205 and the frontend on 5192. Every port is overridable by environment variables; the defaults follow the repo conventions.
- Stop services by PID or port, never `pkill -f src/api/index.ts`: other projects use the same entry paths.
- The simulator can be restarted on its own (it resumes from the API's last known state), but its scenario schedule restarts relative to the new start time, so scenarios fire again.
- Reseeding truncates every table and deletes `lf:*` keys. The processor and planner recreate their consumer groups (NOGROUP recovery), but restarting them after a reseed is cleaner.
