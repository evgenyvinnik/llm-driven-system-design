# ⏰ Distributed Job Scheduler — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A scheduler's UI is an operations console for things that happen somewhere else: on a schedule, on a worker, minutes after anyone clicked anything. So the frontend has two jobs. It must show the truth about state that changes without the user (a run going from running to failed to retrying), including how fresh that truth is. And it must make the dangerous buttons safe under stress: 'Trigger now', 'Cancel' and 'Retry all' get pressed during incidents, on bad networks, by tired people."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Who uses it, for what, and the targets |
| A — Architecture | 8 min | Component tree, who owns which state, the data layer |
| D — Data model | 5 min | Jobs, runs, attempts, and how updates are ordered |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 20 min | Live status, schedule editing, safe actions, big lists |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses this first. It's an internal console used by engineers and on-call operators, mostly on desktop, sometimes from a phone during an incident."

### Functional requirements

1. **Jobs list**: search and filter by status, handler and team; sort by next run; teams have up to ~10,000 jobs.
2. **Job detail**: definition, the next five runs, attempt history grouped by run, and logs for each attempt.
3. **Create and edit**: handler, payload, priority, retry policy, timeout, and a schedule (cron with a builder, one-time, or on demand), with a preview of upcoming runs and the job's time zone.
4. **Operate**: pause/resume, trigger now, cancel a running attempt, retry a failed one.
5. **Dead-letter triage**: see runs that exhausted their retries, filter by error, redrive one or many.
6. **Fleet health**: workers, queue depth, oldest waiting run.

Out of scope: a workflow (DAG) editor and a native mobile app.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.0 s on a laptop over office Wi-Fi; < 3 s on 4G | Opened from alert links during incidents |
| INP | < 200 ms, including typing in search over 10K jobs | The list is the main working surface |
| Status freshness | Run status on screen < 2 s after the worker records it | "Is it running yet?" is the most common question |
| JavaScript | < 200 KB gzipped initial; log viewer, cron builder and charts lazy-loaded | Most visits are list → detail |
| Accessibility | WCAG 2.2 AA; status never conveyed by color alone; status changes announced | Status badges are the whole product |
| Resilience | Keep working when the live stream drops; never show a stale state as current | Incidents are when networks are worst |

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated console with no SEO needs, so I'd build a client-rendered SPA with route-level code splitting. Server rendering would speed up first paint for pages nobody crawls, at the price of a rendering tier. I keep the SPA's cold start in check with a small shell and hashed, immutable assets."

```
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · TanStack Router · auth guard · Zustand: session, UI prefs                  │
 │ URL state: /jobs?status&q&cursor · /jobs/$jobId?tab · /dead-letter                     │
 └─────────┬──────────────────────┬──────────────────────┬──────────────────────┬─────────┘
           │                      │                      │                      │
           ▼                      ▼                      ▼                      ▼
 ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
 │ /jobs             │  │ /jobs/$jobId      │  │ /dead-letter      │  │ /workers          │
 │ JobTable          │  │ RunsList          │  │ DLQTable          │  │ WorkerGrid        │
 │ JobForm           │  │ LogViewer         │  │ BulkRedrive       │  │ lease health      │
 └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
           │ (1) create           │ (2) live runs        │ (3) redrive          │ poll 10 s
           ▼                      ▼                      ▼                      ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ TanStack Query cache: ['jobs', filters] · ['job', id] · ['runs', jobId] · ['dlq']      │
 └──────────────────┬─────────────────────────────────────────────────────────────────────┘
                    │ queries, mutations                          ▲ patch by seq
                    ▼                                             │
 ┌────────────────────────────────────────┐      ┌────────────────────────────────────────┐
 │ API client · fetch + AbortSignal       │      │ EventSource · /jobs/{id}/events        │
 │ Idempotency-Key · problem+json         │      │ Last-Event-ID resume · backoff         │
 └──────────────────┬─────────────────────┘      └────────────────┬───────────────────────┘
                    │ HTTPS · session cookie                      │ GET (SSE stream)
                    ▼                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ Job API · /api/v1/jobs · /executions · /dead-letter · /workers · /events               │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Create (1).** `JobForm` validates locally, freezes the draft with an idempotency key, and runs a mutation. On success the new job is written into the cached list and the router opens its page.
2. **Watch a run (2).** The job page reads `['job', id]` and `['runs', jobId]` from the query cache and opens an `EventSource` for that job. Each event patches one execution in the cache, so the page re-renders without refetching.
3. **Triage (3).** The dead-letter page lists parked runs; "Redrive selected" sends one retry per run, each with its own idempotency key, and reports per-item results.

The workers page polls every 10 s instead of streaming: worker heartbeats change constantly and nobody needs them to the second.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Server data: jobs, runs, attempts, dead letters, workers | TanStack Query | Caching, request dedupe, retries, cancellation and invalidation without hand-written loading flags |
| Live changes to runs | `EventSource`, written into the query cache | One source of truth for rendering; the stream is just another writer |
| Filters, sort, cursor, selected tab | URL search params | Shareable from an incident channel; back button works |
| Session, role, display time zone preference | Zustand | Needed everywhere, tiny, not server data |
| Form drafts, dialogs, row selection | Component state (drafts mirrored to `sessionStorage`) | Local; a draft survives a refresh |

"The rule: server data never lives in a client store. If I copy runs into Zustand I own their staleness, deduplication and invalidation by hand, and that is exactly where dashboards start showing yesterday's truth."

### Key interaction: creating a job

```
Operator                       JobForm                     Query cache                    Job API
    │                             │                             │                            │
    │ 1 Save                      │                             │                            │
    │────────────────────────────▶│                             │                            │
    │                             │ 2 check cron; preview next runs                          │
    │                             │ 3 mutate(draft, K)          │                            │
    │                             │────────────────────────────▶│                            │
    │                             │                             │ 4 POST /jobs (key K)       │
    │                             │                             │───────────────────────────▶│
    │                             │                             │ 5 201 Job, or 400 details  │
    │                             │                             │◀───────────────────────────│
    │                             │ 6 success, or field errors  │                            │
    │                             │◀────────────────────────────│                            │
    │ 7 open job, or show errors  │                             │                            │
    │◀────────────────────────────│                             │                            │
    │                             │                             │                            │
```

"Creation is pessimistic: the server assigns the id and computes the first run time, so there's nothing honest to show early. The form keeps one idempotency key per draft. Resubmitting the unchanged draft after a timeout reuses it and gets the original job back; editing any field starts a new key, because it's a different request."

### Key interaction: watching a run live

```
 JobDetail           EventSource                       Query cache    Job API
     │                    │                                 │            │
     │ 1 subscribe job 7  │                                 │            │
     │───────────────────▶│                                 │            │
     │                    │ 2 GET /jobs/7/events, Last-Event-ID 1041     │
     │                    │─────────────────────────────────────────────▶│
     │                    │ 3 replay 1042-1045, then stream live         │
     │                    │◀─────────────────────────────────────────────│
     │                    │ 4 patch execution E (seq 1045)  │            │
     │                    │────────────────────────────────▶│            │
     │             5 drop events older than the cached seq  │            │
     │ 6 re-render: RUNNING to COMPLETED                    │            │
     │◀─────────────────────────────────────────────────────│            │
     ················ network drops; browser reconnects ··················
     │                    │ 7 GET /jobs/7/events, Last-Event-ID 1045     │
     │                    │─────────────────────────────────────────────▶│
     │                    │                                 │            │
```

"Events carry a sequence number. The cache keeps the highest sequence it has applied per execution and drops anything older, so an event that arrives late can never move a run from COMPLETED back to RUNNING. When the browser reconnects it sends `Last-Event-ID` and the server replays what was missed."

### Key interaction: cancelling a run

```
Operator            ExecutionRow                          Query cache                      Job API
    │                     │                                    │                              │
    │ 1 Cancel (confirm)  │                                    │                              │
    │────────────────────▶│                                    │                              │
    │                     │ 2 cancel(E)                        │                              │
    │                     │───────────────────────────────────▶│                              │
    │                     │                                    │ 3 POST /executions/E/cancel  │
    │                     │                                    │─────────────────────────────▶│
    │                     │                                    │ 4 200 CANCELLED, or 409      │
    │                     │                                    │◀─────────────────────────────│
    │                     │ 5 CANCELLED; worker stops in 10 s  │                              │
    │                     │◀───────────────────────────────────│                              │
    ······························· on 409 (it finished first) ································
    │                     │ 6 refetch; show the real state     │                              │
    │                     │◀───────────────────────────────────│                              │
    │                     │                                    │                              │
```

"Cancel is a request, not a fact on the worker. The server marks the attempt CANCELLED immediately, but the worker only notices at its next lease renewal, within about 10 s, and stops the handler. So the row says 'Cancelled — stopping worker' until the stream confirms the worker let go. If the run finished first, the server answers `409` and I show what actually happened instead of a red error."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Job` | `id`, `name`, `handler`, `schedule`, `timezone`, `nextRunTime`, `misfirePolicy`, `priority`, `retryPolicy`, `status`, `version` | `['job', id]`, and inside list pages | `staleTime` 30 s; invalidated by mutations |
| `JobsPage` | `items: Job[]`, `nextCursor` | `['jobs', {status, q, sort}]` (infinite) | Refetch on focus |
| `Run` | `jobId`, `slot`, `attempts: Attempt[]` | derived in a selector from attempts | — |
| `Attempt` | `id`, `attempt`, `status`, `workerId`, `startedAt`, `completedAt`, `error`, `nextRetryAt`, `leaseExpiresAt`, `seq` | `['runs', jobId]`, `['attempt', id]` | Patched by the event stream |
| `DeadLetterItem` | attempt fields + `jobName`, `handler` | `['dlq', filters]` | Refetch after each redrive batch |
| `Worker` | `id`, `status`, `activeJobs`, `lastHeartbeat` | `['workers']` | Poll 10 s while visible |
| `JobDraft` | form values + `idempotencyKey` | `sessionStorage['job-draft']` | Cleared on success |

Three modeling decisions:

- **Attempts are rows; runs are a view.** The server stores one row per attempt; the UI groups them by `(jobId, slot)` into a run, so "Run at 09:00 — attempt 3 of 4, retrying at 09:01:12" is one line with the history folded under it.
- **The client never invents server states.** `CANCELLED` and `DEAD_LETTER` come from the server. "Stopping worker…" and "Retrying in 12 s" are derived display flags computed from server fields (`status`, `nextRetryAt`), never stored.
- **Every update is ordered.** `seq` is a per-execution version from the server. List refetches and stream events can race; the higher `seq` wins.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET   /api/v1/jobs?status&q&sort&cursor&limit   → {items, next_cursor}
POST  /api/v1/jobs                    + Idempotency-Key → 201 Job | 400 {details} | 409 name taken
PATCH /api/v1/jobs/{id}               + If-Match: version → 200 | 412 changed elsewhere
POST  /api/v1/jobs/{id}/trigger       + Idempotency-Key → 202 {execution} | 409 paused
POST  /api/v1/jobs/{id}/pause|resume  → 200 Job | 409
GET   /api/v1/jobs/{id}/executions    ?cursor → attempts, newest first
GET   /api/v1/jobs/{id}/events        SSE; id = seq; Last-Event-ID resumes
POST  /api/v1/executions/{id}/cancel  → 200 | 409 already finished
POST  /api/v1/executions/{id}/retry   + Idempotency-Key → 200 next attempt | 409 superseded
GET   /api/v1/schedules/preview       ?cron&timezone&count → next run times, or 400 reason
GET   /api/v1/dead-letter             ?error&handler&cursor → items
```

- **Errors are `application/problem+json`** with field details; the API client maps `details` onto form fields and everything else onto a toast.
- **The schedule preview is a server endpoint**, so the client never runs its own cron library that disagrees with the scheduler's about edge cases.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<JobTable query onSelect>` | Virtualized rows, keyboard navigation, row actions in a menu |
| `<JobForm job? onSaved>` | Owns the draft lifecycle: validate → preview → freeze key → submit → map server errors |
| `<RunsList jobId>` | Groups attempts into runs; subscribes to the event stream while mounted |
| `<CronField value timezone onChange>` | Builder plus raw text; shows the server's preview and errors |
| `useJobEvents(jobId)` | Opens and resumes the stream; patches the cache; falls back to polling |
| `useTrigger()`, `useCancel()`, `useRedrive()` | Wrap mutations, idempotency keys and cache updates so components never touch query keys |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: live run status that never lies (7 min)

"An operator triggers a backfill and watches it. I need the status on screen within two seconds of the worker recording it, without hammering the API from a hundred open tabs."

**The choice: Server-Sent Events, per job, with resumable ids.** The browser opens `EventSource('/api/v1/jobs/{id}/events')`. Each event is one execution change, `{id: seq, data: {executionId, status, attempt, seq, …}}`. SSE is plain HTTP: it goes through proxies and the load balancer, reconnects by itself, and sends `Last-Event-ID` on reconnect so the server replays what the client missed.

**Applying events.** The hook writes each event into the query cache with `setQueryData`, but only when its `seq` is higher than the cached one. A list refetch that started before an event and finished after it would otherwise overwrite COMPLETED with RUNNING. Bursts are batched: events are buffered and applied once per animation frame, so a backfill emitting 200 changes a second causes at most 60 renders.

**Freshness is visible.** A small "Live" indicator shows the stream state. If the stream has been down for more than 10 s, it turns into "Updates paused — retrying", the hook falls back to polling every 5 s, and timestamps say "as of 14:05:12". A stale status shown as current is worse than no status.

**Accessibility.** The run the user is looking at gets an `aria-live="polite"` region announcing "Attempt 2 failed, retrying in 30 seconds". Background changes in the list are not announced, or a screen reader would never stop talking.

| Approach | Verdict |
|----------|---------|
| ✅ SSE per job + seq ordering + polling fallback | Sub-second updates, resumable, works through standard HTTP infrastructure |
| ❌ Polling every 2 s | 100 tabs × 0.5 req/s per page; still up to 2 s late; wasteful when nothing changes |
| ❌ WebSocket | Bidirectional channel we don't need; we'd rebuild reconnection and resume that SSE has |

"What I give up: a long-lived connection per open job page, and a server that keeps a short event history for replay. When a tab is hidden I close the stream and refetch on focus, which keeps the connection count proportional to people actually looking."

### Deep dive 2: editing schedules without surprises (6 min)

"Cron is where scheduler UIs cause incidents: `0 9 * * 1` in UTC is 05:00 in New York in summer, and `30 2 * * *` doesn't exist on the spring-forward day."

1. **Builder and raw text, kept in sync.** Common cases (every N minutes, daily at a time, weekdays) use pickers; anything else uses the raw expression. Both edit the same string.
2. **The server previews, the client displays.** After a 300 ms pause in typing, the field calls `/schedules/preview` (aborting the previous call with an `AbortController`) and shows the next five runs in the job's time zone **and** in the viewer's, e.g. "Mon 09:00 Europe/Berlin (08:00 your time)". Invalid expressions show the server's reason inline.
3. **The time zone is part of the job.** The form defaults to the creator's zone but stores it explicitly. DST behavior is spelled out under the preview when the next five runs cross a transition.
4. **Missed runs are a visible choice.** A radio group explains the misfire policy in plain words: "If the scheduler is down when this should run: run once when it recovers / skip it."
5. **Server validation is authoritative.** Client checks are for speed; the server's `400 details` are mapped onto the matching fields, so a rule that exists only on the server still lands next to the right input.

| Approach | Verdict |
|----------|---------|
| ✅ Server-computed preview in two time zones | One cron implementation; users see the instants that will actually fire |
| ❌ Client-side cron library for previews | Two implementations disagree on edge cases like DST and day-of-week/day-of-month rules |
| ❌ Raw cron string only | Experts are fine; everyone else ships `* 9 * * *` (every minute of the 9 o'clock hour) |

### Deep dive 3: operator actions that are safe to repeat (5 min)

"Every action button is pressed twice eventually. The question is what the second press does."

- **Trigger now** is pessimistic. The button disables while the request is in flight, and the request carries an idempotency key generated per click and reused if the network fails and the client retries automatically. The server answers the retry with the original execution.
- **Pause** is optimistic: one field, it almost always succeeds, and rollback is trivial. I snapshot the cached job, flip the badge, and restore the snapshot with a toast on error. A `409` means the job changed state under me, so I refetch and explain.
- **Cancel** is shown as a request until confirmed (see the interaction above).
- **Retry and bulk redrive.** "Redrive 240 selected" sends retries with a concurrency limit of 5, each with its own key, then shows "236 redriven, 4 already retried elsewhere" from the per-item `409 superseded` answers. Refreshing mid-batch is safe: the keys and the selection are in `sessionStorage`, and finished items replay their stored responses.
- **Destructive actions** (delete job, cancel) use a confirmation dialog with focus trapped inside and returned to the trigger button when it closes.

| Approach | Verdict |
|----------|---------|
| ✅ Idempotency keys + pessimistic trigger + optimistic pause | Double clicks and retries can't duplicate runs; cheap actions feel instant |
| ❌ Disable the button and hope | Prevents double clicks, not a retry after a timeout or a refresh |
| ❌ Optimistic trigger | There's no execution id to show until the server creates one |

### Deep dive 4: big lists (2 min)

The jobs table uses keyset pagination from the server (`next_cursor`), server-side search debounced by 250 ms with the previous results kept on screen while the next page loads, and `@tanstack/react-virtual` with fixed 48 px rows, so the DOM holds ~30 rows whether a team has 50 jobs or 10,000. Virtualized rows get `aria-rowcount` and `aria-rowindex`, and arrow-key navigation scrolls the focused row into view. The log viewer is virtualized too and tails new lines only while the user is scrolled to the bottom.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First load of the jobs list | Skeleton rows at the real row height | Pending state of the first page only |
| Live stream disconnected | "Updates paused — retrying" with a timestamp; data stays visible | Stream state from `useJobEvents`; polling fallback |
| Session expired during an action | Login dialog over the page; the draft or selection survives | Drafts and keys in `sessionStorage`; resubmit with the same key |
| `409` on cancel or retry | "This run already finished" or "A newer attempt exists" with the current state | Refetch the attempt and show it |
| `400` on save | Errors next to each field | `problem+json` details mapped to fields |
| `429` | "Too many requests — try again in 20 s" on the button | Read `Retry-After`; count down |
| No jobs yet | Empty state with "Create your first job" focused | The empty state is the onboarding |
| Dead-letter queue empty | "Nothing needs attention" | An empty table looks like a failed load |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA with route splitting | SSR | Authenticated console, no SEO |
| Server state | TanStack Query, stream writes into it | Zustand copies of server data | One cache, no hand-written invalidation |
| Live status | SSE + seq ordering + polling fallback | Polling or WebSocket | Fresh, resumable, cheap |
| Schedule preview | Server endpoint, two time zones | Client cron library | One implementation of cron |
| Trigger / retry | Pessimistic + idempotency key | Optimistic, or a disabled button | No duplicate runs from retries |
| Pause | Optimistic + rollback | Wait for the server | One field, nearly always succeeds |
| Big lists | Keyset pages + virtualization | Load all, filter client-side | 10K rows would wreck INP |

"With more time I'd add a calendar heat map of upcoming runs (to spot the midnight pile-up before it happens), saved filters per team, and keyboard shortcuts for on-call triage."
