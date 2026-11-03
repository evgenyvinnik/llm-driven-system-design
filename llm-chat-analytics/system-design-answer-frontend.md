# LLM Chat Analytics — System Design Answer (Frontend Focus)

*Senior frontend / product engineer interview · 45–50 minutes · structured with the RADIO framework: Requirements → Architecture → Data model → Interface → Optimizations*

> "An analytics dashboard for a chat product looks like a grid of charts with a date picker. The known trap is to spend the hour on chart components and never explain where trustworthy numbers come from. So I'll start with definitions, because every chart is only as good as what 'active user' or 'abandoned generation' means. Then I'll spend most of the time on three client problems: keeping filters, cache keys and responses in agreement while the user clicks fast; showing time zones, comparisons and late data honestly; and drilling into a bar without leaking cost or private conversations."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~6 min | Users, metric definitions, numeric targets, the trap |
| A — Architecture | ~7 min | Screen layout, client layers, the server facts the client relies on |
| D — Data model | ~5 min | The query object, where each kind of state lives |
| I — Interface | ~4 min | Endpoints, the echo, the error codes the UI branches on |
| O — Optimizations | ~22 min | Three deep dives, rendering, accessibility, failure handling, traces |
| Wrap-up | ~2 min | Trade-offs, what breaks first |

---

## 🎯 R — Requirements Exploration (~6 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Who looks at it? | Roles decide what a response may contain | Org admins (see cost), org analysts (no cost), internal support (all orgs, no cost, no conversation lists) |
| How fresh is "near real time"? | Polling vs push, and what the freshness label may claim | Data queryable within a minute; client events can arrive much later |
| One org at a time, or across orgs? | Time zone of a "day" | One org per view; days are calendar days in that org's zone |
| Which breakdowns? | Cross-filter design, dimension rules | Model and feature; filters combine |
| Can users see conversations? | Privacy boundary | Metadata only, never content; nothing under 5 users |
| How far back? | Bucket counts, rendering | 400 days by day, 35 days by hour, 2 days by minute |
| Exports? | Background jobs vs download | Yes, up to a year of conversation metadata, so tens of thousands of rows |

### Metric definitions first

> "Before I draw a screen, I'd write these down with the product team, because the frontend shows them on every tile and the drill-down has to agree with them."

| Metric | Definition the UI commits to |
|--------|------------------------------|
| Conversation | One `conversation_started` event, counted in the bucket of when it happened, whatever happens afterwards |
| Active user | A distinct user who sent at least one message in the period. Opening the app doesn't count |
| Successful response | The server delivered the final token. Rate = completed ÷ (completed + failed + abandoned) |
| Abandoned generation | The user pressed Stop or left before the final token. The server reports it, so a closed tab still counts |
| TTFT and total time | Server-measured over completed responses; p50, p95 and p99 |
| Cost | Tokens × the price in effect at the time. Billing data |

Every event carries `event_id`, `org_id`, a pseudonymous `user_id`, `event_type`, `event_time`, `received_time`, `schema_version` and a source (client or server), plus dimensions and measures. **Never message content.** The definitions page in the app is rendered from the same catalog the API computes from, so a tile and its tooltip can't drift apart.

### The analyst's workflow

1. Open the org's dashboard: last 7 days by day, compared with the previous week.
2. Scan the KPI tiles for anything moving the wrong way.
3. Switch the main chart to the metric that moved; spot the day or hour.
4. Click a model or a feature to narrow every other widget to it.
5. Click the suspicious bar to see the conversations behind it.
6. Share the URL in a ticket, or export the range as CSV.
7. Come back tomorrow and wonder why yesterday's number changed.

### Non-functional requirements

| Property | Target | Why this number |
|----------|--------|-----------------|
| Filter change to painted result | < 300 ms on a cache hit, < 1 s p95 on a miss | Analysts click several filters in a row |
| Rapid changes | Superseded requests aborted; a stale response never painted | The dashboard must never show one filter's numbers under another's label |
| Honest freshness | The label states what the pipeline has *verified*, not when the browser last polled | Trust is lost the first time "live" data is an hour old |
| Shareability | The URL reproduces the exact view, including the open drill-down | Links go into tickets and incident channels |
| Isolation | One widget's failure never blanks the dashboard | Eight widgets, eight queries |
| Access | Cost never reaches the browser for roles that can't see it | Hiding it in React isn't access control |
| Accessibility | WCAG 2.2 AA; every chart has a table view | Identity never by color alone |

---

## 🏗️ A — Architecture (~7 min)

### Screen layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Chat Analytics  Dashboard·Definitions·Pipeline·Exports  [Larkspur · admin ▾]  │
│                       ✓ Up to date · complete through Nov 2 20:11 PST   Alice │
├───────────────────────────────────────────────────────────────────────────────┤
│ [1h|Today|24h|7 days|28 days|MTD|Custom] [By day ▾] [vs previous week ▾]      │
│ Model (orion-large)(orion-swift)…  Feature (Plain chat)(Web search)…  [Export]│
├───────────────────────────────────────────────────────────────────────────────┤
│ Summary  Oct 27 – Nov 2, 20:28 · vs Oct 20 – Oct 26, 20:28   Partial          │
│ [≈896 users ▲0.3%][5,609 conv ▲1.8%][93.1% ok][2.42% err][4.50% aband][…cost] │
├───────────────────────────────────────────────┬───────────────────────────────┤
│ Conversations              [metric ▾]         │ Feature adoption   Partial    │
│  ▇   ▇   ▇   ▇              │░░               │ Plain chat     ≈892  100%     │
│  ▇   ▇   ▇   ▇   ▃   ▄  ▒▒  │ complete        │ Web search     ≈701   78%     │
│  ─ previous week ─────────  │ through 20:11   │ Code execution ≈560   63%  ✓  │
│ Oct27 … Nov1↻ Nov2(partial) · View as table   │                               │
├───────────────────────────────────────────────┴───────────────────────────────┤
│ Conversations · Fri Oct 30   Bar 984 · raw 984 ✓ rows add up      [×]         │
│ conversation · user (pseudonymous) · model · features · messages · tokens …   │
├───────────────────────────────────────────────┬───────────────────────────────┤
│ Time to first token  p50 p95 p99  [TTFT|Total]│ By model        (cross-filter)│
└───────────────────────────────────────────────┴───────────────────────────────┘
```

The freshness label lives in the header because it qualifies every number on the page. Filters sit in one row above everything they affect. The drill-down opens inline under the chart it came from, so the bar and its rows are on screen together.

### Client layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│ URL  /?org=larkspur&range=7d&models=orion-large&metric=error_rate&drill=… │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ 1 parse (garbage → defaults)
┌──────────────▼──────────────┐   2 resolve with org tz + now
│ Dashboard search (intent)   │──────────────────────────────┐
└─────────────────────────────┘                              ▼
                                            ┌────────────────────────────────┐
                                            │ Resolved query (absolute,      │
                                            │ bucket-aligned, canonical)     │
                                            └───────┬────────────────────────┘
                              3 settle 200 ms       │ per widget: minus own dim
          ┌──────────────┬──────────────┬───────────┼──────────────┐
          ▼              ▼              ▼           ▼              ▼
     [overview]     [series m]     [latency]   [breakdown]   [drill bucket]
          │ 4 key = widget + canonical string        │
┌─────────▼────────────────────────────────────────────────────────────────┐
│ Query cache (TanStack Query): keyed entries · AbortSignal · keep-previous │
└─────────┬────────────────────────────────────────────────────────────────┘
          │ 5 GET /query/:widget?…   6 response.echo must equal the key
┌─────────▼────────────────────────────────────────────────────────────────┐
│ Query API: catalog · access · cache (key includes role scope) · planner  │
└──────────────────────────────────────────────────────────────────────────┘
   Zustand: session (user, orgs, roles) · export jobs being watched
```

**Walking the arrows:** (1) The URL is parsed into the user's *intent*: "7 days", these chips, this metric. (2) Intent is resolved into absolute instants: org-local midnights for days, UTC-aligned hours for hours. (3) The fetchable query trails the screen by 200 ms, so a burst of clicks settles into one request. (4) Each widget's key is its name plus the canonical string. (5) The request carries an AbortSignal. (6) The server echoes the canonical string, and a mismatch is thrown away, never painted.

### What the client relies on from the server

I'd name three server facts and then stay in the browser. First, ingest deduplicates by `event_id` and buckets by **event time**, so past buckets change when late events arrive. Second, the API reports a **watermark** per stream: everything before it has been counted. Third, every number comes from one **catalog and one predicate builder**, used by charts, drill-downs and exports alike. Distinct users and percentiles are merged from sketches on the server; the client never adds them up.

---

## 💾 D — Data Model (~5 min)

### The query object

| Field | Example | Notes |
|-------|---------|-------|
| org | `larkspur` | Also decides the time zone |
| from, to | `2026-10-27T07:00Z`, `2026-11-03T08:00Z` | Absolute, aligned: Oct 27 00:00 PDT to Nov 3 00:00 PST |
| grain | `day` | Allowed grains depend on the span |
| models, features | `[orion-large]`, `[]` | Sorted and de-duplicated |
| compare | `wow` | none, week-over-week, month-over-month |
| widget extras | `metric=error_rate`, `dim=model`, `bucket=…` | Part of that widget's key |

The **canonical string** is these fields in a fixed order with empty values dropped. Three places use the same string: the client's cache key, the server's cache key (plus role scope and data revision) and the response echo.

### Entities as the client sees them

| Entity | Key fields the UI uses |
|--------|------------------------|
| Tile | value, previous, delta (relative or points), approximate, coverage, notApplicable |
| Series bucket | start, end, value, count, partial, open, coverage, suppressed, lateEvents, revisedAt, previous {value, toDate, clamped}, clipped |
| Breakdown row | key, value, users, share, suppressed |
| Drill-down | rollupCount, matched, users, conversations, rows (metadata), columns |
| Freshness | watermarks per stream, backlog, revised days |
| Export job | status, rowsDone/rowsTotal, columns, file size |

### Where each kind of state lives

| State | Lives in | Why there |
|-------|----------|-----------|
| Filters, range, metric, open drill-down | URL | Refresh, back button and pasted links reproduce the view |
| Resolved query | Derived on render | Never stored, so it can't go stale against the URL |
| Server data | Query cache keyed by the canonical string | A response can only land in the entry for the question it answers |
| Session, roles, watched export jobs | Zustand | Cross-page, small, rarely changes |
| Hover, open menus, TTFT/Total toggle | Component state | Nobody else needs it |

> "The one rule I'd defend hardest: nothing about *which data is on screen* is held in component state. If it's not in the URL, it's derived from the URL."

---

## 🔌 I — Interface Definition (~4 min)

```
GET  /api/v1/query/overview?{query}                 KPI tiles for the window and comparison
GET  /api/v1/query/series?{query}&metric=           buckets with comparison, partial, coverage
GET  /api/v1/query/latency?{query}                  p50/p95/p99 TTFT and total per bucket
GET  /api/v1/query/breakdown?{query}&metric=&dim=   rows by model or feature, suppressed rows
GET  /api/v1/query/drilldown?{query}&metric=&bucket=&offset=
GET  /api/v1/freshness?org=                         watermarks, backlog, revised days
GET  /api/v1/meta                                   metric catalog, event contract, coverage
POST /api/v1/exports  (Idempotency-Key)             create job;  GET /exports/:id  progress
```

### What the UI branches on

| Response | UI |
|----------|-----|
| 200 with `echo` ≠ my key | Discard silently; the newer request will paint |
| 403 `METRIC_FORBIDDEN` / `FORBIDDEN` | Widget shows "Not available for your role" with the reason |
| 404 `ORG_NOT_FOUND` | Org switcher drops the org (also for orgs you were never in) |
| 422 `DIMENSION_NOT_APPLICABLE` | "Conversations can't be split by feature…" instead of a chart of zeros |
| 400 `UNALIGNED_RANGE` | A client bug: logged, widget shows the error |
| 5xx / network | Per-widget error with Retry; the last good data stays, labelled |

---

## 🔧 O — Optimizations and Deep Dives (~22 min)

> "Three deep dives, each with an obvious alternative that breaks in a specific way."

### Deep dive 1: Filters, query keys and cross-filtering under rapid change (~8 min)

**Decision.** URL is the only source of filter state. Each widget derives its key from the resolved, canonical query. Requests trail the screen by 200 ms and are aborted when superseded, and the server echoes the canonical string.

**Why it works here.** An analyst toggles orion-large, orion-swift and orion-think in under a second. The chips update immediately, because they read the URL. Widgets keep showing their previous answer at half opacity with an "Updating" badge, which is honest: it says these numbers belong to the previous filters. When the filters settle, every widget gets a new key. TanStack Query fetches the new keys and aborts in-flight requests for keys nobody observes anymore. The abort closes the connection, and the API passes the signal to ClickHouse, so the warehouse stops working on a question nobody is asking. With a simulated 1.5-second warehouse delay I measured this: four chip clicks produced 16 requests, 12 were aborted, and only the final filters painted.

The important property is that **staleness is impossible by construction, not by timing**. A slow response for "orion-large only" arrives after the user moved on. It lands in the cache entry keyed "orion-large only", which no widget is observing. It can't paint over the newer view, because the view isn't reading that entry. The echo check is belt and braces: if a proxy or a bug ever returned the wrong body, the widget throws it away.

**Relative ranges.** "Last 7 days" stays as intent in the URL, so a link means "last 7 days" tomorrow too. It's resolved with the org's time zone and *now* at render. The resolved query only changes when a boundary passes: midnight for day ranges, the hour for 24 h, the minute for 1 h. So the key is stable between those moments and the cache works. The open period refreshes on an interval, not by re-keying.

**Cross-filtering.** Clicking "orion-large" in the By-model chart adds it to the global filter. Every other widget narrows to it. The By-model chart itself keeps showing all models with orion-large highlighted. Its own query is the global query *minus its own dimension*, which gives it a different key. Filtering a chart by its own selection would leave a single bar and no way to compare, or to click a second one.

**Follow-up: "The user changes filters several times a second. What reaches the server, and what reaches the screen?"** The server gets at most one request per widget per settled state, plus aborts for anything superseded in flight. Clicks inside the 200 ms window never leave the browser. The screen shows the new chips at once, the previous numbers dimmed and labelled until the new ones arrive, and only responses whose key and echo match the current state.

**Why the alternatives break.**

- *Filters in a store, URL synced afterwards.* Two sources of truth. Back-button and pasted links race the store, and a refresh loses the drill-down.
- *Fire a request per click, last one wins.* "Last" means last *sent*, not last *received*. With variable warehouse latency, the second click's slow response arrives after the third click's fast one and repaints the screen with the wrong filters, under labels that look right. The bug only shows when the warehouse is slow, which is exactly when users are already suspicious.
- *Debounce only, no abort.* Fewer requests, but anything already in flight still runs to completion on the server and can still paint if the code applies results without checking the key.

| Approach | Stale paint possible | Server work on superseded queries | Cost |
|----------|---------------------|-----------------------------------|------|
| ✅ URL → resolved key → keyed cache + abort + echo | No, by construction | Stopped | 200 ms added to each settled change |
| ❌ Store + per-click fetch, last wins | Yes, under latency jitter | Full | Subtle wrong numbers |
| ❌ Debounce only | Yes, if late responses apply | Full for in-flight | Fewer requests, same race |

**What I give up.** A 200 ms delay on every settled change, and up to eight parallel requests per change (HTTP/2 makes that cheap). I'd consider one batched "dashboard" request instead, but then one slow widget holds up all the others.

### Deep dive 2: Time zones, comparison periods and late data (~8 min)

**Decision.** Days are calendar days in the org's time zone, computed by the server. Comparisons shift by local wall-clock time and compare the open period *to date*. Buckets after the watermark are drawn as partial, late arrivals are marked as revisions, and periods before a metric existed are drawn as gaps.

**Time zones.** Larkspur is in Los Angeles; Kestrel is in Kolkata, UTC+5:30. "Yesterday" for Kestrel starts at 18:30 UTC. If the client grouped UTC days, a Kestrel admin's Monday would include Sunday evening. So the server stores a local date with every event and rolls days up by it. The client's job is to ask for local midnights and label everything in the org's zone with its abbreviation. A support engineer in Berlin looking at Kestrel sees Kestrel's day, and the footer says so. Hour charts stay UTC-aligned, because that's how hours are rolled up. In Kolkata that means hours labelled :30, with the first and last bucket clipped to the half-hour, and the tooltip says "00:00–00:30, part of a UTC hour". I found that case by running it: a naive "Today, by hour" in Kolkata failed alignment, and every widget errored.

**Follow-up: "How do time zones affect daily buckets?"** The same instant falls on different days for different orgs, so "Nov 2" is 24 rows of different UTC hours per org. A DST day has 23 or 25 hours, which is why bucket widths in a "by hour" chart vary and the axis must be time-based, not index-based. If an org changes its zone, old days stay in the old zone until they're recomputed. I'd show a banner instead of silently mixing.

**Comparisons.** Week-over-week shifts each bucket back seven days *in local time*: Monday 09:00 PST compares with Monday 09:00 PDT, 167 hours earlier rather than 168. Shifting by a fixed 168 hours would compare 09:00 with 08:00 for the week after DST changes. Month-over-month clamps Mar 31 onto Feb 28 and flags the clamped buckets. The open bucket compares with the previous period *up to the same elapsed time*. Today at 20:00 compares with last Monday until 20:00, not with all of last Monday. Otherwise every evening shows a fake 15% drop that heals at midnight. KPI tiles do the same over the whole range: "Oct 27 – Nov 2, 20:28 vs Oct 20 – Oct 26, 20:28", printed under the title so nobody has to guess.

**Late data and the watermark.** Server events arrive within seconds. Client events from a phone that was offline can arrive hours later, still bucketed by when they happened. The API returns a watermark: ingest progress minus a per-stream allowance (1 minute for server events, 10 for client events). Everything before it has almost certainly been counted. Buckets that end after it are hatched and labelled "partial", and a thin vertical line reads "complete through 20:11". The header label states the same claim for the org, and its popover lists revised days: "Nov 1: +200 late (9.9%), last at 20:18".

**Follow-up: "Events arrive late or twice. How do the charts change?"** Twice: they don't, because duplicates are dropped at ingest, and the drill-down's "rows add up to the bar" check would expose a duplicate that slipped through. Late: the bucket where the event *happened* goes up, even if that's yesterday. It gets a ↻ marker with "200 late events, revised 20:18", and the cache entry for that window is invalidated because its revision changed.

**Follow-up: "Why might yesterday's number be different today?"** Because yesterday is only *probably* complete when the watermark passes it. Late client events can land for 72 hours, after which the bucket is sealed and late events are rejected. The UI makes this visible rather than surprising: ↻ markers, revision times, and a definitions page that says it in plain words.

**Follow-up: "What freshness guarantee can the interface honestly display?"** Only what the pipeline has verified: "complete through T", where T comes from ingest progress, not from the wall clock or the last poll. It goes amber when T is more than 5 minutes past the allowance and red after an hour, or when a partition stops reporting. I keep "last refreshed 12 s ago" separate and smaller, because a dashboard can refresh every 15 seconds and still be an hour behind.

**Follow-up: "A new metric needs a backfill. What do the charts show for the period before it existed?"** Never zeros: a zero is a claim that nothing happened. The catalog carries coverage per metric. `collected_from` is when its inputs started being recorded; `available_from` is how far back its rollups have been computed. Buckets before collection are a labelled hatched gap, "not collected". Buckets that are collected but not yet backfilled show "backfill pending". The tile switches to "since Oct 20 (UTC)" and computes over the covered part only, so the rate isn't diluted by days that couldn't have abandons. When the backfill finishes, `available_from` moves back and the cached windows' revisions change, so the gap fills on the next load without anyone clearing caches.

| Approach | Yesterday changes | DST week | Before a metric existed |
|----------|------------------|----------|-------------------------|
| ✅ Event time + watermark + revisions + coverage | Visible, explained | Wall-clock aligned | Labelled gap |
| ❌ Processing-time buckets | Never, but numbers are wrong | Hour off | Zeros |
| ❌ Event time, no watermark in the UI | Silently | Hour off if shifted by 168 h | Zeros |

**What I give up.** The chart is busier (hatching, a line, markers), so the legend and "view as table" must explain each mark. I also accept that a closed day can still move for three days, a product decision I'd make explicit with the PM.

### Deep dive 3: Drill-down, role-gated metrics and privacy (~6 min)

**Decision.** The drill-down request is the chart's own resolved query plus the bucket. The server runs the same predicate against raw events and returns both numbers. Cost is left out by the server for roles without billing access. Cohorts under 5 users are suppressed before the response is built.

**Drill-down with exactly the same query.** Clicking Friday's bar puts `drill=2026-10-30T07:00Z` in the URL, so the open panel survives refresh and can be shared. The request reuses the chart's canonical query and adds the bucket. The server buckets raw events the way the rollup did: by local date for a day bar. The panel shows "Bar: 984 events · raw events: 984 in 984 conversations from 577 users ✓ rows add up to the bar." For an approximate metric such as active users it says instead "the bar is a HyperLogLog estimate; the list is exact". That explains a 1% difference before anyone files a bug. Rows are conversations with metadata only: a pseudonymous user ID, first event, model, features, message count, tokens, max TTFT, and errors. Pages of 25 load on demand, each page its own cache entry.

**Why a different query breaks it.** If the drill-down asked a separate "list conversations" endpoint with its own date logic, the first DST day or late event would make the list disagree with the bar. Once an analyst catches one disagreement they stop trusting every number. Reconciliation on screen is the cheapest trust-building feature on the page.

**Role-gated metrics.** Alice is an admin at Larkspur and an analyst at Kestrel. When she switches orgs, the cost tiles disappear because the overview response for Kestrel doesn't contain them, not because React hides them. The billing series returns 403. Drill-down and export rows have no cost column. The server cache key includes the permission scope; otherwise an analyst could be served an admin's cached response for the same query. The client uses the role only to avoid offering what will be refused, such as the cost entries in the metric picker or "Conversation list" export for support staff.

**Privacy-safe metrics.** Content never enters the pipeline, so there is nothing to leak in the UI. The event schema is strict, and a producer that adds a content field is rejected, not stored. The risk that remains is singling people out. Tiny Atelier has four users, so a breakdown "image input: 1 user" plus a drill-down would identify someone. Rows under 5 users show "hidden: fewer than 5 users". Two or more small groups pool into "other" only if their *merged* distinct users reach 5; summing them would count one person several times. A filtered series hides buckets under 5 users, and the drill-down refuses with the reason.

**Dimension rules.** A conversation is counted when it starts, before any feature is used. Filtering conversations by "code execution" would draw a confident zero. The API answers 422 with that sentence, and the tile reads "n/a with a feature filter". I found this one in the running app: the first version drew the zero.

**Follow-up: "How do you keep analytics from exposing private conversation content?"** By not having it: the contract has no content field and rejects content-like keys. The rest is metadata, pseudonymous IDs, cohort thresholds on every breakdown and drill-down, and roles enforced in the API and in the cache key.

| Approach | Bar and list agree | Cost exposure | Small cohorts |
|----------|-------------------|---------------|---------------|
| ✅ Same query + server-side gating + suppression | Checked on screen | Never sent | Hidden or pooled correctly |
| ❌ Separate list endpoint, UI hides cost | Drifts on DST and late data | In the JSON | Visible |

**What I give up.** Some legitimate questions get "hidden" answers. Analysts at tiny orgs see little detail. The drill-down costs a raw-table query, so it's paginated and never cached.

### Per-widget states

Each widget renders exactly one state: skeleton (first load), refreshing (previous data dimmed with "Updating"), empty ("Nothing matches these filters"), error (message plus Retry, others unaffected), forbidden, not applicable, or ready. "Ready" can add notes: partial, suppressed groups, coverage. A refresh that fails keeps the last good result with "Refresh failed: showing the last good result". Empty and error are never the same picture; a blank chart that might mean either is the bug that erodes trust.

### Exports

Export opens a menu: daily metrics, or a conversation list. The click mints an idempotency key, and a retried POST reuses it, so a flaky network can't create two jobs. The job runs on the server one day at a time. A progress card ("17 of 28 days written · you can keep working") polls each second, survives navigation because it lives in the app shell, and becomes a Download link. Columns are fixed from the requester's role at creation and re-checked at download.

### Rendering performance

The heaviest chart is 1,440 minute buckets, or 840 hourly buckets over 35 days. That's small enough for SVG with one hit-target rectangle per bucket, which gives accessible tooltips and simple click handling. Past about 3,000 marks, or for small multiples per org, I'd move the plot to canvas and keep an SVG overlay for hover. The API never returns more buckets than the plot is wide (max 1,500), and long ranges switch to coarser grains rather than sampling, so a spike is never dropped by downsampling. Widgets subscribe to their own query only, so a breakdown refresh doesn't re-render the trend chart.

### Accessibility

Every chart has "View as table" with the same values and states. Identity never relies on color: the legend names series, end labels repeat them, partial uses texture, deltas carry ▲▼ and text. Status in the freshness label pairs an icon with words. Chips and breakdown rows are buttons with `aria-pressed`. "Updating" is a polite status, and the export progress region is `aria-live`. The palette was checked for color-vision deficiencies, with separate dark-mode steps.

### Failure and degradation

| Failure | What the user sees |
|---------|-------------------|
| ClickHouse slow | Previous data dimmed; superseded requests aborted; per-widget timeout and Retry |
| Ingest stalled | Freshness label red "Ingest stalled"; all buckets after the frozen watermark hatched |
| Late burst | ↻ markers and revised-day list; numbers move with an explanation |
| One widget fails | That card shows an error; the rest render |
| Role changed mid-session | Next response omits cost; widgets show "Not available for your role" |
| Export worker dies | Card keeps polling; the job is re-leased and resumes |

### Two execution traces

**Success, with a late event.** (1) Alice opens the Larkspur link from a ticket. The URL holds the 7-day range, error rate and `drill=Nov 1`. (2) It resolves to Oct 27 00:00 PDT through Nov 3 00:00 PST; five widget keys and the drill key are built. (3) Responses arrive with matching echoes and paint. The Nov 2 bar is hatched; the line says "complete through 20:11". (4) A phone delivers 200 conversations from yesterday afternoon. Ingest marks them late and bumps Nov 1's revision. (5) On the next refresh the cache key for any window containing Nov 1 is new. The bar grows, gets ↻, and the popover says "+200 late at 20:18". (6) The open drill-down refetches and still reads "rows add up to the bar".

**Failure, with rapid filters and a slow warehouse.** (1) Bob, an analyst, clicks three model chips at 350 ms intervals while ClickHouse is slow. (2) The chips update at once; widgets dim and show "Updating". (3) Each settled change re-keys the widgets. In-flight requests for old keys are aborted, the browser closes the connections, and the API cancels the ClickHouse queries. (4) One response for an old key had already left the server. It's written to the old key's cache entry, which nothing observes, so it doesn't paint. (5) The final response's echo matches and paints. (6) Bob picks "Cost" from a URL someone pasted. The series returns 403 and the card says "Cost is billing data; your role (analyst) cannot see it". The rest of the dashboard is untouched.

### Design Review Checklist, from the browser's side

1. **Source of truth:** raw events on the server; the URL for what's on screen. A view is "loaded" when every widget's echo matches its key.
2. **Retry after a lost response:** reads are idempotent GETs; export creation reuses its idempotency key.
3. **Failure between steps:** an aborted or failed widget keeps its last good data, labelled; an export job is resumed by the server, and the card just keeps polling.
4. **Ordering required:** none between responses. The keyed cache makes arrival order irrelevant.
5. **Access with caches and jobs:** the server omits billing, the role scope is in the server cache key, the client cache is cleared on sign-out, and export columns are fixed at creation and re-checked at download.
6. **What breaks first:** request fan-out per filter change and the drill-down's raw-table query. Evidence: the query-duration histogram per widget and the abort rate.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Filter state | URL, parsed and resolved on render | Global store | One source; links and back button work |
| Cache key | Widget + canonical resolved query | Request sequence numbers | Stale paint impossible by construction |
| Rapid changes | 200 ms settle + abort + echo check | Per-click fetch | Fewer requests, no wrong numbers |
| Relative ranges | Intent in URL, resolved with org tz | Absolute dates in URL | Links stay "last 7 days"; key stable within a day |
| Cross-filter | Widget query minus own dimension | Filter every widget | The chart you click stays comparable |
| Comparisons | Local wall-clock shift; open bucket to date | Fixed 168 h; full previous bucket | No DST skew, no fake evening drop |
| Late data | Watermark, partial hatching, ↻ revisions | Hide it | Changes are explained, not surprising |
| Missing history | Coverage gaps | Zeros | A zero is a false claim |
| Drill-down | Same query on raw events, reconciled | Separate list endpoint | Bar and rows always agree |
| Cost | Omitted by the server | Hidden in the UI | Not in the payload at all |
| Small cohorts | Suppress < 5, pool by merged distinct | Show everything | Can't single people out |
| Exports | Background job with progress | Browser CSV | Large, resumable, survives navigation |
| Freshness | Watermark claim + separate refresh time | "Live" badge | Says only what is verified |

---

## 📈 What Breaks First, and What I'd Do Next (~2 min)

- **Request fan-out.** Eight widgets × every settled filter change × thousands of viewers. The result cache absorbs repeats; next would be a batched request for widgets sharing a window, while keeping per-widget states.
- **Polling cost.** Freshness every 15 s and live widgets every 60 s is fine at thousands of viewers. At more, a small SSE stream per org would push "watermark moved" and "day revised" events, and widgets would refetch only when their window is affected.
- **Many tabs.** Each tab polls separately. A BroadcastChannel leader tab could share freshness and the cache.
- **Drill-down depth.** Deep pagination over raw events gets slow. Keyset pagination on (first event, conversation id) and a virtualized table would replace offset paging.

**With more time:** annotations for incidents and deploys on the time axis; saved views (named URLs); a "what changed" diff that lists which buckets were revised since you last looked; and keyboard navigation across bars.

---

## 📝 Wrap-up

> "To summarize: numbers first, then pixels. Every metric has a written definition and one implementation, and the drill-down proves it by adding up to the bar. The URL holds intent, the resolved query is the key, and responses can only land where they belong, so fast clicking can't paint wrong numbers. Time is always the org's time, comparisons are aligned and to date, and late data is shown as a revision rather than hidden. Cost and small cohorts are filtered on the server, because the browser is not a security boundary. The hardest calls were refusing to show zeros for missing history or inapplicable filters, and accepting a busier chart in exchange for honesty about what is complete."

### How the local implementation compares

The repo's `frontend/` implements this design:
- TanStack Router search params hold every filter and the open drill-down. `lib/filters.ts` resolves ranges in the org's zone, and its tests assert the same canonical string as the server.
- TanStack Query keys by widget and canonical query, with abort signals, keep-previous data and a 200 ms settle. The echo check throws a `StaleResponseError`.
- The SVG trend chart draws partial hatching, the watermark line, coverage gaps, ↻ revision marks and to-date comparisons, with a table view.
- The drill-down shows the reconciliation line. Exports show live progress.

Three bugs were found by running it, and each is fixed and described above: Kolkata's "today by hour", the conversations-by-feature zero, and drill-down rows that showed only the matched event's tokens.

Gaps: no push channel (polling only), no BroadcastChannel sharing between tabs, offset pagination in the drill-down, no incident annotations, and the freshness thresholds are fixed rather than configured per org.
