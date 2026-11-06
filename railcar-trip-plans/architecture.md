# Railcar Trip Plans and ETAs - Architecture

## System Overview

Every loaded railcar travels on a **trip plan**: an origin, an ordered list of legs (each a specific train run between two yards), and a destination customer. AEI tag readers beside the track, yard systems, the dispatching system and other railroads report where cars actually are. This system tracks every car against its plan, detects a missed connection early (often hours before the outbound train leaves), replans the car onto the next train with room, predicts its delivery as a range built from **yard dwell history** rather than distance over speed, and tells each shipper about its own cars in one digest instead of a hundred emails.

It is built as an **event-driven application**. Car movements are facts that many producers publish; decisions (a missed connection, a plan revision, an ETA change, an exception, a digest) are events too, appended by the consumer that made them in the same transaction as its own state change. Read models are projections of the log and can be rebuilt from position 0.

**Signal:** practice extension. Car visibility and trip plans are central to rail service, but this question is not known to have been asked in a BNSF loop (see `CLAUDE.md`).

**Learning goals**

- Model a domain as facts and decisions: past-tense events with versioned schemas, an envelope with event time, processing time, correlation and causation.
- Choose deliberately between an **event-sourced aggregate** (trip plans) and a **projection over facts** (car state), and say why.
- Make **at-least-once delivery produce exactly-once effects**: event store as outbox, idempotent consumers, ack after commit, DLQ with redrive, replay that reproduces the live state.
- Pick partition keys (car vs train) and live with the hot key a 100-car train creates.
- Orchestrate a multi-step process with compensation (the replanning saga) and leave the rest choreographed.
- Predict an ETA whose uncertainty is honest, and that a replay recomputes identically.

### Public context (cited) and assumptions

| Fact | Value | Source |
|------|-------|--------|
| Network | 32,500+ route miles in 28 states | BNSF FY2025 10-K |
| Fleet owned or leased | ~6,700 locomotives, ~70,700 freight cars | BNSF FY2025 10-K |
| Car ownership | Most cars on a Class I belong to lessors and shippers, so "visibility" means telling owners and shippers | ROADMAP rail section |

Everything else here (event rates, dwell distributions, digest windows, the network, names and reporting marks) is an **illustrative assumption**.

---

## Requirements

### Functional Requirements

1. Ingest car movement facts from many producers: AEI reads, yard arrivals, departures, pulls, placements and bad orders, interchanges with other railroads, and train departures, arrivals, delays and cancellations.
2. Create a trip plan per loaded car (from the waybill) and version it on every change, with the reason.
3. Keep a per-car state (where it is, how sure we are, which leg it is on, whether it is on plan) that tolerates missing, duplicated, late and out-of-order events.
4. Detect missed connections: predicted (the inbound train is too late to make the planned outbound) and actual (the outbound left without the car).
5. Replan automatically: next train with capacity, new plan version, new ETA, shipper told. Undo it if the chosen train is cancelled.
6. Predict delivery as p10/p50/p90 from historical yard dwell and the train schedule, recomputed when anything relevant happens.
7. Notify shippers with one deduplicated digest per batching window.
8. Operations: an exceptions board, the replanning sagas, a car event timeline with causation chains, a streams/DLQ page.
9. Access: a shipper sees only its own cars (including after interchange to another railroad); operations sees everything.

### Non-Functional Requirements (production)

| Property | Target | What it forces |
|----------|--------|----------------|
| Ingest durability | No accepted fact is lost; producers may resend forever | Append to the event store before acknowledging; idempotent by event id and natural key |
| Freshness | Fact to car state < 5 s p99; fact to ETA < 30 s p99 | Streaming consumers, not batch |
| Early warning | Missed connection detected within 1 min of the delay report | Predict from TrainDelayed, don't wait for the departure |
| Correctness under bad delivery | Same state whatever the arrival order; interchange feeds up to 72 h late | Event-time folds, order-tolerant handlers |
| Exactly-once effects | No duplicate replans, exceptions, digests | Idempotency marker in the effect's transaction |
| Shipper isolation | Zero cross-shipper leaks | Filter at the read model by the session's shipper id |
| Availability | 99.9% ingest, 99.5% portal | Ingest only depends on the event store |
| Rebuildability | Any read model rebuilt from the log in < 1 h | Projections are pure functions of the log |

---

## Capacity Estimation

### Production Scale (illustrative assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Loaded cars in motion at once | ~200,000 | Owned/leased fleet (~70,700, 10-K) plus foreign and private cars on the network |
| Car facts | ~2.4M/day, ~30/s average, ~300/s peak | ~8 AEI reads + ~4 yard events per car per day; bursty at train arrivals (a 100-car arrival is ~250 events in two minutes) |
| Train facts | ~30,000/day | ~5,000 train runs/day × ~6 events (departed, arrived, delay updates) |
| Fan-out from train events | ~3M car updates/day | Each train event concerns ~100 cars |
| ETA recomputes | ~8M/day, ~100/s | Car facts + train fan-out + clock ticks (every 2 h × 200K cars) |
| Decisions written | ~3M/day | Mostly EtaUpdated (only material moves ≥ 60 min) |
| Event store growth | ~5.5M events/day × ~600 B ≈ 3.3 GB/day ≈ 1.2 TB/year | Monthly partitions, cold tier after 13 months |
| Shipper accounts | ~10,000; digests ~50,000/day | One per shipper per window, at most hourly |

What this says: the volume is modest (a few hundred events per second); the hard parts are **ordering, lateness, fan-out and correctness**, not throughput. The ETA consumer is the heaviest (a train event becomes ~100 timeline reads and Monte Carlo runs of 200 samples each: ~5–10 ms per car including the database round trips, 0.5–1 s per train event in one consumer locally).

### Local Development Scale

| Quantity | Value |
|----------|-------|
| Network | 4 yards, 7 daily trains, 10 AEI sites, 1 interchange (Sandoval ↔ Lone Pine Southern) |
| Fleet | 320 loaded cars, 10 shippers, 7 traffic flows |
| Scenario | 72 simulated hours in ~2.4 minutes (1,800×): ~1,850 facts accepted, ~5,000 events in the log |
| Peak | ~110 events/s for a few seconds (a 90-car departure plus its decisions) |

---

## High-Level Architecture

```
┌─────────────────────┐  ┌──────────────┐  ┌────────────────┐  ┌───────────────────┐  ┌──────────────┐
│ AEI reader gateways │  │ Yard systems │  │ Dispatch (TMS) │  │ Interchange feeds │  │ Waybill feed │
│ (store & forward)   │  │              │  │ train movement │  │ other railroads   │  │ (trip intake)│
└──────────┬──────────┘  └──────┬───────┘  └───────┬────────┘  └─────────┬─────────┘  └──────┬───────┘
           └────────────────────┴─────────┬────────┴──────────────────────┴───────────────────┘
                                          ▼  mTLS, batches, at-least-once
                              ┌───────────────────────┐
                              │ Ingest service        │ validate (type, version, schema), dedupe,
                              │ (stateless, N pods)   │ append; never reject a fact for being late
                              └───────────┬───────────┘
                                          ▼
          ┌──────────────────────────────────────────────────────────────────┐
          │ EVENT STORE: PostgreSQL, hash-partitioned by stream (car id)       │  SOURCE OF TRUTH
          │ events (append-only, per-stream version, published_at = outbox)    │
          │ + log indexes: event_cars, train_run_cars, plan_run_index          │
          └───────────┬──────────────────────────────────────────────────────┘
                      ▼ outbox relay / CDC (Debezium)
          ┌──────────────────────────────────────────────────────────────────┐
          │ KAFKA: car-events (64 partitions, key = car id)                    │  INTEGRATION BACKBONE
          │        train-events (16, key = train run)  shipper-events (8)      │
          │        eta-current (compacted, key = car id)                       │
          └──┬─────────┬──────────┬────────────┬───────────┬─────────────────┘
             ▼         ▼          ▼            ▼           ▼
       ┌─────────┐ ┌───────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────────┐
       │car-state│ │  eta  │ │exceptions│ │ notifier │ │ replanner (process    │
       │projection│ │model  │ │  board   │ │ digests  │ │ manager / saga)       │
       └────┬────┘ └───┬───┘ └────┬─────┘ └────┬─────┘ └──────────┬────────────┘
            │ decisions appended to the event store in the consumer's own transaction
            ▼          ▼          ▼            ▼                   ▼
       ┌──────────────────────────────────────────┐        ┌────────────────────────┐
       │ Read models (PostgreSQL replicas, Redis) │        │ Notification gateway   │
       │ car_state, car_eta, exceptions, plans    │        │ email / EDI / webhooks │
       └───────────────────┬──────────────────────┘        └────────────────────────┘
                           ▼
              ┌──────────────────────────┐
              │ Portal API (shipper-     │──▶ Shipper portal · Ops exceptions board ·
              │ scoped reads, ops cmds)  │    Car timeline · Streams/DLQ ops
              └──────────────────────────┘
```

**Which log is the source of truth?** The PostgreSQL event store. Kafka is the integration backbone: it fans events out to consumer groups, holds a replay window (7 days), and buffers bursts. A projection that needs history older than Kafka's retention rebuilds from the event store. This keeps one durable, queryable, transactional log (consumers append decisions to it in the same transaction as their state changes) while still getting Kafka's partitioned fan-out.

---

## Core Components

### 1. Ingest

Producers post batches of facts: `{eventId, type, version, occurredAt, producer, payload}`. The ingest service:

1. Validates each event on its own: known external type, a schema version it knows, payload valid for *that* version, `occurredAt` not in the future. Malformed events are rejected individually; the rest of the batch goes in.
2. Appends each valid event under a per-stream advisory lock (`car-<id>` or `train-<run>`), assigning the next stream version.
3. Drops duplicates two ways: the same `event_id` (a store-and-forward gateway resending), or the same **natural key** under a new id (the interchange feed resending a batch with new message ids). `ON CONFLICT DO NOTHING` returns `duplicate`.
4. Writes the log indexes in the same transaction: `event_cars` (events that name a car), `train_run_cars` (consist membership from TrainDeparted), `plan_run_index` (every run any plan version names).

Facts are **never** rejected for being late, out of order or about an unknown car: they happened. Unknown cars are a consumer's problem (see DLQ).

### 2. Event store and the outbox relay

One append-only table holds every event, facts and decisions alike. `published_at IS NULL` marks the outbox. The relay (one active instance, an advisory lock elects it) loops: lock the oldest unpublished rows (`FOR UPDATE SKIP LOCKED`), `XADD` each to its topic partition (hash of the key), mark them published, commit. A crash after `XADD` and before commit republishes those rows; consumers drop the duplicates.

Because every state change in this system is either the append itself (facts, plan revisions) or happens in the same transaction as the append (consumer decisions), there is no state change without its event and no event without its state change.

### 3. Car state: a projection over facts

`car_state` is a pure fold over the car's **timeline**: every event that names the car, every event of every train run it rode, and every event of every run any version of its plan named. The fold sorts by **event time** (ties broken by type rank, then event id) and walks the events:

| Evidence | Effect |
|----------|--------|
| CarPulled, CarArrivedYard, yard-lead CarSighted | at yard, **observed** |
| CarDepartedYard, line CarSighted | in transit on a run, **observed** |
| TrainDeparted with the car in the consist | in transit, **inferred** (unless already observed on that run) |
| TrainArrived for a run the car rode | at yard, **inferred** |
| CarBadOrdered | bad-ordered; earliest departure = event time + repair estimate |
| CarInterchanged delivered / received | on the foreign road / at the interchange yard |
| CarPlaced | delivered |

After the walk it counts **missed reads** (a completed train move with no yard read at the destination, or no read at the line site in between), **late events** (recorded more than 60 minutes after they occurred) and **out-of-order events** (arrived after an event about the car that happened later).

The same set of events gives the same state whatever order it arrived in. That one property is what makes late interchange batches, duplicates, partition rebalances and replays safe.

### 4. Trip plans: an event-sourced aggregate

A plan is a decision, so it has a command side. Stream `plan-<tripId>` holds only TripPlanCreated and TripPlanRevised; the stream version is the plan version; a revision appends with `expectedVersion` = the version the writer read. The read model (`trip_plans`, `trip_plan_versions`, `plan_legs_current`) is an **inline projection**, written in the same transaction as the event so that the replanner and car-state never read a plan older than the one they just wrote.

The planner (on TripPlanCreated) picks, for each leg of the route, the first run departing after the car is ready (release + pull + the origin yard's minimum connection, then each arrival + that yard's minimum connection) that still has capacity, and books a seat in `run_reservations`.

### 5. Missed connections: detected by car-state

Two rules, appended as ConnectionMissed in car-state's own transaction:

- **Predicted** (`inbound_delay`): on TrainDelayed for run R, for every car riding R whose next leg leaves R's destination yard: if `newArrival + minConnection(yard) > plannedDeparture`, the connection is already lost. This fires hours before the outbound train departs.
- **Actual** (`departed_without_car`): on TrainDeparted for run R, every car whose current plan puts it on R but which is not in the consist.

The dedupe key `cm:<trip>:<planVersion>:<leg>` makes the early prediction and the later actual miss one event (and a redelivery a no-op).

### 6. The replanning process manager

An orchestrated saga, one row per instance in `replan_sagas`:

```
 ConnectionMissed / TrainCancelled
        │
        ▼
   started ──reserve seat on next run with capacity──▶ reserved ──revise plan (expected version)──▶ awaiting_eta
      │ none within 96 h                                  │ plan moved under us                        │ EtaUpdated whose causation
      ▼                                                   ▼                                            ▼ = our TripPlanRevised
   failed  (ReplanFailed → no_capacity exception)     compensated (seat released)                  completed (ReplanCompleted)
                                                                                                       │ chosen train cancelled
                                                                                                       ▼
                                                                      compensated (TrainCapacityReleased) + child saga, attempt n+1
```

Each step is one transaction: lock the saga row, check its state, do the step's local work (book a seat, append TripPlanRevised with the expected version), append the step's event, move the state. Steps run right after the triggering message commits, and a sweeper resumes any saga left between steps by a crash. The saga dedupe key is `(trip, plan version, leg, attempt)`.

On TrainCancelled, the replanner compensates every saga that chose the run (release the seat, ReplanCompensated) and starts a child saga for each; cars whose original plan used the run get a fresh saga.

### 7. ETA from dwell

The model walks the remaining plan yard by yard with 200 seeded Monte Carlo samples:

```
for each remaining leg (from yard Y):
    ready     = arrival + sample(yard time for Y and this block)   # conditioned on time already waited,
                                                                    # once the car's planned train has gone
    departure = planned run if ready before it leaves and it is not cancelled or gone,
                else the next run between the same yards (schedule)
    arrival   = departure + sample(run time)  (a reported delay replaces the sample)
delivery = arrival + sample(destination local time, or the foreign road's time after an interchange)
```

p10/p50/p90 come from the 200 delivery times. The seed is `hash(carId, planVersion)` (common random numbers): successive recomputes differ only because the inputs did, and a replay reproduces the ETA exactly. The basis records where the remaining time goes (`yardShare`, typically 60–80%) and how often the car misses its next connection across the samples. Confidence drops a level when the position is only inferred or the car is bad-ordered.

**Time as an event.** A car that sits in a yard with no news should see its ETA move. The eta process appends `ClockTicked` whenever the event-time watermark (newest field event time) crosses a 2-hour boundary; the ETA consumer recomputes every non-final car on it, conditioned on the tick. Because the tick is in the log, replay sees the same ticks and the projection stays a pure function of the log.

### 8. Exceptions

The exceptions consumer opens and resolves exceptions as events, with deterministic ids:

| Type | Opened by | Resolved by |
|------|-----------|-------------|
| missed_connection | ConnectionMissed | ReplanCompleted for the trip |
| train_cancelled | ReplanStarted with trigger train_cancelled | ReplanCompleted |
| no_capacity | ReplanFailed | an operator |
| bad_order | CarBadOrdered | sweep, once the car leaves (or an operator) |
| dwell_exceeded | event-time sweep: arrival + p90 ready time + one train cycle < watermark | sweep, once the car moves |

The board (`exceptions` table) is written only by applying ExceptionOpened/ExceptionResolved, including resolutions an operator makes through the API (appended with expected stream version 1, so two operators can't both resolve it).

### 9. Notifications: fan-out with batching

Each EtaUpdated (non-final), ReplanCompleted, bad-order ExceptionOpened and CarPlaced becomes a `notification_items` row (unique on source event id) and opens or extends its shipper's window. A tick flushes a window when it has been quiet for the quiet period (8 s locally, 15 min in production) or open for the maximum window (30 s / 2 h), never more often than once per minimum interval per shipper. The flush collapses items to one line per car (where it ended up, not every step), measures ETA moves against what the shipper was **last told** (suppressing moves < 2 h and wobbles that came back), writes the digest, and appends ShipperNotified in one transaction. Production adds shipper quiet hours and channel preferences; the delivery gateway is idempotent on digest id.

### 10. Access control

Every shipper query filters by the session's shipper id, which every projection row carries (denormalized from the plan). A car that is not the shipper's returns 404, not 403. In timelines, a shipper sees train movements with the consist reduced to a count and whether their car was aboard; causation chains are filtered to events about their cars. A shipper keeps seeing a car after it is interchanged to another railroad because access follows the trip (the waybill), not the railroad holding the car.

---

## Worked Examples

### Successful trace: a delayed train, an early replan, one digest per shipper

1. **04:00** TrainDeparted M-NGTMID-20261104 (88 cars, 6 shippers) from Northgate. Ingest appends to `train-M-NGTMID-20261104`, writes 88 `train_run_cars` rows. The relay publishes to `tp:train:1`.
2. car-state (train partition) folds 88 timelines: each car `in_transit`, inferred or observed. eta recomputes 88 ETAs.
3. **08:00** TrainDelayed: +6 h, new arrival 18:00. car-state: for each of the 88 cars the next leg is M-MIDPRT-20261104 at 20:00; 18:00 + 5 h minimum connection > 20:00 → 88 **ConnectionMissed (predicted)**, each with dedupe key `cm:<trip>:1:1`, all in one transaction with the projection updates.
4. eta, in parallel, recomputes the 88 ETAs with the delay (the planned connection is now missed in nearly every sample) and emits EtaUpdated for each material shift.
5. replanner: per ConnectionMissed, `startSaga` (ReplanStarted) then after commit `advance`: reserve a seat on the next MID→PRT run with room (Z-MIDPRT-20261105 07:00 has 60 seats; the rest go to the following M-MIDPRT), append TrainCapacityReserved, then TripPlanRevised v2 with expected version 1. The inline projection moves the car's legs.
6. eta sees TripPlanRevised and always replies with EtaUpdated (causation = the revision). The replanner matches it, appends ReplanCompleted. exceptions resolves the `missed_connection` it had opened.
7. notifier collects ~400 items (ETA changes, replans) for 6 shippers; after the quiet period it sends 6 digests, one per shipper, each with one line per car.

### Failed trace 1: the ETA consumer dies mid-fan-out

1. The ETA consumer has read TrainDelayed from `tp:train:1` (delivered, pending in its PEL) and is inside the transaction recomputing 88 ETAs. It is killed with SIGKILL.
2. PostgreSQL rolls the transaction back: no `car_eta` rows, no `eta_history` rows, no EtaUpdated, no `processed_events` marker. Valkey still lists the message as pending for `eta-1`.
3. The restarted process has the same consumer name, re-acquires its partition leases immediately, and first reads its own pending entries (id `0`). It processes TrainDelayed from scratch: 88 history rows, 88 EtaUpdated, one marker, then XACK. (Verified: 88 rows, 88 distinct cars, 1 marker.)
4. Had it died *after* commit and *before* XACK, the redelivery would hit the `processed_events` primary key and be acknowledged as a duplicate with no effects.

### Failed trace 2: the chosen train is cancelled (compensation)

1. 60 sagas chose Z-MIDPRT-20261105 and completed (plans at v2). At 02:00 dispatch posts TrainCancelled.
2. The replanner, in one transaction: for each of the 60 sagas, delete its seat on the run, append TrainCapacityReleased and ReplanCompensated, move it to `compensated`; then start 60 child sagas (attempt 2, parent linked, trigger `train_cancelled`) from plan v2.
3. After commit each child reserves the next MID→PRT run with room (the 20:00 manifest until it fills, then the next day's priority train) and revises to v3. exceptions opened `train_cancelled` for each car (from ReplanStarted) and resolves it on ReplanCompleted. Shippers see "plan v2 → v3: Z-MIDPRT-20261105 was cancelled" in their next digest.

---

## Database Schema

The full schema is `backend/src/db/init.sql`. The core:

```sql
-- The event store: source of truth and outbox
CREATE TABLE events (
  position        BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  version         INT NOT NULL,                 -- as produced; never rewritten
  stream_id       TEXT NOT NULL,                -- car-<id>, train-<run>, plan-<trip>, ...
  stream_version  INT NOT NULL,
  topic           TEXT NOT NULL CHECK (topic IN ('car', 'train', 'shipper')),
  partition_key   TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,         -- event time
  recorded_at     TIMESTAMPTZ NOT NULL,         -- processing time
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id  UUID NOT NULL,
  causation_id    UUID,
  producer        TEXT NOT NULL,
  dedupe_key      TEXT UNIQUE,                  -- natural key / decision idempotency key
  payload         JSONB NOT NULL,
  published_at    TIMESTAMPTZ,                  -- NULL = still in the outbox
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX events_unpublished_idx ON events (position) WHERE published_at IS NULL;

-- Log indexes written in the append transaction
CREATE TABLE event_cars     (position BIGINT REFERENCES events, car_id TEXT, PRIMARY KEY (car_id, position));
CREATE TABLE train_run_cars (run_id TEXT, car_id TEXT, PRIMARY KEY (run_id, car_id));
CREATE TABLE plan_run_index (trip_id TEXT, car_id TEXT, run_id TEXT, PRIMARY KEY (trip_id, run_id));

-- Idempotency: one row per (consumer group, event), inserted in the effect's transaction
CREATE TABLE processed_events (consumer TEXT, event_id UUID, processed_at TIMESTAMPTZ DEFAULT now(),
                               PRIMARY KEY (consumer, event_id));

-- Projections (each rebuildable by npm run replay)
CREATE TABLE car_state (car_id TEXT PRIMARY KEY, trip_id TEXT, shipper_id TEXT, plan_version INT,
  status TEXT NOT NULL, location_id TEXT, train_run_id TEXT, position_confidence TEXT NOT NULL,
  last_observed_at TIMESTAMPTZ, last_event_at TIMESTAMPTZ, arrived_at TIMESTAMPTZ, current_leg INT,
  plan_status TEXT NOT NULL, missed_reads INT, late_events INT, out_of_order_events INT, ...);
CREATE TABLE car_eta (car_id TEXT PRIMARY KEY, trip_id TEXT, plan_version INT, p10 TIMESTAMPTZ,
  p50 TIMESTAMPTZ, p90 TIMESTAMPTZ, confidence TEXT, as_of TIMESTAMPTZ, final BOOLEAN, basis JSONB);
CREATE TABLE trip_plans (trip_id TEXT PRIMARY KEY, car_id TEXT, shipper_id TEXT, current_version INT,
  legs JSONB, ...);                                             -- inline projection of plan-<trip>
CREATE TABLE trip_plan_versions (trip_id TEXT, version INT, legs JSONB, reason_code TEXT,
  reason_text TEXT, revised_by TEXT, event_id UUID, occurred_at TIMESTAMPTZ, PRIMARY KEY (trip_id, version));
CREATE TABLE plan_legs_current (trip_id TEXT, leg_seq INT, car_id TEXT, run_id TEXT, ...,
  PRIMARY KEY (trip_id, leg_seq));                              -- "who is planned on run R?"
CREATE TABLE exceptions (exception_id TEXT PRIMARY KEY, car_id TEXT, shipper_id TEXT, type TEXT,
  severity TEXT, status TEXT, summary TEXT, opened_at TIMESTAMPTZ, version INT, ...);

-- Process manager state
CREATE TABLE replan_sagas (saga_id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE,  -- trip:version:leg#attempt
  trip_id TEXT, car_id TEXT, trigger_type TEXT, state TEXT, attempt INT, parent_saga_id TEXT,
  from_plan_version INT, to_plan_version INT, missed_run_id TEXT, chosen_run_id TEXT,
  revision_event_id UUID, eta_before JSONB, eta_after JSONB, steps JSONB, ...);

-- Capacity and notifier state
CREATE TABLE run_reservations (run_id TEXT, trip_id TEXT, reserved_by TEXT, PRIMARY KEY (run_id, trip_id));
CREATE TABLE notification_items (id BIGSERIAL PRIMARY KEY, shipper_id TEXT, car_id TEXT, kind TEXT,
  source_event_id UUID UNIQUE, payload JSONB, digest_id TEXT);
CREATE TABLE shipper_digest_state (shipper_id TEXT PRIMARY KEY, window_opened_at TIMESTAMPTZ,
  last_item_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ);
CREATE TABLE car_last_notified (car_id TEXT PRIMARY KEY, p50 TIMESTAMPTZ, plan_version INT);
```

Reference data: `yards` (minimum connection), `trains` (schedule, run-time p50/p90, capacity), `train_runs` (materialized per service date), `aei_sites` (firmware version), `dwell_stats` (p10/p50/p90 per yard and block), `cars`, `shippers`, `users`.

---

## API Design

```
POST /api/v1/ingest/events              X-Ingest-Token; batch of facts → per-event accepted | duplicate | rejected
POST /api/v1/ingest/trips               Waybill: plan the trip, append TripPlanCreated (idempotent on tripId)

GET  /api/v1/cars?status=&planStatus=&q=&shipper=    Car list (shipper-scoped) with state, plan, ETA range
GET  /api/v1/cars/:carId                Car detail: state, plan versions, ETA + history, exceptions, sagas
GET  /api/v1/cars/:carId/timeline       Every event about the car: event time vs recorded, lateness, upcasts
GET  /api/v1/events/:eventId/chain      Causation chain: ancestors and descendants

GET  /api/v1/exceptions?status=&type=   Exceptions board
POST /api/v1/exceptions/:id/resolve     {version, note} → ExceptionResolved (409 if changed)
GET  /api/v1/replans?state=             Saga instances with their steps
GET  /api/v1/trips/:tripId              Plan aggregate (all versions)
POST /api/v1/trips/:tripId/revise       {expectedVersion, legSeq, runId, note} → TripPlanRevised (409 on conflict)
GET  /api/v1/trains/runs                Runs with capacity, consist size, delay, cancellation
GET  /api/v1/trains/runs/:runId/planned Cars whose current plan uses the run (yards build trains from it)
GET  /api/v1/notifications              Digests (shipper-scoped)

GET  /api/v1/streams/overview           Lag, pending, staleness, DLQ depth per group; outbox; events/s; replays
GET  /api/v1/streams/dlq                Dead letters with the last error
POST /api/v1/streams/dlq/:group/:id/redrive    (admin) → group's retry stream
POST /api/v1/streams/cars               (admin) register a car (the waybill arrived)
GET  /api/v1/streams/eta-calibration    Share of delivered cars inside their 80% band 24 h out
```

---

## Key Design Decisions

### 1. Car state is a projection; trip plans are event-sourced

**Decision.** The car has no aggregate; its state is a fold over facts. The trip plan is an event-sourced aggregate with optimistic concurrency.

**Why it works.** An aggregate exists to protect invariants by accepting or rejecting commands. Nobody commands a car to be sighted: an AEI read is a fact from a reader we don't control, and a fact that arrives 23 hours late from another railroad still happened. If the car were an aggregate with `expectedVersion`, a late interchange record would either be rejected (losing a fact) or appended "after" newer state (corrupting order). A fold sorted by event time absorbs both. The trip plan is the opposite: it is our decision, two writers (the replanner and an operator) can race, and we must not lose either's intent silently. Expected-version appends make the second writer reload and decide again.

**What we give up.** Recomputing the car from its whole timeline on every event costs a query and a fold (~20–60 events per trip, ~1 ms). At production scale we would snapshot per trip and fold only the tail, or keep the fold incremental for in-order events and refold only on a late one.

### 2. The event store is the outbox (and the source of truth)

**Decision.** One PostgreSQL table holds every event; `published_at` marks what the relay has not yet sent. Consumers append their decisions to the same table in the same transaction as their state change and their idempotency marker.

**Why it works.** The dual-write problem disappears: there is exactly one write per state change. A consumer that crashes before commit leaves no state, no decision and no marker; one that crashes after commit leaves all three, and the redelivery is a no-op. The log is queryable (car timelines, causation chains, natural-key dedupe) in ways a broker isn't.

**How the alternative breaks.** Writing state to a table and then publishing to Kafka loses events when the process dies between the two, and publishing first creates events for state that never committed. Making Kafka the only log (with consumers' state elsewhere) needs exactly-once transactions across Kafka and PostgreSQL, which do not exist; you end up rebuilding an outbox anyway.

**What we give up.** The relay adds latency (a poll or a NOTIFY wake-up, ~100 ms locally) and is a single active process per shard; Kafka retention is not the system's history, so long replays read PostgreSQL.

### 3. Partition by car; key trains by run and fan out in the consumer

**Decision.** Car facts, plan events and every decision about a car go to the `car` topic keyed by car id. Train facts go to the `train` topic keyed by train run.

**Why it works.** Everything about one car lands in one partition in order, and one consumer instance owns it (a lease per partition, like a Kafka assignment), so two instances never interleave a car's updates. Train facts keyed by run keep a train's own sequence (departed, delayed, arrived) in order.

**The hot key.** A 100-car TrainDeparted is one message on one train partition, and it becomes 100 car refolds and 100 ETA recomputes inside one consumer invocation (0.5–1 s locally, against 2–10 ms for a single car's fact). Keying train events by car instead (publishing 100 copies) would spread the work but loses the train's own ordering and multiplies the log. The production path is a **re-key stage**: a small consumer that turns each TrainDeparted into per-car derived events on the car topic, so the expensive per-car work runs in parallel across car partitions while the train topic keeps train order. Locally we fan out in-consumer and accept the latency spike.

**Ordering between the two topics is not guaranteed** (a car's CarDepartedYard and its train's TrainDeparted travel on different partitions). That is fine only because the fold is order-independent; this decision and decision 1 depend on each other.

### 4. Orchestrate replanning; choreograph everything else

**Decision.** A process manager owns the replan (reserve → revise → await ETA → complete, with compensation). ETA, exceptions and notifications react to events and don't know the replanner exists.

**Why orchestration for the replan.** The process has an order, a resource that must be given back (the seat on a train with finite capacity), a wait on another service's reply, a timeout, and a constant operator question: "where is the replan for this car, and why?" One row per saga answers it, and the compensation logic lives in one place. In a choreographed version, the reservation service would book a seat on ConnectionMissed, the planner would revise on SeatReserved, and when the train is cancelled *someone* has to know which seats belong to which half-finished replans; that knowledge ends up smeared across three services, and a lost event leaves a seat booked forever with no owner.

**Why choreography for the rest.** ETA must recompute on *any* plan revision (an operator's included) and on any train event; notifications must react to any ETA change. Routing those through the orchestrator would couple it to every consumer and make it a bottleneck.

**What we give up.** The orchestrator is a component to run, monitor and scale (sharded by trip id in production), and its steps are coupled to the planner's data model.

### 5. ETA from dwell, and honest uncertainty

**Decision.** Walk the plan yard by yard: sampled yard time, then the next train that carries the block, then sampled run time. Report p10/p50/p90 and where the time goes.

**Why it works.** Most of a car's transit is standing in yards: in our model 60–80% of the remaining time. A car 300 miles from its destination at 40 mph is not 7.5 hours away; it is "wait for classification, then for tonight's 20:00 train, then 10 hours on the train, then a day for local delivery". Distance over speed is precise and wrong. The yard walk also explains itself: "misses its next connection in 56% of samples" is something an operator can act on.

**What we give up.** It needs historical dwell per yard and block (seeded here; in production a nightly job over the event store), it is heavier (200 samples × legs per recompute), and quantiles are only as calibrated as the history. We measure it: the share of delivered cars that arrived inside their 80% band 24 h earlier.

### 6. Time as an event

**Decision.** ClockTicked events, emitted from the event-time watermark, trigger ETA recomputes for cars with no news.

**Why.** Without it an ETA is frozen at the last event and drifts into the past for a car sitting in a yard. Recomputing on a wall-clock timer would fix that but make the ETA depend on when the consumer ran, and a replay would produce different numbers. A tick in the log is a fact about time that every consumer and every replay sees the same way.

---

## Event-Driven Design Notes

### Kafka mapping

| Concept | Kafka (production) | Here (local) |
|---------|--------------------|--------------|
| Topic | `car-events` (64 partitions), `train-events` (16), `shipper-events` (8) | `tp:car:0..3`, `tp:train:0..1`, `tp:shipper:0` (one Valkey stream per partition) |
| Partitioner | murmur2(key) | FNV-1a(key) mod N |
| Consumer group | group.id per service | `XGROUP` with the same name on every partition stream |
| Partition assignment | group coordinator rebalance | a lease per (group, partition) in Valkey, renewed every 3 s, 10 s expiry |
| Offset commit | commit after the DB transaction | `XACK` after the DB transaction |
| Redelivery of stuck work | rebalance; re-read from committed offset | `XAUTOCLAIM` of entries idle > 3 s |
| Retry / DLQ topics | `<topic>.<group>.retry`, `.dlq` | `tp:retry:<group>`, `tp:dlq:<group>` |
| Compaction | `eta-current` compacted by car id for the portal cache | not built (portal reads `car_eta`) |
| Retention | 7 days; history from the event store | `MAXLEN ~ 500000` per partition |
| Outbox → topic | Debezium CDC on `events` or a relay | relay process, `FOR UPDATE SKIP LOCKED` |

### Idempotency and exactly-once effects

| Consumer | Idempotency | What a redelivery does |
|----------|-------------|------------------------|
| every group | `processed_events (group, event_id)` inserted in the effect's transaction | conflict → skip handler, XACK, count as duplicate |
| car-state | ConnectionMissed dedupe key per (trip, version, leg) | no second miss |
| eta | `eta_history UNIQUE (car, trigger)`, EtaUpdated dedupe per (car, trigger) | no second row or event |
| exceptions | deterministic exception ids, `exo:`/`exr:` dedupe keys | no second open or resolve |
| replanner | saga dedupe key (trip, version, leg, attempt); steps check state | no second saga or step |
| notifier | `notification_items.source_event_id UNIQUE`; digest flush under a row lock | no second item or digest |
| ingest | `event_id UNIQUE`, natural `dedupe_key UNIQUE` | `duplicate` |

### Schema evolution

CarSighted v1 (old reader firmware) and v2 (adds `readerConfidence`, `orientation`) coexist in the log. Rules: additive optional fields with defaults are allowed within a version; anything else is a new version plus an upcaster; consumers deploy the upcaster before producers emit the new version; an upcaster never invents data (unknown becomes null/UNKNOWN). Consumers see only the latest version; the timeline shows "v2 ← v1" for upcast events. An unknown version fails upcasting, is retried and dead-lettered, and is redriven once the consumer is upgraded.

### Ordering and time

- Guaranteed: per key, in append order. Not guaranteed: across keys or topics.
- Every handler is order-tolerant: car state and ETA fold by event time; decisions dedupe by business key.
- Late data: no cutoff for state (a 72-hour-late interchange record still corrects the fold). Lateness only affects decisions already made, which are never retracted silently: a missed connection detected on a later-corrected position stays in the log, and the next plan version is the correction.
- Event time drives sweeps (dwell exceeded) and ticks (ETA), via the watermark; processing time drives only batching windows (inbox flooding happens in real time).

### Replay

`npm run replay -- <car-state|eta|plans|exceptions|all> [--apply]` rebuilds into shadow tables from position 0 up to the current max position, compares row by row (md5 over the compared columns, plus the first differing keys), records the result in `replay_runs` (shown on the streams page) and with `--apply` swaps the rows in under an exclusive lock. Rebuilds have no side effects: car-state does not re-emit ConnectionMissed, eta does not re-emit EtaUpdated. Verified identical after a full run that included a SIGKILL of the ETA consumer mid-fan-out.

---

## Consistency and Idempotency

- **Write success:** a fact is accepted when its append commits; the producer may resend until it gets an answer. A plan revision succeeds when TripPlanRevised commits with the expected version.
- **Retries after a lost response:** same event id → `duplicate`; same natural key under a new id → `duplicate`; trip creation is idempotent on trip id; manual revisions and exception resolutions carry an expected version.
- **Between steps:** consumer effects are one transaction (state + decision events + marker); saga steps are one transaction each and resumable; the relay's crash window produces duplicates, never losses.
- **Read-your-writes:** the plan projection is inline (strong); car state and ETA are eventually consistent (seconds), shown with an "as of" time.

## Security / Auth

- Session auth (httpOnly cookie, session in Valkey) with three roles: shipper, ops, admin. Admin adds DLQ redrive and car registration.
- Producers authenticate with a token (`X-Ingest-Token`); production uses per-producer mTLS and a producer allowlist per event type (only dispatch may send TrainCancelled).
- Shipper scoping is enforced in SQL from the session; shipper ids in requests are ignored for shipper sessions; foreign cars return 404.
- Timeline redaction: consists reduced to a count, digest lines filtered to the shipper's own cars.

## Observability

| Signal | Where |
|--------|-------|
| Consumer lag per group and partition | `tp_consumer_lag` (XINFO GROUPS), streams page |
| Pending (delivered, not acked) | `tp_consumer_pending` |
| Projection staleness | `tp_projection_staleness_seconds`: age of the oldest unfinished message in any partition of the group |
| DLQ depth | `tp_dlq_depth` |
| Events/s, outbox backlog | `tp_events_appended_total`, `tp_events_published_total`, `tp_outbox_backlog`, sparkline on the streams page |
| Producer lateness | `tp_ingest_lag_minutes{producer_kind}` |
| Handler outcomes and latency | `tp_consumer_messages_total{group,outcome}`, `tp_consumer_handler_seconds` |
| Saga transitions, digests | `tp_replan_saga_transitions_total{to}`, `tp_digests_sent_total` |
| ETA calibration | streams page: share of delivered cars inside the 80% band 24 h out, median error |

Structured JSON logs (pino) carry group, consumer, stream, message id, event type and key on every failure.

## Failure Handling

| Failure | Behaviour |
|---------|-----------|
| Consumer crash mid-transaction | Rollback; message stays pending; restarted instance re-reads its pending entries first |
| Consumer crash after commit, before ack | Redelivery hits `processed_events` → duplicate |
| Poison message (unknown car, unknown schema version) | Retried until 4 deliveries (`XAUTOCLAIM`), then copied to `tp:dlq:<group>` with the last error and acked; the partition keeps flowing; admin redrives to the group's retry stream after the fix |
| Train event naming an unknown car | Skips that car (a train must not be held hostage by one car); the car's own fact is what dead-letters |
| Relay crash | Republishes unmarked rows on restart (duplicates, no loss); one relay at a time via advisory lock |
| Replanner crash between steps | Sweeper resumes `started`/`reserved` sagas after 10 s; `awaiting_eta` completes without the ETA after 30 s |
| No train with capacity | ReplanFailed → `no_capacity` exception for a human |
| Concurrent plan revision | Expected-version conflict → the saga compensates (releases its seat); an operator gets 409 |
| Valkey down | Ingest still accepts (PostgreSQL only); the outbox grows; consumers catch up when it returns |
| PostgreSQL down | Ingest returns 5xx; producers store and forward |

## Scalability Considerations

What breaks first, in order, with the evidence:

1. **The ETA consumer on train fan-out.** Locally one 88-car train event costs 0.5–1 s in one consumer (the slowest handler calls in the ETA histogram, against a median of a few milliseconds); at 5,000 trains a day with several events each it is the largest CPU consumer. Fix: the re-key stage (decision 3), more car partitions, and recomputing on ticks only for cars whose p10 has passed.
2. **Event store write and index volume.** EtaUpdated dominates decisions. Fix: emit only material changes (done), hash-partition `events` by stream, monthly time partitions, cold tier.
3. **The relay.** One active relay per database. Fix: one relay per shard, or Debezium CDC.
4. **Timeline queries** (union over event_cars and train streams). Fix: snapshot per trip; precomputed timeline projection for the portal.
5. **Notifier windows** are per shipper; the busiest shippers have thousands of cars. Fix: partition the flush by shipper hash; cap lines per digest with a link to the portal.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Car state | Projection folded by event time | Event-sourced car aggregate | Facts can't be rejected; late data must reorder, not conflict |
| Trip plan | Event-sourced aggregate, expected version | Mutable row | Two writers race; every version and reason is a requirement |
| Source of truth | PostgreSQL event store (also the outbox) | Kafka as the only log | One transactional, queryable log; no dual write |
| Publishing | Outbox relay | Publish from the handler | No lost or phantom events |
| Delivery | At-least-once + idempotent consumers | Exactly-once transport | Effects are exactly-once where it matters, in the DB |
| Partition key | Car id (car topic), train run (train topic) | Everything by car, or by train | Per-car order for state, per-train order for movements; hot key accepted |
| Replanning | Orchestrated saga with compensation | Choreography | Seats must be released; one place to see progress |
| ETA | Monte Carlo over yard dwell + schedule | Distance / speed | Yards dominate transit time; uncertainty shown |
| Time | ClockTicked from the watermark | Wall-clock timer | Replays reproduce ETAs |
| Notifications | Per-shipper windows, collapse per car | One message per event | 100 cars × 2 updates → 1 digest per shipper |
| Poison messages | Bounded retries, DLQ, redrive to a group retry stream | Block the partition | Handlers are order-tolerant; one bad car doesn't stall 25% of the fleet |
| Access | Shipper id on every read-model row, filtered from the session | Filter in the UI | Enforced where the data is |

---

## Design Review Checklist

1. **Source of truth and write success.** The PostgreSQL event store. A fact is written when its append commits (ingest returns `accepted` with its position); a plan revision when TripPlanRevised commits with the expected version; a consumer decision when the consumer's transaction (state + events + marker) commits.
2. **Client retries after losing the response.** Facts carry an event id and a natural key, so a resend returns `duplicate`. Trip creation is idempotent on trip id. Commands carry expected versions (409 on change). Stream redeliveries hit `processed_events`.
3. **Failure between two important steps.** Ingest is one transaction (event + indexes). Consumers are one transaction per message, acked after commit. The relay's window yields duplicates. Saga steps are separate transactions that check state first; a sweeper resumes stuck sagas; compensation releases seats when a later step fails.
4. **Ordering actually required.** Per car, by event time, and that is computed, not trusted: folds sort by event time. Per train run, in append order (departed before delayed before arrived) on the train partition. Nothing across keys. Plan versions are ordered by the aggregate's stream version.
5. **Access with caches, indexes and async jobs.** Every projection row carries the shipper id, written by the consumer from the plan; shipper reads filter by the session's id; digests are built per shipper; timelines redact consists. Late interchange data stays visible to the shipper because access follows the trip, not the railroad.
6. **What breaks first at scale.** The ETA consumer's train fan-out (measured: one 88-car delay = 88 Monte Carlo recomputes, 0.5–1 s in one consumer, the slowest handler calls in `tp_consumer_handler_seconds`), then event store volume (EtaUpdated is the largest stream), then the single relay. Fixes in Scalability Considerations.

---

## Implementation Notes

### Local architecture

```
simulator ──HTTP──▶ API :3000 ──append──▶ PostgreSQL (events + projections)
                                               │ NOTIFY / poll
                                          relay (one) ──XADD──▶ Valkey streams tp:car:0..3, tp:train:0..1, tp:shipper:0
                                                                   │ consumer groups (lease per partition)
                    ┌──────────────┬───────────────┬───────────────┼───────────────┐
                 car-state        eta          exceptions       notifier        replanner
                  :3012          :3013           :3014           :3015           :3016
                    └── decisions appended back to PostgreSQL in each consumer's transaction ──┘
frontend (Vite :5173) ──/api──▶ API
```

Seven Node.js processes (`npm run dev` starts all of them), PostgreSQL and Valkey. The simulator runs a closed-loop discrete-event world: yards build each departing train from the system's current plans (`GET /trains/runs/:id/planned`), so replanned cars really ride their new trains.

### Production-grade patterns actually implemented

| Pattern | Why it matters at scale | Where |
|---------|-------------------------|-------|
| Event store with per-stream versions, expected-version appends, natural-key dedupe | One source of truth; optimistic concurrency for plans; idempotent ingest | `backend/src/shared/event-store.ts` |
| Event store as transactional outbox + relay with `SKIP LOCKED` and a leader lock | No dual writes; duplicates only on relay crash | `backend/src/relay/index.ts` |
| Partitioned consumer runner: partition leases, PEL recovery on start, XAUTOCLAIM, bounded retries, DLQ, retry stream, ack after commit | Kafka-like semantics on Valkey Streams | `backend/src/shared/consumer.ts` |
| Idempotent consumers (`processed_events` in the effect's transaction) | Exactly-once effects over at-least-once delivery | `pgDeps` in `consumer.ts` |
| Versioned zod schemas + upcaster (CarSighted v1 → v2) | Mixed-firmware producers, consumers see one version | `backend/src/shared/events/` |
| Pure projections + replay with row-by-row comparison and `--apply` | Rebuild after a bug fix or schema change; prove equivalence | `backend/src/projections/replay.ts` |
| Orchestrated saga with compensation, resumable steps, sweeper | Replans survive crashes and cancellations | `backend/src/replanner/saga.ts` |
| Dwell-based Monte Carlo ETA with common random numbers | Deterministic, explainable uncertainty | `backend/src/domain/eta-model.ts` |
| ClockTicked from the event-time watermark | Time-driven recomputes that replay reproduces | `emitClockTick` in `backend/src/consumers/eta/handler.ts` |
| Per-shipper digest batching (quiet period, max window, min interval, collapse, suppression) | Fan-out without flooding | `backend/src/domain/digest.ts`, `consumers/notifier/handler.ts` |
| Prometheus metrics (lag, pending, staleness, DLQ, events/s), pino logs, health endpoints per process | Operability | `backend/src/shared/metrics.ts`, `api/services/streams.ts` |

### Simplified or substituted

- **Valkey Streams instead of Kafka**, one stream per partition, leases instead of a group coordinator. Messages carry the full envelope.
- **One PostgreSQL** for the event store, projections and saga state (production: sharded event store, read replicas).
- **One instance per consumer group** locally (the lease mechanism supports more: `CONSUMER_NAME=eta-2`).
- **Simulation clock** in Valkey: the API stamps `recorded_at` in simulated time so lateness is meaningful at 1,800×; batching windows use wall-clock seconds.
- **Dwell history is seeded**, not computed from history; the simulator's yards are more regular than the history, so bands come out conservative.
- **Replanning considers trains between the same two yards**, not alternate routings, and books capacity per car, not by length and tonnage.
- **Session auth and a shared ingest token** instead of SSO and per-producer mTLS.
- **The train fan-out runs inside the consumer** rather than through a re-key stage.

### Omitted

- CDC (Debezium), Kafka, schema registry, compacted topics.
- The notification delivery gateway (email/EDI/webhooks); digests are recorded, not sent.
- Car snapshots per trip, archive tiering of the event store.
- Learning dwell distributions from the event store; alternate routing; length/tonnage capacity.
- Kubernetes, multi-region, SSO.
