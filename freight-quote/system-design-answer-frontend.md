# Freight Quote Service — System Design Answer (Frontend Focus)

*Frontend interview · 45 minutes · Requirements → Architecture → Routes and state → Client-server contract → Presenting a quote → Deep dives → Ops console → Traces*

> "Shippers ask for a rail freight price. Behind the API, four slow services decide it, and the backend answers within a second with either a *firm* quote (a commitment) or an *indicative* one (an estimate that becomes firm a few seconds later). My job on the frontend is to make that difference impossible to miss and safe to act on. Three ideas: every price shows where it came from and how old it is; the portal follows an indicative quote to its firm version by polling the quote resource, which the backend's event consumers keep current; and a submission is idempotent end to end, so a nervous double click or a dropped connection never creates a second quote. There's also an ops console, which is a different product: dense, live, and built for someone diagnosing a slow dependency."

| Phase | Time | Focus |
|-------|------|-------|
| Requirements | ~5 min | Two audiences, firm vs indicative, what a customer must never misread |
| Architecture, routes, state | ~8 min | SPA, file routes, server state vs client state, polling |
| Client-server contract | ~4 min | 201 / 202 / 200 replay / 422 / 429 / 503 and what each looks like |
| Presenting a quote | ~5 min | Badge, band, countdown, provenance rows |
| Deep dives | ~14 min | Showing uncertainty; 202 + poll vs push; idempotent submission |
| Ops console, traces, scale | ~9 min | Dependency cards, knobs, DLQ, analytics; one success, one failure |

---

## 🎯 Requirements (~5 min)

### Users

| User | Goal | What they must never get wrong |
|------|------|-------------------------------|
| Shipper in the portal | Get a price, book it | An estimate mistaken for a commitment; a duplicate quote |
| Integration developer | (No UI) reads the same contract through the API | Retry semantics, 202 handling |
| Quote platform operator | Find which dependency is slow and limit the damage | A green dashboard while customers see estimates |
| Pricing admin | Publish tariffs and surcharges | Publishing without seeing what it re-priced |

### Functional (UI)

1. Request a quote: lane, commodity, equipment (filtered by commodity), cars, ship week, optional webhook notification.
2. Show the answer at once: firm or indicative, total, per-car price, validity countdown, contract badge.
3. For indicative: the price band, what is unconfirmed and why, and an automatic switch to firm when it arrives.
4. Price components with source (live, cached, unconfirmed), basis and version, age and latency.
5. Book a firm quote; recent quotes list; quote detail with pinned inputs and an event timeline.
6. Ops: dependency health, traffic by client class, settings and fault knobs, event log, streams and DLQ, analytics.

### Non-functional

| Property | Target |
|----------|--------|
| First answer visible | < 1.2 s after submit at p99 (server deadline 900 ms plus rendering) |
| Indicative → firm visible | ≤ 1 s after the server commits it |
| Correctness | Never show a price without its kind; never enable Book on an indicative or expired quote |
| Resilience | A dropped response can be retried without creating a duplicate |
| Accessibility | Status never by color alone; keyboard-operable form, switches and tables |
| Bundle | < 150 KB gzipped; no chart library |

### Out of scope for the UI

- Booking beyond recording it (car orders, waybills), contract management, and billing.
- A mobile app: the portal is responsive enough for a tablet, and integrations use the API.
- Live push to the browser (deep dive 2 explains why polling is the better default here).

---

## 🏗️ Architecture (~4 min)

```
┌──────────────────────────── Browser (React SPA) ─────────────────────────────┐
│  routes/            components/              services/api.ts   stores/       │
│  ├ /login           portal/  QuoteForm       one fetch wrapper  auth (Zustand)│
│  ├ /     (portal)   portal/  QuoteCard       ApiError(code)                  │
│  ├ /quotes/$id      portal/  ComponentTable  submit keeps the HTTP status    │
│  ├ /ops             quote/   Timeline        lib/hooks.ts                    │
│  ├ /events          ops/     DependencyCard  usePolling(load, ms)            │
│  ├ /streams         streams/ DlqTable        useTicker (countdowns)          │
│  └ /analytics       analytics/VolumeChart                                    │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ same-origin /api/v1 (cookie session)
                ▼
        Quote API ──▶ four slow dependencies       Event consumers keep the
           │                                       quote resource current
           └── PostgreSQL (quotes + outbox) ◀──────(completer, invalidator)
```

> "It's a plain SPA with file-based routes. The interesting part isn't the framework, it's that all server state is treated as borrowed: the portal never computes or merges a price. It shows exactly what the last response said, with the labels the server attached, and re-reads the resource when something can change."

---

## 🧭 Routes and State (~4 min)

| Route | Who | Data | Refresh |
|-------|-----|------|---------|
| `/` (portal) | Customer | Reference data once; current quote; recent quotes | Current quote polled every 1 s while pending; list every 4 s |
| `/` (staff) | Ops, admin | All quotes | 3 s |
| `/quotes/$quoteId` | Owner or staff | Quote, timeline, deliveries | 2 s |
| `/ops` | Ops, admin | Merged instance stats, settings, knobs | 2 s |
| `/events` | Ops, admin | Event log page with type filters | 3 s |
| `/streams` | Ops, admin | Consumer groups, DLQ, deliveries, projection | 2 s |
| `/analytics` | Ops, admin | Projection: volume, conversion, latency | 5 s |

| State | Home | Reason |
|-------|------|--------|
| User and role | Zustand store | Shell, redirects and role-gated controls read it |
| Server data | Component state from `usePolling` | The server is authoritative; replace, don't merge |
| Idempotency key | Form state | One per logical submission; new when a field changes or after a definitive answer |
| Countdown "now" | `useTicker(1 s)` | Validity labels stay current without refetching |
| Selected knob dependency, filters | Local state | UI-only |

`usePolling` keeps the previous data while refetching (no flicker), pauses while the tab is hidden, and exposes `reload()` so an action (book, redrive, publish) refreshes immediately instead of waiting for the next tick.

---

### Component tree (portal)

```
QuotesPage (route /)
├── Portal                       (customer)
│   ├── QuoteForm                lane · commodity · equipment · cars · week · webhook · key
│   ├── QuoteCard                badge · price or ≈ + band · countdown · contract · Book
│   ├── ComponentTable           one row per component, staleness sentence under stale rows
│   └── RecentQuotes             table → /quotes/$quoteId
└── AllQuotes                    (staff) same table with customer and client class

QuoteDetailPage (route /quotes/$quoteId)
├── QuoteCard · ComponentTable
├── InputsPanel                  pinned versions, rules version, correlation id
└── Timeline                     events in stream order + causes + webhook deliveries
```

Each component stays under ~150 lines; icons live in `components/icons/` behind a barrel export; all calls go through `services/api.ts`.

## 🔌 Client-Server Contract (~4 min)

| Response | Portal behavior |
|----------|-----------------|
| `201` firm | Firm card, exact price, 24 h countdown, Book enabled. Note: "201 Created: firm quote" |
| `202` indicative | Indicative card with ≈ price and band, spinner line "confirming capacity…", start polling `Location` |
| `200` replayed | Same card as before; note explains the key was reused and no new quote was made |
| `422 IDEMPOTENCY_KEY_REUSED` | Shouldn't happen from the form (keys rotate on change); shown as a developer error |
| `422 EQUIPMENT_MISMATCH` / `UNKNOWN_LANE` | Inline error; the form prevents most cases by filtering equipment by commodity |
| `429` / `503 SHED` | "We're busy, retrying in N s" using Retry-After; the same key is reused |
| `503 PRICING_UNAVAILABLE` | "No price available right now"; no card, a retry button with the same key |
| Network error | "Submitting again reuses the same Idempotency-Key, so you won't get a duplicate quote" |

Endpoints the frontend uses:

```
POST /api/v1/quotes               body + Idempotency-Key header
GET  /api/v1/quotes/:id           poll target
GET  /api/v1/quotes/:id/events    timeline (events, causes, webhook deliveries)
POST /api/v1/quotes/:id/book      Idempotency-Key = book-<quote id>
GET  /api/v1/ops/overview · PUT /ops/settings · PUT /ops/knobs/:dep
GET  /api/v1/events · /streams · /streams/dlq · POST /streams/dlq/:id/redrive
GET  /api/v1/analytics
```

---

## 💲 Presenting a Quote (~5 min)

```
┌ Quote ───────────────────────────────────────────────────────────────────────┐
│ [Indicative] [open]                                          ≈ $177,666      │
│ MSP → PDX · 30 × covered hopper · grain · week 2026-11-30   firm expected    │
│                                                              $163,428–$183,768│
│ ⏱ Estimate valid for 15 min · answered in 603 ms · 🔒 contract CTR-PGC-2026   │
│ ◌ Confirming capacity and car supply; the firm quote follows (and webhook)   │
│ [Details & timeline]                                  [Book at this price]░  │
├ Price components and provenance ─────────────────────────────────────────────┤
│ Component        Per car  Source       Based on                   Age  Lat.  │
│ Linehaul          $4,520  cached       contract CTR-PGC-2026 v3   23s   —    │
│ Fuel surcharge      $748  cached       week of 2026-11-02         23s   —    │
│ Capacity premium    $475  cached       snapshot cap-MSPPDX-…     3 min  —    │
│                           ⚠ capacity did not answer within its budget; snapshot 3 min old (max 30) │
│ Equipment           $180  live         18 cars near origin        now  103ms │
└──────────────────────────────────────────────────────────────────────────────┘
```

- The **kind badge** is the first thing in the card and is text, not only color.
- An indicative price carries **≈** and a **band**; a firm price is a single exact number.
- The **countdown** says what the validity means ("Estimate valid for 15 min" vs "Firm price valid for 24 h") and turns red when expired.
- **Book** is disabled with a tooltip unless the quote is firm, open and unexpired. The server checks again.
- The **provenance table** is the same for both kinds. A staleness sentence appears under any row that isn't live or current, in the server's words.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Showing uncertainty instead of hiding it

**Decision.** Show the indicative quote immediately, labeled at three levels: the card (badge, ≈, band, a "confirming" line), each component row (source badge, age, a sentence about why), and the action (Book disabled until firm).

**Why it works.** A freight quote starts a conversation. A shipper comparing modes needs a number now and a commitment soon. Showing ≈ $177,666 with a $163k-$184k band in 0.6 s, then switching to a firm $177,666 two seconds later, gives them both, and the band tells them how much the unconfirmed part could move it. The provenance rows answer the next question ("why is this an estimate?") before they ask it: capacity didn't answer in time, and here's how old the number we used is.

**Why the alternatives fail.** A spinner until firm makes the portal hostage to the slowest dependency; when capacity's p99 is 8 seconds, so is ours, and people leave or click again. A single number with no label invites a customer to book an estimate and dispute the firm price later. Showing only "firm or error" throws away a perfectly useful estimate. And hiding the components behind a "details" link means nobody ever learns why some quotes are estimates.

| Approach | Time to first number | Can be misread | Explains itself |
|----------|---------------------|----------------|-----------------|
| ✅ Indicative card + band + provenance | ~0.6 s | No: badge, ≈, disabled Book | Yes, per row |
| ❌ Spinner until firm | The slowest dependency's tail | No | No |
| ❌ One unlabeled number | ~0.6 s | Yes | No |
| ❌ Error when not firm | ~0.6 s, but nothing useful | No | Barely |

**What I give up.** A busier card, two visual states to design and test, and copy that depends on the server's staleness sentences (so they're written as customer-facing text, not log lines).

### Deep dive 2: Following indicative → firm: 202 and polling vs push

**Decision.** On `202`, poll `GET /quotes/:id` every second while the quote is indicative and `firmStatus` is pending; stop when it's firm or delayed. The backend's event consumers (the firm completer and the tariff invalidator) update the quote row; the poll reads it.

**Why it works.** The resource is the source of truth, so the poll can't miss an update or apply two out of order. Whatever happened between polls (firm completion, re-pricing by a new tariff, a delay), the next response is the whole current state, and the card just re-renders it. Pending usually lasts one to three seconds, so it's a handful of cheap indexed reads per quote. It works through every proxy and survives API restarts and laptop sleeps with no reconnection logic.

**Why push fails here.** Server-sent events or WebSockets mean an event path from the consumers to whichever API instance holds the browser's connection: a pub/sub fan-out, sticky connections, authentication on a long-lived channel, and a resume protocol so a reconnect doesn't miss the one event that mattered. And the browser would be applying *deltas* to local state, which is exactly where a re-pricing and a firm completion arriving in the wrong order produces a wrong number on screen. For one state change per quote within seconds, that buys about half a second.

**The event-driven part the UI does show.** The quote detail page renders the quote's event stream from the log: requested, issued (v2, with provenance), re-priced (caused by `TariffPublished` v8), firm completed (attempt 6 after a DLQ redrive), webhook delivered. It's read like any resource, in `stream_version` order, with causation links. That's the dispute view, and it costs one query.

| Option | Latency | Missed or reordered updates | New infrastructure |
|--------|---------|------------------------------|-------------------|
| ✅ Poll the resource (1 s) | ≤ 1 s | Impossible | None |
| ❌ SSE with deltas | ~100 ms | Possible across reconnects | Pub/sub fan-out, resume tokens |
| ❌ WebSocket | ~100 ms | Possible | Same, plus a socket gateway |

**What I give up.** Up to a second of latency and some idle requests. If a page ever showed dozens of pending quotes, I'd batch them into one poll; for a live ops wall I'd consider push, because there the data changes continuously.

### Deep dive 3: Idempotent submission from the browser

**Decision.** The form owns an idempotency key per logical submission. It's created with the form state, regenerated when any field changes or after a definitive answer, and reused for any retry of the same submission (network error, 429, 503). The key is sent in a header and shown in small type under the button. No optimistic price is ever shown.

**Why it works.** The server stores quotes under `(customer, key)`: a retry with the same key returns the quote it already made, in its current state. So the user can hit the button again after a timeout without fear, and if the first request did succeed, they get that quote (perhaps firm by now) instead of a second one. Booking uses a key derived from the quote id, so double-clicking Book is harmless.

**Why the alternatives fail.** Disabling the button while a request is in flight stops double clicks but not the real case: the response was lost, the button re-enables, and the second click creates a second quote with a different price (capacity moved). A new key per click makes every retry a new quote. Client-side deduplication can't know whether the server received the first request. Optimistic UI is wrong for prices: a number the server hasn't computed is a guess someone might act on.

**What I give up.** The form has to be careful about when a key is "used up" (after a definitive answer) versus reusable (after an error). If the user edits a field and resubmits, that's a new key on purpose: different inputs are a different quote, and the server would reject the old key with a different body anyway.

---

## 🛠️ The Ops Console (~5 min)

- **Dependency cards** (one per dependency): p50, p95 and p99 against the budget (red when over), breaker badge, calls split into ok / failed / short-circuited, cache hit rate for versioned components, hedges fired / won / skipped for the hedged one, coalesced calls, and server-side queue, abandoned and wasted work from the mock dependency.
```
┌ Network capacity ──────────────────────────────── [circuit closed] ┐
│ budget 600 ms · perishable: live, snapshot fallback · hedged      │
│   p50 129 ms        p95 211 ms        p99 290 ms                  │
│ Calls (ok / failed / short-circuited)        130 (128 / 2 / 0)    │
│ Hedges fired / won / skipped (budget)        15 / 6 / 0           │
│ Coalesced into an in-flight call             0                    │
│ Server: in flight / queued (max)             4 / 0 (9)            │
│ Server: abandoned at deadline / wasted       7 / 4                │
│ knobs: 120 ms median, 5% tail at 8000 ms, 32 workers              │
└───────────────────────────────────────────────────────────────────┘
```

The last two rows are the server's view from the mock dependency: "abandoned" is work stopped at a propagated deadline; "wasted" is work finished for a caller that had already gone (a cancelled hedge loser). Seeing both on one card is how an operator learns that cancellation needs to reach the dependency, not just the client.

- **Traffic by client class**: firm, indicative, unavailable, replayed, shed and 429, with p50 and p99; the admission threshold per class next to it.
- **Settings and knobs**: switches for hedging, coalescing, deadline propagation, shedding and rate limits; a deadline select; per-dependency presets ("p99 → 8 s", "slow 2.5 s", "50% errors", "down") and numeric fields. Pricing actions (publish tariff, set fuel surcharge) are enabled for admins only.
- **Streams & DLQ**: consumer groups with lag per partition and pending, outbox backlog, DLQ rows with reason and deliveries and Redrive / Discard buttons, "inject poison" for practice, webhook deliveries next to what the customer's receiver actually kept (once, received N times), and the projection panel with "Verify replay = live".
- **Analytics**: stat tiles (requested, firm, booked, conversion, expired, re-priced); a stacked bar chart of requests per hour by client class (three categorical colors in a fixed order, 2 px gaps between segments, rounded tops, a legend plus hover tooltips, and a totals row as the table view); a latency table per dependency with the component source mix.

> "The ops page answers 'which dependency, how bad, and is the protection working?' in one screen. If the indicative share is 40% and capacity's p99 is red with the breaker open, the story is told. The knobs are there so you can practice causing it."

---

## 🧪 Form, Loading and Empty States (~2 min)

| Situation | What the user sees |
|-----------|--------------------|
| Commodity changes | Equipment options filter to what that commodity moves in; an invalid pairing can't be submitted |
| First load | A neutral placeholder card: "Choose a lane and request a quote" |
| Waiting for the first answer | Button reads "Quoting…" and is disabled; the server answers within its deadline, so this never lasts more than about a second |
| Poll error while pending | Keep the last card and retry on the next tick; the server state is unchanged by a failed read |
| Quote expired while open | Countdown turns red, Book disables, a "request again" hint appears |
| Ops page loses the API | Last data stays visible with an error banner; nothing pretends to be live |

### Testing

- **Playwright smoke tests** per page (`tests/smoke.spec.ts`): log in, load, find the main table or card, no error boundary.
- **Behavior worth a component test**: the idempotency key rotates when a field changes and survives a network error; polling stops on firm or delayed; Book is disabled for indicative and expired quotes.
- **Contract checks against the API**: a 202 response always carries `Location`, and an indicative quote always has a band and at least one non-live component.

## ♿ Accessibility and Performance (~2 min)

| Concern | Approach |
|---------|----------|
| Status by color | Every badge has text (Firm, Indicative, circuit open, live / cached / unconfirmed) |
| Switches | `role="switch"` with `aria-checked` and labels |
| Tables | Real tables with headers; `aria-label` on each for tests and screen readers |
| Live changes | The card re-renders in place; the kind badge text changes, so a screen reader announces it with a polite live region |
| Bundle | React, TanStack Router and Zustand; hand-written SVG chart; ~116 KB gzipped |
| Polling cost | Paused when the tab is hidden; replaced, not merged, so renders are cheap |

---

## 📜 Execution Traces (~4 min)

### Successful trace

1. Pat picks Minneapolis → Portland, wheat, 30 cars, week of Nov 30, webhook on. The form holds key `portal-0333…`.
2. Submit: `202` in 603 ms. The card shows Indicative, ≈ $177,666, band $163k-$184k, a capacity row "snapshot 3 min old". Polling starts.
3. Two seconds later the poll returns `kind: firm`: the badge flips, the ≈ and band disappear, the countdown reads 24 h, the capacity row turns live (2.4 s latency), Book enables.
4. Pat opens Details: pinned inputs (contract v3, fuel week, snapshot ids, rules version) and a timeline ending with "Webhook delivered, 3 attempts".

### Failed trace

1. Nina submits; the response is lost (Wi-Fi drops). The page says submitting again is safe; she clicks again with the same key.
2. The server had made the quote: `200` replayed, indicative, capacity "not confirmed (circuit open)". The note explains no new quote was made.
3. A tariff is published; the next poll shows revision 2 and a new total; the timeline shows "re-priced, caused by TariffPublished v8".
4. Completion fails five times; the poll returns `firmStatus: delayed`; polling stops and the card says the firm quote is delayed and operations has been alerted. After ops redrives, reopening the quote shows it firm at the new tariff.

---

## ✅ Design Review Checklist

| Question | Answer (frontend view) |
|----------|------------------------|
| Source of truth? | The quote resource; the UI never computes or merges prices |
| Client retries after a lost response? | The same idempotency key; the server returns the existing quote |
| Worker fails between steps? | Invisible to the UI except as a later firm; "delayed" after the retry budget |
| Ordering? | Not needed: each poll returns the whole state; the timeline reads `stream_version` order |
| Access with caches and async jobs? | A customer only ever sees its own quotes (404 otherwise); role-gated ops controls are also checked server-side |
| What breaks first? | Server side, the capacity service; client side, many pending quotes polling at once (batch them) |

---

## ❓ Follow-ups

- **Capacity's p99 is 8 s: what does the customer see?** Within about 0.6 s an indicative card with the capacity row explaining it; a firm card seconds later. No spinner tied to the slow service.
- **How stale may a price be?** Published prices: never stale (current version). Snapshots: up to 30 minutes, only in estimates, always with their age in the row.
- **A re-quoting integration?** Not a UI concern, but the ops page shows its re-quotes shed first and its 429s in the class table.
- **Booking after a tariff change?** The firm quote is honored; the booking confirmation shows the honored total. If expired, the UI explains and offers a new quote.
- **A dispute?** The detail page shows the pinned inputs and the full timeline from the log.

---

## 📈 Scaling the Frontend

| Pressure | Response |
|----------|----------|
| Many pending quotes on one page | One batched poll (`?ids=`) instead of one per quote |
| Large event log | Cursor pagination by position (`before=`), type filters |
| Ops wall left open all day | Pause when hidden; consider SSE for this read-only, continuously changing view |
| Many customers | Static assets on a CDN; the API is the only dynamic origin |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Slow answer | Labeled indicative card | Spinner until firm | Bounded wait, honest label |
| Async result | Poll the resource | SSE/WebSocket deltas | No missed or misordered updates |
| Retry safety | Idempotency key per submission | Disable the button | Covers lost responses, not just double clicks |
| Prices | Server-computed only | Optimistic UI | Nobody acts on a guess |
| State | Zustand for auth, component state for server data | A global cache library | Small app, replace-not-merge semantics |
| Charts | Hand-written SVG | Chart library | Small bundle, full control of labeling |
| Ops data | Poll every 2 s | Push | Simple; fine for a handful of operators |

---

## 📝 Wrap-up

> "The portal's job is to make the backend's honesty visible: a firm quote looks like a commitment, an indicative one looks like an estimate, and every number says where it came from. Following an estimate to its firm version is a poll of the resource the event consumers keep current, so nothing is missed or misordered. And a submission is idempotent from the button to the database, so retrying is always safe."

The repo implements this with React 19, TanStack Router, Zustand and Tailwind (portal, quote detail with timeline, ops console, event log, streams and DLQ, analytics), on an Express backend with PostgreSQL and Valkey Streams. Screenshots in `screenshots/` show each page.
