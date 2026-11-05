# Railcar Health - Architecture

## System Overview

A hot-bearing and hot/cold-wheel monitoring and predictive maintenance system for a fleet of about 200,000 railcars. Wayside detectors measure every axle of every passing train. This system turns those readings into risk alerts, routes them to the people who can act, and runs the yard response: hold the car, inspect it, record what was found, repair or release it.

The detector already raises its own alarm. A hot bearing detector (HBD) that sees a bearing over its absolute threshold announces it to the train crew over the radio, and the crew stops under operating rules. That path is safety-critical and must never depend on this system. What this system adds is everything a single detector can't see on its own:

- **Trending across detectors.** A bearing that runs 30°F hotter than the rest of its train at five detectors in a row is failing, even though no single reading is alarming.
- **Identity.** Which car, which bearing, regardless of which way the car faces, across trips and wheelset replacements.
- **Routing and ownership.** The dispatcher for the train's current territory, the mechanical forces at its next yard, the car's owner, each with a deadline.
- **The yard workflow and its feedback.** Inspection findings are the labels that measure precision and calibrate thresholds.

Learning goals:

- Tolerate at-least-once, out-of-order and hours-late data from store-and-forward gateways without changing any answer.
- Keep a bearing's identity stable when the consist is stale, the car was turned, the train was rebuilt or the wheelset was replaced.
- Design for asymmetric costs: a needless stop costs hours of network delay, a missed bearing can derail a train.
- Treat delivered, acknowledged, inspected and closed as separate states, each with an owner.

### Public context (cited, not verified here)

| Source | What it says |
|--------|--------------|
| BNSF, "Eyes on AI" | Condition-based maintenance uses thermal sensors and machine vision over 1.5M+ wheels; AI processes 35M+ wayside readings a day; machine vision handles 2M+ images a day |
| AAR, March 2023 (Class I commitments after East Palestine) | HBDs on key routes at an average 15-mile spacing (max 20 miles where acoustic bearing detection exists); develop a standard for trend analysis of HBD readings, because trending across detectors can reveal a problem before an absolute threshold is reached; about 1,000 detectors added to about 6,000 in service |
| NTSB, East Palestine (2023) | The train passed three HBDs in about 30 miles. The first two showed rising temperatures on the 23rd car, below alarm thresholds. Only the last reached critical |
| Railinc EHMS | Industry system that routes detector-based alerts to car owners and railroads; about 10,000 wayside detectors, 36M train passes a year. Most North American railcars are owned by lessors and shippers, not the railroad |
| BNSF Brake Health Effectiveness | Uses thermal (hot/cold wheel) detectors to judge brake health under an FRA test waiver; rail unions contest using it to replace manual inspections |

Every other number in this document is an illustrative assumption and is labeled as one. Alarm thresholds in the system are configurable, illustrative values, not regulatory ones.

## Requirements

### Functional Requirements

1. **Ingest** passes from detector-site gateways: per-axle, per-rail bearing and wheel temperatures, ambient temperature, speed, AEI (RFID) reads at equipped sites, and the detector's own alarms. Delivery is at-least-once, out of order and sometimes hours late.
2. **Resolve identity**: map axle N on the north rail to car, axle and side relative to the car's B-end, using the consist version in force at the time and AEI corrections.
3. **Trend and score**: per bearing within a trip (above ambient, delta vs the train-side median, rise per 15 miles, rank in train) and across trips (history), plus brake health from wheel temperatures. Explainable risk tiers.
4. **Alert** with one open alert per bearing per trip, escalated in place. Tiers map to actions: CRITICAL stop and inspect, HIGH set out or restricted speed, MEDIUM inspect at the next terminal (hold plus work order), LOW monitor and notify the owner.
5. **Route and own**: dispatcher for the current territory, yard at the predicted next stop, car owner. Ack deadlines, escalation, handoff when the train moves on. Late data is routed to where the train is now.
6. **Yard workflow**: inspection queue, offline-tolerant finding entry, car holds that block outbound builds, bad orders, repairs that record wheelset installs.
7. **Detector health**: offline (buffering), silent (coverage gap), biased (calibration drift), with per-detector freshness for operators.
8. **Reliability engineering**: precision by tier and failure mode, recall estimated with random audits, threshold editing with a backtest.

### Non-Functional Requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Safety path independence | Edge alarm works with the cloud down | Detector alarms are local; the cloud mirrors them, never gates them |
| Fresh-pass latency | Pass to alert < 30 s p99 for on-time data | A live lane that backlog can't block |
| Late data | Every pass up to 72 h old is processed and routed correctly | Order-independent state, event-time logic |
| Correctness under retries | Zero duplicate alerts, holds or work orders | Idempotency keys at every write |
| Availability | 99.95% for alerting, 99.9% for UIs (assumption) | Stateless API, replayable streams |
| Acknowledgment | CRITICAL acknowledged in 5 min, HIGH 15, MEDIUM 60 (illustrative) | Deadlines, escalation chains |
| Data retention | Raw readings 5 years (assumption) | Compressed columnar time-series storage |

## Capacity Estimation

### Production Scale

| Quantity | Estimate | Reasoning (assumptions unless cited) |
|----------|----------|------------------|
| Bearings and wheels | ~1.6M of each | 200K cars × 4 axles × 2 sides; BNSF cites 1.5M+ wheels |
| Car passes | ~1.6M/day | 40% of cars moving on a given day × ~20 detectors passed (≈300 mi at 15-mi spacing) |
| Sensor values | ~26M/day | 1.6M car passes × 8 bearings × 2 values (bearing, wheel). Same order as BNSF's 35M+ readings/day, which spans more detector types |
| Train passes | ~16K/day, ~0.2/s average, ~1/s peak | 1.6M car passes ÷ 100 cars per train |
| Pass payload | ~50 KB JSON, ~8 KB compressed | ~400 axles × 2 rails × 2 values plus AEI |
| Ingest bandwidth | <1 GB/day | 16K × 50 KB. Not a scaling problem |
| Raw storage | ~0.5 GB/day, ~1 TB over 5 years | 26M values × ~16 B compressed columnar |
| Hot trend state | ~0.5 GB | ~1,000 trains en route × 800 bearings × ≤16 observations × 32 B |
| Machine vision | ~600 GB/day | 2M+ images/day (BNSF) × ~300 KB, inference at the edge |
| Industry reference | ~100K train passes/day | Railinc EHMS: 36M/yr across ~10K detectors |

> Volume is small. A few thousand messages a minute and under a terabyte of raw data over five years fit on modest hardware. What makes this hard is correctness (identity, ordering, lateness), the latency of the safety path, and the human workflow around a decision that costs either hours of delay or a derailment. Vision images are the one large stream, and they stay in object storage with inference near the site.

### Local Development Scale

| Component | Local | Notes |
|-----------|-------|-------|
| Network | 3 subdivisions, 240 miles, 16 HBDs, 5 with AEI, 3 yards | `backend/src/shared/network.ts` |
| Scenario | 5 trains, 60–90 cars, ~8 simulated hours | 60× compressed by default |
| Readings | ~55K axle readings per run | One PostgreSQL table |
| Throughput | ~1 pass/s at 240× | One analyzer is plenty; two can run |

## High-Level Architecture

```
  WAYSIDE (per site)                                    CLOUD
 ┌────────────────────────────┐
 │ HBD scanners (N/S rail)    │ radio "talker" ──▶ crew   (safety path: local, never depends on cloud)
 │ hot/cold wheel · AEI · WILD│
 │ acoustic · vision portal   │
 │ site gateway: buffer, retry│
 └────────────┬───────────────┘
              │ store-and-forward over cellular/satellite (at-least-once, late, out of order)
              ▼
 ┌────────────────────────────┐    ┌─────────────────────────────┐
 │ Ingest API (stateless)     │───▶│ Raw store (ClickHouse /     │  passes + axle readings,
 │ mTLS per gateway, validate,│    │ Cassandra), idempotent key  │  immutable, keyed by pass
 │ dedupe (detector, pass id) │    └─────────────────────────────┘
 └──────┬──────────────┬──────┘    ┌─────────────────────────────┐
        │ fresh        │ late      │ Object storage (vision)     │
        ▼              ▼           └─────────────────────────────┘
 ┌─────────────┐ ┌─────────────┐
 │ Kafka: live │ │ Kafka:      │   both partitioned by trip id
 │ lane        │ │ backfill    │
 └──────┬──────┘ └──────┬──────┘
        └───────┬───────┘ (live first)
                ▼
 ┌─────────────────────────────────────────────┐    ┌───────────────────────────┐
 │ Stream processor (per-trip keyed state)     │◀──▶│ Reference: consist        │
 │ identity · per-bearing observation lists    │    │ versions, AEI, component  │
 │ trend features · rules + model score        │    │ installs, detector health │
 │ detector health · late-data routing         │    └───────────────────────────┘
 └──────────────┬──────────────────────────────┘    ┌───────────────────────────┐
                │ alert decisions (idempotent)  ◀───│ Predictive model service  │
                ▼                                   │ (optional; rules work     │
 ┌─────────────────────────────────────────────┐    │ without it)               │
 │ PostgreSQL: alerts, holds, work orders,     │    └───────────────────────────┘
 │ findings, ownership, audit, outbox          │
 └──────┬───────────────────┬──────────────────┘
        │ outbox            │ read APIs + SSE
        ▼                   ▼
 ┌──────────────────┐  ┌──────────────────────────────────────────────┐
 │ Notifier:        │  │ Dispatcher console · yard tablets ·          │
 │ desks, yards,    │  │ reliability dashboard · detector ops         │
 │ owners (EHMS),   │  └──────────────────────────────────────────────┘
 │ escalation timer │
 └──────────────────┘
```

**Two-tier alerting.** The detector's absolute alarm is computed at the site and announced to the crew locally. If the cloud, the network link or this whole system is down, trains are still stopped for hot bearings exactly as they are today. The cloud tier adds early warning (trending), fusion (several detectors and detector types), routing, ownership and the yard workflow. When an edge alarm arrives in the data, the cloud's CRITICAL alert mirrors it: it creates the incident record, holds the car and notifies the next yard, but it never decides whether the crew stops.

## Core Components

### 1. Site gateway and ingest

Each site's gateway buffers passes on local disk and forwards them when the link is up. It retries anything it hasn't seen acknowledged, delivers backlog in whatever order its queue gives, and sends heartbeats with its buffer depth.

The ingest API authenticates the gateway (mTLS in production, a shared token locally), validates the batch, and writes each pass with the detector-assigned `(detector_id, pass_id)` as its idempotency key. A pass is acknowledged only after its readings are committed. A retry of a known pass is acknowledged as a duplicate. A retry with the same key but different readings is a conflict: the first copy is kept and the conflict is logged.

After the commit, the pass is published to the **live lane** if it arrived within 15 minutes of being measured, or to the **backfill lane** if it is older. A site that reconnects with six hours of backlog fills the backfill lane, and the processor keeps draining live first, so the backlog can't delay a new critical reading from another site.

If the API dies between commit and publish, the gateway never got its 2xx and retries. The retry finds the pass stored but unpublished and publishes it. A sweep republishes anything left unpublished for a gateway that gave up.

### 2. Identity resolution

A detector reports "axle 109, north rail". The processor needs "NRLX 304512, bearing R3". The steps:

1. **Consist version by time.** Consists are versioned with an effective time (a train rebuilt at a yard gets a new revision from its departure). A pass is resolved against the revision in force when it was *measured*, so a late pass from before the rebuild still maps correctly.
2. **AEI correction.** At AEI-equipped sites the RFID read gives each unit's identity and which end leads. It overrides the consist for that revision (and for later revisions carrying the same car). Earlier passes of the trip are re-resolved, which is safe because raw columns never change.
3. **Axle count check.** If the detector's axle count disagrees with the consist and there is no AEI read, the pass stays *unresolved* instead of guessing. Guessing would pin readings on the wrong car.
4. **Car-relative position.** Rail plus direction gives the train side. Train side plus leading end gives the car side, and the axle order flips when the A-end leads. Axle 1 is at the B-end; L and R are named standing at the B-end facing the A-end. A car turned on a wye shows its R1 bearing on the other rail and at the other end of its axle sequence, but it is still R1.

```typescript
// backend/src/shared/geometry.ts
export function carRelativePosition(rail, direction, leadingEnd, seqInCar, axleCount) {
  const side = trainSide(rail, direction)            // EB: north rail = left
  if (leadingEnd === 'B') return { side: flip(side), axle: seqInCar }
  return { side, axle: axleCount + 1 - seqInCar }
}
```

### 3. Per-bearing state and trend features

The state for one bearing in one trip is the **ordered list of its observations, keyed by pass**, not a running accumulator. Each new pass, whether late, early or redelivered, is inserted into the list and the features are recomputed. With at most ~16 observations per bearing per trip, recomputing costs nothing, and it makes the answer independent of arrival order and duplicates.

Decisions need one more step, because alerts never de-escalate. The tier is the **maximum score over every event-time prefix** of the list, which is exactly what in-order processing would have decided. Scoring only the latest observation would ignore an old hot reading that arrives after a newer, normal one, although on time it would have opened an alert.

Features at the latest observation:

| Feature | Definition | Why |
|---------|------------|-----|
| Above ambient | bearing − ambient, corrected for known detector bias | What the detector's own alarm uses |
| Side delta | bearing − median of the same rail in the same pass | Cancels speed, load, braking zones, sun on one side, and a scanner's calibration offset |
| Rise per 15 mi | least-squares slope of side delta over distance, last ≤4 readings | Per mile, not per detector, so a silent detector stretches the axis instead of faking continuity |
| Consecutive elevated | trailing readings ≥ elevated threshold | Persistence |
| Rank in train side | percentile among that rail's bearings | Context for the dispatcher |
| History | elevated on N of the car's last 5 trips (on the current wheelset) | Slow degradation |
| Coverage gap | largest gap between readings | Annotates trends built across a silent detector |

Wheels are scored separately, because they are a different failure mode. A **hot wheel** (wheel ≥150°F over the train-side median at two consecutive detectors, illustrative) means a stuck or dragging brake. A **cold wheel** (≥50°F *below* the median in every braking zone, where every other car is braking) means an inoperative brake. Both are per-car brake alerts with a brake-inspection action, never bearing alerts.

### 4. Risk scoring and what a prediction means

Locally, tiers come from explainable rules over the features. Every tier lists the reasons that produced it, because a dispatcher who stops a two-mile train needs to say why. Illustrative defaults:

| Tier | Bearing rule (illustrative, editable) | Action |
|------|---------------------------------------|--------|
| CRITICAL | Detector alarm fired, or ≥195°F above ambient | Stop and inspect (mirrors the edge alarm) |
| HIGH | ≥150°F above ambient, or ≥+60°F vs median and rising ≥8°F/15 mi | Set out at the next siding, or restricted speed to the next inspection point |
| MEDIUM | ≥+35°F at 2+ detectors, or a single +45°F outlier, or rising ≥6°F/15 mi over 4+ readings | Inspect at the next terminal: car hold plus work order |
| LOW | ≥+20°F at 2+ detectors, or warm now and elevated on 2+ recent trips | Monitor, notify the owner, schedule maintenance |

**What a prediction means.** In production a model adds a score next to the rules. It is defined as an **inspection priority over a horizon**: the probability that this bearing would be found defective if inspected at the next inspection opportunity (the next terminal on its route). It is not a time-to-failure promise. The score can raise a tier or reorder a queue, but it never suppresses a rule tier: the rules are the floor. If the model service is down, every rule keeps working, alerts still open and route, and the UI marks predictions as unavailable. Only the reordering degrades.

**Asymmetric costs.** A false CRITICAL or HIGH stops or slows a train: hours of crew time and network delay, and every needless stop teaches crews and dispatchers to doubt the system. A false MEDIUM costs a yard inspection and a held car. A missed failing bearing can derail a train. Thresholds are set per tier by expected cost (P(defect) × cost of failure vs cost of the action) under an **alert-fatigue budget**: a target number of MEDIUM holds per 1,000 car passes the yards can actually inspect. The admin backtest shows what a change does to both.

**Label bias.** Findings only exist for cars that something flagged, so precision is measurable and misses are not. Three mitigations: random **audit inspections** of unflagged cars (locally, one per arriving train); **teardown results** from bearing shops on every removed bearing, flagged or not; and defects found on **routine inspections**, which count as misses. Recall is estimated from these, and the model is trained with these labels weighted for how cars came to be inspected.

### 5. Alert lifecycle and ownership

```
 opened ──▶ delivered ──▶ acknowledged ──▶ inspected ──▶ closed
   │          (provider      (a person        (finding      (released, or
   │           accepted)      owns it)         recorded)     repaired)
   │
   ├── escalated in place (higher tier; new deadline; may change owner)
   ├── ack overdue ─▶ next role (desk ▶ chief dispatcher ▶ NOC; yard ▶ general foreman ▶ NOC)
   ├── approaching yard, unacknowledged ─▶ that yard's supervisor
   └── handoff (train entered another desk's territory, or passed the yard) ─▶ new owner must re-acknowledge
```

- **One open alert per bearing (or per car, for brakes) per trip**, enforced by a partial unique index. New evidence escalates it in place. It never silently de-escalates: a bearing that cools after a braking zone still needs a person to close it.
- **Owner.** HIGH and CRITICAL belong to the dispatcher desk for the train's current territory. MEDIUM belongs to the inspectors at the yard that must catch the car. LOW is an owner notice that needs no acknowledgment.
- **Delivered is not acknowledged.** The notifier records when the provider accepted the message. The ack deadline runs from opening, and a sweeper escalates overdue alerts up the chain. It also warns the next yard's supervisor when an unacknowledged alert's train is within 30 minutes of that yard (illustrative), because by then a late page is useless.
- **Handoff.** When the train crosses into another desk's territory, a dispatcher-owned alert moves to the new desk and must be acknowledged again. When a held car goes past its yard uninspected, the hold and work order move to the next yard. Each move is an audit event and a notification.
- **Audit trail.** `alert_events` records every transition, actor and reason, deduplicated so a redelivered pass can't repeat one.

### 6. Late-data routing

How late the evidence is (measured to received, in event time) and where the train is now (dead reckoning from its newest pass by measurement time) decide the route:

| Situation | Routing |
|-----------|---------|
| Fresh, train en route | Normal tier routing |
| Late, train still en route | Same tier; the note says how old the data is and how far the train has moved since |
| Late, train already arrived | MEDIUM and above go to the arrival yard: "hold and inspect before release", no dispatcher page for a stopped train |
| CRITICAL computed late | Incident record; the crew already had the edge alarm |

### 7. Component lifecycle

A railcar outlives its wheelsets, and a wheelset carries both bearings of its axle. Installs are events with an **event time** (when it went on the car) and a **processing time** (when we were told). The wheelset on each axle at any moment is rebuilt from install and remove events.

> Follow-up: "A detector reconnects and uploads a concerning reading recorded 2 hours ago, but that wheelset was replaced 1 hour ago." The reading is stored, resolved to the car and axle, and kept as history of the *previous* wheelset. Scoring uses only readings whose event time is after the current install, so it never counts against the new wheelset, however late it arrives. An open alert whose evidence all predates the install is closed as `component_replaced`. History rules also count only trips on the current wheelset.

### 8. Yard workflow

A MEDIUM-or-higher alert creates a **car hold** and a **work order** at the predicted yard. The yard's train-building system asks the hold service before adding cars to an outbound train, and held or bad-ordered cars are refused. The inspector starts the inspection (which acknowledges the alert) and records a finding from a tablet that may be offline.

| Finding | Allowed dispositions | Alert after |
|---------|---------------------|-------------|
| Journal bearing defect | bad order, or repaired (new wheelset id and install time) | inspected (bad order) or closed (repaired) |
| Brake defect (stuck/inoperative) | bad order, repaired | same |
| Wheel tread defect | bad order, repaired | same |
| No defect found | release | closed |

A bad-ordered car stays *inspected*, with its hold, until the repair is recorded as a component install, which then closes the alert and releases the hold.

### 9. Detector health

| State | Detected by | Meaning for trends |
|-------|-------------|--------------------|
| Offline | No gateway heartbeat for 25 min | Data is buffered and will arrive late (backfill lane) |
| Silent | ≥2 trains seen on both sides but not here, while heartbeats are fine | Nothing is coming: a coverage gap, flagged on any trend that spans it |
| Biased | Mean over ≥3 trains of (this detector's train median above ambient − its neighbours' for the same train) ≥ 12°F | Absolute features corrected by the offset; relative features are unaffected |

Operators see coverage per detector: *live*, *delayed* (buffering at the site), *catching up* (backlog queued) or *gap*, and the stretches of line longer than the configured spacing with no working detector.

### Worked example: one successful trace

M-HARRID eastbound, bearing R3 of NRLX 304512 slowly failing (the East Palestine pattern):

1. **HBD-055 (MP 55)**: the bearing reads +29°F over the north-rail median and has risen steadily since MP 10. The gateway posts the pass, the API commits it and publishes to the live lane, and replies 201.
2. The processor takes the trip's advisory lock, resolves axle 109 north rail to NRLX 304512 R3 (consist revision 1, B-end leading), recomputes every bearing's features from the trip's observations, and scores R3 **MEDIUM** ("steady rise, 7°F per 15 mi over 4 readings").
3. In one transaction it opens the alert (owner: Cedar Junction yard, ack due in 60 min), places the hold and work order at CDJ, writes outbox rows for the yard and the owner NRLX, and marks the pass processed. Then it acks the stream message and publishes a live notice. The dispatcher queue and CDJ tablets refresh over SSE.
4. The notifier delivers the messages: *delivered*, not acknowledged. Nobody at CDJ acknowledges. The sweeper escalates to the CDJ general foreman, then warns CDJ's supervisor when the train is 30 minutes out.
5. **HBD-126**: +72°F and rising 9°F per 15 mi, so the alert escalates in place to **HIGH**. The owner becomes the West desk dispatcher, ack due in 15 minutes. The train has passed CDJ uninspected, so the hold and work order move to Ridgeway.
6. **MP 160**: the train enters the East desk's territory, so the alert is handed off to East, which must acknowledge again.
7. **HBD-230**: the detector's own alarm fires and is radioed to the crew. The pass carries it, and the alert escalates to **CRITICAL**, mirroring it. The trend flagged the bearing 175 miles earlier.

### Worked example: one failed trace

The analyzer dies between committing pass HBD-112 and acknowledging its stream message:

1. Q-HARCDJ's pass at HBD-112 sat in the gateway buffer for 70 minutes. It arrives through the **backfill lane** after the train reached Cedar Junction.
2. Analyzer A commits: the SVTX 961204 L1 alert opens as MEDIUM, routed `yard_post_arrival` to CDJ with a hold, and the pass is marked `processed_at`. Then A is killed before `XACK`.
3. The message stays pending on A's consumer name. After 30 s idle, analyzer B's reclaim loop claims it with `XAUTOCLAIM` and calls `processPass`.
4. B locks the pass row, sees `processed_at` set, returns `already_processed`, and acks. No second alert, hold, work order or notification exists. Each of those writes is also keyed (partial unique index, `alert_id` unique on holds and work orders, notification `dedupe_key`), as a backstop.
5. Meanwhile the gateway, which never saw a reply to one retry, posts the same batch again. Ingest answers 200 with `duplicates: 4` and changes nothing.

## Database Schema

The full schema is `backend/src/db/init.sql`. Key tables (production splits raw readings into ClickHouse or Cassandra; locally everything is PostgreSQL):

```sql
-- Raw passes: (detector_id, pass_id) is the idempotency key assigned by the detector.
CREATE TABLE detector_passes (
  detector_id TEXT NOT NULL, pass_id TEXT NOT NULL, trip_id TEXT NOT NULL,
  passed_at TIMESTAMPTZ NOT NULL,      -- event time
  received_at TIMESTAMPTZ NOT NULL,    -- processing time (domain clock)
  lag_seconds INT GENERATED ALWAYS AS (GREATEST(0, EXTRACT(EPOCH FROM (received_at - passed_at)))::int) STORED,
  axle_count INT NOT NULL, aei JSONB, edge_alarms JSONB, payload_sha TEXT NOT NULL,
  identity_status TEXT NOT NULL,       -- pending | resolved | unresolved | awaiting_consist
  median_bearing_n NUMERIC, median_bearing_s NUMERIC,
  published_at TIMESTAMPTZ, processed_at TIMESTAMPTZ,
  PRIMARY KEY (detector_id, pass_id)
);

-- Raw columns never change; resolved columns are derived and rewritten on AEI correction.
CREATE TABLE axle_readings (
  detector_id TEXT, pass_id TEXT, axle_seq INT, rail CHAR(1), bearing_f NUMERIC, wheel_f NUMERIC,
  car_id TEXT, unit_position INT, car_axle INT, car_side CHAR(1),
  PRIMARY KEY (detector_id, pass_id, axle_seq, rail)
);

-- Consists are versioned by effective time; units carry orientation and how it was learned.
CREATE TABLE trip_consist_versions (trip_id TEXT, revision INT, effective_at TIMESTAMPTZ, PRIMARY KEY (trip_id, revision));
CREATE TABLE trip_units (
  trip_id TEXT, revision INT, position INT, unit_id TEXT, unit_type TEXT, axle_count INT,
  leading_end CHAR(1), orientation_source TEXT, corrected_by_detector TEXT,
  PRIMARY KEY (trip_id, revision, position)
);

-- Wheelset installs as events: event time vs processing time.
CREATE TABLE component_installs (
  id UUID PRIMARY KEY, car_id TEXT, axle INT, component_id TEXT,
  installed_at TIMESTAMPTZ NOT NULL, removed_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ NOT NULL, ...
);
CREATE UNIQUE INDEX component_installs_current ON component_installs (car_id, axle) WHERE removed_at IS NULL;

CREATE TABLE alerts (
  id UUID PRIMARY KEY, trip_id TEXT, car_id TEXT,
  kind TEXT CHECK (kind IN ('hot_bearing', 'hot_wheel', 'cold_wheel')),
  position TEXT, tier SMALLINT, status TEXT CHECK (status IN ('open', 'acknowledged', 'inspected', 'closed')),
  owner_role TEXT, owner_id TEXT, escalation_level SMALLINT, ack_due_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ, inspected_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
  routing TEXT, desk_id TEXT, yard_id TEXT, reasons JSONB, features JSONB,
  data_lag_seconds INT, late BOOLEAN, version INT, ...
);
CREATE UNIQUE INDEX alerts_one_open_per_bearing ON alerts (trip_id, car_id, kind, position) WHERE status <> 'closed';

CREATE TABLE car_holds   (id UUID PRIMARY KEY, car_id TEXT, alert_id UUID UNIQUE, yard_id TEXT, status TEXT, ...);
CREATE TABLE work_orders (id UUID PRIMARY KEY, alert_id UUID UNIQUE, audit_key TEXT UNIQUE, kind TEXT, yard_id TEXT, ...);
CREATE TABLE findings    (id UUID PRIMARY KEY, client_submission_id TEXT UNIQUE, work_order_id UUID UNIQUE,
                          source TEXT,  -- alert | audit | routine | teardown
                          finding TEXT, disposition TEXT, observed_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ, ...);
CREATE TABLE notifications (id BIGSERIAL, alert_id UUID, channel TEXT, target TEXT, dedupe_key TEXT UNIQUE,
                            created_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, ...);
```

Supporting tables: `alert_events` (audit trail, deduplicated), `expected_passes` (which detectors each trip should have reported, for silence), `detector_bias_samples`, `bearing_trip_summary` (per-trip, per-bearing history), `thresholds` (versioned config), `detectors`, `trips`, `railcars`.

## API Design

```
POST /api/v1/ingest/passes          gateway batch; idempotent per (detector, pass); 201 new / 200 all duplicates
POST /api/v1/ingest/heartbeats      buffer depth, self-test
POST /api/v1/ingest/consists        versioned consist (revision, effectiveAt)
POST /api/v1/ingest/trip-events     departed / arrived (arrival schedules an audit inspection)

GET  /api/v1/alerts                 queue: status, tier, territory (desk or subdivision), late
GET  /api/v1/alerts/:id             alert + audit trail + notifications
POST /api/v1/alerts/:id/acknowledge owner only; If-Match style version in body; 409 if it escalated meanwhile
GET  /api/v1/trips, /trips/:id, /trips/:id/heatmap
GET  /api/v1/cars/:id, /cars/:id/trend?position=R3
POST /api/v1/cars/:id/components    wheelset install (event time); closes inspected alerts on that axle
GET  /api/v1/yards/:id/work-orders, /yards/:id/holds
POST /api/v1/yards/:id/outbound-check   which cars may go in an outbound train
POST /api/v1/work-orders/:id/start      inspection started (= yard acknowledgment)
POST /api/v1/work-orders/:id/finding    clientSubmissionId makes it idempotent; replay returns the stored finding
GET  /api/v1/network, /network/detectors/:id   detectors, coverage, lane backlog
GET/PUT /api/v1/admin/thresholds, POST /admin/thresholds/preview, GET /admin/metrics
GET  /api/v1/events                 SSE notices (ids only), filtered by role
```

Example ingest response:

```json
{ "accepted": 3, "duplicates": 1, "conflicts": 0,
  "results": [{ "detectorId": "HBD-112", "passId": "20261105T131754", "status": "accepted", "lagMinutes": 101, "late": true, "lane": "backfill" }] }
```

## Key Design Decisions

### 1. Trending on relative features, with absolute thresholds kept at the edge

The detector's absolute alarm is the right safety backstop: simple, local, explainable, independent of any network. It is also late by design. NTSB's account of East Palestine shows a bearing rising across two detectors below the threshold before the third reached critical. Trending on the delta vs the train-side median catches the rise early, and it is robust where absolute values are not: speed, load, braking zones, sun and a scanner's calibration offset all shift the whole rail together. The cost is more alerts below the absolute line, each of which needs an owner and a yard's time. That is why the middle tiers ask for an inspection at the next terminal rather than a stop, why holds are budgeted, and why findings feed back into thresholds.

### 2. Partition by trip, not by car

Relative features need every axle of a pass together (the train-side median), and trend features need every pass of a trip. Keying Kafka by trip id puts both in one partition and one processor's state, with one writer per trip. Keying by car would scatter each pass across ~100 partitions and need a shuffle to compute any median, and a consist rebuild would have to coordinate across them. Cross-trip car history is slower-moving and read from a per-car summary store at scoring time, where minutes of staleness are harmless. The cost: per-car state isn't co-located, so history features are eventually consistent, and a trip that is very long-lived holds state longer. Locally, a per-trip advisory lock gives the same single-writer guarantee over a consumer group.

### 3. Per-bearing state is a list of observations, recomputed

A running accumulator (last value, EWMA, slope) breaks under out-of-order arrival: the late MP 112 pass would be folded in after MP 126 as if it came later. Keeping the observations keyed by pass and recomputing makes late data, duplicates and redelivery give the same answer as perfect data, and makes re-resolution after an AEI correction a rewrite of the inputs rather than a correction of a derived value. Scoring the maximum over event-time prefixes makes the *decision*, not just the features, independent of arrival order. The cost is recomputation and storage of ≤16 points per bearing per trip, which is negligible.

### 4. Two lanes for live and backfill

One stream in arrival order means a site that reconnects with hours of backlog puts every other site's fresh readings behind it. Splitting by lateness at ingest gives live readings a lane backlog can't touch. The processor drains live first and takes backfill a few messages at a time. Both lanes still go through the same per-trip lock, so a late pass and a fresh one for the same train are serialized. The cost is a second topic and a priority policy to tune.

### 5. Ownership with deadlines, not notifications

A message the provider accepted is not a person who knows. Each alert has one owner, a tier-based deadline and an escalation chain. Handoffs are explicit when the train moves on. This adds a sweeper and an audit trail, and acknowledging becomes part of the dispatcher's and inspector's job. Without it, the failure mode is the follow-up the design must answer: delivered, unacknowledged, and the train arriving at a yard that doesn't know to catch the car.

### 6. Event time everywhere, rebuilt from events

Lateness, trip position, consist revisions and component installs are all decided by when things *happened*, not when we heard. State is rebuilt from events, so a late install or a late pass converges on the same answer.

## Consistency and Idempotency

| Write | Key | On retry |
|-------|-----|----------|
| Pass + readings | `(detector_id, pass_id)` | 200 duplicate; republish if unpublished; conflict if payload differs |
| Stream processing | `processed_at` on the pass, inside the transaction | Skipped and acked |
| Alert | partial unique `(trip, car, kind, position) WHERE status <> 'closed'` | Escalate in place |
| Alert transition | `alert_events (alert, kind, tier, pass)` unique | Ignored |
| Hold, work order | `alert_id` unique | `ON CONFLICT DO NOTHING / GREATEST(priority)` |
| Notification | `dedupe_key` (alert:channel:tier) | Ignored |
| Finding | `client_submission_id` unique, one per work order | Returns the stored finding (200, `replayed`) |
| Component install | `client_submission_id` unique; one current per axle | Returns the stored install |
| Audit inspection | `audit_key` = trip id | Ignored |
| Acknowledge, thresholds | `version` check | 409 with the current state |

Ordering: only per-trip order matters, and it is recovered from event time, not arrival. Nothing requires global order.

## Security / Auth

- Gateways: per-gateway mTLS certificates and a gateway-to-detector allowlist in production (a shared `X-Ingest-Token` locally). A gateway can only post its own detectors.
- Users: session cookies in Valkey, bcrypt passwords. Roles: dispatcher (a desk), yard car inspector (one yard), reliability engineer (admin).
- Enforcement in the API, not the UI: yard users only see and act on their yard's alerts, work orders and holds. Only the owner role can acknowledge. Live SSE notices are filtered per viewer, and carry ids only: the browser refetches through the same access-checked read APIs, so the async path never widens access.
- Car owners (lessors) receive notices only about their own cars, through the industry's alert-routing channel.

## Observability

- Metrics (`prom-client`, `backend/src/shared/metrics.ts`): passes ingested by outcome, ingest lag histogram, passes processed by outcome and lane, processing time by lane, alert transitions by tier and lateness, ack escalations by reason, stream redeliveries and dead letters, SSE connections.
- Structured logs (Pino) with detector, pass and trip ids on every processor decision.
- Product metrics on the reliability page: precision by tier and failure mode, recall proxy, audit defect rate, alerts per 1,000 car passes (the fatigue budget), late-pass share, open holds.
- Detector health is itself an operational dashboard.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Cloud or link down | Edge alarms still stop trains; gateways buffer; backfill on recovery |
| API dies after commit, before publish | Gateway retry publishes; republish sweep as backstop |
| Processor dies after commit, before ack | Message reclaimed; `processed_at` makes it a no-op |
| Poison pass | Dead-lettered after 5 deliveries; trip continues |
| Consist not yet received | Pass parked as `awaiting_consist`, republished when it arrives |
| Axle count mismatch, no AEI | Pass unresolved, not guessed; counted on the reliability page |
| Biased detector | Absolute features corrected; maintenance flagged |
| Silent detector | Coverage gap shown; trends computed per mile |
| One detector flags nearly every train | Treated as a detector fault: relative features don't move, so the bias check flags it; its absolute-only alerts are quarantined into a maintenance ticket instead of a dispatcher storm; the railroad's own out-of-service rules govern the edge alarm |
| Model service down | Rules keep alerting; predictions marked unavailable |
| Nobody acknowledges | Escalation chain; approaching-yard warning |

## Scalability Considerations

- **What breaks first is people, not machines.** At ~0.2 passes/s, compute and storage are easy. The first limit is how many holds yards can inspect and how many pages dispatchers will read before they stop trusting them. The evidence is the alert-volume and precision tiles. Threshold changes are judged by their effect on both.
- **Processor state** scales by trip partitions. ~1,000 concurrent trains and ~0.5 GB of state fits on a few instances; more partitions as traffic grows.
- **Raw store**: columnar, partitioned by day, ordered by (detector, time); car history served from a per-car summary table rather than scans.
- **Backfill storms**: after a regional outage, thousands of sites reconnect at once. The backfill lane absorbs them at its own pace without affecting live.
- **Read side**: alert queues and yard queues are small, indexed lists. SSE notices fan out per instance from pub/sub.
- **Multi-region**: active-passive for PostgreSQL. Ingest can run in two regions because writes are idempotent.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Safety path | Edge alarm stays local | Cloud decides stops | Must work with the cloud down |
| Main signal | Delta vs train-side median, trended | Absolute temperature only | Earlier, and cancels speed, sun, braking, calibration |
| Stream key | Trip id | Car id | Medians and trends need the whole pass and trip together |
| Bearing state | Observation list, tier = max over event-time prefixes | Running accumulator, latest only | Arrival order can't change the decision |
| Late data | Separate backfill lane | One arrival-ordered stream | Backlog can't delay fresh readings |
| Identity | Consist version by time + AEI override | Current consist | Rebuilt and turned cars stay correct |
| Unresolvable pass | Leave unresolved | Best-effort mapping | Wrong-car alerts are worse than none |
| Escalation | In place, never auto-de-escalate | New alert per reading | One record, a human closes it |
| Acknowledgment | Owner + deadline + chain + handoff | Fire-and-forget notifications | Delivered ≠ seen |
| Components | Install events, event-time filter | Car-level history only | Replacements must reset evidence |
| Labels | Findings + random audits + teardowns | Findings only | Selection bias hides misses |
| Prediction | Inspection priority over the next-terminal horizon, additive to rules | Model replaces rules | Rules keep working when the model is down |
| Live updates | SSE notices with ids, REST refetch | WebSocket state push | One-way; no state to diverge |

## Design Review Checklist

1. **Source of truth, and when a write succeeds.** Raw passes in the raw store; alerts, holds, work orders and findings in PostgreSQL. An ingest write succeeds when the pass and its readings commit (then 2xx). A processor decision succeeds when its transaction commits (then ack).
2. **Client retries after losing the response.** Gateways: same `(detector, pass)` gives a duplicate, and republish if it never reached the stream. Tablets: same `clientSubmissionId` gives the stored finding. Dispatchers: a stale `version` gets 409 with the current alert.
3. **Worker fails between two steps.** API between commit and publish: retry or sweep republishes. Processor between commit and ack: reclaimed and skipped. Notifier between send and mark: resend is deduplicated by the channel's own id (`dedupe_key`).
4. **Required ordering.** Per-trip, by event time, reconstructed from the data. No global order. Per-trip single writer via partitioning (locally, an advisory lock).
5. **Access with caches and async jobs.** The processor writes as a system principal, but every read goes through role checks. SSE carries ids only and is filtered per viewer. Owner notices are scoped to the owner's cars.
6. **What breaks first at 10–100×.** Human capacity (holds per yard per shift, pages per desk), shown by the alert-volume and precision metrics; then backfill bursts after regional outages, shown by lane backlog; storage and compute last.

## Implementation Notes

### Local architecture

```
simulator ──HTTP──▶ api (:3000) ──▶ PostgreSQL (passes, readings, alerts, holds, findings, ...)
 (60× clock          │  └─ XADD ──▶ Valkey streams rh:passes:live / rh:passes:backfill
  in Valkey)         │                        │
                     │                        ▼
 browser ◀──SSE──────┤◀── pub/sub ◀──── analyzer (consumer group; lifecycle + health sweepers)
 (:5173)  ──REST────▶┘
```

| Process | Entry | Role |
|---------|-------|------|
| API | `backend/src/api/index.ts` | Ingest, read APIs, yard workflow, admin, SSE, republish sweep |
| Analyzer | `backend/src/analyzer/index.ts` | Two-lane consumer, identity, trends, scoring, alerts, health job, lifecycle sweeper (delivery, deadlines, escalation) |
| Simulator | `backend/src/simulator/index.ts` | The scenario in compressed time; publishes the simulation clock |
| Frontend | `frontend/` | Alert queue, train heatmap, car trends, yard tablet, detector health, reliability |

### Production-grade patterns actually implemented

- **Idempotent ingest with a retry-driven outbox** (`api/services/ingest.ts`). The pass key is the detector's; publish happens after commit; a retry or the sweep republishes anything committed but unpublished; payload hashes detect conflicting retries.
- **Consumer group with ack-after-commit, reclaim and dead letters** (`analyzer/consumer.ts`). `XAUTOCLAIM` after 30 s idle; dead-letter after 5 deliveries.
- **Live and backfill lanes** (`shared/stream.ts`, `analyzer/consumer.ts`). The lane is chosen at ingest by lag; the consumer drains live, then takes 2 backfill messages, then checks live again.
- **Single writer per trip** (`analyzer/pipeline.ts`): `pg_advisory_xact_lock(hashtext(trip_id))`, the local equivalent of Kafka partitioning by trip.
- **Order-independent trend state and decisions** (`analyzer/trend.ts`, `scoreOverHistory` in `analyzer/risk.ts`), unit-tested with shuffled input and with a late hot reading arriving after a newer normal one.
- **Identity resolution** with consist versions by time, AEI correction and re-resolution (`analyzer/identity.ts`, `analyzer/resolve.ts`).
- **Component lifecycle** (`analyzer/components.ts`, `api/services/findings.ts`). Install events, an event-time filter in scoring and history, and alerts closed as `component_replaced`. Demonstrated by `npm run demo:component-swap`.
- **Alert ownership** (`analyzer/ownership.ts`, `analyzer/lifecycle-job.ts`, `analyzer/alert-manager.ts`): tier deadlines, guarded escalation updates, approaching-yard warnings, handoffs, a deduplicated audit trail.
- **Detector health** from the data (`analyzer/detector-health.ts`, `analyzer/health-inputs.ts`): bias by neighbour comparison on the same trains, silence by expected passes, offline by heartbeats.
- **Prometheus metrics, Pino logs, health and readiness endpoints, login rate limiting** (`shared/metrics.ts`, `shared/logger.ts`, `shared/rate-limit.ts`).
- **Offline-tolerant, idempotent finding entry** on the tablet (`frontend/src/services/offline-queue.ts`).

```typescript
// analyzer/pipeline.ts: event time, not processing time
const cutoffs = await installCutoffs(client, carIds)
const { current: rows, previous } = splitByInstall(allRows, cutoffs) // previous = history of the old wheelset
```

### Simplified or substituted

- **Valkey Streams for Kafka**, carrying pointers rather than payloads; one PostgreSQL table for raw readings instead of a time-series store.
- **Rules instead of a model.** The explainable rules stand in for the rules tier; no ML model is trained. The backtest re-scores stored features against findings.
- **Simulated time.** The simulator compresses time and publishes a clock mapping to Valkey; the API and the analyzer read it, so lateness and position use simulated time. Operational timestamps use database time.
- **Every pass carries its train id.** In production, non-AEI sites are matched to trains from train-movement (PTC) positions.
- **A simulated notifier** marks messages delivered; there is no real paging provider, and there are no users for the chief dispatcher, general foreman or operations-center roles (admins can act for them).
- **Session auth and a shared ingest token** instead of mTLS.
- **Seeded history** (two earlier trips of one car, 48 labeled alerts, 36 audits, 3 routine findings) instead of months of operation; the numbers are illustrative.

### Omitted

- WILD (impact load), acoustic bearing detectors and machine-vision portals (described above, not simulated), and multi-sensor fusion beyond bearings and brakes.
- The industry alert-routing integration (EHMS-style) and real owner notification.
- Multi-region deployment, Kubernetes, partition management, long-term raw-data tiering.
- Teardown-result ingestion (the `teardown` finding source exists; nothing produces it).
- Detector-fault alert-storm quarantine (bias detection is implemented; automatic quarantine of a faulty detector's absolute-only alerts is not).
