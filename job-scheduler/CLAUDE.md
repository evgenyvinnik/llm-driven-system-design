# Job Scheduler — Development with Claude

## Project Context

A distributed, cron-capable job scheduler with priority queueing, worker pools, and **at-least-once execution**. The hard problems are the classic distributed-systems ones: exactly one scheduler must decide what to run (or jobs double-fire), a crashed worker mid-job must not lose the work (or jobs silently vanish), and a poison job must not retry forever (or it starves the pool). The design answers these with Redis leader election, a visibility-timeout queue, and bounded exponential-backoff retries with a dead-letter queue.

**Learning goals:** distributed coordination (leader election, distributed locks), at-least-once delivery with recovery, priority scheduling on a sorted set, and failure isolation with circuit breakers.

## Architecture at a Glance (what actually runs)

Two datastores and several independently-scaled process roles — this matches `docker-compose.yml` and `backend/package.json`:

| Component | Tech | Role |
|-----------|------|------|
| **PostgreSQL 15** (`pg`) | Source of truth | `jobs` (definitions, cron `schedule`, `next_run_time`, priority, retry policy), `job_executions` (per-attempt history), `execution_logs`, `users` |
| **Redis / Valkey 7** (`ioredis`) | Coordination + queue | Priority queue (`job_scheduler:queue` sorted set), in-flight set (`:processing` with timeout score), dead-letter list (`:dead_letter`), leader lock, per-job distributed locks |
| **API service** | Express (port 3001) | Stateless job/execution CRUD + metrics; serves the dashboard |
| **Scheduler service** | Node process | Leader-elected; runs scan / stalled-recovery / retry / metrics loops |
| **Workers 1–3** | Node processes | Pull from the shared queue, `MAX_CONCURRENT_JOBS=5` each, run handlers |
| **Frontend** | React 18 + TanStack Router + Zustand | Dashboard: jobs, executions, workers, DLQ |

Supporting libraries that matter: `cron-parser` (computes `next_run_time` for recurring jobs), `opossum` (per-handler circuit breakers), `prom-client` (17+ metrics at `GET /metrics`), `pino` (structured logs). Built-in handlers: `http.webhook`, `shell.command`, `system.cleanup`, and `test.echo/delay/log`.

## Key Design Decisions

### 1. Single active scheduler via Redis leader election
`LeaderElection` uses `SET key instanceId EX 30 NX` to claim leadership, refreshes it on a heartbeat at TTL/3 (~10s), and releases it with a Lua compare-and-delete so it can never delete another instance's lock. Only the leader scans for due jobs. Trade-off: this makes scheduling a single-writer operation (no duplicate enqueues), but leadership failover has a gap — if the leader dies, up to ~30s (the lock TTL) can pass before a standby claims the lock and scanning resumes. That's acceptable because jobs are time-windowed, not sub-second, and a brief scheduling pause is far cheaper than the double-firing a multi-leader design would cause.

### 2. At-least-once via a visibility-timeout queue
`enqueue` does `ZADD` with an inverted-priority score (`Date.now() - priority*1_000_000`) so higher priority dequeues first via `ZPOPMIN`; `dequeue` atomically pops and records the item in the `:processing` set with a future timeout score. A completed job is `ZREM`'d; a job whose worker crashes leaves its `:processing` entry, and the scheduler's recovery loop (`ZRANGEBYSCORE … -inf now`) re-enqueues anything past its timeout. Trade-off: this is **at-least-once, not exactly-once** — a worker that stalls past the visibility timeout but is still alive can have its job re-run, so handlers must be idempotent. We accept possible duplicates to guarantee no lost executions, which is the right bias for a scheduler.

### 3. Bounded exponential backoff + dead-letter queue
Retries follow `min(initial_backoff_ms * 2^attempt, max_backoff_ms)` up to `max_retries`; the scheduler's retry loop creates a fresh `job_executions` row (attempt+1) rather than mutating the old one, preserving full attempt history. After the retry budget is exhausted the item is `LPUSH`'d to the dead-letter list. Trade-off: a genuinely broken job is parked for human inspection instead of retried forever — we give up automatic self-healing for that job in exchange for not letting one poison payload burn worker capacity.

### 4. Per-handler circuit breakers (Opossum)
Each handler type gets its own breaker (opens at 50% error rate over 5 requests, tests recovery after 30s). If the webhook target is down, its breaker opens and those jobs are requeued for later rather than counted as failures — isolating one bad dependency from the shell/log handlers. Trade-off: added state and tuning per handler, justified because a single failing external endpoint would otherwise drain every worker slot.

### 5. Separate scheduler and worker processes
Scheduling (leader-only, coordination-heavy) and execution (embarrassingly parallel, stateless) scale on different axes, so they're different entry points (`scheduler/index.ts`, `worker/index.ts`) sharing the same codebase. Trade-off: more processes to run locally, bought back by being able to add workers without touching the scheduler.

## Current State

Implemented and running end to end: job CRUD + pause/resume/trigger, cron and one-shot scheduling, the leader-elected scheduler with all four loops (scan, stalled-recovery, retry, metrics), three workers with bounded concurrency, the reliable priority queue with visibility timeout and DLQ, exponential-backoff retries, per-handler Opossum circuit breakers, a full `prom-client` metric set at `GET /metrics`, structured `pino` logging, and the React dashboard (jobs / executions / workers / DLQ views).

Note: **monitoring is implemented**, not pending — the earlier checklist-style CLAUDE.md listed "Add monitoring" as "Not started," which contradicted `src/shared/metrics.ts` and the Opossum breakers already emitting metrics.

Intentionally omitted: DAG/job-dependency workflows, multi-tenancy (jobs are single-tenant), request rate limiting, and a comprehensive automated test suite. Auth exists as a module (`shared/auth.ts`, express-session) but the seed does not create login users, so the local dashboard runs without a login wall.

## Iteration & Repair Log

- **Metrics + circuit-breaker pass.** `src/shared/metrics.ts` and `src/shared/circuit-breaker.ts` were added, wiring `prom-client` and Opossum through the scheduler/worker/API and instrumenting the queue, scheduler leadership, and per-handler breaker state. This is what makes the old "monitoring not started" note obsolete.
- **DB layer split.** The repository was broken into `job-repository.ts`, `execution-repository.ts`, `schedule-repository.ts`, and `queries.ts` under `src/db/` for focus.
- **Migrate-at-startup + dual scripts.** `migrate()` is idempotent (`CREATE … IF NOT EXISTS`) and is called both from the scheduler on boot and via `npm run migrate` / `npm run db:migrate` (both aliases exist). Seeding is `npm run seed` / `npm run db:seed`.
- **CLAUDE.md rewrite (this pass).** Replaced the generic Phase 1–4 checklist ("Phase 3: Not started", "will be updated throughout the development process") with the real architecture and decision rationale grounded in `scheduler/index.ts`, `queue/reliable-queue.ts`, and `queue/leader-election.ts`.

## Open Questions

1. **Job dependencies:** to support DAG workflows, add a `dependencies` field and trigger downstream jobs on completion — but how to detect and reject cycles at definition time?
2. **Failover gap:** the ~30s leadership TTL bounds worst-case scheduling latency after a leader crash. Is a shorter TTL (faster failover, more Redis chatter) or a standby pre-warm worth it?
3. **Exactly-once:** could a per-execution distributed lock (`DistributedLock` already exists) plus a "completed" marker in Postgres upgrade at-least-once toward effectively-once for non-idempotent handlers?
4. **Queue durability:** the queue lives in Redis; on Redis loss, in-flight queue state is gone though `job_executions` in Postgres survives. Is a rebuild-from-Postgres recovery path worth adding?

## Resources

- [Designing a Distributed Job Scheduler](https://levelup.gitconnected.com/designing-a-distributed-job-scheduler-461ac0c3a9e8)
- [Redis distributed locks](https://redis.io/docs/manual/patterns/distributed-locks/) — the SET NX EX + Lua pattern used for leader election
- [cron-parser](https://www.npmjs.com/package/cron-parser) — next-run computation
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — per-handler failure isolation
