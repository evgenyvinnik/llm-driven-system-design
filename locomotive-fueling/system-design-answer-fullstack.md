# Locomotive Fueling — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → End-to-end architecture → Data and API → Planner → Lifecycle across UI and backend → Deep dives → Traces → Scale*

> "We're recommending where each train should fuel and how much, from live fuel level, GPS, route, burn rate and prices. End to end there are four parts. Telemetry flows from the locomotive into a per-unit estimate. A planner turns the estimate into a stop plan. An execution layer reserves pad bays and orders trucks. And a UI lets a fuel desk and a crew trust and act on all of it. I'll go broad, then dive into the three places where the backend and the frontend have to agree on the same idea. Stability: the plan doesn't flip, and the screen shows why. Freshness: the data is late, and the screen says so. Uncertainty at the vendor: we don't know if the truck was ordered, and the screen says that too."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Hard reserve constraint, total-cost objective, three user surfaces |
| Architecture, data, API | ~8 min | Log keyed by locomotive, planner, lifecycle tables, SSE invalidations |
| Planner and lifecycle | ~7 min | DP plus fallbacks; recommended → accepted → executing |
| Deep dives | ~15 min | Stability, freshness, unknown vendor outcomes, from database to pixel |
| Traces, checklist, scale | ~8 min | One success, one failure, what breaks first |

---

## 🎯 Requirements (~5 min)

**Clarifying questions (and the answers I'll assume)**

| Question | Assumption |
|----------|------------|
| Who acts on a recommendation? | Fuel desk or crew accepts; only the desk confirms changes after acceptance |
| Train or unit level? | One stop decision per train, gallons per unit |
| What fueling options exist? | Pads (cheap, limited bays) and DTL trucks (call-out fee, 6 h notice) |
| How fresh is telemetry? | 10-60 s, with multi-hour gaps in dark territory |
| Is running low ever acceptable? | No: the reserve is a hard constraint everywhere |
| Who uses the UI, on what? | Desk on desktops; crew on a cab tablet that goes offline; admins on desktops |

**Functional**

1. Ingest telemetry from every locomotive: position and PTC milepost, speed, notch, engine state, raw fuel level.
2. Estimate true fuel per unit; flag leaks, theft and sensor faults; alarm on low fuel.
3. Recommend stops and per-unit gallons over each train's remaining route.
4. Plan lifecycle: recommended → accepted (fuel desk or crew) → executing → fueled, with versions and reasons. Changes after acceptance are proposals the desk confirms.
5. Reserve pad bays on acceptance, order DTL trucks, reconcile tickets.
6. UI: live fleet board, train plan view, orders, anomalies, prices and model admin, and the crew tablet.

**Non-functional**

| Property | Target |
|----------|--------|
| Board freshness | 2-5 s after a change |
| Low-fuel alarm | < 60 s, independent of the planner |
| Re-plan after a trigger | p95 < 30 s; planner p99 < 500 ms per train with a fallback |
| Safety | No accepted plan below reserve under the planning margin |
| Orders | Exactly one vendor order per accepted stop |
| Tablet | Last plan readable offline, labelled with its age |

**Scale (assumptions)**

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Locomotives | ~8,000 | One partition owner per unit |
| Readings | ~270/s, bursts ~2,700/s | A thin gateway and a log, not direct database writes |
| History | ~23M rows/day | Time-series store with compression |
| Trains running | ~1,500 | Planner runs 3-10/s; ~500 in a minute on a price file |
| Fuel-desk screens | ~50 | One SSE connection each; coalesced refetch |
| Crew tablets | ~1,500 | One train each, metered cellular |

---

## 🏗️ End-to-End Architecture (~4 min)

```
 Locomotive                    Backend                                              Browser
┌──────────┐ batch  ┌───────────┐ append ┌──────────────────┐   ┌───────────────────┐
│ onboard  │──────▶ │ ingest GW │──────▶ │ Kafka telemetry  │──▶│ stream processor  │
│ unit     │ (mTLS) │ dedupe,   │        │ key = locomotive │   │ estimator,        │
└──────────┘        │ sort      │        └──────────────────┘   │ anomalies, alarms │
                    └───────────┘                               └──┬──────┬─────┬───┘
                                                                   ▼      ▼     ▼
                                                    latest state (Redis) │  re-plan triggers
                                                                         ▼           │
                                                                    alerts (PG)      ▼
                        ┌────────────────────────────────────────────────────────────────┐
                        │ planner: inputs + confidence → DP (budget) → hysteresis →      │
                        │ version / proposal → reservations → DTL orders (worker)        │
                        └──────────────┬──────────────────────────────────┬──────────────┘
                                       ▼                                  ▼
                              PostgreSQL (plans, stops,           DTL vendor API
                              commitments, orders, tickets)       (key, timeout → unknown)
                                       │
                        ┌──────────────┴──────────────┐  pub/sub "T03 changed"
                        │ API: REST (role-checked) +  │◀─────────────────────────── workers
                        │ SSE invalidations per viewer│
                        └──────────────┬──────────────┘
                                       ▼
          ┌─────────────────────────────────────────────────────────────────────┐
          │ React: fleet board · plan view · orders · anomalies · crew card     │
          │ refetch on invalidation (coalesced) · poll when offline · cache     │
          └─────────────────────────────────────────────────────────────────────┘
```

> "The one contract I want to call out is between the workers and the browser. Workers publish 'this train changed', and the browser refetches through REST. So the access check lives in exactly one place. A crew tablet gets events only for its own train, and the events contain no data at all."

---

## 💾 Data Model (~2 min)

| Table | Purpose | Key detail |
|-------|---------|------------|
| telemetry | History | PK (locomotive_id, seq) absorbs replays; `late` flag |
| fuel_options, price history | Pads and DTL sites | Price, fee, setup, pump rate, lead time, **bays**, active |
| fuel_plans + plan_stops | Immutable versions | Lifecycle, source (dp / greedy fallback / last good), confidence, assumptions, reason; one current, one proposed |
| plan_evaluations | Every planner run | Decision and explanation, even for "kept" |
| stop_commitments | Accepted stops | Bay slot, expiry; the only thing that reserves capacity |
| dtl_orders + events | Truck orders | stop_key unique = idempotency key; status includes `unknown` |
| fuel_tickets | Deliveries | Source ticket id PK; matched against telemetry |
| alerts | Safety and ops | Partial unique dedup key while open |

---

## 🔌 API (~2 min)

```
POST /api/v1/telemetry/batch               device → 202 | 200 duplicate
GET  /api/v1/fleet                         board (crew: own train only)
GET  /api/v1/trains/:id                    plan, proposal, projection, versions, evaluations, orders
POST /api/v1/trains/:id/plans/:v/accept    desk or that train's crew → 200 | 409 SLOT_TAKEN
POST /api/v1/trains/:id/plans/:v/confirm   desk confirms a proposal  |  /reject keeps the current one
GET  /api/v1/orders  · GET /tickets  · GET /alerts
PUT  /api/v1/admin/fuel-options/:id        admin: price or close a facility
GET  /api/v1/events                        SSE invalidations
```

---

## 🔄 Request Flow: One Reading to One Pixel (~3 min)

1. **Device.** The lead unit's gateway sends a batch every reporting interval: one reading per unit with a sequence number. Retries reuse the batch id.
2. **Ingest gateway.** It validates, drops in-batch repeats, sorts by (unit, seq), appends to the partition for each unit and answers 202. A repeated batch id gets `200 duplicate`.
3. **Stream processor (partition owner).** Per unit, it predicts from the notch, removes the grade tilt, takes the median, and corrects. It writes history (the PK drops replays) and saves estimator state. It updates latest state with a sequence-guarded write, raises or resolves alerts, enqueues triggers (station passed, burn drift, leak, fueling), and acknowledges the log last.
4. **Pub/sub.** "train T01 changed", at most once a second per train.
5. **API process.** Each SSE connection checks the event against its viewer (crew: own train only) and writes `event: train`.
6. **Browser.** The live store bumps the counters for that train and that kind. The page's hook coalesces them for up to two seconds and refetches.
7. **REST.** `GET /fleet` joins latest state (Redis) with plans, orders and alerts (PostgreSQL) for the trains this user may see.
8. **React.** Only the rows whose summary changed re-render. The fuel bar moves and the "data age" label stays "live".

> "Every step either is idempotent or happens after a durable step. A failure anywhere means 'do it again', and doing it again is harmless. The browser is the last step and the simplest: it only ever asks 'what's true now?'"

## 🧾 The UI/Backend Contract (~2 min)

| Field | Backend meaning | UI use |
|-------|-----------------|--------|
| `plan.lifecycle` | recommended, accepted, proposed, superseded, rejected | Chip, and which buttons appear |
| `plan.source` | dp, greedy_fallback, last_good | "Optimized" or a warning chip |
| `plan.confidence` + `assumptions[]` | Margin widened by data age, drift, faults | Chip plus a bullet list, open when not high |
| `plan.reason` | Sentence written by the decision logic | Shown verbatim under the plan title |
| `stops[].perUnit[]` | Arrival level, target, gallons per unit | "6012 2,281 → 3,933" or "no fuel needed" |
| `stops[].commitment` | accepted, executing, fueled, cancelled, expired + slot and expiry | "Bay reserved, held until 19:03" |
| `stops[].orderStatus` | DTL order state, including `unknown` | "Outcome unknown" chip |
| `stops[].queueMinutes` | Expected wait from other trains' reservations | "incl. ~25 min queue" |
| `projection` | Expected profile from the latest evaluation | The chart, labelled with when it was computed |
| `train.lastSeenMs` | Lead unit's last processed reading | "fuel data 2.1 h old" |
| Error `code` | SLOT_TAKEN, NOT_ACCEPTABLE, NOT_PROPOSED, FORBIDDEN | Specific messages; refetch on conflicts |

> "Putting the reason sentence and the confidence on the wire, rather than computing them in the browser, means the screen can't disagree with the evaluation log. The UI renders what the planner decided; it never re-derives it."

---

## 🧮 Planner in One Breath (~4 min)

**What we minimize.** Fuel purchases + truck call-out and cancellation fees + delay (setup, queue and pumping × a train-hour cost) + a stop penalty − credit for fuel carried to the destination (valued below the destination price).

**Hard constraints.** Every unit at or above its reserve at every station, under inflated (~p90) burn; tank capacity; one option per stop; DTL lead time.

**How.** The consist becomes one virtual tank called "headroom": train-gallons until the first unit hits reserve. Each unit's share of burn is its horsepower × efficiency × measured calibration. A DP runs over (station, headroom on a 25-gal grid). The gallon-dependent cost is linear, so the inner minimum is a suffix minimum, and a train takes milliseconds.

**Greedy baseline.** If a cheaper station is reachable, buy just enough to reach it; else fill. It is optimal for per-gallon cost only; the DP matches it there and beats it once fees and dwell matter.

**Uncertain inputs** widen the margin: +3%/h of data age, up to +10% for burn drift, +5% for faulty sensors or leaks, capped at +20%. The plan is labelled high, medium or low confidence, with the assumptions listed.

**Fallbacks.** DP over its 500 ms budget → greedy (labelled) → last good plan (labelled) → emergency (plan through reserve and page the desk).

---

## 🔁 Lifecycle Across UI and Backend (~3 min)

| State | Backend meaning | What the UI shows | Who can act |
|-------|-----------------|-------------------|-------------|
| Recommended | Plan in force, reserves nothing | Blue chip; "reserves nothing until accepted" | Desk or the train's crew: Accept |
| Accepted | Commitments hold bays; DTL stops get trucks inside 12 h | Green chip; "accepted by crew at 20:46"; "Bay reserved, held until 19:03" | Desk: re-plan |
| Proposed | Cheaper plan found after acceptance (saving > threshold + change cost) | Amber card, side by side, Confirm / Keep current | Desk only |
| Executing → fueled | Train on site; ticket arrived | "Fueling now", then the ticket in reconciliation | — |
| Voided | Accepted plan unsafe or a station went down | Critical alert; new plan shows as Recommended | Desk or crew: Accept the replacement |

Bays are enforced at acceptance with a per-pad row lock: first to accept wins, and the second gets 409 and a re-plan that prices the queue. Reservations follow the train's ETA and expire if it doesn't show.

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: Plan stability, from the optimizer to the screen

**Decision.** A DP for the optimum, with three hysteresis bars, proposals instead of silent changes after acceptance, and a reason sentence generated by the decision logic and shown verbatim in the UI.

**Why it works.** Burn estimates move every few minutes, so the optimum moves too. The three bars:

1. A recommended plan changes only if it's unsafe or saves more than max($150, 2%).
2. An accepted plan needs the threshold plus a $400 change cost, and even then it becomes a proposal the desk confirms.
3. The safety check on the plan in force runs at a margin 5 points below planning. DP plans buy just enough, so they sit on the boundary, and without slack every small update voided them. I hit exactly that thrash while building it.

On screen, stability is visible rather than mysterious: "kept the current plan: the alternative saves only $189, under the $550 threshold". The proposal card shows what confirming would release and cancel.

**Why the alternatives fail.**

- **Always adopting the optimum** makes the crew's instruction flip between Belen and Clovis, and churns reservations and truck orders that each cost a cancellation fee.
- **Greedy instead of the DP** would be stable-ish, but it stops at every station on a gently falling price gradient once fees and dwell count. In my test it made three stops where the DP made one.
- **MILP** can do joint bay assignment, but brings unbounded tail latency in a price storm and plans nobody can explain at 3 a.m.

**What I give up.** A plan can sit up to the threshold above the optimum. The consist is planned as balanced units (one headroom dimension). Pads are planned per train against reservations, not jointly.

### Deep dive 2: Freshness, from Kafka partitions to "data 2.1 h old"

**Decision.** The log is keyed by locomotive. The estimator is forward-only with a sequence watermark. Latest state is in Redis and history in a TSDB. Data age flows into the planner's margin and onto the screen.

**Why it works.** One consumer owns each unit, so the estimator (notch-predicted level, median for spikes, tilt compensation for grades, sensor-trust down while accelerating) runs without locks. Duplicates are caught twice: the device batch id answers retries with `200 duplicate`, and the `(locomotive, seq)` primary key catches anything appended twice. Readings that arrive after newer ones are stored as `late` but never rewind the estimate. Alarms run in this processor, so they don't depend on the planner.

Freshness then flows forward. The planner computes data age from the lead unit's last reading and widens the margin by 3% per hour. The plan carries "fuel data is 2.1 h old" as an assumption. The board row and plan header show the age in amber. The UI refetches on SSE invalidations coalesced to 2 s, polls when the stream drops, and the crew tablet serves its last good copy under an offline banner.

**Why the alternatives fail.**

- **A shared queue** interleaves one unit's readings across workers and corrupts the filter.
- **Direct database writes** from devices storm the database when 2,000 units leave dark territory at once.
- **Trusting raw readings:** slosh on a grade is ~250 gallons, an hour of burn.
- **Hiding data age** makes a 3-hour-old plan look as authoritative as a live one.

**What I give up.** Late readings never improve the live estimate, and the refetch model adds a round trip per burst.

### Deep dive 3: Unknown vendor outcomes, made visible

**Decision.** One DTL order per accepted stop, keyed `train:location:option` and sent as the Idempotency-Key. A timeout is the explicit state `unknown`; we look up by key before retrying. Every transition is an event with a human sentence, shown in the orders view.

**Why it works.** After a timeout the vendor may already have created the order. A blind retry double-books a truck if the vendor isn't idempotent. Treating it as a failure leaves a truck idling while the train fuels elsewhere. So:

- the worker claims orders with a lease and calls the vendor outside a transaction;
- it writes the result fenced on the status it read;
- `unknown` triggers a lookup by key: found → confirmed, missing → resubmit with the same key;
- out of time → failed, with "call the vendor" on the desk's screen and a re-plan without that option.

The order row expands to show "pending → unknown: no response in 2,500 ms" and then "unknown → confirmed: vendor has DTL-1002; the earlier request succeeded after we stopped waiting". The desk sees the system reasoning, not a spinner.

**Reconciliation.** It closes the loop. Ticket gallons per unit are compared with telemetry-detected fueling. A 15% short fill opens a dispute alert. For faulty-sensor units the ticket becomes the level, applied in order through the locomotive's partition.

**Why the alternatives fail.** Retrying blindly gives two trucks. Failing fast gives a stranded order. Hiding the unknown state from the UI makes the desk call the vendor for every slow response, or never.

**What I give up.** An extra round trip on uncertainty. Orders also wait for acceptance, so acceptance must land well before the 6-hour lead time; the crew is prompted at 8 hours.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a heavier-than-planned train

1. Q-KCKBAR leaves Kansas City planned at 9,800 t but actually weighs ~12,500 t. Readings flow every 3 simulated minutes.
2. Calibration climbs past the band: the train burns +19% vs the model. The processor enqueues `burn_deviation` (coalesced per train).
3. The planner widens the margin (+9% for drift), so confidence is medium. The plan in force is still safe at the keep margin, and the candidate's saving is under the bar, so the plan is kept. The evaluation row says why.
4. At a later checkpoint the plan in force would breach reserve at Kingman, even at the keep margin. The planner writes a new recommendation: "replanned because the current plan would leave a unit below reserve at Kingman".
5. The SSE event bumps the train's counter. The plan view refetches and shows the new version, its reason, and the chart's new sawtooth. The crew accepts on the tablet, which reserves the bay.

### Failed trace: the vendor refuses after acceptance

1. A crew accepts a plan with a Gallup DTL stop. When the stop is inside the 12-hour window, the order is created `pending`.
2. The vendor answers 409 "no truck available". The order goes `rejected`. An alert opens, and a re-plan runs with Gallup DTL excluded for this trip.
3. The accepted plan now uses an unusable option, so hysteresis returns *unsafe*. The plan is voided and replaced by a recommendation, and a critical alert reads "accepted plan voided". The Gallup commitment is released.
4. The board row shows the alert and "Recommended". The desk opens the plan, reads "Not usable: GAL-DTL: order rejected earlier this trip" in the assumptions, and accepts the replacement, or the crew does.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; successful write? | Telemetry: the log, on a durable append. Plans, commitments, orders, tickets: PostgreSQL commit. The UI shows actions only after a 2xx |
| Retry after a lost response? | Batch id duplicate; reading PK; ticket id PK; second accept → 409; vendor retries reuse the key after a lookup |
| Failure between steps? | Processor saves state before the ack; plan and evaluation share a transaction; order lease and fence plus lookup; the UI refetches after every action |
| Ordering required? | Per locomotive, per train, per pad at acceptance. Nothing global |
| Access with async paths? | SSE events carry ids, are filtered per viewer, and data comes through role-checked REST |
| What breaks first? | Planner writes in price storms (2-5 rows per run × ~1,500 trains); then board rendering past ~200 rows; then partitions for full sensor ingestion |

---

## ❓ Follow-ups

- **What exactly do you minimize, and what's hard?** Total trip cost (purchases, fees, delay, stops, cancellations, minus the destination credit). The reserve, capacity, one option per stop and lead time are constraints, never penalties.
- **An accepted plan and a cheaper option.** A proposal above the higher bar, with side-by-side comparison; nothing changes until the desk confirms.
- **The optimizer times out.** Greedy, then last good plan, labelled on screen; a fallback never displaces a safe plan.
- **A station goes down after acceptance.** Re-plan without it, void and alert, cancel the truck idempotently, ask for re-acceptance.
- **Stale or uncertain inputs.** Still recommend; widen the margin; show confidence and the assumptions.
- **Shared pads.** Plan per train against reservations; enforce bays at acceptance (409); reservations expire. Joint planning is the next step for congested pads.
- **Location pings and sensor ingestion at 3,000+ trains.** The same keyed log; edge aggregation; columnar storage; more partitions.

---

## 🚨 Failure Handling (~2 min)

| Failure | Backend | UI |
|---------|---------|----|
| Dark territory | Device buffers; estimator predicts across the gap; margin grows with data age | "data 2.1 h old", lower confidence; tablet shows its cached plan with an offline banner |
| Duplicate or late readings | Batch id, PK, sequence watermark; late rows kept for audit | Hollow dots on the sensor chart |
| Faulty sensor | Flag, dead-reckon from notch, correct from tickets | "Sensor faulty: dead reckoning" chip; assumption listed |
| Planner down | Alarms keep firing from the processor; plans in force stay; triggers queue | Board still updates fuel and alerts; plan timestamps age |
| Optimizer over budget | Greedy, then last good, labelled | "Greedy fallback" chip |
| Vendor timeout or refusal | Unknown → lookup; refusal → exclude and re-plan | Order trail explains each step |
| Station down after acceptance | Void, re-plan, cancel the truck, alert | Critical alert; plan back to "Recommended" |
| SSE drops | Nothing to do server-side | Amber "Reconnecting (polling)"; catch-up refetch on reconnect |

## 🧪 Testing Strategy (~1 min)

- **Optimizer:** the DP equals greedy on 60 random per-gallon routes and beats it with fees; reserve and capacity are never violated; committed stops, lead time and terminal credit behave as expected; the time budget falls back.
- **Estimator:** smoothing beats raw readings 3× under slosh; duplicates and late readings never move the state; gaps; fueling, sensor-fault and stationary-loss detection; calibration on a heavy train; leak vs consist-mates.
- **Orders:** a fake vendor that loses responses, refuses, or is down for lookups; exactly one vendor order after a timeout; cancel by key.
- **API:** supertest with mocked database and cache for auth, roles, crew scoping, ingest dedup and ordering, and ticket idempotency.
- **End to end:** a simulator scripting a heavy train, a leak, a sensor fault, a reroute, price changes, a station outage, and vendor timeouts, refusals and short fills, plus Playwright smoke tests for each page.

---

## 📈 Scale (~2 min)

| Component | First limit | Next step |
|-----------|-------------|-----------|
| Planner writes | Price storm: ~1,500 transactions with projections in a minute | Skip writes on "keep", move evaluations to a log, shard by train |
| Telemetry | Partitions, at full sensor rates (~1.6M points/s) | Edge aggregation, 64-128 partitions, columnar TSDB |
| Fleet board | Re-render past ~200 rows | Virtualized rows, regional filters |
| SSE fan-out | Every desk receives every train event | Channel per region |
| Congested pad | Row lock serializes acceptances | Per-pad scheduler service |

---

## ⚖️ Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| ✅ DP + hysteresis + proposals | Stable, explainable, fast | Up to a threshold above optimal |
| ❌ Re-plan and replace always | Always optimal | Instructions flip; reservations churn |
| ✅ Log keyed by locomotive | Per-unit order, replay | Hot partition risk |
| ✅ Reserve only on acceptance | No phantom bookings | Orders wait for a human |
| ✅ Unknown + lookup for vendor | No double trucks | Extra round trip |
| ✅ SSE invalidations + refetch | One auth path, proxy-friendly | Round trip per burst |
| ❌ WebSocket with data | Lower latency | Per-viewer data filtering on the push path |
| ✅ Labelled stale cache on tablet | Useful offline | Can be hours old |

---

## 📝 Wrap-up (~1 min)

> "Each hard problem appears twice, once in the backend and once on the screen. Plans are stable because of hysteresis and acceptance bars, and the screen says why each one changed. Data is late because of tunnels, so the planner widens its margin and the screen shows the age. The vendor can leave us not knowing, so we model 'unknown' and show the reasoning. The safety floor, the reserve, is a constraint everywhere and an alarm that doesn't depend on the optimizer. Next: joint bay assignment at congested pads, unit isolation, and a map view."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Kafka keyed by locomotive | Valkey streams, 4 partitions, consumer groups |
| Flink keyed state | Per-process maps persisted to Valkey before the ack |
| TimescaleDB / Cassandra | PostgreSQL table with the same key |
| mTLS per device, partner credentials | Shared device and integration tokens |
| Real onboard units, crews, pads, vendors | Simulator at 180× plus a mock DTL vendor with fault switches |

Valkey streams stand in for Kafka (4 partitions keyed by locomotive) and a PostgreSQL table for the TSDB. A simulator at 180× plays the onboard units, crews, pads, dispatch and price feed, with scripted faults. The React app uses one EventSource, coalesced refetch, a polling fallback and a cached crew view. The DP, lifecycle, reservations, order state machine and reconciliation are implemented and covered by unit and API tests.
