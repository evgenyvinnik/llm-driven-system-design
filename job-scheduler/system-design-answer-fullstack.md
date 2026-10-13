# ⏰ Distributed Job Scheduler — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one run all the way: an operator clicks 'Trigger now', a worker somewhere picks it up, it fails, retries, succeeds, and the screen tells the truth at every step. Three contracts between the layers carry the weight: an idempotency key that makes the button safe to press twice, an execution state machine with a version number so the UI never shows an older state over a newer one, and cancellation treated as a request the worker honors at its next heartbeat, not as an instant fact."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the browser to the worker, and the core flows |
| Data model & API contract | 7 min | Server tables, client cache, and the fields both sides rely on |
| Deep dive 1: one click, one run | 8 min | Idempotency from the button to the unique index, and one owner per run |
| Deep dive 2: status the UI can trust | 7 min | State machine, sequence numbers, fenced writes, live updates |
| Deep dive 3: cancel and pause across the seam | 6 min | Requests vs facts, and what the UI promises |
| Failures, scale, wrap-up | 4 min | What each failure looks like to an operator |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Teams define jobs (a handler deployed with the workers, a JSON payload, priority, retry policy, timeout, and a cron schedule, a run time, or neither). The system fires each slot once, runs it on a worker fleet, retries with backoff and dead-letters what keeps failing. Operators list and search jobs, watch runs live, read logs, pause and resume, trigger now, cancel, retry, and redrive dead letters. Out of scope: DAG workflows and user-uploaded code.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Firing accuracy | Claimable within 1 s of the slot; p99 start delay < 5 s outside spikes |
| Backend | Delivery | Never lost; never two concurrent owners; duplicates detectable by the target |
| Backend | Recovery | A dead worker's run restarts within ~35 s; scheduler failover within one lease TTL |
| Frontend | Status freshness | A run's status on screen < 2 s after the worker records it |
| Frontend | Responsiveness | INP < 200 ms with 10K jobs in a team's list; LCP < 2 s |
| Both | Safety | One click on "Trigger" or "Retry" makes at most one run, across timeouts, refreshes and double clicks |

**Scale.** About 1M recurring jobs and 30M executions a day, which is ~350 a second on average. Cron schedules cluster on round hours, so ~400K runs are due at 00:00 UTC. With a 5-second average run, about 1,750 runs are in flight at any moment (Little's law), and history grows by ~90 GB a day including logs.

"The average tells me a single PostgreSQL could run the queue; the midnight spike tells me to fire ahead of time and shard. On the frontend, the scale that matters is a hundred operators watching runs during an incident, which rules out aggressive polling."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌──────────────────────────────────┐                ┌──────────────────────────────────┐
  │ Browser · React SPA              │                │ Service clients · REST + API key │
  │ query cache · EventSource        │                └───────────────┬──────────────────┘
  └─────────┬────────────────────────┘                                │ POST /api/v1/jobs
            │ (1) POST /trigger  (3) GET /events                      │
            ▼                                                         ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · session or API-key auth · rate limits                          │
  └─────────┬────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
  ┌──────────────────────────────────────────┐                ┌──────────────────────────┐
  │ Job API · stateless                      ├───────────────▶│ Redis                    │
  │ CRUD · trigger · cancel · retry · SSE    │ keys, sessions │ idempotency keys         │
  └─────────┬────────────────────────────────┘                │ sessions                 │
            │ INSERT job / execution                          │ leader leases            │
            │                                                 │ worker heartbeats        │
            ▼                                                 └──────────────────────────┘
  ┌──────────────────────────────────────────┐                             ▲ leader lease
  │ PostgreSQL · hash-sharded by job id      │                ┌────────────┴─────────────┐
  │ jobs · job_executions (= the queue)      │◀───────────────┤ Scheduler                │
  │ execution_logs                           │ (2) fire slots │ one leader per shard     │
  └──────────────────────────────────────────┘                └──────────────────────────┘
            ▲
            │ claim · renew lease · complete (fenced)
            │
  ┌──────────────────────────────────────────┐                ┌──────────────────────────┐
  │ Worker fleet                             ├───────────────▶│ Job targets              │
  │ SKIP LOCKED claims · leases · fencing    │ run handler    │ webhooks · internal APIs │
  └──────────────────────────────────────────┘                └──────────────────────────┘
```

1. **Trigger (1).** The SPA sends `POST /jobs/{id}/trigger` with an idempotency key. The Job API records the key in Redis and inserts a PENDING row into `job_executions`. That row is the queue entry; there is no broker to keep in sync.
2. **Fire and run (2).** For recurring jobs, the scheduler leader for the job's shard inserts one execution per due slot and advances `next_run_time` in one transaction. Workers claim PENDING rows with `FOR UPDATE SKIP LOCKED`, run them under a lease, and record the outcome with a write fenced on their token.
3. **Watch (3).** The SPA holds `GET /jobs/{id}/events` open as a Server-Sent Events stream. Every execution change becomes an event with a sequence number, which the browser writes into its query cache.

| Layer | Choice | Why |
|-------|--------|-----|
| SPA | React, TanStack Query for server state, URL params for filters, `EventSource` for live runs | Authenticated console; the cache owns server data; the stream is just another writer |
| Job API | Stateless REST + SSE | CRUD, trigger, cancel, retry, the event stream |
| Scheduler | Leader per shard, idempotent firing | The leader saves work; the transaction guarantees one execution per slot |
| Workers | Stateless, autoscaled | Leases, heartbeats, fencing tokens |
| PostgreSQL | Jobs, executions (the queue), logs, outbox | One source of truth; retries and delays are columns |
| Redis | Leader leases, sessions, idempotency records | Losing it costs logins and replays, never runs |

### Flow: "Trigger now" across the wire

```
 Dashboard                             Job API                             Redis   PostgreSQL
     │                                    │                                  │          │
     │ 1 POST trigger, Idempotency-Key K  │                                  │          │
     │───────────────────────────────────▶│                                  │          │
     │                                    │ 2 SET idem:K in-flight NX EX 60  │          │
     │                                    │─────────────────────────────────▶│          │
     │                                    │ 3 OK (first time)                │          │
     │                                    │◀─────────────────────────────────│          │
     │                                    │ 4 INSERT execution (PENDING)                │
     │                                    │────────────────────────────────────────────▶│
     │                                    │ 5 store 202 + body for 24 h      │          │
     │                                    │─────────────────────────────────▶│          │
     │ 6 202 {execution}                  │                                  │          │
     │◀───────────────────────────────────│                                  │          │
     ······················ response lost; client retries with K ························
     │ 7 POST trigger, Idempotency-Key K  │                                  │          │
     │───────────────────────────────────▶│                                  │          │
     │                                    │ 8 NX fails; GET stored response  │          │
     │                                    │─────────────────────────────────▶│          │
     │ 9 same 202 (Idempotent-Replayed)   │                                  │          │
     │◀───────────────────────────────────│                                  │          │
     │                                    │                                  │          │
```

"Steps 1 and 7 are the two halves of the contract. The browser promises to send the same key when it repeats the same click, and the server promises that a repeated key returns the stored response instead of doing the work again."

### Flow: a status change reaching the screen

```
Worker                           PostgreSQL                Job API                     Browser
   │                                  │                       │                           │
   │ 1 COMPLETED (token 42) + outbox  │                       │                           │
   │─────────────────────────────────▶│                       │                           │
   │                                  │ 2 relay: E, seq 1045  │                           │
   │                                  │──────────────────────▶│                           │
   │                                  │                       │ 3 SSE id 1045: COMPLETED  │
   │                                  │                       │──────────────────────────▶│
   │                                  │                       │  4 apply if seq is newer  │
   ····························· tab sleeps, then reconnects ······························
   │                                  │                       │ 5 Last-Event-ID 1045      │
   │                                  │                       │◀──────────────────────────│
   │                                  │                       │ 6 replay newer events     │
   │                                  │                       │──────────────────────────▶│
   │                                  │                       │                           │
```

"The worker's fenced update and an outbox row commit in one transaction, so every change that happened produces an event, and only changes that happened do. The event's id is the sequence number, which is also what the browser uses to order updates and to resume after a reconnect."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `jobs` | `id`, `name`, `handler`, `payload`, `schedule`, `timezone`, `next_run_time`, `misfire_policy`, `priority`, retry policy, `status`, `version` | Partial index on `next_run_time` for active jobs |
| PostgreSQL | `job_executions` | `id`, `job_id`, `scheduled_at` (slot), `attempt`, `status`, `run_at`, `worker_id`, `lease_expires_at`, `fencing_token`, `seq`, `error`, `result` | Unique `(job_id, scheduled_at, attempt)`; partial indexes for claimable and leased rows |
| PostgreSQL | `execution_events` (outbox) | `seq` (bigserial), `job_id`, `execution_id`, `status` | Written with each state change; relayed to SSE; kept 24 h for replay |
| Redis | `idem:{user}:{method}:{path}:{key}` | In-flight marker or stored response, body hash | 60 s in flight, 24 h when done |

### Client side

| Cache key | Holds | Updated by |
|-----------|-------|------------|
| `['jobs', {status, q, sort}]` | Pages of jobs with `nextCursor` | Refetch; create inserts into page 1 |
| `['job', id]` | One job including `version` and `nextRunTime` | Mutations; refetch on focus |
| `['runs', jobId]` | Attempts grouped into runs | SSE events with a higher `seq`; refetch on reconnect gaps |
| `sessionStorage` | Form drafts and their idempotency keys; bulk-redrive selection | Cleared on success |

### The contract

```
POST  /api/v1/jobs/{id}/trigger      + Idempotency-Key → 202 {execution} | 409 paused
POST  /api/v1/executions/{id}/retry  + Idempotency-Key → 200 next attempt | 409 superseded
POST  /api/v1/executions/{id}/cancel → 200 CANCELLED | 409 already finished
GET   /api/v1/jobs/{id}/events       SSE; id = seq; Last-Event-ID replays newer events
GET   /api/v1/jobs/{id}/executions   ?cursor → attempts with seq
GET   /api/v1/schedules/preview      ?cron&timezone&count → next runs | 400 reason
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → same response for 24 h; different body → `422`; in flight → `409` + `Retry-After` | Retry after timeouts and refreshes without creating a second run |
| Execution `status` | A fixed state machine: PENDING → RUNNING → COMPLETED, FAILED (+ next attempt), DEAD_LETTER or CANCELLED | Render badges and the actions allowed in each state |
| `seq` | Strictly increasing per execution; also the SSE event id | Drop out-of-order updates; resume the stream |
| `nextRetryAt`, `leaseExpiresAt` | When the next attempt becomes runnable; when a running attempt's lease ends | Show "retrying in 12 s" and "worker unresponsive" honestly |
| Schedule preview | Computed by the same cron code the scheduler uses, in the job's time zone | Show upcoming runs that will actually happen |
| `application/problem+json` | Machine-readable type and field details | Put "cron: expected 5 fields" next to the cron field |

---

## 🔧 Deep Dive 1: One Click, One Run (8 min)

"The scenario: an on-call engineer clicks 'Trigger backfill' on a bad network, the request times out, they click again. Without care the backfill runs twice. Each layer has one job."

**Browser.** The click generates a key with `crypto.randomUUID()`. While the request is in flight the button is disabled and a second click is ignored. If the network fails (fetch rejects before any response), the client retries once with the same key. If the page reloads mid-request, the pending key is in `sessionStorage` and the resubmit reuses it.

**API.** The Job API claims the key with `SET idem:{user}:…:{key} in-flight NX EX 60`. If the claim fails and a stored response exists, it replays it with `Idempotent-Replayed: true`. If the key is still in flight it answers `409` with `Retry-After: 1`. If the body differs it answers `422`, because the client reused a key for a different operation. Server errors are not stored, so a genuine failure can be retried. If Redis is down, the API refuses with `503` rather than run without the guarantee.

**Database.** A manual run gets its own slot (`scheduled_at = now`), so it can never collide with or suppress a scheduled firing. The unique `(job_id, scheduled_at, attempt)` index guards the slot.

**Worker.** One run must also mean one *owner*. Workers claim with `FOR UPDATE SKIP LOCKED`, hold a lease renewed every 10 s, and every write they make is conditional on their fencing token. If a worker freezes past its lease, the reaper retries the run elsewhere and the frozen worker's late write matches nothing.

| Approach | Verdict |
|----------|---------|
| ✅ Client key + server-stored response + per-run slot + fenced worker writes | One effect per click, one owner per run |
| ❌ Disable the button only | Stops double clicks, not retries after a timeout or a reload |
| ❌ Server dedupe by "same job within 10 s" | Merges deliberate repeated triggers and still races |
| ❌ Optimistic trigger in the UI | No execution id exists until the server creates it |

"What I give up is exactly-once execution. If a worker finishes the webhook and dies before recording it, the retry calls the webhook again. So the worker sends the target `Idempotency-Key: {job}:{slot}`, which is the same for every attempt of that run, and the contract says at-least-once."

---

## 🔧 Deep Dive 2: Status the UI Can Trust (7 min)

"A dashboard that shows RUNNING for a run that finished, or flips COMPLETED back to RUNNING, teaches operators to ignore it. Trust comes from three contracts."

**One writer at a time on the server.** Because outcome writes are fenced (`WHERE fencing_token = $t AND status = 'RUNNING'`), the final status always comes from the attempt's current owner, or from the reaper or a cancel. There is never a race between two workers' outcomes for the UI to reconcile.

**Ordered events.** Each change bumps the execution's `seq` and appends an outbox row in the same transaction. A relay publishes events per job, and the API streams them as SSE with `id = seq`. On the client, the stream handler writes into the query cache only when the event's `seq` is higher than what the cache holds. List refetches and stream events can arrive in any order; the higher `seq` wins.

**Resume and fallback.** On reconnect the browser sends `Last-Event-ID`; the API replays newer events from the outbox (kept 24 h). If the gap is older than that, the server sends a `reset` event and the client refetches. If the stream stays down for 10 s, the UI says "Updates paused — retrying", polls every 5 s, and labels data "as of 14:05:12".

**Honest derived states.** The UI shows "Retrying in 12 s" from `nextRetryAt` and "Worker unresponsive" when `leaseExpiresAt` has passed but the reaper hasn't acted yet. Those are display flags computed from server fields, never states the client invents.

| Approach | Verdict |
|----------|---------|
| ✅ Outbox → SSE with `seq`, cache patches, replay | Fresh, ordered, resumable; one event per real change |
| ❌ Polling every 2 s | Up to 2 s stale; 100 tabs make 50 requests a second for mostly unchanged data |
| ❌ Workers push to browsers directly | Couples workers to client connections; no ordering or replay |
| ❌ Patch on any event regardless of order | A late event regresses COMPLETED to RUNNING |

"What I give up: an outbox table and a relay process, and one long-lived connection per open job page. Hidden tabs close their stream and refetch on focus, so connections track people actually watching."

---

## 🔧 Deep Dive 3: Cancel and Pause Across the Seam (6 min)

"Both buttons look instant in the UI, but the system underneath is not, and the copy must not lie."

```
 Browser            Job API                         PostgreSQL                       Worker
    │                  │                                 │                              │
    │ 1 POST cancel E  │                                 │                              │
    │─────────────────▶│                                 │                              │
    │                  │ 2 CANCELLED if PENDING/RUNNING  │                              │
    │                  │────────────────────────────────▶│                              │
    │ 3 200 CANCELLED  │                                 │                              │
    │◀─────────────────│                                 │                              │
    │                  │                                 │ 4 renew (token 42, RUNNING)  │
    │                  │                                 │◀─────────────────────────────│
    │                  │                                 │ 5 0 rows: lease gone         │
    │                  │                                 │─────────────────────────────▶│
    │                  │                                 │         6 abort the handler  │
    │                  │                                 │                              │
```

**Cancel is a request.** The API's update only succeeds if the attempt is still PENDING or RUNNING; otherwise it answers `409` and the UI shows what actually happened ("finished at 14:05:31"). A PENDING attempt is simply never claimed. A RUNNING attempt keeps running until its worker's next lease renewal, at most 10 s later. The renewal matches zero rows, the worker fires the handler's `AbortSignal`, and any result it still produces is rejected by the fenced write. The UI therefore shows "Cancelled — stopping worker" until the stream confirms the attempt ended, and the help text says that handlers stop cooperatively.

**Pause holds, but doesn't kill.** Pausing a job stops new firings and holds its PENDING executions (retries included) at claim time; a RUNNING attempt finishes. Worker status writes are compare-and-set and never overwrite PAUSED, so a run that finishes after the pause can't silently resume the job. In the UI, pause is optimistic: one field, almost always succeeds, rollback on error.

| Approach | Verdict |
|----------|---------|
| ✅ Cancel as a fenced state change the worker discovers at renewal | No worker RPC; works even if the worker is unreachable |
| ❌ API calls the worker to kill the run | Needs routing to the right worker, which may be dead or partitioned |
| ❌ UI shows "Cancelled" as final immediately | Hides up to 10 s of real work and the possibility it already finished |

"The trade-off is a cancellation delay of up to one renewal interval, and handlers that must honor their abort signal. I'd rather state a 10-second promise than pretend to an instant one."

---

## 📈 Failures & Scale (2 min)

| Failure | What the operator sees | What happens to runs | Mitigation |
|---------|------------------------|----------------------|------------|
| Worker crashes | Attempt marked "worker unresponsive", then failed and retried | Restarts within ~35 s | Reaper; fenced writes |
| Scheduler leader dies | Nothing, or slots a few seconds late | Firing resumes within one TTL | Standby; 60 s grace window |
| Redis down | Login and trigger/retry return `503` | Running and scheduled runs continue | Leader keeps its local lease deadline |
| Event stream down | "Updates paused — retrying" | None | Polling fallback, replay on reconnect |
| PostgreSQL shard down | Errors for that shard's jobs | Its jobs pause | Replica failover; other shards unaffected |

**What breaks first as we grow:** the midnight spike (fire 60 s ahead with `run_at` = slot, shard by job id, autoscale workers on queue depth), then SSE fan-out during big incidents (relay through Redis pub/sub to many API instances), then the execution table's write rate (daily partitions; past ~10K runs/s per shard, dispatch through a broker fed by the outbox).

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Trigger safety | Client key + stored response | Disabled button, server time window | Retries and reloads can't duplicate runs |
| Queue | PostgreSQL rows + `SKIP LOCKED` | Redis or Kafka beside the database | No dual write between history and queue |
| Run ownership | Lease + fencing token | Lock without expiry | Dead workers time out; stale ones can't write |
| Live status | Outbox → SSE with `seq` | Polling | Fresh, ordered, resumable |
| Cancel | Fenced state change, cooperative stop | RPC to the worker | Works when the worker is unreachable |
| Schedule preview | Server endpoint | Client cron library | One cron implementation |

"With more time: per-team ownership and quotas, an overlap policy for runs that outlast their interval, and a calendar view of upcoming runs so teams can see, and spread out, their own midnight pile-up."
