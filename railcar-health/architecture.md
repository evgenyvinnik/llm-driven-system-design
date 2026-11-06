# Railcar Health - Architecture

## System Overview

A hot-bearing and hot/cold-wheel monitoring and predictive maintenance system for a fleet of about 200,000 railcars. Wayside detectors measure every axle of every passing train. This system turns those readings into risk alerts, routes them to the people who can act, and runs the yard response: hold the car, inspect it, record what was found, repair or release it.

The detector already raises its own alarm. A hot bearing detector (HBD) that sees a bearing over its absolute threshold announces it to the train crew over the radio, and the crew stops under operating rules. That path is safety-critical and must never depend on this system. What this system adds is everything a single detector can't see on its own:

- **Trending across detectors.** A bearing that runs 30°F hotter than the rest of its train at five detectors in a row is failing, even though no single reading is alarming.
- **Identity.** Which car, which bearing, regardless of which way the car faces, across trips and wheelset replacements.
- **Routing and ownership.** The dispatcher for the train's current territory, the mechanical forces at its next yard, the car's owner, each with a deadline.
- **The yard workflow and its feedback.** Inspection findings are the labels that measure precision and calibrate thresholds.

It is built as an **event-driven application**. Alert cases and car component histories are event-sourced aggregates in a PostgreSQL event store; raw readings are an append-only fact log announced through a transactional outbox; a relay publishes every event to one broker stream per event family; and idempotent consumer groups (the analyzer, a notifier, a work-order integration, a process manager with durable timers, and four projections) react to them. See [Event-Driven Design](#event-driven-design) and the [event catalog](./events.md).

Learning goals:

- Tolerate at-least-once, out-of-order and hours-late data from store-and-forward gateways without changing any answer.
- Keep a bearing's identity stable when the consist is stale, the car was turned, the train was rebuilt or the wheelset was replaced.
- Design for asymmetric costs: a needless stop costs hours of network delay, a missed bearing can derail a train.
- Treat delivered, acknowledged, inspected and closed as separate states, each with an owner.
- Know when to event-source (a case decided by many actors over hours) and when not to (millions of independent readings), and get exactly-once effects out of at-least-once delivery.

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
 │ Kafka: live │ │ Kafka:      │   wayside.readings.*, keyed by trip id
 │ lane        │ │ backfill    │   (claim-check events; readings stay in the raw store)
 └──────┬──────┘ └──────┬──────┘
        └───────┬───────┘ (live first)
                ▼
 ┌─────────────────────────────────────────────┐    ┌───────────────────────────┐
 │ Stream processor = analyzer consumer group  │◀──▶│ Reference: consist        │
 │ identity · per-bearing observation lists    │    │ versions, AEI, car streams│
 │ trend features · rules + model score        │    │ (component history),      │
 │ case decisions (expected stream versions)   │    │ detector health           │
 └──────────────┬──────────────────────────────┘    └───────────────────────────┘
                │ appends events, one transaction per pass ◀── Predictive model service (optional)
                ▼
 ┌─────────────────────────────────────────────┐    ┌───────────────────────────┐
 │ PostgreSQL EVENT STORE + OUTBOX             │───▶│ Projections (read models):│
 │ case-* and car-* streams: source of truth   │    │ alert queue · car history │
 │ pass-* / trip-* rows: outbox for state      │    │ detector health ·         │
 │ case_index (set invariants, hold check)     │    │ reliability facts         │
 └──────┬──────────────────────────────────────┘    └─────────────┬─────────────┘
        │ relay / CDC, by global position                         │ read APIs + SSE
        ▼                                                         ▼
 ┌─────────────────────────────────────────────┐    ┌──────────────────────────────────┐
 │ Kafka topics: identity · trends ·           │    │ Dispatcher console · yard tablets│
 │ trips.position (compacted) · cases · cars · │    │ reliability · detector ops ·     │
 │ detectors.health (compacted) · dead letters │    │ event timelines · ops / streams  │
 └──────┬──────────────────────────────────────┘    └──────────────────────────────────┘
        ▼ consumer groups (choreography)
   notifier (desks, yards, owners via EHMS) · work-order integration (yard maintenance)
   ack process manager (durable timers: the one orchestrated flow) · projectors
```

**Two-tier alerting.** The detector's absolute alarm is computed at the site and announced to the crew locally. If the cloud, the network link or this whole system is down, trains are still stopped for hot bearings exactly as they are today. The cloud tier adds early warning (trending), fusion (several detectors and detector types), routing, ownership and the yard workflow. When an edge alarm arrives in the data, the cloud's CRITICAL alert mirrors it: it creates the incident record, holds the car and notifies the next yard, but it never decides whether the crew stops.

## Core Components

### 1. Site gateway and ingest

Each site's gateway buffers passes on local disk and forwards them when the link is up. It retries anything it hasn't seen acknowledged, delivers backlog in whatever order its queue gives, and sends heartbeats with its buffer depth.

The ingest API authenticates the gateway (mTLS in production, a shared token locally), validates the batch, and writes each pass with the detector-assigned `(detector_id, pass_id)` as its idempotency key. A pass is acknowledged only after its readings are committed. A retry of a known pass is acknowledged as a duplicate. A retry with the same key but different readings is a conflict: the first copy is kept and the conflict is logged.

After the commit, the pass is published to the **live lane** if it arrived within 15 minutes of being measured, or to the **backfill lane** if it is older. A site that reconnects with six hours of backlog fills the backfill lane, and the processor keeps draining live first, so the backlog can't delay a new critical reading from another site.

There is no separate publish step to lose. The pass rows and their `PassRecorded` / `AxleReadingsRecorded` events commit in one transaction (the transactional outbox); the relay publishes them afterwards. If the API dies mid-request, nothing was committed and the gateway, which never got its 2xx, retries.

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
- **Delivered is not acknowledged.** The notifier records when the provider accepted the message. The ack deadline runs from opening, and a process manager with durable timers escalates overdue alerts up the chain. It also warns the next yard's supervisor when an unacknowledged alert's train is within 30 minutes of that yard (illustrative), because by then a late page is useless.
- **Handoff.** When the train crosses into another desk's territory, a dispatcher-owned alert moves to the new desk and must be acknowledged again. When a held car goes past its yard uninspected, the hold and work order move to the next yard. Each move is an audit event and a notification.
- **Audit trail.** The case's own event stream is the audit trail: every transition, actor, reason, event time and recorded time, with the correlation and causation that link it to the pass that triggered it. A redelivered pass can't repeat a transition (processed events, expected versions).

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
3. In one transaction it records the message as processed and appends `AlertRaised` (owner: Cedar Junction yard, ack due in 60 min), `CarHoldPlaced`, `WorkOrderOpened` and `NotificationRequested` for the yard and the owner NRLX to a new case stream, plus `BearingTrendUpdated` and `TripPositionUpdated`. Then it acks. The relay publishes the events; the alert-queue projection applies them and the dispatcher queue and CDJ tablets refresh over SSE.
4. The notifier appends `NotificationDelivered`: *delivered*, not acknowledged. Nobody at CDJ acknowledges. The process manager's durable timer fires: `AckDeadlineMissed`, escalated to the CDJ general foreman; an approach timer later appends `ApproachingYardWarned` when the train is 30 minutes out.
5. **HBD-126**: +72°F and rising 9°F per 15 mi, so `AlertEscalated` to **HIGH**. The owner becomes the West desk dispatcher, ack due in 15 minutes. The train has passed CDJ uninspected, so on the next `TripPositionUpdated` the process manager appends `CarHoldMoved` to Ridgeway.
6. **MP 160**: the train enters the East desk's territory: `AlertHandedOff` to East, which must acknowledge again.
7. **HBD-230**: the detector's own alarm fires and is radioed to the crew. The pass carries it, and the alert escalates to **CRITICAL**, mirroring it. The trend flagged the bearing 175 miles earlier.

### Worked example: one failed trace

The analyzer dies between committing pass HBD-112 and acknowledging its stream message:

1. Q-HARCDJ's pass at HBD-112 sat in the gateway buffer for 70 minutes. Ingest commits it with its `AxleReadingsRecorded` event marked for the **backfill lane**; it is processed after the train reached Cedar Junction.
2. Analyzer A's transaction inserts `(analyzer, event_id)` into `processed_events` and appends `AlertRaised` (SVTX 961204 L1, MEDIUM, routed `yard_post_arrival` to CDJ), the hold, the work order and the notifications. It commits. Then A is killed before `XACK`.
3. The message stays pending on A's consumer name. A restarted A drains its own pending entries first (or B claims them after the idle timeout) and runs the same transaction.
4. The `processed_events` insert finds the row and inserts nothing: the message is acked as a duplicate. No second case, hold, work order or notification exists. The case index (one open alert per bearing per trip) and the case stream's expected version back this up.
5. Meanwhile the gateway, which never saw a reply to one retry, posts the same batch again. Ingest answers 200 with `duplicates: 4`, writes nothing and appends no event.
6. Separately, Ridgeway's maintenance system is down: the work-order integration's `WorkOrderOpened` fails five times and is dead-lettered; nothing else waits on it. After the outage, it is redriven from the Ops page and the ticket is created once.

## Event-Driven Design

Events are the backbone of this system, not a side channel. Every state change is recorded as a past-tense domain event with a versioned schema and a full envelope (event id, type, version, stream and per-stream version, global position, event time, recorded time, correlation and causation). Components never call each other: they append events and react to events. The full catalog, with every field, producer and consumer, is [events.md](./events.md).

### Event store, fact log and outbox

Three different jobs, kept apart on purpose:

| | What | Source of truth | Why this shape |
|-|------|-----------------|----------------|
| **Event store** | `case-<uuid>` and `car-<id>` streams (and a small `detector-<id>` stream) in the PostgreSQL `events` table | **The events.** Current-state tables are projections | Cases and component histories are decided by several actors over hours (analyzer, process manager, dispatchers, two offline tablets, the repair track). The history *is* the product: an audit trail, a timeline, labels for precision. Optimistic concurrency on the stream turns a race into a conflict a domain rule resolves |
| **Fact log** | `detector_passes` + `axle_readings` | The rows | ~26M values a day at production scale and no invariant between one reading and the next. There is no aggregate to protect and nothing to fold, so event-sourcing them would only multiply storage. They are immutable facts; `PassRecorded` and `AxleReadingsRecorded` announce them, the latter as a claim check |
| **Outbox** | `pass-*` and `trip-*` streams in the same `events` table | The state rows (passes, trips, consists, the analyzer's state) | The event is appended in the same transaction as the state change, so there is no dual write: no pass without its event, no event without its pass |

In production the readings live in a columnar store that can't share a transaction with PostgreSQL. The claim check makes that safe: ingest first writes the readings keyed by `(detector, pass)` (idempotent, so a retry overwrites the same blob), then commits the small pass row and its outbox events in PostgreSQL. A crash between the two leaves an orphan blob nobody references, which is harmless; the reverse (an event pointing at missing readings) can't happen.

One table plays the event store and the outbox, so one relay publishes both. The table refuses UPDATE and DELETE (a trigger). `global_position` is assigned under a transaction-scoped advisory lock taken only for the INSERT at the end of the transaction, so positions become visible in commit order and a reader that has seen position N never later finds a smaller one. That is the property a log needs, and it costs one short critical section per commit, not a serialized transaction.

### Event sourcing for cases, state plus outbox for readings

A case (one alert, or one random audit, and the yard's response) is the aggregate:

```
 AlertRaised ─▶ CarHoldPlaced ─▶ WorkOrderOpened ─▶ NotificationRequested ─▶ NotificationDelivered
      │                                                                   (delivered ≠ acknowledged)
      ├─▶ AlertEscalated (tier only goes up; may change owner, reopens an acknowledged case)
      ├─▶ AckDeadlineMissed ─▶ ... ─▶ ApproachingYardWarned          (process manager, durable timers)
      ├─▶ AlertHandedOff / CarHoldMoved                               (the train moved on)
      ├─▶ AlertAcknowledged ─▶ WorkOrderStarted ─▶ InspectionFindingRecorded ─▶ CarHoldReleased ─▶ CaseClosed
      └─▶ CaseClosed (component_replaced | identity_corrected)        (its evidence vanished)
```

Its state is `foldCase(events)` (`domain/case.ts`), a pure function; deciders take the state and a command and return new events or a domain error. The invariants it protects: tiers never go down; a closed case takes no new decisions; only the owner acknowledges; one hold and one work order; a finding needs the work order; a defect report is never overwritten by a no-defect report; each notification is requested once per (channel, target, kind).

Some invariants span aggregates: one open alert per bearing per trip, one audit per arriving train. An event stream can't see its siblings, so a **write-side index** (`case_index`) is updated in the same transaction as the case's events, with partial unique indexes. The yard's outbound-build check reads that index too, never a projection, because a projection that is half a second stale could let a held car into a train.

The car aggregate (`domain/car.ts`) holds wheelset installs with event time (installed) and processing time (recorded). The analyzer reads car streams directly when it scores a trip: a decision reads aggregates from the store (consistent), never from a projection (eventually consistent).

### Concurrent case updates: domain rules, never last-write-wins

Every append to an aggregate carries the version the writer loaded. A mismatch throws `ConcurrencyError`, the whole command re-runs against the new state, and the domain decides:

| Race | Rule |
|------|------|
| A dispatcher acknowledges version 12; meanwhile the notifier appended `NotificationDelivered` (v13) | Events since v12 change no decision: **rebase** and append at v14 |
| A dispatcher acknowledges version 12; meanwhile the alert escalated to CRITICAL (v13) | A decision changed under them: **409** with the current case and the list of changes (`AlertEscalated`). They review and acknowledge the CRITICAL |
| Two offline tablets inspect the same car and sync later: "no defect" then "bearing defect" | **The more severe finding wins**: the defect supersedes (`supersedesFindingId`), the car is held again as bad-ordered, the case goes back to *inspected* |
| The same, in the other order: "defect" then "no defect" | **Refused** (409 `FINDING_CONFLICT`): a defect report is never erased |
| The same tablet resends the same submission | **Replay**: the stored finding is returned (200) |
| The analyzer escalates while a dispatcher acknowledges | Whoever commits first wins the version; the other re-runs: an escalation after an ack reopens the case; an ack after an escalation is refused as above |
| A timer fires a millisecond after the acknowledgment | The process manager re-reads the case: no longer open, nothing to escalate |

### The relay and the Kafka mapping

The relay (`events/relay.ts`, in the workers process) tails `events` by global position, publishes each event to its family's stream with its partition key, then advances `relay_checkpoint`. A NOTIFY from the appending transaction wakes it; a 500 ms poll is the fallback. One relay is active (a session advisory lock); a second instance waits as a hot standby. It is at-least-once: a crash after publishing and before the checkpoint update republishes a few events, which every consumer drops by event id. In production this is Debezium or a Kafka Connect outbox connector reading the WAL.

| Topic (family) | Events | Key | Partitions (production, illustrative) | Retention | Consumer groups |
|----------------|--------|-----|------------|-----------|-----------------|
| `wayside.passes` | PassRecorded | detector id | 12 | 7 d | proj-detector-health |
| `wayside.readings.live` | AxleReadingsRecorded, lag ≤ 15 min | **trip id** | 24 | 3 d | analyzer |
| `wayside.readings.backfill` | AxleReadingsRecorded, lag > 15 min | **trip id** | 24 | 3 d | analyzer |
| `identity` | ConsistVersionChanged, CarIdentified, IdentityQuarantined | trip id | 12 | 30 d | analyzer, proj-car-history |
| `trends` | BearingTrendUpdated | trip id | 12 | 7 d | proj-alert-queue |
| `trips.position` | TripPositionUpdated, TripArrived | trip id | 12 | **compacted** (latest per trip) | ack-process, workorder-sync |
| `detectors.health` | DetectorHealthChanged | detector id | 3 | **compacted** (latest per detector) | proj-detector-health |
| `cases` | every case event | case id | 12 | forever, tiered | notifier, workorder-sync, ack-process, proj-alert-queue, proj-reliability |
| `cars` | ComponentReplaced, routine/teardown findings | **car id** | 12 | forever, tiered | analyzer, workorder-sync, proj-alert-queue, proj-car-history, proj-reliability |

Two different keys for two different questions. The live path is keyed by **trip**, because relative features need every axle of a pass together and trends need every pass of a trip: one partition, one writer per train. Car history is keyed by **car**, because a car's wheelset swaps must stay in order across all the trips it will ever run. Compaction fits the latest-state topics: a consumer that starts cold needs each train's current position and each detector's current status, not their history.

Locally, Valkey Streams stand in: one stream per family (`rh:ev:<family>`), consumer groups, XACK after commit, XPENDING plus XCLAIM for redelivery, a dead-letter stream. Valkey has no partitions, so a family stream is totally ordered; the analyzer can still run several consumers, and the per-trip advisory lock gives the "one writer per trip" that partitioning by trip gives in Kafka.

### Ordering guarantees, and what does not need them

- **Guaranteed:** order within a stream (gap-free `stream_version`), order within a broker stream (global position), hence per key in Kafka.
- **Not guaranteed, and not needed:** order across families. A projection that reads two families makes those updates commutative: case events come from `cases` in order, while trend telemetry goes to its own table as last-writer-wins by global position.
- **Readings don't need order at all.** The analyzer keeps a bearing's observations keyed by pass and recomputes; the tier is the maximum over event-time prefixes. A late pass, a duplicate or a redelivery yields the in-order decision.
- **Event time decides; processing time only measures lateness.** Which consist revision applies, which wheelset was on the axle, where the train is: all by `occurred_at`.

### Idempotency: exactly-once effects from at-least-once delivery

Delivery is at-least-once everywhere (gateways retry, the relay can republish, a consumer can die after commit and before XACK). Effects are exactly-once because each consumer group handles a message in one PostgreSQL transaction that inserts `(group, event_id)` into `processed_events`, runs the handler (its reads, state writes and new events), advances the group's checkpoint, and commits; only then is the message acked. A redelivery inserts nothing and is acked as a no-op. Natural keys back this up: `(detector_id, pass_id)` at ingest, the tablet's `clientSubmissionId`, the audit case id derived from the trip id, expected version `no_stream` on creation.

### Schema evolution

Producers write only the latest version; stored events are never rewritten. Readers upcast step by step and validate the result with the latest zod schema, so a consumer sees one shape. `InspectionFindingRecorded` went from v1 (source implied by `alertId`) to v2 (an explicit `source`: alert, audit, routine or teardown, and `supersedesFindingId`), because bearing-shop teardowns and routine inspections are labels too and v1 couldn't say so. The upcaster maps `alertId ? 'alert' : 'audit'`. Seeded findings older than 30 days are stored as v1, so every replay exercises it, and the timeline shows "v1→v2". A consumer that meets a version newer than it knows dead-letters the message (a permanent error) until it is deployed: deploy consumers before producers.

### Replay and backfill

Every projection can be rebuilt. `npm run replay -- <projection>` opens one REPEATABLE READ transaction, reads the live group's checkpoint for each family, applies exactly the events at or below those positions, in global order, into shadow tables with the same apply function the live projector uses, then compares shadow and live row for row in the same snapshot. Equal means the live table is exactly what its events say. A mismatch is a projector bug, or an event sitting in the dead-letter stream (the tool says which).

`npm run replay -- swap-case` goes further: it re-derives a *decision* from events alone. For the "late reading after a wheelset swap" demo it reads the trip's `ConsistVersionChanged` and `AxleReadingsRecorded` events (following their claim checks into the fact log) and the cars' `ComponentReplaced` events, rebuilds identity and trend state with the analyzer's pure functions, and decides twice: in recorded order, and with the install moved after the late reading. Both end with the open cases the live system recorded. In the second order the replaced car's alert opens and then closes as `component_replaced`, which is what the analyzer does on `ComponentReplaced`.

Backfill has two meanings here. **Late data** (a gateway's buffered passes) is routed at ingest to the backfill lane and processed in event time like any other pass. **Bootstrapping a new consumer** reads the event store from position 0 (catch-up), not the broker's retention: the seed builds every projection that way and starts the relay after the history.

### Choreography by default, orchestration for one flow

Most of the system is choreography: each consumer reacts to facts and publishes its own, and nobody calls anybody.

| Fact | Who reacts | With what |
|------|-----------|-----------|
| AxleReadingsRecorded | analyzer | CarIdentified, BearingTrendUpdated, TripPositionUpdated, AlertRaised/Escalated, holds, work orders, notifications |
| ConsistVersionChanged | analyzer | re-processes passes quarantined for want of it |
| NotificationRequested | notifier | NotificationDelivered |
| WorkOrderOpened | workorder-sync | a ticket in the yard maintenance system |
| InspectionFindingRecorded (repaired) | workorder-sync | ComponentReplaced on the car stream |
| ComponentReplaced | workorder-sync, analyzer | closes bad-ordered cases on that axle; closes open cases whose evidence predates the wheelset |
| TripArrived | workorder-sync | opens the random audit case |

The acknowledgment flow is orchestrated, by a **process manager** (`workers/ack-process.ts`). "If nobody acknowledges in 15 minutes, page the chief dispatcher; 15 more, the operations center; warn the yard 30 minutes before the train arrives; when the train crosses into the East desk's territory, start over with East" needs memory and time, and spreading it across reactive consumers would scatter one policy over five places and leave nobody owning it. The process manager listens to case events and trip positions, keeps **durable timers** in `ack_timers` (due time in domain time), and a poller claims due timers with `FOR UPDATE SKIP LOCKED`, so two workers never fire the same timer and a crash mid-fire leaves it pending. When a timer fires it re-reads the case from its stream and decides with the pure rules in `analyzer/ownership.ts`; its commands are events on the case stream, appended with the loaded version. There is no compensation step because nothing it does needs undoing: a timer that loses the race to an acknowledgment finds nothing to do, and a page already sent is followed by a handoff or a closure, not unsent.

### Dead letters and redrive

A permanent error (bad JSON, a payload that fails its schema, an unknown schema version) dead-letters at once: retrying can't help. A transient error leaves the message pending; the reclaim loop retries it after `STREAM_CLAIM_IDLE_MS`, and after `STREAM_MAX_DELIVERIES` (5) it is dead-lettered with the error, the attempt count and the raw event. The group acks the original and keeps moving, so one poison message never stalls a partition. The Ops page lists dead letters; **redrive** re-publishes the event to its original stream addressed to that group (`redriveFor`), other groups skip it, and processed-events makes a repeat harmless. The analyzer's live/backfill priority and the backfill lane mean a flood of retries never delays a fresh reading.

### Observability of the pipeline

Prometheus (`rh_*` in `shared/metrics.ts`): events appended by type, relay published by family and relay lag, consumer messages by group and outcome (processed, duplicate, skipped, failed, dead_lettered), handle time by group, consumer lag per group and stream, DLQ depth, projection staleness (age of the oldest committed event a group hasn't applied), events per second, timers fired. The Ops / Streams page shows the same numbers live, plus the dead letters with redrive and a fault injector for demos.

### Failure traces, in events

**Success: a slowly failing bearing.** `PassRecorded` and `AxleReadingsRecorded` commit with the pass row (outbox). The relay publishes the readings to `wayside.readings.live`. The analyzer's transaction records the event as processed, resolves identity, and appends `TripPositionUpdated`, `BearingTrendUpdated` and, for NRLX 304512 R3, `AlertRaised` (MEDIUM), then `CarHoldPlaced`, `WorkOrderOpened` and two `NotificationRequested`, all caused by the `AlertRaised`. It commits, then acks. The notifier appends `NotificationDelivered`. The process manager schedules a 60-minute timer; it fires, the case is still open, so `AckDeadlineMissed` (level 1) and a supervisor notification. Two detectors later `AlertEscalated` (HIGH, owner West desk); `TripPositionUpdated` past Cedar Junction makes the process manager append `CarHoldMoved` to Ridgeway, then, at MP 160, `AlertHandedOff` to the East desk. The East dispatcher acknowledges at the version they saw; `NotificationDelivered` events appended since are rebased over.

**Failure: the yard maintenance system is down, and the analyzer crashes.** Ridgeway's maintenance system rejects calls (a fault on `workorder-sync`). `WorkOrderOpened` for Ridgeway fails five times, three seconds apart, and lands in the dead-letter stream with the error; every other group, and every other yard, keeps flowing, and the case itself is unaffected (the hold is already in force). Meanwhile the analyzer is killed after committing a pass but before acking it: on restart it drains its own pending messages first, finds the event in `processed_events`, and acks it as a duplicate: no second `AlertRaised`, hold or page. When Ridgeway's system is back, an operator redrives the dead letter from the Ops page, the ticket is created once, and `npm run replay -- all` still matches every projection.

## Database Schema

The full schema is `backend/src/db/init.sql`. Key tables (production splits raw readings into ClickHouse or Cassandra; locally everything is PostgreSQL):

```sql
-- The event store, which is also the outbox. Append-only (a trigger refuses UPDATE and DELETE).
CREATE TABLE events (
  global_position BIGSERIAL PRIMARY KEY,          -- assigned in commit order (advisory lock around the INSERT)
  event_id UUID NOT NULL UNIQUE,
  stream_id TEXT NOT NULL, stream_type TEXT NOT NULL, stream_version INT NOT NULL,
  type TEXT NOT NULL, version SMALLINT NOT NULL,   -- past-tense name, schema version as written
  family TEXT NOT NULL, partition_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,                -- event time
  recorded_at TIMESTAMPTZ NOT NULL,                -- processing time
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  correlation_id TEXT NOT NULL, causation_id UUID, actor TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}', payload JSONB NOT NULL,
  UNIQUE (stream_id, stream_version)               -- optimistic concurrency
);
CREATE INDEX events_tags_idx ON events USING GIN (tags);

-- Write-side index for invariants that span case streams; updated in the same transaction as their events.
CREATE TABLE case_index (case_id UUID PRIMARY KEY, case_type TEXT, trip_id TEXT, car_id TEXT, kind TEXT, position TEXT,
  is_open BOOLEAN, work_order_id UUID UNIQUE, hold_yard_id TEXT, hold_status TEXT, version INT);
CREATE UNIQUE INDEX case_index_one_open_alert ON case_index (trip_id, car_id, kind, position) WHERE is_open AND case_type = 'alert';

-- Consumers: exactly-once effects, checkpoints, durable timers.
CREATE TABLE processed_events (group_name TEXT, event_id UUID, processed_at TIMESTAMPTZ, PRIMARY KEY (group_name, event_id));
CREATE TABLE consumer_checkpoints (group_name TEXT, stream_key TEXT, last_position BIGINT, events_handled BIGINT, PRIMARY KEY (group_name, stream_key));
CREATE TABLE relay_checkpoint (id INT PRIMARY KEY, last_position BIGINT);
CREATE TABLE ack_timers (case_id UUID, kind TEXT, due_at TIMESTAMPTZ, status TEXT, level SMALLINT, case_version INT, PRIMARY KEY (case_id, kind));

-- Raw passes: (detector_id, pass_id) is the idempotency key assigned by the detector.
CREATE TABLE detector_passes (
  detector_id TEXT NOT NULL, pass_id TEXT NOT NULL, trip_id TEXT NOT NULL,
  passed_at TIMESTAMPTZ NOT NULL,      -- event time
  received_at TIMESTAMPTZ NOT NULL,    -- processing time (domain clock)
  lag_seconds INT GENERATED ALWAYS AS (GREATEST(0, EXTRACT(EPOCH FROM (received_at - passed_at)))::int) STORED,
  axle_count INT NOT NULL, aei JSONB, edge_alarms JSONB, payload_sha TEXT NOT NULL,
  identity_status TEXT NOT NULL,       -- pending | resolved | unresolved | awaiting_consist
  median_bearing_n NUMERIC, median_bearing_s NUMERIC,
  processed_at TIMESTAMPTZ,
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

-- PROJECTIONS from here down: rebuilt from events by `npm run replay`. No foreign keys.
-- car-history: wheelset installs from ComponentReplaced (event time vs processing time).
CREATE TABLE component_installs (
  car_id TEXT, axle INT, component_id TEXT, installed_at TIMESTAMPTZ NOT NULL, removed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL, event_id UUID NOT NULL, ..., PRIMARY KEY (car_id, axle, installed_at)
);

-- alert-queue: alerts, car_holds, work_orders, findings, notifications.
CREATE TABLE alerts (
  id UUID PRIMARY KEY, trip_id TEXT, car_id TEXT,
  kind TEXT CHECK (kind IN ('hot_bearing', 'hot_wheel', 'cold_wheel')),
  position TEXT, tier SMALLINT, status TEXT CHECK (status IN ('open', 'acknowledged', 'inspected', 'closed')),
  owner_role TEXT, owner_id TEXT, escalation_level SMALLINT, ack_due_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ, inspected_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
  routing TEXT, desk_id TEXT, yard_id TEXT, reasons JSONB, features JSONB,
  data_lag_seconds INT, late BOOLEAN,
  version INT,          -- the case stream version this row reflects
  last_position BIGINT, ...
);
CREATE UNIQUE INDEX alerts_one_open_per_bearing ON alerts (trip_id, car_id, kind, position) WHERE status <> 'closed';

CREATE TABLE car_holds   (id UUID PRIMARY KEY, car_id TEXT, alert_id UUID UNIQUE, yard_id TEXT, status TEXT, ...);
CREATE TABLE work_orders (id UUID PRIMARY KEY, alert_id UUID UNIQUE, audit_key TEXT UNIQUE, kind TEXT, yard_id TEXT, ...);
CREATE TABLE findings    (id UUID PRIMARY KEY, client_submission_id TEXT, case_id UUID, work_order_id UUID,
                          source TEXT,  -- alert | audit | routine | teardown (v2)
                          finding TEXT, disposition TEXT, observed_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ,
                          superseded_by UUID, schema_version SMALLINT, ...);
CREATE TABLE notifications (id UUID PRIMARY KEY, alert_id UUID, channel TEXT, target TEXT, kind TEXT,
                            created_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, ...);
```

Other projections: `bearing_trends_latest` (alert queue telemetry, last-writer-wins by position), `car_trips` (car history), `detector_health`, `reliability_facts` (one row per case and per stand-alone finding). State tables with an outbox: `trips`, `trip_units`, `trip_consist_versions`. Analyzer state: `expected_passes` (which detectors each trip should have reported, for silence), `detector_bias_samples`, `bearing_trip_summary` (per-trip, per-bearing history), `thresholds` (versioned config), `detectors`, `trips`, `railcars`.

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
GET  /api/v1/events                 SSE notices (ids only), filtered by role; sent after a projection commits

GET  /api/v1/event-log/cars/:carId     every event tagged with the car (car stream, its cases, its trips)
GET  /api/v1/event-log/cases/:caseId   the case stream plus the events that caused it or that it caused
GET  /api/v1/event-log/events/:id      one envelope, its stored (pre-upcast) payload and its causation chain
GET  /api/v1/ops/streams               relay lag, consumer lag/pending per group and stream, staleness, DLQ depth, events/s
GET  /api/v1/ops/dlq                   dead letters with error, attempts and raw event
POST /api/v1/ops/dlq/:id/redrive       re-publish one dead letter for its group; POST /ops/dlq/redrive-all
PUT/DELETE /api/v1/ops/faults/:group   fault injection for demos (transient, permanent, crash_after_commit)
```

`npm run replay -- <alert-queue|car-history|detector-health|reliability|all|swap-case>` is the offline counterpart.

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

A message the provider accepted is not a person who knows. Each alert has one owner, a tier-based deadline and an escalation chain. Handoffs are explicit when the train moves on. This adds a process manager with durable timers and an audit trail (the case stream), and acknowledging becomes part of the dispatcher's and inspector's job. Without it, the failure mode is the follow-up the design must answer: delivered, unacknowledged, and the train arriving at a yard that doesn't know to catch the car.

### 6. Event time everywhere, rebuilt from events

Lateness, trip position, consist revisions and component installs are all decided by when things *happened*, not when we heard. State is rebuilt from events, so a late install or a late pass converges on the same answer.

### 7. Event-source the cases and car histories; keep readings as facts

A case is decided by many actors over hours, its history is what reviewers and the reliability page need, and races between them must resolve by a rule, not by whoever wrote last: event sourcing with expected versions gives all three. Readings are the opposite: huge volume, no invariants, never revised. They stay an append-only fact log and are announced through the outbox. The cost of event-sourcing cases is real: projections lag their events, set invariants need a write-side index, and every schema change needs an upcaster. Details in [Event-Driven Design](#event-driven-design).

### 8. Choreography, with one process manager

Integrations react to facts (notifier, work-order sync, projections), so adding one never touches another. The acknowledgment, escalation and handoff policy is one process manager with durable timers, because a deadline is memory plus time and scattering it across reactive consumers would leave nobody owning it.

## Consistency and Idempotency

| Write | Key | On retry |
|-------|-----|----------|
| Pass + readings + outbox events | `(detector_id, pass_id)`; events in the same transaction | 200 duplicate, nothing appended; conflict if payload differs |
| Relay publish | `relay_checkpoint`; at-least-once | Republished events dropped by consumers by event id |
| Any consumer's effects | `processed_events (group, event_id)` in the effect's transaction | Acked as a duplicate |
| Case events | expected stream version | Re-run the command; a domain rule decides (rebase, 409, most severe finding) |
| Open alert per bearing per trip | `case_index` partial unique index | Escalate in place |
| Hold, work order, notification | case state (one each; notification per channel, target, kind) | The decider returns no event |
| Finding | `clientSubmissionId` in the case state | Returns the stored finding (200, `replayed`) |
| Component install | `clientSubmissionId` (or finding id) in the car state; one current per axle | Returns the stored install |
| Audit case | case id derived from the trip id, expected `no_stream` | Already exists: nothing to do |
| Timer fire | `ack_timers` row claimed `FOR UPDATE SKIP LOCKED`; case re-read | Stale timer does nothing |
| Thresholds | `version` check | 409 with the current state |

Ordering: per stream (and per Kafka key) only; per-trip order of readings is recovered from event time, not arrival. Nothing requires global order.

## Security / Auth

- Gateways: per-gateway mTLS certificates and a gateway-to-detector allowlist in production (a shared `X-Ingest-Token` locally). A gateway can only post its own detectors.
- Users: session cookies in Valkey, bcrypt passwords. Roles: dispatcher (a desk), yard car inspector (one yard), reliability engineer (admin).
- Enforcement in the API, not the UI: yard users only see and act on their yard's alerts, work orders and holds. Only the owner role can acknowledge. Live SSE notices are filtered per viewer, and carry ids only: the browser refetches through the same access-checked read APIs, so the async path never widens access.
- Car owners (lessors) receive notices only about their own cars, through the industry's alert-routing channel.

## Observability

- Metrics (`prom-client`, `backend/src/shared/metrics.ts`): passes ingested by outcome, ingest lag histogram, passes processed by outcome and lane, processing time by lane, alert transitions by tier and lateness, ack escalations by reason, SSE connections.
- Pipeline metrics: events appended by type, relay published by family and relay lag, consumer messages by group and outcome, handle time by group, consumer lag per group and stream, DLQ depth, projection staleness, events per second, timers fired. The Ops / Streams page shows them live with the dead letters.
- Structured logs (Pino) with detector, pass and trip ids on every processor decision.
- Product metrics on the reliability page: precision by tier and failure mode, recall proxy, audit defect rate, alerts per 1,000 car passes (the fatigue budget), late-pass share, open holds.
- Detector health is itself an operational dashboard.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Cloud or link down | Edge alarms still stop trains; gateways buffer; backfill on recovery |
| API dies mid-request | Pass and events commit together or not at all; the gateway retries |
| Relay dies after publishing, before its checkpoint | Republishes on restart; consumers drop duplicates by event id; a standby relay takes over |
| Consumer dies after commit, before ack | Redelivered (own pending, or claimed by another consumer); `processed_events` makes it a no-op |
| Downstream system down (yard maintenance, paging) | That group retries, then dead-letters; every other group and the case itself carry on; redrive after recovery |
| Poison message (bad schema, unknown version) | Dead-lettered at once; the group keeps moving |
| Projection bug | Fix it, rebuild from position 0 (`npm run replay`), compare with the live table |
| Concurrent case updates | Expected version conflict; command re-run; domain rule decides |
| Consist not yet received | Pass quarantined (`IdentityQuarantined`); `ConsistVersionChanged` releases it to the analyzer |
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
| Cases | Event-sourced aggregate | Mutable rows + audit table | History is the product; races resolve by rule |
| Readings | Fact log + outbox (claim check) | Event-sourced | Volume, no invariants |
| Publishing | Transactional outbox + relay | Write DB then publish | No dual write |
| Delivery | At-least-once + processed-events | Exactly-once broker features | Works across any store and broker |
| Coordination | Choreography + one process manager | Central orchestrator for all | Integrations stay independent; one owner for deadlines |
| Concurrent edits | Expected version + domain rule | Last write wins | A defect report is never silently erased |
| Schema change | New version + upcaster | Rewrite history | The store stays append-only |
| Poison messages | Bounded retries + dead-letter stream + redrive | Retry forever | One bad message can't stall a group |

## Design Review Checklist

1. **Source of truth, and when a write succeeds.** Cases and car histories: their event streams. Raw readings: the fact log. Trips and consists: their rows (with outbox events). Everything else is a projection. An ingest write succeeds when the pass, its readings and its events commit (then 2xx). A command succeeds when its events append at the expected version. A consumer's step succeeds when its transaction (effects, processed mark, checkpoint) commits (then ack).
2. **Client retries after losing the response.** Gateways: same `(detector, pass)` gives a duplicate and appends nothing. Tablets: same `clientSubmissionId` gives the stored finding; a different tablet's conflicting finding is resolved by the severity rule. Dispatchers: a stale version is rebased over notifications, or refused with 409 if a decision changed.
3. **Worker fails between two steps.** There is no "between commit and publish": the outbox makes them one. Relay between publish and checkpoint: republishes, consumers drop duplicates. Consumer between commit and ack: redelivered and skipped. Timer between claim and append: the row stays pending. Notifier between provider call and append: the provider call is idempotent on the notification id.
4. **Required ordering.** Per stream (per Kafka key): trip for readings, car for component history, case for cases. Readings tolerate any order (event time, max over prefixes). No global order across families; projections that span families are commutative.
5. **Access with caches and async jobs.** Consumers write as system principals, but every read goes through role checks, including timelines (a yard user sees only their yard's cases). SSE carries ids only, is filtered per viewer and is sent after the projection commits. Owner notices are scoped to the owner's cars.
6. **What breaks first at 10–100×.** Human capacity (holds per yard per shift, pages per desk), shown by the alert-volume and precision metrics; then backfill bursts after regional outages, shown by lane backlog and consumer lag; then the single-writer append section of the PostgreSQL event store (one short lock per commit), shown by append latency: the fix is the Kafka mapping above, with case and car streams partitioned by key. Storage and compute last.

## Implementation Notes

### Local architecture

```
 simulator ──HTTP──▶ api (:3000) ── one transaction: fact rows + outbox events ──▶ PostgreSQL `events`
 (60× clock in        │   commands (ack, finding, install): case/car streams, expected versions      │
  Valkey)             │                                                                               │ NOTIFY
                      │                                    workers: relay ◀───────────────────────────┘
                      │                                       │ XADD by family
                      │                                       ▼
                      │                           Valkey streams rh:ev:<family> (+ rh:ev:dlq)
                      │                                       │ consumer groups, XACK after commit
                      │        ┌──────────────────────────────┼────────────────────────────────┐
                      │        ▼                              ▼                                ▼
                      │   analyzer (:3010)            workers (:3011): notifier,        projections: alert-queue,
                      │   readings live/backfill,     workorder-sync, ack-process       car-history, detector-health,
                      │   identity, cars              (+ durable timer poller)          reliability
 browser ◀──SSE───────┤◀── pub/sub notices (after a projection commits) ◀─────────────────────────┘
 (:5173)  ──REST─────▶┘    reads: projections; timelines: the event store
```

| Process | Entry | Role |
|---------|-------|------|
| API | `backend/src/api/index.ts` | Ingest (fact log + outbox), commands on case and car aggregates, read APIs, timelines, ops, SSE |
| Analyzer | `backend/src/analyzer/index.ts` | Consumer group `analyzer`: identity, trends, scoring, case decisions; detector-health job |
| Workers | `backend/src/workers/index.ts` | Relay; projections; notifier; work-order integration; ack process manager and its timers (`WORKER_ROLES` selects) |
| Simulator | `backend/src/simulator/index.ts` | The scenario in compressed time; publishes the simulation clock |
| Replay | `backend/src/replay/index.ts` | `npm run replay -- <projection|all|swap-case>` |
| Frontend | `frontend/` | Alert queue, train heatmap, car trends, yard tablet, detector health, reliability, event timelines, Ops / Streams |

### Production-grade patterns actually implemented

- **Event store with optimistic concurrency** (`events/store.ts`): append-only table (trigger-enforced), per-stream versions, expected-version appends, global positions in commit order, NOTIFY on commit.
- **Event-sourced aggregates** (`domain/case.ts`, `domain/car.ts`): pure folds and deciders; the domain rules for concurrent updates (rebase vs 409; the more severe finding wins); a write-side `case_index` for set invariants (`domain/repository.ts`).
- **Transactional outbox and claim check** (`api/services/ingest.ts`, `api/services/feeds.ts`): fact rows and their events in one transaction; `AxleReadingsRecorded` names the readings instead of carrying them.
- **Relay with leader election** (`events/relay.ts`): tails by global position, at-least-once, hot standby via an advisory lock.
- **Consumer-group runtime** (`events/consumer.ts`): processed-events dedupe and checkpoint in the effect's transaction, ack after commit, XPENDING/XCLAIM redelivery, priority across streams (live lane first), bounded retries, a dead-letter stream with redrive (`events/dlq.ts`), fault injection (`events/faults.ts`). Unit-tested for redelivery, crash-after-commit and dead-letter routing.
- **Schema evolution** (`events/catalog.ts`, `events/envelope.ts`): zod schemas per version, an upcaster for `InspectionFindingRecorded` v1 → v2, v1 rows in the seeded history.
- **Process manager with durable timers** (`workers/ack-process.ts`): `ack_timers` polled with `FOR UPDATE SKIP LOCKED`, decisions re-read from the case stream.
- **Projections and replay** (`workers/projections/*`, `events/catchup.ts`, `replay/`): commutative where streams interleave, deterministic (values from events only), rebuilt and compared row by row; decision re-derivation for the wheelset-swap case.
- **Pipeline observability** (`events/ops.ts`, the Ops page, `rh_*` metrics).
- **Single writer per trip** (`analyzer/pipeline.ts`): `pg_advisory_xact_lock(hashtext(trip_id))`, the local equivalent of Kafka partitioning by trip; the consist feed takes the same lock so a parked pass is never missed.
- **Order-independent trend state and decisions** (`analyzer/trend.ts`, `scoreOverHistory` in `analyzer/risk.ts`, `scoreTripPure` in `analyzer/pipeline.ts`).
- **Identity resolution** with consist versions by time, AEI correction and re-resolution (`analyzer/identity.ts`, `analyzer/resolve.ts`).
- **Component lifecycle** in event time: install events on the car stream, an event-time filter in scoring and history, cases closed as `component_replaced`. Demonstrated by `npm run demo:component-swap` and re-derived by `npm run replay -- swap-case`.
- **Detector health** from the data (`analyzer/detector-health.ts`, `analyzer/health-inputs.ts`), status changes as events.
- **Prometheus metrics, Pino logs, health and readiness endpoints, login rate limiting**; **offline-tolerant, idempotent finding entry** on the tablet (`frontend/src/services/offline-queue.ts`).

```typescript
// domain/case.ts: a stale view of a decision is refused; a stale view of bookkeeping is rebased
const changed = interveningDecisions(s, i.seenVersion)   // e.g. ['AlertEscalated']
if (changed.length > 0 || s.status !== 'open') throw new DomainError('STALE_ALERT', '...', 409, { changed })
```

### Simplified or substituted

- **Valkey Streams for Kafka**: one stream per family, no partitions (the per-trip advisory lock stands in for partitioning by trip), approximate MAXLEN instead of retention and compaction. **PostgreSQL for the event store** instead of a dedicated store (EventStoreDB, or Kafka with compacted aggregate topics); the append step is serialized by one advisory lock.
- **The relay polls (with NOTIFY)** instead of reading the WAL (Debezium).
- **One PostgreSQL database** for the fact log, the event store and the projections. In production the readings go to a columnar store and the claim check points there; the small pass row and its outbox events still commit together.
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
- Snapshots of aggregates (cases have tens of events; car streams grow slowly), event-store archival and outbox pruning, a schema registry, cross-region replication of the log.
