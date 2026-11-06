# Track Hazard Detection - System Design Answer (Full-Stack Focus)

*A 45-minute full-stack interview answer. The prompt: "Design a railroad sensor monitoring and incident detection platform. It ingests camera, vibration and temperature data, identifies track hazards, alerts personnel, and provides an operator dashboard. Connectivity is intermittent, and critical alerts must reach people within seconds."*

---

## 🎯 Clarifying the Problem

I'd scope three things before designing.

1. **The hazards.** Track and right-of-way, not railcars: rockfall in canyon cuts (slide fences and geophones), obstructions at grade crossings (cameras with an edge vision model), high water at bridges and culverts, and rail-buckling risk when rail runs far above its neutral temperature on a hot afternoon.
2. **The safety boundary.** A broken slide-fence wire drops the protecting signal to red through a local interlock; crossing gates are driven by local circuits. Those never depend on my platform.

> "My system sees across devices and over time: it turns weak signals into one confident hazard, catches hazards no interlock covers, routes them to the dispatcher who owns the territory, warns approaching trains, and keeps the record. It never sits in the path that stops a train."

3. **"Within seconds" with bad links.** Live data: edge detection to the dispatcher's console under 5 s at p99. Data buffered during an outage: processed on arrival, marked late, still able to change a hazard.

### Requirements

| Functional | Non-functional |
|------------|----------------|
| Ingest gateway batches and train positions | p99 detection → alert < 5 s for live data |
| Correlate into hazards (one per real-world problem) | A reconnect backlog adds < 1 s to a new critical event |
| Alert the territory dispatcher with deadlines and escalation | Zero duplicate hazards, pages or slow orders |
| Warn trains, slow orders, dispatch inspectors, close | Late data up to 72 h processed |
| Coverage gaps visible | 99.95% ingest and alerting |
| Live dashboard, timeline, queue, latency, ops | Full audit history per hazard |

### Users

- **Dispatchers** (one desk per territory) acknowledge, warn, restrict, dispatch, close.
- **Track inspectors** on tablets with patchy coverage close the hazards they were sent to.
- **Platform operators** watch lag, dead letters and replays.

---

## 📏 Scale (illustrative)

| Quantity | Estimate |
|----------|----------|
| Instrumented track | ~6,000 of 32,500+ route miles |
| Sensors / gateways | ~12,000 / ~1,200 |
| Edge events | ~300/s average; 250K in a regional reconnect storm |
| Hazards | ~50/day; ~20 events each |
| Open dashboards | ~200 |

Throughput is modest. The difficulty is time: late, duplicated, out-of-order data, and a backlog that must never delay an emergency.

---

## 🏗️ Architecture

```
 FIELD                                    CLOUD                                   PEOPLE
┌──────────────────────┐
│ interlock ─▶ signal  │ (local safety path)
│ sensors ─▶ gateway   │  disk buffer, seq #,
│  critical first,     │  watermark
└──────────┬───────────┘
           │ drops out
           ▼
   ┌───────────────┐    ┌────────────────────────────┐
   │ Ingest API    │───▶│ PostgreSQL                  │
   │ dedup+outbox  │    │ inbox · event store · outbox│
   └───────────────┘    │ consumer state · read models│
                        └──────────┬─────────────────┘
                                   │ relay (critical > domain > trains > bulk)
                                   ▼
                        ┌────────────────────────────┐
                        │ Kafka (Valkey Streams       │
                        │ locally): edge.critical,    │
                        │ edge.bulk, trains,          │
                        │ hazard-events, dead-letters │
                        └──┬───────┬───────┬───────┬──┘
                           ▼       ▼       ▼       ▼
                     Correlator  Alerting  Projector  Notifier ──▶ console / pager / radio
                      (CEP)      (process   (read                       │
                                  manager)  models)                    │
                                              │                        ▼
                                              └── API + SSE ──▶ React dashboard
```

**Backend.** Node + Express services, each a consumer group: correlator, alerting process manager, projector, notifier, plus an outbox relay and the API. PostgreSQL holds the edge inbox, the event store (hazards are event-sourced), the outbox, consumer state and read models.

**Frontend.** React 19, TanStack Router, Zustand, Tailwind. Pages: operator board (SVG strip maps), hazard detail (response, actions, correlation chart, evidence, timeline), alert queue, speed restrictions, latency, event log, ops.

> "Between services it's choreography: nobody calls anybody, so each can be replayed or scaled alone. Inside one hazard the response has deadlines and compensations, so a process manager orchestrates it."

---

## 📨 Events

| Producer | Events |
|----------|--------|
| Gateway | SensorReadingReported, CameraDetectionReported (v1 → v2), SlideFenceTripped, WaterLevelReported, SensorHeartbeatMissed |
| PTC feed | TrainPositionReported |
| Correlator | HazardDetected, HazardEvidenceAdded, HazardUpgraded, HazardDowngraded, HazardRiskElevated, HazardRiskSubsided, CoverageDegraded / Restored |
| Process manager | AlertIssued, AlertEscalated, TrainsWarned, TrainsReleased, SpeedRestrictionIssued / Lifted |
| People | AlertAcknowledged, SpeedRestrictionIssued, TrainsWarned, InspectorDispatched, HazardCleared, HazardConfirmedFalseAlarm |

Every event has event time and processing time, a stream id and version, a partition key (the track segment), and correlation and causation ids. Hazard streams are the **source of truth**; edge telemetry is ordinary state with an outbox row. Both reach Kafka only via the **transactional outbox**.

---

## 📥 Ingest, Outbox and Relay

1. A gateway posts a batch: gateway id, batch id, its watermark, events with sequence numbers.
2. The API validates the envelope only and stores payloads as delivered (accept-and-store), so one malformed event is dead-lettered by a consumer instead of wedging the gateway's queue with retries.
3. Each new event goes into the inbox (deduplicated on gateway + seq) and gets an outbox row on the lane server policy picks, keyed by the sensor's track segment, in the same transaction.
4. Commit, NOTIFY the relay, respond. A 200 means durably stored; the gateway may drop those events.
5. The leader-elected relay claims unpublished rows (SKIP LOCKED) in priority order, publishes, marks them published. A crash in between republishes: at-least-once, deduplicated downstream.

> "The outbox is what makes 'no state change without its event, no event without its state change' true. Dual writes from the request handler lose events whenever the process dies between the database and Kafka."

---

## 💾 Data Model (summary)

| Table | Purpose | Key constraint |
|-------|---------|----------------|
| edge_events | Inbox of everything gateways delivered | UNIQUE (gateway, seq) |
| events | Event store for hazards and coverage | UNIQUE (stream, version); append-only |
| outbox | Rows to publish, by lane | Partial index on unpublished |
| processed_events | Consumer idempotency | PK (consumer, event id) |
| command_log | API command idempotency | PK command id |
| gateway_state | Heartbeat and watermarks | PK gateway |
| evidence | Correlator state per edge event | Index (subdivision, event time) |
| timers | Durable ack deadlines | Partial index on pending |
| notifications | Never page twice | UNIQUE (event, channel, recipient) |
| proj_* | Read models (board, queue, restrictions, coverage) | Version per (projection, stream) |

---

## 🔌 API

```
POST /api/v1/ingest/batches          gateway batch (mTLS)
GET  /api/v1/board                   strip-map read model
GET  /api/v1/hazards/:id             hazard + timeline + evidence + notifications
POST /api/v1/hazards/:id/commands    { command id, seen version, command }
GET  /api/v1/alerts                  desk-scoped queue
GET  /api/v1/restrictions            slow orders
GET  /api/v1/latency                 p50/p99 + stage breakdown
GET  /api/v1/live                    SSE notices (ids only)
GET  /api/v1/ops/overview            lag, outbox, projections, gateways
POST /api/v1/ops/dlq/:id/redrive     dead letter back to its partition
POST /api/v1/ops/replay/:projection  rebuild from position 0 and compare
```

---

## 🧩 Services and Screens

| Service | Consumes | Produces | State it owns |
|---------|----------|----------|---------------|
| Ingest API | Gateway / PTC batches, people's commands | Inbox rows, outbox rows, command events | Inbox, command log |
| Outbox relay | Outbox table | Stream entries, critical first | Leader lock |
| Correlator | edge.critical, trains, edge.bulk | Hazard and coverage events | Evidence, heat state, watermarks |
| Process manager | hazard-events, trains, timers | Alerts, escalations, warnings, slow orders, compensation | Timers |
| Projector | hazard-events, trains | Read models, live notices | Projection tables and versions |
| Notifier | hazard-events | Console, pager, radio, phone deliveries | Notification rows |

| Screen | Read model | Live topics |
|--------|-----------|-------------|
| Operator board | Board (segments, sensors, hazards, slow orders, coverage, trains) | hazards, trains, coverage, restrictions |
| Hazard detail | Hazard doc + event stream + evidence | hazards, alerts, restrictions |
| Alert queue | Alert queue | alerts, hazards |
| Latency / Ops | Latency samples / stream and group info | latency / polled every 3 s |

---

## 🔐 Security

- Gateways authenticate per device (mTLS; a shared token locally) and must match a known segment; lane assignment is server policy.
- People use session cookies; roles are dispatcher (own territory), inspector (own dispatches, close only) and platform operator (DLQ, replay, sensor registry).
- Every command re-checks authorization on the folded hazard; the UI only hides buttons. A West-desk dispatcher acting on a Prairie hazard gets 403 NOT_YOUR_TERRITORY.
- SSE notices carry ids only, so nothing leaks through the push channel.

---

## 🔧 Deep Dive 1: The Seconds Budget, End to End

The latency path has eight hops, and any FIFO hop lets a backlog overtake an emergency:

```
camera ─▶ gateway ─▶ ingest ─▶ outbox relay ─▶ edge.critical ─▶ correlator ─▶ (event store) ─▶
relay ─▶ hazard-events ─▶ process manager ─▶ notifier ─▶ console   and   projector ─▶ SSE ─▶ board
```

**The decision: a priority lane at every hop.**
- The gateway sends critical events first, in their own batch.
- Ingest assigns the lane by server-side policy (a misconfigured gateway can't flood it).
- The relay publishes critical rows before bulk, and is woken by NOTIFY at commit, not by polling.
- Critical and bulk are separate topics; the correlator drains critical before every bulk batch of 20.
- The notifier records deliveries in its transaction, then sends asynchronously, so a slow radio bulletin never blocks the next alert.
- The board refetches on an SSE notice published after the projection commits.

**Why it works.** With a 4,300-event bulk backlog outstanding in the local build, the correlator acted on a new fence trip 56 ms after it occurred. Live alerts reach the console in about 0.8 s at p50 (most of it is the gateway's 1-second send cadence).

**How the alternative breaks.** A single topic with a priority field: Kafka delivers in offset order per partition, so the critical record still waits. A plain FIFO relay: 3,000 bulk outbox rows committed a moment earlier go first. A synchronous notifier: three radio bulletins at ~1 s each delay the next critical page by 3 s.

**What I give up.** No order across lanes (fine, because correlation is order-independent, deep dive 2), more topics and lag to watch, and lane policy to maintain. On the UI side, refetch-on-notice costs extra REST calls, which I coalesce to about three per second per page.

The latency page shows p50/p99 and where the time goes (edge → ingest → detected → alert → console), plus critical vs bulk cloud latency side by side, so the priority lane is visible, not just claimed.

---

## 🔧 Deep Dive 2: Correlation on Event Time, and Showing It Honestly

**Backend decision.** Each edge event becomes evidence with a confidence (fence break 0.85, camera at model confidence, vibration spike 0.35-0.5). The correlator decides from the evidence *set* in a ±30 s, ±0.5 mi window of **event time**:

1. A vibration spike a passing train explains (interpolated PTC positions) is stored and ignored.
2. Evidence that an open hazard of a compatible kind covers joins it (an upgrade if confidence crosses 0.8).
3. Otherwise it clusters with unattached evidence; a noisy-OR across sensors (each sensor counted once) ≥ 0.5 opens a hazard.

A camera at 0.71 and a geophone at 0.425 six seconds apart give one confirmed hazard at 0.83. Two wires on one fence are one sensor.

**Watermarks.** Each gateway reports the oldest event still in its buffer. A silent gateway's segment watermark advances on processing time after 30 s, so its backlog, when it reconnects, is late. Late events are processed, flagged, and can upgrade or downgrade a hazard. I alert **before** the watermark: waiting would add 30-60 s to every alert.

**How the alternatives break.** Arrival-order counters manufacture hazards when two hours of readings arrive in one second. Dropping late events loses the evidence that matters after an outage. Waiting for the watermark is correct and too slow.

**What I give up.** Occasional downgrades and false alarms. A late train report can explain the spikes a hazard was built on; the hazard is downgraded but **never closed automatically**.

**Frontend side of the same decision.** Late data must not look new. Evidence rows show their edge-to-cloud delay ("1 min 57 s late") and a purple late badge; the hazard page plots evidence by event time and milepost with the correlation window drawn as a box; joined evidence is solid, train-explained evidence hollow. Ack countdowns compute from the deadline, not from when the page opened.

---

## 🔧 Deep Dive 3: Exactly-Once Effects = At-Least-Once + Idempotency

Every hop redelivers sometimes: gateways resend batches, the relay republishes after a crash, streams redeliver unacknowledged messages, ops redrives dead letters, an inspector taps Retry. So each consumer has its own dedup key and commits it in the same transaction as its effects:

| Where | Key |
|-------|-----|
| Ingest | (gateway, seq), event id |
| Correlator, process manager | processed-events row |
| Projector | last applied stream version |
| Notifier | event + channel + recipient |
| Browser commands | client command id, stored result |

**The process manager is level-triggered.** On any wake-up (domain event, durable timer, train movement) it folds the hazard stream and appends only what's missing: an alert if none, an escalation if the deadline passed, a warning for each approaching train not yet warned (nearest first), compensation (lift slow orders, release trains) when the hazard closes. Redeliveries find nothing to do.

**In the browser**, `useCommand` creates a command id once per submission and reuses it if the request got no response. The server returns the stored result with `replayed: true`. Closing a hazard also sends the version the person saw; if new evidence arrived since, the server answers 409 HAZARD_CHANGED. Acknowledgments don't check the version, or they'd bounce during every active incident.

**Why not Kafka transactions?** They give exactly-once inside Kafka; my effects span PostgreSQL, Kafka and a pager. Only idempotency keys compose across all three.

**What I give up.** Dedup tables to prune, a fold per wake-up (cheap: ~20 events), and no optimistic UI: an ack shows a spinner for ~100 ms. In a safety workflow I'd rather show the truth a beat late than a lie at once.

---

## 🗺️ The Dashboard

```
┌ Operator board ─────────────────────────────────────────────────────────┐
│ [Open critical 2] [Unacked 3] [Slow orders 4] [Gaps 1] [p50 0.8 s] [p99] │
│ Canyon Sub  MP 100 ─────────────────────────────────────────── MP 180   │
│   CAN-3 ▨ (dead geophone)   ◆ HZ-1005   ◆ HZ-1006 ▬10   ◀C-COALWB(warned)│
│ Prairie Sub MP 180 ─────────────────────────────────────────── MP 260   │
│   ░ heat zone ▬40 ▬25          ◆ HZ-1008              ◀Z-CHIPRA         │
│ Hazard list                                  │ Coverage gaps             │
└─────────────────────────────────────────────────────────────────────────┘
```

- **SVG strip maps** by milepost (how dispatchers think), a few hundred elements: hazards by severity with a text code, slow orders as yellow bars with the speed, trains as arrows (red ring when warned), sensors by type, hatching for blind track.
- **Live updates**: SSE notices with ids only; pages refetch read models. A missed notice costs freshness, never correctness; reconnect bumps every topic.
- **Critical banner** on every page for a new CRITICAL alert, plus the pager as an independent path.
- **Hazard timeline** renders the event stream: version, type, occurred and recorded time, who did it, and what caused it. It is the audit trail.
- **Ops page**: consumer lag and pending per group, outbox backlog, dead letters with redrive, projection replay with before/after checksums, gateway watermarks.

---

## 🔀 Partitioning, Schema Evolution, Replay

- **Partition by track segment.** Correlation is spatial; a segment's sensors and its hazards land on one partition in order. The correlator also locks neighbouring segments within the radius (a halo) so a boundary hazard isn't built twice. Hot segments (a busy crossing, a slide area in a storm) are handled by edge aggregation and splitting the segment. Keying by sensor would split one rockfall across partitions; by subdivision, one storm makes an 80-mile hot key.
- **Schema evolution.** CameraDetectionReported v2 adds a bounding box and model version. An upcaster lifts v1 on read (and in replay); stored events are never rewritten. An unknown v3 dead-letters and is redriven once supported.
- **Replay.** Each projection is a pure reducer; replay rebuilds it from global position 0 and compares checksums with the live table. The hazard board uses the same fold as the process manager.

---

## 🌡️ Heat Risk and Coverage

- **Rail-buckling risk** is a trend, not a detection. For each rail-temperature sensor the correlator fits a line over 15 minutes of samples (by event time, so late samples just slot in). The band is the worse of the current temperature and a 10-minute projection, capped at one band up: watch at RNT + 25°F, elevated + 35, critical + 45 (illustrative). Elevated appends HazardRiskElevated; the process manager alerts at MEDIUM and issues a standing 40 mph heat order; critical tightens it to 25 mph; subsiding lifts it and clears the hazard.
- **Coverage.** A gateway reports SensorHeartbeatMissed after three missed intervals; the correlator's tick marks a gateway silent after 30 s. Both append CoverageDegraded and the board hatches that stretch. The next reading restores it.

> "A quiet segment isn't a safe segment if its geophone died an hour ago. Showing blindness is part of the product."

---

## 📊 Observability

| Signal | Shown where |
|--------|-------------|
| Detection → alert p50/p99 and per-stage breakdown | Latency page, board KPIs, Prometheus histogram |
| Critical vs bulk cloud latency | Latency page |
| Consumer lag and pending per group | Ops page, Prometheus gauge |
| Outbox backlog per lane, events/sec, late events | Ops page |
| Dead-letter depth | Ops page, Prometheus gauge |
| Projection staleness | Ops page |
| Gateway watermark lag | Ops page, board tooltips |

Logs carry event and correlation ids, so one incident can be traced from gateway to pager.

---

## 🚨 Failure Handling

| Failure | Behaviour |
|---------|-----------|
| Backhaul down | Gateway buffers; segment shown as silent; backlog arrives late |
| Cloud down | Interlocks protect trains; on recovery critical first |
| Duplicate batch / republish | Dedup at ingest and in every consumer |
| Consumer crash | Own pending messages reprocessed on restart; no-ops if committed |
| Poison message | Dead-lettered (permanent at once, transient after retries); redrive after the fix |
| SSE drop | "Reconnecting…", then refetch everything |
| Lost command response | Same command id; stored result |

---

## ✅ Design Review Checklist

1. **Source of truth; write success?** Edge events: committed to the inbox with an outbox row (the gateway may then drop them). Hazards: appended to the event store with outbox rows. The UI renders from read models and command responses.
2. **Client retries after losing the response?** Gateways: (gateway, seq) dedup. People: command id, stored result, `replayed: true`.
3. **Failure between steps?** Effects and dedup rows commit together before ack; timers and notifications are rows swept on restart.
4. **Ordering required?** Per hazard (segment key) for the process manager and projections; none for correlation.
5. **Access with async work?** Notices carry ids; every read and command re-checks role and territory.
6. **What breaks first?** Bulk correlation in regional reconnect storms (critical stays fast; heat and coverage lag), then board refetch storms with hundreds of open dashboards (fix: cached board with ETags, per-subdivision boards).

**Successful trace.** A camera sees a stalled truck on a crossing (0.71) during another gateway's 3,000-event upload. The gateway sends it alone; ingest puts it on the critical lane; the relay publishes it first; the correlator opens HZ-1008 (HIGH); the process manager alerts the East desk dispatcher with a timer; the console shows it about a second after the camera saw it, and the board's SSE notice draws a diamond on the Prairie strip. A geophone spike confirms it (0.83, CRITICAL): re-alert, banner, two trains radioed nearest first. The dispatcher acks (his retry returns the stored result), issues a 10 mph slow order and dispatches Bob, who clears it; the slow order is lifted and the trains released automatically.

**Failed trace.** An inspector taps "Hazard cleared" in a rock cut with no signal; the request committed but the response never arrived. The UI says "No response. Retry is safe" and keeps the command id. Back in coverage he retries; the server returns the stored result with `replayed: true`. One HazardCleared, one SpeedRestrictionLifted, one TrainsReleased, no double page.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Hazards | Event-sourced streams | Mutable rows | History is the product; replay |
| Telemetry | State + outbox | Event-source everything | Same guarantee, less machinery |
| Partitioning | Track segment + halo | Sensor / subdivision | Spatial locality without a giant hot key |
| Alert timing | First threshold crossing | Wait for watermark | Seconds matter |
| Priority | Lane at every hop | Priority field | No FIFO hop for a backlog to win |
| Response | Level-triggered process manager | Choreography | Deadlines and compensation need an owner |
| Live UI | SSE ids + refetch | Push deltas into a client store | Missed messages cost freshness only |
| Commands | Command id, confirmed render | Optimistic UI | Server can refuse; safety workflow |
| Late data | Processed and badged | Dropped or hidden | Post-outage evidence matters and must not look new |
| Train control | Advisory, through the dispatcher | Cloud stops trains | Safety stays in the field |

---

## ❓ Follow-ups I'd Expect

- **Cloud down for two hours during a rockfall?** The fence interlock already dropped the signal. The gateway buffers; on recovery the trip goes first, opens a CRITICAL hazard marked late, and still warns trains that are approaching.
- **Five sensors see one rockfall. How many alerts?** One hazard and one alert; extra sensors raise confidence or are stored as corroboration without new events.
- **Every passing train shakes the geophones?** Spikes near an interpolated train position are explained and ignored; a late PTC report explains them retroactively and downgrades the hazard.
- **Nobody acknowledges?** Durable timers escalate: desk dispatcher, chief dispatcher, manager of operations, visible on the alert row.
- **A newly installed sensor isn't registered?** Its events retry as transient, then dead-letter; ops registers it and redrives; other consumer groups skip the redriven message by event id.
- **How do you prove the dashboard matches the log?** Replay the projection from position 0 and compare checksums with the live table.

