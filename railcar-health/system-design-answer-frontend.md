# Railcar Health — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Users and requirements → Architecture → State and data flow → Alert queue → Heatmap and trends → Yard tablet → Deep dives → Traces → Follow-ups*

> "The prompt is hot-bearing monitoring and the yard response for about 200,000 railcars. On the frontend there are really three products sharing one backend. A dispatcher console: a queue of risk alerts that someone has to triage under pressure, where every false alarm costs trust and every missed one could cost a derailment. A yard tablet: car inspectors walking a yard with patchy coverage, who must record what they found exactly once. And a reliability view: engineers tuning thresholds from inspection outcomes. The detector already radios its own alarm to the crew, so none of these screens is in the safety path. My job is to make early warning usable: show *why* an alert exists, *how old* its evidence is, *who owns it* and *what to do*, and never let a flaky connection lose or duplicate a finding. The backend is event-driven: each alert case is an event-sourced stream, so I also get to show its history, event by event, and I have to design for read models that trail their events by a moment."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Users and requirements | ~5 min | Three personas, three screens; alert fatigue is the enemy |
| Architecture and state | ~6 min | REST as truth, SSE as invalidation, server clock, small stores |
| Alert queue and detail | ~6 min | Triage order, badges that carry meaning, the lifecycle stepper |
| Heatmap and trend chart | ~5 min | One picture that shows a trend across detectors |
| Event timeline and ops | ~3 min | Every event with its two clocks and its lineage; lag and dead letters as a screen |
| Deep dives | ~14 min | Triage under fatigue; SSE vs polling vs WebSocket; offline tablets against an event-sourced case |
| Traces and follow-ups | ~9 min | One success, one failure, four follow-ups |

---

## 🎯 Users and Requirements (~5 min)

### Personas

| Persona | Device and setting | What they need in 10 seconds |
|---------|--------------------|------------------------------|
| Dispatcher (a desk covering territory) | Multi-monitor console, constant interruptions | Which alert needs me now, what action, and has it been acknowledged |
| Yard car inspector | Rugged tablet, gloves, weak Wi-Fi or cellular | Which cars to inspect, why, and recording the finding once |
| Reliability engineer | Desktop | Is each tier right often enough; what would a threshold change do |

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Does any screen stop a train? | Sets the stakes of UI bugs | No. The detector radios its own alarm; the console adds early warning and routing |
| Who acknowledges what? | Drives the queue design | Dispatchers own train-handling alerts (HIGH, CRITICAL); yards own car inspections (MEDIUM) |
| Do yard tablets have reliable connectivity? | Online-only vs offline-tolerant | No: dead spots between cars are normal |
| How fresh must the queue be? | Push vs poll | CRITICAL has a 5-minute acknowledgment deadline (illustrative) |
| Is the data in real time? | Clock handling | Locally, the simulator compresses time; the server's clock is the reference |

### Functional requirements

1. **Alert queue**: by tier, filtered by territory (desk or subdivision), with late-data, held-car, owner and acknowledgment-deadline badges.
2. **Alert detail**: reasons, features, the lifecycle (opened → delivered → acknowledged → inspected → closed), the audit trail, who was notified, and acknowledging with an action.
3. **Train view**: an axle-by-detector heatmap of bearing temperatures with alerted bearings highlighted, the passes with lateness, and AEI orientation corrections.
4. **Car view**: one bearing's trend across detectors and trips, a bearing picker, orientation history, wheelset (component) history.
5. **Yard queue**: work orders sorted by priority and train arrival, an offline-tolerant finding form, car holds, an outbound build check.
6. **Detector health**: a strip map of the line with coverage gaps, a freshness state per detector.
7. **Reliability**: precision by tier and failure mode, recall from audits, thresholds with a backtest.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| New CRITICAL on screen | < 5 s after the backend decides | Push, not slow polling |
| Correctness after reconnect | Never a stale "acknowledged" or a missed escalation | Refetch on reconnect; server is the truth |
| Finding submission | Exactly once, works offline | Client-generated idempotency key, a durable local queue |
| Time | Ages and deadlines in the domain clock | Server-provided "now" |
| Accessibility | Tier never by colour alone | Label + icon + colour; tables for chart data |
| Heatmap | ~100 cars × 16 detectors without jank | Memoized SVG cells, one hover handler |

---

## 🏗️ Architecture (~6 min)

```
┌────────────────────────────────────────────────────────────────────────┐
│ React SPA (Vite, TanStack Router, Zustand, Tailwind)                   │
│                                                                        │
│  routes: /alerts /trains/$id /cars/$id /yard /detectors /admin         │
│          /timeline?car=|case=   /ops                                   │
│                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ auth store   │  │ clock store  │  │ live store   │  │ offline    │  │
│  │ user, role   │  │ server "now" │  │ per-topic    │  │ finding    │  │
│  │ desk / yard  │  │ + speed      │  │ revisions    │  │ queue (LS) │  │
│  └──────────────┘  └──────────────┘  └──────▲───────┘  └─────┬──────┘  │
│         ▲  pages fetch via services/api.ts  │ bump           │ resend │
└─────────┼───────────────────────────────────┼────────────────┼────────┘
          │ REST (role-checked)               │ SSE notices    │ POST finding
          ▼                                   │ (ids only)     ▼ (same submission id)
┌──────────────────────────────────────────────┴────────────────────────┐
│ API: alerts · trips · cars · yards · work orders · network · admin    │
│      reads PROJECTIONS · commands append to CASE STREAMS              │
│      /event-log (timelines from the event store) · /ops (lag, DLQ)    │
│      /events (SSE, sent after a projection commits, filtered)         │
└────────────────────────────────────────────────────────────────────────┘
```

**Walking the diagram:**

1. Every screen reads through a typed API client. The server is the source of truth: queues read projections built from events, commands append events to a case stream, and timelines read the event store itself.
2. One SSE connection per tab carries small notices: "alert X escalated", "work order changed at CDJ", "detector status changed". Each notice bumps a per-topic revision in a Zustand store. Pages list the revisions they care about as effect dependencies and refetch.
3. Every list response carries the server's clock, which the clock store keeps and extrapolates. Relative ages, ack countdowns and "data 70 min late" all use it.
4. The yard tablet's finding form goes through an offline queue that persists to local storage and resends with the same submission id.

> "I'm deliberately not building a client-side copy of alert state that the push channel mutates. The push channel says *something changed*; the REST read says *what is true*. That makes reconnects, missed messages, permission filtering and multiple tabs all boring."

### Routes and who sees them

| Route | Dispatcher | Yard inspector | Reliability engineer |
|-------|-----------|----------------|----------------------|
| /alerts | All territories, filter defaults to their desk | Only their yard's alerts (server-enforced) | All |
| /trains, /cars | Yes | Yes | Yes |
| /yard | — | Their yard only | Any yard |
| /detectors | Yes | Yes | Yes |
| /admin | — | — | Yes |
| /timeline | Any car or case | Cars; cases of their yard only (server-enforced) | Any |
| /ops | — | — | Yes |

### State placement

| State | Where | Why |
|-------|-------|-----|
| User, role, desk or yard | Zustand auth store | Needed by the shell and route guards |
| Server clock | Zustand clock store | Simulated time in the demo; skew-proof in production |
| Live revisions, connection status | Zustand live store | Cross-page invalidation |
| Filters, selected alert, tab | URL search params | Shareable, survives refresh, back button works |
| Fetched lists and details | Component state via a small `useFetch` | Each page owns its data; no global cache to invalidate |
| Unsent findings | Local storage queue | Survives an app kill on a tablet |

---

## 🚨 The Alert Queue (~6 min)

```
┌──────────────────────────────────────────────────────────────┬───────────────────────────┐
│ [All 7] [● CRITICAL 1] [● HIGH 0] [● MEDIUM 4] [● LOW 2]      │ ▲ CRITICAL  🔒 car held   │
│ [All territories ▾] [Open and acknowledged ▾] [☐ Late only]   │ NRLX 304512  bearing R3   │
├──────────────────────────────────────────────────────────────┤ HOT BEARING · M-HARRID EB │
│▌▲ CRITICAL  NRLX 304512 hot bearing · R3 on M-HARRID EB      │ ●──●──○──○──○              │
│▌  ↑ escalated  🔒 car held  ⏱ escalated to operations center │ open deliv ack insp closed │
│▌  Detector's own alarm fired (already radioed to the crew)   │ Owner: East desk · overdue│
│▌                                   East desk → RDG · 2 h ago │ ┌───────────────────────┐ │
├──────────────────────────────────────────────────────────────┤ │ STOP AND INSPECT      │ │
│▌⚠ MEDIUM  SVTX 961204 hot bearing · L1 on Q-HARCDJ EB        │ └───────────────────────┘ │
│▌  ☁ data 1 h 11 min late  🔒 car held  ⏱ ack due in 12 min    │ Why · features · timeline │
│▌  +48°F vs train-side median at HBD-112 (sudden outlier)     │ notified · [Acknowledge]  │
└──────────────────────────────────────────────────────────────┴───────────────────────────┘
```

**Ordering.** Unacknowledged before acknowledged before closed, then tier, then most recently escalated. A CRITICAL the desk has already acknowledged drops below an unacknowledged MEDIUM, because the queue is a to-do list, not a severity ranking.

**Every badge carries a decision:**

| Badge | Why it's there |
|-------|----------------|
| Tier (label + icon + colour) | What kind of action; never colour alone |
| ⏱ ack due / overdue / escalated to … | Whether anyone owns it yet |
| ☁ data N min late | The train has moved since; the note says how far, or that it already arrived |
| 🔒 car held / bad-ordered | The yard can't build this car into a train |
| Kind: hot bearing vs hot/cold wheels · brake | Different failure modes, different inspections |
| Owner and route ("East desk → RDG") | Who must act and where the car will be caught |

**The detail panel** leads with the action ("STOP AND INSPECT", "Bearing inspection at next terminal") and the route note, then the reasons in plain sentences ("+72°F vs train-side median, rising 9.1°F per 15 mi across 6 readings"). Then a features grid, the lifecycle stepper with timestamps, the audit trail and who was notified. Acknowledging is a single select plus an optional note, sent with the alert's version.

---

## 🌡️ Heatmap and Trend Chart (~5 min)

```
              car 10     car 20  ▼R3 CRITICAL car 30  ...                car 80
HBD-010 MP 10 ░░░░░░░░░░░░░░░░░░│▒│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
HBD-025 MP 25 ░░░░░░░░░░░░░░░░░░│▒│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  ...                           │▓│
HBD-112 late  ░░░░░░░░░░░░░░░░░░│▓│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
HBD-140 bias  ░░░░░░░░░░░░░░░░░░│▓│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
- - - 30 mi with no reading - - -  (HBD-170 silent)
HBD-185 MP185 ▒▒▒░▒░░░▒░░▒░░░░░░│█│░░▒░░░░▒░▒░░░░░▒░░░░░░░░░▒░░░░░░░░░░░░░░
HBD-230 MP230 ░░░░░░░░░░░░░░░░░░│█│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

- **Rows** are detector passes in the order the train passed them (two rows each, north and south rail). **Columns** are car axles from the head end. The colour is a one-hue warm ramp, by default the temperature *relative to that rail's median in that pass*, with a toggle to "above ambient".
- **The trending bearing reads top to bottom**: its column darkens detector by detector. Alerted bearings get rails on both sides of the column rather than an outline over it, so the cell colour stays visible.
- **Row annotations** say what the picture can't: "late" (this pass arrived after the train had moved on), "bias" (this detector reads off, corrected in scoring), and a dashed break "30 mi with no reading" where a silent detector left a gap. A trend across a gap is weaker evidence, and the UI shouldn't hide that.
- **One hover handler** on the SVG computes the column and row from coordinates and shows car id, axle, rail, °F, above ambient and vs median. 640 columns × 30 rows is about 19,000 rects, memoized on data and mode, so hovering never re-renders the grid.

> "Why relative-to-median by default? Above ambient makes every train coming down a grade look hot, and makes the sunny side of every train look warmer. The relative view is what the scoring uses, so the dispatcher sees the same thing the alert saw."

**The car view's trend chart** plots one bearing across detectors (x: miles from origin) with one line per trip, and dashed reference lines for the illustrative LOW, MEDIUM and HIGH levels. The bearing picker is a top-down car diagram, B-end to A-end, with sides named the way the inspector names them. Hollow markers mean *measured on a wheelset since replaced*, history rather than evidence. An orientation table shows each trip's leading end and whether it came from the consist or an AEI read.

---

## 📋 The Yard Tablet (~3 min)

```
┌──────────────────────────────────────────────────────────────┐
│ Cedar Junction Yard — inspection queue      ☁ 1 finding waiting to sync [Retry] │
│ [To inspect (4)] [Completed]                                 │
├──────────────────────────────────────────────────────────────┤
│ ⚠ MEDIUM  SVTX 961204 hot bearing · L1  Q-HARCDJ  ☁ 71 min late │
│ Train arrived 3 h ago · +48°F vs median at HBD-112           │
│ Data is 71 min old. Hold the car and inspect before release. │
│ [Start inspection]  [Record finding]                         │
│  Finding: (•) Journal bearing  ( ) Brake  ( ) Wheel  ( ) None │
│  Disposition: (•) Bad-order  ( ) Wheelset replaced  ( ) Release│
│  submission 9da9bcd3                       [Record finding]  │
└──────────────────────────────────────────────────────────────┘
```

- **Sorted by priority, then by when the train arrives.** Cars on trains that already arrived come first, because the car is in the yard now.
- **"Start inspection" is the yard's acknowledgment.** It stops the escalation clock and shows the dispatcher that a person owns it.
- **The form makes illegal states impossible**: a confirmed defect can't be released as is; "wheelset replaced" requires the new serial and install time.
- **Audits** appear as their own cards: a random unflagged car per arriving train, to measure what the alerts miss.

---

## 🛤️ Detector Health and Reliability Screens (~3 min)

```
 Harlow Sub · WEST desk      Prairie Sub · WEST desk      Ridgeway Sub · EAST desk
 ●──●──●──●──●──●──●──●─■─●──◐──●──○ - - - - ●──●──●──●──■
 10 25 40 55 70 85 100 112 CDJ 126 140 155  170 gap 30 mi 185 200 215 230 RDG
                                    ◐ HBD-140 biased   ○ HBD-170 silent
 Analyzer lanes: live 0 queued · backfill 0 queued
```

- **The strip map** shows the line as operators think of it: subdivisions with their desks, yards as squares, detectors coloured by status and labelled in text when they aren't OK, and red dashed stretches where no working detector covers more than the configured spacing.
- **Coverage per detector** is a freshness state, not just up/down: *live*, *delayed* (the gateway is offline and buffering; data will arrive late), *catching up* (a backlog is queued in the backfill lane) and *gap* (silent: nothing is coming). During an outage a dispatcher needs to know which of those applies before trusting a quiet queue.
- **Detector detail** shows the evidence behind a status: recent trains with their train-median temperature, the bias samples (this detector minus its neighbours on the same trains), and the trains that were seen on both sides but not here.
- **The reliability page** shows precision by tier and by failure mode (bearings and brakes separately), a recall estimate from random audits and routine-inspection defects, alert volume per 1,000 car passes (the fatigue budget), late-pass share, and the alert lifecycle (how many escalated for acknowledgment, median time to acknowledge). Thresholds are a form with a **backtest** button: it re-scores every inspected alert under the proposed values and shows per-tier alerts and precision before and after, and how many confirmed defects would drop below MEDIUM. Saving sends the version, so two engineers can't silently overwrite each other.

### What a prediction means on screen

The score is an **inspection priority**: how likely the bearing is defective if inspected at its next terminal. In the UI it shows up as the order of the queue and the reasons, never as a promise like "fails in 40 miles". If the model service is down, the rules still create and route every alert. The queue falls back to rule tiers and marks predictions as unavailable instead of hiding the column. And because only flagged cars get inspected, the reliability page labels its precision as "from inspection findings" and puts the audit defect rate next to it, so nobody mistakes a selection-biased number for the truth.

---

## 🧾 Event Timeline and Ops / Streams (~3 min)

```
┌ Event timeline · HPRX 555001 ──────────────────────────────┬ Selected event ──────────────┐
│ [Identity 1] [Trends 1] [Cars 1]                3 events   │ BearingTrendUpdated  v1      │
│ #1324 00:27  rec 01:27 · learned 1 h later                 │ stream trip-DEMO… #13        │
│       ComponentReplaced v1  car-HPRX 555001 #1 · bob       │ occurred 23:27 (event time)  │
│       Axle 2: wheelset WS-2026-118842 installed            │ recorded 01:27 (2 h later)   │
│ #1340 23:27  rec 01:27 · learned 2 h later                 │ correlation pass:HBD-100/…   │
│       BearingTrendUpdated v1  ↳ caused by AxleReadings…    │ CHAIN PassRecorded →         │
│       L2 reading predates the current wheelset: history    │   AxleReadingsRecorded → this│
└────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

- **The timeline** lists every event about a car (its own stream, its cases, its trips) or about a case (its stream plus what caused it and what it caused), in commit order. Each row has the two clocks side by side, event time and recorded time, with a "learned 2 h later" chip when they differ: that one chip explains every late-data question. It shows the type, the schema version ("v1→v2" in amber when an old event was upcast on read), the stream and its version, a colour per correlation id so one business flow reads as one colour down the list, and a "caused by" link. Clicking opens the full envelope, the payload (and the stored payload when it was upcast) and the causation chain from the root event to the events this one caused.
- **Who it's for.** A dispatcher asking "why is this car held at Ridgeway?" follows `CarHoldMoved` back to the `TripPositionUpdated` that triggered it. A reliability engineer checks that a reading from before a wheelset swap was set aside. And it's the best debugging view the team has.
- **Ops / Streams** (reliability engineers) shows the pipeline as numbers: events per second as a sparkline, relay lag, consumer lag and pending per group and topic, projection staleness in seconds, durable timers, and the dead-letter list with the error, the attempt count, the raw payload and a Redrive button. It polls every 2 seconds; it is a control room, not a page that needs push.

## 🧱 Component Structure (~1 min)

| Area | Components | Notes |
|------|-----------|-------|
| Shell | AppShell, TierBadge, LateBadge, HoldBadge | Role-based nav; live status and sim-speed chip |
| Alerts | AlertFilters, AlertRow, AlertDrawer, Lifecycle, FeatureGrid, AckForm | Drawer driven by `?alert=` |
| Trains | Heatmap, HeatLegend, PassTable, TrainSummary | Heatmap memoizes cells; one hover handler |
| Cars | TrendChart, BearingPicker, CarTrips | Hollow markers for superseded wheelsets |
| Yard | WorkOrderCard, FindingForm, HoldsPanel, OutboundCheck | Finding form owns its submission id |
| Detectors | StripMap, DetectorTable, DetectorDetail | Coverage badge per detector |
| Admin | PrecisionTable, ThresholdForm, BacktestResult | Version-checked save |
| Events | EventList, EventRow, EventDetailPanel, PayloadView | Family filters; selection in `?event=` |
| Ops | OpsTiles, Sparkline, GroupTable, DeadLetters, FaultPanel | Polled; redrive and fault injection |

Each component stays under ~150 lines; icons are separate components; API calls live in `services/`.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Triage under alert fatigue

**Decision:** design the queue as an ownership to-do list with explained, budgeted alerts, not a severity-sorted feed of everything the analyzer noticed.

**Why it works.** A dispatcher who opens the queue needs three answers: what is unowned, what is the action, and why should I believe it. Sorting unacknowledged first and showing the deadline ("ack due in 4 min", "escalated to chief dispatcher") answers the first. Leading the detail panel with the action and the route note ("Mechanical forces at RDG notified, ETA 13 min") answers the second. Plain-sentence reasons and the heatmap answer the third. The tiers above the queue double as a fatigue gauge: if MEDIUM is 40 every shift, the thresholds are wrong, and the reliability page is where that gets fixed with a backtest.

**Why a severity feed fails.** If every LOW sits above the fold, the one CRITICAL that matters is one line among forty. Dispatchers learn that the queue is mostly noise and start acknowledging in bulk, and from then on an acknowledgment means nothing. A feed sorted by severity also hides the most dangerous state, *delivered but unacknowledged*, because a CRITICAL looks the same whether someone owns it or not.

**Late data has to be visible, not just correct.** An alert computed from a pass that sat in a gateway for 70 minutes is about a train that has moved 50 miles or already arrived. The badge says how late; the route note says where the train is now. Without it, a dispatcher calls a crew about a train that is parked in a yard.

**What I give up.** The queue is opinionated: an acknowledged CRITICAL sinks below an unacknowledged MEDIUM, which surprises people at first. LOW alerts, which need no acknowledgment, live at the bottom and are easy to ignore. That's intended, because their consumer is the car owner, not the dispatcher.

### Deep dive 2: Real-time updates: SSE vs polling vs WebSocket

**Decision:** one SSE stream per tab carrying id-only notices, with a REST refetch on every notice and on every reconnect.

**Why SSE fits.** The traffic is entirely server to client: "alert X escalated", "work order changed". Dispatchers act through ordinary POSTs. SSE gives push latency (a new CRITICAL on screen within a second of commit) over plain HTTP, and the browser's `EventSource` reconnects by itself. On every (re)connect the client bumps all topics and refetches, so anything missed while disconnected is picked up. The server filters notices per viewer before writing them (a yard inspector only hears about their yard), and because notices carry ids, not data, the refetch goes through the normal role-checked API. The push channel can never show someone something the API wouldn't.

**Why polling fails here.** A 30-second poll on a 5-minute CRITICAL deadline wastes 10% of the window on average and 10% more for every page a dispatcher has open. Polling every 2 seconds across a few hundred consoles is a steady load of mostly-empty responses, and it still can't tell the user *what* changed, so the flash-on-escalation affordance needs diffing on the client.

**Why a WebSocket with pushed state fails.** A bidirectional socket that pushes alert objects tempts you into a client-side store mutated by deltas. Then reconnects need sequence numbers and replay, multiple tabs diverge, and every permission check has to be duplicated in the push path. None of that buys anything when the client never needs to send on the socket.

**Notices wait for the read model.** Screens read projections that trail their events by tens of milliseconds. If a notice went out when the event was written, the refetch could race the projector and show the old state. So the projector sends the notice after it commits, and a command answers from the aggregate itself (the new version, the new status), so the person who acted sees their own write at once.

**What I give up.** A notice costs a refetch (cheap: queues are small lists), and SSE needs care with proxies that buffer (the server sets no-transform headers and sends keep-alive comments). If the connection is down, the shell shows "Reconnecting…" and the page still works from its last fetch.

### Deep dive 3: Offline tablets against an event-sourced case

**Decision:** the backend models each alert case as an event-sourced stream with versions; readings stay plain facts announced through an outbox. On the tablet, the finding form gets a `clientSubmissionId` when it opens, failed submissions wait in a persistent local queue and are resent with the same id, and any conflict is settled by a domain rule on the server, never by whichever tablet synced last.

**Why the case is a stream and the readings aren't, from where I sit.** A case is touched by many hands: the analyzer escalates it, a process manager hands it to another desk, a dispatcher acknowledges it, two inspectors with patchy coverage inspect the same car. Each command carries the version it was looking at, so the server can tell *what changed since you looked*. That turns every conflict into something the UI can explain instead of a silent overwrite. The readings are different: millions of immutable values with no rule between them, nothing anyone edits, so there is nothing to version and nothing to show but the data itself. They stay facts, and my heatmap reads them directly.

**How the tablet uses it.** When Bob taps "Record finding" in a dead spot, the tablet keeps the submission and shows "1 finding waiting to sync". Back in coverage it resends with the same id; a lost response followed by a resend comes back `replayed`, the stored finding. If a second inspector already recorded a finding for the same work order, the server compares severity: a later defect supersedes an earlier "no defect" (the car is held again and the case goes back to *inspected*), and a later "no defect" against a recorded defect is refused with 409 `FINDING_CONFLICT` and the stored finding, which the tablet shows to the inspector. The tablet records `observedAt` (when he looked) apart from the server's `recordedAt`, and the case timeline shows both.

**Why a mutable row plus "retry the POST" fails.** Without a client-chosen id, a request that reached the server but lost its response is indistinguishable from one that never arrived, so a retry records a second finding. Without versions, two tablets that disagree end with whichever synced last: a "no defect" synced late can erase a "bearing defect", release the hold and send a bad bearing out in the next train. Generating the id on submit instead of on open has its own bug: a double tap makes two ids.

**The same idea on the dispatcher's console.** An acknowledgment carries the version the dispatcher saw. If only bookkeeping happened since (a delivery receipt, a deadline timer re-armed), the server rebases it; if the alert escalated, it answers 409 with the list of changes ("AlertEscalated") and the drawer explains what changed before she acknowledges again.

**What I give up.** Read models trail events, so I rely on the command response for my own writes and on notices sent after the projection commits. Local storage can be cleared or blocked; the queue is best-effort for one device, not a sync engine. A finding queued offline doesn't release the hold until it syncs, which is the safe direction to fail. And the server's rules have to be explained in the UI, or a refused finding just looks like a bug.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a dispatcher acknowledges an escalated alert

1. The analyzer escalates NRLX 304512 R3 to HIGH and commits. The owner is the West desk, ack due in 15 minutes. The API instance's subscriber relays the notice to every SSE client allowed to see it.
2. Alice's tab receives `alert.escalated`. The live store bumps the alerts revision and records the id. The queue refetches, and the row moves to the top and flashes.
3. She opens it. The URL becomes `/alerts?alert=…`, and the drawer fetches the detail: reasons, lifecycle (opened, delivered), "ack due in 14 min", route note.
4. She picks "Set-out planned at next siding" and submits with the case version she saw. Only a delivery receipt was appended since, so the server rebases and appends `AlertAcknowledged`, answering with the new version and status straight from the case. The projector applies it and sends the notice; every console refetches, and the row shows "acknowledged by alice". The case timeline gains one row, caused by the event she was looking at.

### Failed trace: the alert changes under her, then the tablet goes offline

1. While Alice reads the drawer, the next pass escalates the alert to CRITICAL (`AlertEscalated` appended at version 4). Her acknowledgment carries version 3. The server answers 409 `STALE_ALERT` with the current alert and the change list.
2. The form shows "This alert changed since you opened it" and the drawer refetches: CRITICAL, a new deadline, "Stop and inspect". She acknowledges again, this time knowingly.
3. At Cedar Junction, Bob records "journal bearing defect, bad order" for SVTX 961204 in a dead spot. The fetch fails with no response; the offline queue stores it under submission id 9da9bcd3 and the banner shows one pending.
4. Back in coverage, the `online` event flushes the queue. The first resend's response is lost again; the next resend returns 200 `replayed`. One finding, the alert *inspected*, the hold *bad-ordered*, and the dispatcher queue updates via SSE.
5. A second tablet that was offline syncs "no defect" for the same car. The server refuses it (409 `FINDING_CONFLICT`) because a defect is already recorded; the tablet shows the stored finding and drops its copy.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer (frontend view) |
|----------|------------------------|
| Source of truth; when is a write successful? | The case streams behind the API. A write is successful when the server answers 2xx, which means its events were appended; the UI never assumes success, except to show "waiting to sync" |
| Client retries after losing the response? | Findings and installs carry client ids (replayed on resend); acknowledgments carry a version (rebased over bookkeeping, 409 if a decision changed) |
| Server fails between two steps? | The UI refetches on reconnect; a missed SSE notice only delays a refresh; a stuck integration shows up on the Ops page as lag or a dead letter |
| Ordering required? | None on the client. Notices are invalidations, the refetch returns the current state; timelines are in commit order |
| Access with caches and async jobs? | SSE is filtered per viewer and carries ids only; every read is role-checked; route guards are convenience, not security |
| What breaks first at scale? | Human attention (queue length, overdue acknowledgments), shown by the tier counts and the reliability page; then SSE connection counts per API instance |

---

## 🧩 Follow-ups I'd Expect

**"A detector uploads a concerning reading from 2 hours ago, but that wheelset was replaced 1 hour ago."** The backend never alerts on it. On the car page, the reading still appears in the bearing's trend as a hollow marker, "measured on a wheelset since replaced", and the wheelset history lists the install with its event time and when it was recorded. Showing it keeps the history honest. Styling it differently keeps a reliability engineer from reading it as evidence against the new part.

**"The AEI read was missing and the consist was rebuilt at the last yard."** The train view lays the grid out on the current consist, but places each reading by its resolved car and car-relative position, so passes measured under the earlier revision still line up. Orientation corrections from AEI are listed with the detector that made them. A pass that couldn't be resolved shows as "unresolved" in the passes table instead of silently vanishing.

**"One detector suddenly flags nearly every train."** On the detector page it shows as *biased*, with its offset against its neighbours and the per-train samples behind that number. On the heatmap its rows are marked "bias". The queue doesn't fill with absolute-only alerts from it, and I'd show the operations team a single detector-fault item rather than forty car alerts.

**"The provider accepted the page, nobody acknowledged, and the train is approaching the next yard."** The stepper shows *delivered* filled and *acknowledged* empty, and the row shows "ack overdue · escalated to chief dispatcher". When the train is within the approach window, the yard supervisor's notice appears in the "Notified" list, and the yard's queue already has the car held. The yard tablet sorts the car to the top as its train's ETA approaches.

---

## ♿ Accessibility, Performance and UI Failure Modes (~1 min)

| Concern | Approach |
|---------|----------|
| Colour-blind dispatchers | Tiers always carry a label and an icon; the heat ramp is one hue, light to dark; alerted columns are marked by shape (rails), not colour |
| Charts as data | Every chart has a table next to it (passes, trips, detectors) |
| Gloves and sunlight on tablets | Large radio targets, high-contrast text, no hover-only actions |
| Big heatmaps | Cells memoized on data and mode; cell width adapts to car count |
| SSE disconnected | "Reconnecting…" in the shell; pages keep their last data; full refetch on reconnect |
| API down | Errors inline per panel; the finding form queues locally |
| Clock skew or compressed time | All ages from the server clock |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Live updates | SSE id-only notices + REST refetch | WebSocket pushing state | One-way traffic; no client state to diverge or re-authorize |
| Freshness | Push | 30 s polling | Deadlines are minutes long |
| Queue order | Unowned first, then tier | Severity only | Hides "delivered but unacknowledged" |
| Heatmap colour | Delta vs rail median (toggle to ambient) | Above ambient | Matches what scoring sees; cancels grade and sun |
| Highlight | Side rails | Outline over the cell | Keeps the alerted cell's colour visible |
| Finding writes | Client id at form open + offline queue | Plain POST retry | Exactly once across double taps and dead spots |
| Time | Server clock | Browser clock | Simulated time locally; skew-proof in production |
| Filters | URL search params | Component state | Shareable, refresh-safe |
| Data layer | Small fetch hook + revision store | Normalized client cache | Lists are small; invalidation stays trivial |
| Case model | Event-sourced stream with versions | Mutable row | Conflicts the UI can explain; a timeline for free |
| Two tablets disagree | Most severe finding wins | Last sync wins | A defect is never erased |
| Notice timing | After the projection commits | When the event is written | A refetch never races the read model |

## 📝 Wrap-up (~1 min)

> "Three screens, one principle: the server is the truth, the push channel only says *look again*. The dispatcher sees who owns each alert, how old its evidence is and what to do, ordered so unowned risk is never below the fold. The heatmap shows the trend the scoring saw, gaps and biased detectors included. The yard tablet records each finding exactly once, even offline. And none of it is in the safety path: the detector's radio alarm still stops the train if every screen is dark."

### How the local implementation compares

The frontend is React 19 with TanStack Router file routes, Zustand stores for auth, clock and live revisions, Tailwind, and SVG charts without a chart library. Pages: `/alerts` (queue and drawer with lifecycle stepper), `/trains/$tripId` (heatmap), `/cars/$carId` (trend, bearing picker, wheelset history), `/yard` (work orders, offline finding queue, holds, outbound check), `/detectors` (strip map, coverage), `/admin` (precision, audits, thresholds with backtest), `/timeline?car=…|case=…` (event timeline with payloads and causation chains) and `/ops` (consumer lag, staleness, dead letters with redrive). Playwright screenshots of each are in `screenshots/`.
