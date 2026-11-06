# Track Hazard Detection - Architecture

## System Overview

A railroad sensor monitoring and incident detection platform for the **track and right-of-way**. Edge gateways beside the track collect camera, vibration (geophone), slide-fence, rail-temperature and water-level data and forward it over links that drop out. The platform correlates those signals into hazards (rockfall, an obstruction at a crossing, high water, rail-buckling risk from heat), alerts the dispatcher who owns the territory within seconds, warns approaching trains, tracks speed restrictions and inspector dispatch, and keeps the whole incident as an auditable event stream.

This is an **event-driven** system. Gateways report facts as events; the cloud records them, derives new facts (a hazard was detected, an alert was issued, a train was warned) as further events, and builds every screen from those events.

It is distinct from [`railcar-health/`](../railcar-health/), which monitors railcars (their bearings and brakes) from wayside detectors as trains pass. This project monitors the **track itself**: whether the rail, the ground beside it and the crossings are safe for the next train.

**The safety boundary.** A slide fence whose wire breaks drops the protecting signal to red through a local interlock in the field. That works with the cloud down, the link down, or this whole platform gone. Grade-crossing warning devices work the same way. The platform does not sit in that path and never controls signals. What it adds is everything a single field device can't do: correlate many weak signals into one confident hazard, catch hazards that have no interlock (a vehicle stuck on a crossing seen by a camera, a rising river, rail heating in the afternoon sun), route them to the right person with a deadline, warn trains that are approaching, and keep the record.

Learning goals:

- Treat edge data as an at-least-once, out-of-order, sometimes hours-late event stream, and still produce exactly one hazard per real-world problem.
- Use event time, windows and watermarks for correlation, and let late events upgrade or downgrade an earlier decision.
- Keep a priority lane so a reconnecting gateway's backlog never delays a new critical event.
- Build the response as a process manager with durable timers and compensation, and every screen as a projection that can be rebuilt from the event log.

### Public context (cited, not verified here)

| Source | What it says |
|--------|--------------|
| BNSF FY2025 10-K | 32,500+ route miles in 28 states |
| BNSF, "Eyes on AI" | AI processes 35M+ wayside readings a day; machine vision handles 2M+ images a day |
| Candidate report (Reddit, BNSF Senior/Staff Infrastructure Engineer loop, not verified) | The prompt: ingest camera, vibration and temperature data, identify track hazards, alert personnel, operator dashboard; intermittent connectivity; critical alerts within seconds |

Every other number in this document (sensor counts, thresholds, deadlines, rates) is an **illustrative assumption**. Rail-temperature bands and slow-order speeds are configurable illustrations, not any railroad's standard.

## Requirements

### Functional Requirements

1. **Ingest** events from edge gateways (one per track segment) and from the train-position (PTC/dispatch) feed. Delivery is at-least-once, batched, out of order, and sometimes hours late after an outage.
2. **Detect hazards** by correlating events in time and space: a camera obstruction plus a vibration spike within 30 s and 0.5 mi is a confirmed hazard; many sensors seeing one rockfall yield one hazard. Explain vibration caused by passing trains. Trend rail temperature into a buckling-risk band.
3. **Alert** the dispatcher who owns the territory, with an acknowledgment deadline and an escalation chain.
4. **Respond**: warn approaching trains (nearest first), issue speed restrictions (slow orders) on a milepost range, dispatch an inspector, and close the hazard as cleared or a false alarm. Closing lifts restrictions and releases trains.
5. **Coverage**: a sensor that misses heartbeats, or a gateway that goes silent, marks its stretch of track as degraded so operators know where they are blind.
6. **Operator dashboard**: a live strip map of each subdivision with hazards, sensors, coverage gaps, slow orders and trains; hazard detail with the event timeline and correlation evidence; the alert queue; the restriction list; the latency budget; and an operations view of streams, consumer lag, dead letters and replay.

### Non-Functional Requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Safety path independence | Field interlocks and crossing devices work with the cloud down | The cloud mirrors interlock trips, never gates them |
| Detection → alert latency | p99 < 5 s for live data; critical-lane cloud processing p99 < 1 s | A priority lane at every hop; no batch windows on the critical path |
| Backlog isolation | A 2-hour reconnect backlog adds < 1 s to a new critical event elsewhere | Separate critical and bulk topics; consumers drain critical first |
| Correctness under retries | Zero duplicate hazards, alerts, pages or slow orders | Idempotency at every write; dedup keys per consumer |
| Late data | Events up to 72 h late are processed and can change a hazard | Event-time logic, order-independent correlation |
| Availability | 99.95% for ingest and alerting, 99.9% for dashboards | Stateless API, replayable streams, standby relay and timer leader |
| Auditability | Every hazard's full history reconstructable | Event-sourced hazards; append-only store |
| Retention | Domain events forever; raw edge events 90 days hot, 7 years cold | Tiered storage |

## Capacity Estimation

### Production Scale (illustrative)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Instrumented territory | ~6,000 route miles | Hazard-prone share of a 32,500-mile network (mountain passes, river valleys, heat corridors); assumption |
| Sensors | ~12,000 | 600 rail-temperature, 2,500 geophones, 1,500 slide-fence sections, 5,000 crossing cameras, 2,000 water-level sensors |
| Gateways | ~1,200 | One per ~5 mi of instrumented track |
| Edge events | ~300/s average, ~25M/day | Geophone aggregates every 10 s (250/s), cameras 1/30 s heartbeat (170/s minus idle suppression), rail temp 1/min, water 1/5 min |
| Critical-lane events | ~2-5/s | Mostly vibration spikes from passing trains (explained and discarded), plus a few real detections per hour |
| Reconnect storm | ~250,000 events in minutes | 100 gateways in one region back after a 2-hour outage, ~2,500 buffered events each |
| Event size | ~0.6 KB JSON | Aggregates, not raw samples; images are references |
| Raw storage | ~15 GB/day | 25M × 0.6 KB; 90 days hot ≈ 1.4 TB |
| Hazards | ~50/day network-wide | Including heat risks and false alarms (assumption) |
| Domain events | ~1,000/day | ~20 events per hazard lifecycle |
| Train positions | ~1,500 trains × 1 per 10 s = 150/s | PTC/dispatch feed |

> Volume is moderate. One Kafka cluster and a few correlator instances handle it. What makes this hard is time: intermittent links, late and duplicated data, the gap between "seen at the edge" and "on the dispatcher's screen", and a backlog that must never delay a new emergency.

### Local Development Scale

| Component | Local | Notes |
|-----------|-------|-------|
| Railroad | 2 subdivisions, MP 100-260, 16 ten-mile segments, 16 gateways | `backend/src/shared/track.ts` |
| Sensors | 63 (27 geophones, 9 fences, 7 cameras, 16 rail temp, 4 water) | Plus one unregistered geophone |
| Trains | 4 | Moving at real speed |
| Edge events | ~4/s, plus a 3,000-event backlog burst | Real time; scenario ~7 minutes |

## High-Level Architecture

```
  FIELD (per 10-mile segment)                                    CLOUD
 ┌───────────────────────────────────┐
 │ slide fence ──▶ interlock ──▶ signal to red    (safety path: local, no cloud)
 │ crossing circuits ──▶ gates and lights          (safety path: local, no cloud)
 │ geophones · cameras (edge model) · rail temp · water level
 │ edge gateway: aggregate, buffer on disk, seq numbers,
 │               send critical first, report watermark
 └───────────────┬───────────────────┘
                 │ cellular / satellite / radio backhaul (drops out)
                 ▼                                 ┌──────────────────────┐
 ┌───────────────────────────────┐                │ PTC / dispatch feed  │
 │ Ingest API (stateless, mTLS)  │◀───────────────│ train positions      │
 │ dedup (gateway, seq) + outbox │                └──────────────────────┘
 └───────────────┬───────────────┘
                 │ one transaction
                 ▼
 ┌───────────────────────────────────────────────────────────────┐
 │ PostgreSQL: edge inbox · event store (hazards) · outbox ·     │
 │ consumer state (processed events, timers, evidence) · read models
 └───────────────┬───────────────────────────────────────────────┘
                 │ outbox relay (priority: critical > domain > trains > bulk)
                 ▼
 ┌───────────────────────────────────────────────────────────────┐
 │ Kafka                                                         │
 │  edge.critical (by segment)   edge.bulk (by segment)          │
 │  trains (by train)            hazard-events (by segment)      │
 │  dead-letters                                                 │
 └───┬───────────────┬─────────────────┬──────────────┬──────────┘
     ▼               ▼                 ▼              ▼
 ┌─────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐
 │Correlator│  │ Alerting     │  │ Projector  │  │ Notifier │──▶ consoles, pagers,
 │ (CEP)    │  │ process mgr  │  │ read models│  │          │    train radio, phones
 │ windows, │  │ durable      │  └─────┬──────┘  └──────────┘
 │ watermark│  │ timers       │        │
 └────┬─────┘  └──────┬───────┘        ▼
      │ hazard events │ alert, warn,   ┌──────────────────────────────────────┐
      └──── via event store + outbox ──│ API + SSE ─▶ operator dashboard,     │
                                       │ alert queue, inspectors, ops console │
                                       └──────────────────────────────────────┘
```

**Two tiers, one boundary.** The field tier protects trains by itself: a broken fence wire drops a signal, a crossing activates its gates. The cloud tier sees across devices and over time. When an interlock trips, the gateway reports `SlideFenceTripped` with `interlockSignalDropped: true`; the cloud opens a CRITICAL hazard, alerts the dispatcher and warns trains, but the signal was already red before any of that happened. If the cloud is down for two hours, trains are still protected by the field tier, and the gateways buffer everything so the cloud catches up afterwards, with every buffered event marked late.

**Choreography between services, orchestration inside a hazard.** Services do not call each other. Ingest, the correlator, the process manager, the projector and the notifier react to events on topics (choreography), so each can be scaled, restarted or replayed alone. Inside one hazard, the multi-step response (alert, escalate, warn, restrict, compensate on close) is orchestrated by one process manager, because a sequence with deadlines and compensations spread across five reactive services would have no single place that knows the state of the response.

## Core Components / Request Flows

### 1. Edge gateway: store-and-forward

Each gateway:

- **Aggregates** at the edge: one vibration reading per geophone per 10 s window (peak and RMS), one rail temperature per 30-60 s, camera detections from an on-board model with only an image reference.
- **Buffers** every event on local disk with a per-gateway **sequence number** that survives reboots. Events leave the buffer only when the cloud acknowledges the batch (2xx). Anything unacknowledged is resent, so delivery is at-least-once.
- **Sends critical events first.** A fence trip, a camera detection or a vibration spike goes out in its own batch ahead of the routine backlog.
- **Reports a watermark** with every batch: the event time of the oldest event still in its buffer ("everything before T has been delivered").
- **Watches its sensors**: a sensor that misses three intervals produces `SensorHeartbeatMissed`.

### 2. Ingest: inbox + outbox in one transaction

`POST /api/v1/ingest/batches`, authenticated per gateway (shared token locally, mTLS in production).

1. Validate the batch envelope only (event id, sequence, type, version, event time). Payloads are stored as delivered (**accept-and-store**), so one malformed event never wedges a gateway's queue; the consumer dead-letters it instead.
2. Insert each event into `edge_events`, deduplicated on `(gateway, seq)` and on event id. A resent batch inserts nothing.
3. For each new event, write an outbox row on a lane chosen by **server-side policy** (a misconfigured gateway can't flood the critical lane), keyed by the sensor's track segment.
4. Update the gateway's heartbeat and reported watermark; `NOTIFY` the relay at commit.
5. Respond with counts. A 200 means durably stored; the gateway may drop those events.

### 3. Outbox relay

A leader-elected relay publishes outbox rows to the streams in priority order (critical, domain, trains, bulk), restarting from the top after every batch. Rows are claimed with `FOR UPDATE SKIP LOCKED`, published, then marked published in the same transaction. If the relay dies between publish and commit, the rows are published again: at-least-once, deduplicated downstream by event id. Within a lane rows go out in id order, which is commit order per partition key, so per-segment order is preserved.

### 4. Correlator: complex event processing

Consumes `edge.critical` first, then `trains`, then `edge.bulk` in batches of 20, so a critical event waits behind at most one bulk batch. Per event, one transaction:

1. **Idempotency**: insert into `processed_events`; a duplicate stops here.
2. **Upcast and validate** the payload (v1 camera detections become v2). Unknown versions and invalid payloads are permanent failures (DLQ). An unknown sensor is transient (the registry may not have caught up with a field install): retried, then dead-lettered, redriven after ops registers it.
3. **Lock** the sensor's segment and any neighbour within the correlation radius (the "halo"), so two correlator instances can't build two hazards across a segment boundary.
4. **Lateness**: compare the event time with the segment's watermark.
5. **Evidence**: turn the event into evidence with a confidence, or nothing (a quiet geophone, a "clear" frame).
6. **Correlate**:

```
evidence e arrives
  if e is a vibration spike and a train was within 0.6 mi at e's event time:
      store e as explained, stop                     (interpolated from PTC positions)
  if an open hazard of a compatible kind covers e
     (within 0.5 mi of its span, not older than its first evidence - 30 s):
      join it; if confidence rose: HazardEvidenceAdded (+ HazardUpgraded if severity rose)
  else:
      cluster = e + unattached compatible evidence within ±30 s, ±0.5 mi (event time)
      confidence = noisy-OR over sensors (best report per sensor)
      if confidence >= 0.5: HazardDetected (CRITICAL if >= 0.8, else HIGH)
      else: e waits as a candidate
```

Confidence combines as a noisy-OR across sensors: a camera at 0.71 and a geophone spike at 0.425 give 1 − 0.29 × 0.575 = 0.83, confirmed. The same sensor twice (a second wire on one fence, a resent batch) counts once. Because a hazard's evidence set, not the arrival order, decides its confidence, the same events in any order give the same standing hazards; the tests shuffle a scenario 25 times to prove it.

7. **Retroactive explanation**: a train position that arrives late explains any spike along its path between its neighbouring fixes; a hazard built on those spikes is downgraded (`HazardDowngraded`). It is never closed automatically.
8. **Heat**: rail-temperature samples feed a per-sensor linear trend. The band is the worse of the current temperature and a 10-minute projection, capped at one band above the current one: `watch` at RNT+25°F, `elevated` at +35, `critical` at +45 (illustrative). Rising into elevated or critical appends `HazardRiskElevated`; falling back appends `HazardRiskSubsided`.
9. **Coverage**: `SensorHeartbeatMissed` appends `CoverageDegraded`; the next reading from that sensor appends `CoverageRestored`.

A leader-only **tick** every 2 s advances watermarks, marks silent gateways (no batch for 30 s) as degraded coverage, and expires candidate evidence whose window closed below threshold.

### 5. Event time, windows and watermarks

```
event time  ──────────────────────────────────────────────────────────▶
gateway GW-CAN-4:   cam(t=45) │ link down ─────────────────── │ reconnect (t=175)
                              │ spike(t=58) buffered at edge  │ spike delivered late
segment watermark:  follows reported ──▶ │ idle 30 s: advances on processing time
                                         │ (now - 30 s), never backwards
window for cam:     [15 ........ 75]     │
                         watermark passes 75 at ~t=105 → window closed
spike(t=58) arrives at t=175: 58 < watermark → LATE → joins the open hazard → HazardUpgraded(late)
```

- While a gateway is active, its segment's watermark follows the gateway's reported watermark (oldest buffered event).
- While it is silent past the idle timeout, the watermark advances on processing time, so windows close and the rest of the system is not held hostage by one dead link. The watermark is monotonic.
- When the gateway reconnects, its backlog is below the watermark: late. Late events are processed, flagged, and can still create, upgrade or downgrade hazards.
- **We alert before the watermark.** Waiting for a window to close would add at least 30 s to every alert. The correlator fires as soon as confidence crosses the threshold and refines later; the price is an occasional downgrade or false alarm, which the human workflow handles.

### 6. Hazard-response process manager (alerting)

Consumes the domain topic and train positions, and fires durable timers. For every wake-up it folds the hazard stream and runs one **level-triggered** decision function: compare what should be true with what the stream says is true.

| Condition on the folded state | Decision |
|-------------------------------|----------|
| Severity ≥ MEDIUM, no alert yet | `AlertIssued` to the desk dispatcher for the subdivision; ack deadline CRITICAL 60 s, HIGH 3 min, MEDIUM 10 min (illustrative); durable timer |
| Severity rose above the alert's | `AlertEscalated (severity_raised)`; fresh acknowledgment required |
| Deadline passed, not acknowledged | `AlertEscalated (ack_overdue)`: desk dispatcher → chief dispatcher → manager of operations |
| CRITICAL, approaching trains not yet warned | `TrainsWarned`, nearest ETA first |
| Heat risk elevated/critical, no restriction that slow | `SpeedRestrictionIssued` (standing heat order, 40 / 25 mph) |
| Heat risk subsided | Lift automatic heat orders; `HazardCleared` |
| Hazard closed (cleared / false alarm) | **Compensation**: lift every active restriction, release every warned train |

Because the function only appends what is missing, a redelivered event, a timer that fires twice or two wake-ups racing each other find nothing left to do. Appends use optimistic concurrency on the stream version; a conflict reloads and re-decides. The one deliberate asymmetry: nothing is relaxed automatically while a hazard is open, even after a downgrade. A person clears it or calls it a false alarm.

**Durable timers.** The ack-deadline timer is a row in `timers`, written in the same transaction as the `AlertIssued` it belongs to. A leader sweeps due timers every second (`FOR UPDATE SKIP LOCKED`), marks them fired and reconciles the hazard in one transaction. A deadline that passes while the service is down fires when it comes back.

**Approaching trains.** For a hazard on MP a–b, a train heading toward it (increasing milepost below a, or decreasing above b) within 30 mi or 40 min is approaching; warnings go out in ETA order. As trains move, train-position events wake the process manager for open CRITICAL hazards on that subdivision, so a train that enters the approach window later is warned too.

### 7. Commands from people

Dispatchers acknowledge, warn trains, issue and lift slow orders, dispatch an inspector, and close hazards; the dispatched inspector can close the hazard. Each command carries a client **command id** (idempotency key, stored in `command_log` with the result) and the **version the person was looking at**. Rules are checked on the folded stream under an advisory lock. An acknowledgment is not refused just because new evidence moved the version (that would bounce every ack during an active incident), but closing a hazard is refused with `409 HAZARD_CHANGED` if evidence arrived after the version the person saw.

### 8. Projections and replay

The projector maintains four read models from the domain topic (hazards, alert queue, speed restrictions, coverage) plus the latest train positions from the trains topic. Each projection is a pure reducer; the hazards projection uses the same `reduceHazard` fold as the process manager and the commands.

- **Idempotency** is the stream version: an event whose version is not above the last one applied for its stream is skipped.
- **Replay** (`npm run replay -- hazards`, or the button on the ops page) takes the projection's lock, checksums the live table, deletes it, folds every event from global position 0 through the same reducer, writes the result and checksums again. Matching checksums prove the read model is exactly what the log says.

### 9. Notifier

Consumes the domain topic. For each event it records one row per channel and recipient (`event id:channel:recipient` is unique) in the same transaction as its processed-events mark, then delivers asynchronously after commit: console and pager for alerts, radio bulletins to trains one after another in ETA order, a phone message to the inspector. A slow radio bulletin therefore never delays the next critical alert. A sweeper retries rows a crashed notifier left in `sending`.

### Worked example: one successful trace (crossing obstruction during a backlog)

1. 15:02:33.0 A camera at the Hwy 9 crossing (MP 241.3) classifies a vehicle at 0.71. Gateway GW-PRA-7 buffers `CameraDetectionReported` v2 (seq n) and sends it alone, ahead of routine readings.
2. 15:02:33.6 Ingest inserts it into `edge_events` and an outbox row on the critical lane, key `PRA-7`, commits, NOTIFY. At the same moment GW-PRA-1 is uploading a 3,000-event backlog from a morning outage; those rows land on the bulk lane.
3. 15:02:33.7 The relay publishes critical rows before bulk ones: `th:edge.critical:p(PRA-7)`.
4. 15:02:33.7 The correlator reads critical before bulk, marks the event processed, upcasts nothing (already v2), locks PRA-7, finds no open hazard and no other evidence in the window: confidence 0.71 ≥ 0.5, so `HazardDetected` (HIGH, HZ-1008) and its outbox row commit together.
5. 15:02:34.0 The process manager folds the new stream: no alert yet, so `AlertIssued` to Dan (EAST desk owns the Prairie Sub), deadline 3 min, timer row in the same transaction. The notifier puts it on Dan's console (delivered 15:02:34.1: about 1 s from the edge) and pages him.
6. 15:02:39 The geophone at MP 241.5 reports a 27 mm/s spike. No train is within 0.6 mi at that event time. It joins HZ-1008: confidence 0.83, `HazardEvidenceAdded` + `HazardUpgraded` to CRITICAL.
7. The process manager sees severity above the alert's: `AlertEscalated (severity_raised)`, deadline 60 s, and `TrainsWarned` for Z-CHIPRA (ETA 16 min) then M-PRACAN (ETA 38 min). The notifier radios them in that order.
8. Meanwhile GW-PRA-7's HTTP reply for step 1 was lost, so it resends the batch: ingest inserts nothing (`duplicates: 1`). The bulk lane drains the 3,000-event backlog over the next few seconds without touching the critical path.
9. Dan acknowledges (command id c1). His tablet loses the response and retries with c1: the stored result comes back, no second `AlertAcknowledged`. He issues a 10 mph slow order on MP 240.8–242.0 and dispatches Bob.
10. Bob finds a stalled pickup, it is towed, and he records `HazardCleared`. The process manager compensates: `SpeedRestrictionLifted`, `TrainsReleased`.

### Worked example: one failed trace (the correlator dies mid-backlog)

1. The correlator is processing a 5,000-event bulk backlog for GW-PRA-2 and is killed (`kill -9`) after committing event k but before `XACK` of k, with events k+1..k+19 delivered to it and pending.
2. A slide fence trips at MP 113.0 meanwhile. Ingest and the relay keep working; the fence trip sits in `edge.critical`, unread.
3. The interlock already dropped signal CAN-1130W to red: no train enters the block. That part never depended on the cloud.
4. The correlator restarts (same consumer name) and first re-reads its own pending entries (`XREADGROUP ... 0`). Event k's `processed_events` row exists, so it is a no-op and gets acked; k+1.. are processed normally. If the restart had come up on a different instance, `XAUTOCLAIM` would have taken over the idle entries after 5 s.
5. Before draining the rest of the backlog, the consumer reads the critical lane: the fence trip becomes `HazardDetected` (CRITICAL) seconds after the restart.
6. Result: no double effects (one evidence row and at most one hazard event per edge event), the critical event was delayed only by the outage itself, and the detection-to-alert latency panel shows the outage as an outlier with the stage that absorbed it (ingest → detected).

## Database Schema

PostgreSQL holds the edge inbox, the event store, the outbox, consumer state and the read models. Full DDL: [`backend/src/db/init.sql`](./backend/src/db/init.sql).

```sql
-- Event store: source of truth for hazards and coverage. Append-only (a trigger refuses UPDATE/DELETE).
CREATE TABLE events (
  global_position BIGSERIAL PRIMARY KEY,          -- orders the whole log; replay reads in this order
  event_id        UUID NOT NULL UNIQUE,
  stream_id       TEXT NOT NULL,                  -- hazard-<uuid>, sensor-<id>, gateway-<id>
  stream_version  INT NOT NULL,
  type            TEXT NOT NULL,
  version         INT NOT NULL DEFAULT 1,         -- schema version
  partition_key   TEXT NOT NULL,                  -- track segment
  occurred_at     TIMESTAMPTZ NOT NULL,           -- event time
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),  -- processing time
  correlation_id  TEXT NOT NULL,
  causation_id    TEXT,
  source          TEXT NOT NULL,
  meta            JSONB NOT NULL DEFAULT '{}',
  payload         JSONB NOT NULL,
  UNIQUE (stream_id, stream_version)              -- optimistic concurrency
);

-- Edge inbox: every event a gateway delivered, exactly once per (gateway, seq).
CREATE TABLE edge_events (
  event_id UUID PRIMARY KEY, source_id TEXT NOT NULL, seq BIGINT NOT NULL,
  type TEXT NOT NULL, version INT NOT NULL, sensor_id TEXT, segment_id TEXT,
  partition_key TEXT NOT NULL, lane TEXT NOT NULL, late BOOLEAN NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, recorded_at TIMESTAMPTZ NOT NULL, lag_ms INT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE (source_id, seq)
);

-- Transactional outbox: written in the same transaction as edge_events or events.
CREATE TABLE outbox (
  id BIGSERIAL PRIMARY KEY, event_id UUID NOT NULL,
  topic TEXT NOT NULL, lane TEXT NOT NULL, partition_key TEXT NOT NULL,
  envelope JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox (lane, id) WHERE published_at IS NULL;

-- Consumer idempotency.
CREATE TABLE processed_events (consumer TEXT, event_id UUID, processed_at TIMESTAMPTZ,
  PRIMARY KEY (consumer, event_id));
CREATE TABLE command_log (command_id UUID PRIMARY KEY, username TEXT, hazard_id TEXT,
  command TEXT, result JSONB, created_at TIMESTAMPTZ);

-- Gateway heartbeat and watermarks.
CREATE TABLE gateway_state (
  gateway_id TEXT PRIMARY KEY, segment_id TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ, reported_watermark TIMESTAMPTZ,
  effective_watermark TIMESTAMPTZ,                -- monotonic; events before it are late
  buffered_count INT, last_seq BIGINT, coverage TEXT, coverage_since TIMESTAMPTZ
);

-- Correlator keyed state.
CREATE TABLE evidence (
  event_id UUID PRIMARY KEY, kind TEXT NOT NULL, sensor_id TEXT NOT NULL,
  subdivision_id TEXT NOT NULL, segment_id TEXT NOT NULL, milepost NUMERIC(6,1) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, confidence NUMERIC(4,3) NOT NULL, late BOOLEAN NOT NULL,
  explained_by_train TEXT, hazard_id TEXT, expired BOOLEAN NOT NULL DEFAULT false, details JSONB
);
CREATE INDEX evidence_window_idx ON evidence (subdivision_id, occurred_at);
CREATE TABLE correlation_hazards (hazard_id TEXT PRIMARY KEY, code TEXT, kind TEXT,
  subdivision_id TEXT, segment_id TEXT, mp_from NUMERIC, mp_to NUMERIC, confidence NUMERIC,
  severity TEXT, detection_status TEXT, first_evidence_at TIMESTAMPTZ, stream_version INT);
CREATE TABLE train_positions (event_id UUID PRIMARY KEY, train_id TEXT, symbol TEXT,
  subdivision_id TEXT, milepost NUMERIC(7,3), direction TEXT, speed_mph NUMERIC,
  occurred_at TIMESTAMPTZ);                        -- "where was this train at time t?"

-- Process manager: durable timers.
CREATE TABLE timers (id UUID PRIMARY KEY, kind TEXT, hazard_id TEXT, due_at TIMESTAMPTZ,
  status TEXT CHECK (status IN ('pending','fired','cancelled')), fired_at TIMESTAMPTZ);
CREATE INDEX timers_due_idx ON timers (due_at) WHERE status = 'pending';

-- Notifier.
CREATE TABLE notifications (id BIGSERIAL PRIMARY KEY, idempotency_key TEXT UNIQUE,
  event_id UUID, hazard_id TEXT, channel TEXT, recipient TEXT, status TEXT,
  attempts INT, message TEXT, created_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ);

-- Read models (rebuildable) and their bookkeeping.
CREATE TABLE proj_hazards (key TEXT PRIMARY KEY, subdivision_id TEXT, open BOOLEAN, severity TEXT, doc JSONB);
CREATE TABLE proj_alerts (key TEXT PRIMARY KEY, desk_id TEXT, status TEXT, doc JSONB);
CREATE TABLE proj_restrictions (key TEXT PRIMARY KEY, subdivision_id TEXT, active BOOLEAN, doc JSONB);
CREATE TABLE proj_coverage (key TEXT PRIMARY KEY, segment_id TEXT, status TEXT, doc JSONB);
CREATE TABLE projection_versions (projection TEXT, stream_id TEXT, version INT,
  PRIMARY KEY (projection, stream_id));            -- natural idempotency key
CREATE TABLE projection_checkpoints (projection TEXT PRIMARY KEY, last_position BIGINT,
  last_recorded_at TIMESTAMPTZ, events_applied BIGINT, rebuilt_at TIMESTAMPTZ);
```

Reference tables (`desks`, `subdivisions`, `segments`, `sensors`, `users`), `rail_temp_samples`, `heat_state`, `sensor_state` and `latency_samples` complete the schema.

## API Design

```
POST /api/v1/ingest/batches                  Gateway / PTC batch (X-Ingest-Token; mTLS in production)

POST /api/v1/auth/login | logout,  GET /api/v1/auth/me

GET  /api/v1/board                           Strip-map read model: segments, sensors, hazards, slow orders, coverage, trains, KPIs
GET  /api/v1/hazards?status=open|closed|all
GET  /api/v1/hazards/:id                     Hazard + event timeline + evidence + notifications + approaching trains
POST /api/v1/hazards/:id/commands            { commandId, seenVersion, command: { kind, ... } }
GET  /api/v1/alerts?scope=mine|all           Alert queue (desk-scoped for dispatchers, dispatches for inspectors)
GET  /api/v1/restrictions?status=active|all
GET  /api/v1/latency                         Detection-to-alert p50/p99, stage breakdown, per-lane decision latency
GET  /api/v1/events?type=&streamId=&before=  Event store browser
GET  /api/v1/live                            SSE notices (ids only; pages refetch)

GET  /api/v1/ops/overview                    Streams, consumer lag, outbox backlog, projections, gateways, rates
GET  /api/v1/ops/dlq                         Dead letters
POST /api/v1/ops/dlq/:id/redrive | discard   (admin)
POST /api/v1/ops/sensors                     Register a sensor (admin)
POST /api/v1/ops/replay/:projection          Rebuild a projection from position 0 and compare (admin)
```

Example batch:

```json
{
  "sourceId": "GW-PRA-7",
  "batchId": "8f0c…",
  "watermark": "2026-11-06T15:02:33.000Z",
  "bufferedCount": 4,
  "events": [{
    "eventId": "1b9e…", "seq": 178240513990000, "type": "CameraDetectionReported", "version": 2,
    "occurredAt": "2026-11-06T15:02:33.000Z",
    "payload": { "sensorId": "CAM-241.3", "detectionClass": "vehicle", "confidence": 0.71,
                 "imageRef": "s3://edge-frames/CAM-241.3/1762441353000.jpg",
                 "bbox": { "x": 0.31, "y": 0.55, "w": 0.22, "h": 0.18 }, "modelVersion": "yolo-rail-2.3" }
  }]
}
→ 200 { "accepted": 1, "duplicates": 0, "critical": 1, "late": 0 }
```

Example command:

```json
POST /api/v1/hazards/0b6f…/commands
{ "commandId": "c1…", "seenVersion": 4, "command": { "kind": "clear", "note": "Pickup towed clear" } }
→ 201 { "hazard": { … }, "appended": ["HazardCleared"], "replayed": false }
→ 409 { "error": { "code": "HAZARD_CHANGED", "message": "New evidence arrived since you looked (HazardUpgraded)…" } }
```

## Key Design Decisions

### 1. Event-sourced hazards, state-plus-outbox everywhere else

A hazard is an incident whose history *is* the product: the audit trail, the timeline the dispatcher reads, and the input for after-action review. So hazards are event-sourced: the `hazard-<uuid>` stream is the source of truth and every view is a fold of it. The edge inbox, the correlator's evidence index, timers and notifications are ordinary state written in the same transaction as an outbox row. Full event sourcing of raw telemetry would put 25M events/day into aggregate streams that nobody folds; state-plus-outbox gives the same no-lost-event guarantee for a fraction of the complexity. The cost is two patterns to understand instead of one.

### 2. Partition by track segment

Hazards are spatial: correlation needs every event near a milepost, in order, in one place. Keying by segment puts a segment's sensors, its hazard streams and its process-manager decisions on one partition. Keying by sensor would spread one rockfall across partitions and force a cross-partition join; keying by subdivision would make an 80-mile stretch one hot partition. Segments still have boundaries, so the correlator locks the segment and any neighbour within the 0.5 mi radius (the halo). Hot keys are real: a crossing camera in a storm, or a slide area with a dozen geophones, makes one segment busy. Edge aggregation (10 s windows), suppressing camera "clear" frames, and splitting a hot segment in two are the levers; the segment table is data, not code.

### 3. Correlate on event time, alert before the watermark

The correlator decides from the set of evidence in a space-time window, not from arrival order, so late and reordered events give the in-order answer. It does not wait for the watermark before alerting: a 30 s window plus allowed lateness would put a floor of 30-60 s under every alert. It alerts on the first evidence that crosses the threshold and refines (upgrade, downgrade) as late evidence arrives.

### 4. A priority lane at every hop

Priority is only as good as its weakest hop. The gateway sends critical first; ingest classifies the lane server-side; the relay publishes critical before bulk; critical and bulk are separate topics; consumers drain critical before every bulk batch; the notifier delivers asynchronously. Remove any one and a reconnect backlog queues in front of a new emergency.

### 5. A level-triggered process manager

The response could be choreographed (each service reacting to the previous step), but deadlines and compensation need one place that knows the response's state. The process manager folds the stream and appends only what is missing, so it is idempotent without its own dedup logic, and timers, train movements and domain events all reuse one decision function.

### 6. Accept-and-store at ingest

Rejecting a malformed event with a 4xx would make the gateway retry it forever or drop it silently. Ingest stores whatever arrives with a valid envelope and lets the consumer dead-letter it, where ops can see it, fix the cause and redrive.

## Consistency and Idempotency

- **Source of truth and when a write succeeds.** An edge event exists once it is committed to `edge_events` (with its outbox row); a hazard fact exists once it is appended to `events` (with its outbox row). Everything downstream is derived and can lag or be rebuilt.
- **Exactly-once effects = at-least-once delivery + idempotent consumers.** Gateways resend; the relay can republish; streams redeliver unacknowledged entries; redrive re-publishes to every group on a partition. Each consumer's dedup key (table in [events.md](./events.md)) makes the second delivery a no-op, and each consumer commits its effects and its dedup row in one transaction before acknowledging.
- **Optimistic concurrency.** The correlator, the process manager and API commands can all append to one hazard stream. UNIQUE (stream, version) lets exactly one writer win; the others reload and re-decide.
- **Ordering.** Per partition key within a lane. Correlation doesn't need more; projections and the process manager get per-hazard order from the segment key and skip versions already applied.
- **Commands.** Command id → stored result; a retry after a lost response returns it with `replayed: true`.

## Security / Auth

- **Gateways**: per-gateway client certificates (mTLS) in production, a shared ingest token locally. The gateway id in the batch must match the certificate; ingest rejects unknown gateways.
- **People**: session cookie (httpOnly) with sessions in Valkey. Roles: dispatcher (acts on hazards in its desk's subdivision), track inspector (closes hazards it was dispatched to), platform operator (admin: DLQ, replay, sensor registry). Every command re-checks authorization on the folded stream; the UI only hides buttons.
- **Live updates** carry ids only; the browser refetches through access-checked APIs.
- **Rate limits** on login; the critical lane is assigned by server policy, not by the gateway.

## Observability

Each service exposes Prometheus metrics (`backend/src/shared/metrics.ts`):

| Metric | Why |
|--------|-----|
| `th_detection_to_alert_seconds{lane,late}` | The latency budget: edge event time to the alert on the console |
| `th_edge_to_decision_seconds{lane,late}` | Per-lane processing; shows the priority lane holding under backlog |
| `th_consumer_lag{group,topic}`, `th_consumer_pending` | Consumer lag per group (Valkey 7 XINFO GROUPS lag) |
| `th_outbox_backlog{lane}` | Relay health |
| `th_dlq_depth` | Poison messages waiting for a human |
| `th_projection_staleness_seconds{projection}` | Read-model freshness |
| `th_edge_events_ingested_total{type,lane,outcome}` | Events/sec and duplicates |
| `th_ingest_lag_seconds{lane}` | Edge buffering (connectivity) |
| `th_alert_escalations_total{reason}` | Ack deadlines missed |

The latency page shows p50/p99 and the stage breakdown (edge → ingest → detected → alert → console); the ops page shows lag, outbox backlog, projection staleness, gateway watermarks and the DLQ. Logs are structured (pino) with event ids and correlation ids, so one incident can be followed across services.

## Failure Handling

| Failure | What happens |
|---------|--------------|
| Backhaul down | Gateway buffers on disk; the segment watermark advances on processing time after 30 s; segment shows "gateway silent"; backlog arrives late and is processed |
| Cloud down for hours | Field interlocks and crossing devices protect trains; gateways buffer; on recovery critical events go first and every buffered event is marked late |
| Duplicate batch | Ingest dedup on (gateway, seq) |
| Relay crash after publish | Rows republished; consumers dedupe by event id |
| Consumer crash mid-batch | Own pending entries reprocessed on restart; XAUTOCLAIM for another instance; processed-events makes them no-ops |
| Poison message | Permanent errors to `th:dlq` at once; transient ones retried in place (keeping partition order), then dead-lettered; ops redrives after fixing the cause |
| Projection bug | Fix the reducer, replay from position 0 |
| Process manager down | Domain events wait in the stream; due timers fire on restart; nothing is lost, alerts are late (visible in the latency panel) |
| Notification provider failure | Retried with backoff; rows stuck in `sending` swept and retried |
| Late PTC data | Spikes retroactively explained; hazard downgraded, not closed |

## Scalability Considerations

- **What breaks first: the correlator's per-segment serialisation during regional reconnect storms.** At ~2 ms per bulk event, a 250,000-event storm is ~8 minutes of bulk work on one instance. The critical lane is unaffected by design, but bulk-derived signals (heat trends, coverage restoration) lag. Evidence: the local burst demo shows bulk lag climbing to thousands while critical-lane p99 stays sub-second. Fix: more partitions and correlator instances (partitions are assigned statically or by the Kafka group), and batch the bulk path (one transaction per 20 readings).
- **Second: the evidence table and window queries.** Partition `evidence` by day and subdivision; keep only open windows in memory per partition (Flink-style keyed state) with the table as the changelog.
- **Hot segments**: split the segment, or sub-key raw telemetry by sensor while keeping hazard decisions per segment.
- **Projections**: shard by subdivision; the read side scales independently with replicas.
- **Event store**: hazards are low-volume (thousands of events/day); a single PostgreSQL primary with replicas lasts a long time. Raw edge events move to a time-series or columnar store after 90 days.

### Kafka mapping

| Local (Valkey) | Production (Kafka) |
|----------------|--------------------|
| `th:edge.critical:0..3` | topic `edge.critical`, 32 partitions, key = segment, retention 7 d |
| `th:edge.bulk:0..3` | topic `edge.bulk`, 64 partitions, key = segment, retention 7 d |
| `th:trains:0..3` | topic `trains`, key = train id; a compacted twin `trains.latest` for current positions |
| `th:domain:0..3` | topic `hazard-events`, key = segment, retention 30 d (the event store is permanent) |
| `th:dlq` | topic `dead-letters`, one per consumer group in practice |
| consumer group + XACK | consumer group + offset commit after the DB transaction |
| XAUTOCLAIM of idle pending entries | rebalance hands a dead member's partitions to a live one |
| outbox relay | Debezium CDC on the outbox table, or the same relay |
| static partition ownership (`CORRELATOR_PARTITIONS`) | group-managed partition assignment |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Source of truth for hazards | Event-sourced streams | Hazard table + history table | The history is the product; projections replay |
| Edge telemetry | State + outbox | Event-source everything | Same delivery guarantee, far less machinery |
| Partition key | Track segment (+ halo locks) | Sensor / subdivision | Spatial correlation on one partition without one huge hot key |
| Alert timing | On first threshold crossing | Wait for the watermark | Seconds matter; late data refines |
| Correlation state | Evidence set in event time | Incremental per-arrival counters | Order-independent, replay-safe |
| Priority | Separate lanes at every hop | One topic with a priority field | A backlog can't overtake a critical event anywhere |
| Response workflow | Level-triggered process manager | Choreography across services | Deadlines and compensation need one owner |
| Delivery | At-least-once + idempotent consumers | Exactly-once transactions | Works across the DB, streams and notification providers |
| Bad payloads | Accept-and-store, DLQ at consumer | Reject at ingest | One bad event never wedges a gateway |
| Train control | Never (advisory warnings via dispatcher channels) | Cloud stops trains | The safety path stays in the field |

## Design Review Checklist

1. **Source of truth; when is a write successful?** Edge events: committed to `edge_events` with an outbox row (then the gateway may drop them). Hazards: appended to the event store with outbox rows. Projections, the alert queue and the board are derived.
2. **Client retries after losing the response?** Gateways resend; (gateway, seq) dedup returns `duplicates`. People's commands carry a command id; the stored result is returned with `replayed: true`.
3. **Worker fails between two steps?** Every consumer commits its effects and processed-events row together, then acks. A crash before commit redoes the work; a crash after commit redelivers into a no-op. The relay republishes; timers are rows; notifications are rows swept on restart.
4. **Which ordering is required?** Per hazard (segment key) for the process manager and projections; none for correlation, which works on event time. Per train for positions.
5. **Access with async jobs and caches?** SSE notices carry ids; every read and command re-checks the session and role; the critical lane is assigned server-side; gateways authenticate per device.
6. **What breaks first?** Correlator bulk throughput in regional reconnect storms (the burst demo shows bulk lag rising while critical stays fast); then evidence-table window queries. See Scalability Considerations.

The two traces are in Core Components above.

## Implementation Notes

### Local architecture

| Process | Default port | Entry point | Production counterpart |
|---------|--------------|-------------|------------------------|
| API | 3000 | `backend/src/api/index.ts` | Ingest + read + command API behind a gateway |
| Relay | 3014 (metrics) | `backend/src/relay/index.ts` | Debezium or an outbox relay |
| Correlator | 3010 (metrics) | `backend/src/correlator/index.ts` | Flink / Kafka Streams job |
| Alerting | 3011 (metrics) | `backend/src/alerting/index.ts` | Process-manager service |
| Projector | 3012 (metrics) | `backend/src/projector/index.ts` | Read-model service |
| Notifier | 3013 (metrics) | `backend/src/notifier/index.ts` | Paging, radio and console integrations |
| Simulator | - | `backend/src/simulator/index.ts` | Real gateways and the PTC feed |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | PostgreSQL + a columnar store for raw telemetry |
| Valkey 7 | 6379 | - | Kafka |

### Production-grade patterns actually implemented

- **Transactional outbox** (`shared/event-store.ts`, `api/services/ingest.ts`, `relay/relay.ts`): every event and its outbox row commit together; LISTEN/NOTIFY wakes the relay; priority order; leader lock.
- **Partitioned streams with consumer groups** (`shared/streams.ts`, `shared/consumer.ts`): FNV partitioner, priority lanes, ack after commit, in-place retry, XAUTOCLAIM, own-PEL recovery, DLQ.

```ts
// shared/consumer.ts: after every batch, start again from the top lane
for (const lane of this.opts.lanes) {
  const reply = await this.reader.xreadgroup('GROUP', group, consumer, 'COUNT', lane.batch, 'STREAMS', ...keys, ...keys.map(() => '>'))
  if (hasEntries(reply)) { await this.handleReply(reply); handled = true; break }
}
```

- **Idempotent consumers** (`shared/idempotency.ts`, projections' version check, notifier keys, command log).
- **Optimistic concurrency** on stream versions (`appendToStream`, `withConcurrencyRetry`).
- **Upcasting** (`shared/events/edge.ts`): v1 → v2 camera detections, v3 dead-lettered.
- **Event-time correlation with watermarks** (`correlator/engine.ts`, `correlator/tick.ts`), order-independence proven by shuffled tests.
- **Level-triggered process manager with durable timers and compensation** (`alerting/reconcile.ts`, `alerting/handler.ts`).
- **Replayable projections** (`projector/projections.ts`, `projector/store.ts`, `npm run replay`).
- **Observability**: prom-client metrics per service, pino logs, latency samples, lag and staleness on the ops page.

### Simplified or substituted

- Valkey Streams for Kafka, with static partition ownership instead of group rebalancing.
- One PostgreSQL for the inbox, event store, consumer state and read models (production splits raw telemetry into a columnar store).
- Simulated gateways, PTC feed and notification channels; event time is wall-clock time and the scenario runs in real time.
- Edge vision is a confidence number in the simulator; no images are stored.
- A shared ingest token instead of per-gateway mTLS; session auth instead of SSO.
- Projections store JSONB documents with a few typed columns.

### Omitted

- Multi-region deployment, Kubernetes, autoscaling.
- Real signal, PTC or crossing-system integrations (by design the platform never controls them).
- A trained vision model and model rollout; image storage.
- Long-term archival of raw edge events.
