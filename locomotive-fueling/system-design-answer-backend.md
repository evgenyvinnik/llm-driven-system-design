# Locomotive Fueling — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → API → Telemetry → Planner → Lifecycle → Deep dives → Traces → Scale*

> "The prompt is: use real-time fuel level, GPS, route, burn rate and fuel prices to recommend where a locomotive should stop for fuel and how much to buy. I'll split it into three systems that fail differently. First, a telemetry pipeline that turns noisy, late, duplicated sensor readings into a trustworthy fuel estimate per unit. Second, a planner that turns that estimate into a stop plan. Third, an execution layer, where the plan becomes reserved fuel bays and truck orders at a vendor who can time out. Three ideas carry the answer. The optimizer minimizes total trip cost, but the reserve is a hard constraint, never a cost. A plan has a lifecycle: recommended, accepted, executing. Each step raises the bar for changing it. And a timeout from the vendor means 'I don't know', never 'it failed'."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Safety is a constraint; costs include dwell and fees, not only price |
| Architecture | ~5 min | Ingest → Kafka by locomotive → stream processor → planner → orders |
| Data model and API | ~5 min | Immutable plan versions, commitments, orders keyed by stop |
| Telemetry and planner | ~10 min | Kalman-style estimator; DP over (station, fuel level) |
| Deep dives | ~13 min | Optimizer and stability, ingestion at fleet scale, unknown vendor outcomes |
| Traces, checklist, follow-ups | ~5 min | One success, one failure, six review questions |
| Scale and wrap-up | ~2 min | What breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who acts on the recommendation? | Decides whether the system commits anything by itself | The fuel desk or crew accepts. The system recommends, reserves only on acceptance, and orders trucks only for accepted stops |
| Train or locomotive level? | A consist is 2-5 units with separate tanks | Plan per train (one stop decision), fuel per unit (per-unit targets) |
| What fueling options exist? | Changes the cost structure | Fixed pads at terminals (cheap, limited bays) and direct-to-locomotive trucks at sidings (pricier, a call-out fee, 6 h notice) |
| How fresh is telemetry? | Drives the estimator and the margins | 10-60 s reports over cellular or satellite, with gaps of hours in dark territory |
| Is running out an option? | Defines hard vs soft | Never. A stranded train blocks a main line. Reserve at every point is a hard constraint |
| Does the route change? | Plans must react | Yes: reroutes, delays, heavier-than-planned trains, price changes, stations going down |

### Functional requirements

1. Ingest telemetry: position and PTC milepost, speed, notch, engine state, raw fuel level.
2. Estimate true fuel per unit. Detect leaks, theft and sensor faults.
3. Forecast burn per segment from tonnage, grade, speed and the unit's own history.
4. Recommend stops and per-unit gallons over the remaining route.
5. Track the plan lifecycle (recommended, accepted, executing, fueled) with every version and its reason.
6. Reserve pad bays and order DTL trucks for accepted stops, then reconcile the tickets.
7. Raise low-fuel and range alarms from telemetry, even if the planner is down.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Ingest | p99 < 200 ms to a durable log; 99.95% | Thin, stateless gateway; device-side buffering |
| Estimate freshness | p99 < 5 s | Streaming, not batch |
| Low-fuel alarm | < 60 s from evidence, planner-independent | Alarms live in the stream processor |
| Re-plan | p95 < 30 s after a trigger | Event-driven planner, coalesced triggers |
| Planner runtime | p99 < 500 ms per train | Bounded algorithm plus a fallback |
| Safety | Zero accepted plans breaching reserve | Reserve as a constraint with a margin |
| Orders | Exactly one vendor order per accepted stop | Idempotency key plus lookup-before-retry |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Locomotives | ~8,000 (assumption) | Large Class I fleet |
| Telemetry | ~270 msg/s average, ~2,700/s burst | 8,000 ÷ 30 s; bursts when coverage returns |
| History | ~23M rows/day, ~2 GB/day compressed | ~80-300 B per reading |
| Trains running | ~1,500 | 3-6 units each |
| Planner runs | 3-10/s, ~500 in a minute on a price file | Station passages, burn drift, prices |
| Fuel events | ~5,000/day, ~1,000 DTL | Each unit fuels every 1-2 days |

> "These are small numbers for streaming but large for the database. 270 messages a second is one Kafka partition's afternoon. The interesting load is the planner fan-out when the daily price file lands and 500 trains re-plan at once, and each re-plan writes. The full engine-sensor variant of this prompt, 3,000+ trains with hundreds of channels at 1 Hz, is about 1.6 million points a second. That's the same pipeline with edge aggregation and a columnar store. I'll come back to it."

---

## 🏗️ High-Level Architecture (~5 min)

```
┌──────────────┐  batches   ┌──────────────┐  append   ┌──────────────────────────────┐
│ Onboard unit │──────────▶ │ Ingest GW    │─────────▶ │ Kafka telemetry              │
│ (buffers in  │  mTLS      │ validate,    │  acks=all │ partition = locomotive id    │
│  dark areas) │            │ dedupe, sort │           └──────────────┬───────────────┘
└──────────────┘            └──────────────┘                          ▼
                                            ┌──────────────────────────────────────────┐
                                            │ Stream processor (keyed state per unit)  │
                                            │ estimator · anomalies · calibration ·    │
                                            │ station passage · range alarm            │
                                            └──┬──────────┬─────────────┬───────────┬──┘
                                               ▼          ▼             ▼           ▼
                                        ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
                                        │ Latest   │ │ TSDB    │ │ Alerts   │ │ Re-plan  │
                                        │ state    │ │ history │ │          │ │ triggers │
                                        │ (Redis)  │ │         │ │          │ │ coalesce │
                                        └────┬─────┘ └─────────┘ └──────────┘ └────┬─────┘
                                             │                                     ▼
                                             │          ┌────────────────────────────────┐
                                             └─────────▶│ Planner (N, lock per train)    │
                                                        │ DP · fallback · hysteresis     │
                                                        └───────┬───────────────┬────────┘
                                                                ▼               ▼
                                                   ┌──────────────────┐ ┌────────────────┐
                                                   │ PostgreSQL plans,│ │ Order worker → │
                                                   │ commitments,     │ │ DTL vendor API │
                                                   │ orders, prices   │ │ (key, lookup)  │
                                                   └────────┬─────────┘ └───────┬────────┘
                                                            ▼    tickets (webhook)
                                                   ┌──────────────────────────────────┐
                                                   │ API + SSE: fuel desk, crew, admin│
                                                   └──────────────────────────────────┘
```

> "I partition Kafka by locomotive id because the estimator is a per-unit state machine. If two consumers saw readings from the same unit, I'd need locks or I'd interleave the filter. With key partitioning one consumer owns a unit, its readings arrive in log order, and I scale by adding partitions. The planner works per train and reads latest state, so it doesn't care which partition each unit lives on. I keep latest state and history separate because they serve different reads. The board and the planner want O(1) 'where is it now', and audits want range scans over months."

---

## 💾 Data Model (~3 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| telemetry | (locomotive_id, seq) PK, recorded_at, milepost, notch, fuel_raw, fuel_smoothed, late | Natural key absorbs replays; production is a hypertable |
| fuel_options | id, location, kind (pad/dtl), price, fee, setup, pump rate, lead time, cancel fee, bays, active | Price history in an append-only table |
| fuel_plans | (train_id, version) unique, lifecycle, source, confidence, assumptions, status, trigger, reason, cost breakdown | Immutable; one current and at most one proposed per train |
| plan_stops | plan_id, seq, stop_key, option, eta, per-unit targets, gallons, dwell, queue | stop_key = train:location:option |
| plan_evaluations | train_id, trigger, decision, explanation, projection | Every run, including "kept" |
| stop_commitments | stop_key PK, slot window, expires_at, state | Only accepted stops; holds a bay |
| dtl_orders | stop_key unique, status, vendor_order_id, attempts, lease, next attempt | The key is the vendor idempotency key |
| fuel_tickets | source ticket id PK, per-unit gallons, status | Matched against telemetry fueling events |
| alerts | dedup_key (partial unique while open), type, severity | Redelivery can't duplicate an alert |

> "Plan versions are immutable on purpose. When a crew asks 'why did you tell me Clovis an hour ago?', I can show exactly what v4 said and the evaluation row that replaced it. The commitments table is the line between advice and promises. Nothing reserves capacity until a row exists there."

---

## 🔌 API Design (~2 min)

```
POST /api/v1/telemetry/batch                 device; 202 | 200 duplicate (batchId) | 422
GET  /api/v1/fleet                           board; crew sees only their train
GET  /api/v1/trains/:id                      plan in force, proposal, projection, versions, evaluations
POST /api/v1/trains/:id/plans/:v/accept      fuel desk or that train's crew; 409 SLOT_TAKEN
POST /api/v1/trains/:id/plans/:v/confirm     fuel desk confirms a post-acceptance change
POST /api/v1/trains/:id/plans/:v/reject      keep the accepted plan
GET  /api/v1/orders · POST /orders/:id/cancel
POST /api/v1/integrations/fuel-tickets       vendor/pad webhook, idempotent on ticket id
POST /api/v1/integrations/prices             price feed; active=false means station down
GET  /api/v1/events                          SSE invalidations, filtered per viewer
```

---

## 📡 Telemetry Pipeline (~4 min)

The gateway validates, drops in-batch repeats, sorts each unit's readings by sequence and appends them. Dedup happens at two layers:

- **Batch id (fast path).** A device that lost our 202 resends the same batch and gets "duplicate" without a second append. I set that marker only after the append succeeds. A half-failed append is then retried in full, not misreported.
- **Natural key `(locomotive, seq)` (the real guarantee).** Anything appended twice collides in history. The estimator ignores any sequence at or below its watermark.

The estimator, per unit:

1. **Predict** the level from the previous throttle notch. Each notch burns a known rate, from about 4 gal/hr at idle to 200 at notch 8 (illustrative).
2. **Remove the predictable tilt** on the current grade.
3. **Take the median** of the last five readings to kill spikes.
4. **Blend** like a Kalman filter, trusting the sensor less under acceleration and not at all once it's flagged faulty.

On the same pass it detects events:

- fueling: a rise while stationary;
- sensor fault: a sustained rise while moving;
- leak or theft: a drop beyond idle burn while stationary;
- leak: a unit burning far above its consist-mates.

It also computes **calibration** (actual over forecast burn across the last ~300 miles), and **station passages**, which trigger a re-plan.

> "The low-fuel and can't-reach-next-fuel alarms live here, not in the planner. If the planner is wedged or timing out, the processor still sees a unit cross reserve and pages the fuel desk. Safety shouldn't depend on the most complicated component."

---

## 🧮 The Planner (~5 min)

**What exactly do we minimize?** Interviewers push on this, so I write it down:

| Term | In the objective? | Why |
|------|-------------------|-----|
| Fuel purchases (price × gallons) | Yes | The obvious cost |
| DTL call-out fee, cancellation fees | Yes | $150-$275 per event, decides small stops |
| Delay: (setup + queue + pumping) × train-hour cost | Yes | A train-hour is worth hundreds of dollars; dwell is real money |
| Stop penalty | Yes | Braking, restart fuel, risk |
| Credit for fuel left at destination | Yes, at the destination price minus a discount | Otherwise every plan arrives empty and the next trip buys at the terminal |
| Every unit ≥ reserve at every station (inflated burn) | **Hard constraint** | Running dry is not a cost you can pay |
| Tank capacity, one option per stop, DTL lead time | **Hard constraints** | Physics and vendor rules |

**State.** I collapse the consist into one virtual tank called *headroom*: the train-gallons of forecast burn the consist can absorb before its first unit hits reserve. Each unit's share of the train's burn is its horsepower share × model efficiency × its own measured calibration. A level of headroom then maps to a target for every unit, so a leaking unit gets more fuel automatically.

**DP.** It runs over (station, headroom on a 25-gallon grid). At each station, either pass, or stop at one option and fill to level L. The stop cost is a fixed part plus a part linear in gallons, so the inner "best L" is a suffix minimum, and the whole DP is stations × levels × options, a few milliseconds per train.

**Greedy baseline.** The textbook gas-station answer: if a cheaper station is reachable on this tank, buy just enough to reach it; otherwise fill up. It is optimal when cost is purely per gallon. My tests assert the DP equals greedy on those cases and beats it once fees and dwell exist.

**Uncertain inputs still get a recommendation**, with a wider margin and an honest label:

- the base margin is 10% on burn;
- +3% per hour of data age (dark territory);
- up to +10% when burn has drifted from the model;
- +5% for a faulty sensor or suspected leak;
- capped at +20%.

The plan says "Medium confidence" and lists the assumptions.

---

## 🔁 Plan Lifecycle and Station Capacity (~3 min)

```
recommended ──accept──▶ accepted ──on site──▶ executing ──ticket──▶ fueled
     │                     │
     │ cheaper > bar       │ cheaper > bar + change cost ──▶ proposed ──confirm──▶ accepted (new)
     ▼                     │ unsafe / station down / truck refused ──▶ voided → new recommendation
 replaced                  ▼
                    reservation expires → re-plan
```

- **Recommendations reserve nothing.** Acceptance reserves a pad bay for `[eta, eta + dwell]`, serialized per pad with a row lock. First to accept wins; the second gets 409 and a re-plan that now sees the queue.
- **Planning is per train, against existing reservations.** Other trains' slots become an expected queue wait in the cost. Reservations follow the ETA and expire if the train doesn't show.

---

## 🔧 Deep Dives (~13 min)

### Deep dive 1: Greedy vs DP vs MILP, and stability vs optimality

**Decision.** I use a DP over (station, discretized headroom), with hysteresis on top and an acceptance bar.

**Why the DP works here.** The route is fixed for one plan, so the problem is a shortest path over a small graph: about 15 stations × 700 fuel levels × 1-2 options. Every cost we care about is either fixed per stop or linear in gallons. That's why the DP can price a $275 truck fee and 70 minutes of dwell next to a $0.40/gal spread, with a runtime I can promise: milliseconds, no solver.

**Why greedy fails.** Its optimality proof needs costs to be purely per gallon. Add a call-out fee and dwell, and "buy just enough to reach the cheaper station" becomes a liability on a gently falling price gradient: it stops at every station to buy a little. In my test route greedy makes three stops and the DP makes one, a difference of more than $500. Greedy also can't express "don't skip the truck we already ordered, it costs $150 to cancel".

**Why MILP is tempting and where it breaks.** A MILP handles everything, including assigning pad bays across trains. But tail latency is unbounded, so a price storm across 500 trains needs a time limit anyway, and then you're shipping incumbent solutions with unknown gaps. The plans are also hard to explain. "The solver said so" isn't something a fuel desk will accept at 3 a.m.

**Stability.** The optimum moves with every burn update. Re-plan from scratch each time and the crew hears Belen, then Clovis, then Belen. So I keep three bars:

1. A recommended plan is replaced only if it's unsafe or the saving beats max($150, 2%).
2. An accepted plan needs the threshold plus a $400 change cost, and even then it only becomes a *proposal* the fuel desk confirms.
3. The safety check of the plan in force uses a margin 5 points below the planning margin.

That third bar was a lesson from building it. DP plans buy just enough, so they sit exactly on the reserve boundary. Without slack, every small calibration update voided the plan that had just been created, and the system thrashed version after version.

**Timeout fallback.** The DP checks a 500 ms deadline. Past it, I return the greedy plan if it's feasible, labelled "Greedy fallback", or else the last good plan if it's still safe. A fallback never replaces a plan in force that's still safe.

**What I give up.** Some optimality: a plan can stay up to the threshold worse than the best. Some modelling: units are balanced into one headroom dimension, so I never deliberately run one unit empty while filling another. And no global optimization across trains at a congested pad. I accept all three for explainable, stable, fast plans.

### Deep dive 2: Telemetry at fleet scale: partitioning, disorder, noisy sensors

**Decision.** I partition Kafka by locomotive. The estimator is forward-only with a sequence watermark, and latest state is kept separate from history.

**Why it works.** The estimator is a per-unit state machine: level, variance, a median window, calibration sums. Key partitioning gives each unit exactly one owner, so there are no locks and the state is local. A crash replays from the last committed offset. Replays are harmless because history dedupes on `(locomotive, seq)` and the watermark skips anything already applied. I persist state before acknowledging the log, so "processed" and "acknowledged" can't disagree.

**Why the alternatives fail:**

- **Shared queue, any consumer takes any message.** Two workers would interleave one unit's readings, so I'd need a distributed lock per unit at 270/s, or I'd corrupt the filter.
- **Devices writing straight to the database.** Connection storms when 2,000 units leave a tunnel at once, no backpressure, and no replay to rebuild derived state after a bug fix.
- **Trusting the raw sensor.** Slosh on a 1% grade is about 250 gallons, comparable to an hour of burn. A moving average lags and still swallows spikes. The model-predicted filter follows the notch-implied trend and uses the sensor to correct drift.

**Out-of-order data.** A unit can resend, take two links, or flush hours of buffer after newer readings arrived. I store late readings for audit (`late = true`) but never rewind the filter. Production can add a two-minute event-time reorder buffer to catch small shuffles.

**What I give up.** Late readings never improve the live estimate. A unit whose readings straddle a gap gets a wider variance and a wider planning margin rather than a re-computed past. I take that simplicity over event-time re-processing of a stateful filter.

### Deep dive 3: DTL orders with unknown outcomes, and reconciliation

**Decision.** One order per accepted stop, keyed `train:location:option`. That key is the vendor's Idempotency-Key and a unique column. A timeout is the explicit state `unknown`, and the rule is to look up by key before trying again.

**Why it works.** The dangerous moment is after we sent the request and before we heard back. The vendor may have created the order. Retrying blindly against a vendor that isn't idempotent dispatches two trucks at $275 each. Treating silence as failure and re-planning elsewhere leaves a truck idling at a siding while the train fuels somewhere else.

With "ask first":

- the worker sees a timeout → `unknown`;
- the next pass looks up by key;
- found → `confirmed`, otherwise resubmit with the same key;
- out of attempts, or the train is under two hours away → `failed`, and the fuel desk gets "call the vendor" while the plan is recomputed without that option.

**Concurrency.** The worker claims orders with a lease (`SKIP LOCKED`) and talks to the vendor outside any transaction. It then writes the result fenced on the status it read. If the planner moved the order to `cancel_requested` meanwhile, the fenced write loses. The cancel path does its own lookup, because we may never have learned the vendor's order id.

**Reconciliation.** A ticket says what was billed per unit. The processor saw the level rise. I compare them on units that took enough fuel to register, with a tolerance of max(150 gal, 5%). A 15% short fill opens a dispute. For a unit whose sensor is flagged faulty, the ticket is ground truth. I publish a correction into that locomotive's partition, so it's applied in order with its readings and doesn't race the processor.

**What I give up.** An extra round trip on every uncertain outcome. And orders are placed only after acceptance and inside a 12-hour window, so acceptance has to happen before the vendor's 6-hour lead time. The crew prompt at 8 hours covers that.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a price cut, an acceptance, a vendor timeout

1. Admin sets Kingman DTL to $2.10. One transaction writes the price and a history row. Trains not yet past Kingman get a `price_change` trigger, coalesced per train.
2. The planner takes Q-KCKBAR's lock. Burn is running +19% (heavier than planned), so the margin widens to 19%, confidence is medium, and the assumptions are listed.
3. The DP picks Kingman. The plan was only *recommended*, so a $13,267 saving clears the bar. v7 is written with its evaluation row in one transaction.
4. The crew accepts on the tablet. A commitment row reserves the slot, and the next planner pass inserts the order `pending`.
5. The worker POSTs with `Idempotency-Key: T01:KIN:KIN-DTL`. The vendor creates DTL-1002 and hangs. After 2.5 s the order goes `unknown`.
6. The next pass looks up by key, finds DTL-1002 and marks it `confirmed`. The vendor holds exactly one order.
7. On site the commitment goes `executing`. The ticket webhook (retried by the vendor) marks it delivered and fueled.
8. Reconciliation finds 2,072 gallons short and opens a dispute.

### Failed trace: the station goes down after acceptance

1. A crew has accepted "fuel at Amarillo". A bay is reserved.
2. Amarillo's pumps fail and the pad is set inactive. Affected trains get `station_down`.
3. Re-pricing the plan in force finds its Amarillo stop unavailable. Hysteresis returns *unsafe*, which overrides acceptance.
4. A new *recommended* version replaces it. The Amarillo commitment is cancelled; stops that survive keep their reservations. Any truck for a dropped stop goes `cancel_requested` and is cancelled idempotently, with a lookup if we never got its id.
5. A critical "accepted plan voided" alert opens. The tablet shows "not yet accepted" until the crew acknowledges the replacement.
6. If the planner were down, the processor would still raise "may not reach the next open facility above reserve".

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | Telemetry: the log, when the append is durable. Plans, commitments, orders and tickets: PostgreSQL, on commit. Latest state and estimator state are derived and replayable |
| Client retries after losing the response? | Same batch id → duplicate; reading PK; ticket id PK; second accept → 409; our own vendor retry reuses the key after a lookup |
| Worker dies between steps? | Processor saves state before the ack and replays idempotently. Plan version and evaluation share a transaction. Order lease expires, and the fenced write plus lookup resolve it |
| Ordering actually required? | Per locomotive (partition), per train (lock + unique version), per pad at acceptance (row lock). Nothing global |
| Access through caches and async jobs? | Role and crew-train checks on every endpoint. SSE sends invalidations filtered per viewer, and data comes through checked endpoints |
| What breaks first? | Planner writes to PostgreSQL in price storms (2-5 rows per run × ~1,500 trains). Then partition count for full sensor ingestion |

---

## ❓ Follow-ups the Answer Must Handle

**What exactly do you minimize, and what's hard?** Total trip cost: purchases, fees, dwell and queue time, stop penalties and cancellations, minus the credit for fuel left at the destination. The reserve at every station, tank capacity, one option per stop and DTL lead time are hard constraints. I never put safety in the objective as a penalty, because any penalty has a price at which the optimizer would pay it.

**A cheaper option appears after the plan is accepted.** The planner computes it and prices both plans under the same inputs. If the saving beats the threshold plus the change cost, it writes a *proposal*. The accepted plan stays in force until the fuel desk confirms, which releases the old reservations and cancels the old truck. A smaller saving is logged as "kept, saves only $X".

**The optimizer times out.** I return greedy if it's feasible, labelled; otherwise the last good plan if it's still safe; otherwise the emergency path. A fallback never displaces a safe plan in force. Fallbacks above 1% page someone, because it means the budget is wrong.

**A station goes down after acceptance.** I re-plan with that stop removed. Safety overrides acceptance, the replacement needs acceptance, a critical alert opens, and the truck order is cancelled idempotently.

**Stale or uncertain inputs.** I still recommend, but widen the margin by data age and burn drift and label confidence with the assumptions. The UI shows "fuel data 2.1 h old".

**A high-throughput location ping receiver.** The same gateway: stateless, batch-oriented, mTLS per device, append to a log keyed by device, latest position in Redis, history in a TSDB. Clients buffer and retry with batch ids.

**Sensor ingestion for 3,000+ trains.** Aggregate at the edge (fuel channels every 30 s, engine channels as summaries), use more partitions and a columnar store with retention tiers. The fueling consumer reads only what it needs from a filtered topic.

---

## 🚨 Failure Handling (~1 min)

| Failure | Handling |
|---------|----------|
| Dark territory | Device buffers; estimator predicts across the gap; margin widens by data age |
| Duplicates, reordering | Batch id, PK, sequence watermark |
| Sensor bias | Flag, dead-reckon from notch, correct from tickets |
| Planner down | Alarms continue; plans in force remain; triggers queue and are reclaimed |
| Vendor timeout or refusal | Unknown → lookup; refusal → option excluded, re-plan, alert |
| Congested pad | Queue priced, bays enforced at acceptance, reservations expire |

---

## 📈 What Breaks First and How It Scales (~2 min)

The planner's CPU is trivial. What breaks first is the **write fan-out during price storms**. Every evaluation writes a row with a projection, and new versions write stops. Locally that's 2-5 rows per run; × 1,500 trains in a minute it becomes a PostgreSQL problem. The fix:

- skip writes when the decision is "keep";
- send evaluations to a log or warehouse;
- coalesce a price file into one trigger per train;
- shard planners by train id.

Telemetry scales with partitions, because the estimator is O(1) per reading. A single congested pad serializes acceptances on its row lock, which is fine at tens per hour and becomes a per-pad scheduler later.

---

## ⚖️ Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| ✅ DP over (station, headroom) | Prices fees and dwell; milliseconds; explainable | Balanced-consist approximation |
| ❌ Greedy | Simple, optimal for per-gallon cost | Stops everywhere once fees and dwell exist |
| ❌ MILP | Global, handles bays | Unbounded latency, opaque plans |
| ✅ Hysteresis + acceptance bar + safety slack | Stable instructions | Can stay a threshold above the optimum |
| ✅ Kafka keyed by locomotive | Per-unit order, no locks, replay | Hot partition if one unit floods |
| ❌ Shared queue | Simple | Interleaves a unit's readings |
| ✅ Unknown order state + lookup | No double trucks, no silent misses | Extra round trip |
| ❌ Retry blindly | Simple | Two trucks with a non-idempotent vendor |
| ✅ Reserve on acceptance | No phantom bookings | Orders wait for a human |
| ✅ Alarms in the processor | Planner-independent safety | Some logic duplicated with the planner |

---

## 📝 Wrap-up (~1 min)

> "Three layers with different failure modes. The pipeline makes noisy, late, duplicated data trustworthy per unit and raises safety alarms by itself. The planner minimizes total trip cost under a hard reserve constraint, with a bounded DP, labelled fallbacks, and hysteresis that respects what humans have accepted. The execution layer reserves only what's accepted and treats a vendor timeout as a question to ask, not a failure to retry. If I had more time I'd add joint bay assignment at congested pads and unit isolation, where a trailing unit is shut down to save fuel."

### How the local implementation compares

The repo runs this with Valkey streams as Kafka (four partitions keyed by locomotive), a PostgreSQL history table instead of a TSDB, and a simulator playing the onboard units, crews, pads, dispatch and price feed at 180× speed. It scripts a heavier-than-planned train, a leak, a sensor fault, a reroute, price changes, a station outage, and vendor timeouts, refusals and short fills. The DP, hysteresis, lifecycle, reservations, order state machine and reconciliation are implemented and unit-tested.
