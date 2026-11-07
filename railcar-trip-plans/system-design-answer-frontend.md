# Railcar Trip Plans and ETAs — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Requirements → Users and screens → Architecture → Data and state → Deep dives → Traces → Follow-ups*

> "Two very different users look at the same cars. A shipper's logistics coordinator wants to know, for their 40 cars, when each will be placed and whether to call their customer. A railroad operations planner wants to see what went wrong across the network in the last hour and whether the system already fixed it. Underneath both is an event-driven backend: facts from AEI readers and yards, decisions like 'this car will miss its connection' and 'plan v3', and read models that converge a few seconds later. So the frontend has three jobs beyond rendering tables: show uncertainty honestly (an ETA is a range, not a timestamp), show eventual consistency honestly (an 'as of' on everything, commands that are accepted before they're visible), and make the event log explainable (why did this car's plan change, and what caused what)."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Two personas, isolation, ETA as a range |
| Screens and architecture | ~8 min | Portal, plan detail, timeline, exceptions, replans, streams; polling read models |
| Data and state | ~6 min | Server state vs UI state; role-shaped navigation |
| Deep dives | ~16 min | Showing uncertainty; eventual consistency and commands; explaining the event log |
| Traces and follow-ups | ~8 min | A delay as seen by both users; scale paths |

---

## 🎯 Requirements (~5 min)

### Clarifying questions

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who uses it? | Shapes every screen | Shippers (external, many companies) and network operations (internal); a platform admin for streams |
| How fresh must it be? | Polling vs push | Seconds are fine; nothing here is a safety alarm |
| What does a shipper need from an ETA? | The trap | When to promise their customer: a range and how sure we are, not a precise-looking time |
| Can shippers see other shippers' cars in a train? | Redaction | No: they see their car's train movement, not its consist |
| Devices? | Layout | Desktop for both; the shipper portal should work on a laptop in a warehouse office |

### Functional requirements

1. **Shipper portal:** my cars with status, position confidence, plan version and status, ETA range, drift from the original plan.
2. **Car detail:** ETA with its range and where the time goes; how the ETA evolved; every plan version with the reason for each change; exceptions.
3. **Car event timeline:** every event, event time vs recorded time, late and out-of-order markers, schema versions, causation chain.
4. **Operations:** exceptions board with resolve; replanning sagas with their steps; shipper digests.
5. **Streams/DLQ page:** consumer lag, staleness, dead letters with redrive, replay results.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Isolation | A shipper never sees another shipper's car, even by URL | Server-scoped queries; 404 for foreign cars; redacted payloads |
| Honesty | Every number shows its as-of and uncertainty | ETA bands, confidence labels, "inferred" badges |
| Responsiveness | Lists of 500 cars render < 100 ms | Server filtering; virtualize beyond that |
| Explainability | An operator can answer "why" from the screen | Causation chains, plan reasons, saga steps |

---

## 🖥️ Screens (~4 min)

```
┌──────────────┬───────────────────────────────────────────────────────────────────────┐
│ Railcar Trip │  Prairie Grain Co-op: my cars                                          │
│ Plans        │  ┌─────────┐┌─────────┐┌──────────┐┌──────────┐┌──────────┐            │
│              │  │In transit││At a yard││Foreign rd││Replanned ││Delivered │            │
│ ▸ My cars    │  └─────────┘└─────────┘└──────────┘└──────────┘└──────────┘            │
│   Notif.     │  Car        Where                 Plan          ETA (80% range)   vs plan│
│              │  HPSX104217 in transit · observed  v3 replanned  ├──▓▓▓█▓▓▓──┤      +24 h│
│              │             on M-MIDPRT-20261105                 Fri 08 13:51 Sat 03       │
│ Fri 01:37 UTC│  HPSX105078 at PRT · inferred      v1 on plan    ├─▓█▓▓──┤          +6.9 h│
└──────────────┴───────────────────────────────────────────────────────────────────────┘
```

| Route | Who | Purpose |
|-------|-----|---------|
| `/cars` | shipper (own), ops (all, filter by shipper) | The portal list |
| `/cars/$carId?tab=plan` | both | ETA panel, ETA history chart, plan versions, exceptions, sagas (ops only) |
| `/cars/$carId?tab=timeline` | both | Event log and causation chain |
| `/exceptions` | ops | Board with counts per type, resolve with a note |
| `/replans` | ops | Saga instances: trigger, missed → chosen run, steps, ETA shift |
| `/notifications` | shipper (own), ops (all) | Digests with collapse ratio |
| `/streams` | ops (read), admin (redrive, register car) | Lag, staleness, DLQ, replays, events by schema version |

---

## 🏗️ Architecture (~4 min)

```
┌────────────────────────────── Browser (React 19 + TanStack Router) ──────────────────────────────┐
│  __root: session check → redirect by role · AppShell (role-filtered nav, network clock)           │
│                                                                                                    │
│  routes/             components/                   lib/               stores/ (Zustand)            │
│  cars.index    ─────▶ cars/CarTable, EtaRange       usePoll (5 s)      auth-store (user, role)      │
│  cars.$carId   ─────▶ EtaPanel, EtaHistoryChart,    format (UTC,       clock-store (server's        │
│                        PlanVersions, CarSide         relative to        domain clock)               │
│                ─────▶ timeline/CarTimeline,          server clock)                                  │
│                        TimelineTable, ChainPanel                                                     │
│  exceptions, replans, notifications, streams ─▶ tables + StatTiles                                  │
│                                                                                                    │
│  services/api.ts: typed fetch client, ApiError(status, code), same-origin cookie                    │
└──────────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                               ▼ /api/v1 (Vite proxy locally)
                        Portal API: shipper-scoped reads over projections, ops commands
                                               ▼
                 car_state · car_eta · trip_plan_versions · exceptions · replan_sagas · events
```

> "The read side of an event-driven system is a set of projections that converge after each event. The frontend reads those projections; it never reconstructs state from events itself, except for one view: the timeline, where showing the raw events is the point."

### State management

| State | Where | Why |
|-------|-------|-----|
| Session user and role | Zustand `auth-store` | Global, rarely changes, drives nav and redirects |
| Domain clock | Zustand `clock-store`, refreshed every 5 s from `/clock` | All relative times ("in 12 h", "3 h ago") use the server's clock, which is simulated while the simulator runs |
| Server data (cars, exceptions, sagas) | Per-route `usePoll` hook | Read models change on their own as events arrive; polling every 5 s keeps the last good data while refreshing |
| Filters, selected event, tab | Local state or URL search params | Tab lives in the URL (`?tab=timeline`) so links are shareable |

### Component breakdown

| Component | Responsibility | Size target |
|-----------|----------------|-------------|
| `AppShell` | Role-filtered navigation, network clock (UTC, "simulated at 1800×"), user and sign-out | < 80 lines |
| `CarTable` | One row per car: status + position badge, plan badge, ETA range, drift | < 150 lines |
| `EtaRange` | The p10–p90 band, p50 tick, original-plan marker on a shared axis | < 50 lines |
| `EtaPanel` | Big ETA, range sentence, confidence, yard share, miss probability, as-of | < 100 lines |
| `EtaHistoryChart` | SVG band of predictions over prediction time, plan-version markers | < 80 lines |
| `PlanVersions` | Version cards newest first, reason, author, changed legs highlighted | < 70 lines |
| `TimelineTable` / `ChainPanel` | Event rows with two clocks and badges / causation chain with payload | < 80 each |
| `ExceptionTable` | Severity, type, car, summary, resolve with note and version | < 100 lines |
| `GroupTable`, `DlqTable`, `StreamPanels` | Lag and staleness per group, dead letters with redrive, topics, schema versions, replays | < 100 each |
| `icons/` | One SVG component per icon, barrel export, `className` and `title` props | tiny |

### Ops pages, designed for "what went wrong and is it fixed?"

| Page | First thing the eye lands on | Then |
|------|------------------------------|------|
| Exceptions | Open count per type as tiles (click to filter); no-capacity tile turns red | Table sorted by severity then recency; "resolved by svc:replanner · Replanned v1 → v2" shows the system fixed it |
| Replanning | Completed / compensated / failed tiles | Each saga: trigger, missed run struck through above the chosen run, step chips, ETA shift, "attempt 2 after RP-…" for compensations |
| Notifications | Changes vs digests sent and the collapse ratio | Each digest: shipper, kind chips (replanned, ETA change, delivered), one line per car |
| Streams & DLQ | Events/s sparkline, outbox backlog, max staleness, DLQ depth, ETA calibration | Per group: lag, pending, staleness, processed, duplicates dropped, partition chips; DLQ with error and Redrive; events by type and schema version; replay results |

### From event to pixel

> "It helps to trace one fact to the screen, because each hop adds latency the UI should be honest about."

```
 AEI read at 07:40 ──▶ ingest appends (recorded 07:41) ──▶ relay publishes ──▶ car-state folds, commits
       (event time)          (processing time)               (~100 ms)          (car_state row, as of 07:40)
                                                                                      │
 shipper's browser ◀── next poll (≤ 5 s) ◀── GET /cars (shipper-scoped SQL) ◀─────────┘
 shows "in transit · observed · last read 3 min ago" (relative to the server's clock)
```

| Hop | Typical delay | What the UI shows about it |
|-----|---------------|----------------------------|
| Producer to ingest | Seconds, or hours for store-and-forward and interchange feeds | "late 23 h" badge on the timeline; "last car-level read" age in the list |
| Ingest to projection | ~0.1–1 s; minutes if a consumer is behind | Projection staleness on the streams page |
| Projection to screen | ≤ poll interval | Nothing; it is small and uniform |
| Projection to ETA | A few seconds after car state | "As of" on the ETA panel |

---

## 🔌 API Surface (~2 min)

```
GET  /api/v1/cars?status=&planStatus=&q=&shipper=   list (shipper filter forced from the session)
GET  /api/v1/cars/:id                               state, plan versions, ETA + history, exceptions, sagas
GET  /api/v1/cars/:id/timeline                      events with lag, late, out-of-order, upcast flags
GET  /api/v1/events/:id/chain                       ancestors and descendants by causation
GET  /api/v1/exceptions?status=&type=               board
POST /api/v1/exceptions/:id/resolve                 {version, note} → 202 Accepted, or 409
GET  /api/v1/replans, /notifications, /streams/overview, /streams/dlq
POST /api/v1/streams/dlq/:group/:id/redrive         admin only
```

---

## 🔧 Deep Dives (~16 min)

### Deep dive 1: Showing an ETA as a range, not a timestamp

> "The trap in this problem is treating ETA as distance over speed. The frontend version of the same trap is showing 'Fri 13:51' as if we knew it. The backend computes p10, p50 and p90 from 200 samples of yard dwell and run times; my job is to make that range the thing people read."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Range bar: p10–p90 band, p50 tick, dashed line for the original plan, confidence label, drift vs plan | Uncertainty is visible at a glance; drift explains why the customer should be called | Takes more width; needs a shared time axis |
| ❌ Single time (p50) | Compact, familiar | Reads as a promise; a car with a 2-day spread looks as certain as one with a 4-hour spread |
| ❌ Text range only ("Fri 08:21 – Sat 03:31") | Precise | Hard to scan across 40 rows; no sense of where the plan was |

> "In the list, every row's bar shares an axis starting at now, so a shipper scanning 40 cars sees which ranges are wide and which are late versus the dashed original-plan line. The 'vs original plan' column compares like with like: the plan's arrival at the destination yard plus that yard's median local delivery time, because the ETA is to placement, not to the yard. On the detail page the panel adds the two things that explain the number: what share of the remaining time is in yards versus moving (usually 60–80% in yards, which is the whole point), and the share of samples in which the car misses its next connection. A planner reading '56% miss' knows to look at the yard before the system replans."

> "Confidence is a label, not a color alone: high, medium, low, computed from the band width and lowered when the position is only inferred or the car is bad-ordered. Position confidence has its own badge: 'observed' when a car-level read confirmed it, 'inferred' when we only know where its train went. Hovering explains both."

> "The history chart shows how the prediction moved: x is when we predicted, y is the predicted delivery, the band is the range, vertical markers show plan versions. It answers the shipper's real question, 'should I trust this?', by showing the system changing its mind for visible reasons. What I give up: the list is denser and needs a minimum width; on a phone I'd collapse to the median with a range label."

### Deep dive 2: Eventual consistency and commands as events

> "Every read model here is a projection that converges a few seconds after an event. Commands are events too: resolving an exception appends ExceptionResolved, and the board changes only when the exceptions consumer applies it. The UI must not pretend otherwise."

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Poll every 5 s; commands return 202; show "as of" and the domain clock | Simple, survives restarts and network blips; honest about lag; no connection state | Up to 5 s latency; some wasted requests |
| ❌ WebSocket push of projection deltas | Instant | The client becomes a second projection that must handle gaps, reordering and reconnects; duplicates server logic |
| ❌ Optimistic update on resolve | Feels instant | If the append loses an optimistic-concurrency race the UI shows a state that never existed; rollback UX needed |

> "For this domain seconds don't matter (no train stops because of this screen), and the backend already guarantees idempotency and order where it matters. If I pushed deltas over a socket, the browser would have to deal with exactly the problems the consumers solve: a missed message, a duplicate, an old event arriving after a new one. Polling the projection gets the converged answer every time. If I wanted push later, I'd push only 'car X changed' and refetch, never the state itself."

> "Commands carry the version the operator saw. Resolve sends the exception's version; if someone else resolved it, the server returns 409 and the button says 'changed meanwhile; refresh'. On success the server returns 202 with the event id and the note 'applied when the exceptions consumer processes it'; the next poll shows it resolved. The same pattern holds for a manual plan revision with an expected plan version."

> "Two clocks matter. The server's domain clock is what 'in 12 h' is relative to; while the simulator compresses three days into minutes it runs at 1,800×, so the browser's own clock would be wrong. Every relative time uses the clock store. And every derived number says what it's as of: the ETA panel shows the newest event or clock tick it was conditioned on."

### Deep dive 3: Making the event log explainable

> "The timeline is the one place the UI shows raw events, because it's how operators and shippers answer 'why'. The design question is ordering: by event time or by arrival?"

| View | Shows | Use |
|------|-------|-----|
| ✅ By event time (default) | The story as it happened in the world | "Where was the car when?" |
| ✅ By arrival (log position) | The order we learned it, with late and out-of-order badges | "Why did the ETA jump at 21:30?" (because a 23-hour-late interchange record arrived) |
| ❌ Arrival order only | The log as stored | A late record looks like the car teleported backwards |

> "Each row shows event time over recorded time, a 'late 23 h' badge when the gap is large, an 'out of order' badge when it arrived after something about the car that happened later, the type with its schema version (a v1 AEI read shows 'v2 ← v1' because it was upcast), the producer, and a one-line summary with 'caused by #1612'. Facts, train movements, plan versions and service decisions get different colors so a planner can see the decision chain inside the facts."

> "Clicking a row opens the causation chain: walk causation ids up to the root fact and down to everything it caused. For a predicted missed connection that's TrainDelayed → ConnectionMissed → ExceptionOpened, ReplanStarted → TrainCapacityReserved → TripPlanRevised → EtaUpdated → ReplanCompleted → ExceptionResolved. That one panel teaches more about the system than any diagram."

> "Shippers get the same timeline with redaction done on the server: a TrainDeparted shows the consist size and whether their car was aboard, never the other cars; a digest shows only their lines; the chain is filtered to events about their cars plus train movements. What I give up: a car with a long life accumulates hundreds of events (mostly ETA updates), so I hide ETA updates by default and would virtualize the table past a few hundred rows."

---

## 🔐 Access Control in the UI (~2 min)

> "The client never decides what a shipper may see; it only decides what to show for the role it was told."

| Concern | Where it is enforced | What the UI does |
|---------|---------------------|------------------|
| Which cars | API: every query filters by the session's shipper id | Shows "My cars" and hides the shipper filter for shippers |
| A foreign car's URL | API returns 404 (not 403, so existence isn't leaked) | Error note, link back to the list |
| Other shippers' cars in a consist | API redacts TrainDeparted to size + "this car aboard" | Summary reads "departed with 88 cars, this car aboard" |
| Digests | API returns only the shipper's digests; lines filtered to their cars | Same page for ops shows all shippers |
| Ops-only pages | API 403 for shippers; admin-only redrive | Nav hides them; buttons appear only for admins |
| After interchange | Access follows the trip, not the railroad | The car stays in the list as "on foreign road" |

---

## ⚡ Rendering, Performance and States (~2 min)

| Topic | Decision |
|-------|----------|
| Lists | Server filtering and a 500-row cap; past that, `@tanstack/react-virtual` with estimated row heights |
| Timeline | ETA updates hidden by default (they are most of the rows); virtualize past ~300 rows |
| Charts | Hand-written SVG: one polygon for the band, one polyline for p50; no chart library in the bundle |
| Polling | 5 s for lists, 3 s on the streams page, 10 s on the timeline; keep the last data while refreshing |
| Loading | Spinner only on first load; refreshes are silent |
| Errors | Inline note with the server's message; 401 sends to login; network errors keep the stale data visible |
| Empty | Explains why ("No dead letters. Poison messages land here after their retries run out.") |
| Formatting | Times in UTC ("Fri Nov 6 13:51"), relative times from the server clock, monospace for ids and runs |
| Color | Never the only signal: every status has text; severities and confidence are labelled |

---

## 📜 Execution Traces (~3 min)

### Successful trace: a six-hour delay, seen by both users

1. The operations planner's exceptions board grows by 88 "missed connection" rows within a poll or two of the delay report; each says "will miss M-MIDPRT at MID (inbound delayed)", opened at the delay time.
2. Seconds later the replans page shows 88 sagas walking started → reserved → awaiting ETA → completed; the board's rows flip to resolved "Replanned v1 → v2".
3. The shipper's portal shows those cars with a v2 badge, "replanned", a range bar shifted right past the dashed plan line, and "+24 h vs original plan".
4. The shipper opens a car: plan v2 card, reason "Inbound train late into MID; cannot make M-MIDPRT-20261104. Moved to Z-MIDPRT-20261105", the ETA history chart with a v2 marker.
5. Their notifications page shows one digest for all their affected cars.

### Failed trace: an operator resolves an exception someone else just resolved

1. Two planners load the board; both see exception version 1, open.
2. The first resolves: 202. The second clicks Resolve on the stale row: 409 VERSION_CONFLICT.
3. The row shows "changed meanwhile; refresh"; the next poll shows it resolved by the first planner, with the note.

### Failed trace: an event dead-letters

1. A foreign car's interchange record names a car the registry doesn't know; after four deliveries it lands in the car-state DLQ.
2. The streams page shows DLQ 1 in red, the error text, and "unknown to the car registry: LPSX990001".
3. The admin clicks "Register (waybill arrived)", then Redrive; the entry disappears and the car appears in the list on the next poll.

### Failed trace: a shipper follows a link to another shipper's car

1. A coordinator at Prairie Grain pastes a car id shared by a customer: `/cars/ZNCX105181`, which belongs to another shipper.
2. The API scopes the lookup by the session's shipper id and returns 404; the page shows "Car not found" and a link back to their list.
3. Nothing about the car, not even that it exists, reaches the browser.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer (frontend view) |
|----------|------------------------|
| Source of truth; when is a write successful? | The backend event store. A command is successful when the API returns 202 with an event id; visible once the projection applies it |
| Client retries after losing the response? | Commands carry versions, so a retried resolve after success gets 409 and the UI refreshes; reads are idempotent polls |
| Failure between two steps? | The UI never holds intermediate state; it re-reads the projection |
| Ordering required? | The timeline offers both event-time and arrival order and marks the difference |
| Access with caches and async jobs? | Scoping and redaction are server-side; the client never filters for security; foreign car URLs return 404 |
| What breaks first? | Long timelines and 500-row lists: virtualize; then polling load: ETag/304 or a change feed |

---

## 🧩 Follow-ups I'd Expect

**A train carrying 100 cars for 40 customers is six hours late. What does each customer see?**
> "One digest each, listing only their cars, one line per car with the new ETA range and how far it moved since the last digest, plus the plan change and its reason. In the portal those cars move right on the shared axis and get a new plan badge."

**An AEI reader misses a car. What does the UI show?**
> "An 'inferred' badge on the position, 'last car-level read 14 h ago', the missed-read count on the detail page, and a lower confidence label on the ETA. The timeline shows the TrainArrived that placed it."

**How do you show ETA accuracy?**
> "On the streams page: share of delivered cars inside their 80% band 24 hours out, and the median error. Per car, the history chart shows how the prediction moved."

**The ETA changed but the shipper says nobody told them.**
> "The car detail shows the ETA history with the moment it moved, and the notifications page shows the digest that carried it (or that the move was under the 2-hour threshold against what they were last told). Both come from the same events, so support can answer from the screen."

**Operations wants to know if the system is behind.**
> "The streams page: projection staleness per consumer group (age of the oldest unfinished message), lag per partition and DLQ depth. If staleness is high, every 'as of' on the portal is older, and the page says which group is behind."

**What does a shipper see once the car is on another railroad?**
> "The car stays in their list with 'on foreign road (after interchange)', the foreign road's sightings in its timeline as they arrive (often late, marked as such), and a wider ETA band, because the model uses the foreign road's delivery-time history. The tile at the top counts these cars separately so they don't look lost."

**The coordinator opens the portal on a small laptop in a warehouse office.**
> "The list keeps car, status and the ETA range; the plan and drift columns fold under the car id below a breakpoint. The range bar stays: it's the most important thing on the row. Tables scroll horizontally inside their card rather than the page."

**Shippers want push notifications.**
> "Digests already go by email; in the portal I'd add a lightweight 'something changed' signal (SSE with ids only) and refetch."

---

## 🧪 How I'd Test the UI (~1 min)

| Layer | What | How |
|-------|------|-----|
| Pure helpers | Relative times against a fixed server clock, hour formatting, drift sign, range-bar positions (clamped at "now") | Unit tests with a pinned clock |
| Access | A shipper session cannot load another shipper's car, ops pages or redrive; consists are redacted | API contract tests per role, run against seeded users |
| Pages | Every route renders its main table or list for the right role, with no error boundary | Playwright smoke tests generated from the screenshot config |
| Eventual consistency | Resolve shows 202, then resolved on the next poll; a stale resolve shows 409 | Two browser contexts against the running stack |
| Determinism | The ETA band for a car is identical after a projection replay | Snapshot of `/cars/:id` before and after `replay eta --apply` |

> "The determinism check is unusual for a frontend, but it's the one that proves the screens are views of the log and not of something the consumers happened to compute at a given moment."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| ETA display | Range bar + confidence + drift | Single timestamp | Uncertainty is the information |
| Freshness | 5 s polling of projections | WebSocket deltas | Server already solves ordering and duplicates |
| Commands | 202 + version, 409 on conflict | Optimistic UI | Never show a state that might not exist |
| Timeline order | Event time default, arrival order toggle | Arrival only | Late data reads correctly |
| Access | Server scoping and redaction | Client filtering | Security where the data is |
| Global state | Zustand for session and clock only | Global store for all data | Server data belongs to the server |
| Charts | Hand-written SVG | Chart library | Small bundle, exact control of the band |

---

## 📝 Wrap-up (~1 min)

> "The frontend's job in an event-driven system is to be honest: about uncertainty (ranges, confidence, inferred positions), about consistency (as-of times, accepted-not-yet-visible commands, versions on every command), and about causality (timelines in both orders and causation chains). Shippers get their own cars, redacted and digested; operations gets the exceptions, the sagas and the streams."

### How the local implementation compares

React 19 with TanStack Router file routes, Zustand for session and the domain clock, a typed fetch client, hand-written SVG for the ETA band and history chart, SVG icon components with a barrel, and polling hooks. Eight Playwright screenshots in `screenshots/` cover the portal, a plan with three versions, the causation chain, a late interchange timeline, the exceptions board, the sagas, digests and the streams page.
