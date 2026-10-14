# 🧑‍💻 LeetCode (Online Judge) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "An online judge looks like a CRUD app with a 'run this code' button. Two things make it hard. Every submission is hostile code we have agreed to execute — it will loop forever, eat memory, fork-bomb and try the network, a million times a day. And submissions arrive in contest bursts that must each end in exactly one verdict, even when judge machines crash and browsers retry. So I'll spend most of my time on the sandbox and on the queue between the API and the judges, and finish with the contest scoreboard."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and why contests size the system |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives where, and the submit contract |
| Deep dive 1: the sandbox | 8 min | Isolation layers, verdicts, fair timing |
| Deep dive 2: the judge queue | 8 min | Exactly one verdict per submission |
| Deep dive 3: contest standings | 4 min | Ranking 50K contestants for 1.5K readers a second |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down what the judge has to do, because 'run code and compare output' hides most of the work."

### Functional requirements

1. **Browse** problems by difficulty and title; read statements, examples and limits.
2. **Run** code against the sample cases or custom input — no record kept.
3. **Submit** Python, JavaScript, C++ or Java against all hidden tests; show progress and a verdict: Accepted, Wrong Answer, Time / Memory / Output Limit Exceeded, Runtime Error, Compile Error.
4. **Progress**: solved and attempted problems, best runtime, history.
5. **Contests**: a clock and a scoreboard ranked by problems solved, then penalty time.

Out of scope: plagiarism detection, discussions, live pair-programming, billing.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Verdict latency | p50 < 3 s, p95 < 10 s | People iterate in a tight edit-submit loop |
| Contest queue wait | p95 < 10 s to the first test | The scoreboard is a race |
| API latency | p99 < 200 ms reads, < 300 ms submit | Submit only enqueues |
| Durability | A `202` is never lost and ends in exactly one verdict | Contest results depend on it |
| Isolation | No network, no host or neighbor access; escape needs two independent bugs | We run arbitrary code from anyone |
| Fairness | Same code, same runtime within 10% | Time limits and runtime rankings must mean something |
| Scoreboard | < 10 s behind during contests | Contestants refresh it constantly |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Users | 10M registered, 500K daily active | Sessions and rate limits in Redis |
| Submissions | 1M/day → 12/s average; 10K/min → 170/s at a contest start | Size for the peak; it is 14× the average |
| Sample runs | ~3 per submission → ~500/s at peak | Cheaper path: a lost run costs one click |
| Sandbox time | ~2 s per submission (compile + ~50 tests), up to 15 s | Little's law: 170/s × 2 s = 340 busy sandboxes |
| Peak sandboxes | ~340 submit + ~250 run → plan 800 | ~800 vCPUs and ~400 GB RAM of judges for a contest, ~60 vCPUs otherwise |
| Queue writes | ~5 row writes per submission | 170 × 5 ≈ 850 writes/s — fine for one PostgreSQL primary |
| Status polls | ~1,000 in flight × 1 poll/s | ~1K Redis reads/s |
| Scoreboard reads | 50K contestants, refresh every 15 s | ~1.5K req/s, from 5 s cached pages |
| Storage | ~2 KB × 1M/day ≈ 730 GB/year of submissions; ~10 GB of test data | Monthly partitions; test data in object storage |

"The number that drives everything is 800 busy sandboxes at a contest start. Two consequences: judging must be asynchronous and run on its own fleet, and because contests are scheduled, I can scale that fleet half an hour before the start instead of autoscaling after the burst arrives."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys that matter: submitting and polling, judging, and reading the scoreboard."

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

1. **Submit and poll (1).** The browser posts the code with an `Idempotency-Key`. The Submission API inserts one row into `submissions` — that row *is* the judge job — and fires `pg_notify` in the same transaction, then answers `202`. The browser polls the status endpoint, which reads Redis.
2. **Judge (2).** A judge worker, woken by the notification, claims the row with `FOR UPDATE SKIP LOCKED` and a lease, fetches test data (cached on the host), compiles once and runs each test in a fresh gVisor sandbox. Progress goes to Redis; the verdict goes back to PostgreSQL, guarded by the lease.
3. **Standings (3).** The Contest Service serves pages of a Redis sorted set that judges update on every first accepted solution.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, session check, rate limits | Requests | Floods stop here |
| Submission API | Problems, submit, status, history | ~2K req/s at peak | Stateless; never executes code |
| Contest Service | Clock, registration, standings | Scoreboard readers | Reads Redis; rebuilds from PostgreSQL |
| PostgreSQL | Users, problems, submissions, contest results; the judge queue | ~850 writes/s at peak | Primary + read replicas; monthly partitions |
| Redis | Sessions, status cache, rate limits, standings, sample-run stream | Polls, scoreboard reads | Never the only copy of a verdict |
| Judge workers | Claim, compile, run, check, write verdict | Queue wait | Per-language pools on dedicated hosts |
| Sandboxes | One submission, no network, hard limits | Concurrent jobs | gVisor; never reused across submissions |
| Object storage | Versioned test data | Problems | Cached on judge hosts by version |

"Why can't the API just run the code? Because anything that starts a sandbox can, through a sandbox bug, become the host — and API servers hold session secrets and database credentials. Judge hosts hold nothing but test data and a database role that can only touch queue columns. Sample runs go to the judge fleet too, through a Redis stream instead of the database, because losing a run costs the user one click."

### Flow 1: submitting

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

"The client generates one idempotency key per click and reuses it on retries. Step 2 runs into two unique indexes: one on the user and key, which turns a retry into a replay of the original response — or a `422` if the body changed — and a partial one on the user, problem, language and normalized code hash for rows that are still pending or running, which stops the same code from being queued twice. The database serializes the conflicting inserts, so there is no check-then-act window. And `pg_notify` is only delivered if the transaction commits."

### Flow 2: judging

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

"The claim is a 30-second lease that heartbeats extend every 10 seconds. Every claim increments a lease token — a fencing token — and the verdict write in step 9 only matches the row if the token is still ours. I'll come back to why that matters in the queue deep dive."

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

"This is the hottest endpoint — about a thousand requests a second at peak — so it's a Redis read with PostgreSQL as the fallback. The cached entry carries the owner's id, so access control costs nothing, and anyone else gets a `404` rather than a `403` so ids can't be probed. Cache writes only move forward: the worker's progress writes are a small compare-and-set that refuses to overwrite a verdict."

---

## 💾 Data Model (4 min)

"PostgreSQL holds everything that must be correct — including the queue — Redis holds copies and counters, and object storage holds test data."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `problems` | `id`, `slug` (unique), `difficulty`, `time_limit_ms`, `memory_limit_mb`, `checker`, `test_set_version` | `checker`: exact, unordered, float or a checker program |
| PostgreSQL | `test_cases` | `(problem_id, test_set_version, ordinal)` PK, object-storage keys, `is_sample` | A test-data fix bumps the version; nothing is edited in place |
| PostgreSQL | `submissions` | `id`, `user_id`, `problem_id`, `contest_id`, `language`, `code`, `status`, verdict fields | Partitioned by month on `created_at` |
| PostgreSQL | `submissions` (queue columns) | `run_after`, `lease_owner`, `lease_expires_at`, `lease_token`, `judge_attempts` | Partial indexes on pending rows `(run_after, created_at)` and running rows `(lease_expires_at)` — a few hundred rows, whatever the table size |
| PostgreSQL | `submissions` (dedupe columns) | `idempotency_key`, `request_hash`, `code_hash` | Unique `(user_id, idempotency_key)`; unique `(user_id, problem_id, language, code_hash)` while pending or running |
| PostgreSQL | `user_problem_status` | `(user_id, problem_id)` PK, status, attempts, best runtime, `solved_at` | Attempts counted at create; solve recorded with the verdict |
| PostgreSQL | `contest_results` | `(contest_id, user_id, problem_id)` PK, rejected attempts, `accepted_at` | Source of truth behind the scoreboard |
| Redis | `submission:{id}:status` | `{user_id, status, current_test, verdict, terminal}` | 30 s while running, 5 min once final |
| Redis | `contest:{id}:standings` | Sorted set, score = solved and penalty | Rebuilt from `contest_results` if lost |

"Why keep the queue in the submissions table? I'll defend it in deep dive 2, but the short version is that the job and the submission are created in one transaction, so neither can exist without the other. One wrinkle: on a partitioned table a unique index must include the partition key, so in production the idempotency keys live in a small side table written in the same transaction."

---

## 🔌 API Design (3 min)

```
POST /api/v1/submissions                Idempotency-Key → 202 {submissionId} | 200 duplicate | 422 | 429
GET  /api/v1/submissions/{id}/status    → status, test i of n, verdict; Retry-After: 1 while running
GET  /api/v1/submissions/{id}           → code, verdict, failing-test summary (owner or admin only)
GET  /api/v1/users/me/submissions?cursor&limit   → keyset pagination on (created_at, id)
POST /api/v1/runs                       → 202 {runId}; GET /api/v1/runs/{id} → per-sample results
GET  /api/v1/problems?difficulty&q&cursor        → catalog index
GET  /api/v1/problems/{slug}            → statement, samples, limits — never solutions or hidden tests
GET  /api/v1/contests/{id}/standings?page        → 50 rows + caller's rank
POST /api/v1/admin/problems/{id}/rejudge         → reset affected submissions to pending
```

- **Submit is `202`, not `200`.** The verdict doesn't exist yet; the response is a handle to poll.
- **Idempotency-Key with the IETF semantics**: same key and body → the stored response; same key, different body → `422`. Separately, identical code already in flight returns that submission with `200` instead of judging it twice.
- **Owner-only reads with `404`.** Someone else's code and failure details are private; during a contest, failing-test details stay hidden until it ends.
- **Rate limits** per user — 10 submits and 30 runs a minute — and per IP for failed logins, kept in Redis so every API instance enforces the same budget, with `RateLimit` and `Retry-After` headers.

---

## 🔧 Deep Dive 1: The Sandbox (8 min)

"Here's my threat list for one submission: an infinite loop, a 10 GB allocation, a fork bomb, a program that prints forever, a network call to exfiltrate test data, reading other files on the host, and — the serious one — exploiting a kernel bug to escape."

### Layers, and what each one stops

| Threat | Layer that stops it |
|--------|---------------------|
| Infinite loop | Wall-clock kill at the time limit → Time Limit Exceeded |
| Memory bomb | cgroup memory limit, no swap; the kernel's OOM kill is read back from the container → Memory Limit Exceeded |
| Fork bomb | cgroup pids limit (about 50) |
| Output flood | The judge stops reading at 1 MiB of stdout and kills the sandbox → Output Limit Exceeded |
| Network exfiltration | No network interface at all |
| Filesystem tampering | Read-only root and code mount, a 64 MB tmpfs `/tmp`, non-root user |
| Privilege escalation | All capabilities dropped, `no-new-privileges`, seccomp |
| Kernel exploit | gVisor's user-space kernel between the program and the host |

### Choosing the isolation boundary

| Option | How it works | Verdict |
|--------|--------------|---------|
| ❌ Plain containers (`runc`) | Namespaces + cgroups + seccomp on the shared host kernel | Stops everything above except a kernel or runtime bug — CVE-2019-5736 let a container overwrite the host's `runc` binary |
| ✅ gVisor (`runsc`) | A user-space kernel intercepts syscalls; the host kernel sees a small, filtered surface | A drop-in OCI runtime; CPU-bound code runs close to native |
| ⚠️ Firecracker microVMs | Hardware virtualization, ~125 ms boot, under 5 MiB overhead per VM | Strongest boundary, but a VM fleet to operate: images, snapshots, networking |

**Why gVisor works here.** An escape now needs a gVisor bug *and* a host-kernel bug reachable through gVisor's narrow syscall surface, on a host that holds no secrets and has no route to internal networks. It is a runtime flag on the same container tooling, so the judge stays a container scheduler.

**Why plain containers fail.** Not on the everyday attacks — on the tail risk. Every container shares the host kernel; at a million executions a day from anonymous users, someone will try the kernel exploit of the month, and with `runc` that turns one submission into a judge host that can read every contest's hidden tests.

**What I give up.** Syscall-heavy programs run measurably slower under gVisor, so time limits are calibrated on the gVisor fleet, not on a laptop. I keep Firecracker as the upgrade path if the threat model hardens.

### Turning outcomes into verdicts

The judge compiles C++ and Java once per submission, then runs each test in a fresh sandbox from that build, so nothing survives between tests. For each test the container reports an exit code, whether the kernel OOM-killed it, and whether we killed it for time or output. The mapping is ordered: output cap first, then our time kill, then OOM (or a runtime's own "heap exhausted" message), then any non-zero exit as a runtime error, otherwise compare the output. A subtle bug class lives here: Docker multiplexes stdout and stderr on one stream with 8-byte frame headers, and a judge that doesn't parse those frames compares garbage and returns Wrong Answer for every correct solution.

**Output checking** compares tokens after normalizing line endings and trailing spaces, compares JSON values structurally, allows a 1e-6 tolerance only when a decimal is involved, and ignores order only for problems marked "any order". Lenient-looking shortcuts — sorting every array, parsing a leading number — accept wrong answers.

### Fair timing

"Tests run one at a time on a dedicated CPU and stop at the first failure. Parallel tests would finish sooner but make runtime depend on the neighbors: identical code could measure 30% apart, which makes borderline time limits a coin toss and runtime rankings meaningless. Early exit makes most failing submissions cheap — a wrong answer usually fails in the first few tests. Interpreted languages get a multiplier on the time limit. The cost is latency for long accepted runs, which pre-warmed sandbox pools partly hide."

---

## 🔧 Deep Dive 2: The Judge Queue — Exactly One Verdict (8 min)

"The promise is: a `202` means the submission will get exactly one verdict, no matter how many workers crash, stall or retry. Four mechanisms deliver it."

### Decision: the submissions table is the queue

| Option | Delivery model | Verdict |
|--------|----------------|---------|
| ✅ PostgreSQL rows + `SKIP LOCKED` leases | Per-job claim with a timeout, created in the submit transaction | No dual write; queue state is queryable SQL |
| ❌ Kafka | Ordered partitions, one committed offset each | A 15 s C++ job blocks its whole partition; 800 workers need 800 partitions; slow handlers trigger rebalances |
| ⚠️ RabbitMQ / SQS | Per-message ack + visibility timeout | Right delivery model, but a second store: needs an outbox to avoid losing jobs |

**Why the table works.** The job is the submission row, so a submission can never exist without its job. With a broker, the API inserts and then publishes; a crash or broker outage in between leaves a submission "pending" forever — exactly the bug an earlier version of this project had. At 170 jobs a second, about 850 row writes a second, PostgreSQL is nowhere near its limits.

**Why Kafka fails specifically.** Kafka is a log: progress is one offset per partition, so I can't acknowledge job 7 before job 6 finishes, and a consumer that spends longer than its poll interval on one message is evicted — causing a rebalance and redelivery storm at the busiest moment.

**What I give up.** The queue load sits on the primary, idle workers need `LISTEN/NOTIFY` (with polling as a fallback) instead of a push, and there's no replay log — a rejudge is an update that resets the affected rows to pending. If dispatch outgrew the database, I'd move to SQS behind a transactional outbox and keep the same lease and fencing rules.

### Leases, heartbeats and fencing tokens

1. **Claim** sets `running`, a lease expiry 30 s out, increments the attempt counter and increments `lease_token`. `SKIP LOCKED` means hundreds of workers can claim concurrently without blocking or double-claiming.
2. **Heartbeat** every 10 s pushes the lease forward — but only `WHERE lease_token = mine`. If it matches nothing, someone else owns the job, and the worker stops at the next test.
3. **Crash recovery** is free: a dead worker stops heartbeating, the lease lapses, and any worker re-claims the row.
4. **Fencing** is the subtle part. A worker can stall past its lease — a long GC pause, a network partition — while another worker re-claims and finishes the job. When the first one wakes up, its verdict write carries the old token and matches zero rows. Without the token, the stale worker would overwrite the correct verdict.

"So delivery is at-least-once — two workers can judge the same submission — but only one verdict can ever commit. At-least-once plus a fenced write is effectively once."

### Retries and the dead-letter outcome

A sandbox failure — Docker unhealthy, an image pull failing, the circuit breaker open — is never the user's fault, so it isn't a verdict. The job goes back to pending with a backoff of 5 s, 10 s, 20 s (never sooner than the breaker's 30 s reset), and after three attempts it becomes a final `system_error` the user can see and resubmit. Because attempts are counted at claim time, code that crashes the worker itself — a poison job — also stops after three claims instead of taking down judge after judge.

### Idempotent submission

"The earlier design hashed the code and checked Redis before inserting, then wrote the hash afterwards. Eight concurrent identical requests created four submissions — every request passed the check before any wrote it. Unique indexes inside the creating transaction close that window: the database serializes conflicting inserts. They also separate two questions: 'is this the same request?' (the key, replayable forever) and 'is this code already being judged?' (the in-flight index, which stops applying once a verdict lands, so a deliberate resubmission is judged again)."

---

## 🔧 Deep Dive 3: Contest Standings (4 min)

"ICPC-style ranking orders by problems solved, then by penalty: minutes from the start to each accepted solution plus 20 minutes per rejected attempt before it. Both fit in one number — solved times a billion, minus penalty seconds — so a Redis sorted set keeps the ranking current."

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

| Option | Cost per scoreboard read | Verdict |
|--------|--------------------------|---------|
| ✅ Redis sorted set + 5 s page cache | O(log N + 50) for a page, O(log N) for "my rank" | Fresh within seconds; reads never touch PostgreSQL |
| ❌ SQL ranking per request | Sort all participants' results | 50K participants × 1.5K reads/s ≈ 75M rows sorted per second |
| ❌ Materialized view, refreshed often | Full recomputation per refresh | Stale between refreshes and expensive at each one |

"The judge updates the sorted set only on a contestant's *first* accepted solution for a problem, right after the verdict transaction — which also writes `contest_results`, the source of truth. If Redis is lost, the Contest Service rebuilds the set from that table. In the last hour I freeze the public scoreboard: readers get a snapshot while the real set keeps updating, which also makes the read load trivially cacheable."

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first:** judge capacity at the contest start (pre-scale per language pool from the schedule; Python is the big one); then queue contention on the primary somewhere past a few thousand jobs a second (move dispatch to SQS with an outbox); then submission storage (monthly partitions, archive old code).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Judge host dies mid-run | That verdict ~30 s later | Lease expires; another worker re-claims |
| Docker or gVisor sick on a host | Slower verdicts | Breaker opens; jobs requeue with backoff; host drained |
| Poison submission crashes workers | One `system_error` | Attempts counted at claim; capped at 3 |
| Worker stalls, then wakes | Nothing | Stale lease token: its writes match zero rows |
| PostgreSQL failover | Submit `503` for ~30 s | Clients retry with the same key; polls served from Redis |
| Redis down | Logged out, slower polls, frozen scoreboard | Status falls back to PostgreSQL; standings rebuilt |
| Lost NOTIFY | Up to 2 s extra latency | Workers also poll; listener reconnects |

**What I'd watch:** queue depth and queue wait p95 (the contest SLO), jobs by outcome — retried, dead-lettered, lease-lost (lease-lost is the early warning that workers are stalling) — the `system_error` rate, per-language test runtime after any sandbox or kernel upgrade, and breaker state per host.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Isolation | gVisor on dedicated hosts | Plain containers | Survives a kernel bug |
| Job queue | Table + SKIP LOCKED leases | Kafka | No dual write; per-job timeouts; no head-of-line blocking |
| One verdict | Fenced write by lease token | Trust the delivery | Redelivery happens; the stale writer must lose |
| Idempotency | Key + unique indexes | Hash check in Redis | No check-then-act race |
| Delivery | Polling + Redis status | WebSockets | Seconds-long jobs; no connection state |
| Timing | Sequential tests, pinned CPU | Parallel tests | Reproducible runtimes |
| Standings | Redis sorted set | SQL per request | O(log N) reads at 1.5K/s |

"With more time I'd add checker programs for multi-answer problems, a rejudge workflow with test-set versioning in the UI, and plagiarism detection that compares token streams after contests."
