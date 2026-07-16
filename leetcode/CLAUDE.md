# LeetCode (Online Judge) — Development with Claude

## Project Context

An online coding-practice platform: users pick a problem, write a solution in one of four languages, and get it run against hidden test cases with a verdict. The hard problem is **running untrusted code safely and at throughput** — every submission is arbitrary code that could loop forever, fork-bomb, or try to phone home. The whole design is organized around isolating that execution, failing fast when the executor is unhealthy, and keeping the rest of the API responsive while code runs.

**Learning goals:** sandboxed multi-language execution, protecting an expensive/fragile subsystem with circuit breakers + rate limits + idempotency, and offering both an in-process and a queue-decoupled execution path.

## Architecture at a Glance (what actually runs)

Matches `docker-compose.yml` and `backend/package.json`:

| Component | Tech | Role |
|-----------|------|------|
| **PostgreSQL 16** (`pg`) | Source of truth | `users`, `problems`, `test_cases`, `submissions`, `user_problem_status` |
| **Redis / Valkey 7** (`ioredis`) | Hot path | Sessions (`connect-redis`), submission-status cache for polling, idempotency keys, rate-limit counters, problem cache |
| **Kafka + Zookeeper** (`kafkajs`) | Optional queue | `submissions` / `submission-results` topics — the decoupled execution path (opt-in via `USE_KAFKA_QUEUE=true`) |
| **Code executor** | `dockerode` | Spawns a fresh, locked-down Docker container per run |
| **Worker** (`src/worker`) | Kafka consumer | Consumes `submissions`, runs the executor, writes results — the horizontally-scalable execution tier |

Languages (from `codeExecutor.ts`): **Python** (`python:3.11-alpine`), **JavaScript** (`node:20-alpine`), **C++** (`gcc:13`), **Java** (`openjdk:21-slim`) — each with its own compile/run command and time/memory limits. Frontend: React 19 + **react-router-dom v6** (code-based routing under `pages/`) + Zustand (`authStore`, `editorStore`), a CodeMirror editor (`@uiw/react-codemirror`), and a virtualized problem list (`@tanstack/react-virtual`).

## Key Design Decisions

### 1. A fresh, locked-down Docker container per submission (not gVisor/Firecracker/seccomp)
`codeExecutor` uses `dockerode` to launch a container per run with `CapDrop: ALL`, `no-new-privileges`, no network, a read-only rootfs, tmpfs work dirs, and hard memory/pids/CPU limits. Trade-off: Docker's namespace+cgroup isolation shares the host kernel, so a kernel-level exploit could in principle escape — gVisor or Firecracker add a stronger barrier. We accept that residual risk because gVisor breaks some Python/Node syscalls and Firecracker is AWS-specific and operationally heavy; for a learning judge, `dockerode`-managed containers give strong isolation with tooling that's easy to reason about. (A separate hardened `sandbox` image exists under a compose `profiles: [sandbox]` block as an alternative isolation approach; the default path spawns its own per-run containers.)

### 2. Circuit breaker around code execution
Execution is wrapped in an Opossum breaker (opens at 50% error rate over 5+ requests, 30s reset). If the Docker daemon hangs or dies, the breaker trips and submissions fail fast with a 503 instead of piling up blocked requests. Trade-off: while open, some legitimate submissions are rejected — but the alternative (every request blocking on a dead daemon) takes the whole API down, and problem browsing/auth stay healthy because only the execution call is behind the breaker.

### 3. Two execution paths: in-process default, Kafka-queued for scale
This is the decision the old notes got wrong. **Kafka is implemented, not deferred.** By default (`USE_KAFKA_QUEUE=false`) a submission is processed in-process by an async `processSubmission` that returns `202` immediately and updates status in Redis/Postgres as it runs. Set `USE_KAFKA_QUEUE=true` and the API instead publishes a `SubmissionJob` to the `submissions` topic, and independent workers (`dev:worker1/2`) consume and execute it. Trade-off: in-process is simplest and fine locally, but execution capacity is tied to API processes and an API crash loses the in-flight run; the Kafka path decouples execution onto scalable, restartable workers at the cost of running a broker (hence Kafka+Zookeeper in compose).

### 4. Polling + Redis status cache instead of WebSocket
A run takes ~2–15s. The client `POST`s, gets a submission id, and polls `GET /:id/status`, which reads a Redis-cached status (sub-ms) that `processSubmission`/worker updates after each test case. Trade-off: up to ~1–2s of staleness vs. instant WebSocket push — imperceptible against a multi-second run, and it avoids persistent-connection lifecycle management and per-connection server memory.

### 5. Content-hash idempotency + tiered rate limits
Submissions are deduped by `hash(userId + problemSlug + normalizedCode + language)` with a 5-minute Redis TTL, and `express-rate-limit` enforces tiers (submissions 10/min, runs 30/min, general 100/min, auth 5 per 15 min). Trade-off: a genuine identical re-submit within 5 minutes is folded into the first — accepted, because the expensive, resource-bound execution path is exactly what must be protected from double-submits and retry storms.

## Current State

Implemented and running end to end: session auth (bcrypt + Redis store), problem catalog with caching, submit + run-against-samples + status polling, the `dockerode` executor for all four languages with the Opossum breaker, both execution paths (in-process default and Kafka worker), content-hash idempotency, tiered rate limiting, `prom-client` metrics, `pino` logging, `/health` + `/health/live` + `/health/ready`, graceful shutdown, and vitest tests (auth routes, idempotency, code executor). Frontend: catalog with virtualized list + filtering, CodeMirror editor, live test results, progress dashboard, admin page. Seed: 15 problems (easy/medium/hard) plus `admin`/`admin123` and `demo`/`user123`.

Intentionally omitted: plagiarism detection (MOSS), contests/time-limited submissions, WebSocket status push, and VM-grade isolation (gVisor/Firecracker).

## Iteration & Repair Log

- **Kafka execution path added, then mis-documented.** `shared/kafka.ts`, the worker, and the `USE_KAFKA_QUEUE` branch in `routes/submissions.ts` were built, and Kafka+Zookeeper added to compose — but the CLAUDE.md still claimed queue execution was "not needed… can add Kafka later." Corrected: Kafka is an implemented opt-in path.
- **Language set expanded.** The executor grew from Python/JS to four languages (added C++ via `gcc:13`, Java via `openjdk:21-slim`); older notes still said "Python and JavaScript."
- **Seed grown to 15 problems** (from 7) and vitest tests added for auth, idempotency, and the executor.
- **README command fix (this pass).** README step 3 used `npm run seed`, which doesn't exist; the scripts are `db:migrate` / `db:seed`. Fixed, and a `db:migrate` step added (schema also auto-applies via the `docker-entrypoint-initdb.d` init.sql mount on a fresh volume).
- **CLAUDE.md rewrite (this pass).** Replaced the Phase 1–4 checklist (with a self-contradictory "Phase 4: In progress" that then listed everything "Completed") with real architecture + decisions grounded in `codeExecutor.ts`, `routes/submissions.ts`, and `worker/index.ts`.

## Open Questions

1. **Credentials not normalized:** the seed uses `admin123` / `user123` (bcrypt); the repo-wide `password123` normalization never reached this seed. Align the seed (source change) or leave as documented?
2. **Large outputs:** a solution that prints megabytes should be truncated/streamed rather than buffered — where's the right cap, and does it count as wrong-answer or a distinct verdict?
3. **Plagiarism:** hash-based near-duplicate detection is cheap but weak; is MOSS-style structural comparison worth the complexity for a practice platform?
4. **Warm containers:** per-run container startup dominates latency for fast solutions. Would a pool of pre-warmed, reset-between-runs containers be safe, or does reuse risk state bleed between submissions?

## Resources

- [Docker security](https://docs.docker.com/engine/security/) — the isolation primitives the executor relies on
- [dockerode](https://github.com/apocas/dockerode) — programmatic container lifecycle
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
- [KafkaJS](https://kafka.js.org/) — the optional queue path
