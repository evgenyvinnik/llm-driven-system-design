# Web Crawler - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 📋 Introduction (2 minutes)

"Today I'll design the operator dashboard for a distributed web crawler. The crawler itself is a backend system, but the people running it depend on the dashboard to answer three questions quickly: *Is it crawling? Is it crawling the right things? Is it being polite?*

The frontend challenges are less about flashy UI and more about honest data presentation:

1. **A firehose that can't be rendered** — the backend completes ~10,000 pages a second; the UI has to turn that into something a human can read
2. **Tables over data that mutates underneath you** — the frontier holds millions of URLs whose status changes while you scroll
3. **Admin controls with real-world consequences** — a slider that changes how hard we hit someone's server, a button that deletes the crawl queue
4. **Telling 'stalled' from 'idle'** — the dashboard must not look calm when the crawl is dead

Let me clarify the requirements."

---

## 🎯 Requirements Clarification (4 minutes)

### Functional Requirements

1. **Overview** — crawl rate, frontier counts by status, active workers, recent pages, top domains
2. **Frontier browser** — filter URLs by status; see priority, depth, retry count, last error
3. **Crawled pages** — search by URL/title/domain, page through results
4. **Domain management** — view robots.txt, adjust crawl delay, block a domain
5. **Admin** — add seed URLs, force stale-lease recovery, clear the frontier, reset counters

### Non-Functional Requirements

| Requirement | Target | Implication |
|-------------|--------|-------------|
| Freshness | Overview ≤ 5s stale | Snapshot polling is enough; must show data age |
| Scale of data | Millions of frontier rows | Server-side filtering + cursor pagination + virtualization |
| Audience | A handful of operators, sometimes on a tablet during an incident | Responsive layout; correctness over animation |
| Safety | No accidental destructive actions | Typed confirmation; mutations behind auth |
| Resilience | Backend restart must not break the page | Explicit stale/error states; automatic recovery |

### The Number That Shapes the UI

"10K pages/second is 600,000 events a minute. Even if the browser could render them, a human can read maybe two rows a second. So the first design decision is made before any component exists: **the server aggregates; the client displays aggregates plus a small sample.** Every view is either a counter, a rate, a top-N, or a paginated query — never a raw event stream."

---

## 🏗️ High-Level Design (6 minutes)

### Application Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         React SPA (Vite)                         │
│  ┌────────────┐ ┌───────────┐ ┌─────────┐ ┌─────────┐ ┌───────┐  │
│  │ Dashboard  │ │ Frontier  │ │  Pages  │ │ Domains │ │ Admin │  │
│  │     /      │ │ /frontier │ │ /pages  │ │/domains │ │/admin │  │
│  └─────┬──────┘ └─────┬─────┘ └────┬────┘ └────┬────┘ └───┬───┘  │
│        │              │            │           │          │      │
│  ┌─────▼──────────────▼────────────▼───────────▼──────────▼───┐  │
│  │  Zustand store: stats snapshot, fetchedAt, error, polling  │  │
│  └─────────────────────────────┬──────────────────────────────┘  │
│  ┌─────────────────────────────▼──────────────────────────────┐  │
│  │  services/api.ts — one typed client, all endpoints         │  │
│  └─────────────────────────────┬──────────────────────────────┘  │
└────────────────────────────────┼─────────────────────────────────┘
                                 │ REST / JSON DTOs
                                 ▼
              API server  ── Postgres (truth) + Redis (counters)
```

### Overview Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  Crawler            Dashboard  Frontier  Pages  Domains  Admin   │
│                                         ● Live · updated 3s ago  │
├────────────┬────────────┬────────────┬────────────┬──────────────┤
│ Crawled    │ Failed     │ Pending    │ In progress│ Workers      │
│ 1.2M       │ 4,310      │ 2.5M       │ 12         │ 3 of 3 ●     │
├────────────┴────────────┴──────┬─────┴────────────┴──────────────┤
│  Throughput (pages/s, 1h)      │  Worker heartbeats              │
│  ▁▂▃▅▆▇▇▆▇▇▆▅▆▇▇               │  w1 ● 2s   w2 ● 3s   w3 ● 41s ⚠  │
├────────────────────────────────┴────┬────────────────────────────┤
│  Recently crawled (last 20)          │  Top domains               │
│  200  example.com/a     120ms        │  example.com    48,120     │
│  301  blog.io/old       35ms         │  blog.io        12,904     │
└──────────────────────────────────────────────────────────────────┘
```

"Frontier counts are broken out by status on purpose — I'll come back to why in the operations section. The freshness indicator in the header is part of the data, not decoration."

---

## 🔧 Deep Dive 1: Getting Live Data to the Screen (10 minutes)

### What the data actually is

"Before choosing a transport, I want to characterize the data, because the reflex answer — 'it's real-time, use WebSockets' — skips this step:

- **It's a snapshot, not an event stream.** The overview renders counters and a top-N list. Missing an intermediate value loses nothing; only the latest sample matters.
- **It changes continuously.** At 10K pages/s, every counter changes every millisecond. 'Push only when data changes' degenerates into 'push constantly'.
- **The audience is tiny.** One to a handful of operators.
- **Nothing flows client → server on the live channel.** Every mutation is a discrete REST action."

### Transport options

| Approach | Fit for this data |
|----------|-------------------|
| ✅ Polling a snapshot endpoint every 5s | Matches snapshot semantics exactly; stateless; survives backend restarts with zero reconnection code |
| ✅ SSE (the upgrade path) | One-way server→client over plain HTTP; browser reconnects automatically; cookies and proxies just work |
| ❌ WebSocket | Bidirectional capability nobody uses; needs heartbeats, manual reconnect with backoff, and sticky or fanned-out connections across API instances |

**Decision: poll every 5 seconds, move to SSE if the audience grows.**

"Polling at 5s gives at most 5s of staleness — close to how fast a human can usefully react to a counter. The cost is one request per open tab per interval whether or not anything changed, which at operator scale is noise. Where it breaks is a customer-facing dashboard with thousands of viewers all requesting the same global aggregate: the load scales linearly with viewers and is almost entirely redundant. That's when I'd switch, and the switch is SSE: one server-side sampler computes the snapshot per tick and fans it out. WebSocket would add connection-lifecycle work for traffic that only ever flows one way."

### Polling done properly

"Naive polling has four bugs I'd design out up front:

1. **Overlapping requests.** A setInterval keeps firing while a slow request is in flight; responses can arrive out of order and an old snapshot overwrites a newer one. Fix: schedule the next poll *after* the current one settles, and tag responses so a stale one is discarded.
2. **Background tabs.** An operator with six dashboard tabs open generates six times the load. Fix: pause polling when the Page Visibility API reports the tab hidden; poll immediately on return.
3. **Error storms.** When the backend is down, polling every 5s forever produces a wall of failures. Fix: exponential backoff on consecutive errors (5s → 10s → 20s, capped at 60s), reset on the first success.
4. **Silent staleness.** If polling fails, the last numbers stay on screen and look perfectly healthy. Fix: store `fetchedAt` with every snapshot and render data age; past 3 intervals the header flips from '● Live' to '⚠ Stale · 47s' and the cards dim."

> "The 'Live' badge is a claim about the data. It should only be green when the data is actually recent."

### Rates and the throughput chart

"Counters like 'pages crawled' are cumulative. Showing a rate means differencing two samples — and two subtleties appear. A counter reset (operator clicks Reset Stats) makes the difference negative, which must be treated as a restart, not a negative rate. And with 5s samples, a one-hour chart is 720 points: fine for a small SVG line chart; there's no need for a heavyweight charting library or canvas at that size. For longer windows the server should return pre-bucketed time series rather than the client accumulating samples, because client-side history disappears on refresh."

### State management

| Approach | Fit |
|----------|-----|
| ✅ Zustand store for the polled snapshot | One global snapshot, selector subscriptions so a card re-renders only when its value changes, tiny API |
| ✅ TanStack Query (strong alternative) | Built-in polling, dedup, background refetch, stale-time — most of the 'polling done properly' list for free |
| ❌ React Context | Every consumer re-renders on every 5s snapshot |
| ❌ Redux Toolkit | Works, but ceremony without benefit for one snapshot and a few lists |

"Honestly, for a REST-polling dashboard TanStack Query is the better fit — it encodes the visibility pause, request dedup, and stale-time semantics that I'd otherwise hand-write. I'd still keep Zustand for genuinely client-side state like table filters and the 'paused' toggle. If the codebase already standardizes on Zustand, the hand-written version is about forty lines, and the four bugs above are the checklist."

---

## 🔧 Deep Dive 2: The Frontier Table (10 minutes)

### Why 'virtualize a million rows' is the wrong first answer

"The frontier can hold millions of URLs. The reflex is to load them into a virtualized list with infinite scroll. Three problems make that the wrong *first* answer:

1. **No one scrolls a million rows.** An operator looks for something specific: failed URLs on one domain, the oldest pending items, URLs stuck retrying. The primary UI is **filters** (status, domain, priority, has-error), and the result set is usually small.
2. **Offset pagination over a mutating set is wrong.** While you scroll, URLs move from pending to completed. With LIMIT/OFFSET, rows shift between pages: you see some twice and some never. And OFFSET 500000 makes the database walk half a million rows to throw them away.
3. **Browsers cap element height.** Chromium limits an element to roughly 33 million pixels; a million 48px rows is 48 million pixels. A naive virtualizer's spacer element silently clips, and the scrollbar lies."

### What I'd build instead

| Concern | Approach |
|---------|----------|
| Finding things | Server-side filters in the URL query string, so a filtered view is shareable and survives refresh |
| Paging | **Keyset (cursor) pagination** — 'next 100 after (updated_at, id)' — stable under inserts and O(log n) at any depth |
| Rendering | `@tanstack/react-virtual` over the *loaded* pages, ~48px rows, overscan ~10 |
| Large totals | Show '2.5M pending' as a count; don't promise a scrollbar for all of them |
| Live changes | Freeze the visible set; show a '37 updated — refresh' pill instead of reflowing rows under the cursor |
| Search box | Debounce 300ms; cancel the in-flight request when a newer one starts (AbortController) |

"The live-changes rule deserves a sentence. If rows re-sort while an operator is about to click one, they click the wrong URL. Gmail and GitHub solve this the same way: hold the snapshot steady and offer the update as an explicit action."

### Columns and what they're for

| Column | Why it's there |
|--------|----------------|
| Status badge + 'retry N' | Distinguishes 'waiting its turn' from 'failed three times against a dying host' |
| Last error (tooltip) | 'robots.txt unavailable' vs 'HTTP 503' vs 'timeout' points at different fixes |
| Priority, depth | Explains *why* something hasn't been crawled yet |
| Domain (link) | One click to the domain's settings and robots.txt |
| Next eligible time | A retrying URL is pending but not crawlable until its backoff expires |

"Retry count and last error are the columns I'd fight for. Without them, 'pending' is ambiguous, and the operator has to open server logs to learn what the database already knows."

---

## 🔧 Deep Dive 3: Admin Controls With Real Consequences (8 minutes)

### Domain crawl delay: the slider that touches someone else's server

```
┌────────────────────────────────────────────────────────────────┐
│  example.com                                        [ Block ]  │
│  48,120 pages · robots.txt fetched 2h ago                      │
├────────────────────────────────────────────────────────────────┤
│  Crawl delay                                                   │
│  robots.txt asks: 2s  ·  your override: 5s  ·  effective: 5s   │
│  2s ●━━━━━━━━━━━━━━━━━━○──────────────────────────────── 60s   │
│  Overrides can only slow crawling, never go below robots.txt   │
├────────────────────────────────────────────────────────────────┤
│  robots.txt                                       [ Refresh ]  │
│  User-agent: *                                                 │
│  Disallow: /private/                  ← highlighted red        │
│  Crawl-delay: 2                       ← highlighted amber      │
└────────────────────────────────────────────────────────────────┘
```

"Three design choices here:

1. **The slider's floor is the robots.txt delay, and the backend enforces it too.** Workers compute effective delay as max(override, robots delay). The UI shows all three numbers — what the site asked for, what the operator set, what's in force — so nobody has to guess which one wins. The client-side floor is for usability; the server-side max is the actual guarantee, because a UI constraint is not a security boundary.
2. **Confirmed, not optimistic.** I'd show a saving state and update only on success. Optimistic UI is great for likes and drafts; for a control that changes load on a third party's server, showing 'saved' before the server agrees is the wrong trade.
3. **Explain propagation.** After saving: 'Applied — takes effect on the next request to this host.' The backend writes the setting to Postgres and publishes it to Redis; if the second step fails, the API returns an error and re-submitting applies it. The UI should never claim more than the server confirmed."

### Destructive actions

| Action | Risk | Guard |
|--------|------|-------|
| Clear frontier | Deletes the entire crawl queue | Type the word CLEAR to confirm; show the count that will be deleted |
| Reset stats | Loses counters (not data) | Simple confirm dialog |
| Block domain | Stops crawling a site | One click, easily reversible; show 'blocked' badge prominently |
| Recover stale URLs | Safe, idempotent | No confirmation; show how many were recovered |

"Friction proportional to irreversibility. A modal on every button trains people to click through modals; typed confirmation is reserved for the one action that can't be undone. And every mutating endpoint sits behind admin auth on the server — the client hiding a button is not access control."

### Seeding

"The seed form accepts a pasted list, one URL per line. The client trims, drops blanks, validates with the URL constructor, and shows invalid lines inline *before* submitting. The response reports 'added 37 of 50' — the other 13 were duplicates or filtered — so the operator isn't left wondering why the frontier didn't grow by 50."

---

## 🔧 Deep Dive 4: Telling Stalled From Idle (4 minutes)

"The most dangerous dashboard state is one that looks calm while nothing works. Three patterns, all readable from data the API already returns:

| Pattern | Meaning | UI treatment |
|---------|---------|--------------|
| Pending high, in-progress 0, crawl rate 0 | Workers are dead, or every host is politeness-locked | Red banner: 'Frontier has work but nothing is crawling' |
| In-progress stuck, completed flat | Workers hung mid-fetch | Amber banner; link to 'Recover stale URLs' |
| Pending 0, in-progress 0 | Crawl finished | Neutral 'Idle — add seeds to continue' |

### Worker heartbeats and clock skew

"Each worker writes a heartbeat timestamp. The tempting client computation is `Date.now() - lastHeartbeat`, but that mixes the browser's clock with the worker's — a laptop 40 seconds fast makes every worker look stale. The robust version has the API compute `heartbeatAgeMs` with server time and send the age, not the timestamp. Thresholds: green under 15s, amber to 60s, red beyond — and a worker that disappears from the active set still shows as 'last seen 3m ago' rather than vanishing, because a silently shrinking worker count is exactly the failure that's easy to miss."

---

## 🧭 The URL Is Part of the State (2 minutes)

"During an incident, operators share links: 'look at this'. So every view that answers a question should be addressable:

| View state | Where it lives | Why |
|------------|----------------|-----|
| Frontier filters (status, domain, has-error) | Route search params | Shareable, survives refresh, back button works |
| Pagination cursor | Search param | A shared link opens the same slice |
| Selected domain | Path segment (/domains/:domain) | Alerts can deep-link straight to the domain page |
| Polling paused, column widths | Client store / localStorage | Personal preference, not part of the question |

With TanStack Router, search params are typed and validated at the route, so a hand-edited link with `status=bogus` falls back to a default instead of sending a garbage query to the API. The rule of thumb: if two operators looking at the same link should see the same thing, it belongs in the URL; if it's how *I* like to see it, it belongs in local state."

---

## 🔌 The API Contract Is a Frontend Concern (3 minutes)

"This system shipped a bug worth retelling from the frontend side. The Crawled Pages table rendered `undefined B`, a bare `ms`, and `Invalid Date` in every row. The frontend's `CrawledPage` type declared camelCase fields; the backend handler returned raw Postgres rows in snake_case. **Both sides compiled cleanly** — neither imports the other's type, and the fetch wrapper's generic cast told TypeScript the JSON was a `CrawledPage` without checking.

What I take from it as the frontend owner:

| Defense | What it catches |
|---------|-----------------|
| Backend maps rows to DTOs explicitly | Casing drift and accidental column leaks at the source |
| Shared or generated types | Both sides agreeing on one declaration |
| Runtime validation of responses in dev (a schema parse in the API client) | The case where the server returns something other than what the type claims |
| Formatters that refuse undefined | 'undefined B' becomes '—' plus a console warning instead of plausible-looking garbage |

The generic `fetchApi<T>` is the weak point: it's a cast, not a check. Validating responses in development — and logging, not crashing, in production — turns a silent rendering bug into a loud one on the first page load."

---

## ⏳ Loading, Empty, and Error States (2 minutes)

| State | Treatment |
|-------|-----------|
| First load | Skeleton cards with fixed dimensions, so nothing jumps when numbers arrive |
| Refresh in progress | Keep showing the last snapshot; a subtle spinner in the header — never blank the page every 5 seconds |
| Backend unreachable | Keep last data, mark it stale with its age, show 'Reconnecting… next try in 20s' |
| Empty frontier | Not an error: 'No URLs queued — add seed URLs' with a link to Admin |
| Mutation failed | Inline error next to the control that failed, with the server's message; never a silent revert |

"The principle is that a dashboard during an incident is the moment it's most needed, so failure states get as much design as the happy path."

---

## ⚡ Performance Budget (2 minutes)

- **Bundle:** five routes, code-split per route; the dashboard route loads first and stays under ~150 KB gzipped
- **Re-render scope:** each stat card subscribes to its own selector, so a 5s snapshot that changes only 'pages crawled' re-renders one card, not the page
- **Tables:** virtualized rows, memoized row components keyed by URL hash, no inline object props that defeat memoization
- **Network:** one snapshot request per 5s per visible tab; table queries only on filter change or explicit refresh
- **Number formatting:** compact display (1.2M, 48.1K) via a single cached `Intl.NumberFormat` instance rather than one per render

---

## ❓ Likely Follow-ups

**"Ten thousand operators instead of ten — what changes?"** — Polling load scales linearly and is redundant, so move the overview to SSE with a single server-side sampler, and put the snapshot endpoint behind a short CDN cache as a fallback for clients that can't hold a stream.

**"An operator wants to see every URL as it's crawled."** — Offer a sampled live tail: the server keeps a ring buffer of the last ~200 completions and the client shows them in a fixed-height list that pauses on hover. A true firehose isn't readable, so the honest product is a representative sample with the aggregate rate beside it.

**"How do you test this?"** — Component tests for formatters and the stale/live logic with fake timers; a mocked API to drive each banner state; and smoke tests that load every route against a seeded backend, which is what catches contract drift like the snake_case bug.

---

## ♿ Responsive and Accessible (2 minutes)

- **Tablet first-class.** Stat cards reflow from five columns to two; tables keep URL and status and move the rest into an expandable row
- **Status is never color alone.** Badges carry text ('failed', 'retry 2'); heartbeat dots have labels for screen readers
- **Polite live region** for the stale/live state change only — announcing every 5-second counter update would make a screen reader unusable
- **Keyboard path** through the table (row focus, Enter opens domain) and focus returned to the trigger after a dialog closes

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Live updates | 5s snapshot polling | WebSocket | Snapshot data, few viewers, nothing flows upstream |
| Upgrade path | SSE | WebSocket | One-way traffic over plain HTTP with automatic reconnect |
| Polling hygiene | Settle-then-schedule, visibility pause, backoff, data age | Plain setInterval | Prevents out-of-order overwrites, wasted load, and silent staleness |
| Server state | Zustand snapshot (TanStack Query a strong alternative) | Context / Redux | Selector re-renders without ceremony |
| Frontier table | Filters + keyset pagination + virtualization | Virtualized infinite scroll over offsets | Stable under mutation, fast at depth, avoids browser height caps |
| Live table changes | Freeze + 'N updated' pill | Auto-reflow | Rows must not move under the cursor |
| Crawl-delay control | Confirmed update, floor = robots.txt | Optimistic slider | Affects third-party servers; server enforces max() regardless |
| Destructive actions | Typed confirmation for irreversible only | Modal on everything | Friction proportional to irreversibility |
| Heartbeat age | Computed server-side | Client clock math | Immune to browser clock skew |

### The Trade-off Underneath All of These

"Almost every row above trades a little immediacy for trustworthiness: 5-second snapshots instead of a stream, a frozen table instead of live reflow, a confirmed save instead of an optimistic one. For a consumer feed I'd often choose the other side. For an operations tool, an operator acting on a number that was wrong — or already stale — is worse than an operator waiting a few seconds for one that's right."

---

## 🚀 Future Enhancements

1. **SSE stats stream** with a server-side sampler if the dashboard gains many viewers
2. **Server-bucketed time series** for 24h/7d throughput charts that survive refresh
3. **Per-domain health view** — error rate, robots.txt status, circuit state — for the long tail of hosts
4. **Saved filters** for recurring investigations ('failed in the last hour, grouped by domain')
5. **Audit log** of admin actions: who cleared the frontier, who slowed which domain

---

## 📝 Summary

"The dashboard's job is to make the crawler's state legible, and most of the design follows from the volume mismatch: the backend produces 10K events a second and a human reads two. So the server aggregates and the client presents snapshots, polled every five seconds with the hygiene that makes polling trustworthy — no overlapping requests, no background-tab load, backoff on failure, and a freshness indicator that turns amber when the data is old.

The frontier table is built around finding things rather than scrolling everything: filters first, keyset pagination that stays correct while rows change status, virtualization for what's loaded, and the retry count and last error that turn 'pending' into a diagnosis. And the admin controls are treated as what they are — levers on other people's servers — so the crawl-delay slider can only slow things down, updates are confirmed rather than optimistic, and friction scales with how irreversible an action is."
