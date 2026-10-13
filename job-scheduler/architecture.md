# Job Scheduler — Architecture

## System Overview

A distributed job scheduler runs code on behalf of other teams: "call this webhook every five minutes", "run the nightly export at 02:00", "run this cleanup once, now". People define **jobs** (a handler, a payload, and either a cron schedule or a single run time); the scheduler turns each due **slot** into an **execution** and a fleet of workers runs it, retrying failures and parking the hopeless ones for a human.

Two things make it a real design problem rather than a `setInterval`:

1. **Each run should happen once, even though every component crashes, stalls and gets partitioned.** Exactly-once is impossible when a worker can die after the webhook succeeded but before it recorded that, so the honest target is *at-least-once with duplicates made harmless*: a run is never lost, it is never executed by two workers at the same time, and a worker that lost its claim can never overwrite the outcome. The mechanisms are a transactional claim (`FOR UPDATE SKIP LOCKED`), leases that expire, and fencing tokens.
2. **Time.** Cron slots must fire on time, exactly once each, even across a scheduler failover; runs missed during an outage need an explicit policy instead of an accident; and real cron schedules cluster on round times, so midnight UTC produces a spike hundreds of times the average.

This document describes the production-scale design first. [Implementation Notes](#implementation-notes) then describes what the local Express + PostgreSQL + Redis + React implementation actually runs.

**Learning goals**

- Using a PostgreSQL table as a work queue: `FOR UPDATE SKIP LOCKED`, priorities, delayed retries.
- Leases with heartbeats and expiry, and fencing tokens that stop a stale worker from writing.
- Leader election as an optimization, with correctness coming from an idempotent firing transaction.
- Cron arithmetic, misfire policies and the grace window; retries with jittered backoff and dead-lettering.
- Idempotency keys on non-idempotent API calls.

## Requirements

### Functional requirements

1. **Define jobs**: handler name, JSON payload, priority (0–100), retry policy (`max_retries`, backoff bounds), timeout, and either a cron schedule (recurring), a run time (one-time), or neither (on demand).
2. **Fire on schedule**: every cron slot produces exactly one execution; one-time jobs fire once.
3. **Run executions** on a horizontally scaled worker fleet, highest priority first.
4. **Retry** failed attempts with exponential backoff; after the last attempt, **dead-letter** the run so an operator can fix the cause and redrive it.
5. **Operate**: pause/resume jobs, trigger now, cancel a running execution, retry a failed one, see attempt history, logs, worker health and queue depth.

Out of scope: workflow DAGs (job B after job A), arbitrary user code upload (handlers are deployed with the workers), and per-tenant billing.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Firing accuracy | Execution claimable within 1 s of its slot; p99 start delay < 5 s outside spikes |
| Spike drain | The midnight UTC spike (~400K runs) fully started within 2 minutes, in priority order |
| Delivery | At-least-once: an accepted run is never lost; never executed by two workers concurrently |
| Crash recovery | Work held by a dead worker restarts within lease length + reaper interval (~35 s) |
| Scheduler failover | Firing resumes within one lease TTL (15–30 s) after a leader dies |
| API availability | 99.95% for job management; p99 < 200 ms for trigger/cancel |
| Durability | Executions kept 30 days hot, 1 year archived; accepted jobs survive a node loss |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Job definitions | ~1M recurring + on-demand jobs | The due-job scan must be an index range scan, never a table scan |
| Executions | ~30M/day → ~350/s average | One PostgreSQL primary could absorb the average, but not the spikes below |
| Midnight UTC spike | ~400K slots due at 00:00:00 (hourly: ~150K at :00) | Fire ahead of time (look-ahead); shard the tables; scale workers on queue depth |
| Writes per execution | insert + claim + complete (+ a renewal every 10 s while running) | ~1.4K row writes/s average, ~25K/s while the midnight spike drains |
| Concurrent runs | 350/s × 5 s average run (Little's law) ≈ 1,750 | 2K slots steady state, autoscaled to ~20K for spikes (~1,000 pods × 20 slots) |
| Execution history | ~1 KB/row → 30 GB/day; logs ~2 KB/run → 60 GB/day | Partition by day; ~1.3 TB hot (30 days of runs, 7 of logs); older partitions to S3 as Parquet |
| Redis | Leader leases, sessions, idempotency records (24 h) | A few GB; losing it costs logins and replays, never runs |

The spike row drives the design. If 400K slots were inserted at 00:00:00, one primary would need ~80K inserts/s for five seconds. Firing 60 seconds ahead with `run_at` set to the slot spreads those inserts over the preceding minute (~6.7K/s), and hash-sharding jobs and executions by job id across 16 shards brings that to ~420 inserts/s per shard. Workers still all become eligible at 00:00:00, so the start-time target for spikes is "drained in two minutes in priority order", not "everything starts in one second".

### Local Development Scale

One API process, one scheduler (a second can be started to watch failover), three workers with five slots each, one PostgreSQL and one Redis. Tens of jobs, a few executions per second. Ports and commands are in the [README](./README.md).

## High-Level Architecture

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

1. **Define and trigger (1).** The dashboard or a service calls the Job API through the load balancer. Creating a job inserts a row into `jobs`; "trigger now" inserts a PENDING row into `job_executions`. That row *is* the queue entry, so there is no second system to keep in sync. Non-idempotent POSTs carry an `Idempotency-Key`, recorded in Redis.
2. **Fire (2).** For each shard, one scheduler holds a lease in Redis. Every second it locks the due jobs, inserts one execution per due slot and moves each job's `next_run_time` forward, all in one transaction, so a slot cannot be fired twice or skipped.
3. **Execute (3).** Workers claim PENDING executions with `FOR UPDATE SKIP LOCKED`, receive a lease and a fencing token, run the handler against the job's target, renew the lease while it runs, and record the outcome with a write that only succeeds if their token still owns the execution. Failures schedule the next attempt or dead-letter the run.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, routing, session/API-key auth, rate limits | Requests | Stateless |
| Job API | Job CRUD, trigger, cancel, retry, status stream (SSE) | Operators and client services | Stateless; never talks to workers directly |
| Scheduler | Fires due slots; reaps expired leases | Due slots per second | One leader per shard, standbys waiting on the lease |
| Worker fleet | Claims, runs and records executions | Concurrent runs | Stateless; autoscaled on ready-queue depth |
| PostgreSQL | Jobs, executions (the queue), logs | Rows and writes | 16 hash shards by job id; executions partitioned by day |
| Redis | Leader leases, sessions, idempotency records, worker heartbeats | Small, hot keys | Loss costs logins and replays, never runs |
| Job targets | Webhooks and internal services the handlers call | — | Receive an idempotency key and fencing token |
| S3 (not drawn) | Archived execution partitions (Parquet) | History | Nightly; queried with Athena/Trino when needed |

Why not put the queue in Redis or Kafka and keep PostgreSQL for history? Because then every execution is a **dual write**: the row and the queue entry are written separately, and a crash between the two either loses a run (row exists, nothing will ever run it) or duplicates one. [Key Design Decision 1](#1-the-execution-table-is-the-queue) covers the alternatives.

## Core Components / Request Flows

### Firing a due slot

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

- The scheduler measures lateness with the database clock (`NOW()` from the same statement that selected the job), so app-server clock skew cannot make a slot look early or late.
- Within the grace window (60 s) the next run is computed **from the slot**, not from now: a tick that is 3 s late still fires 09:05 next, and if several slots are already due (a short outage) the following ticks catch up one slot at a time.
- Later than the grace window, the whole gap is one **misfire**: `fire_once` runs the oldest missed slot once, `skip` runs nothing, and either way `next_run_time` jumps to the first slot after now. A job is never left with a due time in the past.
- `ON CONFLICT DO NOTHING` on `(job_id, scheduled_at, attempt)` makes a repeated slot a no-op, and the job row lock means a second scheduler that believes it leads (a split brain) skips the job instead of firing it again.
- At production scale the select is `next_run_time <= NOW() + 60 s` and the insert sets `run_at = slot`: executions are created ahead of time but cannot be claimed early.

### Claiming and running an execution

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

- The claim is one statement: a CTE selects runnable rows (`status = 'PENDING' AND run_at <= NOW()`, highest priority first) with `FOR UPDATE SKIP LOCKED`, and the outer `UPDATE` marks them RUNNING with `lease_expires_at = NOW() + 30 s` and `fencing_token = nextval(...)`. Concurrent workers skip each other's locked rows instead of waiting or double-claiming.
- The worker renews all of its leases in one statement every 10 s. A renewal that matches zero rows means the execution was cancelled or reclaimed, and the handler's `AbortSignal` fires.
- The worker also keeps a local deadline (last confirmed renewal + lease − 2 s). If renewals fail (database unreachable, process stalled), it stops the handler before the lease can lapse rather than run alongside a replacement.
- The handler forwards `Idempotency-Key: {job_id}:{slot}` (stable across retries of the same run) and `X-Fencing-Token`, so a target can de-duplicate side effects and reject writes from an older attempt.

### Recovering from a crashed or stalled worker

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

- The reaper is the leader's second loop (every 5 s). It locks expired RUNNING rows with `SKIP LOCKED` and applies the same failure transition a worker would: the attempt becomes FAILED and attempt 2 is inserted with `run_at = now + backoff`, or the run is dead-lettered if no attempts remain.
- A lapsed lease counts as a failed attempt. That is what stops a poison job that crashes its worker every time from cycling forever.
- Worker A's late write carries token 42, but the row is no longer RUNNING under 42, so it matches nothing. A stale worker can neither complete, fail, renew nor release an execution it no longer owns.

### Triggering a run from the API

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

- The key is claimed with `SET NX`, so two concurrent duplicates cannot both run; the stored response is replayed for 24 h. The same key with a different body is a `422`; a duplicate that arrives while the first is in flight gets `409` with `Retry-After: 1`.
- 5xx responses are not stored, so a client can retry a genuinely failed request. If Redis is unreachable the API answers `503` rather than silently dropping the guarantee.
- Each manual run gets its own slot (`scheduled_at = now`), so it can never collide with, or suppress, a scheduled firing.

## Database Schema

### Production schema

```sql
CREATE TABLE jobs (
  id                 UUID PRIMARY KEY,
  shard              SMALLINT NOT NULL,              -- hash(id) % 16, routes every query
  name               TEXT NOT NULL UNIQUE,
  handler            TEXT NOT NULL,                  -- must exist in the worker registry
  payload            JSONB NOT NULL DEFAULT '{}',
  schedule           TEXT,                           -- cron; NULL for one-time / on-demand
  timezone           TEXT NOT NULL DEFAULT 'UTC',    -- IANA zone the cron is evaluated in
  next_run_time      TIMESTAMPTZ,                    -- the next slot; NULL once a one-time job fired
  misfire_policy     TEXT NOT NULL DEFAULT 'fire_once' CHECK (misfire_policy IN ('fire_once', 'skip')),
  priority           SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  max_retries        SMALLINT NOT NULL DEFAULT 3,
  initial_backoff_ms INTEGER NOT NULL DEFAULT 1000,
  max_backoff_ms     INTEGER NOT NULL DEFAULT 3600000,
  timeout_ms         INTEGER NOT NULL DEFAULT 300000,
  status             TEXT NOT NULL DEFAULT 'SCHEDULED',  -- SCHEDULED, PAUSED, QUEUED, RUNNING, ...
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs (next_run_time) WHERE status = 'SCHEDULED';

CREATE SEQUENCE execution_fencing_seq;

-- One row per attempt. Partitioned by the slot's day: old history is detached, not deleted,
-- and the firing guard below includes the partition key, so it holds across partitions.
CREATE TABLE job_executions (
  id               UUID NOT NULL,
  job_id           UUID NOT NULL,
  scheduled_at     TIMESTAMPTZ NOT NULL,             -- the slot: identity of the logical run
  attempt          SMALLINT NOT NULL,
  status           TEXT NOT NULL,     -- PENDING, RUNNING, COMPLETED, FAILED, DEAD_LETTER, CANCELLED
  priority         SMALLINT NOT NULL,                -- copied from the job for the claim index
  run_at           TIMESTAMPTZ NOT NULL,             -- earliest claim time (slot, or now + backoff)
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token    BIGINT,
  next_retry_at    TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  result           JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, scheduled_at),
  UNIQUE (job_id, scheduled_at, attempt)             -- the firing guard
) PARTITION BY RANGE (scheduled_at);

CREATE INDEX executions_claimable ON job_executions (priority DESC, run_at) WHERE status = 'PENDING';
CREATE INDEX executions_leases    ON job_executions (lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX executions_by_job    ON job_executions (job_id, scheduled_at DESC);
```

Why partition by `scheduled_at` rather than `created_at`: PostgreSQL only enforces a unique constraint on a partitioned table if it includes the partition key. Partitioned by `created_at`, the firing guard would have to include `created_at` and could never conflict. A slot and all its retries share `scheduled_at`, so they live in one partition. The cost is that a lookup by execution id alone probes each daily partition's primary-key index (about 30 of them), which is acceptable for an operator screen. `execution_logs` (execution id, level, message, metadata) is partitioned by day as well and kept for 7 days.

Redis keys: `scheduler:leader:{shard}` (lease), `session:{id}`, `idem:{user}:{method}:{path}:{key}` (in-flight marker or stored response), `workers` (heartbeat registry).

### Local schema

The local schema is the `SCHEMA_SQL` string in [`backend/src/db/migrate.ts`](./backend/src/db/migrate.ts), applied idempotently by every process at startup under a PostgreSQL advisory lock (and by `npm run db:migrate`). It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `jobs` with `shard`, `timezone` | `jobs` | No sharding; cron is always evaluated in UTC; `misfire_policy` added with a CHECK constraint |
| Partitioned `job_executions` | Plain `job_executions` | Same queue columns (`priority`, `run_at`, `lease_expires_at`, `fencing_token`); unique index `(job_id, scheduled_at, attempt)` over the whole table; cleanup deletes rows instead of detaching partitions |
| `execution_fencing_seq` | Same | — |
| Partial indexes | `idx_executions_claimable`, `idx_executions_lease`, `idx_jobs_due` | Same shape |
| Users in an identity provider | `users` table (seeded, unused) and users in Redis | Auth reads Redis; see Security |

## API Design

### Production API

```
POST   /api/v1/jobs                         create; Idempotency-Key → 201 | 400 details | 409 name taken
GET    /api/v1/jobs?status&q&cursor&limit   list, keyset pagination on (created_at, id)
GET    /api/v1/jobs/{id}                    definition + next_run_time
PATCH  /api/v1/jobs/{id}                    edit; If-Match: version → 200 | 412
POST   /api/v1/jobs/{id}/pause | /resume    → 200 | 409 wrong state
POST   /api/v1/jobs/{id}/trigger            Idempotency-Key → 202 {execution} | 409 paused
GET    /api/v1/jobs/{id}/executions         attempt history, newest first (cursor)
GET    /api/v1/jobs/{id}/events             SSE stream of execution changes; Last-Event-ID resume
GET    /api/v1/executions/{id}              attempt + logs
POST   /api/v1/executions/{id}/cancel       → 200 | 409 already finished
POST   /api/v1/executions/{id}/retry        Idempotency-Key → 200 next attempt | 409 superseded
GET    /api/v1/dead-letter?cursor           runs waiting for an operator
```

Errors use `application/problem+json`; rate limits are reported with `RateLimit` headers. Every POST that creates work accepts an `Idempotency-Key`.

### Local routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login`, `/api/auth/logout`; GET `/api/auth/me` | Session cookie auth |
| POST / GET | `/api/v1/jobs` | Create (admin, validated, `Idempotency-Key`); list with `page`/`limit`, `withStats` |
| GET / PUT / DELETE | `/api/v1/jobs/:id` | Read; update (admin, validated); delete (admin) |
| POST | `/api/v1/jobs/:id/pause`, `/resume`, `/trigger` | Lifecycle; trigger accepts `Idempotency-Key`, `409` when paused |
| GET | `/api/v1/jobs/:id/executions` | Attempt history (`page`, `limit`, `status`) |
| GET | `/api/v1/executions/:id` | Attempt with logs |
| POST | `/api/v1/executions/:id/cancel`, `/retry` | Guarded cancel (`409`); redrive as next attempt (`Idempotency-Key`) |
| GET | `/api/v1/metrics/system`, `/metrics/executions`, `/workers`, `/dead-letter` | Dashboard data |
| GET | `/api/v1/health`, `/health/ready`, `/health/live`, `/metrics` | Operations |
| POST / GET | `/api/v1/admin/users`, `/admin/cleanup`, `/admin/storage`, `/admin/circuit-breakers/reset` | Admin |

## Key Design Decisions

### 1. The execution table is the queue

Every scheduler needs two things: durable history ("what ran, when, with what result") and a work queue ("what should run next"). Keeping them in two systems is the classic dual write. With PostgreSQL rows plus a Redis sorted set, firing writes the row and then `ZADD`s; a crash in between leaves a PENDING row nothing will ever run, and the opposite order leaves a queue entry whose row may not exist yet. Recovery then needs a reconciliation scanner, which is a second scheduler in disguise.

Making the row the queue entry removes the problem. Firing, claiming, retrying and dead-lettering are single-database transactions; delayed retries are a `run_at` column; priority is an `ORDER BY` served by a partial index; and the history is the queue itself. `FOR UPDATE SKIP LOCKED` (PostgreSQL 9.5+) is what makes this practical: concurrent claimers skip rows another transaction has locked instead of blocking on them.

| Option | Why / why not |
|--------|---------------|
| ✅ PostgreSQL rows + `SKIP LOCKED` | One source of truth; transactional firing and outcomes; delays and priorities for free. Thousands of claims/s per primary, more with shards |
| ❌ Redis sorted set | ~100K ops/s, but a dual write with the database, and durability depends on AOF fsync settings |
| ❌ Kafka | No per-message ack or visibility timeout (a slow job blocks its partition), no priorities, no native delays |
| ⚠️ SQS / RabbitMQ | Visibility timeouts built in, but still a dual write (needs an outbox); SQS has no priorities and caps delays at 15 minutes |

The cost is write load on PostgreSQL: three to four row updates per execution and an index on hot, frequently updated rows (autovacuum must keep up). Beyond ~10K executions/s per shard I would keep PostgreSQL as the ledger and move dispatch to a broker fed by a transactional outbox.

### 2. Leases and fencing tokens, not locks

A worker that claims an execution gets a **lease**: ownership until `lease_expires_at`, extended by heartbeats. A lock without expiry would hang the run forever when its holder dies; a lease turns a dead worker into a delay of at most lease + reaper interval.

Expiry creates the opposite problem. A worker that is alive but stalled (a long GC pause, a partition from the database) does not know its lease lapsed. When it wakes up, another worker may be running the same run. The **fencing token** fixes the bookkeeping: every claim takes the next value of a global sequence, and every later write is `WHERE fencing_token = $mine AND status = 'RUNNING'`. The stale worker's writes match zero rows. The token is also passed to the job's target so it can reject older writers, and the worker stops itself at its local lease deadline so it rarely gets that far.

The lease length is a trade-off. A 5 s lease recovers fast but expires under ordinary pauses and network blips, producing duplicate runs; a 5 min lease is safe from pauses but holds a crashed worker's job for 5 minutes. 30 s with 10 s heartbeats tolerates two missed renewals and recovers a crash in ~35 s.

### 3. The leader is an optimization; the firing transaction is the guarantee

Leader election (a Redis key set with `NX PX`, renewed with a Lua compare-and-pexpire every TTL/3) keeps one scheduler per shard doing the work. But a lease-based leader can be wrong: a paused leader can keep acting after its lease expired and someone else took over. So correctness does not depend on it. Due jobs are locked with `FOR UPDATE SKIP LOCKED` inside the firing transaction, `next_run_time` moves forward in the same commit, and the execution insert is guarded by the unique `(job_id, scheduled_at, attempt)`. Two concurrent leaders split the due jobs between them or find nothing due; neither can fire a slot twice. The leader also self-fences on a local deadline, the same way workers do.

Without a leader every scheduler instance would poll every shard every second and contend for the same rows: correct, but wasteful, and slot order within a shard would be lost.

### 4. Misfires need a policy and a grace window

A slot that is late by less than the **grace window** (60 s, longer than the worst failover) is on time: fire it, then advance from the slot itself so a slightly late tick never skips the next slot. A slot that is later than that means the system was down. Replaying every missed slot of an every-minute job after a two-hour outage would enqueue 120 identical runs at once, which is rarely what anyone wants, so the gap collapses into one decision per job: `fire_once` (run the oldest missed slot once, the default) or `skip`. Either way `next_run_time` moves to the first future slot. One-time jobs always fire, however late.

### 5. One row per attempt

A retry inserts a new row (same job and slot, `attempt + 1`, `run_at = now + backoff`) instead of updating a counter. The attempt history is then exact: each row records which worker ran it, how long it took, and how it failed. The slot identifies the logical run, which is what the downstream idempotency key is built from. The cost is more rows, which daily partitions make cheap to drop.

### 6. Retries: jittered backoff, a bounded budget, a dead-letter state

Attempt *n* waits a random time between half and all of `min(max_backoff, initial_backoff · 2^(n−1))`. The exponent backs off from a struggling dependency; the jitter stops a thousand jobs that failed together (same outage) from retrying in one synchronized wave. `max_retries` counts retries after the first attempt. Errors a retry cannot fix (unknown handler, invalid payload, an HTTP 4xx other than 408/429) dead-letter immediately. A dead-lettered run waits in the `DEAD_LETTER` state until an operator redrives it as its next attempt.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Firing a slot | At most one execution per (job, slot) | Job row lock + `next_run_time` advanced in the same transaction + unique `(job_id, scheduled_at, attempt)` |
| Claiming | One owner per execution at a time | `FOR UPDATE SKIP LOCKED`; lease + fencing token |
| Recording an outcome | Only the current owner's write lands | `WHERE fencing_token = $t AND status = 'RUNNING'` on complete, fail, renew and release |
| Worker crash | Run restarts within lease + reaper interval | Reaper treats a lapsed lease as a failed attempt |
| Side effects | Duplicates are detectable downstream | `Idempotency-Key: {job}:{slot}` and `X-Fencing-Token` sent to targets |
| Create / trigger / retry | One effect per client intent | `Idempotency-Key` header, `SET NX` claim, stored response, `422` on body mismatch |
| Redrive | One new attempt per dead-lettered run | Only the latest attempt can be redriven, under a row lock |
| Pause | Survives an in-flight run finishing | Status writes from workers are compare-and-set and never overwrite `PAUSED` |

What is **not** guaranteed: exactly-once side effects. A worker can complete a webhook call and die before recording it; the retry calls the webhook again. That is why targets get a stable idempotency key.

## Security / Auth

- **Authentication**: session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`) backed by Redis for people; API keys for services at the load balancer.
- **Authorization**: roles (`admin` manages jobs; `user` views and triggers) plus ownership per team in production, so one team cannot trigger or read another team's jobs.
- **Handlers are code, not input**: handlers ship with the worker image and are referenced by name; the API rejects unknown names. A shell handler exists only in development builds.
- **Secrets**: payloads reference secrets by name (resolved by the worker from a secret store), so they never sit in `jobs.payload` or execution logs.
- **Outbound calls**: webhook targets are validated against an allow-list (no internal metadata endpoints), and responses stored in `result` are truncated.
- **Rate limits**: per user and per API key on creates and triggers, enforced in Redis so they hold across API instances.

## Observability

- **Firing**: lag between slot and firing (p50/p99), misfires by policy, duplicate-slot inserts (should be zero; non-zero means two leaders), leader changes.
- **Queue**: ready depth, delayed depth (backoff), oldest ready age, running count, expired-but-unreaped leases.
- **Execution**: start delay (claim − run_at), duration by handler, outcome by handler, retries, dead letters.
- **Leases**: reaped leases by outcome, fenced writes rejected (non-zero means workers stall longer than the lease), renewal latency.
- **Alerts**: oldest ready execution > 60 s; dead-letter rate above baseline; fenced rejections > 0 for 10 minutes; no leader for a shard > 2 × TTL; worker count 0 while the queue is non-empty.

Structured logs carry `jobId`, `executionId`, `attempt`, `workerId` and `fencingToken`, so one run can be traced across the scheduler, the worker and the target.

## Failure Handling

| Failure | Effect | Mitigation |
|---------|--------|------------|
| Worker crashes mid-run | Run paused for up to ~35 s | Reaper reclaims the lapsed lease; next attempt on another worker |
| Worker stalls past its lease | Two workers may run the same slot | Fencing token rejects the stale outcome; worker self-fences; target dedupes by idempotency key |
| Scheduler leader dies | Firing pauses for up to one TTL | Standby takes the lease; slots inside the grace window fire on time-ish, older ones follow the misfire policy |
| Two leaders (split brain) | Both tick | Firing transaction is idempotent; duplicate-slot metric alerts |
| PostgreSQL shard down | That shard's jobs neither fire nor run | Failover to a synchronous replica; other shards unaffected |
| Redis down | No logins, idempotency `503`, no leader changes | Running leader keeps firing until its local deadline; runs themselves are unaffected |
| Target dependency down | Jobs for it fail repeatedly | Per-target circuit breaker holds executions back (no attempt consumed); backoff; dead letter after the budget |
| Poison job crashes workers | Each attempt kills a worker | Lapsed lease counts as an attempt; dead-lettered after `max_retries` |
| Deploy restarts workers | Running work interrupted | SIGTERM: stop claiming, drain for a grace period, hand back the rest without consuming an attempt |

## Scalability Considerations

1. **Spikes come from the calendar.** Fire 60 s ahead with `run_at = slot`; autoscale workers on ready-queue depth and on the known schedule (the next minute's due count is a query away); let jobs that don't care about the exact second opt into start jitter.
2. **Shard by job id.** 16 logical shards on 4 PostgreSQL clusters to start. Each shard has its own scheduler lease; workers claim from shards round-robin, weighted by queue depth.
3. **Keep the hot set small.** Claims touch only PENDING and RUNNING rows through partial indexes; completed rows age into daily partitions that are detached and archived, so the claim index stays small however much history accumulates.
4. **Batch.** Claims take several rows per statement; lease renewals are one statement per worker; inserts during firing are batched per shard.
5. **Fairness.** Strict priority can starve low-priority work under sustained overload. If that shows up, add aging (effective priority grows with wait time) or weighted per-priority queues.
6. **Beyond ~10K executions/s per shard**, keep PostgreSQL as the ledger and dispatch through a broker fed by an outbox.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Work queue | PostgreSQL rows + `SKIP LOCKED` | Redis sorted set, Kafka | No dual write; transactional retries and delays |
| Ownership | Lease + heartbeat + fencing token | Lock without expiry | Dead workers time out; stale workers can't write |
| Delivery | At-least-once + downstream idempotency key | Exactly-once via 2PC | 2PC can't include an arbitrary webhook |
| Scheduler | Leader per shard, idempotent firing | Every instance scans | Less contention; correctness never rests on the lock |
| Missed runs | Grace window + `fire_once`/`skip` | Replay every slot | Avoids bursts after outages |
| Attempt history | One row per attempt | Counter on one row | Exact failure history; slot = idempotency identity |
| Retries | Jittered exponential backoff, then dead letter | Fixed delay, retry forever | No synchronized retry waves; poison jobs stop |
| Spikes | Fire 60 s ahead, shard, autoscale | Bigger primary | The midnight spike is ~1,000× average |

## Implementation Notes

This section describes the code as it runs after the 2026-10 repair pass; [CLAUDE.md](./CLAUDE.md) records the iteration history.

### What runs

Four Node.js (Express, TypeScript/CommonJS) entry points share one codebase: the API ([`backend/src/api/index.ts`](./backend/src/api/index.ts), port 3001 under `npm run dev`), the scheduler ([`backend/src/scheduler/index.ts`](./backend/src/scheduler/index.ts)), workers ([`backend/src/worker/index.ts`](./backend/src/worker/index.ts), three under `npm run dev`), and an all-in-one mode ([`backend/src/index.ts`](./backend/src/index.ts)). PostgreSQL holds jobs, executions and logs; Redis holds the leader lease, users, sessions, idempotency records and the worker registry. The React dashboard is in [`frontend/`](./frontend).

### Production-grade patterns implemented

| Pattern | Where | What it does |
|---------|-------|--------------|
| SKIP LOCKED claiming | [`db/execution-queue.ts`](./backend/src/db/execution-queue.ts) `claimExecutions` | One `WITH … FOR UPDATE SKIP LOCKED` + `UPDATE` statement; priority order; skips future `run_at` and paused jobs |
| Leases, heartbeats, self-fencing | `renewLeases`; [`worker/index.ts`](./backend/src/worker/index.ts) | 30 s lease renewed every 10 s in one statement; local deadline aborts the handler if renewals fail |
| Fencing tokens | `completeExecution`, `failExecution`, `releaseExecution` | Every outcome write is `WHERE fencing_token = $t AND status = 'RUNNING'`; rejections are counted |
| Reaper | `reapExpiredLeases`, leader loop every 5 s | Lapsed lease = failed attempt → retry or dead letter |
| Idempotent firing + misfire policy | [`db/schedule-repository.ts`](./backend/src/db/schedule-repository.ts) `fireDueJobs`, [`scheduler/cron.ts`](./backend/src/scheduler/cron.ts) | One transaction per batch; unique `(job_id, scheduled_at, attempt)`; 60 s grace; `fire_once`/`skip` |
| Leader lease | [`queue/leader-election.ts`](./backend/src/queue/leader-election.ts) | `SET NX PX`, Lua compare-and-pexpire/delete, local deadline; standbys retry every tick |
| Retries and dead letter | `applyFailure`, [`shared/backoff.ts`](./backend/src/shared/backoff.ts) | Equal-jitter exponential backoff; new row per attempt; `DEAD_LETTER` state; `NonRetryableError` |
| Idempotency keys | [`shared/idempotency.ts`](./backend/src/shared/idempotency.ts) | On create, trigger and retry: `SET NX` claim, fingerprint → `422`, in-flight `409`, 5xx not stored, `503` if Redis is down |
| Boundary validation | [`api/validation.ts`](./backend/src/api/validation.ts) | Cron (5/6 fields), registered handler, ranges; `400` with details instead of `500` |
| Circuit breakers | [`shared/circuit-breaker.ts`](./backend/src/shared/circuit-breaker.ts) | Opossum per handler type; open breaker → execution released for 30 s without consuming an attempt |
| Graceful shutdown | worker and scheduler `stop()` | Worker drains for `SHUTDOWN_GRACE_MS`, then hands executions back; scheduler releases its lease |
| Metrics and logs | [`shared/metrics.ts`](./backend/src/shared/metrics.ts), [`utils/logger.ts`](./backend/src/utils/logger.ts) | prom-client (`/metrics` on the API; `METRICS_PORT` for scheduler and workers); Pino JSON logs |

The core of the claim, as it runs:

```sql
WITH next AS (
  SELECT e.id FROM job_executions e
  WHERE e.status = 'PENDING' AND e.run_at <= NOW()
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = e.job_id AND j.status = 'PAUSED')
  ORDER BY e.priority DESC, e.run_at ASC
  LIMIT $2
  FOR UPDATE OF e SKIP LOCKED
)
UPDATE job_executions e
SET status = 'RUNNING', worker_id = $1, started_at = NOW(), completed_at = NULL,
    lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
    fencing_token = nextval('execution_fencing_seq')
FROM next WHERE e.id = next.id
RETURNING e.*;
```

Tests: `npm test` runs 38 offline unit tests (backoff, cron and misfire planning, validation, the idempotency middleware against a real Express server, leader election with a fake clock, password hashing). With `TEST_DATABASE_URL` set it also runs 11 PostgreSQL integration tests: four concurrent claimers over 60 rows never share one, the highest priority is claimed first, a reaped lease rejects the stale worker's writes, cancel and release are fenced, redrive happens once, two concurrent firing passes fire each slot once, and both misfire policies.

### Simplified or substituted

- **One PostgreSQL, no shards or partitions.** `job_executions` is a plain table; `POST /api/v1/admin/cleanup` and the `system.maintenance` handler delete executions older than 30 days and logs older than 7. Nothing is archived to S3.
- **UTC-only cron.** There is no per-job time zone; `cron-parser` always evaluates in UTC.
- **No look-ahead firing.** Due slots are fired when due, so a large top-of-the-hour spike is not smoothed.
- **Workers poll** every 500 ms (with jitter) instead of being woken by `LISTEN/NOTIFY`.
- **Users live in Redis** (`job_scheduler:user:*`, salted scrypt hashes, legacy SHA-256 hashes upgraded on login). The PostgreSQL `users` table is seeded but unused. `admin` / `admin123` is created at API startup.
- **Dashboard updates by polling** (dashboard and workers every 5 s, a running execution every 2 s) with Zustand stores and offset pagination; there is no SSE stream, no dead-letter page (the count and `/api/v1/dead-letter` exist), and no list virtualization.

### Omitted

Sharding, read replicas, daily partitions and S3 archiving; per-team ownership and API keys; rate limiting (a `rateLimitConfig` object exists, no middleware applies it); webhook allow-lists and secret references; per-target circuit breakers; a load balancer and multi-region deployment; Kubernetes autoscaling; distributed tracing.

### Known limitations

- **Cancellation is cooperative.** A cancelled or reclaimed handler is aborted through its `AbortSignal`; a handler that ignores the signal keeps running in the background until it finishes, though its result is rejected.
- **No overlap policy.** If a run takes longer than its interval, the next slot still fires and both run (Kubernetes calls this `Allow`; `Forbid` is not implemented).
- **Strict priority** can starve low-priority executions under sustained overload.
- **Breakers are per handler type and per worker process**: one failing webhook host opens the breaker for every `http.webhook` job on that worker.
- **Any authenticated user can trigger or retry any job**; there is no ownership model, and `shell.command` is registered in every environment.
- **Seed jobs reference handlers that do not exist** (`database-backup`, `health-checker`, …); when they come due they are dead-lettered immediately as non-retryable.
- The Docker `app` profile was updated (`dist/api/index.js`, `npm install` because no lockfile is committed) but not run in this pass.
