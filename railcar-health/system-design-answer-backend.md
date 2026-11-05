# Railcar Health — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → Identity → Trending and risk → Deep dives → Traces → Follow-ups → Scale*

> "The prompt is hot-bearing and hot-wheel monitoring for about 200,000 railcars from wayside detector data, with risk alerts and the yard response. Before drawing anything, I want to say what this system is *not*: it is not the thing that stops a train for a hot bearing. The detector already does that. It compares each bearing to an absolute threshold and announces an alarm to the crew over the radio, and that path has to keep working if my whole cloud is down. What I'm building sits behind it and does what a single detector can't: trend each bearing across successive detectors, keep a stable identity for it through stale consists, turned cars and wheelset changes, route a risk to the person who can act with a deadline, and run the yard workflow whose inspection findings tell me how good my alerts are. Three ideas carry the answer. State is rebuilt from events in event time, so late and duplicated data change nothing. A bearing's identity is car-relative and versioned. An alert has an owner, not just a recipient."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Two-tier alerting; data volume is small, correctness is hard |
| Architecture | ~6 min | Store-and-forward ingest, two lanes, per-trip processing, PostgreSQL for decisions |
| Data model and API | ~5 min | Idempotency keys everywhere; consists and components as versioned events |
| Identity, trending, risk | ~8 min | Car-relative positions; relative features; explainable tiers |
| Deep dives | ~13 min | Trending vs thresholds; late data and partitioning; ownership and the yard loop |
| Traces, follow-ups, scale | ~8 min | One success, one crash, four follow-ups, what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Does the cloud decide whether a train stops? | Sets the safety boundary | No. Detector alarms stay local; the cloud mirrors them and adds early warning |
| Which detectors? | Scope of fusion | Hot bearing (HBD), hot/cold wheel, AEI readers in scope; WILD, acoustic, vision described but not deep-dived |
| How does data reach us? | Delivery semantics | Site gateways store and forward over cellular or satellite: at-least-once, out of order, sometimes hours late |
| Who owns the cars? | Routing | Mostly lessors and shippers, not the railroad; owners get notified (the industry routes detector alerts to them today) |
| What does "predictive" mean here? | Defines the output | An inspection priority over a horizon: how likely the bearing is defective if inspected at its next terminal |
| What is the yard's role? | Ends the loop | Hold the car, inspect it, bad-order or release it, record what was found |

### Functional requirements

1. Ingest passes: per-axle, per-rail bearing and wheel temperatures, ambient, speed, AEI reads, and the detector's own alarms.
2. Resolve each reading to a car, axle and side relative to the car's B-end.
3. Trend each bearing within a trip and across trips; score brakes from wheel temperatures separately.
4. Raise one alert per bearing per trip, escalated in place, with tiers mapped to actions.
5. Route by tier and by where the train is now; own every actionable alert with a deadline.
6. Run the yard workflow: holds, work orders, findings, repairs; measure precision from findings.
7. Track detector health: offline, silent, biased.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Safety-path independence | Edge alarms unaffected by any cloud failure | Mirror, never gate |
| Fresh latency | Pass to alert < 30 s p99 | A live lane backlog can't block |
| Late data | Correct for passes up to 72 h old | Event-time logic, order-independent state |
| Exactly-once effects | No duplicate alerts, holds, work orders or pages | Idempotency keys inside each transaction |
| Acknowledgment | CRITICAL in 5 min, HIGH 15, MEDIUM 60 (illustrative) | Owners, deadlines, escalation |

### Capacity estimate

Public figures (cited, not verified): BNSF says its condition-based maintenance covers 1.5M+ wheels with thermal sensors and machine vision, AI processes 35M+ wayside readings a day and vision handles 2M+ images a day. Railinc's EHMS sees about 10,000 detectors and 36M train passes a year. Everything else here is my assumption.

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Bearings | ~1.6M | 200K cars × 4 axles × 2 sides |
| Car passes | ~1.6M/day | 40% of cars moving × ~20 detectors a day at 15-mile spacing |
| Sensor values | ~26M/day | × 8 bearings × 2 values; same order as BNSF's 35M+ |
| Train passes | ~16K/day, ~1/s peak | ÷ 100 cars per train |
| Raw storage | ~0.5 GB/day compressed | ~1 TB over five years |
| Hot state | ~0.5 GB | ~1,000 trains en route × 800 bearings × ≤16 readings |

> "Volume is small: about a pass a second at peak, under a terabyte over five years. I won't spend the interview on throughput. The hard parts are correctness (identity, ordering, lateness), never touching the safety path, and the human loop: an alert costs either hours of network delay or, if it's missing, a derailment."

---

## 🏗️ High-Level Architecture (~6 min)

```
 WAYSIDE SITE                                         CLOUD
┌──────────────────────────┐
│ HBD scanners N/S · wheel │── radio talker ──▶ crew stops (safety path, local)
│ AEI · gateway (buffer)   │
└────────────┬─────────────┘
             │ store-and-forward: at-least-once, late, out of order
             ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│ Ingest API (stateless)   │──▶ │ Raw store (columnar)     │ passes + axle readings,
│ mTLS · validate · dedupe │    │ key (detector, pass id)  │ immutable
└──────┬────────────┬──────┘    └──────────────────────────┘
       │ fresh      │ late (> 15 min)
       ▼            ▼
┌────────────┐ ┌────────────┐
│ Kafka live │ │ Kafka      │   both keyed by trip id
│            │ │ backfill   │
└─────┬──────┘ └─────┬──────┘
      └──────┬───────┘ live drained first
             ▼
┌───────────────────────────────────────┐   ┌──────────────────────────┐
│ Stream processor, keyed state per trip│◀─▶│ Consist versions · AEI · │
│ identity · observation lists · trends │   │ component installs ·     │
│ rules (+ optional model score)        │   │ detector health          │
└─────────────┬─────────────────────────┘   └──────────────────────────┘
              │ decisions, one transaction each
              ▼
┌───────────────────────────────────────┐   ┌──────────────────────────┐
│ PostgreSQL: alerts · owners · holds · │──▶│ Notifier + deadline      │──▶ desks,
│ work orders · findings · audit · outbox│   │ sweeper (escalation)     │    yards, owners
└─────────────┬─────────────────────────┘   └──────────────────────────┘
              ▼
   Dispatcher console · yard tablets · reliability dashboard
```

**Walking the diagram:**

1. The gateway posts a batch. Ingest writes each pass keyed by the detector's `(detector_id, pass_id)`, commits, then publishes: to the **live** lane if the pass is under 15 minutes old, otherwise to **backfill**. A 2xx means committed.
2. The processor consumes both lanes, live first. All passes of a trip land on one partition, so one writer owns that trip's state.
3. For each pass it resolves identity, recomputes the features of every bearing on the train from that trip's observations, scores them, and commits its decisions (alert, hold, work order, outbox rows) in one transaction before acknowledging the message.
4. The notifier delivers the outbox. A sweeper watches acknowledgment deadlines and escalates.
5. UIs read PostgreSQL through role-checked APIs and get id-only live notices over SSE.

**Three placement decisions worth saying out loud:**

- **The safety path never crosses the network.** If the cloud is down, crews are still stopped for alarms exactly as today. The cloud's CRITICAL tier mirrors an edge alarm to create the incident record and hold the car. It doesn't decide the stop.
- **PostgreSQL holds decisions, the columnar store holds evidence.** Alerts, ownership, holds and findings need transactions and unique constraints. Raw readings need cheap append and scan.
- **The processor is the only writer of alert state.** UIs write acknowledgments, findings and installs through the API. The sweeper writes escalations with guarded updates.

---

## 💾 Data Model (~4 min)

| Table | Key columns | Constraints | Notes |
|-------|-------------|-------------|-------|
| detector_passes | detector_id, pass_id, trip_id, passed_at (event), received_at (processing), axle_count, aei, edge_alarms, payload hash | PK (detector_id, pass_id) | identity_status: resolved, unresolved or awaiting_consist |
| axle_readings | pass key, axle_seq, rail, bearing_f, wheel_f, then resolved car_id, car_axle, car_side | PK (pass, axle, rail) | Raw columns immutable; resolved columns rewritten on correction |
| trip_consist_versions | trip_id, revision, effective_at | PK (trip, revision) | A rebuilt train gets a new revision |
| trip_units | trip, revision, position, unit_id, axle_count, leading_end, orientation_source | PK (trip, revision, position) | orientation_source says consist or AEI |
| component_installs | car_id, axle, component_id, installed_at (event), removed_at, recorded_at (processing) | one current per (car, axle) | Wheelset carries both bearings of its axle |
| alerts | trip, car, kind (hot_bearing, hot_wheel, cold_wheel), position, tier, status, owner_role, owner_id, escalation_level, ack_due_at, delivered_at, acknowledged_at, inspected_at, closed_at, version | partial unique (trip, car, kind, position) where not closed | Escalated in place |
| alert_events | alert, kind, tier, actor, note, at | unique (alert, kind, tier, pass) | The audit trail |
| car_holds, work_orders | car, alert (unique), yard, status | one per alert; audits keyed by trip | Holds block outbound builds |
| findings | client_submission_id (unique), work order (unique), source (alert, audit, routine, teardown), finding, disposition | | The labels |
| notifications | alert, channel, target, dedupe_key (unique), delivered_at | | Outbox; delivered is not acknowledged |

> "Two columns on every pass, `passed_at` and `received_at`, are the whole late-data story. Everything that decides an outcome (trend order, the train's position, which consist applies, which wheelset was on the axle) uses event time. Processing time only says how late we are."

---

## 🔌 API Design (~2 min)

```
POST /api/v1/ingest/passes            batch; idempotent per (detector, pass); 201 new, 200 all duplicates
POST /api/v1/ingest/consists          versioned (revision, effectiveAt)
POST /api/v1/ingest/trip-events       departed / arrived
GET  /api/v1/alerts                   queue by status, tier, territory, late
POST /api/v1/alerts/:id/acknowledge   owner only; version check → 409 if it escalated meanwhile
POST /api/v1/work-orders/:id/start    inspection started (the yard's acknowledgment)
POST /api/v1/work-orders/:id/finding  clientSubmissionId → replay returns the stored finding
POST /api/v1/cars/:id/components      wheelset install with its event time
POST /api/v1/yards/:id/outbound-check which cars may be built into a train
GET  /api/v1/network                  detector health, coverage, lane backlog
GET  /api/v1/events                   SSE, ids only, filtered by role
```

---

## 📥 Ingest and the Two Lanes (~2 min)

The gateway is the hard client here: it buffers on local disk, retries anything it hasn't seen acknowledged, and delivers backlog in whatever order its queue gives.

1. **Validate and authenticate.** mTLS per gateway, and a gateway may only post its own detectors' passes.
2. **Write with the detector's key.** `(detector_id, pass_id)` is assigned at the site, so a retry of the same pass is recognizably the same. A retry with the same key but a different payload hash is a conflict: keep the first, log it, count it.
3. **Commit, then publish, then reply.** If I die after commit but before publish, the gateway never got a 2xx and retries. The retry finds the pass stored but unpublished and publishes it. A sweep covers a gateway that gave up.
4. **Pick the lane by lateness.** Under 15 minutes old goes to live, older goes to backfill.

| Response | Meaning for the gateway |
|----------|-------------------------|
| 201 | Something new was stored: drop your copy |
| 200 with duplicates | Already had it all: drop your copy |
| 422 | Bad batch (unknown detector, malformed): alarm the site, don't retry forever |
| 5xx / timeout | Retry the same batch: it's idempotent |

---

## 🧭 Identity Resolution (~4 min)

A detector reports "axle 109, north rail". I need "NRLX 304512, bearing R3", and R3 must mean the same physical bearing on every trip.

1. **Pick the consist revision in force when the pass was measured.** A train that set out four cars at Cedar Junction has revision 2 from its departure there. A late pass from before that still maps against revision 1.
2. **Apply AEI.** At equipped sites, the RFID read gives each unit's identity and which end leads. It overrides the consist and is carried into later revisions for the same car. Earlier passes of the trip are re-resolved, which is safe because raw columns never change.
3. **Refuse to guess.** If the axle count disagrees with the consist and there's no AEI read, the pass stays unresolved. A reading pinned on the wrong car is worse than none: it accuses a healthy bearing and hides the sick one.
4. **Make it car-relative.** Rail plus direction gives the train side. With the B-end leading, the car's sides are mirrored and axle 1 arrives first. With the A-end leading, axle 4 arrives first. A car turned on a wye shows its R3 bearing on the other rail, at the other end of its axle sequence, and it is still R3.

> "The bug this prevents is real. In my simulation one car was turned on a wye, and the consist still had the old orientation. Its slightly warm L2 bearing only matched its own history, elevated on its last two trips, after the first AEI read corrected the orientation. Without that, it would have looked like a brand-new R3 with no history, and no alert."

---

## 📈 Trend Features and Risk (~4 min)

Per bearing per trip, the state is the **list of its observations keyed by pass**, recomputed on every pass. That's at most about 16 points, so recomputing is free.

| Feature | Definition | Why |
|---------|------------|-----|
| Side delta | Bearing minus the median of the same rail in the same pass | Cancels speed, load, braking zones, sun, a scanner's offset |
| Rise per 15 mi | Slope of side delta over distance, last ≤4 readings | Per mile, so a silent detector stretches the axis instead of faking a step |
| Consecutive elevated | Trailing readings ≥ +20°F | Persistence |
| Above ambient | Bias-corrected | What the edge alarm uses |
| History | Elevated on N of the last 5 trips, on the current wheelset | Slow degradation |

| Tier | Illustrative rule | Action |
|------|-------------------|--------|
| CRITICAL | Detector alarm fired, or ≥195°F above ambient | Stop and inspect (mirrors the edge) |
| HIGH | ≥150°F above ambient, or ≥+60°F and rising ≥8°F/15 mi | Set out or restricted speed to the next inspection point |
| MEDIUM | ≥+35°F at 2+ detectors, a +45°F outlier, or a steady rise ≥6°F/15 mi | Hold plus work order at the next terminal |
| LOW | ≥+20°F at 2+ detectors, or warm and elevated on recent trips | Notify owner, monitor |

Brakes are a different failure mode and are scored apart. A **hot wheel** (tread far above the train-side median at two consecutive detectors) means a stuck or dragging brake. A **cold wheel** (far below the median in every braking zone, where every other car is braking) means an inoperative brake. Both are per-car brake alerts with a brake-inspection action, never bearing alerts. BNSF's Brake Health Effectiveness program uses thermal detectors this way under an FRA test waiver, and rail unions contest it as a replacement for manual brake inspections. So I'd scope brake alerts as targeting inspections, not replacing them.

### Detector health

| State | How I detect it | What it means for trends |
|-------|-----------------|--------------------------|
| Offline | No gateway heartbeat for 25 minutes | Data is buffered at the site and will arrive late (backfill lane) |
| Silent | Two or more trains seen on both sides but not here, heartbeats fine | Nothing is coming: a coverage gap, annotated on any trend that spans it |
| Biased | This detector's train median minus its neighbours', same trains, averaged over 3+ trains, ≥12°F | Absolute features are corrected by the offset; relative ones never noticed |

> "Silent is the dangerous one. An offline gateway is honest: it says it's down and its data comes later. A silent detector heartbeats happily and records nothing, so the only way to see it is from the trains: they were seen at the detectors on both sides, and not here. Operators get a per-detector coverage state (live, delayed, catching up, gap) so they know which stretches of line are uncovered right now."

---

## 🔧 Deep Dives (~13 min)

### Deep dive 1: Trending vs absolute thresholds, and the asymmetric cost of being wrong

**Decision:** keep the absolute alarm at the edge as the safety backstop, and add trend-based tiers in the cloud that ask for *less* than a stop: an inspection at the next terminal, or a set-out.

**Why trending works here.** The NTSB account of East Palestine is the canonical case: the train passed three HBDs in about 30 miles, the first two showed rising temperatures on the 23rd car below the alarm threshold, and only the third reached critical. The AAR's 2023 commitments include developing a standard for trend analysis of HBD readings for exactly that reason. In my simulation the same pattern plays out: a bearing running +29°F over its rail median and rising 7°F per 15 miles goes MEDIUM at mile 55, HIGH at mile 126, and the detector's own alarm only fires at mile 230, 175 miles later. The relative feature works where the absolute one is noisy: speed, load, a braking zone and the sun on one side all lift the whole rail together, so the delta cancels them. It also cancels a scanner's calibration error. My biased detector read 20°F low, and the trend didn't notice.

**Why absolute-only fails.** An absolute threshold low enough to catch the rise early would fire on every train descending a grade on a hot afternoon. The detector would be stopping trains for physics, crews would learn to distrust it, and every stop costs hours of crew time and delays every train behind it. An absolute threshold high enough to be quiet is late by design. There is no single number that is both early and quiet.

**Why not stop on trend.** A trend is evidence, not proof. If MEDIUM stopped trains, the false-positive cost would be the same network delay as a bad absolute alarm. So the middle tiers turn evidence into the cheapest action that still catches the bearing: a hold at the next terminal, where an inspector looks at it with the train stopped anyway.

**What a prediction means.** I define the risk score as an **inspection priority over a horizon**: the probability that this bearing would be found defective if inspected at its next terminal. In production a model produces it next to the rules. It can raise a tier or reorder a queue, but never lower a rule tier. If the model service is down, every rule still fires and routes. Only the ordering degrades, and the UI says "model unavailable".

**Tuning by expected cost under a fatigue budget.** Each tier's threshold is set where the expected cost of acting (stop, set-out, a held car) falls below P(defect) × the cost of a failure, then capped by a budget: how many MEDIUM holds per 1,000 car passes the yards can actually inspect. The reliability page shows both, and the backtest re-scores inspected alerts under proposed thresholds before anyone saves them.

**Label bias.** Precision comes from findings, but findings only exist for cars we flagged, so misses are invisible. I mitigate with random **audit inspections** of unflagged cars (one per arriving train in my build), **teardown results** from bearing shops on every removed bearing, and defects found on routine inspections, which count as misses. Those give the recall estimate and the training weights.

**What I give up.** More alerts below the absolute line, each needing a yard's time and an owner. That's why holds are budgeted and why the feedback loop exists at all.

### Deep dive 2: Late and out-of-order data, identity, and partitioning by trip

**Decision:** partition the stream by trip id; keep each bearing's state as an observation list recomputed per pass; split ingest into a live lane and a backfill lane; decide everything in event time.

**Why partition by trip.** Relative features need every axle of a pass together (the rail median), and trends need every pass of a trip in order. Keying by trip gives one partition one train, with a single writer for its state. Keying by car scatters a pass across ~100 partitions, so computing one median needs a shuffle, and a consist rebuild must coordinate across all of them. Cross-trip history changes slowly, so I read it from a per-car summary at scoring time and accept minutes of staleness there. (Locally, a consumer group plus a per-trip advisory lock gives the same single-writer guarantee.)

**Why observation lists, not accumulators.** A gateway reconnects and delivers its MP 112 pass after the train already passed MP 126. An accumulator (last value, EWMA, slope) would fold MP 112 in as if it came after MP 126. Inserting it into the list and recomputing gives exactly the in-order answer. But features alone aren't enough, because decisions are sticky: once on time, an old hot reading would have opened a MEDIUM that never de-escalates. If it arrives after a newer, normal reading, scoring only the latest would ignore it. So **the tier is the maximum over every event-time prefix of the list**. That's the decision in-order processing would have made, whatever the arrival order. I found this one by replaying a late batch.

**Why two lanes.** One arrival-ordered stream means a site that reconnects with six hours of backlog puts every other site's fresh readings behind it. Ingest routes passes older than 15 minutes to a backfill lane. The processor drains live first and takes backfill two messages at a time between live checks, and both lanes still serialize per trip.

**Late-data routing.** How late the evidence is and where the train is *now* (dead reckoning from its newest pass by measurement time) decide where the alert goes:

| Situation | Route |
|-----------|-------|
| Fresh, train en route | Normal tier routing |
| Late, train still en route | Same tier; the note says how old the data is and how far the train has moved since |
| Late, train already arrived | MEDIUM and up go to the arrival yard: "hold and inspect before release"; no dispatcher page for a stopped train |
| CRITICAL computed late | Incident record; the crew already had the edge alarm |

**Component lifecycle in event time.** The car outlives its wheelsets. Installs are events with an event time and a processing time, and current state is rebuilt from them. Readings measured before the current wheelset's install are history of the old one and never evidence against the new one, however late they arrive.

**What I give up.** Recomputation per pass (trivial at ≤16 points), a second topic and its priority policy, and eventually consistent car history. And unresolvable passes are simply unused until an AEI read or consist arrives. I'd rather lose a reading than accuse the wrong car.

### Deep dive 3: Alert lifecycle, ownership, holds and the yard loop

**Decision:** an alert moves through **opened → delivered → acknowledged → inspected → closed**, each with an owner, a deadline and an audit event. A MEDIUM-or-higher alert creates a car hold and a work order. Findings are the labels.

**Why ownership, not notification.** "We sent the page" is not "someone knows". The notifier records *delivered* when the provider accepts the message, but the deadline keeps running until a person *acknowledges*. HIGH and CRITICAL belong to the dispatcher desk for the train's current territory, with 15 and 5 minutes to acknowledge. MEDIUM belongs to the inspectors at the yard that must catch the car, with 60. If the deadline passes, the sweeper escalates to the next role: desk, then chief dispatcher, then the operations center; for a yard, inspectors, then the general foreman, then the operations center. Each escalation is a guarded update (`WHERE escalation_level = what I read`), so two sweepers can't double-escalate.

**Why explicit handoff.** Trains move. When this one crosses from the West desk's territory into the East's, the alert's owner becomes East and East must acknowledge again: West's acknowledgment proves nothing about East. When a held car goes through its yard uninspected, the hold and work order move to the next yard, with an audit event and a notification.

**Why holds are separate from work orders.** The work order is a task for an inspector. The hold is a constraint the yard's train-building system checks before adding a car to an outbound train. Without the hold, a busy yard builds the car into the next train and the alert's only effect was a message.

**Inspected is not closed.** A finding of "confirmed bearing defect, bad order" moves the alert to *inspected*. The car sits on the repair track with its hold. The alert closes when the repair is recorded as a wheelset install, which also releases the hold. "No defect found" or "repaired on the spot" closes it immediately. Each finding carries the tablet's client submission id, so a double tap or an offline resend records one finding.

**What I give up.** Acknowledging becomes part of two jobs, and I own a sweeper, an escalation chain and an audit trail. The alternative fails exactly where it matters: delivered, unread, and the train arriving at a yard that doesn't know to catch the car.

---

## 📜 Execution Traces (~3 min)

### Successful trace: a slowly failing bearing on M-HARRID

1. At HBD-055 the gateway posts the pass. Ingest commits it under `(HBD-055, pass id)`, publishes to the live lane and returns 201.
2. The processor locks the trip, resolves axle 109 north rail to NRLX 304512 R3 (revision 1, B-end leading), recomputes features and scores **MEDIUM**: steady rise, 7°F per 15 miles over four readings.
3. One transaction opens the alert (owner: Cedar Junction inspectors, ack due in 60 minutes), places the hold and work order at CDJ, writes outbox rows for CDJ and the owner, and marks the pass processed. Then it acks the message and publishes an id-only SSE notice.
4. The notifier marks it *delivered*. Nobody acknowledges, so the sweeper escalates to the general foreman and warns CDJ's supervisor 30 minutes before arrival.
5. At HBD-126 the alert escalates in place to **HIGH**. The owner becomes the West desk with 15 minutes, and since the train went through CDJ uninspected, the hold moves to Ridgeway. At mile 160 it hands off to the East desk.
6. At HBD-230 the detector's own alarm fires and is radioed to the crew. The pass carries it, so the alert becomes **CRITICAL**, mirroring an alarm the crew already has. The trend flagged the bearing 175 miles earlier.

### Failed trace: the processor dies between commit and ack

1. HBD-112's gateway was offline for two hours. On reconnect it posts four buffered passes, newest first. Three are older than 15 minutes and go to the backfill lane.
2. Analyzer A processes Q-HARCDJ's pass: SVTX 961204 L1 is a +48°F outlier, so a **MEDIUM** opens. The train has already arrived, so it routes `yard_post_arrival` to Cedar Junction with a hold. A commits, setting `processed_at`, and is killed before `XACK`.
3. The message sits pending on A's consumer. After 30 seconds idle, analyzer B claims it, locks the pass row, sees `processed_at`, and acks without doing anything. A second alert, hold, work order or page would also collide with the partial unique index and the `alert_id` and `dedupe_key` uniques.
4. The gateway, which lost one reply, re-posts the batch. Ingest answers 200 with four duplicates.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | Raw store for evidence, PostgreSQL for decisions. Ingest succeeds on commit (then 2xx); a processor decision succeeds on commit (then ack) |
| Client retries after losing the response? | Gateway: same pass key, duplicate (republished if it never reached the stream). Tablet: same submission id, stored finding. Dispatcher: stale version, 409 with the current alert |
| Worker fails between two steps? | API between commit and publish: the retry or a sweep republishes. Processor between commit and ack: reclaimed and skipped. Notifier between send and mark: deduplicated by `dedupe_key` |
| Which ordering is required? | Per-trip by event time, reconstructed from the data. No global order |
| Access with async jobs? | The processor writes as a system principal; reads are role-checked; SSE carries ids only, filtered per viewer; owners see only their cars |
| What breaks first at scale, and the evidence? | People: holds per yard per shift and pages per desk, shown by alert volume per 1,000 car passes and precision. Then backfill bursts after regional outages, shown by lane backlog |

---

## 🧩 Follow-ups I'd Expect

**"A detector reconnects and uploads a concerning reading recorded 2 hours ago, but that wheelset was replaced 1 hour ago."** I keep the reading: it resolves to the car and axle and is stored as history of the previous wheelset. Scoring only uses readings whose event time is after the current install on that axle, so it can't count against the new wheelset. An open alert whose evidence all predates the install closes as `component_replaced`, and history rules count only trips on the current wheelset. The install itself is an event with an event time, so if the repair is recorded late, recomputation converges on the same answer.

**"The AEI read is missing and the consist was rebuilt at the last yard."** I resolve the pass against the consist revision in force when it was measured, not the current one. If cars were set out, revision 2 has a different axle count, and the detector's count tells me which applies. If the count still disagrees, I leave the pass unresolved rather than guess, and the next AEI-equipped site resolves the trip (and re-resolves earlier passes). Corrections from earlier AEI reads are carried into the new revision for the same car.

**"One detector suddenly flags nearly every train."** That's the detector, not the fleet. Relative features don't move when a scanner drifts, because every bearing on the rail shifts together. So bias detection (this detector's train median against its neighbours' for the same trains) flags it within a few trains. Its absolute-only alerts get quarantined into a maintenance ticket instead of a storm of dispatcher pages, and maintenance is dispatched. The edge alarm on that detector is governed by the railroad's out-of-service rules, which I surface to operations but don't override.

**"The notification provider accepted the message, nobody acknowledged, and the train is approaching the next yard."** Delivered is not acknowledged, so the deadline is still running. The sweeper escalates on the deadline, and separately warns the next yard's supervisor when the train is within 30 minutes of that yard. Because MEDIUM-and-up already placed a hold, the car can't be built into an outbound train even if nobody reads anything, and if it goes through uninspected, the hold moves to the next yard.

---

## 🚨 Failure Handling (~1 min)

| Failure | Behavior |
|---------|----------|
| Cloud or link down | Edge alarms still stop trains; gateways buffer; the backfill lane catches up |
| Consist arrives after the pass | Pass parked, republished when the consist arrives |
| Poison message | Dead-lettered after 5 deliveries; the trip continues |
| Silent detector | Coverage gap shown; trends computed per mile, annotated |
| Model service down | Rules keep alerting; predictions marked unavailable |

## 📈 What Breaks First and How It Scales (~2 min)

> "At a pass a second, compute is not the constraint. The first thing that breaks is human capacity: if MEDIUM precision falls, a yard spends its shift on healthy cars and starts ignoring holds. I'd watch alert volume per 1,000 car passes and precision by tier, and change thresholds only through the backtest. The second is a regional outage: thousands of sites reconnecting at once. The backfill lane takes it at its own pace while live stays fast, and I'd watch backfill lag. Raw storage grows linearly and slowly; I'd tier it by age."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Safety path | Edge alarm local | Cloud gates stops | Must survive any cloud failure |
| Signal | Trended delta vs rail median | Absolute temperature | Earlier; cancels speed, sun, braking, calibration |
| Stream key | Trip | Car | Medians and trends need the whole pass and trip |
| State | Observation list, max over prefixes | Running accumulator | Arrival order can't change the decision |
| Late data | Backfill lane | One stream | Backlog can't delay fresh readings |
| Identity | Consist by time + AEI, refuse to guess | Current consist | Rebuilt and turned cars stay right |
| Alerts | Owner, deadline, escalation, handoff | Fire-and-forget | Delivered isn't seen |
| Labels | Findings + audits + teardowns | Findings only | Selection bias hides misses |

## 📝 Wrap-up (~1 min)

> "To summarize: the detector keeps the safety decision. I add early warning by trending each bearing against its own train, keep its identity through stale consists, turned cars and wheelset swaps, and decide everything in event time so late and duplicate data change nothing. Every actionable alert has an owner and a deadline, every MEDIUM holds the car, and every finding feeds back into how good the alerts are, with random audits so I can see what I miss."

### How the local implementation compares

The repository builds this with an Express API, a Valkey-streams analyzer (live and backfill lanes, consumer group, reclaim and dead letters, per-trip advisory lock), PostgreSQL for everything, and a simulator that runs five trains in compressed time with a heating bearing, a turned car, a stale consist, a train rebuilt at a yard, a biased and a silent detector, a gateway outage with out-of-order delivery and retries, a stuck brake and an inoperative one. Rules stand in for the model. `npm run demo:component-swap` reproduces the wheelset follow-up end to end.
