# Railcar Trip Plans and ETAs — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Event model → Architecture → Car state → Replanning → ETA → Deep dives → Traces → Follow-ups → Scale*

> "The prompt: every loaded car moves on a trip plan, an origin, a sequence of yards and trains, and a destination. AEI readers and yard systems report where cars actually are. Track each car against its plan, catch missed connections early, predict ETAs, and show shippers their cars. Before I draw anything I want to name the shape of the problem. It is not a throughput problem: a Class I network produces a few hundred car events a second. It is a correctness problem under bad delivery: facts come from dozens of producers I don't control, some hours late, some twice, some never. So I'll build it event-driven around one durable log, and three ideas carry the answer. A car's state is a fold over facts sorted by event time, so arrival order doesn't matter. A trip plan is a decision with versions and optimistic concurrency, changed by one orchestrated replanning process. And an ETA is a distribution walked yard by yard, because cars spend most of their trip standing in yards, not moving."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Facts vs decisions; early detection; ETA as a range; shipper isolation |
| Event model and architecture | ~8 min | Event store as source of truth and outbox; car and train topics; five consumer groups |
| Car state, replanning, ETA | ~10 min | Order-independent fold; predicted misses; saga; dwell walk |
| Deep dives | ~14 min | Missing and late events; orchestration vs choreography; partition key and exactly-once |
| Traces, follow-ups, scale | ~8 min | One success, two failures, the 100-car delay, what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who creates trip plans? | Whether plans are inputs or my decisions | My system plans from the waybill, and replans; operators can override |
| What reports car position? | Delivery semantics | AEI gateways (store and forward), yard systems, the dispatch system, other railroads' interchange feeds: all at-least-once, some hours late |
| How early must a missed connection be caught? | Prediction vs detection | Before the outbound train leaves whenever the inbound delay makes it certain |
| What is an ETA here? | The trap | Delivery (placement at the customer), with a range, not a single time |
| Who sees what? | Access model | A shipper sees only its own cars, including after interchange; operations sees everything |
| Who gets told, how often? | Fan-out | Shippers, batched into digests; no per-event email |

### Functional requirements

1. Ingest car facts (AEI reads, yard arrivals and departures, pulls, placements, bad orders, interchanges) and train facts (departed, arrived, delayed, cancelled).
2. Plan each trip and version every change with its reason.
3. Keep a per-car state that tolerates missing, duplicated, late and out-of-order events, and says how sure it is.
4. Detect missed connections, predicted and actual; replan onto the next train with capacity; compensate if that train is cancelled.
5. Predict delivery as p10/p50/p90 from yard dwell history and the schedule.
6. Send each shipper one digest per batching window; give operations an exceptions board and per-car event timelines.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Durability | No accepted fact lost; producers resend freely | Append before acknowledging; idempotent ingest |
| Freshness | Fact → car state < 5 s p99, → ETA < 30 s p99 | Streaming consumers |
| Early warning | Predicted miss < 1 min after the delay report | Decide on TrainDelayed, not TrainDeparted |
| Correctness | Same state for any arrival order; 72 h late data | Event-time folds |
| Exactly-once effects | One replan, one exception, one digest per cause | Idempotency inside the effect's transaction |
| Isolation | Zero cross-shipper leaks | Filter at the read model from the session |

### Capacity estimate

Public figures: BNSF's 10-K lists 32,500+ route miles and about 70,700 owned or leased freight cars; most cars on a Class I belong to lessors and shippers. Everything else is my assumption.

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Loaded cars moving | ~200K | Owned fleet plus foreign and private cars |
| Car facts | ~2.4M/day, ~30/s avg, ~300/s peak | ~8 AEI reads + ~4 yard events per car per day; bursty at arrivals |
| Train facts | ~30K/day | ~5K runs/day × ~6 events |
| Train fan-out | ~3M car updates/day | ~100 cars per train event |
| ETA recomputes | ~8M/day, ~100/s | Facts + fan-out + clock ticks |
| Log growth | ~3 GB/day | ~5.5M events × ~600 B |

> "So the numbers say one modest cluster. The design effort goes into ordering, lateness and fan-out."

---

## 🧱 Event Model (~3 min)

> "I separate facts from decisions. Facts are what producers saw; I can't reject them, only record them. Decisions are what my services concluded; they are events too, appended by the service that made them."

| Kind | Events | Producer | Key |
|------|--------|----------|-----|
| Car facts | CarSighted, CarArrivedYard, CarDepartedYard, CarPulled, CarPlaced, CarBadOrdered, CarInterchanged | AEI, yards, interchange feeds | car id |
| Train facts | TrainDeparted (with consist), TrainArrived, TrainDelayed, TrainCancelled | dispatch | train run |
| Plan (aggregate) | TripPlanCreated, TripPlanRevised | planner, replanner, operators | car id (stream per trip) |
| Decisions | ConnectionMissed, EtaUpdated, ExceptionOpened/Resolved, ReplanStarted, TrainCapacityReserved/Released, ReplanCompleted/Failed/Compensated, ShipperNotified | consumers | car id (shipper id for digests) |
| Time | ClockTicked | the ETA service, from the event-time watermark | clock |

Every event carries an envelope: event id, type and **schema version**, stream id and stream version, **event time** (when it happened) and **recorded time** (when I appended it), correlation id (the business flow) and causation id (the event that caused it). Causation is what lets an operator click a plan revision and see "TrainDelayed → ConnectionMissed → ReplanStarted → TrainCapacityReserved → TripPlanRevised → EtaUpdated → ReplanCompleted → digest".

---

## 🏗️ High-Level Architecture (~5 min)

```
 AEI gateways   Yard systems   Dispatch (TMS)   Interchange feeds   Waybill feed
      └─────────────┴──────────────┬───────────────┴──────────────────┘
                                   ▼ at-least-once batches (mTLS)
                        ┌──────────────────────┐
                        │ Ingest service       │ validate type + version + schema,
                        │ (stateless)          │ dedupe by event id and natural key
                        └──────────┬───────────┘
                                   ▼
          ┌───────────────────────────────────────────────────────┐
          │ EVENT STORE (PostgreSQL, partitioned by stream)        │  ◀── SOURCE OF TRUTH
          │ append-only events, per-stream version, published flag │      and the OUTBOX
          └──────────────┬────────────────────────────────────────┘
                         ▼ relay / CDC
          ┌───────────────────────────────────────────────────────┐
          │ KAFKA  car-events (key car id)  train-events (key run) │  ◀── integration backbone
          └──┬────────────┬─────────────┬────────────┬────────────┬─┘
             ▼            ▼             ▼            ▼            ▼
        car-state        eta        exceptions    notifier     replanner
        projection    dwell model     board       digests     (process manager)
             │            │             │            │            │
             └────── decisions appended to the event store, same transaction ──┘
                                   ▼
                   Read models (car_state, car_eta, plans, exceptions)
                                   ▼
                   Portal API (shipper-scoped) ─▶ shipper portal, ops board
```

> "The event store in PostgreSQL is the source of truth and also the outbox: each row has a published flag, and a relay (or Debezium) moves committed rows to Kafka. Kafka gives me partitioned fan-out and a replay window; anything older replays from PostgreSQL. Every consumer writes its read model, the decision events it produced, and an idempotency marker in one transaction, then commits the Kafka offset. That's how at-least-once delivery becomes exactly-once effects."

### Consumer groups

| Group | Reads | Writes | Emits |
|-------|-------|--------|-------|
| car-state | car + train topics | car_state | ConnectionMissed |
| eta | car + train topics, ClockTicked | car_eta, eta_history | EtaUpdated |
| exceptions | car topic | exceptions board | ExceptionOpened / Resolved |
| notifier | car topic | notification items, digests | ShipperNotified |
| replanner | car + train topics | replan_sagas, run reservations, plans | Replan*, TrainCapacity*, TripPlanRevised |

---

## 💾 Data Model (~3 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| events | position (global), event_id (unique), stream_id + stream_version (unique), dedupe_key (unique), occurred_at, recorded_at, correlation_id, causation_id, payload, published_at | Append-only; the outbox is "published_at is null" |
| event_cars, train_run_cars, plan_run_index | (car, position), (run, car), (trip, run) | Log indexes written in the append transaction; a car's timeline is a union over them |
| processed_events | (consumer group, event_id) | Inserted in the effect's transaction |
| car_state | car_id → status, location, train run, position confidence (observed / inferred), plan status, missed reads, late and out-of-order counts, shipper_id | Projection |
| trip_plans, trip_plan_versions, plan_legs_current | trip, version, legs (train run, from, to, planned times), reason | Inline projection of the plan aggregate; "who is planned on run R" index |
| car_eta, eta_history | car → p10/p50/p90, confidence, as-of, basis | History keyed by triggering event |
| replan_sagas | saga_id, dedupe (trip, version, leg, attempt), state, chosen run, revision event id, steps | Process manager state |
| run_reservations | (run, trip) | Capacity: a run is full when its count reaches capacity |
| dwell_stats | (yard, block) → p10/p50/p90 | Historical yard time |

---

## 🔌 API Design (~2 min)

```
POST /api/v1/ingest/events            facts batch → accepted | duplicate | rejected per event
POST /api/v1/ingest/trips             waybill → plan → TripPlanCreated (idempotent on trip id)
GET  /api/v1/cars?status=&q=          shipper-scoped car list with state, plan version, ETA range
GET  /api/v1/cars/:id                 state, plan versions with reasons, ETA and its history
GET  /api/v1/cars/:id/timeline        every event: event time vs recorded time, lateness, causation
POST /api/v1/trips/:id/revise         operator override, expectedVersion → 409 on conflict
POST /api/v1/exceptions/:id/resolve   expected version → 409 if someone else resolved it
GET  /api/v1/streams/overview         lag, pending, staleness, DLQ depth per consumer group
POST /api/v1/streams/dlq/:group/:id/redrive
```

---

## 🚂 Core Flows (~10 min)

### Car state as a fold

> "For each car I load its timeline: events that name it, every event of every train run it rode, and every event of every run its plan named. I sort by event time and walk it. Yard and AEI reads set the position as observed. A TrainDeparted with the car in its consist puts it in transit, and a TrainArrived for a run it rode puts it in the next yard, both as inferred unless a car-level read confirms them. Afterwards I count missed reads, late events and out-of-order arrivals. The same set of events always produces the same state."

### Missed connections, predicted and actual

> "Two rules in car-state. On TrainDelayed, for every car on that train whose next leg leaves the destination yard: if the new arrival plus the yard's minimum connection is after the planned departure, the connection is already lost. That fires hours before the outbound leaves. On TrainDeparted, any car planned on that run but not in the consist missed it. Both emit ConnectionMissed with a dedupe key of trip, plan version and leg, so the early prediction and the later actual miss are one event."

### Replanning (orchestrated)

| Step | Local work | Event | Next state |
|------|------------|-------|------------|
| Start | Create saga row (dedupe per trip, version, leg, attempt) | ReplanStarted | started |
| Reserve | Book a seat on the first run between the same yards, after the car is available, with room | TrainCapacityReserved, or ReplanFailed | reserved / failed |
| Revise | Append TripPlanRevised with expected version = the version the saga started from; release old seats | TripPlanRevised | awaiting_eta |
| Await ETA | Wait for the EtaUpdated whose causation is that revision | ReplanCompleted | completed |
| Compensate | Chosen train cancelled or plan moved: release the seat, start a child saga | TrainCapacityReleased, ReplanCompensated | compensated |

### ETA from dwell

> "For each sample, I walk the remaining legs. At each yard: the car is ready after a yard time drawn from that yard's history for its block; it leaves on the planned train if ready in time and the train isn't cancelled or gone, else on the next train between the same yards; it arrives after a sampled run time, or the reported delay if there is one. Then the destination's local delivery time. Two hundred samples give p10, p50, p90. I seed by car and plan version, so a replay gives the same numbers and successive recomputes only move when inputs move. And because a car sitting in a yard with no news should still see its ETA move, the clock itself is an event: ClockTicked from the event-time watermark."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Yard-by-yard walk over dwell history and the schedule | Matches where the time goes (60–80% in yards); explains itself ("misses its next connection in 56% of samples"); gives a range | Needs dwell history per yard and block; 200 samples per recompute |
| ❌ Remaining distance / average speed | Trivial; one number | A car 300 miles out at 40 mph is not 7.5 h away when it still has to be classified and wait for tonight's train; hides uncertainty |
| ❌ Schedule only (planned arrival of the last leg) | Simple, consistent with the plan | Assumes every connection is made; the first late inbound makes it wrong until a replan |

### Notifications

> "Each ETA change, replan, bad order or delivery becomes an item in its shipper's window. The window flushes after a quiet period, or a maximum duration, never more often than a minimum interval. The flush collapses to one line per car, compares the ETA against what the shipper was last told, suppresses small wobbles, and appends ShipperNotified in the same transaction."

### Ordering and time

| Concern | Rule |
|---------|------|
| What is ordered | Per partition key, in append order: everything about one car; each train run's own movements |
| What is not | Anything across keys, including a car's facts versus its train's facts |
| How handlers cope | Folds sort by event time; decisions dedupe by business key, so arrival order never changes the outcome |
| Late data | No cutoff for state: a 72-hour-late interchange record still lands in the right place in the fold |
| Decisions made on old information | Never retracted silently; the next plan version is the correction, and both stay in the log |
| "Now" for sweeps and ETAs | The event-time watermark (newest field event time), published as ClockTicked; wall-clock time only for digest windows |

### Schema evolution

> "AEI readers get firmware upgrades in the field over months, so two versions of CarSighted coexist: v1 from old readers, v2 adding read confidence and orientation. The log stores each event exactly as produced. Consumers read through upcasters: v1 becomes v2 with confidence null and orientation UNKNOWN. The upcaster never invents a value the old reader couldn't know. The rules I hold to: additive optional fields with defaults within a version; anything else is a new version and an upcaster; consumers deploy the upcaster before any producer sends the new version. If a producer jumps ahead and sends v3, upcasting fails, the message retries and dead-letters, and I redrive it once the consumer is upgraded. Ingest validates each event against the schema of the version it claims, so a malformed payload never enters the log."

### Replay

> "Every read model is a pure function of the log, so `replay car-state` rebuilds into shadow tables from position zero, compares row by row with the live table, and can swap. Rebuilds don't re-emit decisions: those are already facts in the log. After the full simulated run, including the SIGKILL, all four projections rebuilt identical to live."

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Per-car state under missing and late events — projection, not aggregate

> "The tempting design is an event-sourced Car aggregate: commands come in, it validates against current state, appends with an expected version. I chose a projection over facts instead, and the reason is the nature of the inputs."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Projection: fold the car's facts sorted by event time | Order-independent; late facts slot into the past; replay-safe; nothing to reject | Refold costs a query per update; needs a per-trip snapshot at scale |
| ❌ Event-sourced Car aggregate with expected-version appends | Familiar; cheap incremental updates | Must either reject a late fact (losing it) or apply it "after" newer state (wrong position); concurrent producers conflict constantly |
| ❌ Mutable row updated per event | Simplest | Last write wins by arrival time, so a 23-hour-late interchange record moves a car backwards |

> "An aggregate exists to protect invariants by accepting or rejecting commands. Nobody commands a car to be read by an AEI site. A reader 600 miles away and another railroad's EDI bridge both report facts, and a fact that arrives a day late still happened. With an aggregate I'd have to choose between rejecting it, which loses information, or appending it after newer events, which puts the car back at the interchange yard after it already left. With a fold sorted by event time the late record simply lands in the past: it confirms where the car was, upgrades an inferred position to observed, and changes nothing about where it is now. I verified exactly that: posting a 44-hour-old line read for a car in transit increments its late and out-of-order counters and leaves its position and ETA untouched."

> "Missing events are the other half. AEI readers miss tags; yard systems go down. If no car-level read confirms a move, the train's own movement does: TrainDeparted lists the consist, TrainArrived tells me the yard. I mark that position inferred, count the missed read, and drop the ETA's confidence a level. When a late yard report arrives it upgrades the position to observed. So the answer to 'an AEI reader missed the car, where is it?' is: where its train went, flagged as inferred."

> "The plan is the opposite case, and that's why it *is* an aggregate. A plan is my decision; the replanner and an operator can race to change it; and I must keep every version with its reason. So `plan-<trip>` is a stream whose version is the plan version, and a revision appends with the expected version. The loser reloads and decides again."

> "What I give up: refolding a car's 20 to 60 events on every update. At a millisecond per fold that's fine; at production scale I'd snapshot per trip and fold the tail, refolding fully only when an event arrives older than the snapshot."

### Deep dive 2: Replanning — orchestration over choreography

> "Replanning is a multi-step process: find the next train with capacity, reserve a seat, write a new plan version, get the new ETA, tell the shipper. I could choreograph it, each service reacting to the previous one's event, or orchestrate it with a process manager. I orchestrate this one process and choreograph everything else."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Orchestrated saga: one state row per replan, steps as transactions, compensation in one place | Explicit order and timeouts; "where is the replan for this car?" is one query; seats always released | A coordinator to run and scale; coupled to the planner |
| ❌ Choreography: reservation reacts to ConnectionMissed, planner reacts to SeatReserved, ETA reacts to PlanRevised | No coordinator; services independent | Compensation smeared across services; a lost event leaves a seat booked with no owner; no single view of progress |

> "The deciding factor is the resource. Trains have finite capacity. In the choreographed version, the reservation service books a seat when it sees ConnectionMissed, the planner revises when it sees SeatReserved, and then the chosen train is cancelled. Who releases those 60 seats? The reservation service doesn't know which plans used them; the planner doesn't own seats. Every service ends up holding a piece of the compensation logic, and if one event is lost a seat stays booked forever with no owner, quietly shrinking capacity."

> "With a process manager each replan is a row: started, reserved, awaiting ETA, completed, with the chosen run and the revision's event id. Each step is one transaction: lock the row, check the state, do the local work, append the step's event, move the state. If the process dies between steps, a sweeper resumes it; steps check state first, so repeating one is a no-op. When TrainCancelled arrives, the replanner finds every saga that chose that run, releases the seats, marks them compensated, and starts child sagas with attempt two. In the simulated run that's exactly what happened: 60 cars were moved onto a priority train with 60 seats, the train was cancelled, and 60 compensations plus 60 child sagas put them on the next manifest."

> "The plan revision step uses the aggregate's expected version. If an operator revised the plan while the saga was reserving, the append fails, and the saga compensates instead of overwriting a human decision."

> "Why not orchestrate everything? Because ETA must react to *every* plan change, including an operator's, and to every train event; notifications react to every ETA change. Routing those through the orchestrator would couple it to every consumer and make it the bottleneck. So the saga waits for the ETA service's reply, matched by causation id, but the ETA service doesn't know sagas exist. What I give up is a coordinator I have to run, monitor and shard by trip id."

### Deep dive 3: Partition key, the hot key, and exactly-once as at-least-once plus idempotency

> "Two questions decide the stream layout: what must be ordered, and where does the work concentrate."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Car topic keyed by car id; train topic keyed by train run | Per-car order for facts, plans and decisions; per-train order for movements | A 100-car train event is one message that fans out to 100 car updates in one consumer |
| ❌ Everything keyed by train run | Train-centric order | A car changes trains at every yard, so its events scatter across partitions and two consumers update one car concurrently |
| ❌ Everything keyed by car (publish each train event once per car) | Parallel per-car work | Loses a train's own order; 100× the log volume for train events |

> "Everything about one car, its facts, its plan events and every decision about it, goes to the car partition, and one consumer instance owns that partition at a time. Train facts are keyed by run so departed, delayed and arrived stay in order. The cost is the hot key: TrainDeparted for 100 cars is one message, and car-state and ETA each do 100 units of work for it inside one handler. In my run, the 88-car delay meant 88 Monte Carlo recomputes in one ETA transaction. The production fix is a re-key stage: a tiny consumer that turns each train event into per-car derived events on the car topic, so the expensive work spreads across car partitions while train order stays intact."

> "Note what I gave up: order between a car's own facts and its train's facts, because they travel on different topics. That's only safe because of deep dive 1: the fold is order-independent. These two decisions depend on each other."

> "Exactly-once. Kafka delivers at least once, and so does my relay: if it dies after publishing and before marking rows published, those rows go out again. I don't fight that. Every consumer runs each message in one database transaction that inserts (group, event id) into processed_events, writes its read model, and appends any decision events. Then it commits the offset. If it dies before commit, everything rolls back and the message is redelivered. If it dies after commit but before the ack, the redelivery hits the primary key and is acknowledged as a duplicate. Business keys back this up: ConnectionMissed is unique per trip, version and leg; sagas per trip, version, leg and attempt; digest items per source event. I tested it by SIGKILLing the ETA consumer in the middle of the 88-car fan-out: on restart it re-read its pending message, and the result was 88 history rows, 88 EtaUpdated events and one idempotency marker."

> "Poison messages are the last piece. A fact about a car the registry doesn't know, because its waybill hasn't arrived, fails in car-state. After four deliveries it moves to that group's dead-letter stream with the error, and the partition keeps flowing. I don't block the partition, Kafka-style, because every handler tolerates order; one unknown car shouldn't stall a quarter of the fleet. Once the car is registered, an admin redrives it onto the group's own retry stream, so groups that already processed it aren't bothered."

---

## 🔐 Access Control (~1 min)

> "A shipper sees only its own cars. I enforce that at the read model, not in a gateway or the UI. Every projection row carries the shipper id, copied from the plan when the consumer writes it, so a list query is 'where shipper id equals the session's shipper id'. A request for another shipper's car returns 404, not 403, so it doesn't confirm the car exists. Timelines are redacted on the server: a train departure shows its size and whether this car was aboard, never the other cars. Digests are built per shipper from items already keyed by shipper. And access follows the trip, not the railroad, so a car handed to another railroad stays visible, with the foreign road's late sightings folded in."

## 🗺️ Kafka Mapping (local stand-in)

| Concept | Production | Local |
|---------|------------|-------|
| Topics and partitions | car-events (64, key car id), train-events (16, key run), shipper-events (8) | One Valkey stream per partition |
| Group assignment | Group coordinator | A lease per (group, partition), renewed every few seconds |
| Offset commit | After the database transaction | XACK after the transaction |
| Stuck work | Rebalance, re-read from the committed offset | XAUTOCLAIM of entries idle > 3 s |
| Retry and DLQ | Per-group retry and DLQ topics | `retry:<group>` and `dlq:<group>` streams |
| Outbox to topic | Debezium CDC | A relay process with `SKIP LOCKED` |

---

## 📜 Execution Traces (~3 min)

### Successful trace: a six-hour delay

1. **04:00** TrainDeparted M-NGTMID with 88 cars for 6 shippers. Ingest appends it and 88 consist rows; the relay publishes it to the train partition.
2. car-state refolds 88 cars (in transit); eta recomputes 88 ETAs.
3. **08:00** TrainDelayed +6 h, new arrival 18:00. car-state: next leg leaves Midland at 20:00; 18:00 plus a 5-hour minimum connection is past 20:00, so 88 predicted ConnectionMissed, in the same transaction as the 88 projection updates.
4. replanner: 88 sagas. Each reserves the next Midland–Port run with room (60 fit on tomorrow's 07:00 priority train, the rest on the 20:00 manifest) and appends TripPlanRevised v2 with expected version 1.
5. eta replies to each revision with EtaUpdated; each saga completes; exceptions resolves the missed-connection exceptions it opened.
6. notifier: hundreds of items for 6 shippers collapse into 6 digests, one line per car.

### Failed trace: consumer killed mid-fan-out

1. The ETA consumer is inside the transaction for TrainDelayed (88 cars) when it's killed.
2. PostgreSQL rolls back; nothing is written. The message stays pending for that consumer.
3. The restarted process (same consumer name) reclaims its partition leases and reads its pending entries first; it reprocesses the delay from scratch and commits once.

### Failed trace: the chosen train is cancelled

1. 60 sagas completed onto the priority train; dispatch cancels it five hours before departure.
2. One transaction in the replanner: release 60 seats, 60 ReplanCompensated, 60 child sagas (attempt 2).
3. The children reserve the next run with room and write plan v3; shippers see "plan v2 → v3: priority train cancelled" in their next digest.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The PostgreSQL event store. A fact when its append commits; a plan revision when it commits at the expected version; a consumer decision when its transaction (state + events + marker) commits |
| Client retries after losing the response? | Same event id or natural key → duplicate; trip creation idempotent on trip id; commands carry expected versions |
| Failure between two steps? | Consumers: one transaction per message, ack after commit. Relay: duplicates, never losses. Saga: resumable steps, sweeper, compensation |
| Ordering actually required? | Per car by event time (computed, not trusted); per train run in append order; nothing across keys |
| Access with caches and async jobs? | Every projection row carries the shipper id; queries filter by the session's id; digests built per shipper; consists redacted in shipper timelines |
| What breaks first? | ETA fan-out on train events (88 recomputes per delay in one consumer), then event store volume (EtaUpdated), then the single relay |

---

## 🧩 Follow-ups I'd Expect

**A train carrying 100 cars for 40 customers is six hours late. What goes out?**
> "One TrainDelayed. Car-state predicts which of the 100 will miss their connections and emits one ConnectionMissed each; the replanner moves those to the next trains with room and writes new plan versions. The ETA service recomputes all 100. The notifier receives a few hundred items and sends 40 digests, one per customer, each with one line per car: new ETA range, how far it moved since the last thing they were told, and the plan change with its reason. If the delay grows twice within the window, each customer still gets one message."

**An AEI reader misses a car. How do you know where it is?**
> "From its train. The consist on TrainDeparted and the TrainArrived event place it; the state says 'inferred', the missed read is counted, and the ETA confidence drops a level. A late yard report later upgrades it to observed. If a car is missing from a consist it was planned on, that's a missed connection, not a missing read."

**How accurate is your ETA, and how do you show uncertainty?**
> "I show p10 to p90 as a band with the median marked and the original plan as a reference line, plus where the remaining time goes: yards versus trains, and the chance the car misses its next connection. I measure calibration: of delivered cars, what share arrived inside the band predicted 24 hours earlier, and the median error. If the band is too narrow, the dwell history or the run-time spread is wrong; if it's too wide, it's not useful, so I'd learn dwell per yard, block, day of week and season."

**Other railroads' interchange records arrive a day late and twice.**
> "Natural-key dedupe at ingest drops the resend even with new message ids; the fold places the record in the past. The shipper keeps seeing the car on the foreign road because access follows the trip, not the railroad."

**You change the ETA model. What about existing ETAs?**
> "Deploy, then `replay eta --apply`: rebuild from position zero into shadow tables, compare row by row, swap. Decisions already made (EtaUpdated events, digests) stay in the log as what we said at the time."

---

## 🚨 Failure Handling (~1 min)

| Failure | Behaviour |
|---------|-----------|
| Poison message | 4 deliveries, then the group's DLQ with the error; redrive after the fix |
| Unknown car inside a train's consist | Skipped for that train event; only the car's own fact dead-letters |
| Relay crash | Unmarked rows republished; consumers dedupe |
| Broker down | Ingest still commits; the outbox grows and drains later |
| No capacity within 96 h | ReplanFailed → high-severity exception for a planner |
| Concurrent plan edit | Saga compensates; operator gets 409 |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **ETA on train fan-out.** Add the re-key stage, more car partitions, and recompute on clock ticks only for cars whose p10 has passed.
2. **Event store volume.** Emit EtaUpdated only on material moves (≥ 60 min, done), hash-partition by stream, monthly partitions, cold storage.
3. **The relay.** One per shard, or CDC.
4. **Timeline reads.** Snapshots per trip and a precomputed timeline projection.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Car state | Projection folded by event time | Event-sourced car | Facts can't be rejected; late data must reorder |
| Plans | Event-sourced, expected version | Mutable row | Racing writers; every version and reason kept |
| Log | PostgreSQL event store as outbox | Kafka as the only log | One transactional, queryable source of truth |
| Delivery | At-least-once + idempotent consumers | Exactly-once transport | Effects exactly once, in the database |
| Keys | Car id; train run for train facts | One key for everything | Order where it matters; hot key accepted |
| Replanning | Orchestrated saga | Choreography | Seats must be released; progress visible |
| ETA | Monte Carlo over yard dwell | Distance / speed | Yards dominate transit time |
| Time | ClockTicked from watermark | Wall-clock timer | Replay reproduces ETAs |
| Notifications | Per-shipper digest windows | Per-event messages | 100 cars → 1 message per customer |

---

## 📝 Wrap-up (~1 min)

> "To recap: one event store that is both the source of truth and the outbox; facts folded by event time so missing, late and duplicated data converge; plans as an aggregate changed by one orchestrated, compensating replanner; ETAs walked yard by yard as a distribution, with time itself in the log; and digests per shipper so a 100-car delay is 40 messages, not 4,000."

### How the local implementation compares

Valkey Streams stand in for Kafka (one stream per partition, leases for assignment, XAUTOCLAIM for redelivery); one PostgreSQL holds the event store, projections and saga state; a simulator plays three days of a four-yard railroad in about two and a half minutes, with missed reads, a late and duplicated interchange batch, a six-hour delay, cars left behind, a bad order, a cancelled train and an unknown car that dead-letters. `npm run replay -- all` reproduces every projection exactly.
