# Track Hazard Detection - System Design Answer (Frontend Focus)

*A 45-minute frontend interview answer. The prompt: "Design a railroad sensor monitoring and incident detection platform. It ingests camera, vibration and temperature data, identifies track hazards, alerts personnel, and provides an operator dashboard. Connectivity is intermittent, and critical alerts must reach people within seconds."*

---

## 🎯 Clarifying the Problem

I'd start by asking who sits in front of the screen, because the dashboard is the part of this system a person has to trust in the worst minute of their shift.

**Users.**
- **Dispatchers** own a territory (a subdivision of 80-ish miles). They acknowledge alerts, warn trains, issue speed restrictions ("slow orders") and dispatch inspectors. They work at a desk with several monitors and need to see their whole territory at a glance.
- **Track inspectors** are in a truck or on foot with a tablet and a patchy cellular link. They see the hazards they were sent to and close them as cleared or a false alarm.
- **Platform operators** watch the pipeline: consumer lag, dead letters, replays.

**The boundary I'd state early.** The safety-critical path (a broken slide-fence wire dropping a signal to red, crossing gates) is local in the field and never depends on the dashboard. My UI is where people *decide and coordinate*, so its jobs are to be fast, to be honest about what it doesn't know, and to never let a click happen twice.

### Functional requirements (UI)

1. A **live strip map** per subdivision: hazards by severity, sensors by type, coverage gaps, slow orders and train positions with direction.
2. A **hazard detail** page: response state (alert, deadline, escalation, warned trains, slow orders, inspector), the actions, the correlation evidence, and the full event timeline.
3. An **alert queue** with ack deadlines counting down and escalations visible.
4. A **speed restriction list**, a **latency panel** (detection to alert p50/p99) and an **ops page** (streams, lag, dead letters, replay).

### Non-functional requirements

| Property | Target |
|----------|--------|
| New CRITICAL hazard visible on the board | < 1 s after the backend commits it |
| Board render during a burst | No jank: < 16 ms per frame with ~100 sensors, ~10 trains, ~20 hazards |
| Duplicate actions | Zero, even on a flaky tablet link |
| Honesty | Every view says how fresh it is; blind track is visibly blind |
| Accessibility | Severity never by colour alone |

---

## 📏 Scale From the UI's Point of View

| Quantity | Estimate (illustrative) | Consequence |
|----------|-------------------------|-------------|
| Dispatcher desks | ~30 across the network, each owning 1-3 subdivisions | The board is per territory, never the whole railroad |
| Open dashboards | ~200 (desks, chiefs, operations, inspectors) | Notices fan out to every open tab |
| Sensors per subdivision | 30-100 | SVG is comfortable |
| Trains per subdivision | 5-20, positions every 5-10 s | Throttle train notices to 1/s |
| Open hazards per subdivision | Usually 0-5, a storm can make 20 | The list and map must stay readable |
| Live notices during an incident | Tens per second network-wide | Coalesce refetches per page |

> "The data volumes the browser sees are tiny. What matters is update cadence and honesty: the screen must change within a second of the truth changing, and must say so when it can't."

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ React 19 + TanStack Router (file routes) + Zustand + Tailwind     │
│                                                                  │
│  routes/  board · hazards/$id · alerts · restrictions · latency   │
│           events · ops · login                                    │
│                                                                  │
│  ┌───────────────┐  revision bump   ┌──────────────────────────┐  │
│  │ live-store    │◀─────────────────│ SSE /api/v1/live          │  │
│  │ (per-topic    │                  │ notices: topics + ids     │  │
│  │  revisions)   │                  └──────────────────────────┘  │
│  └──────┬────────┘                                                │
│         │ deps of useFetch (coalesced ≤ 3/s)                      │
│         ▼                                                         │
│  ┌───────────────┐  REST (read models)  ┌─────────────────────┐   │
│  │ services/api  │─────────────────────▶│ API: board, hazard, │   │
│  │ + useCommand  │──commands + ids─────▶│ alerts, commands    │   │
│  └───────────────┘                      └─────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

> "I deliberately keep almost no client-side domain state. The server's read models are the truth; the browser holds a *revision number per topic* and refetches when it changes. That one choice makes reconnection, missed messages and multiple tabs boring."

### State placement

| State | Where | Why |
|-------|-------|-----|
| Session user | Zustand auth store | Needed by every route guard |
| Live connection + topic revisions | Zustand live store | Shared by all pages; tiny |
| Board, hazard, alerts | Fetched per route with `useFetch` | Server is the truth; no cache invalidation puzzles |
| Form inputs, open rows | Component state | Local |
| Pending command id | `useRef` inside `useCommand` | Must survive re-renders, not navigation |

---

## 🗺️ The Strip Map

A strip map is how railroads already draw territory: one horizontal line per subdivision, mileposts along it. I draw it in **SVG** with a fixed `viewBox` (1000 wide) and a linear milepost scale, in horizontal bands:

```
 CAN-1      CAN-2      CAN-3      CAN-4 · GW SILENT    ...   segment labels / coverage
                                   ◆ HZ-1005                 hazards (diamond, colour = severity)
                                   ▬▬ 10                     slow orders (yellow bars with mph)
 ════╪═════════╪═════════╪══════════════▶═════════╪═══       track, mileposts, trains (arrow = direction)
    100       110       120   Q-CANEXP 130       140
 geophone  ●  ●   ●          ●    ●  ●                       sensors by type, one row each
 fence       □     □  ✕                                      (red ✕ = no heartbeat, hatched = blind)
 camera                         ▲
 rail temp   ●(colour = heat band)
 water             💧
```

**Why SVG, not canvas or a map library.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ SVG strip | ~200 elements; native hit-testing, `<title>` tooltips, accessible, crisp at any zoom | Slows past a few thousand nodes |
| ❌ Canvas | Fast for tens of thousands of points | Hit-testing, tooltips and accessibility by hand |
| ❌ Slippy map (Leaflet/Mapbox) | Real geography | Dispatchers think in mileposts, not lat/long; tiles need connectivity |

A subdivision has ~30 sensors, a handful of trains and hazards: SVG is the obvious fit and costs nothing. If a whole railroad were on one screen I would switch the sensor layer to canvas and keep hazards in SVG.

**Severity is never colour alone.** Hazards carry their code label; badges say CRITICAL/HIGH in text; blind segments say "GW SILENT"; a dead sensor gets an ✕ as well as red.

---

## 🔧 Deep Dive 1: Live Updates in an Event-Driven Backend

**The decision.** The backend publishes a small notice after every committed change: the topics it touches (hazards, alerts, ...), the hazard id and the severity. The API relays notices over **Server-Sent Events**. Notices carry ids, never state. Each page subscribes to the topics it renders (the board: hazards, trains, coverage, restrictions, alerts) and refetches its read model when a revision changes. On every (re)connect the client bumps *all* topics.

Which pages listen to which notices:

| Domain event (projected) | Topics bumped | Pages that refetch |
|--------------------------|---------------|--------------------|
| HazardDetected / Upgraded / Downgraded | hazards, alerts | Board, hazard detail, alert queue |
| AlertIssued / Escalated / Acknowledged | alerts, hazards (+ latency) | Alert queue, board KPIs, latency panel |
| SpeedRestrictionIssued / Lifted | restrictions, hazards | Restrictions, board |
| CoverageDegraded / Restored | coverage | Board |
| TrainPositionReported (throttled 1/s) | trains | Board |

**Why it works here.** The backend is eventually consistent: a hazard event is appended, then the projector updates the read model, then publishes the notice. Because the notice is sent *after* the projection commits, a refetch always sees the change. Because notices carry no state, a missed notice costs one stale screen until the next one, never a wrong screen. Reconnection is trivial: EventSource reconnects by itself, the `hello` event bumps everything, and every page refetches once.

**How the alternative breaks.** Pushing deltas ("hazard 1005 severity is now CRITICAL") and patching a client store looks more efficient, but it fails in exactly the conditions this system lives in:
- A dropped connection loses deltas. The client must now detect the gap (sequence numbers), ask for a replay or a snapshot, and merge. I'd be re-implementing a consumer group in the browser.
- Deltas arrive in commit order per hazard but not across hazards, and the client has to apply them to a store that might already have a newer snapshot from a REST call. Ordering bugs show up as a hazard flickering back to HIGH.
- Access control has to be applied to every delta on the server; with ids only, the REST read applies it once.

**What I give up.** Extra REST traffic: a burst of 20 notices would mean 20 board fetches. I coalesce: `useFetch` waits so a page refetches at most about three times a second, and the projector throttles train notices to one per second. I also accept a few hundred milliseconds of extra latency for the refetch, well inside the budget. WebSockets would buy nothing: the client never pushes in real time; commands are ordinary POSTs.

> "SSE with ids only is the browser version of 'events are notifications, read models are the truth'. It's the same contract the backend services use with each other."

---

## 🔧 Deep Dive 2: Commands on a Flaky Link, Against an Eventually Consistent Read Model

Two problems meet on the hazard page: inspectors have bad connectivity, and the hazard can change under the person's finger (new evidence upgrades it).

**Idempotent commands.** Every action (acknowledge, slow order, dispatch, clear, false alarm) is a POST with a **client-generated command id**. `useCommand` creates the id once per submission and keeps it in a ref:
- If the request fails with no response (network error), the UI says "No response. Retry is safe" and the retry **reuses the same id**. The server stores each command's result by id and returns it with `replayed: true` instead of acting twice.
- If the server answered with an error, the id is discarded; the next attempt is a new command.

**Version-aware conflicts.** Each command also sends the hazard version the person was looking at. The server treats this differently by action:
- **Acknowledge** never conflicts on version. During an active incident the correlator appends evidence every few seconds; refusing an ack because the version moved would make the button unusable.
- **Clear / false alarm** are refused with 409 HAZARD_CHANGED if evidence arrived after the version the person saw. The UI shows the message and the page has already refetched (via the live notice), so the person reviews the new evidence and decides again.

**Read-your-writes.** The command response contains the hazard folded from the event stream itself (strongly consistent), so the detail page can render the result immediately. The lists (board, alert queue) come from projections and may lag by a fraction of a second; they catch up on the next notice.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Command id + server dedup | Retries are safe across tabs and reloads | Server must store results |
| ❌ Disable the button until the response | Simple | A lost response leaves the user stuck or retrying blindly |
| ✅ Confirmed render from the command response | Correct state at once | A second, different source of truth on that page for a moment |
| ❌ Optimistic local mutation | Instant | Wrong when the server refuses (territory, 409); easy to show "acknowledged" when it wasn't |

**What I give up.** No optimistic UI: an acknowledge shows a spinner for ~50-200 ms. For a safety workflow I'd rather show the truth a beat later than show a lie instantly. And the inspector tablet has no offline queue in this design; if I added one (inspectors in dead zones), the command id is already the deduplication key the queue needs.

---

## 🔧 Deep Dive 3: Showing Time Honestly

Event-driven systems have two clocks: when something happened (event time) and when the cloud learned about it (processing time). The UI has to show both, or dispatchers will misread late data as new hazards.

- **Late badges.** Evidence, hazards and alerts that arrived after their segment's watermark carry a purple "late" badge with a tooltip ("buffered at the edge while the link was down").
- **Edge → cloud column.** The evidence table shows each report's ingest delay: 250 ms for a live camera frame, "1 min 57 s late" for a spike buffered at an offline gateway.
- **Correlation chart.** A small SVG scatter plots evidence by *event time* (x, relative to the first evidence) and milepost (y), with the ±30 s × ±0.5 mi correlation window drawn as a box. Points that joined are solid; nearby reports that didn't (explained by a passing train) are hollow. This is the clearest way I know to explain "why is this one hazard and not three".
- **Countdowns from deadlines, not timers.** Ack countdowns compute from the server-provided deadline every second, so a page opened late shows "overdue 2:47", not a fresh 60-second timer.
- **Freshness.** The sidebar shows the SSE connection state; the board shows each segment's watermark lag in its tooltip ("data complete to 4 s ago") and hatches segments whose gateway is silent.

**The trade-off.** More visual vocabulary to learn. I keep it to one colour (purple) for "late", one pattern (red hatching) for "blind", and one shape per sensor type, and put a legend on the board.

---

## 🔔 Getting a Critical Alert Noticed

The backend's job ends when the alert reaches the console; the UI's job is to make sure a human actually sees it.

- **A banner on every page.** When a notice arrives for an AlertIssued or AlertEscalated at CRITICAL, the live store records the hazard id and the shell shows a red banner ("New CRITICAL hazard alert. Open hazard") on whatever page the dispatcher is on, for two minutes or until dismissed.
- **The queue sorts open alerts first**, and an overdue one turns its row red with "ack overdue 2:47".
- **Escalation is visible**, not just a page sent somewhere: "escalated L2 to manager of operations" sits on the row, so the dispatcher knows their chief is already involved.
- **The pager is the backstop.** The notifier also pages the dispatcher for CRITICAL and HIGH alerts. The browser tab might be behind another window; the pager isn't.

> "I don't rely on browser notifications or sounds alone. Tabs get throttled in the background and permission prompts get dismissed. The banner, the queue and the pager are three independent paths to the same person."

---

## 📋 Alert Queue

Each row is one hazard's alert from the alert-queue read model:

| Element | Source | Why |
|---------|--------|-----|
| Severity badge | Alert severity (as issued or re-issued) | What the person was paged about |
| "hazard now LOW (re-assessed)" | Hazard severity, when different | A downgrade is shown, never hidden; the alert stays until a person closes it |
| Desk, assignee, age | Routing in AlertIssued | Who owns it |
| Countdown | Deadline in the read model, client clock | "due in 0:42" / "overdue 1:05" |
| Escalation | Latest AlertEscalated | Level and target |
| Ack button | Only for the user's own desk | The server re-checks territory |

Dispatchers default to their own desk with a switch to all desks; inspectors see "My dispatches". Acknowledging in place uses the same idempotent `useCommand` hook as the hazard page.

---

## 🧭 Hazard Detail Page

```
┌──────────────────────────────────────────────────────────────────────┐
│ HZ-1005 · Obstruction  [CRITICAL] [confirmed] [alerting]  conf 0.82 v8 │
├───────────────────────────────┬──────────────────────────────────────┤
│ RESPONSE                      │ CORRELATION EVIDENCE                  │
│ Alert AL-1005 → alice         │   mp ▲   ┌─ ±30 s · ±0.5 mi ─┐        │
│ escalated L2, overdue 2:47    │       │   │  ● CAM-136.2       │        │
│ Trains warned: 1. C-COALWB    │       │   │        ◉ GEO-135.9 │ (late) │
│ [Acknowledge] [Warn trains]   │       └───┴────────────────────┴──▶ t  │
│ Slow order mph/from/to [Issue]│                                       │
│ Inspector [Dispatch]          │                                       │
│ Note [Hazard cleared] [False] │                                       │
├───────────────────────────────┴──────────────────────────────────────┤
│ EVIDENCE table: sensor · kind · MP · occurred · edge→cloud · lane ·   │
│ schema (v1 → v2 upcast) · confidence · status (joined / explained)    │
├──────────────────────────────────────────────────────────────────────┤
│ EVENT TIMELINE: v · type · occurred · recorded · by · caused by · …   │
├──────────────────────────────────────────────────────────────────────┤
│ NOTIFICATIONS: console / pager / radio, delivered in N ms             │
└──────────────────────────────────────────────────────────────────────┘
```

The **timeline** is the hazard's event stream rendered as a table: stream version, type, occurred and recorded times, who did it (correlator, alerting, a username), and what caused it ("v3 HazardEvidenceAdded"). Clicking a row expands the raw envelope. It doubles as the audit trail and as the best teaching tool in the product: a dispatcher can see that the train warning was caused by the upgrade, which was caused by a late spike.

---

## 📡 Intermittent Connectivity on the Inspector's Tablet

The prompt says connectivity is intermittent. That's true for the gateways, and it's just as true for the inspector standing in a rock cut.

- **Connection state is always visible**: a green "Live" dot or a grey "Reconnecting…" in the sidebar. When SSE drops, the page still shows the last data, and the user can see it may be stale.
- **Reads recover on their own.** EventSource retries every 3 s; when it reconnects, every topic is bumped and every open page refetches once.
- **Writes are safe to retry** because of the command id (deep dive 2). A clear that timed out can be retried in the truck later without clearing twice.
- **What I'd add for real field use**: an offline queue for inspector commands in IndexedDB, replayed in order on reconnect, each with its original command id and the version the inspector saw. If the hazard changed in the meantime the server answers 409 HAZARD_CHANGED and the tablet asks the inspector to review instead of silently applying a stale decision.

| Approach for offline writes | Pros | Cons |
|-----------------------------|------|------|
| ✅ Queue with command ids + seen version | Safe replay; conflicts surface to a human | Needs a review UI for conflicts |
| ❌ Last-write-wins sync | Simple | Can silently close a hazard that just got worse |
| ❌ Block until online | Honest | Inspectors lose their notes and give up on the app |

---

## 🛠️ Ops Page and Latency Panel

These pages exist because an event-driven system fails quietly: nothing errors, things just get late.

**Streams & DLQ** (refreshes every 3 s):
- Consumer groups by topic with **lag** (not yet delivered) and **pending** (delivered, not acknowledged), summed across the four partitions. Green at zero, amber when behind, red when far behind.
- Outbox backlog per lane, events per second, late events in the last minute.
- **Dead letters** with the error code (SCHEMA_INVALID, UNSUPPORTED_VERSION, UNKNOWN_SENSOR), delivery count, source gateway and the partition it came from. Admins can **Redrive** (re-publish unchanged), **Discard**, or for an unknown sensor **Register sensor** first and then redrive.
- **Projections** with checkpoint, staleness and a "Replay from 0" button that shows the before/after checksums: "identical" is the reassuring answer.
- Gateways with last heartbeat, watermark lag, buffered count and duplicates absorbed.

**Latency budget**:
- p50/p99 of detection → alert for live alerts against the 5 s budget, with late alerts counted separately (they measure the outage, not the system).
- A stacked bar of where the time goes: edge → ingest, ingest → detected, detected → alert, alert → console.
- **Per-lane cloud latency**: critical vs bulk. During a backlog the bulk bar grows and the critical bar doesn't, which is the priority lane made visible.

---

## 🧩 Component Structure

| Area | Components | Notes |
|------|------------|-------|
| Board | StripMap, StripLayers (SensorGlyph, HazardMarker, TrainMarker), KpiRow, HazardList, Legend | Geometry helpers in one module |
| Hazard | HazardHeader, ResponseState, ActionPanel, CorrelationChart, EvidenceTable, Timeline, Notifications | Each under ~150 lines |
| Alerts | AlertRow (with its own `useCommand`) | Ack in place |
| Latency | StageBars, Histogram, LaneCompare | Hand-written SVG, no chart library |
| Ops | GroupsTable, DlqTable, ProjectionsTable, GatewaysTable | Admin-only buttons |
| Shared | Badges, PageHeader/StatTile, Loading, icons barrel | Icons as components, never inline SVG |

API calls live in `services/api.ts`; the SSE connection in `services/live.ts`.

---

## ⚡ Performance

- **Refetch coalescing** (≤ 3/s per page) keeps a burst of notices from becoming a burst of renders.
- **Board payload** is one request (~30 KB) with everything the strip map needs; no N+1 per hazard.
- **SVG element count** stays in the low hundreds; React reconciles keyed elements cheaply.
- **Countdowns** use one ticker per page (1 s) instead of a timer per row.
- **Routes are code-split** by the router plugin; the ops and latency pages don't load for inspectors.

---

## 🧪 Testing and Verification

- **Pure helpers** (milepost scale, countdown text, severity ordering, event summaries) are plain functions, easy to unit-test.
- **Smoke tests** in Playwright log in as each role and load every page against the running simulator: the board renders both strips, the alert queue renders, the ops page shows the consumer groups table.
- **Scenario-driven review**: the simulator plays a scripted afternoon (a rockfall, a crossing obstruction during a backlog, a flaky gateway delivering late, a heat ramp, a dead sensor, poison messages). I screenshot each page at the interesting moments and look for what's wrong: a label that collides, a late badge that's missing, a countdown that reset.
- **Failure drills**: kill the SSE connection (the "Reconnecting…" state and the refetch on reconnect), throttle the network to test command retries, and send a stale clear to see the 409 path.

---

## 🔐 Access in the UI

The UI hides what a role can't do (inspectors see "My dispatches", not the ops page; dispatchers only get Ack buttons for their desk), but the server re-checks every command against the folded hazard and the user's territory. A West-desk dispatcher who crafts a request against a Prairie hazard gets 403 NOT_YOUR_TERRITORY. Live notices carry ids only, so nothing sensitive leaks through SSE.

---

## ✅ Design Review Checklist (from the UI's side)

1. **Source of truth; when is a write successful?** The event store on the server. A command is successful when the API returns 201 with the appended event types; the UI renders the hazard from that response.
2. **Client retries after losing the response?** Same command id, stored result returned with `replayed: true`; the UI says "already done".
3. **Failure between two steps?** If the API commits and the response is lost, the retry is idempotent. If the SSE connection drops, every page refetches on reconnect.
4. **Ordering required?** None in the browser: each fetch is a consistent snapshot of a read model; the hazard page is a fold of one stream in version order.
5. **Access with caches and async?** Notices carry ids; reads and commands are access-checked; the client caches nothing across users.
6. **What breaks first?** Refetch storms with many open dashboards during a regional incident: hundreds of clients refetching the board several times a second. Evidence: each notice fans out to every open tab. Fix: a cached board endpoint with ETags, then per-subdivision board endpoints, then pushing compact board deltas with a sequence number once the read side is the bottleneck.

**Successful trace.** A camera reports a vehicle on a crossing. Within a second the projector commits the new hazard and publishes a notice; the dispatcher's board refetches and a diamond appears on the Prairie strip; the alert queue shows "ack due in 2:59". He clicks Acknowledge; the response arrives in ~100 ms with the folded hazard; the queue updates on the next notice.

**Failed trace.** An inspector taps "Hazard cleared" in a cutting with no signal. The request times out with no response. The UI shows "No response. Retry is safe" and keeps the command id. Back in coverage he taps Retry: the server had in fact committed the first request, so it returns the stored result with `replayed: true` and the UI shows "Already done". The hazard is cleared exactly once and the slow order is lifted once.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Live updates | SSE notices with ids, refetch | Push deltas into a client store | Missed messages cost freshness, not correctness |
| Transport | SSE | WebSocket | One-way push is all we need; proxies and reconnection are easier |
| Map | SVG strip by milepost | Canvas / slippy map | Small element count, accessible, matches how dispatchers think |
| Commands | Command id + confirmed render | Optimistic mutation | Safety workflow; server can refuse |
| Conflicts | Version-aware only for closing actions | Strict version check on all | Acks must work during an active incident |
| Client state | Revisions + per-route fetch | Normalised client cache | Server read models are the truth |
| Time | Event time and processing time both shown | One timestamp | Late data must not look new |
| Charts | Hand-written SVG | Chart library | Tiny bundle, exact control |
| Critical attention | Banner + queue + pager | Browser notifications only | Background tabs are throttled; three independent paths |

---

## ❓ Follow-ups I'd Expect

- **Two dispatchers acknowledge the same alert at once?** The first appends AlertAcknowledged; the second gets "nothing to change" because the server checks the folded state, not a version number.
- **The board shows a hazard the alert queue doesn't have yet?** Two projections, two checkpoints; they converge within a notice. The ops page shows each projection's staleness.
- **How do you test the strip map?** Geometry helpers are pure functions; Playwright smoke tests load each page against the simulator; screenshots are reviewed.
- **Why not show raw sensor waveforms?** The edge aggregates (peak and RMS per 10 s window); the cloud never sees raw samples. The evidence table shows what the correlator actually used.
