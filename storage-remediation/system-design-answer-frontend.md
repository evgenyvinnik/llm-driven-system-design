# Storage Misconfiguration Remediation — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Users → Screens → Architecture → State → Contract → Deep dives → Traces → Scale*

> "The backend of this system finds insecure storage settings across forty thousand accounts and fixes them in waves without breaking apps. The frontend is where three very different people decide things based on what they see. A security engineer decides whether to start a campaign that will change hundreds of production resources. An application owner decides whether to fix their account now, migrate a caller, or ask for an exception. An approver decides whether to accept a risk. Every one of those decisions is only as good as the numbers on the screen, so the frontend's real job is trust: numbers with definitions and timestamps, progress that stays live for an hour-long rollout, and actions that can't be double-submitted or misread."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Users and screens | ~5 min | Three roles, seven screens, one account page as the owner's unit of work |
| Architecture and state | ~8 min | URL for filters, route state for snapshots, a stream hook for live campaigns |
| Contract | ~4 min | Idempotency keys from the client; errors that carry decisions |
| Deep dives | ~18 min | Dashboards people trust; campaign progress over SSE; owner self-service and exceptions |
| Traces and checklist | ~6 min | Create-and-start end to end; a reconnect during a rollback |
| Scale and wrap-up | ~4 min | 110K findings, many viewers on one campaign |

---

## 🎯 Users and Requirements (~5 min)

### Clarifying questions

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who uses it? | Drives scope and permissions | Security engineers (run campaigns), resource owners (fix or except their accounts), approvers (accept risk) |
| Does the UI change cloud resources directly? | Decides how careful actions must be | Indirectly: every change goes through the backend executor (waves, bake, rollback) |
| How long does a campaign run? | Decides live-update strategy | Minutes locally, days in production; people watch the first waves closely |
| How fresh is the data? | Decides how to label numbers | Inventory lags reality by seconds to minutes; full scans daily |
| How many findings? | Decides list strategy | ~110,000 at the start (illustrative 40K-account fleet) |

### Functional requirements

1. **Posture**: compliance per control over time, the open-findings burn-down, evidence mix, freshness.
2. **Findings explorer**: filter by control, subscription, owner, severity, evidence class, environment; sort by risk.
3. **Account detail**: current vs desired per control, usage evidence with callers, change history, remediation attempts; "Fix now" and "Request exception".
4. **Campaigns**: create with a live plan preview; start, pause, resume, kill; live wave progress, rollbacks and events.
5. **Exceptions**: request, approve or reject (never your own), revoke; expiries visible.
6. **Controls and policy**: current effect per control; switching to deny is guarded.
7. **Audit log**: who changed what, before and after.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Trust | Every number has a definition and an as-of time | Freshness banner, footnoted definitions, seeded history marked |
| Liveness | Campaign events on screen within ~1 s | SSE with snapshots and events; polling fallback |
| Correctness of actions | No double-created campaigns, no accidental kills | Idempotency keys, confirmations for destructive actions, no optimistic UI for cloud changes |
| Scoping | Owners never see another team's accounts | Server-side scope; the UI only reflects it |
| Accessibility | Status never by color alone; charts readable without hover | Icons and labels on every badge; table views beside charts |
| Performance | Dashboard p95 < 2 s; lists scroll smoothly | Server aggregation, pagination, small payloads |

---

## 🗺️ Screens and Routes (~2 min)

| Route | Who | Purpose |
|-------|-----|---------|
| `/login` | Everyone | Session sign-in |
| `/posture` | Everyone (owners see their team) | Compliance, burn-down, evidence mix, freshness |
| `/findings?control&owner&evidence…` | Everyone | Explorer; filters live in the URL |
| `/accounts/$name` | Everyone (owners: own accounts) | The owner's unit of work |
| `/campaigns`, `/campaigns/$id` | Security runs; others view | Create with preview; live progress |
| `/exceptions` | Owners request; approvers decide | Risk acceptance with expiries |
| `/controls` | Security | Policy effect per control |
| `/audit?action&account` | Everyone (owners: own accounts) | Append-only trail |

---

## 🏗️ Client Architecture (~4 min)

```
┌────────────────────────────────────────────────────────────────────────┐
│ React 19 + TanStack Router (file routes)                               │
│                                                                        │
│  __root: session check → AppShell (nav by role, notification bell)     │
│   ├─ /posture ──── FreshnessBanner · StatTiles · BurnDownChart ·       │
│   │                ControlTable (sparklines, evidence bars)            │
│   ├─ /findings ─── Filters ⇄ URL search params ─ FindingsTable         │
│   ├─ /accounts/$name ─ ConfigTable · EvidencePanel · HistoryList ·     │
│   │                    ExceptionForm                                   │
│   ├─ /campaigns ── CampaignForm (debounced preview) · CampaignList     │
│   └─ /campaigns/$id ─ useCampaignLive ─┬─ CampaignHeader (controls)    │
│                                        ├─ CounterRow · WaveProgress    │
│                                        └─ TargetTable · EventFeed      │
├────────────────────────────────────────────────────────────────────────┤
│ Zustand: auth only    services/api.ts: typed client, ApiError(code)   │
│ services/campaign-stream.ts: EventSource → snapshot/progress → poll    │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ REST (JSON) · SSE (text/event-stream)
┌──────────────────────────────▼─────────────────────────────────────────┐
│ API: role + team scope in every query · Idempotency-Key · SSE from a   │
│ capped event stream with Last-Event-ID resume                          │
└────────────────────────────────────────────────────────────────────────┘
```

> "The router owns navigation and the URL; a tiny Zustand store owns who's signed in; each route owns its own server data. I don't reach for a global cache here, because almost nothing is shared between screens except the session, and the one truly live object, a running campaign, needs stream semantics a generic cache doesn't give me."

---

## 💾 State Management (~4 min)

| State | Where it lives | Why |
|-------|----------------|-----|
| Session user and role | Zustand `auth-store` | Read by the shell, nav and every action button |
| Findings filters and page | URL search params (validated in the route) | Shareable links ("all SA-02 findings needing migration for payments"), back button works |
| Posture, account, exceptions | Route-local state, refetched on an interval | Each screen's data is used by that screen only |
| Live campaign | `useCampaignLive(id)` hook: snapshot + rolling event list + stream mode | Stream lifecycle tied to the route; dedupe by event ID |
| Form drafts (campaign, exception) | Component state | Short-lived; the preview is derived, never stored |
| Idempotency key per intended campaign | `useMemo` in the form | One key per "I want this campaign", reused across double clicks and retries |

> "Filters in the URL is the decision people underrate. A security engineer pastes a findings link into a ticket for a team; it has to open to exactly the same list for the owner, scoped by the server to what they're allowed to see."

---

## 🧩 Component Boundaries (~2 min)

| Component | Owns | Doesn't own |
|-----------|------|-------------|
| `CampaignForm` | Draft config, debounced preview, the idempotency key | Navigation after create (the route does it) |
| `useCampaignLive` | Snapshot, event list, stream mode, dedupe | Rendering |
| `CampaignHeader` | Transition buttons, confirmation, stream indicator | Campaign state (it re-fetches after the server answers) |
| `WaveProgress` | One segmented bar per wave with a legend | Counting (the server counts) |
| `ConfigTable` | Current vs desired per control, row actions | The fix itself (calls the API, then navigates) |
| `EvidencePanel` | Callers and counts, the "no logs" warning | Classification (computed server-side) |
| `FreshnessBanner` | Turning timestamps into "fresh" or "stale" | The timestamps themselves |

Components stay under about 150 lines; icons are components in one folder with a barrel export; API calls live in one typed client so error codes are handled in one place.

---

## ⚡ Performance Budget (~1 min)

| Path | Budget | How |
|------|--------|-----|
| Posture payload | < 50 KB | Aggregates only; history pre-bucketed by snapshot |
| Findings page | 50 rows, < 30 KB | Server pagination; filters as query params |
| Campaign stream | ≤ 1 snapshot/s | Server-side throttling; events are small |
| Bundle | ~120 KB gzipped | No chart library: two small SVG components |

---

## 🔐 Role-Aware UI (~2 min)

The server enforces every permission; the UI only avoids showing doors that won't open.

| Screen | Security engineer | Resource owner | Approver |
|--------|-------------------|----------------|----------|
| Posture | Fleet; "Run full scan" | Own team's numbers, fleet history | Fleet, read-only |
| Findings | All | Own team only (server filter) | All, read-only |
| Account | Fix now, request exception | Fix now, request exception (own accounts) | Read-only |
| Campaigns | Create, start, pause, resume, kill | View | View |
| Exceptions | Decide (not own), revoke | Request, revoke own | Approve or reject (not own) |
| Controls | Change effect (deny guarded) | View | View |

> "Owners see 'Showing accounts owned by payments' in the header. When scope silently changes what a table shows, people file bugs about missing data, so I say the scope out loud."

---

## ⏳ Loading, Empty and Error States (~2 min)

| State | Treatment |
|-------|-----------|
| First load | A small spinner with a label; no skeleton flash on 15-second refetches (the old data stays until the new arrives) |
| Empty list | Says why: "No findings match these filters", not a blank table |
| Network error | Inline note with the server's message; the last good data stays on screen |
| Stale data | The freshness banner turns amber with an icon and the word "stale" |
| Stream degraded | Header shows "polling every 3s" instead of "live (SSE)" |
| Action refused | The error code drives the message (cap for this severity, burn-down incomplete) |

---

## ♿ Accessibility and Charts (~2 min)

- **Status never by color alone.** Severity, target state and campaign status all carry an icon and a word. Status colors (good, warning, serious, critical) are reserved for status and never reused for a data series.
- **Categorical colors validated, not eyeballed.** The three evidence classes use the first three slots of a palette checked for color-vision deficiency; one slot is below 3:1 contrast on white, so every use has a visible text label and the findings table serves as the table view.
- **Charts readable without hover.** The burn-down labels its current value directly; the crosshair tooltip adds detail but is never the only way to read a number. Sparklines carry an accessible label ("SA-02: 25.5% → 43.3%").
- **Keyboard and screen readers.** Tables have labels, buttons are real buttons, and the destructive Kill action asks for confirmation in words.

---

## 🔌 Client–Server Contract (~4 min)

```
GET  /posture                         → controls[], fleet totals, history[], freshness{}
GET  /findings?control=SA-02&page=2   → findings[], total, page, pageSize
GET  /accounts/:name                  → account, controls[current/desired/finding], evidence, history
POST /campaigns/preview               → plan {eligible, waves[], excluded{}}
POST /campaigns  (Idempotency-Key)    → {campaignId, plan, replayed}
POST /campaigns/:id/start|pause|resume|kill → {status, changed}
GET  /campaigns/:id/events            → SSE: event snapshot · event progress (id = stream ID)
POST /accounts/:name/fix (Idempotency-Key) → {campaignId}
POST /exceptions · /exceptions/:id/approve|reject|revoke
PUT  /controls/:id/policy             → 409 BURN_DOWN_INCOMPLETE {compliancePct, open}
```

Errors carry a code the UI acts on, not just a message:

| Code | UI behavior |
|------|-------------|
| `BURN_DOWN_INCOMPLETE` | Explain why deny is premature, show compliance and open count, offer an explicit "force" |
| `INVALID_DURATION` | Inline on the exception form: the cap for this severity |
| `CANNOT_DECIDE` | Approve button hidden for your own request; message if it races |
| `NOT_YOUR_ACCOUNT` | Owner lands on a page they can't see: a clear 403, not an empty page |
| `NO_ELIGIBLE_TARGETS` | Disable create; the preview already shows zero |

---

## 🔧 Deep Dive 1: Posture Dashboards People Trust (~6 min)

**Decision:** one definition of compliance shared by the dashboard, the snapshots and the policy guardrail; every number shown with when it was true and how it's computed; history that admits which part is real.

**Why it matters here.** The posture page drives two decisions with real consequences: which campaign to run next, and whether a control is clean enough to switch policy to deny. A dashboard that overstates compliance gets deny turned on early, and deny on a dirty fleet blocks every team's redeploys. A dashboard nobody trusts gets ignored, and the program loses its argument for priority. So trust is the requirement, not decoration.

**What builds trust:**

1. **One definition, written on the page.** Compliance = accounts passing the control ÷ accounts evaluated for it. Exempt accounts are not compliant; they're accepted risk, shown separately. An account is "evaluated" only once the resource the control reads has been read (soft delete lives on a child resource). The footnote says exactly that, and the server computes it in one place.
2. **Freshness, front and center.** A banner states the last full scan, the last change-feed poll and the last config change seen, and explains that full scans read Resource Graph (which lags) while changes are re-read from ARM. When the scan is older than expected or the feed stalls, the banner turns amber and says "data may be stale" with an icon and words, not just a color.
3. **History that labels itself.** The seeded backfill (before the first scan) sits under a shaded band labelled as such. I don't use a dashed line; a band is quieter and reads as "this region is different".
4. **Small multiples instead of a spaghetti chart.** Seven controls on one line chart means seven colors and a legend chase. Each control row gets its own sparkline of compliance, and the headline chart is a single series (open findings) with a crosshair tooltip. One series needs no legend; the title names it.
5. **The evidence mix as a part-of-whole bar.** Safe to fix, needs migration, insufficient evidence: three categorical colors validated for color-vision deficiency, 2-pixel gaps, a legend above the table, and the exact counts in the findings explorer (the table view).

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Shared definition + freshness + labelled history + small multiples | Numbers hold up in a review | More UI chrome; slower to build |
| ❌ "98% secure" hero number | Executives love it | Hides exempt and unevaluated accounts; invites premature deny |
| ❌ One line chart with seven series | Compact | Unreadable; color-only identity |
| ❌ Client-side aggregation from raw findings | Flexible | 110K rows to the browser, and a second definition of "compliant" |

> "If the dashboard and the deny guardrail computed compliance differently, someone would screenshot 96% and then get a 409 saying 93%. That inconsistency costs more trust than either number."

**What I give up.** The page is denser, and the honest numbers look worse early on (60% instead of a flattering figure). Owners see their team's current numbers but fleet-wide history, because per-team history would need per-scope snapshots; that's a backend rollup I'd add next.

---

## 🔧 Deep Dive 2: Long-Running Campaign Progress — SSE vs Polling (~6 min)

**Decision:** Server-Sent Events carrying two kinds of messages: a full snapshot (counts, waves, recent targets) at most once a second, and individual progress events (applied, throttled, rolled back, paused) as they happen. EventSource reconnects on its own with `Last-Event-ID`; after three failures the client falls back to polling the same snapshot every 3 seconds, and the header says which mode it's in.

**Why SSE fits.** Progress is one-way, server to client. A campaign emits bursts: a wave starting enqueues hundreds of targets, the verifier finishes dozens in the same second. The viewer cares about two things: "is anything going wrong right now" (a rollback, an auto-pause) and "how far along are we". Events answer the first with sub-second latency; snapshots answer the second and make the stream self-healing. If the client missed events, the next snapshot corrects every counter, so the UI never drifts.

```
EventSource /campaigns/:id/events
   │
   ├─ event: snapshot  ─▶ replace counts, waves, recent targets
   ├─ event: progress  ─▶ prepend to feed (dedupe by stream ID)
   ├─ event: progress  ─▶ "target.rolled_back stmobilemediw9i0jo · W1"
   ├─ (network drop)   ─▶ auto-reconnect, Last-Event-ID: 1793903623163-0
   │                      server resumes after that ID, then a fresh snapshot
   └─ 3 failures       ─▶ close stream, poll GET /campaigns/:id every 3 s
```

| Approach | Pros | Cons |
|----------|------|------|
| ✅ SSE: snapshots + events, Last-Event-ID, polling fallback | Push latency, plain HTTP, resumable, simple server | One long connection per viewer; buffering proxies break it |
| ❌ Polling only | Trivial, cache-friendly | A 3 s poll misses the moment of a rollback; 100 viewers × 20 req/min |
| ❌ WebSocket | Bidirectional | Nothing to send upstream; more infrastructure; reconnection is mine to build |
| ❌ Events only, no snapshots | Smaller messages | Any missed event leaves counters wrong forever |

> "The snapshot is the correctness mechanism; the events are the experience. Without snapshots, a reconnect after a laptop sleeps would show 62 verified forever while the server says 252."

**Details that matter:**

- **Throttled snapshots.** During a burst the server sends at most one snapshot per second, plus a keep-alive comment every 15 s so proxies don't close the stream.
- **Dedupe on reconnect.** The client keeps the last 200 events keyed by stream ID; a replay after reconnect never shows a row twice.
- **Problem rows first.** The recent-targets table sorts rolled back, failed and escalated above routine verifications, so a pause reason and its causes are on the first screen.
- **Controls reflect state, and confirm the dangerous one.** Start in draft; Pause while running; Resume when paused; Kill always, behind a confirmation that says exactly what kill does: stops new writes, while changed accounts keep baking and can still roll back.
- **No optimistic transitions.** Clicking Pause doesn't flip the badge until the server says so. A campaign that changes cloud resources must never look paused while workers are still writing.

**What I give up.** One open connection per viewer per API instance, each with its own blocking read on the event stream. Fine for tens of viewers; at hundreds I'd multiplex one subscription per campaign per API instance and fan out in process.

---

## 🔧 Deep Dive 3: Owner Self-Service and Exception UX (~6 min)

**Decision:** the account page is the owner's unit of work. It shows, per control, the current and desired value, the finding with its due date, and the evidence that explains why it isn't safe yet, with two actions: "Fix now" (through the same executor path as any campaign) and "Request exception" (time-boxed, approved by someone else).

**Why it works.** Owners get a daily digest per control ("12 accounts need you for SA-02: 9 have callers to migrate, 3 lack logs"), not one ticket per finding. Each link lands on an account page that answers the owner's three questions in one place: what's wrong, who is using it, and what happens if I fix it. The evidence panel names the callers (IP, auth type, user agent, last seen) and says plainly when logs are missing: "Absence of logs is not evidence of non-use: fix SA-07 first."

**"Fix now" is not a shortcut around safety.** It creates a one-account campaign, so the owner's own fix records intent, writes with If-Match, bakes, and rolls back on 403s. After clicking, the owner lands on that campaign's live page and watches it bake. The button carries an Idempotency-Key, so a double click is one fix.

**Exceptions are designed to expire.** The form states the rules before the owner types: an approver who isn't you must accept the risk; the duration is capped by severity (high: 90 days); when it expires the finding reopens automatically. The approver's table shows justification, requester, severity and owner, hides Approve on your own requests, and highlights expiries within 7 days in words ("expires in 3d") as well as color.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Account page + digest + fix through the executor + expiring exceptions | Owners see cause and effect; every path is safe | More screens to build |
| ❌ Ticket per finding | Fits existing tools | 110K tickets; owners mute the queue |
| ❌ "Fix now" as a direct PATCH | Instant | Skips bake and rollback for exactly the people least able to judge the risk |
| ❌ Free-form, permanent exceptions | Less friction | Risk accepted once, never revisited |

> "The most dangerous button in the product is an owner's 'Fix now' on an account with callers they don't know about. Routing it through the same bake and rollback as a campaign turns that into a 30-second detour instead of an outage."

**What I give up.** Owners wait a bake period after "Fix now" instead of seeing instant success, and the exception form adds friction on purpose. Both are the point.

---

## 🧪 Traces (~6 min)

### Successful: Alice creates and starts a campaign

1. Campaigns → New campaign. The form is prefilled (SA-02, non-production, safe to fix only) and generates one Idempotency-Key for this intended campaign.
2. Every change to the form debounces 300 ms and calls the preview. The panel shows "255 accounts in 3 waves" with wave sizes and exclusions (227 need migration, 288 lack evidence, 1 exception).
3. She clicks Create. The request carries the key; a double click sends the same key and gets the same campaign back (`replayed: true`).
4. The app navigates to the campaign page; the hook fetches a snapshot and opens the event stream. The header shows "live (SSE)".
5. She clicks Start. The badge flips to running when the server confirms. Wave 1 starts; events stream in (applied, then verified); the snapshot updates counters once a second.

### Failed: a reconnect during a rollback

1. Wave 1 is baking. Alice's laptop sleeps; the stream drops.
2. While she's away the verifier rolls back `stmobilemediw9i0jo` and, later, wave 2 exceeds its failure budget and the campaign pauses itself.
3. The laptop wakes. EventSource reconnects with the last event ID it saw; the server sends the events after it (rollback started, rolled back, campaign paused), then a snapshot.
4. The hook skips any event it already has. The header now shows "paused", an amber banner with the reason ("2 failures exceeded the budget of 1"), and the targets table lists the three rolled-back accounts first, each with its reason.
5. If the reconnect fails three times (a proxy buffering the stream), the hook switches to polling and the header says "polling every 3s". The page still converges; it's just less immediate.

---

## ✅ Design Review Checklist (~2 min)

1. **Source of truth.** The server. The UI never infers state: transitions, campaign status and exception status change on screen only after the server confirms.
2. **Retry after a lost response.** Campaign creation and "Fix now" carry an Idempotency-Key generated once per intent, so retries and double clicks return the same campaign. Transitions are idempotent on the server.
3. **Failure between two steps.** A dropped SSE stream resumes from `Last-Event-ID`; snapshots repair anything missed; three failures fall back to polling.
4. **Ordering.** Events are shown newest first and deduped by stream ID; counters come only from snapshots, so out-of-order delivery can't corrupt them.
5. **Access with caches and async work.** Scope is enforced by the server in every query, including stream snapshots; the UI hides actions a role can't take but never relies on hiding for security.
6. **What breaks first.** Many viewers on one campaign, because each holds one blocking stream read on the API, and then list size. The evidence: the posture call takes 24 ms at 1,500 accounts and grows linearly with the fleet, and the stream reader is one connection per viewer by construction.

---

## 📈 Scale (~3 min)

| Pressure | Approach |
|----------|----------|
| 110K findings | Server pagination and filtering; filters in the URL; virtualize if a page grows past a few hundred rows |
| Posture at 40K accounts | Precomputed per-scope rollups; the page only renders aggregates |
| Many viewers on a launch-day campaign | Multiplex one event subscription per campaign per API instance; snapshots throttled to 1/s |
| Very long campaigns (days) | Event feed capped (~2,000 per campaign); history from the audit log |
| Owners across 1,200 teams | Digests, not per-finding notifications; deep links into filtered lists |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Live progress | SSE snapshots + events | Polling | Rollbacks need sub-second visibility; snapshots self-heal |
| Transport | SSE | WebSocket | One-way data; HTTP semantics; built-in resume |
| Filters | URL search params | Component state | Shareable, back-button safe |
| Global state | Auth only in Zustand | Global cache for everything | Little shared data; live data needs stream semantics |
| Cloud-changing actions | Pessimistic (confirm, then show) | Optimistic UI | Never show "paused" while writes continue |
| Posture chart | Single series + small multiples | Multi-series line chart | Seven series is unreadable |
| Owner fix | Through the executor | Direct PATCH | Bake and rollback protect owners too |
| Exceptions | Capped, approver ≠ requester, expiring | Free-form | Accepted risk must come back |

---

## 🎤 Wrap-up

> "Everything on these screens is there to support a decision with consequences in production. So the dashboard says what each number means and when it was true; the campaign page stays live through an hour-long rollout and survives a laptop lid closing; and every button that changes the cloud is idempotent, confirmed when destructive, and routed through the same safety net as the campaigns themselves."
