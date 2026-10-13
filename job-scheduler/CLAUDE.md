# Job Scheduler — Development with Claude

## Project Context

A distributed, cron-capable job scheduler with priority queueing, worker pools, and **at-least-once execution**. The hard problems are the classic distributed-systems ones: a slot must fire once even when two schedulers briefly both think they lead, a crashed or frozen worker must not lose the run or overwrite a newer attempt's result, a poison job must not retry forever, and runs missed during an outage need a deliberate policy. Since the 2026-10 pass the design answers these with a PostgreSQL work queue (`FOR UPDATE SKIP LOCKED`), leases renewed by heartbeat, fencing tokens on every outcome write, an idempotent firing transaction, and bounded jittered retries ending in a `DEAD_LETTER` state. The design itself is in [architecture.md](./architecture.md); this file is the history.

**Learning goals:** SKIP LOCKED work queues, leases and fencing tokens, leader election as an optimization (not a guarantee), cron misfire policies, retries with backoff and dead-lettering, idempotency keys, and circuit breakers.

## Architecture at a Glance (what actually runs)

Two datastores and several independently-scaled process roles — this matches `docker-compose.yml` and `backend/package.json`:

| Component | Tech | Role |
|-----------|------|------|
| **PostgreSQL** (`pg`) | Source of truth *and* the work queue | `jobs` (cron `schedule`, `next_run_time`, `misfire_policy`, retry policy), `job_executions` (one row per attempt; `run_at`, `lease_expires_at`, `fencing_token`), `execution_logs`, `users` (seeded, unused) |
| **Redis / Valkey 7** (`ioredis`) | Coordination that can be rebuilt | Scheduler leader lease, users and sessions, idempotency records, worker liveness registry |
| **API service** | Express (port 3001) | Job/execution CRUD, trigger/cancel/retry, metrics; serves the dashboard |
| **Scheduler service** | Node process | Leader-elected; fires due slots, reaps lapsed leases, refreshes queue gauges |
| **Workers 1–3** | Node processes | Claim with SKIP LOCKED, `MAX_CONCURRENT_JOBS=5` each, renew leases, run handlers |
| **Frontend** | React 18 + TanStack Router + Zustand | Dashboard: jobs, executions, workers |

Supporting libraries that matter: `cron-parser` (UTC next-run computation), `opossum` (per-handler circuit breakers), `prom-client`, `pino`, and `vitest` for tests. Built-in handlers: `http.webhook`, `shell.command`, `system.cleanup`, `system.maintenance`, and `test.echo/delay/log`.

## Key Design Decisions

The reasoning lives in [architecture.md → Key Design Decisions](./architecture.md#key-design-decisions). In one line each:

1. **The execution row is the queue entry** (PostgreSQL + `SKIP LOCKED`), replacing the Redis sorted set, whose dual write with the execution row could lose or duplicate runs.
2. **Leases + fencing tokens** replace the visibility-timeout set and the per-job Redis lock.
3. **Leader election is an optimization**; the firing transaction (row locks, unique `(job_id, scheduled_at, attempt)`, `next_run_time` advanced in the same commit) is the guarantee.
4. **Misfires** use a 60 s grace window and a per-job `fire_once`/`skip` policy.
5. **Retries** are new attempt rows with jittered backoff; the budget ends in `DEAD_LETTER`; a lapsed lease counts as an attempt.
6. **Separate scheduler and worker processes**, because firing and execution scale on different axes.

## Current State

Runs end to end with PostgreSQL and Redis (`npm run dev` starts the API, one scheduler and three workers): job CRUD with boundary validation, pause/resume/trigger, cron (UTC) and one-time scheduling with a misfire policy, the leader-elected scheduler (fire + reap), SKIP LOCKED claiming with 30 s leases, heartbeat renewal, self-fencing and fenced outcome writes, cooperative cancellation, graceful worker shutdown that hands work back, jittered retries and dead-lettering with redrive, `Idempotency-Key` on create/trigger/retry, Opossum breakers, prom-client metrics (`/metrics` on the API, `METRICS_PORT` for scheduler and workers), Pino logs, and the React dashboard.

Tests: `npm test` in `backend/` runs 38 offline unit tests; with `TEST_DATABASE_URL` pointing at a throwaway database it also runs 11 PostgreSQL integration tests of the queue and the firing transaction.

Auth is session-based and enforced on every `/api/v1` route. Users live in Redis (`job_scheduler:user:*`, salted scrypt hashes), not in the PostgreSQL `users` table, which is seeded but unread. `ensureAdminUser()` creates **`admin` / `admin123`** on API boot (override with `ADMIN_USERNAME` / `ADMIN_PASSWORD`); that is the login the dashboard and the screenshot harness use.

Not built: rate limiting (`rateLimitConfig` exists, nothing applies it), per-team ownership, per-job time zones, an overlap (concurrency) policy, look-ahead firing, sharding/partitioning, live updates in the dashboard (it polls), a dead-letter page in the UI, and DAG workflows.

## Iteration & Repair Log

- **Metrics + circuit-breaker pass.** `src/shared/metrics.ts` and `src/shared/circuit-breaker.ts` were added, wiring `prom-client` and Opossum through the scheduler/worker/API and instrumenting the queue, scheduler leadership, and per-handler breaker state. This is what makes the old "monitoring not started" note obsolete.
- **DB layer split.** The repository was broken into `job-repository.ts`, `execution-repository.ts`, `schedule-repository.ts`, and `queries.ts` under `src/db/` for focus.
- **Migrate-at-startup + dual scripts.** `migrate()` is idempotent (`CREATE … IF NOT EXISTS`) and is called both from the scheduler on boot and via `npm run migrate` / `npm run db:migrate` (both aliases exist). Seeding is `npm run seed` / `npm run db:seed`.
- **2026-07-29 — the project did not actually run; six separate faults.** It had zero screenshots, and each fix uncovered the next:
  1. **Every backend service failed to boot.** `tsconfig` sets `"module": "commonjs"`, but 17 files used ESM-style `.js` import suffixes (`from '../db/repository.js'`), which CommonJS `require` cannot resolve — so api, scheduler, and all workers died on their first import with `Cannot find module`. `migrate.ts` was the one file using extensionless imports, which is why migrations appeared to work while nothing else did. 67 imports rewritten to match the module system.
  2. **A stale compiled `vite.config.js` shadowed `vite.config.ts`.** `tsconfig.node.json` is a composite project with no `outDir`, so `npm run build` emitted the compiled config *next to the source*, and Vite resolves `.js` before `.ts`. The dev server kept starting on the old port 3000 no matter what the TypeScript said. Fixed by pointing the emit at `node_modules/.tmp`.
  3. **`docker-compose up -d` started the whole app, not just infrastructure**, binding host 3001/3000 before the local dev servers could. The health check passed against the *container*, hiding it. App services now sit behind `profiles: ["app"]`.
  4. **The frontend had no login screen at all** while every `/api/v1` route requires a session, so the dashboard could never load data. Added `routes/Login.tsx`, an auth store, and a gate in `Layout` keyed on `authChecked` (not `!user`, which flashes the login form on every reload).
  5. **The dashboard called `/api/v1/metrics`, which does not exist** — the route is `/api/v1/metrics/system`, and bare `/metrics` is the Prometheus scrape endpoint. The 404 became a null metrics object, so every stat card rendered `0` while the job table beneath it was full.
  6. **`db-seed/seed.sql` had an INSERT missing a value** (`weekly-report-generation` omitted `next_run_time`), which aborted the transaction and left the database empty.
- **`npm run dev` now starts the real topology** (api + scheduler + 3 workers via `concurrently`), matching what docker-compose describes. Previously it ran a single all-in-one process, so the Workers page could only ever show one worker; the seeded execution history references worker-1/2/3. The old single-process entry point is still available as `dev:all-in-one`.
- **CLAUDE.md rewrite (earlier pass).** Replaced the generic Phase 1–4 checklist ("Phase 3: Not started", "will be updated throughout the development process") with the real architecture and decision rationale grounded in `scheduler/index.ts`, `queue/reliable-queue.ts`, and `queue/leader-election.ts`.

- **2026-10-10 — the delivery guarantees were not real; queue moved into PostgreSQL, docs rewritten.** A baseline run of the old code with two workers reproduced the problems before anything was changed:
  1. **A crashed worker's run was silently dropped.** After `kill -9` mid-run, the recovery loop re-enqueued the execution, but the next worker found the dead worker's Redis execution-idempotency key still set and marked the run `DEDUPLICATED`. The per-job Redis lock (1 h TTL) would also have suppressed every other run of that job for an hour. `dequeue` was a non-atomic `ZPOPMIN` + `ZADD`, so a crash between the two lost the item outright.
  2. **Jobs missed by more than 5 minutes were stranded forever**: `getDueJobs` ignored them and nothing advanced their `next_run_time`. Its `FOR UPDATE SKIP LOCKED` ran outside a transaction, so it locked nothing.
  3. **Pause was overwritten** when an in-flight run finished (`PAUSED` → `SCHEDULED`), because workers wrote job status unconditionally.
  4. **`max_retries = 1` meant no retries** (`attempt < max_retries`), and circuit-open requeues spun in a tight loop and then got deduplicated away.
  5. **Concurrent startup migrations deadlocked** (`40P01`) and killed a worker at random under `npm run dev`.
  6. An invalid cron returned `500`, unknown handlers were accepted, the idempotency middleware cached 5xx responses for 24 h and used a non-atomic check, and passwords were unsalted SHA-256.

  Changes: `job_executions` is now the queue (`db/execution-queue.ts`: SKIP LOCKED claim, batch lease renewal, fenced complete/fail/release, reaper, redrive, guarded cancel); firing is one transaction with a unique `(job_id, scheduled_at, attempt)` guard and a misfire policy (`db/schedule-repository.ts`, `scheduler/cron.ts`); the leader lease uses a Lua compare-and-pexpire plus a local deadline; workers self-fence, heartbeat every 5 s (idle workers no longer show as offline after 60 s), hand work back on SIGTERM, and treat unknown handlers and 4xx webhook answers as non-retryable; `shared/backoff.ts` adds equal-jitter backoff with corrected retry semantics; `api/validation.ts` returns `400` with details; the idempotency middleware was rewritten (SET NX, body fingerprint → `422`, no 5xx caching, per-user scope, `503` when Redis is down); scrypt password hashing with legacy upgrade; migrations take an advisory lock; `system.maintenance` is registered in workers too; the Redis `ReliableQueue` and `DistributedLock` were deleted. The integration tests caught one bug introduced during the work: `scheduled_at` round-tripped through a JS `Date` lost PostgreSQL's microseconds, so redrives and retries are now copied inside SQL; the first runtime burst caught another (manual-trigger slots truncated to milliseconds collided under 40 concurrent triggers), fixed by keeping full precision with a microsecond bump on conflict. Verified with two real workers: 74 concurrent executions each started exactly once, `kill -9` and `SIGSTOP` mid-run (the frozen worker's late write was rejected by its fencing token), cancel, pause, misfire policies, retries into `DEAD_LETTER`, redrive, and leader failover (5.6 s after `kill -9` with a 6 s TTL; 0.4 s after SIGTERM). Frontend: mutations now surface server errors, create/trigger/retry send idempotency keys, dead-lettered runs can be retried, the lint script works again. Docs: `architecture.md` and the three answers were rewritten around the new design, with generated sequence diagrams.

## Open Questions

1. **Job dependencies:** to support DAG workflows, add a `dependencies` field and trigger downstream jobs on completion — but how to detect and reject cycles at definition time?
2. **Overlap policy:** a run that outlasts its interval overlaps the next slot today (Kubernetes' `Allow`). Should firing skip a slot while the previous run of the same job is still PENDING or RUNNING (`Forbid`), and should retries of the previous run count as "still running"?
3. **Polling vs `LISTEN/NOTIFY`:** idle workers claim every 500 ms. At a few hundred workers that is thousands of empty queries per second; a NOTIFY on insert would wake them instead. Worth the extra connection per worker?
4. **Time zones:** cron is evaluated in UTC. Adding a per-job IANA zone means choosing DST behavior for skipped and repeated local times; `cron-parser` shifts a skipped 02:30 to 03:30 — is that what users expect?
5. **Priority starvation:** claims are strict priority order. Add aging, or weighted per-priority claiming, if low-priority executions start waiting minutes behind a steady high-priority stream.

## Resources

- [Designing a Distributed Job Scheduler](https://levelup.gitconnected.com/designing-a-distributed-job-scheduler-461ac0c3a9e8)
- [Redis distributed locks](https://redis.io/docs/manual/patterns/distributed-locks/) — the SET NX PX + Lua pattern used for the leader lease
- [How to do distributed locking (Kleppmann)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) — why leases need fencing tokens
- [PostgreSQL SELECT … FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) — the claim mechanism
- [cron-parser](https://www.npmjs.com/package/cron-parser) — next-run computation
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — per-handler failure isolation
