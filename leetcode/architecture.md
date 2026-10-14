# LeetCode (Online Judge) — Architecture

## System Overview

An online judge lets people pick a programming problem, write a solution in the browser, run it against the sample cases, and submit it to be judged against hidden test cases. The answer is a verdict — Accepted, Wrong Answer, Time Limit Exceeded, and so on — usually within a few seconds. Contests add a clock and a live leaderboard.

Two things make it a real design problem. First, **every submission is hostile code**: it may loop forever, allocate 10 GB, fork-bomb, print without end, or try to reach the network, and we run it a million times a day. Second, **submissions arrive in bursts that must each end in exactly one verdict**: a weekly contest turns 12 submissions a second into 170 within a minute, judge machines crash mid-run, and browsers retry on flaky Wi-Fi — yet nobody's submission may be lost, judged twice, or stuck on "Running" forever.

This document describes the production design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Valkey + Docker + React implementation actually does.

**Learning goals**

- Isolating untrusted code: containers, gVisor and microVMs, seccomp, cgroup limits, and what each one does and does not stop.
- A durable work queue built on the database itself: `FOR UPDATE SKIP LOCKED`, leases, heartbeats, fencing tokens, bounded retries and a dead-letter outcome.
- Idempotent submission: client idempotency keys and database-enforced deduplication instead of check-then-act.
- Judging correctness: fair timing, output checkers, and turning container outcomes into verdicts.
- Contest leaderboards that stay fast under thousands of readers.

## Requirements

### Functional requirements

1. **Browse problems**: filter by difficulty and search by title; read a statement with examples and constraints.
2. **Run**: execute code against the sample cases (or custom input) and see per-case output, without recording a submission.
3. **Submit**: judge code against all hidden test cases in Python, JavaScript, C++ or Java, and show progress ("test 3 of 10") and a verdict.
4. **Progress**: per-user solved and attempted problems, best runtime, submission history.
5. **Contests**: timed contests with a scoreboard ranked by problems solved and penalty time.
6. **Admin**: add problems and test data, view system statistics, rejudge after fixing test data.

Out of scope: plagiarism detection, discussion forums, interview-style live collaboration, paid tiers.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Verdict latency | p50 < 3 s, p95 < 10 s for typical problems | People resubmit in a tight edit-run loop |
| Queue wait during contests | p95 < 10 s from submit to first test | The scoreboard is a race; waiting is unfair |
| API latency | p99 < 200 ms for reads, < 300 ms for submit | Submit only enqueues; judging is asynchronous |
| Durability | A submission that got `202` is never lost and gets exactly one final verdict | Contest results and streaks depend on it |
| Isolation | No network, no access to other submissions or the host; an escape needs two independent bugs | We execute arbitrary code from anyone |
| Fairness | Rerunning the same code varies < 10% in measured time | Runtime percentiles and time limits must mean something |
| Availability | 99.9% for submit and judge; browsing survives a judge outage | Judging may slow down, but must not take the site with it |
| Scoreboard freshness | < 10 s behind during contests | Contestants watch it constantly |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Users | 10M registered, 500K daily active | Session store and per-user rate limits in Redis |
| Submissions | 1M/day → ~12/s average; contest peak 10K/min → ~170/s | Size judges for the peak, not the average |
| Sample runs | ~3 per submission → ~500/s at contest peak, ~3 tests each | A separate, cheaper path: a lost run is harmless |
| Sandbox time per submission | ~2 s median (compile, ~50 tests), up to 15 s | Little's law: 170/s × 2 s = 340 busy sandboxes |
| Busy sandboxes at peak | 340 for submissions + ~250 for runs → ~600, plan 800 | ~800 vCPUs and ~400 GB RAM of judge hosts during a contest; ~60 vCPUs otherwise |
| Queue writes | ~5 row writes per submission (insert, claim, heartbeat, verdict, progress) | 170/s × 5 ≈ 850 writes/s: comfortable for one PostgreSQL primary |
| Status polls | ~1,000 submissions in flight × 1 poll/s | ~1K req/s of Redis GETs — trivial |
| Scoreboard reads | 50K contestants, refresh every 15 s while visible | ~1.5K req/s, served from 5 s cached pages |
| Submission storage | ~2 KB each × 1M/day ≈ 2 GB/day ≈ 730 GB/year | Partition by month; archive old partitions |
| Test data | 3,000 problems × ~50 cases, up to 10 MB each → ~10 GB | Object storage, cached on judge hosts by version |

Contests are scheduled, so the 14× peak is predictable: judge pools are scaled up 30 minutes before the start instead of reacting to queue depth after the burst has already arrived.

### Local Development Scale

One API process (which can also judge), optional standalone judge workers, PostgreSQL, Valkey, and the Docker daemon on the same machine, at most 4 sandbox containers at a time per process. Fifteen seeded problems and two users. The queue, leases and idempotency rules are identical to production; only the sandbox runtime, the scale and the contest features differ. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │ Coder's browser · React SPA                                          │
  │ editor · verdict panel · contest standings                           │
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

1. **Submit and poll (1).** The browser posts the code with an `Idempotency-Key`. The Submission API inserts one row into `submissions` — that row *is* the job in the judge queue — and fires `pg_notify` in the same transaction, then answers `202` with the submission id. The browser then polls `GET /submissions/{id}/status`, which is a Redis read.
2. **Judge (2).** A judge worker, woken by the notification, claims the row with `FOR UPDATE SKIP LOCKED` and a lease, fetches the problem's test data (cached on the host), compiles once and runs each test in a fresh sandbox. It publishes progress to Redis and writes the verdict back to PostgreSQL, guarded by its lease token; during a contest it also updates the scoreboard sorted set.
3. **Standings (3).** Contestants read the scoreboard from the Contest Service, which serves pages of a Redis sorted set (cached for 5 s) and the caller's own rank.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| CDN | JS bundles, problem statements | Page views | Statements change rarely; cache with versioned URLs |
| API gateway | TLS, session check, per-user rate limits | Requests | Rejects floods before they reach the database |
| Submission API | Problems, submit, run, status, history | Requests (~2K/s at peak) | Stateless; never touches a sandbox |
| Contest Service | Contest clock, registration, standings | Scoreboard readers | Reads Redis; rebuilds from PostgreSQL if Redis is lost |
| PostgreSQL | Source of truth: users, problems, submissions, contest results; the judge queue | Writes (~850/s at peak) | Primary + replicas for history; monthly partitions |
| Redis | Sessions, status cache, rate-limit counters, standings, sample-run queue | Polls and scoreboard reads | Losing it slows reads; it never holds the only copy of a verdict |
| Judge workers | Claim jobs, compile, run, check, write verdicts | Queue depth and wait time | Per-language pools on dedicated hosts; pre-scaled before contests |
| Sandboxes | Execute one submission with no network and hard limits | Concurrent submissions | gVisor (`runsc`) per submission; never reused across submissions |
| Object storage | Test data, versioned per problem | Problems | Workers cache `(problem, version)` on local SSD |

"Why is the Submission API not allowed to run code?" Because anything that can start a sandbox can, through a sandbox or runtime bug, become the host. API servers hold session secrets and database credentials; judge hosts hold nothing but test data and a database role that can only touch the queue columns. Sample runs therefore also go to the judge fleet — through a Redis stream rather than the database, because a lost run costs the user one click, while a lost submission costs them a contest.

## Core Components / Request Flows

### Flow 1: creating a submission

```
 Browser                    Submission API                          PostgreSQL    Redis
    │                              │                                     │          │
    │ 1 POST /submissions (key K)  │                                     │          │
    │─────────────────────────────▶│                                     │          │
    │                              │ 2 INSERT … ON CONFLICT DO NOTHING   │          │
    │                              │────────────────────────────────────▶│          │
    │                              │ 3 1 row (0 → replay/422/duplicate)  │          │
    │                              │◀────────────────────────────────────│          │
    │                              │ 4 attempts+1, pg_notify, COMMIT     │          │
    │                              │────────────────────────────────────▶│          │
    │                              │ 5 SET status pending NX                        │
    │                              │───────────────────────────────────────────────▶│
    │ 6 202 {submissionId}         │                                     │          │
    │◀─────────────────────────────│                                     │          │
    │                              │                                     │          │
```

- The browser generates the key once per click of Submit (`crypto.randomUUID()`), and every retry of that attempt sends the same key.
- Step 2 runs against two unique indexes. `(user_id, idempotency_key)` turns a retried request into a lookup of the row the first attempt created: same body → replay the original `202`; different body → `422`. `(user_id, problem_id, language, code_hash) WHERE status IN ('pending','running')` makes the same code for the same problem impossible to queue twice at once → `200` with the in-flight submission.
- Because the unique index arbitrates, two concurrent identical requests cannot both insert: the second waits for the first transaction to commit and then sees the conflict. There is no read-then-write window.
- `pg_notify` is transactional: PostgreSQL delivers it only if the row commits, so an idle worker never wakes for a submission that does not exist. Step 5 seeds the status cache with `NX` so it can never overwrite progress that a fast worker already wrote.

### Flow 2: judging a submission

```
PostgreSQL                             Judge worker                            Sandbox    Redis
     │                                       │                                    │         │
     │ 1 NOTIFY judge_queue                  │                                    │         │
     │──────────────────────────────────────▶│                                    │         │
     │ 2 claim … FOR UPDATE SKIP LOCKED      │                                    │         │
     │◀──────────────────────────────────────│                                    │         │
     │ 3 job + lease token t                 │                                    │         │
     │──────────────────────────────────────▶│                                    │         │
     │                                       │ 4 compile once                     │         │
     │                                       │───────────────────────────────────▶│         │
     │                                       │ 5 progress: test i of n                      │
     │                                       │─────────────────────────────────────────────▶│
     │                                       │ 6 run test i in a fresh container  │         │
     │                                       │───────────────────────────────────▶│         │
     │                                       │ 7 stdout, exit code, OOM flag      │         │
     │                                       │◀───────────────────────────────────│         │
     │ 8 heartbeat: lease += 30 s (token t)  │                                    │         │
     │◀──────────────────────────────────────│                                    │         │
     │ 9 verdict … WHERE lease_token = t     │                                    │         │
     │◀──────────────────────────────────────│                                    │         │
     │                                       │ 10 SET verdict (terminal)                    │
     │                                       │─────────────────────────────────────────────▶│
     │                                       │                                    │         │
```

The submissions table is the queue. A row moves through a small state machine:

```
pending ──claim──▶ running ──verdict──▶ accepted | wrong_answer | time_limit_exceeded | ...
   ▲                  │
   └──retry (backoff)─┤ sandbox unavailable, attempts left
                      └──lease expired (worker died) ──▶ claimable again
```

- **Claim (step 2).** `UPDATE submissions SET status='running', lease_expires_at=now()+30s, lease_token=lease_token+1, judge_attempts=judge_attempts+1 … FROM (SELECT id … WHERE pending and due OR running with an expired lease ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED)`. `SKIP LOCKED` lets hundreds of workers poll at once without blocking on, or double-claiming, the same row.
- **Lease and heartbeat (step 8).** A claim is a 30-second lease that the worker extends every 10 s while it runs tests. If a judge host dies, its leases lapse and any other worker re-claims the rows.
- **Fencing (step 9).** Every claim increments `lease_token`. A worker writes its verdict with `WHERE lease_token = t`, so a worker that stalled past its lease (a long GC pause, a network partition) and was replaced cannot overwrite the new owner's verdict — its write matches zero rows and is discarded. The verdict and the user's solved status commit in one transaction.
- **Retries and the dead-letter outcome.** A sandbox failure (Docker daemon down, image pull failed, circuit breaker open) is never the user's fault, so the job goes back to `pending` with `run_after = now() + 5 s × 2^(attempt−1)`, never sooner than the breaker's 30 s reset. After 3 attempts it becomes a final `system_error` the user can see. A job whose attempts are already used up when it is claimed — typically code that crashed the worker itself — is failed without running it again.
- **Compile once, run each test fresh.** C++ and Java compile in one sandbox; each test then runs in a fresh one from the same build, so no state survives between tests. Tests run sequentially and stop at the first failure.
- **Test data.** Workers fetch test files from object storage by `(problem_id, test_set_version)` and keep them on local SSD; a test-data fix bumps the version, so no worker can judge against a stale copy.

### Flow 3: polling for the verdict

```
 Browser                            Submission API                                Redis   PostgreSQL
    │                                      │                                        │          │
    │ 1 GET /submissions/{id}/status       │                                        │          │
    │─────────────────────────────────────▶│                                        │          │
    │                                      │ 2 GET submission:{id}:status           │          │
    │                                      │───────────────────────────────────────▶│          │
    │                                      │ 3 hit: running, test 3 of 10, user_id  │          │
    │                                      │◀───────────────────────────────────────│          │
    │ 4 200 + Retry-After: 1 (owner only)  │                                        │          │
    │◀─────────────────────────────────────│                                        │          │
    ································ cache miss or Redis down ··································
    │                                      │ 5 SELECT status, user_id … WHERE id = $1          │
    │                                      │──────────────────────────────────────────────────▶│
    │                                      │ 6 row                                             │
    │                                      │◀──────────────────────────────────────────────────│
    │ 7 200, or 404 if not the owner       │                                        │          │
    │◀─────────────────────────────────────│                                        │          │
    │                                      │                                        │          │
```

- The status endpoint is the hottest read in the system (~1K req/s at peak). It reads Redis first and falls back to PostgreSQL, the source of truth, on a miss or when Redis is down.
- Cache entries carry the owner's user id, so the access check needs no query. Anyone else gets `404`, not `403`, so ids cannot be probed.
- Entries only move forward: progress writes go through a small Lua compare-and-set that refuses to replace a cached verdict, so a late write from a worker that lost its lease cannot turn "Accepted" back into "Running".
- While the submission is pending or running, the response carries `Retry-After: 1`; clients back off from 0.5 s to 5 s and stop at a terminal status.

## Database Schema

### Production schema

```sql
CREATE TABLE problems (
  id                UUID PRIMARY KEY,
  slug              VARCHAR(100) UNIQUE NOT NULL,
  title             VARCHAR(255) NOT NULL,
  statement_md      TEXT NOT NULL,
  difficulty        VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  time_limit_ms     INTEGER NOT NULL DEFAULT 2000,   -- per test, scaled per language
  memory_limit_mb   INTEGER NOT NULL DEFAULT 256,
  checker           VARCHAR(20) NOT NULL DEFAULT 'exact',  -- exact | unordered | float | program
  test_set_version  INTEGER NOT NULL DEFAULT 1       -- bumped on every test-data change
);

CREATE TABLE test_cases (
  problem_id        UUID REFERENCES problems(id),
  test_set_version  INTEGER NOT NULL,
  ordinal           INTEGER NOT NULL,
  input_key         TEXT NOT NULL,                   -- object-storage keys, not inline data
  expected_key      TEXT NOT NULL,
  is_sample         BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (problem_id, test_set_version, ordinal)
);

CREATE TABLE submissions (
  id                UUID NOT NULL,
  user_id           UUID NOT NULL,
  problem_id        UUID NOT NULL,
  contest_id        UUID,
  language          VARCHAR(20) NOT NULL,
  code              TEXT NOT NULL,
  status            VARCHAR(30) NOT NULL DEFAULT 'pending',
  test_cases_passed INTEGER, test_cases_total INTEGER,
  runtime_ms        INTEGER, memory_kb INTEGER, error_message TEXT,
  idempotency_key   VARCHAR(255), request_hash CHAR(64), code_hash CHAR(64),
  run_after         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- queue: earliest (re)try
  lease_owner       VARCHAR(100), lease_expires_at TIMESTAMPTZ,
  lease_token       INTEGER NOT NULL DEFAULT 0,          -- fencing token
  judge_attempts    INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);                     -- one partition per month

-- The queue: small partial indexes over the few rows that are in flight
CREATE INDEX submissions_queue ON submissions (run_after, created_at) WHERE status = 'pending';
CREATE INDEX submissions_leases ON submissions (lease_expires_at) WHERE status = 'running';
CREATE INDEX submissions_history ON submissions (user_id, problem_id, created_at DESC);

CREATE TABLE contest_results (
  contest_id   UUID, user_id UUID, problem_id UUID,
  wrong_before_accept INTEGER NOT NULL DEFAULT 0,
  accepted_at  TIMESTAMPTZ,
  PRIMARY KEY (contest_id, user_id, problem_id)
);
```

Two production details deserve a note. Unique indexes on a partitioned table must include the partition key, so the idempotency rules live on the current partition plus a small `submission_keys (user_id, idempotency_key)` table in the same transaction. And the queue never scans history: both queue indexes are partial, so they contain only the few hundred rows that are pending or running, whatever the table size.

| Redis key | Holds | TTL |
|-----------|-------|-----|
| `sess:{sid}` | Session | 7 days |
| `submission:{id}:status` | `{user_id, status, current_test, verdict…, terminal}` | 30 s while running, 5 min once terminal |
| `rl:{user}:{route}` | Rate-limit window | Window length |
| `contest:{id}:standings` | Sorted set: member = user, score = solved and penalty | Contest end + 1 day |
| `standings:{id}:page:{n}` | Rendered page of 50 rows | 5 s |
| `problem:v2:{slug}` | Public problem view (no solutions) | 5 min |

### Local schema

The local schema in [`backend/src/db/init.sql`](./backend/src/db/init.sql) is re-runnable (`IF NOT EXISTS`, guarded constraints) and keeps the same queue and idempotency columns on an unpartitioned `submissions` table, so the unique indexes can live directly on it:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_idempotency_key
  ON submissions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_in_flight
  ON submissions (user_id, problem_id, language, code_hash)
  WHERE status IN ('pending', 'running') AND code_hash IS NOT NULL;
```

| Production | Local |
|------------|-------|
| `test_cases` with object-storage keys and `test_set_version` | Inline `input` / `expected_output` columns, no versions |
| `checker` with `float` and `program` checkers | `checker IN ('exact', 'unordered')`; floats compared with a tolerance by the exact checker |
| Monthly partitions, `submission_keys` side table | One table with both unique indexes |
| `contest_results`, contests tables | Not present — no contests locally |
| Reference solutions stored with problems | `solution_*` columns, never returned by the public API |

## API Design

### Production API

```
POST /api/v1/submissions               Idempotency-Key → 202 {submissionId} | 200 duplicate | 404 | 422 | 429
GET  /api/v1/submissions/{id}/status   → {status, current_test, test_cases_total, verdict fields}; Retry-After while running
GET  /api/v1/submissions/{id}          → code, verdict, failing test summary (owner or admin)
GET  /api/v1/users/me/submissions?cursor=…&limit=20   → keyset pagination on (created_at, id)
POST /api/v1/runs                      → 202 {runId}; GET /api/v1/runs/{id} → per-sample results (10 min TTL)
GET  /api/v1/problems?difficulty&q&cursor   → catalog index
GET  /api/v1/problems/{slug}           → statement, samples, limits (never solutions or hidden tests)
GET  /api/v1/contests/{id}/standings?page=1 → 50 rows + caller's rank; cached 5 s
POST /api/v1/admin/problems/{id}/rejudge     → resets affected submissions to pending
```

A submit request and its three possible answers:

```
POST /api/v1/submissions
Idempotency-Key: 7f8c2a8e-1b9d-4c43-9d55-0c3c1d2b4e6f
{"problemSlug": "two-sum", "language": "python", "code": "..."}

202 {"submissionId": "c1a906a4-…", "status": "pending"}                  first attempt
202 {"submissionId": "c1a906a4-…", "status": "running"}                  retry, header Idempotent-Replayed: true
422 {"error": "Idempotency-Key was already used with a different request body"}
```

### Local routes

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/v1/auth/register`, `/login`, `/logout`; GET `/me` | Session cookie; login counts only failed attempts toward its limit |
| GET | `/api/v1/problems`, `/problems/:slug`, `/problems/:slug/submissions` | `limit` capped at 500; problem view cached 5 min |
| POST | `/api/v1/problems` | Admin; problem and test cases in one transaction |
| POST | `/api/v1/submissions` | `Idempotency-Key` optional but sent by the SPA |
| POST | `/api/v1/submissions/run` | Synchronous sample run; `503` + `Retry-After` when the sandbox is down |
| GET | `/api/v1/submissions/:id`, `/:id/status` | Owner or admin; `404` otherwise |
| GET | `/api/v1/users/:id/profile`, `/:id/submissions`, `/:id/solved`, `/me/progress` | |
| GET/POST | `/api/v1/admin/stats`, `/users`, `/submissions`, `/leaderboard`, `/cache/clear` | Admin only |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics` | |

## Key Design Decisions

### 1. Sandbox: gVisor per submission on dedicated hosts, not plain containers or microVMs

Plain Docker (`runc`) gives namespaces, cgroups, a default seccomp profile and dropped capabilities, and the local implementation adds no network, a read-only root, a non-root user and a 64 MB `/tmp`. That stops the everyday attacks — fork bombs (pids limit), memory bombs (cgroup memory, OOM kill), infinite loops (wall-clock kill), output floods (1 MiB cap), network calls (no interface). What it does not stop is a kernel bug: every container shares the host kernel, and container escapes through kernel or runtime bugs (CVE-2019-5736 overwrote the host's `runc` binary; CVE-2022-0185 was a heap overflow reachable from a container) turn one malicious submission into a compromised judge host. At a million executions a day, someone will try.

gVisor's `runsc` runtime puts a user-space kernel between the program and the host, so a kernel bug in the guest syscall path compromises gVisor, not the host. It is a drop-in OCI runtime that Docker can select per container, and it costs little for CPU-bound code; syscall-heavy programs (lots of small reads and writes) run measurably slower, so time limits are calibrated on the gVisor fleet. Firecracker microVMs give an even stronger hardware-virtualization boundary with fast boots (about 125 ms) and small overhead (under 5 MiB per VM), at the price of running a VM fleet — images, networking, snapshot management. I would start with gVisor and keep Firecracker as the option if the threat model hardens.

Defense in depth matters more than the runtime choice: judge hosts run nothing else, hold no secrets, have no route to internal networks, and are recycled regularly. What we give up is per-test cost: a fresh sandbox per test is slower than one process per test, which pre-warmed sandbox pools (booted ahead of time, never reused across submissions) hide.

### 2. The submissions table is the queue, not Kafka or RabbitMQ

The job is created in the same transaction as the submission, so there is no dual write: a submission cannot exist without its job, and a job cannot exist without its submission. With a separate broker, the API would insert the row and then publish — and a crash or broker outage between the two leaves a submission `pending` forever (the previous version of this project had exactly that bug). Fixing it properly needs a transactional outbox and a relay, which is more machinery than the queue itself.

Kafka is a particularly poor fit for this job. A partition is consumed in order and its progress is a single offset, so one 15-second C++ submission blocks every message behind it on that partition, and offsets cannot be committed out of order. Parallelism equals the partition count, so 800 concurrent sandboxes would need 800 partitions. And a consumer that spends longer than `max.poll.interval.ms` on a message is evicted, triggering a rebalance and a redelivery storm exactly when the system is busiest. Kafka is a log; judging needs per-message acknowledgement and redelivery after a timeout — which is what a lease gives us. RabbitMQ or SQS do provide that, and would be the choice if dispatch outgrew the database; they still need the outbox.

At 170 submissions a second and about 850 row writes a second, PostgreSQL is far from its limits, and the queue state is queryable with SQL — "what is stuck, and since when" is one `SELECT`. What we give up: an idle worker learns about new work through `LISTEN/NOTIFY` (with polling as the fallback), the queue load lands on the primary, and there is no replayable log — a rejudge is an `UPDATE … SET status = 'pending'` over the affected rows.

### 3. Idempotency enforced by unique indexes, not by a cache check

The earlier design hashed `(user, problem, code, language)`, looked the hash up in Redis, and wrote it after inserting the submission. Concurrent identical requests all passed the lookup before any of them wrote it: in a local test, eight identical requests created four submissions. Moving both rules into unique indexes inside the creating transaction closes the window completely, because the database serializes the conflicting inserts. It also separates two different questions: "is this the same request?" (the idempotency key, safe to replay forever) and "is the same code already being judged?" (the in-flight index, which stops caring as soon as a verdict lands, so a deliberate resubmission later is judged again). What we give up is a little write amplification — three hash and key columns and two more indexes on the hottest table.

### 4. Polling with backoff and a Redis status cache, not WebSockets

Judging takes 2–15 seconds and produces a handful of state changes, so a client that polls at 0.5 s, 1 s, 1.5 s, 2 s and then every few seconds sees each change within about a second. At ~1,000 in-flight submissions that is ~1K Redis reads per second. A WebSocket per open editor tab — hundreds of thousands at peak — would cost connection state on every API server, sticky routing or a pub/sub fan-out layer, and reconnection logic, to shave a second off a result the user waits seconds for anyway. If contests later need instant "your submission was accepted" banners, Server-Sent Events from the Contest Service would be the next step: one-way, proxy-friendly, resumable with `Last-Event-ID`.

### 5. Fair timing: sequential tests, pinned CPU, per-language limits

Tests for one submission run one at a time on a dedicated CPU, and the first failure stops the run. Running tests in parallel would finish sooner but make the measured runtime depend on what else shared the core — two identical submissions could differ by 30%, which makes "beats 80% of submissions" meaningless and turns borderline time limits into a coin toss. Early exit means most failing submissions (wrong answers usually fail in the first few tests) cost a fraction of a full run. Interpreted languages get a multiplier on the problem's time limit because the same algorithm runs several times slower in Python than in C++. What we give up is latency for long accepted runs; the reported runtime is the slowest test, which is also what the time limit is checked against.

### 6. Output checking that is tolerant of formatting, strict about content

Outputs are compared token by token after normalizing line endings and trailing whitespace. Numbers are compared with a 1e-6 relative tolerance only when one side is a decimal, JSON arrays and objects are compared structurally, and element order is ignored only for problems marked `unordered` ("return the answer in any order"). The previous comparator sorted every array and parsed outputs with `parseFloat`, which accepted an unmerged list for "Merge Two Sorted Lists" and any output whose first number matched. Problems with many valid answers get a checker program — trusted code written by the problem setter that runs in the sandbox like a submission.

### 7. Contest standings in a Redis sorted set

```
Judge worker                         Redis                   Contest Service                 Browser
      │                                │                            │                           │
      │ 1 first AC: ZADD contest:{id}  │                            │                           │
      │───────────────────────────────▶│                            │                           │
      │                                │                            │ 2 GET …/standings?page=1  │
      │                                │                            │◀──────────────────────────│
      │                                │ 3 GET page 1 (cached 5 s)  │                           │
      │                                │◀───────────────────────────│                           │
      │                                │ 4 miss                     │                           │
      │                                │───────────────────────────▶│                           │
      │                                │ 5 ZREVRANGE 0 49           │                           │
      │                                │◀───────────────────────────│                           │
      │                                │ 6 ZREVRANK me              │                           │
      │                                │◀───────────────────────────│                           │
      │                                │                            │ 7 top 50 + your rank      │
      │                                │                            │──────────────────────────▶│
      │                                │                            │                           │
```

ICPC-style ranking orders by problems solved (descending), then penalty (ascending): minutes from the contest start to each accepted solution, plus 20 minutes per rejected attempt before it. Both fit in one sorted-set score, `solved × 10^9 − penalty_seconds`, so `ZADD` keeps the ranking current on every first accept, `ZREVRANGE` returns a page in O(log N + 50), and `ZREVRANK` gives a contestant their own rank without scanning anything. Computing the same ranking in SQL is a sort over every participant's results on every request: 50K participants at 1.5K requests a second is 75 million rows sorted per second. A materialized view refreshed every few seconds avoids that but rebuilds the whole ranking for each refresh. The sorted set is a read model: `contest_results` in PostgreSQL stays the source of truth, written in the same transaction as the verdict, and the sorted set can be rebuilt from it if Redis is lost. During the last hour of a contest the public scoreboard freezes (served from a snapshot) while the real set keeps updating.

## Consistency and Idempotency

- **Exactly one verdict per submission.** Delivery to workers is at-least-once (a lease can expire while a slow worker is still judging), but the verdict write is fenced by the lease token, so only the current owner's verdict commits. At-least-once judging plus a fenced write gives effectively-once verdicts.
- **Exactly one submission per click.** The client sends one `Idempotency-Key` per submit attempt and reuses it on every retry; the unique index makes concurrent and late retries return the original submission. A reused key with a different body is `422`.
- **No double judging of identical code.** The partial unique index on in-flight rows returns the queued submission for an identical resubmission while it is pending or running.
- **Progress is counted once.** Attempts are incremented when the submission row is created, in the same transaction; the solve (status, best runtime, `solved_at`) is recorded in the verdict transaction. A retried judging attempt cannot count twice.
- **Caches are never the only copy.** The status cache and the scoreboard are read models: the verdict commits to PostgreSQL first, and cache entries are rebuilt from it on a miss. Cache writes only move forward (NX for the initial entry, a compare-and-set for progress).
- **Graceful shutdown hands work back.** A stopping worker finishes the current test, returns its job to `pending` immediately and refunds the attempt, instead of leaving it to wait out the lease.

## Security / Auth

- **Untrusted code**: see decision 1. Per-test limits on CPU, memory (no swap), processes (50), output (1 MiB stdout), wall-clock time; no network; read-only filesystem except a small tmpfs; non-root user; `no-new-privileges`; all capabilities dropped. Judge hosts have no secrets and a database role restricted to the queue columns.
- **Authentication**: server-side sessions in Redis, `HttpOnly` and `SameSite=Lax` cookies, bcrypt password hashes.
- **Authorization**: a submission's code, status and errors are visible only to its owner and admins; everyone else gets `404`. Reference solutions and hidden tests never leave the server — the public problem view selects explicit columns. During contests, failing-test details are hidden until the contest ends.
- **Rate limits**: per user for submits (10/min) and runs (30/min), per IP for failed logins (5 per 15 min) and registrations (5/hour), and a general per-user ceiling. In production these counters live in Redis so every API instance enforces the same budget, and responses carry `RateLimit` and `Retry-After` headers.
- **Input limits**: 64 KB of source per submission, an allow-list of languages, idempotency keys of at most 255 visible ASCII characters.

## Observability

| Signal | What it tells us | Alert |
|--------|------------------|-------|
| `judge_queue_depth` | Pending submissions | Above the pool's 1-minute capacity |
| `judge_queue_wait_seconds` | Time from eligible to claimed | p95 > 10 s during a contest, > 30 s otherwise |
| `judge_jobs_total{outcome}` | completed, retried, dead_lettered, lease_lost, released | Any sustained `dead_lettered` or `lease_lost` |
| `submissions_total{status, language}` | Verdict mix | `system_error` > 1% |
| `code_execution_duration_seconds` | Per-test runtime by language | p95 drift after a sandbox or kernel upgrade |
| `circuit_breaker_state` | Sandbox health per worker | Open for more than 1 minute |
| `docker_containers_active` | Busy sandboxes per host | Near the host's slot count |
| `http_request_duration_seconds` | API latency by route | Status endpoint p99 > 50 ms |

Logs are structured JSON (Pino) with the submission id, attempt number, worker id and verdict. Health checks are split: `/health/live` only says the process is up, `/health/ready` checks PostgreSQL and Redis, and `/health` adds the sandbox breaker state and the worker's active jobs. A sandbox outage therefore does not make the API unready: browsing and polling keep working while judging catches up.

## Failure Handling

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Judge host crashes mid-run | That submission takes ~30 s longer | Lease expires; another worker re-claims and judges from scratch |
| Docker or gVisor unhealthy on a host | Slower verdicts | Circuit breaker opens; jobs go back with backoff; the host is drained |
| Code that crashes the worker itself | One `system_error` verdict | Attempts are counted at claim time; after 3 the job fails without running |
| Worker stalls past its lease, then wakes | Nothing | Its heartbeat and verdict carry a stale token and are rejected |
| PostgreSQL primary failover | Submit returns `503` for ~30 s; polls served from Redis | Workers' claims fail and retry; nothing in flight is lost |
| Redis down | Logged-out users, slower polls, frozen scoreboard | Polls fall back to PostgreSQL; standings rebuilt from `contest_results` |
| NOTIFY lost or listener disconnected | Up to one poll interval of extra latency | Workers poll every 2 s and reconnect the listener |
| Contest-start burst | Queue wait rises | Pools pre-scaled; per-user limits keep one user from taking every slot |
| Output flood or fork bomb | `Output Limit Exceeded` / `Runtime Error` | Caps enforced per sandbox; the host is unaffected |

## Scalability Considerations

1. **Judge capacity first.** Workers scale per language pool on queue wait time; for contests the pools are scaled from the schedule ahead of time. Python is about 70% of submissions, so its pool is the one that grows.
2. **Queue on the primary.** Claims and verdicts must hit the primary, which comfortably handles the ~850 writes/s of a contest peak. Beyond several thousand jobs a second I would move dispatch to SQS or RabbitMQ behind a transactional outbox and keep the same lease and fencing rules.
3. **Reads off the primary.** Submission history and profiles read from replicas; problem statements from the CDN; status and standings from Redis.
4. **History growth.** Monthly partitions keep indexes small and make archiving old code a partition detach.
5. **Redis.** Status entries are tiny and short-lived; sorted sets are per contest. A small cluster handles both, sharded by key.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Isolation | gVisor per submission on dedicated hosts | Plain containers; Firecracker | Survives a kernel bug; cheaper to run than a VM fleet |
| Job queue | Submissions table + SKIP LOCKED leases | Kafka; RabbitMQ with an outbox | No dual write; per-job leases; ample headroom at 170 jobs/s |
| Exactly-one verdict | Lease token fences the verdict write | Trusting the queue's delivery | Redelivery is inevitable; the stale writer must lose |
| Idempotency | Client key + unique indexes | Content hash checked in Redis | No check-then-act race; retries and resubmits are distinct |
| Verdict delivery | Polling with backoff + Redis status | WebSockets | Seconds-long jobs; no connection state on API servers |
| Test execution | Sequential, pinned CPU, early exit | Parallel tests | Reproducible timing; failing runs cost less |
| Output checking | Token and JSON comparison, per-problem modes | Byte equality; global sorting | Ignores formatting noise without accepting wrong answers |
| Standings | Redis sorted set, rebuilt from PostgreSQL | SQL ranking per request | O(log N) rank queries for thousands of readers |
| Sample runs | Redis stream to the judge fleet | Running code on API servers | API hosts never execute untrusted code |

## Implementation Notes

The local project implements the submission path, the queue and the sandbox described above at small scale; contests do not exist locally. Everything runs as one Express API that can also judge, optional standalone workers, PostgreSQL, Valkey and the local Docker daemon.

### Production patterns actually implemented

**Judge queue on PostgreSQL** — [`shared/judgeQueue.ts`](./backend/src/shared/judgeQueue.ts) and [`worker/judgeWorker.ts`](./backend/src/worker/judgeWorker.ts). Claims use `FOR UPDATE SKIP LOCKED` with a 30 s lease (`JUDGE_LEASE_MS`), heartbeats every 10 s, a fencing token checked by every write, `JUDGE_MAX_ATTEMPTS` (default 3) before a final `system_error`, exponential backoff that respects the circuit breaker, and an optional `WORKER_LANGUAGES` filter for per-language pools. Workers wake on `LISTEN judge_queue`, re-open the listener when it drops, and poll every `JUDGE_POLL_MS` (2 s) regardless. On shutdown they finish the current test, release the job and refund the attempt. The API runs a worker in-process by default (`EMBEDDED_WORKER`); `npm run dev:worker1` / `dev:worker2` run standalone workers.

```sql
-- The verdict commits only if this worker still holds the lease it claimed
UPDATE submissions SET status = $3, ... WHERE id = $1 AND lease_token = $2 AND status = 'running'
```

**Idempotent submission** — [`services/submissionService.ts`](./backend/src/services/submissionService.ts) inserts with `ON CONFLICT DO NOTHING`, resolves conflicts to a replay, `422` or the in-flight duplicate, counts the attempt and calls `pg_notify`, all in one transaction. Keys are validated by [`shared/idempotency.ts`](./backend/src/shared/idempotency.ts).

**Sandbox** — [`services/codeExecutor.ts`](./backend/src/services/codeExecutor.ts) compiles C++ and Java once per submission and runs each test in a fresh container as uid 65534, with no network, a read-only root and read-only `/code`, a 64 MB `/tmp` tmpfs, all capabilities dropped, `no-new-privileges`, 50 pids, half a CPU, and memory without swap. [`services/dockerStream.ts`](./backend/src/services/dockerStream.ts) parses Docker's multiplexed attach stream (8-byte frame headers, frames split across chunks) and caps stdout at 1 MiB. Exit outcomes map to verdicts in `classifyRun`: output cap → OLE, our kill at the time limit → TLE, `OOMKilled` or a runtime's out-of-memory message → MLE, other non-zero exits → RE. Containers are labelled with the owning worker and removed on its next start if a crash left them running. `SANDBOX_RUNTIME=runsc` switches to gVisor; `SANDBOX_MAX_CONTAINERS` (default 4) bounds containers per process. Docker failures raise `SandboxUnavailableError`, which the worker retries and the run endpoint turns into `503` with `Retry-After`.

**Judging and checking** — [`services/judge.ts`](./backend/src/services/judge.ts) runs tests sequentially, stops at the first failure, reports the slowest test as the runtime, and names the failing test in the message. [`services/checker.ts`](./backend/src/services/checker.ts) implements the `exact` and `unordered` checkers; Two Sum is seeded as `unordered`.

**Status cache** — [`shared/submissionStatus.ts`](./backend/src/shared/submissionStatus.ts): `SET … NX` for the pending entry, a Lua compare-and-set for progress, verdicts cached 5 min; the route checks ownership against the cached `user_id` and falls back to PostgreSQL.

**Operational patterns** — Opossum circuit breaker around container runs ([`shared/circuitBreaker.ts`](./backend/src/shared/circuitBreaker.ts), opens at 50% failures over at least 5 calls, 30 s reset, no fallback so failures stay visible); Prometheus metrics including `judge_queue_depth`, `judge_queue_wait_seconds` and `judge_jobs_total` ([`shared/metrics.ts`](./backend/src/shared/metrics.ts)); Pino JSON logs; liveness, readiness and detailed health checks; graceful shutdown of HTTP, worker, pool and Redis; a Redis client that reconnects forever with capped backoff.

**Frontend** — React 19 with React Router (the editor page and admin page are lazy chunks: the initial bundle is ~106 KB gzipped instead of ~339 KB), a Zustand auth store, and a persisted Zustand draft store ([`stores/editorStore.ts`](./frontend/src/stores/editorStore.ts)) that keeps code per problem and language with a 500 ms debounce. Submitting generates one `Idempotency-Key` and retries network errors and `5xx` twice with the same key; [`hooks/useSubmissionStatus.ts`](./frontend/src/hooks/useSubmissionStatus.ts) polls with backoff from 0.5 s to 5 s, aborts in-flight requests on unmount and announces progress through an `aria-live` region. The problem list is a virtualized `<table>` that loads every catalog page.

### What was simplified or substituted

| Production | Local |
|------------|-------|
| gVisor sandboxes on dedicated judge hosts | Docker `runc` on the developer's machine (`SANDBOX_RUNTIME=runsc` if gVisor is installed) |
| Pre-warmed sandbox pools | A container is created per test; startup dominates fast solutions |
| CPU-time accounting on a pinned core | Wall-clock limit, half a CPU via cgroup quota; `memory_kb` is not measured (null) |
| Test data in object storage by version | `test_cases` rows in PostgreSQL; workers cache them for 60 s |
| Sample runs on the judge fleet via a Redis stream | `/submissions/run` executes synchronously in the API process, so the API needs the Docker socket |
| Redis-backed rate limits behind a gateway | `express-rate-limit` memory store: each API instance counts separately |
| Partitioned `submissions`, replicas, Redis cluster | One PostgreSQL, one Valkey |

### What was omitted

- Contests, the Contest Service, sorted-set standings and scoreboard freezes. The admin "leaderboard" is a SQL aggregate over `user_problem_status`.
- Checker programs and float-specific checkers; rejudge tooling; plagiarism detection.
- CDN, API gateway, autoscaling, multi-region, server-sent events.
- TanStack Query: the SPA keeps server data in component state plus the polling hook.

### Known limitations

- The Docker sandbox could not be run end to end in the environment where this pass was verified (no Docker daemon). The stream parser, verdict mapping, compile-once flow, container options, OOM and timeout handling are covered by unit tests against a fake Docker that emits real multiplexed frames; the queue, idempotency, authorization, retries, dead-lettering, lease fencing and NOTIFY wake-up were verified against a real PostgreSQL and Redis.
- The in-flight unique index means two identical submissions by one user cannot both be pending, so a future rejudge tool must reset them one at a time.
- Idempotency keys never expire; a status entry can show "running" for up to 30 s after a verdict if the Redis write of the verdict fails.
- Sessions live in Redis: restarting a Redis without persistence logs everyone out (Compose runs Valkey with AOF).
- Problem acceptance counts are cached for 5 minutes and computed with `COUNT(*)` on each miss.
- The `sandbox/` image and the Compose `sandbox` profile are not used by the executor, which starts stock language images.
