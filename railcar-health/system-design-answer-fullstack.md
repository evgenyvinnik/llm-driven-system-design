# Railcar Health — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Data and API → Pipeline → Screens → Deep dives → Traces → Follow-ups → Scale*

> "The prompt is a hot-bearing and hot-wheel monitoring and predictive maintenance system for about 200,000 railcars, from wayside detector data, with risk alerts and the yard response. I'll split it into four pieces end to end. Ingest from detector sites over flaky links. A per-train stream processor that resolves which bearing a reading belongs to and trends it across detectors. An alert workflow with owners, holds and deadlines. And two UIs, a dispatcher queue and a yard tablet, whose inspection findings come back as the labels that tell me whether the alerts are any good. One boundary up front: the detector's own absolute alarm, radioed to the crew, stays local and is the safety path. Everything I build is early warning on top of it. And I'll build it event-driven: each alert case is an event-sourced aggregate, raw readings are facts announced through a transactional outbox, and everything downstream (the processor, notifications, the yard integration, the screens' read models) is an idempotent consumer group."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Two-tier alerting; small data, hard correctness, human workflow |
| Architecture | ~6 min | Gateways → ingest + outbox → event store → relay → topics → consumer groups → read models → UIs |
| Data, API, pipeline | ~8 min | Idempotency keys; car-relative identity; relative trend features |
| Screens | ~5 min | Queue triage, heatmap, offline tablet, SSE invalidation |
| Deep dives | ~12 min | Trending vs thresholds; late data and partitioning; event sourcing the case vs outbox for readings |
| Traces, follow-ups, scale | ~9 min | One success, one crash; four follow-ups; what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions

| Question | Assumption |
|----------|------------|
| Does the cloud decide stops? | No. Detector alarms stay local; the cloud mirrors them and adds early warning |
| How does data arrive? | Store-and-forward gateways: at-least-once, out of order, sometimes hours late |
| Which detector types? | HBD and hot/cold wheel in depth, AEI for identity; WILD, acoustic and vision as extensions |
| Who owns the cars? | Mostly lessors and shippers; they get notified |
| What does "predictive" output? | An inspection priority: how likely a defect is found if inspected at the next terminal |
| Users? | Dispatchers (by desk), yard car inspectors (by yard), reliability engineers |

### Functional requirements

1. Idempotent ingest of passes, heartbeats, consists and train movements.
2. Identity resolution to car and car-relative bearing position.
3. Trends within and across trips; brake health from wheels, kept separate from bearings.
4. One alert per bearing per trip, escalated in place; tiers mapped to actions.
5. Owners, acknowledgment deadlines, escalation, handoff; routing that knows where the train is now.
6. Yard holds, work orders, offline-tolerant findings, repairs as component installs.
7. Detector health, and precision and recall from findings and audits.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Edge safety path | Unaffected by any cloud failure |
| Fresh pass to alert | < 30 s p99; on the dispatcher's screen < 5 s after that |
| Late data | Correct for passes up to 72 h old |
| Duplicates | Zero duplicate alerts, holds, work orders, findings |
| Acknowledgment | CRITICAL 5 min, HIGH 15, MEDIUM 60 (illustrative) |

### Capacity

Public figures (cited, not verified): BNSF describes thermal sensors and machine vision over 1.5M+ wheels, 35M+ wayside readings a day processed by AI and 2M+ images a day; Railinc's EHMS covers about 10,000 detectors and 36M train passes a year. The rest are my assumptions:

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Bearings | ~1.6M | 200K cars × 4 axles × 2 sides |
| Car passes | ~1.6M/day | 40% of cars moving × ~20 detectors at 15-mile spacing |
| Sensor values | ~26M/day | × 8 bearings × 2 values; same order as BNSF's 35M+ |
| Train passes | ~16K/day, ~1/s peak | ÷ ~100 cars per train |
| Raw storage | ~0.5 GB/day compressed | ~1 TB over five years |
| Live screens | a few hundred consoles and tablets | One SSE connection each |

> "That is small. The difficulty is in correctness under bad delivery, identity, and the people who have to act on an alert."

---

## 🏗️ Architecture (~6 min)

```
 SITE                                          CLOUD
┌────────────────────────┐
│ HBD · wheel · AEI      │── radio talker ──▶ crew (safety path)
│ gateway: buffer, retry │
└───────────┬────────────┘
            │ at-least-once, late, out of order
            ▼
┌────────────────────────┐   ┌────────────────────┐
│ Ingest API             │──▶│ Raw store (facts)  │ (detector, pass) key
│ facts + outbox, 1 txn  │   └────────────────────┘
└───────────┬────────────┘
            ▼
┌────────────────────────────────┐    relay (CDC)    ┌───────────────────────────┐
│ EVENT STORE (PostgreSQL)       │──────────────────▶│ Topics: readings live /   │
│ case-* · car-* streams         │                   │ backfill (by trip) · cases│
│ outbox rows · case index       │◀─┐                │ · cars (by car) · trips · │
└───────────────┬────────────────┘  │                │ dead letters              │
                │ projections       │ appends        └─────────────┬─────────────┘
                ▼                   │ (expected                    ▼
┌────────────────────────────────┐  │  versions)    ┌───────────────────────────┐
│ Read models: alert queue ·     │  └───────────────│ Consumer groups: analyzer │
│ holds · work orders · car      │                  │ (per trip) · notifier ·   │
│ history · detector health      │                  │ yard integration · ack    │
└───┬──────────────┬─────────────┘                  │ process manager (timers)  │
    │ REST         │ SSE (ids only)                 └───────────────────────────┘
    ▼              ▼
 Dispatcher console · yard tablet · reliability · event timelines · ops
```

1. **Ingest** writes each pass under the detector-assigned key **and** appends `PassRecorded` and `AxleReadingsRecorded` in the same transaction (the outbox), then replies. A retry is a duplicate and appends nothing. There is no separate publish step that can be lost.
2. **The relay** tails the event store and publishes each event to its family's topic: readings to the live lane (under 15 minutes old) or backfill lane, keyed by trip.
3. **The processor** is a consumer group. It owns each trip's state (one partition per trip), resolves identity, recomputes every bearing's features, scores them and appends case events (`AlertRaised`, `CarHoldPlaced`, `WorkOrderOpened`, `NotificationRequested`) in one transaction with its processed-event mark, then acks.
4. **Other groups react**: the notifier delivers, the yard integration opens maintenance tickets, a process manager runs the acknowledgment deadlines, and projectors build the read models the UIs query. UIs refetch when an SSE notice says a read model changed.

What ingest tells the gateway, because the gateway's retry loop depends on it:

| Response | Meaning |
|----------|---------|
| 201 | Something new was stored; drop your copy |
| 200, duplicates | Already had it; drop your copy (a different payload under the same key is counted as a conflict) |
| 422 | Bad batch; alarm the site instead of retrying forever |
| 5xx / timeout | Retry the same batch; it's idempotent |

---

## 💾 Data Model and API (~4 min)

| Table | Key / constraint | Purpose |
|-------|------------------|---------|
| detector_passes | PK (detector_id, pass_id); passed_at (event) and received_at (processing) | Idempotent raw pass, lateness |
| axle_readings | PK (pass, axle, rail); raw columns immutable, resolved car/axle/side derived | Evidence |
| trip_consist_versions, trip_units | (trip, revision) with effective_at; leading end and source per unit | Identity by time |
| events | PK global position; unique (stream, stream version); type, schema version, event time, recorded time, correlation, causation | Event store for case and car streams, outbox for the rest |
| case_index | partial unique (trip, car, kind, position) while open; hold status | Set invariants an event stream can't see; the outbound hold check |
| processed_events, checkpoints | PK (group, event id) | Exactly-once effects per consumer group |
| ack_timers | PK (case, kind), due_at | The process manager's durable timers |
| alerts, car_holds, work_orders, findings, notifications | projections of case events; version = case stream version | Read models for queues and tablets |
| component_installs | projection of the car stream; installed_at vs recorded_at | Lifecycle |

```
POST /api/v1/ingest/passes             idempotent batch → 201 new / 200 duplicates
POST /api/v1/ingest/consists           versioned consist
GET  /api/v1/alerts                    queue (tier, territory, status, late)
POST /api/v1/alerts/:id/acknowledge    owner only, version check → 409 if changed
GET  /api/v1/trips/:id/heatmap         per pass × axle bearing temperatures + highlights
GET  /api/v1/cars/:id/trend            one bearing across detectors and trips
POST /api/v1/work-orders/:id/finding   client submission id → replay returns the stored finding
POST /api/v1/cars/:id/components       wheelset install (event time)
POST /api/v1/yards/:id/outbound-check  held cars are refused
GET  /api/v1/events                    SSE notices, filtered per viewer
GET  /api/v1/event-log/cars/:id        every event about a car, with lineage
GET  /api/v1/event-log/cases/:id       a case's stream, causes and effects
GET  /api/v1/ops/streams               lag, pending, staleness, dead letters; POST /ops/dlq/:id/redrive
```

---

## ⚙️ The Pipeline (~4 min)

**Identity.** The detector says "axle 109, north rail". I pick the consist revision in force when the pass was *measured*, apply any AEI read at that site (it overrides a stale orientation and re-resolves earlier passes), and refuse to guess if the axle count disagrees. Then I convert to a car-relative position: axle 1 at the B-end, sides named facing the A-end from the B-end. A car turned on a wye shows its R3 bearing on the other rail at the other end of its axle sequence, and it is still R3.

**Features**, per bearing per trip, from its list of observations keyed by pass:

| Feature | Why |
|---------|-----|
| Delta vs the median of the same rail in the same pass | Cancels speed, load, braking zones, sun and a scanner's calibration error |
| Rise per 15 miles over the last four readings | Per mile, so a silent detector widens the gap instead of faking continuity |
| Consecutive elevated readings | Persistence |
| Above ambient, bias-corrected | What the edge alarm uses |
| Elevated on recent trips, current wheelset only | Slow degradation |

**Tiers** (illustrative and editable): CRITICAL when the detector alarm fired or ≥195°F above ambient (stop and inspect); HIGH at ≥150°F, or +60°F and rising 8°F per 15 miles (set out or restricted speed); MEDIUM at +35°F over two detectors, a +45°F outlier or a steady rise (hold plus work order at the next terminal); LOW at +20°F twice or warm with a warm history (notify the owner). Each tier comes with its reasons in plain sentences.

**Brakes are a separate failure mode.** Hot wheels mean a stuck or dragging brake; cold wheels in braking zones mean an inoperative brake. They are per-car brake alerts leading to a brake inspection. BNSF's Brake Health Effectiveness program uses thermal detectors for brake health under an FRA test waiver, and rail unions contest it as a replacement for manual inspections, so I treat brake alerts as targeting inspections, not replacing them.

**Components.** A railcar outlives its wheelsets, and a wheelset carries both bearings of its axle. A repair records an install with its event time (when it went on) and processing time (when we were told), and the current wheelset per axle is rebuilt from those events. Readings measured before the install are history of the old wheelset, never evidence against the new one.

**Detector health** comes from the data:

| State | Detected by | Shown to operators as |
|-------|-------------|-----------------------|
| Offline | No gateway heartbeat for 25 minutes | "Delayed: buffering at site" (data will arrive late) |
| Silent | Two or more trains seen on both sides but not here | "Gap: no data coming", with the uncovered stretch on the strip map |
| Biased | Its train median vs its neighbours' on the same trains, ≥12°F over 3+ trains | "Biased", offset shown; absolute features corrected |
| Catching up | Backlog queued in the backfill lane | "Catching up (N queued)" |

**Late-data routing** uses how old the evidence is and where the train is *now*:

| Situation | Route |
|-----------|-------|
| Fresh, en route | Normal tier routing |
| Late, still en route | Same tier; the note says how old and how far the train has moved |
| Late, already arrived | MEDIUM and up to the arrival yard: hold and inspect before release |

---

## 🖥️ The Screens (~5 min)

```
┌ Alert queue ─────────────────────────────────────┬ Detail ───────────────────────┐
│ [All] [● CRITICAL 1] [● HIGH] [● MEDIUM 4] [LOW] │ ▲ CRITICAL  NRLX 304512 R3    │
│▌▲ NRLX 304512 R3 · M-HARRID  ⏱ escalated to NOC   │ ●──●──○──○──○                  │
│▌⚠ SVTX 961204 L1 · ☁ 71 min late · 🔒 held        │ open deliv ack insp closed    │
│▌⚠ HPRX 377120 cold wheels · inoperative brake     │ STOP AND INSPECT · why · owner│
└──────────────────────────────────────────────────┴───────────────────────────────┘
```

- **Queue**: unacknowledged first, then tier. Badges for owner and deadline, late data, held car, and bearing vs brake.
- **Detail**: action first, reasons, the lifecycle stepper (delivered and acknowledged are different steps), audit trail, who was notified, acknowledge with a version.
- **Train heatmap**: rows are detectors in passing order, columns are car axles, colour is the delta vs rail median. The failing bearing darkens down its column. Rows are marked late or biased, and a dashed break says "30 mi with no reading" where a detector was silent.
- **Car view**: one bearing across detectors and trips, a top-down bearing picker, orientation history (consist vs AEI), wheelset history. Readings from a replaced wheelset are hollow markers.
- **Yard tablet**: work orders by priority and train arrival, "Start inspection" as the yard's acknowledgment, a finding form that can't express illegal states, holds, an outbound build check, and an offline queue banner.
- **Event timeline** (car or case): every event with its type and schema version ("v1→v2" when upcast), event time vs recorded time ("learned 2 h later"), stream and version, a correlation colour per business flow and a "caused by" link; clicking shows the payload and the causation chain. This is the audit view and the best debugging tool in the system.
- **Ops / Streams**: consumer lag and pending per group and topic, projection staleness, relay lag, events per second, and the dead-letter list with the error, the payload and a Redrive button.
- **Live updates**: one SSE stream of id-only notices, sent after a projection commits. Each bumps a topic revision, and pages refetch through the normal API. On reconnect everything refetches.

| Client state | Where | Why |
|--------------|-------|-----|
| User, role, desk or yard | Zustand auth store | Shell and route guards |
| Server clock | Zustand clock store | Ages and deadlines in domain time, skew-proof |
| Topic revisions, connection status | Zustand live store | SSE-driven invalidation |
| Filters, selected alert | URL search params | Shareable, refresh-safe |
| Unsent findings | Local storage queue | Survives the tablet app being killed |

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: Trending vs absolute thresholds, and the asymmetric cost of errors

**Decision:** the absolute alarm stays at the edge; the cloud adds trend-based tiers whose actions are cheaper than a stop.

**Why it works.** NTSB's account of East Palestine describes a train that passed three HBDs in about 30 miles, with rising temperatures on the 23rd car at the first two, below the alarm threshold. Only the third reached critical. The AAR's 2023 commitments include a standard for trend analysis of HBD readings for this reason. Trending on the delta vs the train-side median catches the rise early. In my simulation a slowly failing bearing goes MEDIUM at mile 55 and HIGH at mile 126, while the detector's own alarm fires at mile 230. And the delta is robust where absolute temperature isn't: grades, sun, load and a miscalibrated scanner lift the whole rail together, so they cancel.

**Why absolute-only fails.** A low absolute threshold fires on every train coming down a grade on a hot afternoon. Each stop costs hours of network delay and teaches crews to distrust the alarm. A high one is quiet and late. No single number is both early and quiet.

**Why trend tiers don't stop trains.** A trend is evidence, not proof. Turning it into a held car inspected at the next terminal, where the train stops anyway, catches the bearing at a fraction of the cost of a mainline stop. Thresholds are tuned by expected cost (P(defect) × the cost of a failure vs the cost of the action), capped by an **alert-fatigue budget**: holds per 1,000 car passes the yards can actually inspect.

**What a prediction means, and when it's missing.** In production a model scores **inspection priority over the next-terminal horizon**. It can raise a tier or reorder the queue, but never lower a rule tier. If it's down, rules still alert and route, and only the ordering degrades.

**What I give up.** More alerts below the absolute line, each needing an owner and a yard's time. That's why holds are budgeted and the findings loop exists.

### Deep dive 2: Late data, identity and partitioning by trip

**Decision:** partition by trip; keep each bearing's state as an observation list; decide everything in event time; two lanes.

**Why partition by trip.** Relative features need every axle of a pass, and trends need every pass of a trip, both on one writer. By car, each pass would scatter across ~100 partitions and every median would need a shuffle. Cross-trip history changes slowly and is read from a per-car summary where minutes of staleness are fine.

**Why observation lists, and max over prefixes.** A gateway reconnects and delivers a pass from before the train's latest one. An accumulator would fold it in out of order. A list, recomputed, doesn't care. Decisions are sticky (alerts never de-escalate), so the tier is the **maximum over every event-time prefix** of the list. An old hot reading that arrives after a newer normal one opens the same alert it would have opened on time. I found that bug by replaying a late batch: scoring only the latest reading ignored it.

**Why two lanes.** One arrival-ordered stream puts a reconnecting site's six-hour backlog in front of every fresh reading. Late passes go to a backfill lane that the processor samples between live messages, still serialized per trip.

**Event time everywhere.** Lateness, where the train is now, which consist applied and which wheelset was on the axle are all decided by when things happened. A late MEDIUM for a train that has already arrived goes to that yard as "hold and inspect before release", not to a dispatcher.

**What I give up.** Recomputation (trivial at ≤16 points), a second topic and its priority tuning, eventually consistent car history, and unresolvable passes left unused rather than guessed.

### Deep dive 3: Event sourcing the case, state plus outbox for the readings

**Decision:** an alert case (the alert and the yard's whole response to it) is an event-sourced aggregate: its state is the fold of its events, appended with an expected version. Raw readings are not: they are immutable facts in a fact log, announced by outbox events in the same transaction. Every screen reads projections.

```
 case-7f3…:  AlertRaised → CarHoldPlaced → WorkOrderOpened → NotificationRequested
             → NotificationDelivered → AckDeadlineMissed → AlertEscalated → AlertHandedOff
             → AlertAcknowledged → WorkOrderStarted → InspectionFindingRecorded → CaseClosed
```

**Why the case earns event sourcing.** Five actors change one case over hours: the processor (new evidence), a process manager (deadlines, handoffs), dispatchers, inspectors on offline tablets, and the repair track. With a mutable row, two of them writing at once means one silently wins. With a stream, each append carries the version it read, a race becomes a conflict, and the domain decides. A dispatcher who acknowledged version 12 while only a delivery receipt was appended is rebased; one who acknowledged while the alert escalated to CRITICAL gets a 409 showing the escalation. Two tablets that synced "no defect" and then "bearing defect" end with the defect winning and the car held again; the reverse order is refused, because a defect is never erased. And the history is the product: it is the audit trail, the timeline screen and the label set, for free.

**Why the readings don't.** Millions of values a day, never revised, and no rule that relates one reading to the next. There is no state to fold and no invariant to protect, so event-sourcing them would only double storage. They stay facts; the outbox event is a claim check that names them.

**Why the outbox.** "Commit the pass, then publish" has a crash window: a stored pass nobody processes, or a published pass that was never stored. Writing the event in the same transaction removes the window; a relay publishes afterwards, at least once, and consumers drop duplicates by event id in the same transaction as their effects.

**On the frontend.** The screens read projections, which lag their events by tens of milliseconds. Commands therefore answer from the aggregate itself (an acknowledgment returns the new version at once), and SSE notices go out only after a projection commits, so a refetch sees the change. The tablet's client submission id rides inside the case: a resend is recognized as a replay.

**What I give up.** Projections are eventually consistent, so the safety-relevant hold check reads a write-side index instead. Set invariants (one open alert per bearing per trip) need that index too. Every schema change needs a new version and an upcaster: findings went from v1 (source implied) to v2 (alert, audit, routine or teardown), and old rows are upcast on read. And there are more moving parts to watch, which is why lag, staleness and dead letters are a screen.

### Ownership and the yard loop, briefly

Alerts move opened → delivered → acknowledged → inspected → closed, each with an owner and a deadline. HIGH and CRITICAL belong to the dispatcher desk for the train's territory, MEDIUM to the inspectors at the yard that must catch the car. This flow is orchestrated, not choreographed: a process manager keeps **durable timers** (claimed with `SKIP LOCKED`), escalates desk → chief dispatcher → operations center, warns the yard 30 minutes before arrival, and hands the case off when the train crosses into another desk's territory. A MEDIUM holds the car: a work order is a task, a hold is a constraint the train-building system checks. SSE carries ids only because traffic is one-way and the server stays the only truth. Random audits of unflagged cars counter the label bias of inspecting only flagged ones.

---

## 📜 Execution Traces (~4 min)

### Successful trace

1. HBD-055's gateway posts a pass. Ingest commits the pass and its two events under `(HBD-055, pass id)`, returns 201; the relay publishes the readings event to the live lane.
2. The processor locks the trip, resolves axle 109 north rail to NRLX 304512 R3, recomputes features and scores MEDIUM (steady rise). In one transaction it marks the event processed and appends `AlertRaised` (owner Cedar Junction, ack due in 60 minutes), `CarHoldPlaced`, `WorkOrderOpened` and the notification requests to a new case stream, then acks.
3. The alert-queue projector applies them and sends a notice; consoles and CDJ tablets refetch; the row appears with "ack due in 60 min". The case timeline shows each event caused by the readings event.
4. Nobody acknowledges; the process manager's timer fires (`AckDeadlineMissed`) and later warns CDJ before arrival. At HBD-126 `AlertEscalated` to HIGH, owned by the West desk. After the train passes CDJ, `CarHoldMoved` to Ridgeway; at mile 160, `AlertHandedOff` to the East desk.
5. At HBD-230 the detector's alarm fires and the alert becomes CRITICAL, mirroring an alarm the crew already has, 175 miles after the first warning.

### Failed trace

1. HBD-112's gateway was offline for two hours. It reconnects and posts four buffered passes newest first; three go to the backfill lane.
2. Analyzer A processes one: SVTX 961204 L1 is a +48°F outlier, the train has arrived, so a MEDIUM routes to Cedar Junction as "hold and inspect before release". A commits, then dies before acking.
3. The restarted analyzer (or B, after the idle timeout) gets the pending message again. Its processed-event insert finds the row, so it acks without doing anything. Nothing is duplicated; the case index and the stream's expected version are the backstop.
4. The gateway lost one reply and re-posts; ingest answers 200 with four duplicates.
5. At CDJ, Bob records "journal bearing defect, bad order" in a dead spot. The tablet queues it, and the resend returns `replayed`. The case is inspected and the car stays held. The yard maintenance integration is down, so its ticket message retries five times and lands in the dead-letter stream; the Ops page shows it and an operator redrives it after recovery. When the wheelset replacement is recorded (`ComponentReplaced` on the car stream), the integration closes the case.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | Case and car streams for decisions, the fact log for readings; everything else is a projection. Success = the transaction with its events committed, then 2xx or ack |
| Client retries after losing the response? | Pass key → duplicate; submission id → stored finding; stale version → rebased, or 409 if a decision changed |
| Failure between two steps? | Outbox: no commit-then-publish gap. Commit-then-ack healed by redelivery plus processed events; a failing integration retries, then dead-letters |
| Required ordering? | Per key: trip for readings, case for cases, car for components; readings tolerate any order; no global order |
| Access with caches and async jobs? | Consumers write as system; reads and timelines role-checked; SSE ids only, filtered per viewer |
| What breaks first at scale? | People (holds per yard, pages per desk), shown by alert volume and precision; then backfill bursts |

---

## 🧩 Follow-ups I'd Expect

**"A detector uploads a reading from 2 hours ago, but the wheelset was replaced 1 hour ago."** Installs are events with event time and processing time. Scoring uses only readings measured after the current install on that axle, so the old reading is kept as history of the previous wheelset and never counts against the new one. On the car view it's a hollow marker. An open alert built only on pre-install readings closes as `component_replaced`.

**"No AEI read, and the consist was rebuilt at the last yard."** Resolve against the consist revision in force when the pass was measured, using the axle count to confirm. If it still disagrees, leave the pass unresolved until the next AEI site, which re-resolves earlier passes. AEI corrections carry into the new revision.

**"One detector flags nearly every train."** That's the detector. Relative features don't move when a scanner drifts, so bias detection against its neighbours on the same trains flags it within a few trains. Its absolute-only alerts become one maintenance item, not a storm of pages, and the railroad's out-of-service rules govern its edge alarm.

**"The provider accepted the message, nobody acknowledged, and the train is approaching the next yard."** The deadline keeps running after delivery and escalates. At 30 minutes out, that yard's supervisor is warned, and the hold already stops the car from being built into a train. If the car goes through uninspected, the hold moves to the next yard and the handoff is audited.

---

## 🚨 Failure Handling (~1 min)

| Failure | Behavior |
|---------|----------|
| Cloud or link down | Edge alarms still stop trains; gateways buffer; backfill on recovery |
| Consist arrives after the pass | Pass quarantined; the consist event releases it |
| Poison message or downstream outage | Bounded retries, then the dead-letter stream; redrive from the Ops page |
| Projection bug | Fix and rebuild from position 0; `replay` compares with the live table |
| Model service down | Rules keep alerting; predictions marked unavailable |
| SSE disconnected | "Reconnecting…"; pages keep last data; full refetch on reconnect |
| Tablet offline | Findings queued locally, resent with the same id |

## 📈 What Breaks First (~1 min)

> "Not the database: a pass a second fits anywhere. The first limit is human: if MEDIUM precision drops, yards spend shifts on healthy cars and stop respecting holds, and dispatchers stop reading pages. Alert volume per 1,000 car passes and precision by tier are the leading indicators, and thresholds only change through a backtest. Next is a regional outage: thousands of sites reconnecting at once, which the backfill lane absorbs while live stays fast. Then SSE fan-out per API instance, which scales horizontally."

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Safety path | Edge alarm local | Cloud gates stops | Survives any cloud failure |
| Signal | Trended delta vs rail median | Absolute only | Earlier; cancels grade, sun, calibration |
| Stream key | Trip | Car | Medians and trends need the whole pass and trip |
| State | Observation list, max over prefixes | Accumulator, latest only | Arrival order can't change the decision |
| Late data | Backfill lane | One stream | Backlog can't delay fresh readings |
| Identity | Consist by time + AEI, refuse to guess | Current consist | Rebuilt and turned cars stay right |
| Alerts | Owner + deadline + handoff | Notifications | Delivered isn't seen |
| Live UI | SSE ids + REST refetch | WebSocket state / polling | One-way; no divergence; push latency |
| Findings | Client id + offline queue | Plain retries | Exactly once in dead spots |
| Cases | Event-sourced, expected versions | Mutable rows | Races resolve by rule; history is the audit trail |
| Readings | Fact log + outbox | Event-sourced | Volume, no invariants |
| Deadlines | Process manager + durable timers | Choreographed reactions | One owner for a time-based policy |
| Labels | Findings + audits + teardowns | Findings only | Selection bias hides misses |

## 📝 Wrap-up (~1 min)

> "The detector keeps the safety decision. I add early warning by trending each bearing against its own train, keep identity right through stale consists, turned cars, rebuilt trains and wheelset swaps, and decide everything in event time so bad delivery changes nothing. Every actionable alert has an owner and a deadline, every MEDIUM holds the car, the yard records findings exactly once, and those findings, with random audits, tell me how good the alerts are."

### How the local implementation compares

Express API whose ingest writes the fact log and the outbox in one transaction; a PostgreSQL event store with case and car streams; a relay to Valkey Streams (standing in for Kafka topics); consumer groups for the analyzer (per-trip advisory lock), notifier, yard integration, process manager and four projectors, all with processed-events dedupe and a dead-letter stream; a simulator running five trains in compressed time with every failure above; React 19 screens for the queue, heatmap, car trend, yard tablet, detector health, reliability, event timelines and Ops / Streams. `npm run replay -- all` rebuilds every projection and compares; `npm run demo:component-swap` and `npm run replay -- swap-case` reproduce and re-derive the wheelset follow-up.
