# Railcar Trip Plans: Event Catalog

Every event in the system, who produces it, who consumes it, what it is keyed by and what it carries. The code version of this catalog is `backend/src/shared/events/catalog.ts` (routing) and `backend/src/shared/events/schemas.ts` (zod schemas per version).

## Envelope (every event)

| Field | Meaning |
|-------|---------|
| `event_id` | UUID. Producer-assigned for facts from the field, service-assigned for decisions. A resend with the same id is a no-op. |
| `type`, `version` | Schema identity. The log stores the version as produced; consumers upcast on read. |
| `stream_id`, `stream_version` | The entity stream (`car-<id>`, `train-<run>`, `plan-<trip>`, `exception-<id>`, `replan-<saga>`, `eta-<car>`, `carstate-<car>`, `shipper-<id>`, `clock`) and the event's position in it. Writers that pass an expected version get optimistic concurrency. |
| `topic`, `partition_key` | Where the relay publishes it: `car` (key = car id), `train` (key = train run id), `shipper` (key = shipper id). |
| `occurred_at` | Event time: when it happened in the world. |
| `recorded_at` | Processing time: when the event store appended it (the simulation clock while the simulator runs). |
| `correlation_id` | The business flow it belongs to (one delay, one replan). Facts start a flow; decisions inherit it. |
| `causation_id` | The event that directly caused this one. Null for facts from the field. |
| `producer` | `aei:<site>`, `yard:<yard>`, `tms:dispatch`, `interchange:LPS`, `waybill-feed`, `ops:<user>`, `svc:<consumer>`. |
| `dedupe_key` | Natural key for facts (catches a resend under a new event id), or a decision's idempotency key. |

## Flow

```
 PRODUCERS                         EVENT STORE (PostgreSQL)              STREAMS (Valkey ≈ Kafka)          CONSUMER GROUPS
 ┌──────────────────────┐          ┌──────────────────────────┐          ┌──────────────────────┐          ┌──────────────────────────┐
 │ AEI reader gateways  │─┐        │ events (append-only,     │          │ tp:car:0..3          │─────────▶│ car-state  (projection + │
 │ yard systems         │ │ ingest │  per-stream version,     │  relay   │  key = car id        │          │   ConnectionMissed)      │
 │ dispatch (TMS)       │ ├───────▶│  published_at = outbox)  │─────────▶│ tp:train:0..1        │─────────▶│ eta (ETA + EtaUpdated,   │
 │ LPS interchange EDI  │ │  API   │ + event_cars,            │  XADD by │  key = train run     │          │   ClockTicked)           │
 │ waybill feed         │─┘        │   train_run_cars,        │  key hash│ tp:shipper:0         │          │ exceptions (board)       │
 └──────────────────────┘          │   plan_run_index         │          │  key = shipper       │─────────▶│ notifier (digests)       │
                                   └──────────▲───────────────┘          └──────────────────────┘          │ replanner (saga)         │
                                              │  decisions appended in the consumer's own transaction      └────────────┬─────────────┘
                                              └──────────────────────────────────────────────────────────────────────────┘
 Per group: tp:retry:<group> (redrive target, read only by that group) and tp:dlq:<group> (dead letters after 4 deliveries)
```

**Ordering guarantee:** per partition key, in append order. Everything about one car (its facts, its plan events, every decision about it) shares the car partition. Train facts are ordered per run. Nothing is ordered across keys. No consumer relies on arrival order for correctness: car state and ETA are folds over the car's events sorted by event time.

**Retention:** the event store keeps everything (it is the source of truth; production would tier old partitions to cold storage). Streams are capped at 500K entries per partition (`MAXLEN ~`); a consumer that falls further behind than that rebuilds from the event store with `npm run replay`. Production mapping: Kafka topics with 7-day retention, plus a compacted `eta-current` topic keyed by car id for the portal cache.

---

## Car movement facts (topic `car`, key car id, stream `car-<carId>`)

Producers report what they saw. Facts are never rejected for being late, out of order or about an unknown car, only for being malformed or dated in the future.

### CarSighted

An AEI reader read the car's tag.

| | |
|-|-|
| Producers | AEI reader gateways (`aei:<site>`); the foreign road's feed for reads on its network (`interchange:LPS`) |
| Consumers | car-state, eta |
| Natural key | car + site + minute |

| Field | Type | v1 | v2 | Notes |
|-------|------|----|----|-------|
| carId | string | ✔ | ✔ | |
| siteId | string | ✔ | ✔ | `line` readers between yards, `yard_lead` readers at yard entrances |
| trainRunId | string or null | ✔ | ✔ | When the gateway knows the train |
| direction | E / W / null | ✔ | ✔ | |
| railroad | string | ✔ | ✔ | `PN` (home) or the foreign road |
| readerConfidence | 0–1 or null | | ✔ | Newer firmware reports read quality |
| orientation | A_END_LEADING / B_END_LEADING / UNKNOWN | | ✔ | Which end of the car led |

**Version history.** v1: original. v2: adds `readerConfidence` and `orientation` (required). Upcaster v1 → v2 sets `readerConfidence: null`, `orientation: UNKNOWN`: the old reader could not know them, so the upcaster says "unknown" rather than inventing a value. Northgate-area readers still send v1; both versions coexist in the log. Consumers deployed with the upcaster before any reader sent v2. A version a consumer does not know (v3) fails upcasting, is retried, then dead-lettered until the consumer is upgraded and the message redriven.

### CarArrivedYard / CarDepartedYard

The yard system booked the car in or out.

| | |
|-|-|
| Producers | yard systems (`yard:<yard>`) |
| Consumers | car-state, eta |
| Natural key | arrival: car + yard + minute; departure: car + train run |

| Field | Type | Notes |
|-------|------|-------|
| carId | string | |
| yardId | string | |
| trainRunId | string (null allowed on arrival) | |
| track | string or null | Arrival only |

### CarPulled / CarPlaced

A local crew pulled the loaded car from the shipper's siding into the origin yard, or placed it at the destination customer (delivery).

| | |
|-|-|
| Producers | yard systems; the foreign road's feed for placements on its network |
| Consumers | car-state, eta; notifier (CarPlaced → `delivered` digest line) |

| Field | Type | Notes |
|-------|------|-------|
| carId, customerId | string | |
| yardId | string | CarPulled: origin yard; CarPlaced: serving yard or null |
| railroad | string | CarPlaced only; `LPS` when the foreign road placed it |

### CarBadOrdered

The car was tagged defective and moved to the repair track.

| | |
|-|-|
| Producers | yard systems |
| Consumers | car-state (status `bad_ordered`, earliest availability = event time + repair estimate), eta (repair time in the walk), exceptions (`bad_order`) |

| Field | Type | Notes |
|-------|------|-------|
| carId, yardId | string | |
| defect | string | |
| estimatedRepairHours | number or null | 24 h assumed when null |

### CarInterchanged

The car was handed to, or received from, another railroad.

| | |
|-|-|
| Producers | our interchange yard (`yard:SDV`) for deliveries; the foreign road's EDI bridge (`interchange:LPS`) for receipts. The EDI feed is batched, hours late, shuffled, and resent with new event ids. |
| Consumers | car-state, eta |
| Natural key | car + interchange point + direction + minute (this is what drops the resends) |

| Field | Type | Notes |
|-------|------|-------|
| carId | string | May name a car the registry does not know yet (its waybill has not arrived): car-state fails it, retries, dead-letters it; redrive after the car is registered |
| interchangePoint | string | Yard where the roads meet |
| direction | delivered / received | |
| fromRoad, toRoad | string | |
| waybillRef | string or null | |

---

## Train movement facts (topic `train`, key train run id, stream `train-<runId>`)

Keyed by run so a train's own events stay in order (departed before delayed before arrived). The cost: one event concerns up to ~120 cars, so consumers fan out internally (see "hot key" in architecture.md).

| Event | Producer | Consumers | Fields | Notes |
|-------|----------|-----------|--------|-------|
| TrainDeparted | `tms:dispatch` | car-state, eta | runId, trainId, fromYard, toYard, consist (car ids) | Writes `train_run_cars` in the append transaction. Car-state infers departures for cars with no yard report, and emits ConnectionMissed for planned cars not in the consist |
| TrainArrived | `tms:dispatch` | car-state, eta | runId, trainId, yardId | Car-state infers arrivals for cars with no yard or AEI read (position `inferred`) |
| TrainDelayed | `tms:dispatch` | car-state, eta | runId, trainId, delayMinutes, newEtaAt, location, reason | Several per run as the delay grows (natural key includes newEtaAt). Car-state predicts missed connections from it |
| TrainCancelled | `tms:dispatch` | eta, replanner | runId, trainId, fromYard, reason | The replanner compensates sagas that chose the run |

All v1.

---

## Trip plans (topic `car`, key car id, stream `plan-<tripId>`)

An event-sourced aggregate: the stream holds only these two types, stream version = plan version, and revisions append with an expected version.

| Event | Producer | Consumers | Notes |
|-------|----------|-----------|-------|
| TripPlanCreated | API (`waybill-feed` or `ops:<user>`) | car-state, eta; inline projection `trip_plans` | Dedupe key `tpc:<trip>`; expected version 0 |
| TripPlanRevised | replanner (`svc:replanner`) or an operator (`ops:<user>`) | car-state, eta (always answers with EtaUpdated); inline projection | Expected version = previous version; a stale writer gets 409 / ConcurrencyError |

| Field | Created | Revised | Notes |
|-------|---------|---------|-------|
| tripId, carId, shipperId | ✔ | ✔ | Shipper id is what access control filters on |
| originYard, destinationYard, destinationCustomer, handoffRoad, releasedAt | ✔ | | handoffRoad set when the trip continues on a foreign road |
| version | 1 | n | |
| previousVersion | | ✔ | |
| legs[] | ✔ | ✔ | seq, trainId, runId, fromYard, toYard, plannedDeparture, plannedArrival |
| reason | ✔ | ✔ | code (initial, missed_connection, train_cancelled, manual), text, missedRunId, yardId |
| revisedBy, sagaId | | ✔ | Which saga or operator |

---

## Decisions (topic `car`, key car id)

Appended by consumers in the same transaction as their read-model change and their idempotency marker.

### ConnectionMissed (stream `carstate-<carId>`)

| | |
|-|-|
| Producer | car-state |
| Consumers | replanner (starts a saga), exceptions (`missed_connection`), car-state (plan status) |
| Dedupe key | `cm:<trip>:<planVersion>:<legSeq>`: the early prediction and the later actual miss collapse into one event |

| Field | Notes |
|-------|-------|
| carId, tripId, shipperId, planVersion, legSeq | Which leg of which plan version |
| runId, trainId, yardId, plannedDeparture | The connection being missed |
| reason | `inbound_delay` (predicted from TrainDelayed: new arrival + minimum connection > planned departure) or `departed_without_car` (TrainDeparted without it) |
| predicted | true when detected before the outbound train left |
| availableAt | Earliest the car can leave: inbound ETA + minimum connection, or the repair estimate for a bad-ordered car |
| inboundRunId | The late inbound run, if any |

### EtaUpdated (stream `eta-<carId>`)

| | |
|-|-|
| Producer | eta |
| Consumers | notifier (`eta_change` item, unless final), replanner (the reply its saga waits for: causation id = its TripPlanRevised) |
| Emitted when | p50 moved ≥ 60 min, the plan version changed, the car was delivered, or the trigger was a plan revision |
| Dedupe key | `eta:<car>:<triggerEventId>` |

| Field | Notes |
|-------|-------|
| carId, tripId, shipperId, planVersion | |
| p10, p50, p90 | Delivery-time quantiles from 200 seeded samples |
| previousP50, shiftMinutes | vs the previous stored ETA |
| confidence | high / medium / low (band width, inferred position, bad order) |
| asOf | Newest relevant event time or clock tick the ETA is conditioned on |
| trigger | Type of the event that caused the recompute |
| final | true once the car is placed |

### ExceptionOpened / ExceptionResolved (stream `exception-<exceptionId>`)

| | |
|-|-|
| Producers | exceptions (opened and auto-resolved); API for operator resolution (`ops:<user>`, expected version 1) |
| Consumers | exceptions (applies both to the board), notifier (bad orders) |
| Ids | Deterministic: `MC-<trip>-v<n>-L<leg>`, `TC-…`, `NC-<saga>`, `BO-<car>-<time>`, `DW-<car>-<yard>-<arrival>` |

| Field | Opened | Resolved |
|-------|--------|----------|
| exceptionId, carId | ✔ | ✔ |
| tripId, shipperId, yardId | ✔ | |
| type | missed_connection, train_cancelled, no_capacity, bad_order, dwell_exceeded | |
| severity, summary, detail | ✔ | |
| resolution, resolvedBy | | ✔ |

### Replanning saga events (stream `replan-<sagaId>`)

All produced by the replanner. Exceptions consumes ReplanStarted (cancellations), ReplanFailed and ReplanCompleted; the notifier consumes ReplanCompleted.

| Event | Fields (besides sagaId, carId, tripId) | Meaning |
|-------|----------------------------------------|---------|
| ReplanStarted | shipperId, trigger, fromPlanVersion, legSeq, yardId, missedRunId, readyAt, attempt, parentSagaId | One saga per (trip, plan version, leg, attempt) |
| TrainCapacityReserved | runId, trainId, departure | Seat booked on the next run with room (`run_reservations`) |
| TripPlanRevised | (see above) | The plan step |
| ReplanCompleted | shipperId, fromPlanVersion, toPlanVersion, chosenRunId, etaBefore, etaAfter, shiftMinutes, reasonText | ETA reply received |
| ReplanFailed | shipperId, reason, yardId | No train with capacity within 96 h → `no_capacity` exception |
| TrainCapacityReleased | runId, reason | Compensation: the seat given back |
| ReplanCompensated | reason, releasedRunId | The saga was undone (chosen train cancelled, or the plan moved under it); a child saga with attempt n+1 follows when needed |

### ShipperNotified (topic `shipper`, key shipper id, stream `shipper-<shipperId>`)

| | |
|-|-|
| Producer | notifier, when it flushes a shipper's batching window |
| Consumers | none locally (in production: the email/EDI/webhook gateway, idempotent on digestId) |
| Dedupe key | `sn:<digestId>` |

| Field | Notes |
|-------|-------|
| shipperId, digestId | |
| carIds | Only this shipper's cars |
| itemCount, suppressedCount | Car-level changes collapsed into this digest |
| channel, subject, lines | One line per car |

### ClockTicked (topic `train`, key `clock`, stream `clock`)

| | |
|-|-|
| Producer | eta process (`svc:clock`), when the event-time watermark (newest field event time) crosses a 2-hour boundary |
| Consumers | eta (recompute every non-final ETA) |
| Why an event | Time passing with no news is information: a car still in the yard at 19:00 is conditioned on having waited. Putting the tick in the log keeps the ETA a pure function of the log, so replay reproduces it |

| Field | Notes |
|-------|-------|
| at | Tick boundary (event time) |
| watermark | Newest field event time when emitted |
