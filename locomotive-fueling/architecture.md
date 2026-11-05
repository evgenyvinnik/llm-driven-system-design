# Locomotive Fueling - Architecture

## System Overview

A backend for a freight railroad's fuel desk. Every locomotive reports its position, speed, throttle notch, engine state and tank level. From that telemetry, the route ahead, the train's tonnage and burn history, and the fuel prices at every pad and truck site, the system recommends **where each train should stop for fuel and how many gallons each unit should take**. It keeps every unit above a safety reserve at every point, orders direct-to-locomotive (DTL) trucks where needed, and reconciles what was delivered.

Three problems make this harder than the classic "gas station" puzzle:

1. **The inputs are noisy and late.** Tank sensors read the sloshing fuel surface. Readings arrive duplicated, out of order, or hours late after dark territory. Burn varies with tonnage, grade and the individual unit.
2. **Plans have a life after they're computed.** A recommendation becomes a commitment when the fuel desk or crew accepts it. Accepting reserves a pad bay or orders a truck. Changing the plan after that has a real cost, so a re-plan can't simply overwrite it.
3. **External calls have unknown outcomes.** A DTL vendor can time out after creating the order. The design has to avoid both double-ordering and silently not ordering.

**Learning goals:** stream processing keyed by device, with event-time and ordering problems; a dynamic-programming optimizer with hysteresis and a fallback path; a plan lifecycle that separates recommendation, acceptance and execution; idempotent integration with an unreliable partner; and safety alarms that don't depend on the optimizer.

**Signal.** This is a candidate-reported BNSF Railway prompt from Glassdoor (not verified). Related reported prompts are "a high-throughput location ping receiver for thousands of moving locomotives" and "a scalable ingestion system for sensor data from 3,000+ trains". See [CLAUDE.md](./CLAUDE.md).

**Numbers are illustrative.** Fleet size, tank sizes, burn rates, prices and network geometry are assumptions chosen to be plausible, not any railroad's data.

## Requirements

### Functional Requirements

1. **Ingest telemetry** from onboard units: position (lat/lon and route milepost from PTC), speed, throttle notch, engine state and raw fuel level. Report interval 10-60 s. Units buffer readings in dark territory and flush them later.
2. **Estimate true fuel per unit** by smoothing the sensor. Detect anomalies: a level drop while stationary (leak or theft), a rise without fueling (sensor fault), and burn far above consist-mates (leak).
3. **Forecast consumption** per route segment from tonnage, horsepower per ton, grade, curvature and planned speed, recalibrated in flight with measured burn.
4. **Recommend fuel stops** for each train over its remaining route: which pad or DTL site, and per-unit target levels. Minimize total trip cost subject to hard safety constraints.
5. **Manage the plan lifecycle.** States are recommended → accepted (by fuel desk or crew) → executing → fueled or cancelled. Every version is kept with the reason it changed. A change after acceptance is proposed and needs explicit confirmation.
6. **Share station capacity.** Pads have a limited number of fueling bays. Acceptance reserves a bay for a time window, and the reservation expires.
7. **Order DTL trucks** for accepted stops with idempotent creation, cancellation and an outcome-unknown state, and reconcile fuel tickets against telemetry.
8. **Raise safety alarms** (low fuel, cannot reach next fuel) from telemetry alone, even when the planner is down.
9. **Serve the UI:** a fleet board, a train plan view with confidence and assumptions, orders and reconciliation, anomalies, and price and parameter admin. The crew gets a read-only view of their own train.

### Non-Functional Requirements

| Property | Target | Why |
|----------|--------|-----|
| Ingest availability | 99.95% (devices buffer on failure) | Losing readings blinds the estimator |
| Ingest latency | p99 < 200 ms to durable log | Devices retry on timeout, so slow acks cause duplicates |
| Telemetry → latest state | p99 < 5 s | Fleet board and alarms are near real time |
| Low-fuel alarm | Within 60 s of the evidence, independent of the planner | Running dry blocks a main line |
| Re-plan after a trigger | p95 < 30 s | Crews need instructions before the next decision point |
| Planner run | p99 < 500 ms per train (budgeted, with fallback) | Price-change storms re-plan hundreds of trains |
| Plan correctness | Zero accepted plans that breach reserve under the planning margin | Hard safety constraint |
| DTL ordering | Exactly one vendor order per accepted stop | Double trucks cost a call-out fee each, and a missing truck strands the train |
| Durability | No accepted reading or plan version lost | Audit, fuel accounting, claims against vendors |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Locomotives reporting | ~8,000 | Large Class I fleet (assumption) |
| Trains running at once | ~1,500 | 3-6 units per road train, plus yard and local work |
| Telemetry rate | ~270 msg/s average, ~2,700/s burst | 8,000 ÷ 30 s; bursts at shift change and after coverage returns |
| Reading size | ~300 B JSON, ~80 B compact binary | ~12 fields |
| History | ~23M readings/day, ~7 GB/day raw, ~2 GB compressed | 270 × 86,400 |
| One year hot | ~0.7-2.5 TB | Time-series store with compression and downsampling |
| Planner runs | ~3-10 per second | 1,500 trains × 6-20 evaluations per hour (stations, burn drift, prices) |
| Price-change storm | ~500 trains in ~1 min | Daily price feed touches most of the network |
| Fuel events | ~5,000/day, ~1,000 of them DTL | Each unit fuels every 1-2 days |

The related "3,000+ trains sensor ingestion" prompt is a different order of magnitude. Raw engine telemetry is hundreds of channels at 1 Hz per unit: 8,000 × 200 ≈ 1.6M points/s. The same ingest path applies, with edge aggregation on the unit and a columnar store. The fueling planner only needs the fuel-relevant subset.

### Local Development Scale

10 trains and 34 locomotives on 18 locations. The simulator runs 180× real time, so one 3-minute reading per unit per second gives about 35 readings/s and 10 batches/s. One process handles each role.

## High-Level Architecture

```
┌──────────────────────┐   cellular / satellite (buffers in dark territory)
│ Onboard unit (lead)  │──────────────────────────────┐
│ PTC milepost, notch, │                              ▼
│ tank level, engine   │                 ┌────────────────────────┐
└──────────────────────┘                 │ Ingestion gateway (N)  │ validate, dedupe batch id,
                                         │ mTLS per device        │ sort per unit, append
                                         └───────────┬────────────┘
                                                     ▼
                              ┌───────────────────────────────────────────┐
                              │ Kafka: telemetry (partition = locomotive)  │
                              │ + corrections from ticket reconciliation   │
                              └──────────────┬────────────────────────────┘
                                             ▼
                 ┌────────────────────────────────────────────────────────┐
                 │ Stream processor (Flink / Kafka Streams, keyed state)  │
                 │ estimator · fueling detection · anomaly rules ·        │
                 │ calibration · station passage · range check            │
                 └──┬──────────────┬───────────────┬──────────────┬───────┘
                    ▼              ▼               ▼              ▼
          ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ ┌──────────────┐
          │ Latest state │ │ Time-series  │ │ Alerts      │ │ Re-plan      │
          │ Redis (seq-  │ │ TimescaleDB/ │ │ (PostgreSQL)│ │ triggers     │
          │ guarded)     │ │ Cassandra    │ └──────┬──────┘ │ (coalesced)  │
          └──────┬───────┘ └──────────────┘        │        └──────┬───────┘
                 │                                 │               ▼
                 │            ┌────────────────────┴───────────────────────┐
                 └───────────▶│ Planner service (N, per-train lock)        │
                              │ inputs + confidence → DP (budget) → greedy │
                              │ / last-good fallback → hysteresis →        │
                              │ version / proposal → reservations, orders  │
                              └───────┬───────────────────────┬────────────┘
                                      ▼                       ▼
                     ┌───────────────────────────┐  ┌──────────────────────────┐
                     │ PostgreSQL: plans, stops, │  │ Order worker → DTL vendor│
                     │ commitments, orders,      │  │ idempotency key, timeout │
                     │ tickets, prices, params   │  │ = unknown → lookup       │
                     └───────────┬───────────────┘  └───────────┬──────────────┘
                                 │                    tickets (webhook, retried)
                                 ▼                              ▼
                   ┌──────────────────────────────────────────────────────────┐
                   │ API + SSE gateway: fuel desk, crew tablet, admin, vendors│
                   └──────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Ingestion gateway

The gateway is deliberately thin. It authenticates the device, validates the batch, drops exact `(locomotive, seq)` repeats inside the batch, sorts each locomotive's readings by sequence, and appends each reading to the partition for its locomotive. It replies 202 once the append is durable (Kafka `acks=all`). Enrichment happens downstream so the edge stays fast and stateless.

Dedup happens at two layers, on purpose:

| Layer | Key | Purpose | Guarantee |
|-------|-----|---------|-----------|
| Batch id (fast path) | `batchId`, 24 h TTL, written **after** a successful append | A device that lost our 202 retries; we answer `200 duplicate` without re-appending | Optimization only |
| Natural key (real guarantee) | `(locomotive_id, seq)` primary key in history; sequence watermark in the estimator | Anything re-appended for any reason (partial failures, replays) | Exactly-once effect |

Writing the batch marker only after the append means a half-failed append is retried in full, rather than wrongly answered as a duplicate.

### 2. Partitioning and ordering

Kafka is **partitioned by locomotive id**. Every reading from one unit goes to one partition, and one consumer owns that partition, so the estimator sees each unit's readings in arrival order without locks. Train-level checks need all units of a consist. These read the latest per-unit state, which tolerates the units living on different partitions.

Arrival order is not event order. The device can resend, use two links, or flush a buffer after newer readings. The estimator is forward-only: a reading whose sequence is at or below the unit's watermark is stored for history (`late = true`) and never rewinds the filter. Production can add a short reorder buffer, such as Flink event time with 2 minutes of allowed lateness, to absorb small shuffles before the watermark. Locally late readings go straight to history.

### 3. Fuel-level estimator (per unit)

Tank sensors measure the fuel surface, which tilts on grades and sloshes under acceleration. Raw readings swing by hundreds of gallons. The estimator works in four steps:

1. **Predict** the level forward using the previous interval's throttle notch. Each notch burns a known rate (illustrative: idle 4 gal/hr up to notch 8 at 200 gal/hr). Process variance grows with elapsed time, so a gap after dark territory widens uncertainty.
2. **Compensate for tilt.** The track profile is known, so the predictable tilt offset (about 260 gal per 1% grade, illustrative) is subtracted.
3. **Take the median** of the last five readings to reject spikes. The window resets after a gap.
4. **Correct** Kalman-style, trusting the sensor less while accelerating, and not at all once the sensor is flagged faulty.

The estimator also detects events:

| Event | Rule | Action |
|-------|------|--------|
| Fueling | Level jumps > 150 gal while stationary; ends on departure or 30 min without rise | Snap to sensor, record `fueling_events`, trigger re-plan |
| Sensor fault | Median exceeds estimate by > 250 gal for 3 readings while moving (fuel can't rise while moving) | Flag the unit, dead-reckon from notch, alert |
| Stationary loss | Drop beyond idle burn > 60 gal over ≥ 30 min, engine idle or off | Leak/theft alert (critical) |
| Burn far above consist-mates | Unit calibration > 1.25 and > 1.3× peer median | Leak alert, re-plan with that unit's measured share |
| Low fuel | Estimate below the unit's reserve | Critical alarm; resolves above 1.2× reserve |
| Range risk | Consist headroom below inflated forecast burn to the next fuel facility | Warning, independent of the planner |

**Calibration** compares filtered burn with the model's forecast over decayed sums (about 300-mile memory). It is trusted only after about 250 gal of forecast evidence per unit. Train-level drift beyond ±12% from what the last evaluation assumed triggers a re-plan.

### 4. Consumption model

Work over a segment is (rolling + curve resistance) × distance + weight × climb, at about 35M ft·lbf of rail work per gallon (≈137k BTU/gal at ~33% efficiency). Descents count as zero work, which approximates dynamic braking. Idle and auxiliary load adds about 4 gal/hr per unit. Each unit's share of the train's burn is its horsepower share × model efficiency factor × its own calibration. A leaking unit's share therefore grows, and the planner fuels it more.

### 5. Planner

**Inputs.** The planner builds them from the train's remaining path, the latest per-unit state, fuel options and prices, existing orders and reservations, and parameters:

- **Headroom.** The consist becomes one virtual tank measured in *headroom*: the train-gallons of forecast burn the consist can absorb before its first unit reaches reserve. When units are balanced, unit *i* holds `reserve_i + share_i × h`. Raising headroom by one train-gallon costs Σ share real gallons. One level then determines every unit's target, which keeps the DP one-dimensional.
- **Uncertain inputs widen the margin.** The reserve check uses forecast burn × (1 + margin). The base margin is 10%. It grows by 3% per hour of fuel-data age, by up to 10% when burn drifts from the model, and by 5% for a faulty sensor or suspected leak, capped at +20%. The plan carries a confidence label (high, medium or low) and plain-language assumptions.
- **Availability.** A DTL option is unavailable inside its lead time unless already ordered. Inactive facilities and vendors that refused this trip are unavailable too.
- **Shared capacity.** Pad options carry an expected queue wait, computed from other trains' accepted reservations at that bay count. The wait is added to dwell and delay cost.

**Objective and constraints.**

| Term | What it means |
|------|---------------|
| Minimize | Fuel purchases + DTL fees + delay (dwell and queue × train-hour cost) + stop penalty + cancellation fees − credit for fuel left at the destination |
| Hard constraint | Every unit ≥ its reserve (max of 10% of tank and 500 gal) at every station, against inflated burn |
| Hard constraint | No unit above tank capacity; at most one fuel option per stop; DTL lead time |
| Soft (priced) | Delay, stops, cancellations, queue time |
| Terminal credit | Leftover fuel valued at the destination pad price minus a discount ($0.25/gal), because the next trip can buy elsewhere |

Purchase cost alone would ignore dwell, and a train-hour is worth hundreds of dollars. Delay alone would ignore price spreads worth thousands per trip. The objective therefore prices both. Safety is never traded for money: the reserve is a constraint, not a penalty.

**DP.** Over (node, discretized headroom; 25-gal grid), at each node either pass or stop at one option and fill to level L. The stop cost is fixed (fee, penalty, setup and queue delay, cancellations) plus a part that is linear in gallons (price plus pumping time). Because that part is affine in L, the inner minimum is a suffix minimum. The whole DP is therefore O(nodes × levels × options), a few milliseconds per train.

**Greedy baseline.** If a cheaper station is within one tank, buy just enough to reach it; otherwise fill up, or buy just enough to finish. This is optimal for purely per-gallon costs. Tests assert the DP matches it on those cases and beats it once fees and dwell exist. The UI shows the comparison.

**Budget and fallback.** The DP checks a deadline (default 500 ms). Past the deadline the planner uses the greedy plan if it is feasible, labelled *Greedy fallback*. If not, it keeps the last good plan if that is still feasible (*Last good plan*), and otherwise goes to the emergency path. A fallback never replaces a plan in force that is still safe.

**Emergency.** If no plan keeps every unit above reserve, the planner re-plans against zero reserve, marks the plan *emergency* and raises a critical alarm. If even that fails it raises an alarm and the desk intervenes.

### 6. Plan lifecycle and hysteresis

```
                 ┌──────────── safety/unavailable: replace now (accepted plan voided) ─────┐
                 │                                                                          ▼
 (planner) ─▶ recommended ──accept (desk or crew)──▶ accepted ──train on site──▶ executing ──▶ fueled
                 │  ▲                                   │                                     │
                 │  └── cheaper by > threshold ─────────┤ cheaper by > threshold + change     └─▶ cancelled
                 │      (replaced, reserves nothing)    │ cost → proposed ── confirm ──▶ accepted (new)
                 ▼                                      ▼                   └─ reject ──▶ kept
             superseded                         reservation expires ─▶ expired → re-plan
```

- **Every run is logged.** Each planner run writes a `plan_evaluations` row with the trigger, the decision and the explanation, including runs that kept the plan. A plan version is immutable: its stops and per-unit targets are exactly what the crew was told.
- **Recommended plan.** It is replaced only if it became unsafe, or a new plan saves more than max($150, 2% of trip cost).
- **Accepted plan.** The bar is the threshold plus a $400 change cost, and the result is only a **proposal**. The plan in force stays until the fuel desk confirms. Confirming releases the old reservations and cancels dropped trucks (cancel fee applies).
- **Safety overrides acceptance.** If the accepted plan would breach reserve, or uses a station that went down or a refused truck, the planner supersedes it at once with a new recommendation. It raises a "plan voided" alarm and cancels the truck idempotently. Stops the new plan keeps hold their reservations.
- **The safety check has its own hysteresis.** Plans land on the reserve boundary by design, because they buy just enough. The plan in force is declared unsafe only if it fails at (margin − 5 points). Without that slack, every small burn update voided the plan (observed while building; see CLAUDE.md).
- **Triggers coalesce.** Station passage, burn deviation, leak, price change, reroute, station down, vendor refusal or failure, fueling, acceptance, slot conflict, reservation expiry, order window opening, and manual all share a per-train pending key (5 s). A burst becomes one run, and the run reads the newest inputs.

### 7. Shared capacity and reservations

The system plans each train separately against existing reservations, then resolves conflicts at acceptance:

1. When planning, other trains' accepted slots at a pad become an expected queue wait, which the objective prices.
2. **Recommendations reserve nothing.** Accepting a plan reserves a bay for each stop over `[eta, eta + dwell]`. The check is serialized per option with a row lock. The first to accept gets the bay. The second gets `409 SLOT_TAKEN`, an alert and a re-plan that now sees the queue.
3. Each re-evaluation moves the train's reservations to its current ETA. A reservation expires if the train hasn't arrived by slot end plus 2 h, which frees the bay and re-plans that train.

Joint planning would assign bays across trains with a MILP or a column-generation model. It gives better global allocations at a congested pad, but it couples every train's plan. A delay on one train re-plans its neighbours, and plans stop being explainable per train. Deep dive in the interview answers.

### 8. DTL orders

An order exists only for an **accepted** DTL stop inside the ordering window (12 h). Its idempotency key is the stop key `train:location:option`.

| From | Event | To |
|------|-------|----|
| pending | vendor 201/200 | confirmed |
| pending | vendor 4xx (no truck) | rejected → alert, re-plan without the option |
| pending | timeout, 5xx or network error | **unknown** (never "failed") |
| unknown | lookup by key: found | confirmed |
| unknown | lookup: not found | resubmit with the same key |
| unknown | attempts exhausted or train < 2 h out | failed → alert "call vendor", re-plan |
| cancel_requested | lookup (if id unknown), then cancel | cancelled (fee recorded) |
| confirmed | ticket webhook | delivered → reconciled or discrepancy |

The worker claims due orders with a lease (`FOR UPDATE SKIP LOCKED`), calls the vendor outside any transaction, and writes the result fenced on the status it read. If the planner moved the order in the meantime (for example to `cancel_requested`), the fenced write loses. The next pass then handles the new state, using lookup-by-key because the vendor id may never have been learned.

**Reconciliation.** It matches ticket gallons per unit with telemetry-detected fueling events, comparing only units that took enough fuel to register (≥ 200 gal), with a tolerance of max(150 gal, 5%). A short fill raises a dispute alert. For units with faulty sensors, the ticket becomes the ground truth. A correction is published to that locomotive's partition, so the processor applies it in order with the readings.

### Worked example: one successful trace

A price cut makes Kingman DTL the best stop for Q-KCKBAR, and the vendor times out.

1. Admin sets KIN-DTL to $2.10. The price row and a history row are written in one transaction. Trains still heading through Kingman (T01, T07) get a `price_change` trigger.
2. The planner takes T01's lock. Its inputs show burn running +19% vs the model, so the margin widens to 19% and confidence is medium. The DP picks KIN-DTL. T01's plan was only *recommended*, so the $13,267 saving clears the threshold, and v7 is written as the new recommendation. T07's plan was *accepted*, so the same saving produces a *proposal* awaiting the fuel desk.
3. The crew acknowledges v7 on the cab tablet (first stop < 8 h away). A commitment is written for Kingman with its slot window and expiry.
4. The planner run triggered by `accepted` inserts `dtl_orders(stop_key = T01:KIN:KIN-DTL, pending)`.
5. The order worker claims the order and POSTs with `Idempotency-Key: T01:KIN:KIN-DTL`. The vendor creates DTL-1002 but never answers. After 2.5 s the order goes `unknown` with a 1 s backoff.
6. The next pass looks up by key, finds DTL-1002, and marks it `confirmed`: "the earlier request succeeded after we stopped waiting". The vendor has exactly one order.
7. At Kingman the commitment goes `executing`. The truck delivers and the vendor posts ticket VT-DTL-1002, which is retried until we answer. The ticket marks the order `delivered` and the commitment `fueled`, and triggers a re-plan.
8. Reconciliation compares 13,270 gal billed with 11,198 seen by telemetry. The vendor short-filled 15%, so a dispute alert is raised.

### Worked example: one failed trace

A station goes down after acceptance.

1. Q-KCKBAR's crew has accepted v1: fuel at Amarillo, with a bay reserved.
2. Amarillo's pumps fail, and the pad is set inactive. Trains still heading there get a `station_down` trigger.
3. The planner re-prices the plan in force: AMA-PAD is now unavailable, so the plan in force is infeasible. Hysteresis returns `switch_unsafe` even though the plan was accepted.
4. A new version is written as a *recommendation* (not accepted). The old one is superseded, and the Amarillo commitment is cancelled. Stops the new plan keeps keep their reservations, and any DTL order for a dropped stop goes to `cancel_requested`.
5. A critical "accepted plan voided" alert opens. The crew view shows "Not yet accepted" until someone accepts the replacement. Accepting resolves the alert.
6. If the planner itself were down during all this, the processor would still raise `range_risk` when the consist could no longer reach the next open facility above reserve. The low-fuel alarm would fire if a unit crossed reserve.

### Design Review Checklist

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | Telemetry: the Kafka log; a write succeeds when the append is durable (202). Plans, commitments, orders, tickets: PostgreSQL; success is the committed transaction. Latest state and estimator state are derived and rebuildable from the log |
| Client retries after losing the response? | Device: same batch id → `200 duplicate`, and re-appended readings collide on `(locomotive, seq)`. Accept: a second accept is a 409 and changes nothing. Vendor webhook: ticket id PK. Our own retry to the vendor: same Idempotency-Key, after a lookup |
| Worker fails between two steps? | Processor: state saved before the stream ack; redelivery is idempotent (watermark, PK, alert dedup key). Planner: the version write and evaluation share one transaction; unacked requests are reclaimed. Order worker: lease expiry plus fenced update; outcome-unknown is resolved by lookup |
| Ordering actually required? | Per locomotive for the estimator (partition key). Per train for plan versions (lock + UNIQUE). Per fuel option at acceptance (row lock). Nothing global |
| Access with caches, indexes, async jobs? | Every REST endpoint checks role and crew-train scope. SSE carries invalidations only, filtered per viewer, and data is refetched through access-checked endpoints. Workers act as the system and never serve user data directly |
| What breaks first at scale, with evidence? | PostgreSQL write volume from evaluations during price storms (2-5 rows and ~5-15 ms DB time per run locally, × 1,500 trains per price file). Then partition count for full sensor ingestion. See Scalability Considerations |

## Database Schema

The full DDL is in [`backend/src/db/init.sql`](./backend/src/db/init.sql). The key tables follow:

```sql
-- Telemetry history: the natural key makes replays harmless.
CREATE TABLE telemetry (
  locomotive_id TEXT, seq BIGINT, recorded_at TIMESTAMPTZ, train_id TEXT, milepost DOUBLE PRECISION,
  speed_mph DOUBLE PRECISION, notch SMALLINT, engine_state TEXT,
  fuel_raw DOUBLE PRECISION, fuel_smoothed DOUBLE PRECISION, late BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (locomotive_id, seq)
);
CREATE INDEX ON telemetry (locomotive_id, recorded_at DESC);   -- production: hypertable by time

-- Immutable plan versions; one current, at most one pending proposal per train.
CREATE TABLE fuel_plans (
  id BIGSERIAL PRIMARY KEY, train_id TEXT REFERENCES trains(id), version INT,
  is_current BOOLEAN, lifecycle TEXT CHECK (lifecycle IN ('recommended','accepted','proposed','superseded','rejected')),
  accepted_by TEXT, accepted_at TIMESTAMPTZ, source TEXT CHECK (source IN ('dp','greedy_fallback','last_good')),
  confidence TEXT, assumptions JSONB, status TEXT CHECK (status IN ('ok','emergency','infeasible')),
  trigger TEXT, reason TEXT, created_at TIMESTAMPTZ, cost_total NUMERIC, cost_breakdown JSONB,
  greedy_cost NUMERIC, inputs JSONB, profile JSONB, UNIQUE (train_id, version)
);
CREATE UNIQUE INDEX ON fuel_plans (train_id) WHERE is_current;
CREATE UNIQUE INDEX ON fuel_plans (train_id) WHERE lifecycle = 'proposed';

CREATE TABLE plan_stops (
  plan_id BIGINT REFERENCES fuel_plans(id), seq INT, stop_key TEXT,     -- train:location:option
  location_id TEXT, option_id TEXT, kind TEXT, eta TIMESTAMPTZ, gallons DOUBLE PRECISION,
  per_unit JSONB,                                                     -- [{locomotiveId, arrivalGal, targetGal, gallons}]
  price_per_gal NUMERIC, fuel_cost NUMERIC, fee NUMERIC, delay_cost NUMERIC,
  dwell_minutes DOUBLE PRECISION, queue_minutes DOUBLE PRECISION, PRIMARY KEY (plan_id, seq)
);

-- Only accepted stops reserve capacity.
CREATE TABLE stop_commitments (
  stop_key TEXT PRIMARY KEY, train_id TEXT, location_id TEXT, option_id TEXT, plan_version INT,
  state TEXT CHECK (state IN ('accepted','executing','fueled','cancelled','expired')),
  slot_start TIMESTAMPTZ, slot_end TIMESTAMPTZ, expires_at TIMESTAMPTZ, accepted_by TEXT
);
CREATE INDEX ON stop_commitments (option_id, state, slot_start);

CREATE TABLE dtl_orders (
  id BIGSERIAL PRIMARY KEY, stop_key TEXT UNIQUE,                       -- the idempotency key
  train_id TEXT, location_id TEXT, option_id TEXT, plan_version INT, gallons_requested DOUBLE PRECISION,
  eta TIMESTAMPTZ, status TEXT, vendor_order_id TEXT, attempts INT, next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ, last_error TEXT, cancel_fee NUMERIC, gallons_delivered DOUBLE PRECISION
);

CREATE TABLE fuel_tickets (
  id TEXT PRIMARY KEY,                                                  -- the source's ticket id
  source TEXT, order_id BIGINT, stop_key TEXT, train_id TEXT, location_id TEXT, delivered_at TIMESTAMPTZ,
  gallons_total DOUBLE PRECISION, per_unit JSONB, price_per_gal NUMERIC,
  status TEXT CHECK (status IN ('unmatched','matched','discrepancy','unverified')), telemetry_gallons DOUBLE PRECISION
);

CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY, type TEXT, severity TEXT, train_id TEXT, locomotive_id TEXT,
  message TEXT, dedup_key TEXT, status TEXT, raised_at TIMESTAMPTZ, details JSONB
);
CREATE UNIQUE INDEX ON alerts (dedup_key) WHERE status <> 'resolved';
```

The other tables are `locations`, `tracks` (miles, climb per direction, curvature, speed, dark flag), `routes`, `fuel_options` (price, fee, setup, pump rate, lead time, cancel fee, **bays**, active), `fuel_price_history`, `locomotives`, `trains` (path, planned tons), `consist_units`, `fueling_events`, `plan_evaluations`, `dtl_order_events`, `model_params` and `users`.

**Valkey keys** (prefix `lf:`):

| Key | Purpose |
|-----|---------|
| `telemetry:p{n}` | Partition streams, the Kafka stand-in |
| `loco:{id}:state` | Latest state hash, written by a sequence-guarded Lua script |
| `loco:{id}:filter` | Estimator state (watermark, level, variance, calibration sums) |
| `train:{id}:cal`, `train:{id}:plancal` | Measured train calibration, and the calibration the last evaluation assumed |
| `plan:requests`, `plan:pending:{id}`, `plan:lock:{id}` | Trigger queue, coalescing key, per-train planner lock |
| `ingest:batch:{id}` | Batch dedup fast path |
| `sim:clock` | Simulated clock |
| `events` | Pub/sub invalidations for SSE |
| `session:{id}` | Sessions |

## API Design

```
Devices (X-Device-Token; production: mTLS per unit)
POST /api/v1/telemetry/batch              → 202 accepted | 200 duplicate (same batchId) | 422

Integrations (X-Integration-Token)
PUT  /api/v1/integrations/clock                       simulator clock
GET  /api/v1/integrations/sim/bootstrap               trains, consists, last state
GET  /api/v1/integrations/trains/:id/instructions     plan in force + lifecycle + per-unit targets
POST /api/v1/integrations/trains/:id/plans/:v/accept  crew acknowledges on the cab tablet
PUT  /api/v1/integrations/stops/:stopKey/state        train on site → executing
POST /api/v1/integrations/trains                      new trip (dispatch)
POST /api/v1/integrations/trains/:id/reroute          path from a location ahead
POST /api/v1/integrations/trains/:id/arrive
POST /api/v1/integrations/fuel-tickets                idempotent on ticketId (201 | 200 duplicate)
POST /api/v1/integrations/prices                      price feed; {active:false} = station down

Fuel desk / crew / admin (session cookie)
POST /api/v1/auth/login | /logout, GET /me
GET  /api/v1/fleet                                    crew: own train only
GET  /api/v1/trains/:id                               plan, proposal, projection, versions, evaluations, orders
GET  /api/v1/trains/:id/telemetry                     raw vs smoothed
POST /api/v1/trains/:id/plans/:v/accept               fuel desk, or crew of that train (409 SLOT_TAKEN)
POST /api/v1/trains/:id/plans/:v/confirm | /reject    fuel desk: proposals after acceptance
POST /api/v1/trains/:id/replan                        fuel desk
GET  /api/v1/orders, POST /orders/:id/cancel, GET /tickets
GET  /api/v1/alerts, POST /alerts/:id/ack
GET  /api/v1/fuel-options, PUT /admin/fuel-options/:id (admin)
GET|PUT /api/v1/admin/params (admin writes), GET|PUT /admin/vendor (mock fault switches)
GET  /api/v1/events                                   SSE invalidations, filtered per viewer

Mock DTL vendor
POST /vendor/v1/orders (Idempotency-Key)   GET /vendor/v1/orders?idempotencyKey=
POST /vendor/v1/orders/:id/cancel          POST /vendor/v1/orders/:id/deliver (simulator)
```

## Key Design Decisions

### 1. DP over (station, fuel level), not greedy and not MILP

Greedy is provably optimal only when the only cost is per gallon. Real stops carry a truck call-out fee, 40-70 minutes of dwell at several hundred dollars per train-hour, and a stop penalty. Greedy buys "just enough to reach the cheaper station", so on a falling price gradient it stops at every station. In the tests a fee-heavy route costs greedy three stops and the DP one. A MILP handles everything, including joint bay assignment, but needs a solver, has unbounded tail latency, and produces plans that are hard to explain. The DP has a fixed state space, a deterministic runtime of a few milliseconds, and explanations that map to cost lines. Its price is the balanced-consist approximation (one headroom dimension), and no cross-train optimization.

### 2. Hysteresis on cost and on safety, plus an acceptance bar

The optimum moves with every burn update. Without hysteresis the crew's instructions would flip between Belen and Clovis. There are three bars:

- a saving threshold for recommendations;
- threshold + change cost, producing only a proposal, for accepted plans;
- a 5-point slack on the safety check of the plan in force.

What we give up is a little optimality: the system can keep a plan up to the threshold worse than the best one.

### 3. Recommendation ≠ acceptance ≠ execution

Reserving bays and ordering trucks for every recommendation would book capacity that plan churn then cancels, with a cancel fee each time. Only an explicit acceptance reserves anything, and only a human confirms a change after that. The cost is latency: a truck is ordered only after acceptance, so acceptance must happen comfortably before the DTL lead time. The crew is prompted when the first stop is within 8 hours.

### 4. Kafka partitioned by locomotive; latest state separate from history

Per-unit ordering without locks, exclusive ownership of each unit's estimator state, and horizontal scale by partition count. Latest state lives in Redis (O(1) reads for the board and planner). History lives in a time-series store (range scans, compression). Both are derived from the log, so either can be rebuilt by replay.

### 5. Alarms in the stream processor, not the planner

Low fuel and range risk are computed from telemetry and the static network by the processor, so they fire when the planner is down, timing out, or wrong.

### 6. Outcome-unknown is a first-class order state

After a timeout we ask before acting again. This works whether or not the vendor honours idempotency keys, and it makes cancellation correct even when we never learned the vendor's order id.

## Consistency and Idempotency

| Write | Source of truth | Success means | Retry behaviour |
|-------|-----------------|---------------|-----------------|
| Telemetry reading | Kafka log, then history PK | Appended (202) | Same batch: 200 duplicate. Re-appended reading: PK collision. Filter: sequence watermark |
| Estimator state | Keyed state (Redis locally) | Saved before the stream ack | Redelivery recomputes deterministically; insert conflicts |
| Latest state | Redis hash | Guarded HSET applied | Lua script ignores seq ≤ stored seq |
| Alert | PostgreSQL partial unique `dedup_key` | Row inserted | Repeats are no-ops |
| Plan version | PostgreSQL, one transaction (version + stops + evaluation) | Committed | Per-train lock; UNIQUE (train, version) and partial indexes are the fence |
| Acceptance | PostgreSQL transaction with per-option row lock | Commitments written | Second accept → 409; double click is harmless |
| DTL order | `dtl_orders.stop_key` UNIQUE + vendor Idempotency-Key | Vendor confirmed | Timeout → unknown → lookup → confirm or resubmit |
| Fuel ticket | `fuel_tickets.id` = source ticket id | Row inserted | Webhook redelivery → 200 duplicate |

**Ordering actually required:** per locomotive only, for the estimator. Plans need serializable per-train decisions (lock plus fence). Bays need per-option serialization at acceptance. Nothing needs global ordering.

## Security / Auth

- **Devices.** Locally a shared `X-Device-Token`; production uses mTLS with a per-unit certificate whose CN must match `locomotiveId`, so one compromised unit can't impersonate the fleet.
- **Integrations.** An integration token locally; production uses per-partner credentials and HMAC-signed webhooks.
- **People.** Session cookies (httpOnly, Valkey-backed, bcrypt passwords) and three roles:
  - fuel desk: plans, accept/confirm, orders, alerts;
  - crew: read-only for their own train, and may accept their train's recommendation;
  - admin: prices and parameters.
- **Access through async paths.** The access check runs on every endpoint and on the SSE stream. SSE events are invalidations filtered per viewer before writing, and the browser refetches through access-checked endpoints, so a crew session never receives another train's data via a broadcast.
- **Login rate limit:** 20 per minute per IP.

## Observability

Prometheus metrics (`backend/src/shared/metrics.ts`):

| Metric | What it shows |
|--------|---------------|
| `fueling_telemetry_ingested_total{outcome}`, `fueling_telemetry_processed_total{applied\|late\|duplicate}` | Ingest volume, and how often readings arrive late or twice |
| `fueling_processor_event_lag_seconds` | How far processing trails the clock |
| `fueling_plan_triggers_total{trigger,coalesced}` | What causes re-plans, and how much coalescing absorbs |
| `fueling_planner_run_seconds{decision}` | Planner latency by outcome |
| `fueling_vendor_call_seconds{op,outcome}`, `fueling_order_transitions_total{to}` | Vendor health and order flow |
| `fueling_alerts_raised_total{type}`, `fueling_sse_connections` | Alert mix, live viewers |

Pino JSON logs carry a service name. Every planner decision is queryable in `plan_evaluations`, every order step in `dtl_order_events`. Each process serves `/health`, `/ready` and `/metrics`.

Useful alerts:

- processor lag > 2 min;
- `late` readings above 5% (device clock or link problems);
- more than 20 orders sitting in `unknown` (vendor outage);
- planner fallbacks above 1% (DP budget too small);
- trigger rate per train above 1 per minute (thrash).

## Failure Handling

| Failure | Effect | Handling |
|---------|--------|----------|
| Device offline / dark territory | No readings | Device buffers and flushes in order. Estimator predicts across the gap. Planner widens margin by data age. UI shows "data 2.1 h old" |
| Duplicate or reordered delivery | Same reading twice, old after new | Batch id, PK, sequence watermark |
| Sensor bias | Estimate drifts | Fault rule flags the unit and dead-reckons. Tickets correct it |
| Processor crash | Unacked entries redelivered | Idempotent steps; state saved before ack |
| Planner down or slow | No new plans | Alarms continue in the processor. Plans in force remain. Triggers queue and coalesce. Unacked requests are reclaimed (XAUTOCLAIM) |
| Optimizer over budget | No DP result | Greedy fallback, else last good plan, labelled. Emergency path last |
| Vendor timeout / 5xx | Unknown outcome | Lookup by key; resubmit same key; give up with alert when out of time |
| Vendor refuses | No truck | Option excluded for the trip; re-plan; alert |
| Station down after acceptance | Accepted stop unusable | Plan voided → new recommendation, truck cancelled, alert, re-accept |
| Pad congested | Wait at pad | Queue minutes priced. Acceptance enforces bays (409). Reservations expire |
| Price-feed storm | Hundreds of re-plans | Coalescing, per-train lock, horizontal planners |

## Scalability Considerations

**What breaks first.** At about 3-10 planner runs per second the planner is cheap; the DP takes milliseconds. Under load the first bottleneck is the **trigger fan-out on price updates and the synchronous PostgreSQL writes per evaluation**. A daily price file touching 300 locations re-plans most of 1,500 trains in a minute: about 1,500 transactions, each writing an evaluation row with a projection. Evidence: locally, each run writes 2-5 rows and costs ~5-15 ms of DB time. Mitigations:

- write evaluations to a log or warehouse, not the OLTP database;
- skip the version write when the decision is "keep";
- shard planners by train id;
- batch price changes into one trigger per train.

**Telemetry at 1.6M points/s** (the full sensor variant): partition by locomotive across about 64-128 partitions. Aggregate at the edge (send fuel channels at 30 s, engine channels as 1-minute summaries). Use a columnar time-series store with retention tiers. The estimator is O(1) per reading and keyed, so it scales linearly with partitions.

**Read side.** Fleet board fan-out is solved by SSE invalidations plus cached read models per train. Crew tablets fetch only their own train.

**Hot spots.** A single congested pad serializes acceptances on its row lock. That is fine at tens per hour. At scale, move bay assignment to a per-pad scheduler service.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Optimizer | DP over (node, headroom) | Greedy / MILP | Prices fees and dwell; bounded runtime; explainable |
| Consist model | One headroom dimension, per-unit targets | DP over every unit's level | Exponential state otherwise; costs a little optimality when units are unbalanced |
| Objective | Total trip cost with reserve as a hard constraint | Purchase cost only / weighted safety penalty | Dwell and fees are real money; safety is never traded |
| Plan stability | Hysteresis + acceptance bar + proposal | Always adopt the optimum | Crews and reservations need stable instructions |
| Safety check | Keep-margin 5 pts below plan margin | Same margin for both | Plans sit on the boundary; avoids void/replan thrash |
| Capacity | Plan per train against reservations, enforce at accept | Joint assignment | Decoupled, explainable; loses global optimality at congested pads |
| Ingest log | Kafka keyed by locomotive | Shared queue / direct DB writes | Per-unit order, replay, backpressure |
| Late data | Forward-only estimator, history keeps late rows | Re-run filter on late data | Simple and idempotent; loses a little information |
| Fuel level | Notch-predicted Kalman with median and tilt compensation | Raw sensor / moving average | Slosh is hundreds of gallons; model predicts the trend |
| Vendor outcome | Explicit unknown + lookup by key | Retry blindly / fail fast | No double trucks, no silent misses |
| Alarms | In the stream processor | In the planner | Fire when the planner is down |
| Live UI | SSE invalidations + refetch | WebSocket pushing data | One-way, proxy-friendly, access checks stay in REST |

## Implementation Notes

### Local architecture

| Process | Default port | Entry | Production counterpart |
|---------|--------------|-------|------------------------|
| API | 3000 | `backend/src/api/index.ts` | Ingest gateway + REST/SSE gateway |
| Processor | 3100 (metrics) | `backend/src/processor/index.ts` | Flink / Kafka Streams job |
| Planner + order worker + reconciliation | 3200 (metrics) | `backend/src/planner/index.ts` | Planner service, order service |
| Mock DTL vendor | 3300 | `backend/src/vendor/index.ts` | Partner API |
| Simulator | 3400 (control) | `backend/src/simulator/index.ts` | Onboard units, crews, pads, dispatch, price feed |
| Frontend | 5173 | `frontend/` | Fuel desk SPA and crew tablet |

### Production-grade patterns actually implemented

- **Idempotent ingest at two layers.** A batch-id fast path is set after a successful append. Natural-key dedup uses the history primary key and the estimator watermark (`api/services/ingest.ts`, `processor/estimator.ts`). This matters because devices retry on any timeout; without both layers, a flaky link doubles fuel burn in the history.
- **Partitioned streams with consumer groups.** Valkey streams `telemetry:p0..p3`, routed by FNV hash of locomotive id (`shared/partition.ts`). `PROCESSOR_PARTITIONS=0,1` assigns partitions to an instance, so two processors split the fleet like Kafka consumers. The processor acks only after history, state, alerts and triggers are written, and drains its own pending entries on restart.
- **Sequence-guarded latest state**, via a Lua compare-and-set on the hash (`shared/state.ts`).
- **The estimator**: median, Kalman-style correction, tilt compensation, fault and leak detection, calibration (`processor/estimator.ts`, 12 tests).
- **The DP optimizer** with suffix-minimum inner loop, greedy baseline, simulator for pricing and profiles, and time budget (`planner/optimizer.ts`, 11 tests including 60 random greedy-equivalence cases).
- **Lifecycle, hysteresis with acceptance bar and safety slack, proposals, emergency and fallback paths** (`planner/plan-service.ts`, `planner/hysteresis.ts`).
- **Confidence and widened margins for uncertain inputs** (`planner/confidence.ts`).
- **Pad capacity:** queue estimation in planning, bay enforcement with row locks at acceptance, expiry sweep (`planner/capacity.ts`, `planner/acceptance.ts`).
- **The DTL order state machine** with unknown outcome, lookup-before-retry, fenced writes and leased claims (`orders/state-machine.ts`, `orders/order-worker.ts`, 8 tests with a fake vendor).
- **Ticket reconciliation**, with ordered corrections through the partition stream (`orders/reconcile.ts`).
- **Prometheus metrics** (prom-client), **Pino** JSON logs, health and readiness endpoints, zod validation, and session auth with roles.

A trimmed example of the order step:

```typescript
// orders/state-machine.ts
case 'unknown': {
  const found = await vendor.lookup(order.stopKey)          // ask before acting again
  if (found.kind === 'found') return { to: 'confirmed', vendorOrderId: found.vendorOrderId, note: '…succeeded after we stopped waiting' }
  if (found.kind === 'not_found') return submit(order, vendor, ctx, 'Lookup found nothing; resubmitted with the same key')
  return giveUpOrWait(order, ctx, `Lookup failed (${found.message})`)
}
```

### Simplified or substituted

- Kafka → Valkey streams (4 partitions); Flink keyed state → per-process maps persisted to Valkey; TimescaleDB/Cassandra → a PostgreSQL table with the same key.
- Simulated time (180×). Domain timestamps are simulated time; leases and retry backoff use the wall clock.
- A fictional network with real town names; illustrative prices, climbs and fleet.
- A physics-lite burn model, and a simulator whose "truth" uses the same physics with hidden tonnage, efficiency, leak and sensor-bias factors.
- One shared device token and integration token instead of mTLS and per-partner credentials.
- A single PostgreSQL; plans and orders written synchronously.
- DTL truck capacity per order is not modelled (one order may imply two trucks), and DTL orders aren't amended when gallons change (the truck fills to the plan's targets).
- No reorder buffer: late readings go straight to history.
- The simulator plays the crew: it accepts a recommendation when the first stop is within 8 h, and only stops for accepted plans.

### Omitted

Multi-region deployment, CDN, Kubernetes, sharded planners, a real map-matching service (PTC milepost is given), crew hours-of-service and meet/pass planning, locomotive assignment and unit isolation (shutting down a unit to save fuel), joint multi-train bay optimization, and a warehouse for fuel accounting.
