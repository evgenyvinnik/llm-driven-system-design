# Track Hazard Detection - Event Catalog

Every event in the system, who produces it, who consumes it, how it is keyed and versioned, and what ordering and retention apply. The design behind the events is in [architecture.md](./architecture.md).

## Flow

```
 EDGE (per track segment)                 CLOUD
┌────────────────────────┐
│ sensors ─▶ gateway     │ store-and-forward, seq numbers, critical first
│ (geophones, fences,    │──────────────┐
│  cameras, rail temp,   │              ▼
│  water level)          │      ┌──────────────┐  inbox + outbox    ┌────────────────────────────┐
└────────────────────────┘      │  Ingest API  │───(one txn)───────▶│ PostgreSQL                  │
┌────────────────────────┐      └──────────────┘                    │ edge_events · events · outbox│
│ PTC / dispatch feed    │─────────────▲                            └──────────────┬─────────────┘
└────────────────────────┘                                                         │ outbox relay
                                                                                   │ (critical → domain → trains → bulk)
              ┌──────────────────────────┬──────────────────────┬──────────────────┴─────┐
              ▼                          ▼                      ▼                        ▼
     th:edge.critical:0..3      th:edge.bulk:0..3        th:trains:0..3           th:domain:0..3
     key = track segment        key = track segment      key = train id           key = track segment
              │                          │                 │      │      │          │     │      │
              └────────────┬─────────────┘                 │      │      │          │     │      │
                           ▼                               ▼      ▼      ▼          ▼     ▼      ▼
                    ┌─────────────┐◀── trains ─────────────┘  alerting projector  alerting projector notifier
                    │ correlator  │                                 (PM)            (PM)
                    │ (CEP)       │── hazard + coverage events ──▶ events + outbox ──▶ th:domain
                    └─────────────┘
     dead letters from any group ──▶ th:dlq ──(ops redrive)──▶ original partition
```

## Conventions

**Envelope.** Every event carries `eventId` (UUID), `type` (past tense), `version` (schema version), `occurredAt` (event time), `recordedAt` (processing time), `streamId` and `streamVersion`, `partitionKey`, `correlationId`, `causationId`, `source` and `meta` (lane, late flag, sensor, segment, actor, command id). See `backend/src/shared/events/envelope.ts`.

| Field | Edge events | Domain events |
|-------|-------------|---------------|
| `streamId` | `gw-<gateway id>` (or `gw-PTC`) | `hazard-<uuid>`, `sensor-<id>`, `gateway-<id>` |
| `streamVersion` | the gateway's sequence number | per-stream version; UNIQUE (stream, version) is the optimistic-concurrency check |
| `partitionKey` | track segment (`CAN-5`); train id for positions | the hazard's track segment |
| `correlationId` | the event's own id | the edge event that started the chain |
| `causationId` | null | the event that directly caused this one |

**Two logs.** The edge inbox (`edge_events`) is the integration log for everything gateways report. The event store (`events`) is the source of truth for hazards and coverage. Both reach the streams only through the outbox.

**Streams.** Valkey streams stand in for Kafka topics, four partitions each. Partition = FNV-1a(partition key) mod 4.

| Topic | Kafka equivalent | Producer | Consumer groups | Retention (local / production) |
|-------|------------------|----------|-----------------|------------------------------|
| `th:edge.critical:0..3` | `edge.critical`, 4 partitions | outbox relay (ingest) | correlator | MAXLEN ~200k / 7 days |
| `th:edge.bulk:0..3` | `edge.bulk`, 4 partitions | outbox relay (ingest) | correlator | MAXLEN ~200k / 7 days |
| `th:trains:0..3` | `trains`, keyed by train | outbox relay (ingest) | correlator, alerting, projector | MAXLEN ~200k / 3 days, or compacted by train id for "latest position" |
| `th:domain:0..3` | `hazard-events`, keyed by segment | outbox relay (event store) | alerting, projector, notifier | MAXLEN ~200k / 30 days; the event store keeps everything |
| `th:dlq` | `dead-letters` | any consumer group | ops (redrive, discard) | until resolved |

**Ordering.** Guaranteed per partition key: every event for one track segment is consumed in order within a lane. Nothing is guaranteed across lanes, partitions or gateways. The correlator does not need ordering (correlation is a function of the evidence set in event time). The process manager and projections need per-hazard order, which the hazard's segment key gives them; projections also skip any event whose stream version they have already applied.

**Late events.** An event is late if it occurred before its segment's watermark when the correlator processes it. Late events are processed, never dropped: they can create, upgrade or downgrade a hazard, and they carry `late: true` into the hazard events and the UI.

**Idempotency per consumer.**

| Consumer | Idempotency key | Where |
|----------|-----------------|-------|
| Ingest | (gateway, seq) and event id | `edge_events` unique constraints |
| Correlator | event id | `processed_events (consumer='correlator')`, same transaction as its effects |
| Alerting | event id, plus state-based decisions (level-triggered) | `processed_events (consumer='alerting')` |
| Projector | (projection, stream) last applied version | `projection_versions` |
| Notifier | event id + channel + recipient | `notifications.idempotency_key` |
| API commands | client command id | `command_log` |

---

## Edge events

Produced by edge gateways (one per track segment) and by the PTC train-position feed. Gateways aggregate at the edge: they send one reading per sensor per window, never raw samples.

### SensorReadingReported

| | |
|-|-|
| Producer | Edge gateway |
| Consumers | Correlator (vibration spikes become evidence; rail temperature feeds the heat trend; any reading proves the sensor is alive) |
| Key | Track segment of the sensor |
| Lane | Critical if a vibration peak is at or above the spike threshold (12 mm/s); otherwise bulk |
| Versions | v1 |
| Ordering / retention | Per segment; rail-temperature samples are stored by (sensor, event time), so late samples join the series in the right place |

| Field | Type | Notes |
|-------|------|-------|
| sensorId | string | `GEO-147.9`, `RTS-205.0` |
| kind | `vibration` \| `rail_temp` | |
| windowSec | number | Edge aggregation window (10 s geophones, 30 s rail temperature) |
| peakMmS, rmsMmS | number? | Geophone peak and RMS particle velocity |
| tempF | number? | Rail temperature |

### CameraDetectionReported

| | |
|-|-|
| Producer | Edge gateway (the edge vision model runs on the camera or gateway) |
| Consumers | Correlator |
| Key | Track segment |
| Lane | Critical unless the class is `clear` |
| Versions | **v1** (Canyon gateways, older firmware), **v2** (Prairie gateways); v3 is unknown and dead-lettered |
| Ordering / retention | Per segment. Images stay in object storage; only `imageRef` travels |

| Field | Type | Version | Notes |
|-------|------|---------|-------|
| sensorId | string | v1 | `CAM-241.3` |
| detectionClass | `vehicle` \| `debris` \| `person` \| `animal` \| `clear` | v1 | |
| confidence | 0..1 | v1 | Model confidence |
| imageRef | string | v1 | Object-storage key of the frame |
| bbox | {x, y, w, h} \| null | **v2** | Normalised bounding box |
| modelVersion | string | **v2** | Edge model build |

**Version history and compatibility.** v2 added `bbox` and `modelVersion`. The upcaster `CameraDetectionReported@1` lifts v1 to v2 with `bbox: null` and `modelVersion: "edge-v1 (unreported)"`. Consumers always see v2. Unknown extra fields are ignored (tolerant reader), so a v2 producer adding an optional field does not break a v2 consumer. A version newer than any upcaster (v3) is a PermanentError: dead-lettered, then redriven once the cloud ships support. Stored events are never rewritten; upcasting happens on read, including replay.

### SlideFenceTripped

| | |
|-|-|
| Producer | Edge gateway |
| Consumers | Correlator |
| Key | Track segment |
| Lane | Always critical |
| Versions | v1 |
| Ordering / retention | Per segment. A second wire on the same fence is extra evidence from the same sensor and does not raise confidence |

| Field | Type | Notes |
|-------|------|-------|
| sensorId | string | `FNC-147.8` |
| wire | int | Which wire broke |
| interlockSignalDropped | boolean | The edge interlock already put the protecting signal to red. Informational: the cloud never controls signals |
| signalId | string | The signal the interlock dropped |

### WaterLevelReported

| | |
|-|-|
| Producer | Edge gateway |
| Consumers | Correlator |
| Key | Track segment |
| Lane | Critical when 24 in or less below the rail; otherwise bulk |
| Versions | v1 |

| Field | Type | Notes |
|-------|------|-------|
| sensorId | string | `WTR-171.2` |
| inchesBelowRail | number | Water surface below the base of rail |
| risingInPerHr | number | Edge-computed trend |

### SensorHeartbeatMissed

| | |
|-|-|
| Producer | Edge gateway (it notices a sensor that missed three reporting intervals) |
| Consumers | Correlator (marks the sensor's coverage degraded) |
| Key | Track segment |
| Lane | Bulk |
| Versions | v1 |
| Ordering | A late "missed" report for a sensor that has reported since is ignored |

| Field | Type | Notes |
|-------|------|-------|
| sensorId | string | |
| lastSeenAt | ISO time | Last reading the gateway received |
| missedIntervals | int | |

### TrainPositionReported

| | |
|-|-|
| Producer | PTC / dispatch feed (source `PTC`) |
| Consumers | Correlator (explains vibration spikes, retroactively for late reports), alerting (warns trains newly approaching a CRITICAL hazard), projector (strip map) |
| Key | Train id |
| Lane | `trains` topic |
| Versions | v1 |
| Ordering / retention | Per train. Also stored as reference data in `train_positions` at ingest, so "where was this train at time t" works whatever order the correlator sees events in |

| Field | Type | Notes |
|-------|------|-------|
| trainId, symbol | string | |
| subdivisionId | string | |
| milepost | number | |
| direction | `increasing` \| `decreasing` | Milepost direction |
| speedMph | number | |

---

## Domain events (event store)

All are v1. Hazard events are on `hazard-<uuid>` streams, keyed by the hazard's track segment; coverage events on `sensor-<id>` and `gateway-<id>` streams. The event store is append-only (a trigger refuses UPDATE and DELETE).

### Correlator events

| Event | Stream | Consumers | Key fields | Notes |
|-------|--------|-----------|------------|-------|
| **HazardDetected** | hazard | alerting, projector | hazardId, code, kind, subdivisionId, segmentId, mpFrom, mpTo, confidence, severity, detectionStatus, evidence[], late, trigger {eventId, occurredAt, recordedAt, lane, late} | Opens a hazard stream. One per hazard however many sensors saw it |
| **HazardEvidenceAdded** | hazard | alerting, projector | evidence {eventId, sensorId, kind, milepost, occurredAt, confidence, late}, confidence, mpFrom, mpTo | Only when the new evidence changes confidence or the span; pure corroboration is stored without an event |
| **HazardUpgraded** | hazard | alerting, projector | fromSeverity, toSeverity, fromStatus, toStatus, confidence, reason, late | Late evidence can upgrade |
| **HazardDowngraded** | hazard | alerting, projector | same, plus removedEvidence[] | A late train position explained the spikes. Never closes the hazard |
| **HazardRiskElevated** | hazard | alerting, projector | band (`elevated` \| `critical`), severity, sensorId, railTempF, neutralTempF, projectedTempF, slopeFPerMin, trigger | Opens (or raises) a rail-buckling risk for one segment |
| **HazardRiskSubsided** | hazard | alerting, projector | railTempF, projectedTempF | The process manager then lifts the standing heat order and clears the hazard |
| **CoverageDegraded** | sensor / gateway | projector | scope, targetId, subdivisionId, segmentId, mpFrom, mpTo, reason (`heartbeat_missed` \| `gateway_silent`), since | Operators see the blind spot on the strip map |
| **CoverageRestored** | sensor / gateway | projector | scope, targetId, subdivisionId, segmentId, restoredAt | |

### Process-manager events (alerting)

| Event | Consumers | Key fields | Notes |
|-------|-----------|------------|-------|
| **AlertIssued** | projector, notifier | alertId, severity, deskId, assignee, ackDeadlineAt, summary, lane, late, timing {edgeOccurredAt, ingestedAt, detectedAt} | Routed to the dispatcher whose desk owns the subdivision. A durable timer is written in the same transaction |
| **AlertEscalated** | projector, notifier | level, reason (`ack_overdue` \| `severity_raised`), target, severity, ackDeadlineAt | Deadline missed: next level of the chain. Worse severity: same level, fresh acknowledgment required |
| **TrainsWarned** | projector, notifier | trains[] {trainId, symbol, etaMinutes, distanceMiles, direction} nearest first, instruction, automatic, by | Automatic for CRITICAL hazards; manual from the API otherwise |
| **TrainsReleased** | projector, notifier | trainIds[], reason, by | Compensation when the hazard closes |
| **SpeedRestrictionIssued** | projector | restrictionId, subdivisionId, mpFrom, mpTo, maxSpeedMph, reason, automatic, by | Automatic for heat risk (standing heat order); manual from the API otherwise |
| **SpeedRestrictionLifted** | projector | restrictionId, reason, by | Compensation when the hazard closes, or manual |

### Command events (API)

| Event | Who | Key fields | Rules checked on the folded stream |
|-------|-----|------------|------------------------------------|
| **AlertAcknowledged** | Territory dispatcher, admin | alertId, by, note | An alert exists and is unacknowledged (otherwise a no-op) |
| **SpeedRestrictionIssued** | Dispatcher | (as above, `automatic: false`) | Limits within the subdivision |
| **TrainsWarned** | Dispatcher | (as above, `automatic: false`) | At least one approaching train not yet warned |
| **InspectorDispatched** | Dispatcher | inspector, inspectorName, etaMinutes, note | Inspector exists |
| **HazardCleared** | Dispatcher, the dispatched inspector | by, note | Hazard open; refused (409) if new evidence arrived after the version the person saw |
| **HazardConfirmedFalseAlarm** | Dispatcher, the dispatched inspector | by, note, cause | Same |
| **SpeedRestrictionLifted** | Dispatcher | restrictionId, reason, by | Restriction active |

## Lifecycle of one hazard stream

```
HazardDetected ─▶ AlertIssued ─┬─▶ TrainsWarned (CRITICAL, nearest first)
   (correlator)    (PM)        │
                               ├─▶ AlertEscalated (deadline, durable timer) ─▶ ... level 2
HazardEvidenceAdded/Upgraded ──┤
HazardDowngraded (late PTC) ───┤
                               ├─▶ AlertAcknowledged (dispatcher)
                               ├─▶ SpeedRestrictionIssued / TrainsWarned / InspectorDispatched
                               └─▶ HazardCleared | HazardConfirmedFalseAlarm
                                        └─▶ SpeedRestrictionLifted, TrainsReleased (PM compensation)
```
