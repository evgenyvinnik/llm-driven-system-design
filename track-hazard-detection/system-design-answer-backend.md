# Track Hazard Detection - System Design Answer (Backend Focus)

*A 45-minute backend interview answer. The prompt: "Design a railroad sensor monitoring and incident detection platform. It ingests camera, vibration and temperature data, identifies track hazards, alerts personnel, and provides an operator dashboard. Connectivity is intermittent, and critical alerts must reach people within seconds."*

---

## 🎯 Clarifying the Problem

Before drawing anything I would pin down four things.

**What are we protecting?** The track and right-of-way, not the railcars. Hazards are a rockfall in a canyon cut, a vehicle or debris on a crossing, water rising toward the rail at a bridge, and rail buckling ("sun kinks") when continuous welded rail runs far above its neutral temperature on a hot afternoon. Monitoring car bearings from wayside detectors is a different system.

**What already protects trains without us?** A slide fence is a wire mesh whose broken wire drops the protecting signal to red through a local interlock. Crossing circuits drive the gates. These work with no network at all. I will say this out loud early because it sets the most important boundary in the design:

> "My platform never sits in the path that stops a train. The field interlock does that in milliseconds whether or not my system exists. What I add is everything a single device can't see: correlating weak signals into one confident hazard, hazards with no interlock at all (a stalled truck seen by a camera, a rising river, heat), routing to the person who owns the territory with a deadline, warning approaching trains, and the record."

**Who acts?** The dispatcher who controls the territory (acknowledges, issues slow orders, stops trains by radio or PTC bulletin), track inspectors who go and look, and an operations team who runs the platform.

**What does "within seconds" mean when links drop?** For live data: edge detection to the dispatcher's console in under 5 s at p99. For data that sat in a gateway buffer during an outage, it's processed as soon as it arrives, marked late, and still allowed to change a hazard.

### Functional requirements

1. Ingest edge events from gateways (one per ~10-mile track segment) and train positions from the PTC/dispatch feed. Delivery is at-least-once, batched, out of order, sometimes hours late.
2. Correlate events in time and space into hazards. Many sensors seeing one rockfall produce one hazard. Late events can upgrade or downgrade it.
3. Alert the territory dispatcher with an ack deadline and escalation.
4. Respond: warn approaching trains nearest first, slow orders on a milepost range, dispatch an inspector, close as cleared or false alarm.
5. Show coverage: a sensor or gateway that goes quiet makes that stretch visibly blind.
6. Dashboard: strip map, hazard timeline and evidence, alert queue, restrictions, latency, pipeline health.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Detection → alert | p99 < 5 s live; critical cloud processing p99 < 1 s |
| Backlog isolation | A 2-hour reconnect backlog adds < 1 s to a new critical event |
| Duplicates | Zero duplicate hazards, pages or slow orders |
| Late data | Up to 72 h late, processed and able to change outcomes |
| Availability | 99.95% ingest and alerting |
| Audit | Every hazard's full history reconstructable |

---

## 📏 Scale Estimates

All illustrative except the network size (BNSF reports 32,500+ route miles).

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Instrumented track | ~6,000 mi | Hazard-prone share of the network |
| Sensors | ~12,000 | Geophones, fences, crossing cameras, rail temp, water level |
| Gateways | ~1,200 | One per ~5 mi |
| Edge events | ~300/s, ~25M/day | Aggregates every 10-60 s per sensor |
| Critical events | 2-5/s | Mostly vibration from passing trains, explained away |
| Reconnect storm | ~250K events in minutes | 100 gateways back after 2 h |
| Hazards | ~50/day | Including heat risks and false alarms |

> "Throughput is modest; one Kafka cluster handles it easily. The hard part is time: links drop, data arrives late and duplicated, and a storm of old data must never sit in front of a new emergency. I'll spend my time there."

---

## 🏗️ High-Level Architecture

```
 FIELD (per segment)                               CLOUD
┌──────────────────────────────┐
│ fence ─▶ interlock ─▶ signal │  safety path, local only
│ geophones · cameras (edge    │
│ model) · rail temp · water   │
│ gateway: aggregate, disk     │
│ buffer, seq #, critical      │
│ first, report watermark      │
└──────────────┬───────────────┘
               │ cellular / satellite (drops out)
               ▼                                  ┌──────────────┐
      ┌──────────────────┐                        │ PTC feed     │
      │ Ingest API       │◀───────────────────────│ (positions)  │
      │ dedup + outbox   │                        └──────────────┘
      └────────┬─────────┘
               │ one transaction
               ▼
      ┌────────────────────────────────────────────┐
      │ PostgreSQL: edge inbox · event store ·     │
      │ outbox · consumer state · read models      │
      └────────┬───────────────────────────────────┘
               │ outbox relay (critical > domain > trains > bulk)
               ▼
      ┌────────────────────────────────────────────┐
      │ Kafka: edge.critical · edge.bulk (by seg)  │
      │        trains (by train) · hazard-events   │
      │        (by seg) · dead-letters             │
      └──┬──────────┬──────────────┬───────────┬───┘
         ▼          ▼              ▼           ▼
   ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐
   │Correlator│ │ Alerting │ │ Projector │ │ Notifier │
   │  (CEP)   │ │ process  │ │ read      │ │ console, │
   │          │ │ manager  │ │ models    │ │ pager,   │
   └────┬─────┘ └────┬─────┘ └─────┬─────┘ │ radio    │
        └─ hazard events ─┘        │       └──────────┘
          (event store + outbox)   ▼
                            API + SSE ─▶ dashboard
```

> "Services never call each other. Each reacts to events on a topic, so I can restart, scale or replay any one of them alone. That is choreography between services. Inside a single hazard, though, the response has deadlines and compensations, so one process manager orchestrates it. I'll come back to why."

---

## 📨 Events and the Two Logs

Everything is an event with an envelope: event id, type (past tense), schema version, **occurred-at (event time)**, **recorded-at (processing time)**, stream id and version, partition key, correlation id (the edge event that started the chain) and causation id (the event that directly caused this one).

| Producer | Events |
|----------|--------|
| Edge gateway | SensorReadingReported, CameraDetectionReported, SlideFenceTripped, WaterLevelReported, SensorHeartbeatMissed |
| PTC feed | TrainPositionReported |
| Correlator | HazardDetected, HazardEvidenceAdded, HazardUpgraded, HazardDowngraded, HazardRiskElevated, HazardRiskSubsided, CoverageDegraded, CoverageRestored |
| Process manager | AlertIssued, AlertEscalated, TrainsWarned, TrainsReleased, SpeedRestrictionIssued, SpeedRestrictionLifted |
| People (API) | AlertAcknowledged, SpeedRestrictionIssued, TrainsWarned, InspectorDispatched, HazardCleared, HazardConfirmedFalseAlarm |

There are two logs and I'd be explicit about which is the source of truth for what:

- **Edge inbox** (integration log). Every event a gateway delivered, exactly once per (gateway, sequence number). Raw telemetry is state plus an outbox row; nobody folds it.
- **Event store** (source of truth for hazards). Each hazard is an event-sourced stream. Its history is the product: the audit trail, the timeline the dispatcher reads, the input to after-action review.

Both reach Kafka only through a **transactional outbox**: the event row and its outbox row commit together, so nothing is published that wasn't committed and nothing committed is lost.

---

## 📥 Ingest and the Outbox, Step by Step

A gateway posts a batch: its id, a batch id, its watermark, and events each with a sequence number. In one transaction the API:

1. Validates the **envelope only** (event id, sequence, type, version, event time). The payload is stored as delivered. If I rejected a malformed payload with a 4xx, the gateway would retry it forever or drop it silently; storing it lets the consumer dead-letter it where ops can see it.
2. Inserts each event into the edge inbox with ON CONFLICT DO NOTHING on (gateway, seq) and on event id. A resent batch inserts nothing.
3. For each *new* event, writes an outbox row on the lane chosen by server policy (fence trip, non-clear camera frame, vibration spike, water within 24 in of the rail: critical; everything else: bulk), keyed by the sensor's track segment.
4. Records the gateway heartbeat and its reported watermark.
5. Commits and fires a NOTIFY so the relay wakes in milliseconds instead of polling.

A 200 means "durably stored": the gateway may now drop those events from its disk buffer.

The **relay** is leader-elected. It claims unpublished rows with SKIP LOCKED in priority order, publishes them, and marks them published in the same transaction. If it dies after publishing but before committing, the rows go out again. That is fine: at-least-once is the contract and every consumer dedupes.

> "I'm choosing an outbox over dual writes. Writing to PostgreSQL and then to Kafka from the request handler loses events whenever the process dies between the two, and there is no way to detect it afterwards. With the outbox, the commit is the only decision point."

---

## 💾 Data Model

| Table | Key columns | Indexes / constraints | Notes |
|-------|-------------|-----------------------|-------|
| edge_events | event id, gateway, seq, type, version, sensor, segment, lane, late, occurred/recorded at, payload | UNIQUE (gateway, seq); event id PK | Accept-and-store: payload validated later |
| events | global position, event id, stream id, stream version, type, version, partition key, occurred/recorded at, correlation, causation, payload | UNIQUE (stream, version); append-only trigger | Event store |
| outbox | id, event id, topic, lane, partition key, envelope, published at | partial index on unpublished by (lane, id) | Relay claims with SKIP LOCKED |
| processed_events | consumer, event id | PK (consumer, event id) | Idempotent consumers |
| command_log | command id, user, hazard, result | PK command id | Idempotent API commands |
| gateway_state | gateway, last seen, reported watermark, effective watermark, coverage | PK gateway | Watermarks and silence |
| evidence | edge event id, kind, sensor, segment, milepost, occurred at, confidence, explained-by-train, hazard id | (subdivision, occurred at) | Correlator keyed state |
| train_positions | train, milepost, direction, speed, occurred at | (subdivision, occurred at), (train, occurred at) | "Where was this train at time t?" |
| timers | id, hazard, due at, status | partial index on pending due at | Durable ack deadlines |
| notifications | idempotency key (event:channel:recipient), status, delivered at | UNIQUE key | Never page twice |
| read models | hazards, alert queue, restrictions, coverage | per-projection version table | Rebuildable by replay |

---

## 🔌 API

```
POST /api/v1/ingest/batches            gateway batch: source, batch id, watermark, events[] (mTLS)
GET  /api/v1/board                     strip-map read model
GET  /api/v1/hazards/:id               hazard + event timeline + evidence + notifications
POST /api/v1/hazards/:id/commands      { command id, seen version, command }
GET  /api/v1/alerts                    queue scoped to the user's desk
GET  /api/v1/restrictions              slow orders
GET  /api/v1/latency                   detection-to-alert p50/p99 and per-stage breakdown
GET  /api/v1/live                      SSE notices (ids only)
GET  /api/v1/ops/overview              consumer lag, outbox backlog, projection staleness
POST /api/v1/ops/dlq/:id/redrive       dead letter back to its partition
POST /api/v1/ops/replay/:projection    rebuild from position 0 and compare
```

---

## 🔧 Deep Dive 1: The Priority Lane Under a Reconnect Burst

**The decision.** I keep a separate critical lane at *every* hop: the gateway sends critical events first, ingest assigns the lane by server-side policy, the outbox relay publishes critical rows before bulk ones, critical and bulk are separate Kafka topics, and consumers drain the critical topic before every bulk batch of 20.

**Why it works here.** The dangerous moment is a gateway reconnecting after two hours in a canyon with 3,000 buffered readings, at the same time a fence trips 40 miles away. With separate lanes, the fence trip sits in a topic with nothing in front of it. The correlator checks that topic between bulk batches, so the worst case is one bulk batch (about 40 ms) of extra wait. In the local build I measure it: with 4,300 events of bulk lag outstanding, the correlator decided on a new fence trip 56 ms after it happened.

**How the alternative breaks.** One topic with a priority field doesn't help, because Kafka delivers a partition in offset order; the consumer can't skip ahead to the critical record without abandoning per-partition order. One topic per segment doesn't help either: the reconnecting gateway's own segment is exactly where a new critical event might occur. And if *any* hop is FIFO, the backlog wins there. The classic miss is the outbox relay: if it publishes in plain id order, 3,000 bulk rows committed a moment earlier go out first and the critical row waits behind them.

**What I give up.** There is no global order between lanes, so a camera detection can be processed before an older vibration reading from the same segment. That's acceptable only because correlation is order-independent (deep dive 2). There are also more topics, consumer groups and lag metrics to operate, and lane assignment becomes policy I have to maintain: if I'm too generous (every vibration sample critical), the critical lane fills up and stops being special. Server-side classification also stops one misconfigured gateway from flooding the critical lane.

> "Priority is only as good as its weakest hop. I'd draw this as five arrows and ask the interviewer to find the FIFO one."

---

## 🔧 Deep Dive 2: Correlation on Event Time, with Watermarks

**The decision.** The correlator turns each edge event into evidence with a confidence (a fence break 0.85, a camera detection at its model confidence, a vibration spike 0.35-0.5), then decides from the *set* of evidence inside a space-time window, ±30 s and ±0.5 mi of **event time**:

1. A spike that a train explains (a train was within 0.6 mi at the spike's event time, interpolated from PTC positions) is stored and ignored.
2. If an open hazard of a compatible kind covers the evidence, it joins that hazard.
3. Otherwise it clusters with unattached compatible evidence in the window. Confidence combines as a noisy-OR across sensors, counting each sensor once. At 0.5 the cluster becomes a hazard (HIGH); at 0.8 it's confirmed (CRITICAL).

A camera at 0.71 plus a spike at 0.425 six seconds later gives 0.83: one confirmed hazard, not two. Two wires on the same fence are one sensor, so they don't double-count. A resent batch is the same sensor too.

**Why event time and set semantics.** Because the decision is a function of the evidence set, the same events in any order give the same standing hazards. That is what makes late data, duplicates and replay safe; the test suite shuffles a scenario 25 times and compares.

**Watermarks.** Each gateway reports a watermark with each batch: the event time of the oldest event still in its buffer. While the gateway is active, the segment's watermark follows it. When the gateway goes silent past 30 s, the watermark advances on processing time instead, so windows close and the rest of the system isn't held hostage by one dead link. It never moves backwards. When the gateway reconnects, its backlog is below the watermark, and those events are **late**: still processed, flagged in every hazard event and on screen.

**I do not wait for the watermark to alert.** Waiting for the window to close plus allowed lateness puts a 30-60 s floor under every alert. I fire as soon as confidence crosses the threshold and refine later. In the scenario a tunnel camera sees debris at 0.66 (HIGH, alerted at once); the geophone spike that confirms it was buffered at an offline gateway and arrives two minutes late; it joins the open hazard and upgrades it to CRITICAL, which re-alerts and warns trains.

**How the alternatives break.** Arrival-order counters ("two alarms in the last 30 s of wall clock") break the moment a gateway reconnects: two hours of readings land in one second and look simultaneous, which manufactures hazards. Dropping late events loses exactly the evidence that matters after an outage. Waiting for the watermark is correct but too slow for a stalled truck on a crossing.

**What I give up.** Early firing means occasional downgrades and false alarms. A late PTC report can explain the spikes a hazard was built on: the hazard is downgraded, but **never closed automatically**. A person closes it as a false alarm. I also keep evidence state per window, which needs an index on (subdivision, event time) and cleanup, and "late" has to be explained to dispatchers in the UI.

---

## 🔧 Deep Dive 3: Exactly-Once Alerts from At-Least-Once Delivery

**The decision.** Every hop is at-least-once and every consumer is idempotent, with a dedup key chosen for that consumer:

| Consumer | Dedup key |
|----------|-----------|
| Ingest | (gateway, sequence number), event id |
| Correlator | processed-events row, same transaction as its effects |
| Process manager | processed-events row, plus level-triggered decisions |
| Projector | last applied stream version per projection |
| Notifier | event id + channel + recipient |
| API commands | client command id |

Each consumer commits its effects *and* its dedup row in one database transaction, then acknowledges the message. A crash before commit redoes the work; a crash after commit redelivers into a no-op.

**The process manager is level-triggered.** For every wake-up (a domain event, an ack-deadline timer, a train moving) it folds the hazard stream and compares what should be true with what is true: severity at least MEDIUM and no alert means AlertIssued; deadline passed and no ack means AlertEscalated; CRITICAL with an approaching train not yet warned means TrainsWarned, nearest ETA first. It appends only what's missing, with optimistic concurrency on the stream version. A redelivered event, a timer firing twice, or two wake-ups racing find nothing left to do.

**Durable timers.** The ack deadline is a row in a timers table, written in the same transaction as the AlertIssued it belongs to. A leader sweeps due timers, marks them fired and reconciles in one transaction. A deadline that passes while the service is down fires when it returns.

**Compensation.** When a hazard closes (cleared or false alarm), the process manager lifts every active slow order and releases every warned train. Nothing is relaxed automatically while the hazard is open.

**Why not exactly-once transactions?** Kafka's transactional producer gives exactly-once *within Kafka*. My effects span PostgreSQL, Kafka and a paging provider; there is no transaction across a pager. Idempotency keys are the only thing that composes across all three.

**Why not choreograph the response?** I could have the notifier react to HazardDetected, a "warner" react to severity, a timer service emit deadline events. Then the state of one incident is smeared across five services and the compensation ("this was a false alarm: undo the warnings and slow orders") has no owner. One process manager per hazard type gives one place to read and test.

**What I give up.** A processed-events table that grows forever (prune after the stream retention window) and a fold per wake-up (cheap: a hazard has around 20 events). I also carry a second pattern: hazards are event-sourced while edge telemetry is state plus outbox, and new engineers have to learn both. I'd defend that split: event-sourcing 25M readings a day into streams nobody folds buys nothing.

---

## 🌡️ Heat Risk and Coverage

Not every hazard is a single detection. **Rail buckling risk** is a trend: continuous welded rail is laid at a rail neutral temperature (RNT), and the further it runs above RNT the more compressive stress builds. For each rail-temperature sensor I keep the samples by event time and fit a line over the last 15 minutes. The risk band is the worse of the current temperature and a 10-minute projection, but the projection may raise the band by only one step (a trend is a warning, not a measurement). Illustrative bands: watch at RNT + 25°F, elevated at + 35, critical at + 45.

- Rising into elevated appends **HazardRiskElevated**; the process manager alerts at MEDIUM and puts a standing 40 mph heat order on the segment.
- Rising into critical raises it to HIGH and a 25 mph order.
- Falling back appends **HazardRiskSubsided**; the process manager lifts the automatic orders and clears the hazard.

Late samples simply join the series in the right place, so the trend is the same whatever order they arrive in.

**Coverage** is the other quiet signal. A gateway reports **SensorHeartbeatMissed** when a sensor skips three intervals, and the correlator's tick marks a gateway silent after 30 s with no batch. Both append CoverageDegraded, and the strip map hatches that stretch of track. The next reading restores it.

> "A blind segment is information the dispatcher needs. No alert from MP 120 means nothing if the geophone at MP 122 died an hour ago."

---

## 🔁 Projections and Replay

The projector builds four read models from the hazard-events topic (hazard board, alert queue, slow orders, coverage) plus latest train positions. Each projection is a pure reducer, and the hazard board uses the *same* fold as the process manager and the command handler.

- **Idempotency** is the stream version: an event whose version is not above the last one applied for that stream is skipped. No processed-events table needed.
- **Replay** takes the projection's lock, checksums the live table, deletes it, folds every event from global position 0 through the same reducer, and checksums again. Matching checksums prove the read model is exactly what the log says. After a reducer bug, the fix is "deploy, replay", not a data-migration script.

---

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Detection → alert p50/p99, by lane and late | The headline SLO, split into edge → ingest → detected → alert → console |
| Per-lane decision latency | Proves the priority lane holds while bulk backs up |
| Consumer lag and pending per group | Who is behind, and who is stuck |
| Outbox backlog per lane | Relay health |
| Dead-letter depth | Poison messages waiting for a human |
| Projection staleness | How old the dashboard is |
| Gateway watermark lag | How far behind real time each segment's data is complete |

Every log line carries the event id and correlation id, so one incident can be followed from the gateway through the correlator, the process manager and the notifier.

---

## 🔀 Partitioning and Hot Keys

I partition by **track segment**. Correlation is spatial, so every event for a stretch of track should land on one partition and be processed in order. A hazard's events carry its segment as the key, so the process manager and projections see one hazard in order too.

| Key | Problem |
|-----|---------|
| ✅ Track segment (10 mi) | Spatial locality; one hazard on one partition |
| ❌ Sensor | A rockfall seen by a fence and a geophone spans partitions: a cross-partition join |
| ❌ Subdivision | 80 miles on one partition; a storm makes it hot |
| ❌ Random | Lose ordering and locality |

Segments have edges, so the correlator also locks any neighbouring segment within the 0.5 mi radius (a halo) before deciding. Hot keys are real: a busy crossing camera or a slide area full of geophones in a storm. The levers are edge aggregation (10-second windows), suppressing camera "clear" heartbeats, and splitting a hot segment. The segment table is data, not code.

---

## 🧬 Schema Evolution

Camera firmware went from v1 (class, confidence, image ref) to v2 (adds a bounding box and model version). Canyon gateways still run v1. Consumers only ever see v2: an upcaster lifts v1 with a null box and "unreported" model version, on read and during replay. Stored events are never rewritten. Unknown extra fields are ignored (tolerant reader). A v3 from beta firmware has no upcaster, so it's a permanent failure and goes to the dead-letter topic; when the cloud ships v3 support, ops redrives it.

---

## 🚨 Failure Handling

| Failure | Behaviour |
|---------|-----------|
| Backhaul down | Gateway buffers; segment shows "gateway silent"; backlog arrives late |
| Cloud down 2 h | Interlocks protect trains; gateways buffer; on recovery critical first, all late |
| Duplicate batch | (gateway, seq) dedup |
| Relay crash after publish | Republished; consumers dedupe |
| Consumer crash | Own pending entries reprocessed on restart; another instance claims idle ones |
| Poison message | Permanent → dead-letter at once; transient (unknown sensor) retried in place, then dead-lettered; redrive after the fix |
| Projection bug | Fix the reducer, replay from position 0, compare checksums |
| Notifier provider down | Retry with backoff; rows stuck in "sending" swept |

---

## 📈 Scalability: What Breaks First

> "The first thing to break is bulk throughput in the correlator during a regional reconnect storm. At about 2 ms per bulk event, 250,000 events is 8 minutes of work on one instance. The critical lane is fine by design, but bulk-derived signals like heat trends and coverage restoration lag. I can see it coming in the local burst demo: bulk lag climbs into the thousands while critical-lane decisions stay under 100 ms."

The fixes, in order: more partitions and correlator instances; batching the bulk path into one transaction per 20 readings; then keeping open windows in memory per partition (Flink-style keyed state) with the evidence table as the changelog. Second to break is the evidence table's window queries, fixed by partitioning it by day and subdivision. The hazard event store is tiny (about 1,000 events a day) and lasts a long time on one PostgreSQL primary.

---

## ✅ Design Review Checklist

1. **Source of truth; when is a write successful?** An edge event is accepted once it and its outbox row commit; then the gateway may drop it. A hazard fact exists once appended to the event store with its outbox row. Every screen is derived.
2. **Client retries after losing the response?** Gateways resend the batch; (gateway, seq) dedup answers "duplicate". Commands carry a command id; the stored result returns with "replayed".
3. **Worker fails between two steps?** Effects and dedup row commit together, then ack. Timers and notifications are rows, swept on restart. The relay republishes.
4. **Which ordering is required?** Per hazard for the process manager and projections (segment key). None for correlation, which works on event time.
5. **Access with async work?** Live notices carry ids only; reads and commands re-check role and territory; the critical lane is server policy; gateways authenticate per device.
6. **What breaks first?** Bulk correlation in reconnect storms; then evidence window queries.

**Successful trace (crossing obstruction during a backlog).** A camera sees a vehicle on the Hwy 9 crossing at 0.71. The gateway sends it alone, ahead of routine readings. Ingest stores it with a critical-lane outbox row while another gateway's 3,000-event backlog lands on the bulk lane. The relay publishes critical first; the correlator reads critical first, finds nothing else in the window, appends HazardDetected (HIGH). The process manager issues an alert to the East desk dispatcher with a 3-minute deadline and a timer row; the notifier puts it on his console about 1 s after the camera saw it. Six seconds later a geophone spike confirms it: confidence 0.83, upgraded to CRITICAL, re-alerted, and the two approaching trains are radioed nearest first. The gateway's lost HTTP reply makes it resend: ingest answers "duplicate". The dispatcher acknowledges, retries on a flaky link with the same command id and gets the stored result, issues a 10 mph slow order and dispatches an inspector, who clears it. The process manager lifts the slow order and releases the trains.

**Failed trace (correlator dies mid-backlog).** The correlator is killed while draining a 5,000-event backlog, with 20 messages delivered but not acknowledged. A fence trips meanwhile; the interlock has already dropped the signal, so no train enters the block. On restart the correlator first reprocesses its own pending messages (those already committed are no-ops), then reads the critical lane before resuming bulk: the fence trip becomes a CRITICAL hazard seconds after restart. Exactly 5,000 processed-events rows exist for the 5,000 backlog events, and one hazard event for the fence trip. The latency panel shows the outage as an outlier in the ingest-to-detected stage.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Hazard storage | Event-sourced streams | Mutable hazard rows | History is the product; replay |
| Telemetry | State + outbox | Event-source everything | Same guarantee, less machinery |
| Partition key | Track segment + halo | Sensor or subdivision | Spatial locality without a giant hot key |
| Alert timing | First threshold crossing | Wait for watermark | Seconds matter; late data refines |
| Correlation | Evidence set in event time | Arrival-order counters | Order-independent, replay-safe |
| Priority | Lanes at every hop | Priority field on one topic | Nothing FIFO can overtake critical |
| Response | Level-triggered process manager | Choreography | Deadlines and compensation need an owner |
| Delivery | At-least-once + idempotency | Kafka transactions | Effects span DB, Kafka and pagers |
| Bad payloads | Store, dead-letter at consumer | Reject at ingest | One bad event never wedges a gateway |
| Train control | Advisory, via the dispatcher | Cloud stops trains | Safety stays in the field |

---

## ❓ Follow-ups I'd Expect

- **The cloud is down for two hours. What happens to a rockfall?** The fence interlock already dropped the signal. The gateway buffers; on recovery it sends critical first; the hazard opens late, flagged late, and the process manager alerts and warns trains still approaching.
- **A gateway reconnects with a backlog. How do new critical events avoid waiting?** Deep dive 1.
- **One rockfall, five sensors. How many alerts?** One hazard, one alert; extra sensors raise confidence or are stored as corroboration.
- **Vibration from every passing train?** Explained by interpolated train positions; a late PTC report explains spikes retroactively and downgrades the hazard.
- **Nobody acknowledges?** Durable timer escalates: desk dispatcher, chief dispatcher, manager of operations.
- **Why partition by segment, not train?** Hazards are places; trains move through many segments.
- **Rolling out a new camera model?** New schema version with an upcaster, consumers first, then firmware; anything unknown dead-letters instead of being guessed at.
- **A sensor installed in the field isn't in the registry yet?** Its events fail as *transient* (the registry may just be behind), are retried in place, then dead-lettered. Ops registers the sensor and redrives; every other consumer group skips the redriven message by event id.
- **Dispatchers drown in alerts?** Correlation already merges sensors into one hazard; train-explained vibration never alerts; downgraded hazards stay visible but don't re-page; I'd add per-desk rate limits on *pages*, never on hazards.
