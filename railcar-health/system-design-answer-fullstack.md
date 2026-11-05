# Railcar Health — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Data and API → Pipeline → Screens → Deep dives → Traces → Follow-ups → Scale*

> "The prompt is a hot-bearing and hot-wheel monitoring and predictive maintenance system for about 200,000 railcars, from wayside detector data, with risk alerts and the yard response. I'll split it into four pieces end to end. Ingest from detector sites over flaky links. A per-train stream processor that resolves which bearing a reading belongs to and trends it across detectors. An alert workflow with owners, holds and deadlines. And two UIs, a dispatcher queue and a yard tablet, whose inspection findings come back as the labels that tell me whether the alerts are any good. One boundary up front: the detector's own absolute alarm, radioed to the crew, stays local and is the safety path. Everything I build is early warning on top of it."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Two-tier alerting; small data, hard correctness, human workflow |
| Architecture | ~6 min | Gateways → ingest → two lanes → per-trip processor → PostgreSQL → UIs |
| Data, API, pipeline | ~8 min | Idempotency keys; car-relative identity; relative trend features |
| Screens | ~5 min | Queue triage, heatmap, offline tablet, SSE invalidation |
| Deep dives | ~12 min | Trending vs thresholds; late data and partitioning; the alert-to-label loop |
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
│ Ingest API             │──▶│ Raw store          │ (detector, pass) key
└───┬──────────────┬─────┘   └────────────────────┘
    │ fresh        │ late
    ▼              ▼
 ┌──────┐      ┌──────────┐    keyed by trip
 │ live │      │ backfill │
 └──┬───┘      └────┬─────┘
    └──────┬────────┘ live first
           ▼
┌────────────────────────────────┐   ┌────────────────────────────┐
│ Processor (per-trip state)     │◀─▶│ consists by version · AEI ·│
│ identity · trends · rules      │   │ wheelset installs · health │
└────────────┬───────────────────┘   └────────────────────────────┘
             ▼
┌────────────────────────────────┐   ┌────────────────────────────┐
│ PostgreSQL: alerts · owners ·  │──▶│ Notifier · deadline sweeper│
│ holds · work orders · findings │   └────────────────────────────┘
└───┬──────────────┬─────────────┘
    │ REST         │ SSE (ids only)
    ▼              ▼
 Dispatcher console · yard tablet · reliability view
```

1. **Ingest** writes each pass under the detector-assigned key, commits, then publishes to the live lane (under 15 minutes old) or backfill lane (older), then replies. A retry is a duplicate. A crash between commit and publish is healed by the retry or a sweep.
2. **The processor** owns each trip's state (one partition per trip), resolves identity, recomputes every bearing's features from the trip's observations, scores them and commits its decisions in one transaction before acking.
3. **PostgreSQL** holds decisions: alerts, ownership, holds, work orders, findings, the audit trail and the notification outbox.
4. **UIs** read through role-checked REST and refetch when an SSE notice says something changed.

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
| component_installs | one current wheelset per (car, axle); installed_at vs recorded_at | Lifecycle |
| alerts | partial unique (trip, car, kind, position) while not closed; owner, deadline, lifecycle timestamps, version | Decisions |
| alert_events | unique (alert, kind, tier, pass) | Audit trail |
| car_holds, work_orders | unique per alert; audits keyed per trip | Yard workflow |
| findings | unique client_submission_id; source alert, audit, routine, teardown | Labels |
| notifications | unique dedupe_key; delivered_at | Outbox |

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
- **Live updates**: one SSE stream of id-only notices. Each bumps a topic revision, and pages refetch through the normal API. On reconnect everything refetches.

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

### Deep dive 3: From alert to label: ownership, holds, the yard, and SSE

**Decision:** alerts move opened → delivered → acknowledged → inspected → closed, each with an owner and deadline. MEDIUM and up hold the car. Findings are labels, collected exactly once even offline.

```
 opened ──▶ delivered ──▶ acknowledged ──▶ inspected ──▶ closed
   │       (provider        (a person        (finding      (released,
   │        accepted)        owns it)         recorded)     or repaired)
   ├── escalated in place: higher tier, new deadline, maybe a new owner
   ├── ack overdue ─▶ next role in the chain
   ├── approaching the yard, unacknowledged ─▶ that yard's supervisor
   └── handoff: new territory or new yard ─▶ new owner re-acknowledges
```

**Why owners, deadlines and handoffs.** "Delivered" means the provider accepted a message, not that anyone read it. HIGH and CRITICAL are owned by the dispatcher desk for the train's current territory, MEDIUM by the inspectors at the yard that must catch the car. Missed deadlines escalate (desk → chief dispatcher → operations center), and an unacknowledged alert whose train is 30 minutes from its yard warns that yard's supervisor. When the train crosses into another desk's territory, ownership hands off and the new desk must acknowledge. When a held car goes through its yard uninspected, the hold moves to the next yard.

**Why the hold matters.** A work order is a task; a hold is a constraint the train-building system checks. Without it, a busy yard builds the car into the next outbound train.

**Why SSE with refetch.** Traffic is one-way, server to client. Id-only notices and a REST refetch keep the server as the only truth, so reconnects, missed messages and per-viewer filtering are trivial. Polling wastes a large share of a 5-minute deadline. A WebSocket pushing state makes the client a second database to keep consistent and re-authorize.

**Why a client submission id on the tablet.** Yards have dead spots. The form gets its id when it opens, failed submissions are queued locally and resent with the same id, and the server returns the stored finding on a replay. A double tap, a lost response or an app restart all produce one finding.

**Label bias.** Only flagged cars get inspected, so precision is measurable and misses are not. Random audit inspections of unflagged cars (one per arriving train locally), bearing-shop teardown results and routine-inspection defects estimate recall and weight the training data.

**What I give up.** Acknowledging becomes part of two jobs, and I run a sweeper and an audit trail. The alternative fails exactly in the case that matters: delivered, unread, and the car built into the next train.

---

## 📜 Execution Traces (~4 min)

### Successful trace

1. HBD-055's gateway posts a pass. Ingest commits it under `(HBD-055, pass id)`, publishes to the live lane, returns 201.
2. The processor locks the trip, resolves axle 109 north rail to NRLX 304512 R3, recomputes features and scores MEDIUM (steady rise). In one transaction it opens the alert (owner Cedar Junction, ack due in 60 minutes), places the hold and work order, writes outbox rows, marks the pass processed, then acks and publishes a notice.
3. Dispatcher consoles and CDJ tablets refetch; the row appears with "ack due in 60 min".
4. Nobody acknowledges; the sweeper escalates and warns CDJ before arrival. At HBD-126 the alert escalates in place to HIGH, owned by the West desk. The hold follows the train to Ridgeway after it passes CDJ, and at mile 160 the alert hands off to the East desk.
5. At HBD-230 the detector's alarm fires and the alert becomes CRITICAL, mirroring an alarm the crew already has, 175 miles after the first warning.

### Failed trace

1. HBD-112's gateway was offline for two hours. It reconnects and posts four buffered passes newest first; three go to the backfill lane.
2. Analyzer A processes one: SVTX 961204 L1 is a +48°F outlier, the train has arrived, so a MEDIUM routes to Cedar Junction as "hold and inspect before release". A commits, then dies before acking.
3. After 30 seconds, analyzer B claims the pending message, sees `processed_at` set, and acks. Nothing is duplicated; unique keys on alerts, holds, work orders and notifications are the backstop.
4. The gateway lost one reply and re-posts; ingest answers 200 with four duplicates.
5. At CDJ, Bob records "journal bearing defect, bad order" in a dead spot. The tablet queues it, and the resend returns `replayed`. The alert is inspected, the car stays held until its wheelset replacement is recorded, and then the alert closes.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | Raw store for evidence, PostgreSQL for decisions; success = committed, then 2xx or ack |
| Client retries after losing the response? | Pass key → duplicate; submission id → stored finding; version → 409 with current state |
| Failure between two steps? | Commit-then-publish healed by retry or sweep; commit-then-ack healed by reclaim plus `processed_at` |
| Required ordering? | Per trip, by event time, reconstructed from data; no global order |
| Access with caches and async jobs? | Processor writes as system; reads role-checked; SSE ids only, filtered per viewer |
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
| Consist arrives after the pass | Pass parked, republished when the consist arrives |
| Poison message | Dead-lettered after 5 deliveries |
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
| Labels | Findings + audits + teardowns | Findings only | Selection bias hides misses |

## 📝 Wrap-up (~1 min)

> "The detector keeps the safety decision. I add early warning by trending each bearing against its own train, keep identity right through stale consists, turned cars, rebuilt trains and wheelset swaps, and decide everything in event time so bad delivery changes nothing. Every actionable alert has an owner and a deadline, every MEDIUM holds the car, the yard records findings exactly once, and those findings, with random audits, tell me how good the alerts are."

### How the local implementation compares

Express API with idempotent ingest and two Valkey-stream lanes; an analyzer with a consumer group, reclaim, dead letters and a per-trip advisory lock; PostgreSQL for everything (raw readings included); a simulator running five trains in compressed time with every failure above; React 19 screens for the queue, heatmap, car trend, yard tablet, detector health and reliability backtest. Rules stand in for the model; `npm run demo:component-swap` reproduces the wheelset follow-up.
