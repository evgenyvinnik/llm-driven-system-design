# Locomotive Fueling — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Users → Architecture → State → Live updates → Screens → Deep dives → Traces → Wrap-up*

> "The backend recommends where each locomotive should fuel and how much. The frontend serves three groups. The fuel desk watches the whole fleet and owns the decisions. The crew needs one sentence on a cab tablet that loses signal in canyons. Admins tune prices and the model. The hard parts aren't rendering a table. They are: keeping a dense dashboard live without drowning it, explaining to a tired dispatcher why the plan changed, and keeping the crew's instructions correct and honest when the tablet has been offline for two hours. Three ideas carry the answer. The server pushes *that* something changed, and the browser fetches *what* it may see. Every plan carries its reason, its confidence and its history. And a stale screen is labelled as stale, never shown as live."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Users and requirements | ~5 min | Three surfaces with different constraints |
| Architecture and state | ~7 min | Server state per page, live invalidations, little global state |
| Screens | ~6 min | Board, plan view, orders, anomalies, crew card |
| Deep dives | ~15 min | Live updates, explaining changes, offline tablet |
| Traces and follow-ups | ~7 min | One success, one failure, the hard questions |
| Wrap-up | ~2 min | What I'd build next |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Does the UI decide, or only display? | Decides whether actions exist | The desk or crew accepts recommendations; only the desk confirms changes after acceptance |
| How many trains does one dispatcher watch? | Board density and virtualization | ~150 in a region; the whole network on demand |
| What hardware is in the cab? | Layout and input | A rugged tablet, often in glare, often offline |
| Must the crew act offline? | Offline queueing vs read-only | Read offline; act online, because acceptance reserves shared capacity |
| How live is "live"? | Push vs poll | A few seconds is fine; sub-second isn't needed |
| Can a crew see other trains? | Server-side scoping | No: their own train only |

### Users and surfaces

| User | Device | Needs | Constraint |
|------|--------|-------|------------|
| Fuel desk | Desktop, 1-2 large monitors | All trains in a region, alerts, plan changes to accept or confirm, DTL orders | Dense, live, scannable in seconds |
| Crew | Cab tablet, glare, gloves | Next stop, gallons per unit, accept the plan | Intermittent connectivity; one train only; read-mostly |
| Admin | Desktop | Prices, closures, model parameters | Changes re-plan many trains; must be deliberate |

### Functional requirements

1. A fleet board: every train, its fuel per unit against reserve, next stop, plan state and alerts, updating live.
2. A train plan view showing:
   - projected fuel along the route with the reserve line;
   - stops with per-unit targets, cost, dwell and queue;
   - reservation and truck status;
   - confidence and assumptions;
   - version history with the reason each plan changed.
3. Plan actions: accept a recommendation; confirm or reject a proposed change after acceptance; re-plan now.
4. DTL orders with their full event trail (including "outcome unknown"), and tickets reconciled against telemetry.
5. Anomalies: leak, sensor fault and low fuel, with the raw-vs-smoothed sensor trace as evidence.
6. Prices and parameters for admins; read-only for the fuel desk.
7. The crew view: their train only, the next stop large and plain, usable offline.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Board freshness | Visible within ~2-5 s of a change | A push channel; refetch coalescing |
| Board scale | ~150 trains per desk region, ~600 unit bars | Row-level updates; virtualize past ~200 rows |
| Tablet offline | Last plan readable with no network, labelled with its age | Local cache of the last good response |
| Correctness | Never show another train to a crew; never show an old plan as current | Server-side scoping; stale banners |
| Accessibility | Status never by colour alone; keyboard reachable | Chips with text, tick for reserve, labelled charts |

### UI load estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Desks per region | ~10-20 | 24/7 coverage across shifts |
| Trains per desk view | ~150 | ~1,500 trains across ~10 regions |
| Raw change events per desk | ~150/min at normal speed | Each train's latest state changes every 30-60 s |
| Refetches per desk | ≤ 30/min | Invalidations coalesced into 2 s windows |
| Fleet payload | ~150 KB uncompressed for 150 trains | ~1 KB per train summary, ~25 KB gzipped |
| Train detail payload | ~30-60 KB | Plan, profile points, versions, evaluations |
| Crew tablet traffic | One train's events; a refetch every few minutes | Cellular data is metered and patchy |

> "The numbers tell me two things. The board can't afford to refetch on every event, so coalescing is a requirement, not a nicety. And the crew tablet must fetch one train and nothing else, both for bandwidth and because the server scopes it anyway."

---

## 🏗️ High-Level Architecture (~4 min)

```
┌────────────────────────── Browser (React 19 + TanStack Router) ───────────────────────────┐
│                                                                                            │
│  Routes: /fleet  /trains/$trainId  /orders  /anomalies  /prices  /login                    │
│                                                                                            │
│  ┌──────────────┐   ┌──────────────────────┐   ┌───────────────────────────────────────┐   │
│  │ auth store   │   │ live store (Zustand) │   │ useRefresh(fetcher, triggers, cache)  │   │
│  │ user, role   │   │ EventSource, counters│──▶│ coalesced refetch · poll when offline │   │
│  └──────────────┘   │ per kind, per train  │   │ · localStorage last-good (tablet)     │   │
│                     └──────────▲───────────┘   └──────────────────┬────────────────────┘   │
└────────────────────────────────┼──────────────────────────────────┼────────────────────────┘
                                 │ SSE: "train T03 changed"          │ REST (role-checked)
                         ┌───────┴──────────┐               ┌────────▼─────────┐
                         │ /api/v1/events   │               │ /api/v1/fleet,   │
                         │ filtered per     │◀── pub/sub ───│ /trains/:id, ... │
                         │ viewer           │   from workers└──────────────────┘
                         └──────────────────┘
```

> "The live channel carries ids, not data. When the processor updates T03's fuel or the planner writes v7, a tiny event goes out: 'train T03 changed'. The page that cares refetches through the same access-checked endpoint it loaded from. That keeps one code path for authorization, and a missed event only costs freshness, never correctness."

---

## 🗂️ State Management (~3 min)

| State | Where | Why |
|-------|-------|-----|
| Session user and role | Zustand auth store | Needed by the shell, routes and actions |
| Live connection and change counters | Zustand live store | One EventSource per tab; pages subscribe to the counters they care about |
| Server data (fleet, train detail, orders) | Per-page hook (`useRefresh`) | Each page owns its fetch, coalescing and polling fallback |
| Last good train detail | localStorage per train | The tablet can show something honest offline |
| Hover, expanded rows, drafts | Component state | Local and ephemeral |

> "I deliberately keep server data out of a global store. A global normalized cache would let the board and the plan view share a train object, and then I'd have to reason about partial updates from two endpoints with different shapes. The pages here don't share much. The board needs a summary of every train; the plan view needs one train in depth. Each refetches on its own trigger, and the server returns a consistent snapshot. If the app grew, I'd move to TanStack Query with the same invalidation counters as query keys."

---

## 📡 Live Updates (~3 min)

- **Events.** `train`, `plan`, `alert`, `order`, `price`, `ticket`, each with an optional train id.
- **Viewer filtering on the server.** A crew session only receives events for its own train.
- **Refetch rules:**
  - The board refetches on train, plan, alert and order events, coalesced to at most one fetch per 2 s. At 180× simulated speed the processor emits a train event per second per train, so without coalescing the board would refetch 10 times a second.
  - The plan view listens only to its own train's counter, coalesced to 1.5 s.
  - While the stream is down, every page polls every 10 s.
  - Reconnecting bumps every counter once, so the page catches up on what it missed.

---

## 🖥️ Screens (~6 min)

**Fleet board.** One row per train:

- symbol and route;
- position bar with milepost, speed and next station;
- fuel bars per unit with a tick at reserve: amber below 2× reserve, red with the word "LOW" below reserve;
- next stop with kind, ETA, gallons and truck status;
- plan chips: version, Recommended/Accepted, confidence when it's not high, "Change awaiting confirmation";
- alert counts by severity.

Tiles across the top show trains running, open alerts, active truck orders, fuel still to buy, and the lowest unit.

**Train plan view**, top to bottom:

- **Header:** milepost, speed, planned tons, "burn running ×1.19 vs model", data age.
- **Open alerts.**
- **Plan card:** lifecycle, Optimized / Greedy fallback / Last good plan, confidence, the reason sentence, who accepted it and when. A collapsible list of assumptions is open by default when confidence isn't high.
- **Proposal card,** when a change is pending.
- **Fuel profile chart.**
- **Stops table:** per-unit "from → to" targets, gallons, cost, dwell including queue, "Bay reserved, held until 19:03", truck status.
- **Objective card:** each cost line and the greedy comparison.
- **Consist panel:** smoothed and raw level, notch, burn multiplier, fault and leak flags.
- **History:** every version with its reason, and the recent evaluations, *including the ones that changed nothing*.

**Orders.**

- **Vendor fault switches** to rehearse failures.
- **The order table.** Expanding a row shows its event trail, e.g. "pending → unknown: no response in 2,500 ms" followed by "unknown → confirmed: vendor has DTL-1002; the earlier request succeeded after we stopped waiting".
- **Tickets** with billed vs telemetry-observed gallons.

**Anomalies.** The alert list, with unit-level alerts first. The selected unit's raw-vs-smoothed sensor chart sits beside it.

**Crew card.** One sentence, large: "Amarillo fuel pad. Arrive 16:39 (in 2.7 h). Take on about 633 gal: 7360 to 3,290, 6260 to 3,456". Plus an Accept button when the plan is only recommended.

### Component breakdown

| Component | Responsibility | Notes |
|-----------|----------------|-------|
| AppShell | Navigation by role, live-status dot, user and sign-out | Crew sees only Fleet (their train) and Anomalies |
| TrainRow | One board row | Pure props; re-renders only when its summary changes |
| FuelBar | One tank with a reserve tick and "LOW" text | Used on the board and in the consist panel |
| PlanHeader | Lifecycle, source, confidence, reason, assumptions, Accept / Re-plan | Actions disabled while a request is in flight |
| ProposalCard | Side-by-side accepted vs proposed, Confirm / Keep current | Fuel desk only |
| FuelProfileChart | Projected fuel vs milepost, reserve line, stop markers, crosshair | Width measured with a callback ref |
| StopsTable | Per-unit targets, cost, dwell and queue, reservation and truck status | "No fuel needed" for units already above target |
| HistoryPanel | Versions and evaluations | Hidden for crew |
| OrdersTable | Orders with an expandable event trail | Auto-expands the first order that went through "unknown" |
| SensorChart | Raw vs smoothed readings, late readings hollow | Evidence for leak and sensor alerts |
| CrewCard | The one sentence the crew needs | Big type, no tables |

Every component stays under about 150 lines, and icons are components in their own folder. API calls live in one typed client that turns error bodies into typed errors with the server's code, so the UI can branch on `SLOT_TAKEN` or `NOT_ACCEPTABLE` instead of parsing messages.

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: SSE invalidations vs WebSocket vs polling for the fuel desk

**Decision.** Server-Sent Events carrying invalidations, with a per-page refetch coalesced to 1.5-2 s, and polling every 10 s only while the stream is down.

**Why it works.** The flow is one-way: the server knows something changed, and the desk needs to see it within a few seconds. SSE is plain HTTP, so it passes the corporate proxies a railroad desk sits behind, and it reconnects on its own with `retry`. One connection per tab is cheap; at 50 desks that's 50 connections per region. Because the payload is "T03 changed" and not the new state, the server does no per-viewer rendering. The authorization check stays in the REST endpoints, where it's already tested. When a crew session is subscribed, the server simply skips events for other trains, so an event can't leak data.

**Why WebSocket fails here.** It doesn't fail technically, but it buys bidirectionality I don't need and costs things I do. Every action already goes over REST with idempotency and access checks, so a socket would mean a second protocol to authorize. Pushing full payloads would also make the server responsible for per-viewer filtering of data, not just ids, and a bug there leaks another train's plan to a crew.

**Why polling alone fails.** A board of 150 trains polling every 2 seconds is 75 requests a second per desk for data that's mostly unchanged. Polling every 30 seconds makes a low-fuel alarm feel broken. Polling is the right fallback, not the primary.

**Why pushing data fails at this event rate.** With the simulator at 180×, every train changes every second. Pushing full rows would re-render the board constantly. Invalidation plus a 2-second coalescing window gives one consistent snapshot per window.

**What I give up.** A refetch costs a round trip after each burst, so updates lag by up to the coalescing window plus one request. A missed event is only repaired by the next event or the reconnect catch-up, which is acceptable because events for a moving train are constant.

### Deep dive 2: Explaining plan changes to humans

**Decision.** Every plan version, and every evaluation that *kept* a plan, is visible with a one-sentence reason. Acceptance and proposals are explicit, and confidence and assumptions sit next to the plan, not in a log.

**Why it matters.** A plan that silently changes from "fuel at Belen" to "fuel at Clovis" teaches a dispatcher to ignore it. The backend uses hysteresis so plans don't flip. The UI has to show that stability is deliberate, and show what would have to change to move it:

- **Reason sentences are generated by the decision logic, not written in the UI.** For example: "price change (KIN-DTL $3.14 → $2.10): new plan saves $13,267"; "kept the current plan: the alternative saves only $189, under the $550 threshold"; "replanned because the current plan would leave a unit below reserve at Winslow; the accepted plan is void".
- **Lifecycle chips** say who holds the decision. A *Recommended* plan reserves nothing, and the card says so. An *Accepted* plan shows who accepted it and when. A *Change proposed* card shows the plan in force and the proposal side by side: the stops still ahead and what each buys. Confirm and Keep current buttons appear for the fuel desk only, plus a sentence on what confirming will release and cancel.
- **Confidence** (high/medium/low) with the reasons: "fuel data is 2.1 h old (+6% margin)", "burn running +19% vs model", "unit 6260 dead-reckoned". The margin isn't a hidden fudge factor; it's on screen.
- **Fallback labels.** If the optimizer timed out, the plan says "Greedy fallback" or "Last good plan". A human should know the plan didn't come from the full optimizer.
- **The chart.** Projected consist fuel against milepost, with the reserve as a labelled red line, "Now", and labelled fuel markers. The hover tooltip shows gallons and "above reserve". The sawtooth makes "why fuel here" visible: the line would cross reserve otherwise.

**Why the alternatives fail.** Showing only the current plan hides churn and makes every change look arbitrary. Showing a raw diff of numbers (gallons moved by 120) buries the one change that matters, a different station. Hiding confidence produces overtrust when the data is stale and undertrust when it's good.

**What I give up.** Screen space and more text. The history panel is hidden from the crew, who need the next stop, not the audit trail.

### Deep dive 3: The crew tablet with intermittent connectivity

**Decision.** The tablet keeps the last good train detail in localStorage, and shows it under an "Offline, showing the plan as of 23 min ago" banner. Actions that change the server need the server.

**Why it works.** In a canyon the crew still needs "next stop Amarillo, take on about 633 gal". A cached plan is useful as long as it's labelled. Every successful fetch rewrites the cache with a timestamp. When a fetch fails, the hook marks the data stale and keeps the cached copy. When the connection returns, the reconnect handler refetches immediately. Time references in the UI are simulated or server time, so "in 2.7 h" is computed against the server's clock.

**Acceptance is not optimistic or queued offline.** Accepting reserves a bay, and the server may answer "409, every bay is taken": first to accept wins. If I let the tablet show "Accepted" optimistically, or queue the click and replay it later, the crew would believe in a reservation that doesn't exist. Instead the button is disabled offline and the card says the stop isn't accepted yet. The server-side crew prompt fires 8 hours ahead, so there's usually coverage somewhere on the way.

**Why the alternatives fail:**

- **No cache.** A blank screen in the one place the crew can't call anyone.
- **A service worker caching every API response.** That serves old plans with no age label, which is worse than nothing. It would also cache other endpoints that should never be stale, such as orders.
- **Queuing acceptance offline** produces phantom reservations.

**Safety beyond the UI.** The tablet isn't the alarm. Low-fuel and range alarms come from the stream processor and reach the desk even if the tablet is dark.

**What I give up.** A crew can't act while offline, and a cached plan can be hours old. The banner and the data age in the header make that explicit.

---

## 📊 Chart Decisions (~2 min)

| Chart | Encodes | Choices |
|-------|---------|---------|
| Fuel profile | Consist gallons vs milepost | One series (title names it, so no legend); reserve as a labelled red threshold; vertical jumps at fuel stops with labels; station names on the x-axis, darker for stations that sell fuel; crosshair tooltip |
| Sensor trace | Raw readings vs smoothed level over time | Raw in de-emphasized grey dots, late readings hollow; smoothed as the blue line with a direct label and a legend; tooltip shows notch, speed and whether a reading was applied |

Both are hand-rolled SVG drawn at the measured container width, so text isn't stretched. The width hook uses a callback ref, so it attaches even when the component first renders a placeholder; a bug here clipped the sensor chart during development.

---

## ⚡ Performance and Density (~2 min)

- **Coalesce, then fetch once.** A burst of 40 train events in two seconds becomes one fleet request. The hook records when it last fetched and schedules the next fetch at "last + window", so a steady stream can't starve the page.
- **Stable rows.** Rows are keyed by train id and take plain props, so React re-renders only rows whose summary changed. Past ~200 rows I'd virtualize the table body (fixed row height makes that easy) and add a regional filter.
- **No chart library.** Two small SVG components drawn at the measured width avoid a large dependency and keep text crisp. Hover state is local to the chart, so moving the mouse doesn't re-render the page.
- **Cheap payloads.** The board gets summaries (fuel per unit, next stop, plan chips). The full plan, profile and history load only on the train page.

## 🛑 Error and Edge States (~2 min)

| Situation | What the user sees | Why |
|-----------|-------------------|-----|
| Stream disconnected | Amber dot "Reconnecting (polling)"; data keeps refreshing every 10 s | Degrade, don't freeze |
| Fetch fails, cache exists | Offline banner with the cache's age | Honest staleness |
| Fetch fails, no cache | Error note, with retry on the next poll | Nothing to show safely |
| Accept returns 409 SLOT_TAKEN | "Every bay is reserved around this train's arrival; re-planning" and a refetch | The server already re-plans; the UI shows the new plan |
| Accept returns 409 "already accepted" | Refetch, which shows who accepted it | Double clicks and two people acting at once are normal |
| Confirm on a proposal that's gone | 409 NOT_PROPOSED and a refetch | The proposal was superseded or rejected by someone else |
| Plan is emergency or infeasible | Red chip "Emergency: uses reserve" and a critical alert | The most important state on the screen |
| Fuel data hours old | Amber "data 2.1 h old" on the row and the header; confidence drops | Stale data is a property of the plan |

## ♿ Accessibility (~1 min)

- Status chips always carry text ("Bay reserved", "Outcome unknown", "LOW"). Colour reinforces, never encodes alone.
- The reserve is a tick on every fuel bar and a labelled line on the chart, so it reads in greyscale.
- Charts have `aria-label`s, and the same numbers appear in the stops table, so the chart is never the only source.
- Actions are buttons with visible labels. Rows are links with the train symbol as text.

## 🧪 Testing Strategy (~1 min)

- Type-check and lint on every change; components are small enough to review whole.
- Playwright smoke tests per page (login, board, plan view, orders, anomalies, prices, crew card) against the seeded stack.
- Scripted scenarios from the simulator to reach rare states on purpose: proposal pending, plan voided, order unknown, sensor fault, short fill. The screenshots in the repo were captured from those states.
- A contract check: the frontend types mirror the API's read models, and the build fails on drift.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a cheaper option after acceptance

1. Admin cuts Kingman's DTL price on the Prices page. The server re-plans affected trains and broadcasts `price` and `plan` events.
2. The desk's board receives two `plan` events, waits out the 2-second window, and refetches once. Q-KCKBAR2's row gains "Change awaiting confirmation".
3. The dispatcher opens the train. The proposal card shows the accepted stop ahead (Clovis) against the proposal (Kingman, saves $9,183 against a bar of $611 that includes the $400 change cost).
4. Confirm sends one POST. On success, the server confirms the new plan, releases the Clovis bay and queues the truck order. The page refetches and shows v6 Accepted, "Bay reserved", and then the truck going Confirmed.
5. The crew tablet, which only receives its own train's events, refetches and its card now reads "Kingman, DTL truck at the siding".

### Failed trace: the tablet is offline when the station goes down

1. The crew accepted "fuel at Amarillo"; the tablet cached it.
2. The train enters a 40-mile dark stretch. Fetches fail; the hook keeps the cached plan and shows the offline banner with its age.
3. Amarillo's pumps fail. The server voids the accepted plan, writes a new recommendation and alerts the desk (critical). The tablet can't receive any of it.
4. The desk sees the voided-plan alert immediately and can radio the crew. The board shows the train's data age climbing.
5. Coverage returns. EventSource reconnects, the counters bump, and the tablet refetches. The banner disappears, the card shows the new stop with "Not yet accepted", and the crew accepts. If someone else took the last bay in the meantime, the server answers 409 and a re-plan follows; the tablet never claimed a reservation it didn't have.

---

## ✅ Design Review Checklist (~2 min)

| Question | Frontend answer |
|----------|-----------------|
| Source of truth; when is a write successful? | The server. An accept or confirm is successful only on a 2xx, and the UI never shows it optimistically |
| Retry after a lost response? | Accept is idempotent in effect: a second click gets 409 "already accepted" and the page refetches the truth |
| Failure between steps? | The page refetches after every action and on every reconnect; nothing assumes the previous step finished |
| Ordering? | Each refetch returns a consistent server snapshot; coalescing means the newest wins |
| Access with async paths? | SSE events are filtered per viewer and carry ids only; all data comes through role-checked endpoints |
| What breaks first? | Board re-render cost past ~200 trains per desk; then SSE fan-out per region. Virtualize rows, then shard the event channel by region |

---

## ❓ Follow-ups

**What does the plan minimize, and how do I show it?** The objective card lists each term: fuel purchases, truck fees, delay (dwell and queue × train-hour cost), stop penalties, cancellations, and the credit for fuel carried to the destination. The reserve isn't on that card. It's the red line on the chart, and a hard rule stated under the assumptions.

**An accepted plan and a cheaper option.** It appears as a proposal card, never as a silent swap. Confirming is a fuel-desk action; the crew sees the change only after confirmation.

**The optimizer timed out.** The plan chip says "Greedy fallback" or "Last good plan", and the reason sentence says the budget was exceeded.

**A station goes down after acceptance.** A critical "accepted plan voided" alert appears on the board and in the train view. The new plan shows as Recommended, and the stops table marks which reservations were released.

**Stale data.** The header shows "fuel data 2.1 h old", the confidence chip drops, and the board row says "data 2.1 h old" in amber.

**Two dispatchers confirm the same proposal at once.** The server checks the lifecycle inside a transaction. The second request gets 409 NOT_PROPOSED, and its page refetches and shows the plan the first dispatcher confirmed.

**An admin closes a busy pad by mistake.** The change is one click, but the response says "re-planning 4 trains". Reopening re-plans them again, and accepted plans that were voided must be re-accepted. In production I'd add a confirmation that lists the affected trains before saving, since a closure voids accepted plans.

**The board for the whole network (1,500 trains).** Virtualize rows, add a region filter and sorting by risk (lowest fuel above reserve, open critical alerts first), and move SSE to a channel per region so a desk doesn't receive the whole network's events.

---

## ⚖️ Trade-offs Summary

| Approach | Pros | Cons |
|----------|------|------|
| ✅ SSE invalidations + refetch | One-way, proxy-friendly, one auth path | Extra round trip per burst |
| ❌ WebSocket with payloads | Lower latency | Second protocol to authorize; per-viewer data filtering |
| ❌ Polling only | Simple | Load or latency, pick one |
| ✅ Per-page server state | Simple, consistent snapshots | Some duplicate fetching across pages |
| ❌ Global normalized cache | Shared objects | Partial-update bugs across endpoint shapes |
| ✅ Cached last plan with age banner | Useful offline, honest | Can be hours old |
| ❌ Optimistic or queued acceptance | Feels fast | Phantom reservations |
| ✅ Reasons, versions, confidence on screen | Trust, fewer calls to the desk | More text, more space |
| ✅ Hand-rolled SVG charts | Exact encoding, no dependency | More code than a chart library |

---

## 📝 Wrap-up (~1 min)

> "The frontend's job is trust. The desk trusts a live board because it updates within seconds and never lies about staleness. They trust the plan because every change comes with a sentence, a version and a confidence level, and nothing they accepted changes without their confirmation. The crew trusts the tablet because it says plainly when it's offline and never claims a reservation it doesn't have. Next I'd add row virtualization and a regional filter for the desk, a map view of trains and fuel facilities, and push notifications to the tablet for voided plans."

### How the local implementation compares

The repo's frontend is Vite + React 19 + TanStack Router + Zustand + Tailwind. It has one EventSource with counters per kind and per train, a `useRefresh` hook with coalescing, a polling fallback and a localStorage cache, hand-rolled SVG charts with crosshair tooltips, and a crew view scoped by the server. Screenshots of every page are in `screenshots/`.
