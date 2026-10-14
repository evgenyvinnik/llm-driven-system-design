# LeetCode (Online Judge) — Development with Claude

## Project Context

An online coding-practice platform: users pick a problem, write a solution in one of four languages, and get it run against hidden test cases with a verdict. The hard problem is **running untrusted code safely and at throughput** — every submission is arbitrary code that could loop forever, fork-bomb, or try to phone home. The whole design is organized around isolating that execution, failing fast when the executor is unhealthy, and keeping the rest of the API responsive while code runs.

**Learning goals:** sandboxed multi-language execution, a durable judge queue built on PostgreSQL (leases, fencing tokens, retries, dead-letter outcome), idempotent submission enforced by the database, and protecting a fragile subsystem with circuit breakers and rate limits.

## Architecture at a Glance (what actually runs)

Matches `docker-compose.yml` and `backend/package.json`:

| Component | Tech | Role |
|-----------|------|------|
| **PostgreSQL 16** (`pg`) | Source of truth + judge queue | `users`, `problems`, `test_cases`, `submissions` (each row is also a queue job), `user_problem_status` |
| **Redis / Valkey 7** (`ioredis`) | Hot path | Sessions (`connect-redis`), submission-status cache for polling, problem cache |
| **Judge worker** (`src/worker/judgeWorker.ts`) | Queue consumer | Claims rows with `FOR UPDATE SKIP LOCKED` + leases, judges, writes fenced verdicts; runs inside the API by default (`EMBEDDED_WORKER`) or standalone (`dev:worker1/2`) |
| **Code executor** | `dockerode` | Compiles once per submission, then a fresh locked-down container per test |

Languages (from `codeExecutor.ts`): **Python** (`python:3.11-alpine`), **JavaScript** (`node:20-alpine`), **C++** (`gcc:13`), **Java** (`openjdk:21-slim`) — each with its own compile/run command and time/memory limits. Frontend: React 19 + **react-router-dom v6** (code-based routing under `pages/`, the editor and admin pages lazy-loaded) + Zustand (`authStore`, a persisted `editorStore` for per-language drafts), a CodeMirror editor (`@uiw/react-codemirror`), and a virtualized `<table>` problem list (`@tanstack/react-virtual`). Design rationale lives in `architecture.md`; the notes below are the short version.

## Key Design Decisions

### 1. Locked-down Docker containers locally, gVisor in the production design
`codeExecutor` compiles C++/Java once, then runs each test in a fresh container as uid 65534 with no network, a read-only root and read-only `/code`, a 64 MB tmpfs `/tmp`, `CapDrop: ALL`, `no-new-privileges`, 50 pids, half a CPU and no swap. Docker's shared kernel is the residual risk; `SANDBOX_RUNTIME=runsc` switches to gVisor, which is what the production design uses. (The `sandbox/` image under the compose `sandbox` profile is not used by the executor.)

### 2. Circuit breaker around code execution
Container runs are wrapped in an Opossum breaker (opens at 50% error rate over 5+ calls, 30s reset, no fallback). While it is open, sample runs get `503` + `Retry-After` and queued submissions go back to `pending` with a backoff of at least 30 s, then become `system_error` after `JUDGE_MAX_ATTEMPTS`. Problem browsing, auth and polling never touch the breaker.

### 3. The submissions table is the judge queue (Kafka path removed)
A submission row is created `pending` and `pg_notify` fires in the same transaction; workers claim with `FOR UPDATE SKIP LOCKED`, hold a 30 s lease extended by heartbeats, and write the verdict only `WHERE lease_token = <their claim>`. Sandbox failures retry with backoff; after `JUDGE_MAX_ATTEMPTS` (3) the job ends as `system_error`. Trade-off: queue load on the primary and no replay log, in exchange for no dual write and per-job timeouts (see architecture.md, decision 2).

### 4. Polling + Redis status cache instead of WebSocket
A run takes ~2–15s. The client `POST`s, gets a submission id, and polls `GET /:id/status` with backoff (0.5 s → 5 s); the endpoint reads a Redis status entry the worker updates per test (forward-only writes) and falls back to PostgreSQL. Only the owner or an admin may read it. Trade-off: up to a second of staleness vs. push, with no connection state to manage.

### 5. Idempotency enforced by unique indexes + tiered rate limits
`Idempotency-Key` (one per submit attempt, sent by the SPA) is unique per user; a replay returns the original submission, a reused key with a different body is `422`. A partial unique index on `(user, problem, language, code_hash)` while `pending`/`running` stops identical code being queued twice. Rate limits: submissions 10/min, runs 30/min, general 100/min per user; failed logins 5/15 min and registrations 5/hour per IP — all in-process (`express-rate-limit` memory store).

## Current State

Implemented: session auth (bcrypt + Redis store), problem catalog with caching (solutions never returned), submit with database-enforced idempotency, the PostgreSQL judge queue with leases, fencing, retries and dead-lettering, an embedded or standalone judge worker woken by `LISTEN/NOTIFY`, the `dockerode` executor for four languages (compile once, hardened containers, OOM/time/output-limit verdicts, correct stdout/stderr demultiplexing), token- and JSON-aware output checking with a per-problem `checker`, status polling through a forward-only Redis cache with owner-only access, tiered rate limiting, `prom-client` metrics (including queue depth, queue wait and job outcomes), `pino` logging, health/liveness/readiness, graceful shutdown. 71 vitest tests. Frontend: virtualized problem table, CodeMirror workspace with persisted per-language drafts, idempotent submit with retries, backoff polling with an `aria-live` verdict, lazy-loaded editor route, progress dashboard, admin page. Seed: 15 problems plus `admin`/`admin123` and `demo`/`user123`.

Not built: contests and a real-time scoreboard (the admin leaderboard is a SQL aggregate), gVisor/Firecracker (only the `SANDBOX_RUNTIME` switch), CPU-time and memory measurement, checker programs, rejudge tooling, plagiarism detection.

## Iteration & Repair Log

- **Kafka execution path added, then mis-documented.** `shared/kafka.ts`, the worker, and the `USE_KAFKA_QUEUE` branch in `routes/submissions.ts` were built, and Kafka+Zookeeper added to compose — but the CLAUDE.md still claimed queue execution was "not needed… can add Kafka later." Corrected: Kafka is an implemented opt-in path.
- **Language set expanded.** The executor grew from Python/JS to four languages (added C++ via `gcc:13`, Java via `openjdk:21-slim`); older notes still said "Python and JavaScript."
- **Seed grown to 15 problems** (from 7) and vitest tests added for auth, idempotency, and the executor.
- **README command fix (this pass).** README step 3 used `npm run seed`, which doesn't exist; the scripts are `db:migrate` / `db:seed`. Fixed, and a `db:migrate` step added (schema also auto-applies via the `docker-entrypoint-initdb.d` init.sql mount on a fresh volume).
- **CLAUDE.md rewrite (this pass).** Replaced the Phase 1–4 checklist (with a self-contradictory "Phase 4: In progress" that then listed everything "Completed") with real architecture + decisions grounded in `codeExecutor.ts`, `routes/submissions.ts`, and `worker/index.ts`.

- **2026-10-10 — judge correctness, queue, idempotency, docs rewrite.** Runtime checks against the old code showed reference solutions in the anonymous `GET /problems/:slug` response (`SELECT p.*`), eight concurrent identical submits creating four rows (Redis check-then-act), any submission's status/details readable without login, `500` on non-UUID ids, successful logins exhausting the 5-per-15-min auth limit (smoke tests log in four times), and an ioredis `retryStrategy` that stopped reconnecting after three tries. Reading the executor found worse: it stripped one byte of Docker's 8-byte frame header, so every judged output began with control bytes and could never match (every correct solution was Wrong Answer); `AutoRemove` raced the second `wait()`; Docker errors during compilation were reported as Compile Error; OOM was never detected; the comparator sorted every JSON array and fell back to `parseFloat`, accepting an unmerged list for merge-two-sorted-lists and any output whose first number matched. The Kafka worker double-counted attempts, kept running tests after a wrong answer, and marked a submission Accepted if shutdown interrupted it; insert-then-publish could strand submissions as `pending`. Fixes: Kafka removed in favor of the submissions-table queue (`shared/judgeQueue.ts`, `worker/judgeWorker.ts`), `services/submissionService.ts` + unique indexes, rewritten `services/codeExecutor.ts` with `services/dockerStream.ts`, `services/judge.ts`, `services/checker.ts` (Two Sum seeded `unordered`), owner-only status/details, explicit problem columns with a `problem:v2:` cache key, login limiter counting only failures, Redis reconnecting forever, `SCAN` instead of `KEYS`, transactional problem creation. Frontend: `Idempotency-Key` + retries, `useSubmissionStatus` backoff polling with abort, persisted per-language drafts (switching language used to wipe the code), the problem list loads every page (it showed only the first 20) as a semantic `<table>` (smoke test 03 waits for `table`, which never existed), lazy editor/admin routes (initial JS 339 → 106 KB gzipped), working `npm run lint` in both packages. Verified with tsc, 71 tests, builds, and a scripted run against PostgreSQL + Redis (idempotent replays, in-flight dedupe, 404s, NOTIFY claim in ~100 ms, retry then dead-letter, lease takeover rejecting the stale verdict, Redis restart recovery, two workers sharing the queue with no double-judged attempts, graceful shutdown). Docker itself was unavailable, so the sandbox is covered only by unit tests with a fake Docker. Docs: architecture.md and the three answers rewritten around one layered overview plus generated sequence diagrams.

## Open Questions

1. **Credentials not normalized:** the seed uses `admin123` / `user123` (bcrypt); the repo-wide `password123` normalization never reached this seed. Align the seed (source change) or leave as documented?
2. **Plagiarism:** hash-based near-duplicate detection is cheap but weak; is MOSS-style structural comparison worth the complexity for a practice platform?
3. **Warm containers:** a container per test case means startup dominates latency for fast solutions (50 tests × a few hundred ms). Is a pool of pre-started containers (one per submission, never reused) worth it locally, or should one sandbox run all tests with a per-test process limit, as production judges do?
4. **Sample runs in the API process:** `/submissions/run` still executes synchronously in the API, which therefore needs the Docker socket. Route runs through the workers (a Redis stream, results with a TTL) as the production design does?
5. **Rate limits per process:** `express-rate-limit` uses its memory store, so `dev:server1..3` each grant the full budget. Move to a Redis store?

## Resources

- [Docker security](https://docs.docker.com/engine/security/) — the isolation primitives the executor relies on
- [dockerode](https://github.com/apocas/dockerode) — programmatic container lifecycle
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
- [PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) — the claim behind the judge queue
- [Docker attach stream format](https://docs.docker.com/engine/api/v1.43/#tag/Container/operation/ContainerAttach) — the 8-byte frame headers the executor parses
- [gVisor](https://gvisor.dev/) — the `runsc` runtime `SANDBOX_RUNTIME` can select
