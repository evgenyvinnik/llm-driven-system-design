# Railcar Trip Plans and ETAs — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · Requirements → Event model → Architecture → Backend flows → Frontend → Deep dives → Traces → Follow-ups*

> "Each loaded car rides a trip plan: an origin, a sequence of trains between yards, a destination. Readers beside the track, yard systems, dispatch and other railroads report where cars actually are, at least once, often late, sometimes not at all. I need to track every car against its plan, catch missed connections early, replan, predict ETAs, and show each shipper only its cars. I'll build it event-driven: one event store that is the source of truth and the outbox, consumers that fold events into read models and append their own decisions, and a portal that reads those read models and is honest about uncertainty and lag. The ETA trap is distance over speed; cars spend most of their trip waiting in yards, so I'll predict from yard dwell history and show a range."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Facts vs decisions; early warning; ranges; isolation |
| Event model and architecture | ~8 min | Event store as outbox; car and train topics; five consumers; portal on projections |
| Backend flows | ~8 min | Fold by event time, predicted misses, saga, dwell walk, digests |
| Frontend | ~5 min | Portal, plan versions, timeline with causation, ops boards |
| Deep dives | ~12 min | Missing and late events; orchestration vs choreography; fan-out and batching end to end |
| Traces and follow-ups | ~8 min | A six-hour delay; a crash; a cancelled train |

---

## 🎯 Requirements (~4 min)

### Functional

1. Ingest car facts (AEI reads, yard events, pulls, placements, bad orders, interchanges) and train facts (departed with consist, arrived, delayed, cancelled).
2. Plan each trip from the waybill; version every change with its reason.
3. Per-car state that tolerates missing, duplicate, late and out-of-order events.
4. Detect missed connections (predicted and actual); replan onto the next train with capacity; compensate if it's cancelled.
5. ETA as p10/p50/p90 from yard dwell history.
6. One digest per shipper per window; exceptions board, sagas view, event timeline, streams/DLQ page.
7. Shippers see only their cars (including after interchange); operations sees all.

### Non-functional

| Property | Target | What it forces |
|----------|--------|----------------|
| Durability | No accepted fact lost | Append before acking; idempotent ingest |
| Freshness | State < 5 s, ETA < 30 s | Streaming consumers; UI polls every 5 s |
| Early warning | Miss predicted < 1 min after the delay | Decide on TrainDelayed |
| Correctness | Order-independent; 72 h late data | Event-time folds |
| Exactly-once effects | One replan, exception, digest per cause | Idempotency in the effect's transaction |
| Isolation | No cross-shipper leaks | Shipper id on every read-model row, filtered from the session |

### Scale (assumptions, except the fleet figure)

BNSF's 10-K lists about 70,700 owned or leased freight cars; with foreign and private cars I assume ~200K loaded cars moving. That's ~2.4M car facts a day (~30/s, ~300/s peak), ~30K train facts, ~3M car updates from train fan-out, ~8M ETA recomputes. Modest volume; the difficulty is ordering, lateness and fan-out.

---

## 🧱 Event Model (~3 min)

| Kind | Examples | Key |
|------|----------|-----|
| Car facts | CarSighted (v1 and v2), CarArrivedYard, CarDepartedYard, CarPlaced, CarBadOrdered, CarInterchanged | car id |
| Train facts | TrainDeparted (consist), TrainArrived, TrainDelayed, TrainCancelled | train run |
| Plan aggregate | TripPlanCreated, TripPlanRevised | car id (stream per trip) |
| Decisions | ConnectionMissed, EtaUpdated, ExceptionOpened/Resolved, Replan* and TrainCapacity* saga events, ShipperNotified | car id / shipper id |
| Time | ClockTicked (from the event-time watermark) | clock |

> "Every event has an envelope: id, type and schema version, stream and stream version, event time and recorded time, correlation and causation ids. Facts are never rejected for being late; decisions are appended by the consumer that made them in the same transaction as its state change."

---

## 🏗️ High-Level Architecture (~5 min)

```
 Producers (AEI, yards, dispatch, interchange, waybills)
                │ at-least-once batches
                ▼
        ┌────────────────┐        ┌───────────────────────────────────────┐
        │ Ingest API     │──────▶ │ EVENT STORE (PostgreSQL)               │ source of truth + outbox
        └────────────────┘        │ events · event_cars · train_run_cars   │
                                  └──────────────┬────────────────────────┘
                                                 ▼ relay
                                  ┌───────────────────────────────────────┐
                                  │ Kafka (local: Valkey Streams)          │
                                  │ car topic (car id) · train topic (run) │
                                  └──┬───────┬────────┬────────┬────────┬─┘
                                     ▼       ▼        ▼        ▼        ▼
                               car-state    eta   exceptions notifier replanner
                                     └───── decisions appended back, same transaction ──┘
                                                 ▼
                                  Read models: car_state, car_eta, plans, exceptions, sagas, digests
                                                 ▼
                                  Portal API (shipper-scoped) ──▶ React portal + ops pages
```

| Component | Responsibility |
|-----------|----------------|
| Ingest | Validate type, version and schema per event; dedupe by event id and natural key; append; write log indexes |
| Relay | Publish unpublished rows to partition streams; mark published; duplicates on crash, never loss |
| car-state | Fold each affected car's timeline; emit ConnectionMissed |
| eta | Dwell-walk Monte Carlo; emit EtaUpdated on material change; emit ClockTicked |
| exceptions | Open/resolve exceptions as events; apply them to the board |
| replanner | Process manager: reserve, revise, await ETA, complete or compensate |
| notifier | Per-shipper batching windows; collapse; ShipperNotified |
| Portal API | Shipper-scoped reads; commands with expected versions; streams ops |

---

## 💾 Data Model (~2 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| events | position, event_id (unique), stream_id + stream_version (unique), dedupe_key (unique), occurred_at, recorded_at, causation_id, published_at | Append-only; outbox = unpublished rows |
| processed_events | (group, event_id) | Idempotency, in the effect's transaction |
| car_state | car_id, status, location, train run, observed/inferred, plan status, missed reads, shipper_id | Projection |
| trip_plan_versions, plan_legs_current | trip, version, legs, reason | Inline projection of the plan aggregate |
| car_eta, eta_history | p10/p50/p90, confidence, as-of, basis | Projection + audit |
| replan_sagas, run_reservations | saga state, chosen run; (run, trip) seats | Process manager, capacity |
| notification_items, digests | per-shipper items and sent digests | Notifier |

---

## 🔌 API (~2 min)

```
POST /api/v1/ingest/events            producers → accepted | duplicate | rejected per event
POST /api/v1/ingest/trips             waybill → TripPlanCreated
GET  /api/v1/cars, /cars/:id, /cars/:id/timeline, /events/:id/chain
GET  /api/v1/exceptions               POST /api/v1/exceptions/:id/resolve {version}
GET  /api/v1/replans, /notifications  POST /api/v1/trips/:id/revise {expectedVersion}
GET  /api/v1/streams/overview, /streams/dlq    POST /api/v1/streams/dlq/:group/:id/redrive
```

---

## ⚙️ Backend Flows (~8 min)

**Car state.** Load the car's timeline (events naming it, plus every event of trains it rode or is planned on), sort by event time, walk it. Car-level reads give an observed position; TrainDeparted/TrainArrived give an inferred one when no read confirms it. Count missed reads, late and out-of-order events.

**Missed connections.** On TrainDelayed: if the new arrival plus the yard's minimum connection is after the next leg's planned departure, emit a predicted ConnectionMissed. On TrainDeparted: planned cars not in the consist missed it. Dedupe per trip, plan version and leg.

**Replanning.** Saga per missed leg: reserve a seat on the next run between the same yards with room → TripPlanRevised with the expected version → wait for the EtaUpdated caused by that revision → ReplanCompleted. A cancelled chosen train releases the seat and starts a child saga.

**ETA.** For each of 200 seeded samples: at each remaining yard, sampled yard time from history, then the planned train if ready in time (else the next one between the same yards), then sampled run time (or the reported delay); then local delivery time. Report p10/p50/p90 plus yard share and miss probability.

| ETA approach | Pros | Cons |
|--------------|------|------|
| ✅ Dwell walk + schedule, as a distribution | Matches where time goes; explains itself; ranges | Needs dwell history; heavier |
| ❌ Distance / speed | Trivial | Ignores 60–80% of transit time spent in yards |

**Digests.** Items per shipper; flush after a quiet period or max window; one line per car; compare to what the shipper was last told.

### Consumer groups

| Group | Reads | Writes | Emits | Idempotency key |
|-------|-------|--------|-------|-----------------|
| car-state | car + train topics | car_state | ConnectionMissed | (group, event id); miss per trip/version/leg |
| eta | car + train topics, ClockTicked | car_eta, eta_history | EtaUpdated | history unique per (car, trigger) |
| exceptions | car topic | exceptions board | ExceptionOpened / Resolved | deterministic exception ids |
| notifier | car topic | items, digests | ShipperNotified | items unique per source event |
| replanner | car + train topics | sagas, seats, plans | saga events, TripPlanRevised | saga per trip/version/leg/attempt |

### Ordering, time and schema evolution

| Concern | Rule |
|---------|------|
| Ordered | Per key in append order: everything about a car; each train's movements |
| Not ordered | Across keys, including a car's facts vs its train's facts (safe because folds are order-independent) |
| Late data | No cutoff; the fold places it in event time |
| "Now" | The event-time watermark, published as ClockTicked so ETAs move for cars with no news and replays agree |
| Schema change | CarSighted v1 → v2 (reader confidence, orientation) with an upcaster that fills "unknown"; consumers upgrade first; unknown versions dead-letter |
| Replay | `replay <projection>` rebuilds into shadow tables from position 0, compares row by row, optionally swaps; decisions are not re-emitted |

### Failure handling

| Failure | Behaviour |
|---------|-----------|
| Consumer dies before commit | Rollback; the pending message is re-read on restart |
| Consumer dies after commit, before ack | Redelivery is a duplicate (marker exists) |
| Relay dies after publishing | Rows republished; consumers dedupe |
| Poison message (unknown car) | 4 deliveries → group DLQ with the error; partition keeps flowing; admin redrives after registering the car |
| No train with capacity | ReplanFailed → high-severity exception |
| Operator and replanner revise together | Expected version: one wins, the saga compensates, the operator gets 409 |

---

## 🖥️ Frontend (~5 min)

```
┌───────────┬────────────────────────────────────────────────────────────────────┐
│ My cars   │  HPSX104217  [in transit][observed]  [v3][replanned]               │
│ Notif.    │  ETA Fri 13:51  likely Fri 08:21 – Sat 03:31 · medium   +24 h      │
│           │  ├──────▓▓▓▓█▓▓▓▓▓────────┤  ▌original plan                         │
│           │  Remaining time in yards 64% · misses next connection 0%            │
│           │  Plan v3 train cancelled: Z-MIDPRT cancelled → M-MIDPRT             │
│           │  Plan v2 missed connection: inbound late into MID → Z-MIDPRT        │
└───────────┴────────────────────────────────────────────────────────────────────┘
```

| Screen | Highlights |
|--------|------------|
| Portal list | Status + observed/inferred badge, plan version badge, ETA range bar on a shared axis, drift vs original plan |
| Car detail | ETA panel with range and where the time goes; ETA history chart with plan-version markers; plan version cards with reasons |
| Timeline | Event time vs recorded time, late and out-of-order badges, v2 ← v1 upcast marker, causation chain panel |
| Ops | Exceptions board (resolve with version), replanning sagas with steps, digests, streams/DLQ with redrive |

| State | Where | Why |
|-------|-------|-----|
| Session and role | Zustand | Drives navigation and redirects |
| Domain clock | Zustand, refreshed from the server | Relative times use simulated time while the simulator runs |
| Server data | Per-route polling hook (5 s) | Projections converge on their own; polling always gets the converged answer |
| Tab, filters | URL search params, local state | Shareable links to a car's timeline |

### Access control end to end

| Layer | Enforcement |
|-------|-------------|
| Consumers | Copy the shipper id from the plan onto every projection row |
| API | Every shipper query filters by the session's shipper id; foreign cars return 404; ops pages return 403 |
| Timeline | Server redacts consists to a count and digest lines to the shipper's cars |
| UI | Role-filtered navigation only (never a security boundary) |

> "React with TanStack Router, Zustand only for the session and the server's domain clock (simulated time while the simulator runs), and polling hooks for server data. Commands return 202 with an event id; the board updates when the consumer applies the event, and a stale version gets 409."

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: Per-car state under missing and late events

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Projection folded by event time | Order-independent; late facts land in the past; replay-safe | Refold per update; snapshot at scale |
| ❌ Event-sourced car aggregate | Incremental, familiar | A late fact must be rejected (lost) or appended after newer state (wrong) |
| ❌ Row updated per event | Simplest | Last arrival wins: a day-late interchange record moves the car backwards |

> "Car movements are facts from producers I don't control. An aggregate exists to accept or reject commands, and there's no command here: nobody asks permission to read a tag. So the car is a projection: I fold every event about it in event-time order, and the same set of events always yields the same state, whatever order they arrived in. A 23-hour-late interchange record lands in the past and confirms history without moving the car. A missed AEI read is covered by the train: the consist on TrainDeparted and the TrainArrived event place the car, marked inferred, with a missed-read count and a lower ETA confidence, until a late yard report upgrades it."

> "The trip plan is the opposite: it's my decision, two writers race (replanner and operator), and every version must be kept, so it's an event-sourced aggregate with expected-version appends. I give up a refold per update (a millisecond for 20 to 60 events); at scale I'd snapshot per trip."

> "In the UI this shows up as the observed/inferred badge and as the timeline's two orders: by event time it reads as a clean story, by arrival it shows the late record with a 'late 23 h' badge exactly where we learned it."

### Deep dive 2: Replanning — orchestration over choreography

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Process manager (saga row, steps as transactions, compensation) | Order, timeouts, seat release in one place; progress visible | A coordinator to run and scale |
| ❌ Choreography across reservation, planner, ETA | No coordinator | Who releases seats when the train is cancelled? Logic smeared; a lost event strands a seat |

> "Replanning holds a resource: a seat on a train with finite capacity. If I choreograph it, reservation books on ConnectionMissed and the planner revises on SeatReserved; when the chosen train is cancelled, nobody owns the whole picture. With a saga row per replan, each step is a transaction that checks state, does its work, appends its event and moves on. A crash between steps is resumed by a sweeper. TrainCancelled compensates every saga that chose the run, releases the seats, and starts child sagas. In the simulation, 60 cars were moved onto a 60-seat priority train that was then cancelled: 60 compensations, 60 child sagas, plan v3 for each."

> "Everything else stays choreographed: ETA reacts to any plan revision, an operator's included; the notifier reacts to any ETA change. The saga waits for the ETA service's reply by causation id, but the ETA service doesn't know sagas exist. The ops UI has a sagas page because the orchestrator makes 'where is the replan for this car?' a single query."

### Deep dive 3: Fan-out, batching and exactly-once, end to end

> "A 100-car train six hours late is the stress case: one event, hundreds of effects, forty customers."

| Stage | What happens | Exactly-once mechanism |
|-------|--------------|------------------------|
| Ingest | One TrainDelayed appended | event id + natural key |
| car-state | 100 refolds; predicted misses for cars that can't connect | processed_events; ConnectionMissed dedupe per trip/version/leg |
| eta | 100 recomputes; EtaUpdated for material moves | processed_events; eta_history unique per car and trigger |
| replanner | One saga per missed leg | saga dedupe per trip/version/leg/attempt |
| notifier | Hundreds of items → windows per shipper | items unique per source event; flush under a row lock |
| UI | 40 digests; portal rows shift right with new plan badges | reads converged projections |

| Partitioning | Pros | Cons |
|--------------|------|------|
| ✅ Car topic by car id, train topic by run | Per-car order for state; per-train order for movements | Hot key: one train event = 100 units of work in one consumer |
| ❌ Everything by train | Train order | A car's events scatter across partitions as it changes trains |
| ❌ Everything by car | Parallel | Loses train order; 100× log volume |

> "Delivery is at least once everywhere: the relay can republish after a crash, consumers can die before acking. Each consumer handles a message in one transaction that inserts an idempotency marker, writes its read model and appends its decisions, then acks. I killed the ETA consumer in the middle of the 88-car fan-out: on restart it reprocessed the pending message once (88 history rows, 88 EtaUpdated, one marker). The hot key costs up to a second in one consumer, against a few milliseconds for a single car's fact; the production fix is a re-key stage that turns each train event into per-car events. Batching then turns 100 per-car changes into one digest per shipper: quiet period, max window, minimum interval, one line per car, ETA moves measured against what the shipper was last told."

---

## 📜 Execution Traces (~3 min)

### Successful trace

1. TrainDeparted with 88 cars; car-state marks them in transit; ETA recomputes.
2. TrainDelayed +6 h: car-state emits 88 predicted ConnectionMissed; the board shows 88 open exceptions.
3. Replanner: 88 sagas reserve seats (60 on the next priority train, 28 on the following manifest), write plan v2, wait for the ETA reply, complete; exceptions resolve.
4. Shippers' portals show v2 badges and shifted ranges; each of 6 shippers gets one digest.

### Failed trace: consumer crash

1. The ETA consumer dies inside the 88-car transaction; PostgreSQL rolls back; the message stays pending.
2. The restarted consumer reads its pending entries first and processes the delay once.

### Failed trace: cancelled train

1. TrainCancelled for the priority train the 60 sagas chose.
2. One transaction: 60 seats released, 60 sagas compensated, 60 child sagas started; plan v3 for each; shippers see "plan v2 → v3: train cancelled".

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; write success? | PostgreSQL event store; a fact when its append commits, a decision when its consumer's transaction commits |
| Retries after a lost response? | Event id / natural key → duplicate; commands carry versions → 409 |
| Failure between steps? | One transaction per message, ack after commit; saga steps resumable; compensation |
| Ordering required? | Per car by event time (computed); per train run by append order |
| Access with async jobs? | Shipper id on every projection row; session-scoped queries; server-side redaction |
| What breaks first? | ETA fan-out on train events, then event store volume, then the single relay |

---

## 🧩 Follow-ups I'd Expect

**100 cars, 40 customers, six hours late: what goes out?**
> "40 digests, one per customer, one line per car: new ETA range, movement since the last digest, plan change with its reason."

**An AEI reader misses a car: where is it?**
> "Where its train went, marked inferred, with the missed read counted and the ETA confidence lowered; a late read upgrades it."

**How accurate is the ETA and how is uncertainty shown?**
> "A p10–p90 band with the median and the original plan marked; calibration measured as the share of delivered cars inside the band 24 hours out, plus median error."

**A new CarSighted field from reader firmware?**
> "v2 schema plus an upcaster for v1 (unknown, not invented); consumers upgrade first; an unknown future version dead-letters until they do."

---

## 🧪 How I'd Prove It Works (~1 min)

| Claim | Test |
|-------|------|
| Duplicates change nothing | Post the same fact twice, then again with a new id: accepted, duplicate, duplicate; republish a stored event to its stream: each group counts a duplicate, no new rows |
| Late data doesn't move the car | Post a 44-hour-old line read for a car in transit: late and out-of-order counters move, position and ETA don't |
| Crashes don't double effects | SIGKILL the ETA consumer mid-fan-out: after restart, one marker and one row per car |
| Poison is contained | Unknown car → DLQ after 4 deliveries; redrive before the fix returns it to the DLQ; after registering the car, redrive succeeds |
| Projections are functions of the log | `replay -- all` rebuilds car-state, eta, plans and exceptions identical to live |

---

## 📈 What Breaks First (~2 min)

1. **ETA fan-out on train events.** One 88-car delay is 88 Monte Carlo recomputes in one consumer. Fix: a re-key stage that turns train events into per-car events, more car partitions, ticks only for cars whose p10 has passed.
2. **Event store volume.** EtaUpdated dominates; emit only material moves (done), partition by stream and month, tier old data.
3. **The relay.** One per shard, or CDC.
4. **Portal reads.** Timeline unions get expensive for long-lived cars: snapshot per trip, cache the list per shipper, virtualize long tables in the UI.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Car state | Projection by event time | Car aggregate | Facts can't be rejected |
| Plans | Event-sourced aggregate | Mutable row | Versions, reasons, racing writers |
| Log | Event store as outbox | Kafka-only | No dual write; queryable timelines |
| Effects | At-least-once + idempotency | Exactly-once transport | Exactly once where it matters |
| Replanning | Orchestrated saga | Choreography | Seats released; progress visible |
| ETA | Dwell walk, range | Distance/speed | Yards dominate |
| UI freshness | Polling projections | Socket deltas | Server already handles order and duplicates |
| Notifications | Per-shipper digests | Per-event messages | 100 changes → 1 message |

---

## 📝 Wrap-up (~1 min)

> "An event store as the source of truth and outbox; facts folded by event time; a versioned plan changed by one compensating saga; ETAs as ranges walked yard by yard, with time itself in the log; digests per shipper; and a UI that shows ranges, as-of times and causation instead of false precision."

### How the local implementation compares

Express + TypeScript services (API, relay, car-state, eta, exceptions, notifier, replanner), PostgreSQL for the event store and projections, Valkey Streams for the partitions, a closed-loop simulator (320 cars, 4 yards, 7 trains, 72 hours in ~2.4 minutes), and a React portal. `npm run replay -- all` rebuilds every projection identical to live.
