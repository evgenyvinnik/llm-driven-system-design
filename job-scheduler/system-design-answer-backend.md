# ⏰ Distributed Job Scheduler — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A scheduler looks like a cron table and a loop. Two things make it hard. First, every run should happen once even though schedulers and workers crash, freeze and get partitioned, and since a worker can die right after the webhook succeeded, 'exactly once' isn't on offer. What I can promise is that a run is never lost, never executed by two workers at the same time, and that a worker that lost its claim can't overwrite the result. Second, time: slots must fire on time across failovers, missed slots need a policy, and midnight UTC brings a spike a thousand times the average."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the midnight spike |
| High-level architecture | 10 min | One overview and the three core flows |
| Data model & API | 7 min | Why the execution table is the queue |
| Deep dive 1: claims, leases, fencing | 8 min | One owner per run, and stale owners can't write |
| Deep dive 2: firing on time | 7 min | Leader election vs an idempotent firing transaction; misfires |
| Deep dive 3: retries and poison jobs | 5 min | Backoff with jitter, a retry budget, dead letters |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs |

---

## 🎯 Requirements & Scale (5 min)

"I'll pin down what a 'job' is first, because cron-as-a-service and a background task queue are different products with different scale."

### Functional requirements

1. **Define jobs**: a handler name (code deployed with the workers), a JSON payload, a priority from 0 to 100, a retry policy, a timeout, and either a cron schedule, a single run time, or neither (on demand).
2. **Fire on schedule**: each cron slot produces exactly one execution; one-time jobs fire once.
3. **Execute** on a worker fleet, highest priority first.
4. **Retry** with backoff; after the last attempt, **dead-letter** the run for an operator to fix and redrive.
5. **Operate**: pause and resume, trigger now, cancel a running execution, see attempt history and logs.

Out of scope: DAG workflows, user-uploaded code, and billing.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Firing accuracy | Claimable within 1 s of the slot; p99 start delay < 5 s outside spikes | Jobs are used for SLAs like "report at 06:00" |
| Delivery | Never lost; never two concurrent owners; duplicates detectable downstream | A lost payroll export is worse than a duplicate the target can ignore |
| Crash recovery | A dead worker's run restarts within ~35 s | Lease length plus reaper interval |
| Failover | Firing resumes within one lease TTL after the leader dies | 15–30 s, inside the misfire grace window |
| Spike drain | The ~400K midnight runs all started within 2 minutes, by priority | We can't start 400K things in one second, but we can be predictable |
| API | 99.95%, p99 < 200 ms for trigger and cancel | Operators use it during incidents |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Definitions | ~1M recurring jobs | Due-job scan must be an index range scan |
| Executions | ~30M/day → ~350/s average | Fine for one database on average |
| Midnight UTC | ~400K slots due at 00:00:00; ~150K every hour at :00 | Fire ahead, shard, autoscale workers |
| Row writes | insert + claim + complete, plus a renewal every 10 s while running | ~1.4K/s average, ~25K/s while midnight drains |
| Concurrency | 350/s × 5 s average run ≈ 1,750 runs in flight (Little's law) | ~2K slots steady, ~20K at the spike |
| History | ~30 GB/day of execution rows, ~60 GB/day of logs | Daily partitions, 30 days hot, then Parquet in S3 |

"Two numbers drive the design. 350 runs a second means the average load is boring; any single PostgreSQL primary handles it. 400K runs due in the same second at midnight means the hard part is the calendar, not the average. Real cron schedules cluster on round times."

---

## 🏗️ High-Level Architecture (10 min)

"Here's the whole system. The key choice is visible in the middle: the execution table in PostgreSQL is the queue. There is no separate broker to keep in sync."

```
  ┌──────────────────────────────────┐                ┌──────────────────────────────────┐
  │ Operator dashboard · React SPA   │                │ Service clients · REST + API key │
  └─────────┬────────────────────────┘                └───────────────┬──────────────────┘
            │ (1) POST /api/v1/jobs/{id}/trigger                      │ POST /api/v1/jobs
            │                                                         │
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
            │ (3) claim · renew lease · complete (fenced)
            │
  ┌──────────────────────────────────────────┐                ┌──────────────────────────┐
  │ Worker fleet                             ├───────────────▶│ Job targets              │
  │ SKIP LOCKED claims · leases · fencing    │ run handler    │ webhooks · internal APIs │
  └──────────────────────────────────────────┘                └──────────────────────────┘
```

1. **Define and trigger (1).** The dashboard or a client service calls the Job API. Creating a job inserts into `jobs`; "trigger now" inserts a PENDING row into `job_executions`, and that row is the queue entry. POSTs that create work carry an `Idempotency-Key`, recorded in Redis.
2. **Fire (2).** Per shard, one scheduler holds a lease in Redis. Every second it locks the due jobs, inserts one execution per due slot and moves `next_run_time` forward, all in one transaction.
3. **Execute (3).** Workers claim PENDING rows with `FOR UPDATE SKIP LOCKED`, get a lease and a fencing token, call the job's target, renew the lease while working, and record the outcome with a write that only lands if their token still owns the row.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, auth, rate limits | Requests | Stateless |
| Job API | CRUD, trigger, cancel, retry, status stream | Operators, client services | Stateless; never calls workers |
| Scheduler | Fire due slots; reap expired leases | Due slots per second | One leader per shard plus standbys |
| Worker fleet | Claim, run, record | Concurrent runs | Stateless; autoscaled on queue depth |
| PostgreSQL | Jobs, executions (the queue), logs | Writes | 16 hash shards by job id; daily partitions |
| Redis | Leader leases, sessions, idempotency keys, heartbeats | Tiny | Losing it costs logins, never runs |

"Why are the scheduler and the workers different processes? They scale on different axes. Firing is a small amount of coordination-heavy work that must happen once; execution is embarrassingly parallel and its load follows the calendar. Splitting them lets me run 2 scheduler instances per shard and 1,000 worker pods without either knowing about the other. They only meet in the execution table."

### Flow 1: firing a due slot

```
 Scheduler                                           Redis   PostgreSQL
     │                                                 │          │
     │ 1 renew leader lease (Lua compare-and-pexpire)  │          │
     │────────────────────────────────────────────────▶│          │
     │ 2 1 = still the leader                          │          │
     │◀────────────────────────────────────────────────│          │
     │ 3 BEGIN; SELECT due jobs FOR UPDATE SKIP LOCKED            │
     │───────────────────────────────────────────────────────────▶│
     │ 4 job 7 due 09:00; NOW() = 09:00:01                        │
     │◀───────────────────────────────────────────────────────────│
     │ 5 on time: fire 09:00, next run 09:05           │          │
     │ 6 INSERT (7, 09:00, attempt 1) ON CONFLICT DO NOTHING      │
     │───────────────────────────────────────────────────────────▶│
     │ 7 UPDATE next_run_time = 09:05; COMMIT                     │
     │───────────────────────────────────────────────────────────▶│
     │                                                 │          │
```

"Three details matter. Lateness is measured with the database clock, from the same statement that found the job due, so app-server clock skew can't make a slot look early. The next slot is computed from the fired slot, not from now, so a tick that runs three seconds late doesn't skip anything. And the insert and the `next_run_time` update commit together: if the scheduler dies between them, neither happened, and the next tick fires the slot."

### Flow 2: claiming and running an execution

```
Worker                                         PostgreSQL   Webhook target
   │                                                │              │
   │ 1 claim PENDING rows (FOR UPDATE SKIP LOCKED)  │              │
   │───────────────────────────────────────────────▶│              │
   │ 2 execution E, fencing token 42, lease 30 s    │              │
   │◀───────────────────────────────────────────────│              │
   │ 3 POST; Idempotency-Key job:slot; X-Fencing-Token 42          │
   │──────────────────────────────────────────────────────────────▶│
   │ 4 every 10 s: renew lease WHERE token = 42     │              │
   │───────────────────────────────────────────────▶│              │
   │ 5 1 row: lease extended                        │              │
   │◀───────────────────────────────────────────────│              │
   │ 6 200 OK                                                      │
   │◀──────────────────────────────────────────────────────────────│
   │ 7 SET COMPLETED WHERE id = E AND token = 42    │              │
   │───────────────────────────────────────────────▶│              │
   │ 8 1 row: outcome recorded                      │              │
   │◀───────────────────────────────────────────────│              │
   │                                                │              │
```

"The claim is a single statement. A CTE picks runnable rows, meaning PENDING with `run_at` in the past, highest priority first, and locks them with `SKIP LOCKED`; the outer UPDATE marks them RUNNING with a 30-second lease and the next fencing token. The handler sends the target an idempotency key built from the job id and the slot, which is the same on every retry of this run, plus the fencing token."

### Flow 3: a worker stalls and its run moves on

```
Worker A                           PostgreSQL                                   Reaper   Worker B
    │                                   │                                          │         │
    │ 1 claim E (token 42, lease 30 s)  │                                          │         │
    │──────────────────────────────────▶│                                          │         │
    │ 2 stalls (GC pause, partition)    │                                          │         │
    ······························ 30 s pass without a renewal ·······························
    │                                   │ 3 lock expired leases (SKIP LOCKED)      │         │
    │                                   │◀─────────────────────────────────────────│         │
    │                                   │ 4 E: FAILED; attempt 2 at now + backoff  │         │
    │                                   │◀─────────────────────────────────────────│         │
    │                                   │ 5 claim attempt 2 (token 43)                       │
    │                                   │◀───────────────────────────────────────────────────│
    │ 6 SET COMPLETED WHERE token = 42  │                                          │         │
    │──────────────────────────────────▶│                                          │         │
    │ 7 0 rows: lease lost; discard it  │                                          │         │
    │◀──────────────────────────────────│                                          │         │
    │                                   │ 8 SET COMPLETED WHERE token = 43                   │
    │                                   │◀───────────────────────────────────────────────────│
    │                                   │                                          │         │
```

"This is the scenario the whole design is built around. Worker A isn't dead, just frozen. The reaper sees the lapsed lease, records attempt 1 as failed, and schedules attempt 2, which worker B claims with token 43. When A wakes up and tries to complete, its write says `token = 42`, matches no row, and A discards its result. The bookkeeping stays correct; the only cost is that the target may have seen two calls with the same idempotency key."

---

## 💾 Data Model (4 min)

"PostgreSQL holds everything that must be correct. Redis holds things I can afford to lose."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `jobs` | `id`, `shard`, `name` (unique), `handler`, `payload`, `schedule`, `timezone`, `next_run_time`, `misfire_policy`, `priority`, `max_retries`, backoff bounds, `timeout_ms`, `status` | Partial index on `next_run_time` where status is SCHEDULED: the tick reads only due, active jobs |
| PostgreSQL | `job_executions` | `id`, `job_id`, `scheduled_at` (the slot), `attempt`, `status`, `priority`, `run_at`, `worker_id`, `lease_expires_at`, `fencing_token`, `next_retry_at`, `result`, `error` | Unique `(job_id, scheduled_at, attempt)`; partial index `(priority DESC, run_at)` on PENDING; partial index on `lease_expires_at` for RUNNING; partitioned by the slot's day |
| PostgreSQL | `execution_logs` | `execution_id`, `level`, `message`, `metadata` | Daily partitions, 7-day retention |
| PostgreSQL | `execution_fencing_seq` | — | One global sequence; every claim takes the next value |
| Redis | `scheduler:leader:{shard}` | owner instance id | `PX` TTL 30 s, renewed every 10 s |
| Redis | `idem:{user}:{method}:{path}:{key}` | in-flight marker or stored response, body hash | 60 s while in flight, 24 h once done |

"One row per attempt, not a counter. A retry inserts a new row with the same job and slot and `attempt + 1`. When someone asks at 3 a.m. why a job flaps, each attempt says which worker ran it, for how long, and how it died. The slot is the identity of the logical run, so the unique index doubles as the firing guard."

"I partition by the slot's day, not by `created_at`. PostgreSQL only enforces a unique constraint on a partitioned table if it includes the partition key, and the firing guard has to hold globally. A slot and its retries share `scheduled_at`, so they land in the same partition."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/jobs                        create; Idempotency-Key → 201 | 400 details | 409 name taken
GET    /api/v1/jobs?status&q&cursor        list (keyset pagination)
PATCH  /api/v1/jobs/{id}                   edit; If-Match: version → 200 | 412
POST   /api/v1/jobs/{id}/pause | /resume   → 200 | 409 wrong state
POST   /api/v1/jobs/{id}/trigger           Idempotency-Key → 202 {execution} | 409 paused
GET    /api/v1/jobs/{id}/executions        attempt history, newest first
POST   /api/v1/executions/{id}/cancel      → 200 | 409 already finished
POST   /api/v1/executions/{id}/retry       Idempotency-Key → 200 next attempt | 409 superseded
GET    /api/v1/dead-letter?cursor          runs waiting for an operator
```

- **Idempotency-Key on create, trigger and retry.** "Trigger" is the dangerous one: a retried request after a timeout would otherwise run a payroll export twice. The first request claims the key with `SET NX`; a retry gets the stored response; the same key with a different body is a `422`; a duplicate that arrives while the first is in flight gets `409` and `Retry-After: 1`. Server errors aren't stored, so a real failure can be retried.
- **Validate at the boundary.** The cron expression must parse (and have 5 or 6 fields, since libraries happily fill in missing ones), the handler must exist, numbers must be in range. A bad cron should be a `400` at creation, not a failure every minute forever.
- **Cancel and retry are state transitions with conflicts**, so they return `409` when the execution already moved on rather than pretending.

---

## 🔧 Deep Dive 1: One Owner per Run — Claims, Leases and Fencing Tokens (8 min)

"The requirement: a run must not be lost when a worker dies, and must not be executed by two workers at once. I'll build it from three pieces."

**Claiming without contention.** Workers run `SELECT … FOR UPDATE SKIP LOCKED` inside the claim UPDATE. Without `SKIP LOCKED`, fifty workers asking for the next job all queue behind the first one's row lock. With it, each takes the next unlocked row, so claims proceed in parallel and no row goes to two claimers. Each claim takes a batch, up to the worker's free slots.

**Leases, not locks.** A claim is ownership until `lease_expires_at`. The worker renews every 10 s, all of its leases in one statement. If it dies, the lease lapses and the reaper, a loop on the scheduler leader, reclaims the run. A lock without expiry would hang that run forever.

**Fencing tokens.** Leases create the opposite problem: a worker that is alive but frozen (a 40-second GC pause, a partition from the database) doesn't know its lease ran out. Every claim takes the next value of a global sequence, and every later write by that worker is conditional: complete, fail, renew and release all say `WHERE fencing_token = $mine AND status = 'RUNNING'`. A stale worker's write matches zero rows. The worker also stops itself when its last confirmed renewal is older than the lease minus a 2-second margin, so in practice it aborts the handler before anyone else even starts.

**Downstream.** The bookkeeping is now right, but the frozen worker may have already called the target. So every call carries `Idempotency-Key: {job_id}:{slot}`, which is stable across retries of the same run, and `X-Fencing-Token`. The target can dedupe, or reject a token lower than the highest it has seen.

| Approach | Verdict |
|----------|---------|
| ✅ Lease + heartbeat + fencing token | Dead workers time out; stale workers can't write; one table, no coordinator |
| ❌ Lock with no expiry | A crashed worker holds its run forever |
| ❌ Lease without fencing | A worker that wakes up after its lease lapsed overwrites the new owner's result |
| ❌ Two-phase commit for exactly-once | Can't enlist a third-party webhook in a transaction; adds a coordinator to every run |

**The lease length is the real trade-off.** A 5-second lease recovers a crash fast but expires during ordinary GC pauses and network blips, and every false expiry is a duplicate run. A 5-minute lease never expires by accident but leaves a crashed worker's job stalled for five minutes. I pick 30 s with renewals every 10 s: two renewals can fail before anything happens, and a crash costs about 35 s.

"What I give up is exactly-once. If a worker completes the webhook and dies before recording it, the next attempt calls the webhook again. I make that duplicate harmless rather than impossible, and say so in the API contract."

---

## 🔧 Deep Dive 2: Firing On Time, Once (7 min)

"Firing must produce exactly one execution per slot, keep working when a scheduler dies, and do something sensible about slots missed during an outage."

### Is leader election the guarantee? No.

I do elect one scheduler per shard: a Redis key set with `NX PX`, renewed every TTL/3 by a Lua compare-and-pexpire, so a scheduler can only extend its own lease. But a lease-based leader can be wrong. A leader that freezes past its TTL resumes believing it still leads, while a standby has taken over. If correctness depended on the leader, that window would double-fire slots.

So the firing transaction is idempotent on its own:

1. Lock due jobs with `FOR UPDATE SKIP LOCKED` inside the transaction. Two schedulers split the due jobs between them; neither waits.
2. Insert the execution keyed by `(job_id, slot, attempt 1)` with `ON CONFLICT DO NOTHING`.
3. Move `next_run_time` forward in the same commit. Once it moves, the job is no longer due for anyone.

| Approach | Verdict |
|----------|---------|
| ✅ Leader per shard + idempotent firing | The leader saves work; the transaction guarantees one execution per slot |
| ❌ Leader election alone | A paused leader plus its successor double-fire during the overlap |
| ⚠️ No leader, every instance scans | Correct thanks to SKIP LOCKED, but N instances poll every shard every second and slot order is lost |

"The leader also fences itself the way workers do: it keeps a local deadline from its last successful renewal and stops ticking when that passes, even if Redis is unreachable and it can't find out who leads."

### Misfires: what happens to slots missed during an outage?

"Every scheduler has to answer this; most answer it by accident. Say the cluster is down for two hours and a job runs every minute."

- **Within a grace window of 60 s** (longer than the worst failover), a slot is on time. I fire it and compute the next slot from the fired slot, so a few late ticks catch up one slot at a time without skipping any.
- **Later than the grace window**, the whole gap is a misfire, and the job's `misfire_policy` decides: `fire_once` (the default) runs the oldest missed slot once, `skip` runs nothing. Either way `next_run_time` jumps to the first slot after now.
- **One-time jobs** always fire, however late.

| Option | Verdict |
|--------|---------|
| ✅ Grace window + per-job `fire_once`/`skip` | Short delays are invisible; outages cost one run, not a flood |
| ❌ Replay every missed slot | 120 identical runs at once after a two-hour outage, hammering the same target |
| ❌ Silently drop anything older than N minutes | The job can be left with a due time in the past and never fire again |

### The midnight spike

400K slots at 00:00:00 would mean ~80K inserts a second for five seconds. Instead, the scheduler fires 60 seconds ahead (`next_run_time <= now + 60 s`) and sets `run_at` to the slot, so executions exist early but can't be claimed early. The inserts spread over a minute, about 6.7K/s, and 16 shards make that ~420/s each. Workers autoscale on queue depth, and the schedule tells us tomorrow's spike in advance. "What I give up: a job deleted or paused in the last 60 seconds before its slot may still have a pending execution, so pause also holds pending executions at claim time."

---

## 🔧 Deep Dive 3: Retries, Backoff and Poison Jobs (5 min)

"A retry policy has to help with transient failures, protect a struggling dependency, and stop on permanent failures."

1. **Backoff with jitter.** Attempt *n* waits a random time between half and all of `min(max_backoff, initial × 2^(n−1))`. Exponential growth backs off from a struggling target. Jitter matters more than people expect: when a dependency goes down, a thousand jobs fail in the same second, and without jitter they retry in the same second, which is exactly what knocks the recovering dependency over again.
2. **A bounded budget.** `max_retries` counts retries after the first attempt, so a job with `max_retries = 3` runs at most four times. The retry is a new row with `run_at` in the future; no timer, no retry loop, the claim query simply ignores it until then.
3. **Non-retryable errors skip the budget.** An unknown handler, an invalid payload, or an HTTP 4xx other than 408 and 429 will fail the same way every time, so those runs are dead-lettered on the first attempt.
4. **A lapsed lease counts as an attempt.** A poison job that crashes its worker never records a failure itself. Counting the reaped lease as a failed attempt is what stops it after `max_retries` instead of crashing workers forever.
5. **Dead letters are a state, not a separate queue.** The final attempt becomes `DEAD_LETTER`. An operator fixes the cause and redrives it, which inserts the next attempt of the same run. Only the latest attempt can be redriven, so a double click produces one new attempt.
6. **Circuit breakers per target.** If a target fails half its calls, its breaker opens and its executions are released back to the queue for 30 s **without consuming an attempt**, so an outage elsewhere doesn't burn every job's retry budget.

| Approach | Verdict |
|----------|---------|
| ✅ Jittered exponential backoff + budget + dead letter | Transients recover, dependencies get room, poison stops |
| ❌ Fixed-interval retries | Synchronized waves against a recovering dependency |
| ❌ Retry forever | One poison job occupies worker slots indefinitely |
| ❌ Dead-letter on first failure | Every network blip pages an operator |

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first, in order:** the midnight spike on firing and claiming (look-ahead firing, sharding, worker autoscaling); then write amplification on `job_executions` (batch renewals, keep the hot partial indexes small, let completed rows age into partitions); then, past ~10K executions/s per shard, the database as a dispatcher (keep PostgreSQL as the ledger, dispatch through a broker fed by a transactional outbox). Strict priority can starve low-priority work under sustained overload; aging fixes that if it shows up.

| Failure | What happens | Mitigation |
|---------|--------------|------------|
| Worker crash | Run waits ~35 s | Reaper; next attempt elsewhere |
| Worker freezes past its lease | Possible duplicate side effect | Fencing rejects the stale outcome; target dedupes on the key |
| Scheduler leader dies | Firing pauses ≤ one TTL | Standby takes over; grace window absorbs the delay |
| Two leaders | Both tick | Idempotent firing; duplicate-slot metric alerts |
| PostgreSQL shard down | Its jobs neither fire nor run | Synchronous replica failover; other shards continue |
| Redis down | No logins, no idempotency (`503`), no leader changes | Current leader keeps firing until its deadline; runs continue |
| Deploy restarts workers | Running work interrupted | SIGTERM: stop claiming, drain, hand back the rest without using an attempt |

**What I'd watch:** slot-to-fire lag, oldest ready execution age (the single best "are we keeping up" signal), start delay, misfires by policy, reaped leases, fenced writes rejected (non-zero means workers freeze longer than the lease), dead-letter rate by handler, and leader changes per shard.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Work queue | PostgreSQL rows + `SKIP LOCKED` | Redis sorted set, Kafka | No dual write; retries and delays are columns |
| Ownership | Lease + heartbeat + fencing token | Lock without expiry | Dead workers time out; stale ones can't write |
| Delivery | At-least-once + idempotency key downstream | Exactly-once via 2PC | Can't put a webhook in a transaction |
| Scheduling | Leader per shard + idempotent firing | Leader election as the guarantee | Leaders can overlap; the transaction can't double-fire |
| Missed slots | 60 s grace + `fire_once`/`skip` | Replay everything | One run per outage, not a flood |
| Retries | Jittered backoff, budget, dead letter | Fixed delay, retry forever | No retry waves; poison jobs stop |
| Spikes | Fire 60 s ahead, shard, autoscale | Bigger database | Midnight is ~1,000× the average |

"With more time I'd add per-job time zones with explicit DST rules (a 02:30 job on the spring-forward day doesn't exist), an overlap policy for runs that outlast their interval, per-team ownership and quotas, and workflow dependencies built on the same execution table."
