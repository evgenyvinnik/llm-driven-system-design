# Railcar Health - Event Catalog

Every domain event in the system: who produces it, who consumes it, its key, its fields, its version history, and its ordering and retention rules. The schemas themselves are zod objects in `backend/src/events/catalog.ts`; this file is the readable version. [architecture.md](./architecture.md#event-driven-design) explains why the system is built this way.

## Three kinds of stream, one table

All events live in one append-only PostgreSQL table, `events`. Each event belongs to a stream, and the stream type decides what the event means.

| Stream type | Stream id | Role | Source of truth | Append rule |
|-------------|-----------|------|-----------------|-------------|
| `case` | `case-<uuid>` | **Event-sourced aggregate**: one alert (or random audit) and the yard's response to it | The events. `alerts`, `car_holds`, `work_orders`, `findings` and `notifications` are projections | Expected stream version (optimistic concurrency) |
| `car` | `car-<car id>` | **Event-sourced aggregate**: the car's component history (wheelset swaps) and stand-alone findings | The events. `component_installs` is a projection | Expected stream version |
| `pass` | `pass-<detector>/<pass id>` | **Outbox** for the raw-reading fact log | `detector_passes` and `axle_readings` rows | `no_stream` (a pass is written once) |
| `trip` | `trip-<trip id>` | **Outbox** for trips, consists and the analyzer's per-trip results | `trips`, `trip_units` and the analyzer's state tables | `any` (several independent writers) |
| `detector` | `detector-<id>` | **Small aggregate** for a detector's decided status | The events. `detector_health` is a projection | Expected stream version |

Raw detector readings are deliberately **not** an aggregate. A pass carries hundreds of readings, there are about 26M values a day at production scale, and no reading depends on an earlier one, so there is no invariant to protect and nothing to rebuild a state from. They stay in an append-only fact log. The events that announce them are small, and `AxleReadingsRecorded` is a claim check that names the rows instead of copying them.

## The envelope

Every event, whatever its type, has this envelope.

| Field | Meaning |
|-------|---------|
| `event_id` | UUID. Consumers deduplicate on it (`processed_events`) |
| `type` | Past-tense name, e.g. `AlertRaised` |
| `version` | Schema version the payload was written at. Readers upcast older versions to the latest one |
| `stream_id`, `stream_type` | The aggregate or outbox stream the event belongs to |
| `stream_version` | 1, 2, 3... within the stream. Unique per stream; the basis of optimistic concurrency |
| `global_position` | Position in the whole store. Assigned in commit order, so the relay never skips one |
| `family` | Broker stream (Kafka topic) the relay publishes it to |
| `partition_key` | Kafka message key: the unit whose events must stay in order |
| `occurred_at` | **Event time**: when it happened (a pass measured, a wheelset installed). Domain clock |
| `recorded_at` | **Processing time**: when the system learned it. Domain clock |
| `committed_at` | Wall clock at commit, for lag, events per second and staleness |
| `correlation_id` | The business flow, e.g. `pass:HBD-112/20261105T131754`, `finding:<tablet submission id>`, `consist:<trip>:<rev>` |
| `causation_id` | The event that directly caused this one (null for a root event such as `PassRecorded` or a person's command) |
| `actor` | A user name, a gateway, or a component (`analyzer`, `ack-process`, `notifier`, `workorder-sync`) |
| `tags` | `car:<id>`, `trip:<id>`, `case:<id>`, `detector:<id>`, for cross-stream timelines |
| `payload` | The event's fields, below |

## Producers, streams and consumers

```
 PRODUCERS                   EVENT STORE              BROKER STREAMS (Kafka topics)        CONSUMER GROUPS
                             (PostgreSQL `events`)
 gateways ─▶ ingest API ───▶ pass-*   ──┐            wayside.passes ──────────────────────▶ proj-detector-health
                                        │            wayside.readings.live ─┐
 transportation system ────▶ trip-*  ───┤            wayside.readings.backfill ┴──────────▶ analyzer (live first)
                                        │  relay     identity ────────────────────────────▶ analyzer, proj-car-history
 analyzer ─────────────────▶ trip-*,  ──┼──(tails ──▶trends ──────────────────────────────▶ proj-alert-queue
                             case-*,    │   by       trips.position ──────────────────────▶ ack-process, workorder-sync
                             detector-* │   global   detectors.health ────────────────────▶ proj-detector-health
 people (API commands) ────▶ case-*,  ──┤   position)cases ───────────────────────────────▶ notifier, workorder-sync, ack-process,
                             car-*      │                                                  proj-alert-queue, proj-reliability
 ack-process, notifier, ───▶ case-*,  ──┘            cars ────────────────────────────────▶ analyzer, workorder-sync,
 workorder-sync              car-*                                                         proj-alert-queue, proj-car-history,
                                                                                           proj-reliability
                                                     dlq ◀── any group, after bounded retries (redrive from the Ops page)
```

## Broker streams

Locally each family is one Valkey stream (`rh:ev:<family>`); in production each is a Kafka topic with the listed key.

| Stream (topic) | Events | Kafka key | Retention (production) | Consumer groups |
|----------------|--------|-----------|------------------------|-----------------|
| `wayside.passes` | PassRecorded | detector id | 7 days, delete | proj-detector-health |
| `wayside.readings.live` | AxleReadingsRecorded (lag ≤ 15 min) | trip id | 3 days, delete | analyzer |
| `wayside.readings.backfill` | AxleReadingsRecorded (lag > 15 min) | trip id | 3 days, delete | analyzer |
| `identity` | ConsistVersionChanged, CarIdentified, IdentityQuarantined | trip id | 30 days, delete | analyzer, proj-car-history |
| `trends` | BearingTrendUpdated | trip id | 7 days, delete | proj-alert-queue |
| `trips.position` | TripPositionUpdated, TripArrived | trip id | compacted (latest position per trip) | ack-process, workorder-sync |
| `detectors.health` | DetectorHealthChanged | detector id | compacted (latest status per detector) | proj-detector-health |
| `cases` | every case event | case id | forever (it is the aggregate's history; tiered storage) | notifier, workorder-sync, ack-process, proj-alert-queue, proj-reliability |
| `cars` | ComponentReplaced, InspectionFindingRecorded (routine, teardown) | car id | forever | analyzer, workorder-sync, proj-alert-queue, proj-car-history, proj-reliability |
| `dlq` | any event a group gave up on, with the error | - | until redriven | (operators) |

The event store keeps everything forever locally. In production, `pass` and `trip` outbox rows are pruned once relayed and older than the topic retention: their source of truth is the fact log and the state tables. `case`, `car` and `detector` streams are never pruned, because they are the source of truth.

## Ordering guarantees

- **Per stream, total order.** `stream_version` is gap-free and unique; an append with a stale expected version fails.
- **Per broker stream, the relay preserves global-position order.** Locally one Valkey stream per family is totally ordered. In Kafka the guarantee is per partition, i.e. per key: all events of one trip (live path), one car (component history) or one case are in order.
- **No order across families.** A projection that reads two families (alert-queue reads `cases` and `trends`) makes those updates commutative: trend telemetry goes to its own table as last-writer-wins by global position.
- **Readings are order-independent by design.** The analyzer recomputes a bearing's features from all its observations in event time and takes the maximum tier over event-time prefixes, so a late or out-of-order pass gives the in-order decision.

## Consumer groups

| Group | Kind | Reads | Writes | Idempotency |
|-------|------|-------|--------|-------------|
| `analyzer` | decision | readings (live, backfill), identity, cars | trip, case and detector streams; trend state tables | processed_events; passes also carry `processed_at` |
| `notifier` | integration | cases | NotificationDelivered | processed_events; provider call idempotent on notificationId |
| `workorder-sync` | integration | cases, cars, trips.position | ComponentReplaced, CaseClosed, CarHoldReleased, audit cases; `mro_tickets` | processed_events; audit case id derived from the trip id |
| `ack-process` | process manager | cases, trips.position | AckDeadlineMissed, ApproachingYardWarned, AlertHandedOff, CarHoldMoved, NotificationRequested; `ack_timers` | processed_events; timers claimed with SKIP LOCKED; expected versions |
| `proj-alert-queue` | projection | cases, cars, trends | alerts, car_holds, work_orders, findings, notifications, bearing_trends_latest | processed_events; rebuildable |
| `proj-car-history` | projection | cars, identity | component_installs, car_trips | processed_events; rebuildable |
| `proj-detector-health` | projection | wayside.passes, detectors.health | detector_health | processed_events; rebuildable |
| `proj-reliability` | projection | cases, cars | reliability_facts | processed_events; rebuildable |

---

## Ingest and raw facts

### PassRecorded (v1)

A train passed a detector and the pass header was stored in the fact log.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| Ingest API, in the same transaction as the `detector_passes` row | proj-detector-health | `pass-<detector>/<pass>`, family `wayside.passes` | detector id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| detectorId, passId | string | The detector-assigned idempotency key of the pass |
| tripId, gatewayId, direction | string | |
| passedAt | ISO time | Event time (also `occurred_at`) |
| receivedAt, lagSeconds | ISO time, int | Processing time and how late the pass arrived |
| lane | live / backfill | Chosen at ingest: lag over 15 minutes goes to backfill |
| speedMph, ambientF, axleCount | number | |
| aeiRead, edgeAlarmCount | boolean, int | Whether the site read AEI tags; how many alarms the detector itself raised |

### AxleReadingsRecorded (v1)

The pass's per-axle readings were stored. A claim check: it names the fact-log rows instead of carrying ~700 readings. Caused by `PassRecorded`, same correlation.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| Ingest API | analyzer | `pass-<detector>/<pass>`, family `wayside.readings.live` or `.backfill` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| detectorId, passId, tripId, lane, axleCount | | As in PassRecorded |
| readingCount, payloadSha | int, string | The hash detects a retry with the same key but different readings |
| claimCheck | { store, detectorId, passId } | Where the readings are: `axle_readings` keyed by (detector, pass) |
| maxBearingF, maxWheelF | number | For timelines and quick triage |

## Identity

### ConsistVersionChanged (v1)

A consist revision took effect: departure, or a train rebuilt at a yard (cars set out or picked up).

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| Ingest API (transportation feed), with the `trip_units` rows | analyzer (releases quarantined passes) | `trip-<id>`, family `identity` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, symbol, direction, originYardId, destinationYardId, stops, departedAt | | |
| revision, effectiveAt | int, ISO time | A pass is resolved against the revision in force at its event time |
| units[] | position, unitId, unitType, axleCount, leadingEnd | The whole consist, so identity can be re-derived from events alone |
| setOut[], pickedUp[] | car ids | Difference from the previous revision |

### CarIdentified (v1)

A car was placed and oriented in a trip: once per car per consist revision, and again when an AEI read corrects it.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| analyzer | proj-car-history | `trip-<id>`, family `identity` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, revision, carId, position | | |
| leadingEnd | A / B | Which end faces the head of the train |
| source | consist / aei | How it was learned |
| detectorId, passId | string | The pass that resolved or corrected it |
| correctedFrom | { unitId, leadingEnd } or null | What the consist said before an AEI read overrode it (a car turned on a wye) |

### IdentityQuarantined (v1)

A pass could not be mapped to cars and is held rather than guessed. Released when `ConsistVersionChanged` arrives.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| analyzer | (timelines; operators) | `trip-<id>`, family `identity` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, detectorId, passId | string | |
| reason | awaiting_consist / axle_count_mismatch | No consist yet, or the detector's axle count disagrees and there is no AEI read |
| detectedAxles, expectedAxles | int, int or null | |

## Trends, trips and detectors

### BearingTrendUpdated (v1)

A bearing's trend features changed with a new observation. Telemetry, not a decision: the case stream records decisions only. Also emitted (with `previousComponent: true`) when a notable reading predates the wheelset now on its axle, so the car's timeline shows it was kept as history.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| analyzer | proj-alert-queue (`bearing_trends_latest`, last-writer-wins by position) | `trip-<id>`, family `trends` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, carId, position | string | Car-relative bearing, e.g. R3 |
| detectorId, passId, passedAt | | The pass that changed the trend; `occurred_at` = its event time |
| tier | 0-4 | Rule tier at this point (max over event-time prefixes) |
| excludedPreInstall | int | Readings set aside as the previous wheelset's history |
| features | object | sideDelta, medianSideDelta, maxSideDelta, risePer15mi, aboveAmbient, observations, coverage gap... |

### TripPositionUpdated (v1)

The train's newest position by event time, its territory and next yard. Latest-state: compacted in Kafka.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| analyzer, when a pass is newer (event time) than the last one | ack-process (handoffs, hold moves, approach timers) | `trip-<id>`, family `trips.position` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, symbol, status | | |
| detectorId, milepost, passedAt | | The newest pass by measurement time, not by arrival |
| territoryId, deskId | string, string or null | Whose dispatcher territory the train is in |
| nextYardId, nextYardEta | string or null, ISO time or null | Dead-reckoned |

### TripArrived (v1)

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| Ingest API (trip events), with the `trips` update | workorder-sync (opens the random audit case) | `trip-<id>`, family `trips.position` | trip id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, symbol, yardId, arrivedAt | | `occurred_at` = arrivedAt |

### DetectorHealthChanged (v1)

A detector became ok, offline, silent or biased. Latest-state: compacted in Kafka.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| analyzer health job, expected version = the detector stream's | proj-detector-health | `detector-<id>`, family `detectors.health` | detector id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| detectorId, from, to | | ok / offline / silent / biased |
| reason | string or null | e.g. "Reads 20°F low vs neighbouring detectors on the same trains" |
| biasOffsetF, missedPasses, lastHeardAt | | The evidence |

## The case aggregate

All case events share stream `case-<uuid>`, family `cases`, key = case id, and carry `caseId`. They are tagged with the car, the trip and the case. Appends carry the expected stream version.

### AlertRaised (v1)

A risk alert was opened for a bearing, or for a car's brakes: the case begins. At most one open alert case per bearing per trip (`case_index`).

| Producer | Consumers | Versions |
|----------|-----------|----------|
| analyzer | ack-process (timer), proj-alert-queue, proj-reliability | v1 |

| Field | Type | Notes |
|-------|------|-------|
| tripId, symbol, carId, ownerMark | | ownerMark: the lessor or shipper who owns the car |
| kind | hot_bearing / hot_wheel / cold_wheel | Bearing failure vs stuck brake vs inoperative brake |
| position | string | R3, or CAR for brake alerts |
| tier, action | int, string | e.g. 2, inspect_next_terminal |
| routing, deskId, territoryId, yardId | | Where the train is now and which yard must catch the car |
| owner | { role: dispatcher / yard / owner, id } | Who must acknowledge |
| ackDueAt | ISO time or null | Tier deadline (illustrative: 5 / 15 / 60 min) |
| reasons, features, routeNote | | Why, in words a dispatcher can repeat |
| trigger | { detectorId, passId, passedAt, lagSeconds } | The pass behind the decision |
| late | boolean | Computed from data more than 15 minutes old |

### AlertEscalated (v1)

New evidence raised the tier in place. Tiers never go down. May change the owner (a yard MEDIUM becomes a dispatcher HIGH) and reopen an acknowledged case.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| analyzer | ack-process, proj-alert-queue, proj-reliability | v1 |

Fields: fromTier, toTier, action, routing, deskId, territoryId, yardId, owner, ackDueAt, reasons, features, routeNote, trigger, late, reopened (boolean).

### AlertHandedOff (v1)

Ownership moved because the train crossed into another desk's territory, or a held car went past its yard. The new owner must acknowledge again.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| ack-process (on TripPositionUpdated) | ack-process, proj-alert-queue, proj-reliability | v1 |

Fields: from (owner), to (owner), reason (desk_territory / passed_yard), ackDueAt, note.

### CarHoldMoved (v1)

The car went past its yard uninspected: the hold and work order move to the next yard on the route.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| ack-process | proj-alert-queue | v1 |

Fields: holdId, carId, fromYardId, toYardId, workOrderId, note.

### AlertAcknowledged (v1)

The owner acknowledged: a person now owns it. From the console (with the case version the person saw) or by starting the inspection.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| API command (dispatcher or yard) | ack-process (cancels the timer), proj-alert-queue, proj-reliability | v1 |

Fields: by, action (stop_ordered, setout_planned, ...), note, tier (what was acknowledged), via (console / inspection_started). `causation_id` is the newest case event the person had seen.

### AckDeadlineMissed (v1)

Nobody acknowledged in time: escalated to the next role in the chain (desk, chief dispatcher, operations center; or yard inspectors, general foreman, operations center), with a fresh deadline.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| ack-process, when a durable timer fires | ack-process (next timer), proj-alert-queue, proj-reliability | v1 |

Fields: ownerRole, ownerId, fromLevel, toLevel, escalatedTo, nextAckDueAt, note.

### ApproachingYardWarned (v1)

Delivered, unacknowledged, and the train is within the approach window (30 min, illustrative) of the yard that must catch the car.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| ack-process (approach timer) | proj-alert-queue | v1 |

Fields: yardId, etaAt, toLevel, note.

### NotificationRequested (v1)

Someone must be told: a desk, a yard, the car owner, the reliability desk, a supervisor or the operations center. Requested once per (channel, target, kind) per case.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| analyzer, ack-process | notifier, proj-alert-queue | v1 |

Fields: notificationId, channel, target, kind (opened, escalated:HIGH, handoff, ack_overdue:1, ...), message.

### NotificationDelivered (v1)

The provider accepted the message. Delivered is not acknowledged. Appended with expected version `any`: an external fact that does not depend on the case's state.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| notifier | ack-process (escalation waits for delivery), proj-alert-queue | v1 |

Fields: notificationId, channel, target, provider.

### CarHoldPlaced (v1)

The car may not be built into an outbound train until inspected (MEDIUM and above). Also re-placed, bad-ordered, when a second tablet reports a defect after a "no defect".

| Producer | Consumers | Versions |
|----------|-----------|----------|
| analyzer; API (superseding finding) | proj-alert-queue | v1 |

Fields: holdId, carId, yardId, reason, status (active / bad_ordered). The outbound-build check reads the write-side `case_index`, never this projection.

### CarHoldReleased (v1)

| Producer | Consumers | Versions |
|----------|-----------|----------|
| API (release or repair), workorder-sync (repair recorded), analyzer (evidence superseded) | proj-alert-queue | v1 |

Fields: holdId, carId, yardId, by, reason (released / repaired / component_replaced / identity_corrected).

### WorkOrderOpened (v1)

An inspection task at a yard: for an alert case, or the first event of a random audit case.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| analyzer (alert), workorder-sync (audit, on TripArrived) | workorder-sync (yard maintenance ticket), proj-alert-queue, proj-reliability | v1 |

Fields: workOrderId, caseType (alert / audit), tripId, carId, position (ALL for audits), kind, yardId, priority (tier; 0 for audits).

### WorkOrderStarted (v1)

| Producer | Consumers | Versions |
|----------|-----------|----------|
| API (yard inspector) | ack-process, proj-alert-queue | v1 |

Fields: workOrderId, by.

### InspectionFindingRecorded (v2)

What the inspector, or a bearing shop, found: the label behind precision and recall. On a case stream for alert and audit inspections; on a car stream for routine inspections and teardowns.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| API (yard tablet); seed history | workorder-sync (repair → ComponentReplaced), ack-process, proj-alert-queue, proj-reliability | **v1 → v2** |

| Field | Type | Notes |
|-------|------|-------|
| caseId, workOrderId | uuid or null | Null for a routine or teardown finding (car stream) |
| findingId, clientSubmissionId | uuid, string | The tablet's id makes a resend a replay |
| carId, position | string | |
| finding | confirmed_bearing_defect / brake_defect / wheel_defect / no_defect_found | |
| disposition | bad_order / release / repaired | A defect can't be released |
| notes, recordedBy, observedAt | | observedAt is the tablet's clock (it may have been offline) |
| replacement | { componentId, installedAt, axle } or null | A repair on the spot |
| **source** (v2) | alert / audit / routine / teardown | v1 implied it |
| **supersedesFindingId** (v2) | uuid or null | A more severe finding from a second tablet |

**Version history.** v1 had `alertId` and no `source`: an alert id meant the inspection came from an alert, otherwise from a random audit. Routine inspections and bearing-shop teardowns could not be expressed. v2 drops `alertId` (the case id is enough), adds `source` and `supersedesFindingId`. The upcaster (`events/envelope.ts`) maps v1 to v2 as `source = alertId ? 'alert' : 'audit'`, `supersedesFindingId = null`. The seeded findings older than 30 days are stored as v1, so the upcaster runs on every replay and the timeline shows "v1→v2".

### CaseClosed (v1)

The case ended. A closed case takes no new decisions; a new alert for the same bearing opens a new case.

| Producer | Consumers | Versions |
|----------|-----------|----------|
| API (release, repair on the spot), workorder-sync (repair recorded later), analyzer (evidence superseded) | workorder-sync (closes the ticket), ack-process, proj-alert-queue, proj-reliability | v1 |

Fields: outcome, reason (released / repaired / component_replaced / identity_corrected / audit_complete), note, closedBy.

## The car aggregate

### ComponentReplaced (v1)

A wheelset was changed out on an axle. `occurred_at` is when it went on the car; `recorded_at` when the system was told, which can be hours later.

| Producer | Consumers | Stream | Key | Versions |
|----------|-----------|--------|-----|----------|
| API (repair track); workorder-sync (from a repair finding) | analyzer (re-decides the car's open trips), workorder-sync (closes inspected cases on that axle), proj-car-history | `car-<id>`, family `cars` | car id | v1 |

| Field | Type | Notes |
|-------|------|-------|
| carId, axle | string, int | Axle 1 is at the car's B-end |
| removedComponentId, installedComponentId | string or null, string | |
| installedAt | ISO time | Readings measured before it are history of the old wheelset, never evidence against the new one |
| recordedBy, findingId, caseId, clientSubmissionId | | Lineage and idempotency |

Stand-alone findings (`InspectionFindingRecorded` v2 with source routine or teardown) are also appended to the car stream.

---

## Schema evolution rules

1. **Add, don't change.** A new optional field, or a new version with an upcaster. Never rename or retype a field in place.
2. **Producers write only the latest version.** Rows already in the store are never rewritten (the table refuses UPDATE and DELETE).
3. **Readers upcast, then validate.** Every consumer and every replay upcasts step by step to the latest version and validates with that version's zod schema. A consumer only ever sees one shape.
4. **Deploy consumers before producers.** A consumer that receives a version newer than it knows treats it as a permanent error: the message goes to the dead-letter stream, the group keeps moving, and it is redriven once the new consumer is deployed.
5. **Broker messages carry the stored version.** Kafka consumers in other teams would use a schema registry with backward-compatible evolution and the same upcast-on-read rule.

## Replay

`npm run replay -- <alert-queue|car-history|detector-health|reliability|all>` rebuilds a projection from position 0 into shadow tables with the same apply code the live projector uses, up to the live group's checkpoints, and compares row by row. `npm run replay -- swap-case` re-derives the "late reading after a wheelset swap" decision from the trip's and cars' events alone, in recorded order and with the install recorded last, and checks both against what the live system decided.
