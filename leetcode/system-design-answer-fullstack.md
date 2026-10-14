# 🧑‍💻 LeetCode (Online Judge) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one submission from the editor to its verdict and get the contracts between the layers right, so that each layer can retry, crash or lag without the coder ever seeing a duplicate, a lost submission or a verdict that changes. Three contracts carry most of the weight: an idempotency key that makes Submit safe to retry, a status resource that tells the client how often to ask, and a lease token that makes the verdict trustworthy. The fourth part of the problem — running hostile code safely — lives entirely on the server, and I'll cover it briefly."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Targets on both sides of the wire |
| End-to-end architecture | 9 min | One diagram from the editor to the sandbox, plus the core flows |
| Data model & API contract | 7 min | Server tables, client state, and the fields both sides rely on |
| Deep dive 1: one submission per click | 8 min | Idempotency from the button to the database |
| Deep dive 2: from "Running" to verdict | 8 min | Polling contract, progress, and a verdict that never flips |
| Deep dive 3: the contest scoreboard | 5 min | Ranking on the server, refresh policy on the client |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a coder |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Coders browse problems, write code in a browser editor (Python, JavaScript, C++, Java), run it against sample cases, and submit it for judging against hidden tests with live progress and a verdict. They see their history and solved problems. Contests add a clock and a live scoreboard. Out of scope: plagiarism detection, discussions, billing.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Verdict latency | p50 < 3 s, p95 < 10 s; contest queue wait p95 < 10 s |
| Backend | Durability | A `202` is never lost and ends in exactly one verdict |
| Backend | Isolation | No network or host access for submitted code; escape needs two independent bugs |
| Frontend | Problem page | LCP < 2.5 s on a mid-range laptop; the editor chunk loads while the statement renders |
| Frontend | Editor | INP < 100 ms while typing in a 500-line file |
| Both | Correctness | One click on Submit creates at most one submission, across timeouts, double clicks and refreshes |
| Both | Honesty | A displayed verdict never changes; "still judging" is shown as such, never as a failure |

**Scale.** 500K daily active users, 1M submissions a day (12/s) rising to 170/s in the first minutes of a weekly contest. At ~2 s of sandbox time each, that is 340 busy sandboxes for submissions alone. About 1,000 submissions are in flight at peak, each polled roughly once a second, and 50K contestants refresh the scoreboard every 15 seconds — about 1.5K reads a second.

"Those numbers tell me two things. Judging must be asynchronous — a 15-second C++ run can't hold an HTTP request open — so the API returns a handle and the client polls. And the client's polling policy is part of the capacity plan: a thousand tabs polling every 200 ms would be five times the load of the same tabs backing off to a few seconds."

---

## 🏗️ End-to-End Architecture (9 min)

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │ Coder's browser · React SPA                                          │
  │ draft store in localStorage · one Idempotency-Key per submit         │
  │ status polling with backoff · standings refresh every 15 s           │
  └─────────┬───────────────────────────────────────────┬────────────────┘
            │ (1) POST /submissions                     │ (3) GET /contests/{id}/standings
            │     GET /submissions/{id}/status          │
            │                                           │
            ▼                                           ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ API gateway · TLS, session check, per-user rate limits               │
  └─────────┬───────────────────────────────────────────┬────────────────┘
            │                                           │
            ▼                                           ▼
  ┌──────────────────────────────┐          ┌────────────────────────────┐
  │ Submission API               │          │ Contest Service            │
  │ problems · submit · status   │          │ standings · contest clock  │
  └─────┬──────────────────────┬─┘          └─────┬──────────────────────┘
        │                      │                  │
        │ INSERT, NOTIFY       │ GET status       │ ZREVRANGE top 50
        │                      │                  │
        ▼                      ▼                  ▼
  ┌──────────────────────┐    ┌────────────────────────────────┐
  │ PostgreSQL           │    │ Redis                          │
  │ users · problems     │    │ sessions · status cache        │
  │ submissions = queue  │    │ rate limits · standings        │
  └──────────────────────┘    └────────────────────────────────┘
                  ▲                         ▲
                  │ (2) claim · verdict     │ progress · ZADD
                  │                         │
                  │                         │
            ┌─────┴─────────────────────────┴──────┐
            │ Judge workers                        │
            │ per-language pools, woken by NOTIFY  │
            └─────────┬───────────────────────┬────┘
                      │                       │
                      │ compile, run          │ fetch test data
                      ▼                       ▼
        ┌────────────────────────────┐  ┌────────────────────────┐
        │ Sandboxes · gVisor         │  │ Object storage         │
        │ no network, cgroup limits  │  │ test data by version   │
        └────────────────────────────┘  └────────────────────────┘
```

1. **Submit and poll (1).** The SPA freezes the editor's content, generates an `Idempotency-Key` and posts it. The Submission API inserts the submission — which is also the judge job — and notifies workers in one transaction, then returns `202` with an id. The SPA polls the status resource, which is a Redis read.
2. **Judge (2).** A worker claims the job with a lease, compiles once, runs each test in a fresh sandbox, publishes "test 3 of 10" to Redis, and writes the verdict to PostgreSQL only if it still holds the lease.
3. **Standings (3).** During a contest the SPA refreshes the scoreboard every 15 s while the tab is visible; the Contest Service serves it from a Redis sorted set.

| Layer | Choice | Why |
|-------|--------|-----|
| SPA | React, lazy-loaded editor route, server-state cache, persisted draft store | Authenticated workspace, no SEO; the editor is the heavy part |
| Gateway | TLS, session check, per-user rate limits in Redis | Floods and retry storms stop before the database |
| Submission API | Stateless; problems, submit, status, history | Never runs code: API hosts hold secrets |
| PostgreSQL | Source of truth and the judge queue | Job and submission created in one transaction |
| Redis | Sessions, status cache, rate limits, standings | Hot reads; never the only copy of a verdict |
| Judge workers + gVisor sandboxes | Per-language pools on dedicated hosts | Hostile code runs where there is nothing to steal |

### Flow: submitting across the wire

```
 Coder                        SPA                      Submission API                  PostgreSQL
   │                           │                              │                             │
   │ 1 click Submit            │                              │                             │
   │──────────────────────────▶│                              │                             │
   │                           │ 2 freeze code, key K = randomUUID()                        │
   │                           │ 3 POST /submissions (key K)  │                             │
   │                           │─────────────────────────────▶│                             │
   │                           │                              │ 4 INSERT … ON CONFLICT      │
   │                           │                              │────────────────────────────▶│
   │                           │ 5 response lost (timeout)    │                             │
   │                           │◀─────────────────────────────│                             │
   │                           │ 6 retry in 0.5 s, same K     │                             │
   │                           │─────────────────────────────▶│                             │
   │                           │                              │ 7 conflict → find row by K  │
   │                           │                              │────────────────────────────▶│
   │                           │ 8 202, same id (replay)      │                             │
   │                           │◀─────────────────────────────│                             │
   │ 9 "Waiting for a judge…"  │                              │                             │
   │◀──────────────────────────│                              │                             │
   │                           │                              │                             │
```

"This is the case the design exists for. The response to the first attempt is lost — Wi-Fi on a train — so the SPA retries with the *same* key. The insert conflicts on the unique index for that user and key, the API finds the row the first attempt created, and the coder gets the original submission back instead of a second judging run."

### Flow: from progress to verdict

```
 SPA                        Submission API           Redis                      Judge worker
  │                                │                   │                              │
  │                                │                   │ 1 progress: test 3 of 10     │
  │                                │                   │◀─────────────────────────────│
  │ 2 GET …/status                 │                   │                              │
  │───────────────────────────────▶│                   │                              │
  │                                │ 3 GET status key  │                              │
  │                                │──────────────────▶│                              │
  │ 4 running 3/10, Retry-After 1  │                   │                              │
  │◀───────────────────────────────│                   │                              │
  │                                │                   │ 5 verdict (after PG commit)  │
  │                                │                   │◀─────────────────────────────│
  │ 6 poll again (1–5 s)           │                   │                              │
  │───────────────────────────────▶│                   │                              │
  │ 7 accepted, 48 ms              │                   │                              │
  │◀───────────────────────────────│                   │                              │
  │ 8 stop polling, announce verdict                   │                              │
  │                                │                   │                              │
```

"The worker writes progress to Redis as it goes and writes the verdict to Redis only after it has committed to PostgreSQL. The SPA's polling interval grows from half a second to five seconds and stops at the first terminal status, then announces the verdict and refreshes the submission history."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `problems` | `slug`, `difficulty`, `time_limit_ms`, `memory_limit_mb`, `checker`, `test_set_version` | Reference solutions never leave the server |
| PostgreSQL | `submissions` | `id`, `user_id`, `problem_id`, `language`, `code`, `status`, verdict fields | Also the queue: `run_after`, `lease_expires_at`, `lease_token`, `judge_attempts` |
| PostgreSQL | `submissions` (dedupe) | `idempotency_key`, `request_hash`, `code_hash` | Unique per (user, key); unique per (user, problem, language, code) while in flight |
| PostgreSQL | `user_problem_status`, `contest_results` | `(user, problem)`, `(contest, user, problem)` | Attempts counted at create; solves with the verdict |
| Redis | `submission:{id}:status` | `{user_id, status, current_test, verdict, terminal}` | Forward-only writes |
| Redis | `contest:{id}:standings` | Sorted set: score = solved, then penalty | Rebuilt from `contest_results` if lost |

### Client side

| State | Owner | Why there |
|-------|-------|-----------|
| Problems, problem detail, history, standings | Server-state cache (TanStack Query) | Dedupe, retries, refetch intervals and invalidation without hand-written flags |
| Submission status | A query keyed by submission id, with a backoff refetch interval that stops at a terminal status | Polling is just a query whose interval depends on the data |
| Code drafts per problem and language | Zustand store persisted to `localStorage`, saved 500 ms after typing stops | Survives refresh, language switches, closed tabs |
| The in-flight submit's key | Component state, mirrored to `sessionStorage` until a response arrives | A refresh mid-submit can still resend the same key |
| Filters, search, contest page | URL search params | Shareable, survives reload |

### The contract

```
POST /api/v1/submissions             + Idempotency-Key → 202 {submissionId} | 200 duplicate | 422 | 429
GET  /api/v1/submissions/{id}/status → {status, current_test, test_cases_total, verdict…} + Retry-After
GET  /api/v1/submissions/{id}        → code + verdict, owner or admin only
POST /api/v1/runs  → 202 {runId};  GET /api/v1/runs/{id} → per-sample results
GET  /api/v1/contests/{id}/standings?page → 50 rows + your rank + frozen flag
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → the same submission; same key + different body → `422` | Retry after timeouts and refreshes without duplicates |
| `200` with `duplicate: true` | Identical code already in flight is not queued twice | Show "already judging this" instead of an error |
| Status values | `pending` and `running` are the only non-terminal ones; terminal values never change | Stop polling at the first terminal status and trust it |
| `Retry-After` on status | A sensible next poll time while judging | Back off instead of hammering |
| `404` for others' submissions | Never reveals another user's code, errors or existence | Treat `404` as "stop polling, show history" |
| `system_error` vs. user verdicts | Sandbox failures are retried server-side and never reported as Wrong Answer | Tell the coder "our fault, resubmit" instead of "your bug" |
| `503` + `Retry-After` on runs | The sandbox is temporarily down | Disable Run with a countdown |

---

## 🔧 Deep Dive 1: One Submission per Click (8 min)

"The scenario: a coder on a flaky connection presses Submit, the request times out, and they press it again. If we create two submissions, their attempt count is wrong, two sandboxes burn time, and during a contest the second one may even be judged first. Each layer has a job."

**Browser.** On Submit, the SPA flushes the pending draft save, freezes the code, and creates a key with `crypto.randomUUID()` (falling back to `getRandomValues` on non-secure dev hosts). It keeps the key until a response arrives — in `sessionStorage`, so even a page refresh resends the same key — and retries network errors and `5xx` responses twice with the same key. The button is disabled while pending, but correctness doesn't depend on that.

**API and database.** The insert runs with `ON CONFLICT DO NOTHING` against two unique indexes. A conflict on (user, key) is a retry: same body hash → return the original submission, different hash → `422`. A conflict on (user, problem, language, normalized code) among pending or running rows is a second click with identical code → return the in-flight submission. Because the database serializes conflicting inserts, eight concurrent identical requests produce one row; in an earlier design that checked a Redis hash first, the same eight requests produced four.

**Queue.** The insert and `pg_notify` share the transaction, so the coder can't get a `202` for a submission no worker will ever see.

| Approach | Verdict |
|----------|---------|
| ✅ Client key + database unique indexes | Correct under timeouts, refreshes and concurrent double clicks |
| ❌ Content hash checked in a cache, written after insert | Concurrent requests all pass the check; it also conflates "retry" with "same code again" |
| ❌ Disable the button only | Stops double clicks, not retries after a timeout or a refresh |
| ❌ Optimistic insert into the history list | There is no id or verdict to show until the server assigns one |

"What I give up: three extra columns and two more indexes on the hottest table, and keys that are remembered forever. I'm happy with both — a key is 36 bytes, and forgetting it is what creates duplicates."

---

## 🔧 Deep Dive 2: From "Running" to Verdict (8 min)

"The promise to the coder is that what they see is true: progress moves forward, and a verdict, once shown, never changes. That promise spans the worker, Redis, the API and the polling loop."

**Worker side.** The worker holds a 30 s lease, renewed every 10 s, with a token that increments on every claim. If it stalls past its lease and another worker takes over, its verdict write carries the old token and matches nothing — so two workers can judge the same submission, but only one verdict can commit. Sandbox failures are retried with backoff and, after three attempts, become `system_error`: the coder sees "the judge is temporarily unavailable; retrying (attempt 1 of 3)" while it's pending, never a fake Wrong Answer.

**Cache side.** Progress goes to Redis through a compare-and-set that refuses to overwrite a terminal entry, and the verdict is cached only after it commits to PostgreSQL. The status endpoint reads Redis and falls back to PostgreSQL. Entries carry the owner's id, so the endpoint can return `404` to anyone else without a query.

**Client side.** The status query polls at 0.5 s, 1 s, 1.5 s, 2 s, 3 s, then every 5 s, aborts its in-flight request when the coder leaves the page, keeps polling through network errors, and gives up after five minutes with "still judging — check your submissions". Progress and the final verdict go to an `aria-live="polite"` region, so screen-reader users hear "Running test 3 of 10" and "Accepted" without moving focus.

| Approach | Verdict |
|----------|---------|
| ✅ Polling with server-guided backoff + forward-only status cache | ~1K Redis reads/s at peak; nothing to reconnect; verdicts can't flip |
| ❌ WebSocket per editor tab | Hundreds of thousands of connections, sticky routing or a fan-out layer, reconnection logic — to save a second on a multi-second job |
| ⚠️ Server-Sent Events | The right upgrade for instant contest banners: one-way, proxy-friendly, resumable with `Last-Event-ID` |

"I'd make polling the default and add SSE only for the contest page, where 'your submission was accepted' a second earlier actually changes behavior."

---

## 🔧 Deep Dive 3: The Contest Scoreboard (5 min)

"Ranking is a server problem; freshness is a client policy. I want both to be explicit."

**Server.** ICPC-style ranking — problems solved, then penalty minutes including 20 per rejected attempt — packs into one sorted-set score. The judge updates it on each contestant's first accepted solution, right after the verdict transaction writes `contest_results`, the source of truth. Pages of 50 are cached for 5 s and "my rank" is a single O(log N) lookup. Computing the ranking in SQL per request would sort 50K participants' results 1,500 times a second.

**Client.** The standings query refetches every 15 s, only while the tab is visible, keeps the previous page on screen while the next one loads, and highlights the coder's own row from the `your rank` field even when it isn't on the current page. During the final hour the server returns a frozen snapshot and a `frozen: true` flag, and the UI says so rather than looking stale.

| Approach | Verdict |
|----------|---------|
| ✅ Sorted set + 5 s page cache + 15 s client refresh | Fresh within ~20 s; reads never touch PostgreSQL |
| ❌ SQL ranking per request | ~75M rows sorted per second at peak |
| ❌ Pushing every rank change to every client | Each accepted solution shifts thousands of ranks; nobody reads them that fast |

---

## 📈 Failures & Scale (2 min)

| Failure | What the coder sees | Mitigation |
|---------|---------------------|------------|
| Response to Submit lost | Nothing — the retry returns the same submission | Same key on every retry |
| Judge host dies mid-run | The verdict arrives ~30 s later | Lease expires; another worker re-claims |
| Sandbox unhealthy | "Judge temporarily unavailable, retrying"; `system_error` after 3 tries | Breaker, backoff, dead-letter outcome |
| Worker stalls and wakes | Nothing | Fencing token rejects its stale verdict |
| Redis down | Logged out; slower status; frozen scoreboard | Status falls back to PostgreSQL; standings rebuilt |
| PostgreSQL failover | Submit fails briefly; the client retries with the same key | Idempotent retries make the blip harmless |
| Rate limited | "Try again in 42 s" on the button | `429` with `Retry-After`, counted per user in Redis |

**What breaks first as we grow:** judge capacity at contest starts (pre-scale pools from the contest schedule), then queue contention on the primary past a few thousand jobs a second (move dispatch to SQS behind an outbox, same lease rules), then submission storage (monthly partitions).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Submit safety | Client key + unique indexes | Cache check or disabled button | Retries and double clicks can't duplicate |
| Job queue | Submissions table with leases | Kafka | No dual write; per-job timeouts |
| Verdict integrity | Lease-token fenced write + forward-only cache | Last writer wins | A shown verdict never changes |
| Verdict delivery | Backoff polling guided by `Retry-After` | WebSockets | Cheap, stateless, honest progress |
| Drafts | Persisted client store, debounced | Server-side autosave | Instant, offline-tolerant, no write load |
| Scoreboard | Sorted set + client refresh while visible | SQL per request; push every change | Fresh enough, cheap at 1.5K reads/s |
| Isolation | gVisor sandboxes on dedicated judge hosts | Running code on API servers | API hosts never execute untrusted code |

"With more time: SSE for contest verdicts, a 'compare with your previous submission' diff view, and server-side draft sync so code follows the coder across devices."
