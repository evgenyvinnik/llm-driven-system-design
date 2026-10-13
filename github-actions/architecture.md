# GitHub Actions — Architecture Design

## System Overview

A CI/CD service in the style of GitHub Actions. A push, pull request, tag, schedule, or manual dispatch triggers the workflows a repository declares as YAML in `.github/workflows/`. Each workflow becomes a **run**: a directed acyclic graph of **jobs** (edges from `needs:`, fan-out from `strategy.matrix`). The platform schedules the jobs onto a shared fleet of ephemeral runner VMs, streams their logs live, stores their artifacts and dependency caches, and reports the outcome back to the pull request as checks. The system is multi-tenant: millions of repositories share the same runner pools, and arbitrary user code runs on our machines next to the tenant's secrets.

The prompt (OpenAI's Staff list: "a CI/CD system similar to GitHub Actions") is framed around reliability and operational trade-offs, not YAML features. Three properties drive this design:

1. **No job is silently lost, and no result is recorded twice.** Runners die mid-job, networks partition, and webhooks arrive twice. Execution is at-least-once, so every state transition must be idempotent and every runner write must be fenced.
2. **The data plane is huge and the control plane is small.** Logs, artifacts, and cache restores move terabytes per hour. Scheduling decisions are a few thousand per second. Bytes never flow through the control plane.
3. **Untrusted code sits next to secrets.** Isolation (one VM per job), scoping (forked pull requests get no secrets), and short-lived credentials matter as much as throughput.

**Learning goals:** DAG scheduling with event-driven readiness; leases, heartbeats, and fencing tokens for at-least-once execution; pull-based dispatch with per-tenant fair share; warm-pool sizing with Little's law; separating a live, loss-tolerant log path from an archival, authoritative one; and cache scoping that prevents poisoning.

## Requirements

### Functional Requirements

- **Triggers**: accept push, pull_request, tag, schedule, and manual (`workflow_dispatch`) events, and evaluate each workflow's `on:` filters (event type, branch and tag globs, changed paths).
- **Workflow parsing**: read workflow YAML pinned to the triggering commit SHA, expand matrices, build the job DAG from `needs:`, and turn cycles or invalid files into a visible failed run.
- **Scheduling**: queue jobs whose dependencies are satisfied, match them to runners by label (`runs-on`), and enforce per-organization concurrency limits by plan.
- **Execution**: run each job on a fresh ephemeral runner, report per-step status, and enforce job timeouts.
- **Control flow**: `if:` expressions, skip propagation, matrix fail-fast, concurrency groups with `cancel-in-progress`, run and job cancellation, and environment approval gates.
- **Logs**: stream step logs live, and keep archived logs for 90 days with random access by line range.
- **Artifacts and caches**: upload and download build artifacts; save and restore dependency caches by key, with prefix fallback.
- **Secrets**: org-, repo-, and environment-scoped encrypted secrets, delivered only to jobs entitled to them and masked in logs.
- **Re-runs**: re-run all jobs, only the failed jobs (plus their dependents), or a single job, as a new attempt.
- **Reporting**: check runs on commits and pull requests, run history, and status badges.

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Event durability | Zero acknowledged trigger events lost; a duplicate delivery never creates a duplicate run |
| Job durability | Every queued job reaches a terminal state; none is silently dropped |
| Trigger latency | Event received → run created: p99 < 10 s |
| Queue latency (hosted, warm pool) | Job queued → assigned to a runner: p50 < 5 s, p99 < 60 s |
| Live log latency | Line printed on the runner → visible in the browser: p95 < 2 s |
| Status latency | Job state change → UI p95 < 2 s; → pull request check p95 < 10 s |
| Control-plane availability | 99.95% (about 22 minutes a month); running jobs keep running through control-plane blips |
| Runner-loss detection | ≤ 70 s (60 s lease TTL + 10 s sweep interval) |
| Isolation | Nothing (files, processes, credentials) survives from one job to the next on hosted runners |

### Out of Scope

- The Git host itself (repositories, pushes, review). See [GitHub](../github/). We consume its events and call its Checks API.
- An actions marketplace, action publishing, and supply-chain verification of third-party actions.
- Build-specific features such as test sharding by timing, flaky-test detection, or remote build execution.
- Billing beyond counting runner-minutes per organization.

## Capacity Estimation

### Assumptions

| Input | Value |
|-------|-------|
| Trigger events | 50M/day |
| Runs per event (most pushes match no workflow; some match several) | 0.2 → 10M runs/day |
| Jobs per run, after matrix expansion | 4 → 40M jobs/day |
| Steps per job | 10 |
| Mean job duration | 5 minutes (300 s) |
| Peak-to-average ratio | 3:1 (overlapping US and EU working hours) |
| Log output per job | 1 MB raw (about 10K lines of 100 B), 5:1 gzip |
| Jobs that upload artifacts | 10%, 50 MB mean |
| Jobs that restore a dependency cache | 50%, 200 MB mean |
| Runner cold boot from a VM snapshot | 30 s |
| Heartbeat interval / lease TTL | 15 s / 60 s |

### Derived Load

| Quantity | Calculation | Result |
|----------|-------------|--------|
| Event ingest | 50M / 86,400 s | ≈ 580/s average, ≈ 1,740/s peak |
| Job starts | 40M / 86,400 s | ≈ 463/s average, ≈ 1,390/s peak |
| Concurrent running jobs (Little's law) | 463/s × 300 s; 1,390/s × 300 s | ≈ 139K average, ≈ 417K peak |
| Runner time | 40M × 5 min | 200M runner-minutes/day |
| Status writes (4 job transitions + 2 per step = 24 per job) | 40M × 24 = 960M/day | ≈ 11.1K/s average, ≈ 33K/s peak |
| Heartbeats | 139K / 15 s; 417K / 15 s | ≈ 9.3K/s average, ≈ 27.8K/s peak (Redis, not PostgreSQL) |
| Log ingest | 40M × 1 MB = 40 TB/day | ≈ 463 MB/s average, ≈ 1.4 GB/s peak |
| Log chunk appends (one 1-second flush per running job, at most) | | ≤ 139K/s average, ≤ 417K/s peak |
| Cache restore bandwidth | 40M × 50% × 200 MB = 4 PB/day | ≈ 46 GB/s (≈ 370 Gbps) average, ≈ 1.1 Tbps peak |
| Warm pool needed to hide boot time | 1,390 starts/s × 30 s | ≈ 42K VMs booting or idle at peak (≈ 10% of the fleet) |
| Backlog if dispatch stalls for 10 minutes at peak | 1,390/s × 600 s | ≈ 834K queued jobs |

> Two numbers shape everything. The control plane makes about 1,400 scheduling decisions and 33K status writes per second at peak, which a handful of sharded PostgreSQL clusters can handle. The data plane moves about 1.4 GB/s of log text and 1.1 Tbps of cache restores, which nothing in the control plane could proxy. Runners therefore talk to object storage directly through signed URLs, and the API tier never touches bytes.

### Storage

| Data | Daily | Retention | Footprint |
|------|-------|-----------|-----------|
| Logs (compressed) | 40 TB / 5 = 8 TB | 90 days | ≈ 720 TB |
| Artifacts | 40M × 10% × 50 MB = 200 TB | 90 days | ≈ 18 PB |
| Cache entries | bounded by a 10 GB per-repository quota (LRU) | 7 days unused | quota-bound |
| Run metadata (runs 1 KB, jobs 500 B, steps 200 B) | 10 GB + 20 GB + 80 GB = 110 GB | 1 year | ≈ 40 TB before replication |
| Live log hot tail (≤ 60 s per running job at 3.3 KB/s ≈ 200 KB) | — | until sealed | ≈ 83 GB in Redis at peak |

Artifacts dominate storage; cache restores dominate bandwidth; log chunks dominate request count.

### Local Development Scale

Three runner agents, each running one job container at a time; about 10 runs an hour with about 5 jobs each; a log generator that can emit 500K lines to exercise the viewer. PostgreSQL holds a few megabytes and MinIO a few gigabytes.

## High-Level Architecture

```
┌──────────────────────┐            ┌────────────────────────────────────────────────────┐
│ Git host             │            │ Browsers · CLI · REST clients                      │
│ push · PR · tag      │            └───────────┬─────────────────────────────┬──────────┘
└──────────┬───────────┘                        │ REST · SSE                  │ badge.svg
           │ HMAC-signed webhook                ▼                             ▼
           ▼                         ┌──────────────────────┐      ┌──────────────────────┐
┌──────────────────────┐             │ API Gateway          │      │ CDN                  │
│ Event Gateway        │             │ authn · rate limits  │      │ badges · static UI   │
│ verify · write · ack │             └──────────┬───────────┘      └──────────────────────┘
└──────────┬───────────┘                        │
           ▼                                    ▼
┌──────────────────────┐   ┌──────────────────────────────────────────────────────────────┐
│ Event log (Kafka)    │──▶│ CONTROL PLANE CELL (repositories hashed across 16 cells)     │
│ keyed by repo_id     │   │                                                              │
└──────────────────────┘   │  Workflow Resolver ───▶ Run Orchestrator ───▶ Outbox relay   │
                           │  YAML @ SHA · matrix    DAG transitions ·     job.ready ·    │
                           │  · DAG · run + jobs     concurrency · cancel  check runs     │
                           │                                                              │
                           │            ┌────────────────────────────────────┐            │
                           │            │ PostgreSQL: runs · jobs · steps ·  │            │
                           │            │ lease epochs · outbox              │            │
                           │            └────────────────────────────────────┘            │
                           └──────────────────────────────┬───────────────────────────────┘
                                                          │ ready jobs
                                                          ▼
                           ┌──────────────────────────────────────────────────────────────┐
                           │ DISPATCH (per region)                                        │
                           │  Job Broker: pool queues · per-org fair share · leases       │
                           │  Fleet Manager: warm pools · VM launch/destroy · autoscaling │
                           └──────────────────────────────┬───────────────────────────────┘
                                                          │ acquire (long poll) · heartbeat
                                                          ▼ · step status · complete
                           ┌──────────────────────────────────────────────────────────────┐
                           │ RUNNER FLEET: one ephemeral VM per job, destroyed afterwards │
                           └───────┬──────────────────────┬───────────────────────┬───────┘
                                   │ log chunks           │ signed-URL PUT/GET    │ secrets
                                   ▼                      ▼                       ▼
                           ┌────────────────┐   ┌───────────────────┐   ┌──────────────────┐
                           │ Log Service    │   │ Object storage    │   │ Secrets Service  │
                           │ hot tail · SSE │   │ log segments ·    │   │ KMS envelope     │
                           │ fan-out        │   │ artifacts · cache │   │ encryption       │
                           └────────────────┘   └───────────────────┘   └──────────────────┘
```

The API Gateway routes REST calls to the cell that owns the repository and routes SSE streams to the Log Service and to the cell's status channel. The Artifact/Cache Service (not drawn) is a thin metadata service beside object storage that issues signed URLs.

| Component | Responsibility | Scales with |
|-----------|----------------|-------------|
| Event Gateway | Verify webhook signature, append to Kafka, acknowledge | Events/s (stateless) |
| Workflow Resolver | Fetch YAML at the commit SHA, evaluate filters, build the plan, insert run and jobs | Events/s |
| Run Orchestrator | DAG transitions, `if:` evaluation, fail-fast, concurrency groups, cancellation, timeouts | Job completions/s |
| Outbox relay | Publish `job.ready` to the broker and check-run updates to the Git host | Transitions/s |
| Job Broker | Per-pool, per-organization queues; acquire; lease tracking | Job starts/s, heartbeats/s |
| Fleet Manager | Warm pools per runner image and size; VM lifecycle | VM launches/s |
| Runner agent | Execute steps, mask and stream logs, seal log segments, upload artifacts | One per VM |
| Log Service + SSE gateways | Ingest chunks, keep the unsealed tail, fan out to viewers, serve line ranges | Log bytes/s, viewers |
| Artifact/Cache Service | Metadata and signed URLs; never proxies bytes | Requests/s |
| Secrets Service | Decrypt and deliver scoped secrets at acquire time | Job starts/s |

## Core Components / Request Flows

### 1. Trigger → Run

1. The Git host POSTs a signed webhook with a unique `delivery_id`. The Event Gateway verifies the HMAC-SHA256 signature over the raw body, rejects timestamps more than 5 minutes old, appends the event to Kafka (keyed by `repo_id`, `acks=all`), and only then returns 2xx. Payloads over 1 MB go to object storage with a pointer in the message.
2. Per-repository ordering in Kafka matters: two pushes to the same branch must be resolved in order, or "latest push wins" in a concurrency group could pick the wrong one.
3. The Workflow Resolver inserts the event into `trigger_events` (`ON CONFLICT (delivery_id) DO NOTHING`). It then lists `.github/workflows/` **at the event's head SHA**. Most pushes don't touch workflow files, so the parsed files are cached by tree SHA.
4. For each file it parses the YAML (512 KB limit), validates the schema, and evaluates `on:` filters. Path filters use the push's changed-file list; if that list is truncated, the filter is treated as matched.
5. For each matching workflow it builds the **plan**: matrix expansion (cartesian product with `include`/`exclude`, capped at 256 legs), reusable-workflow inlining (depth-limited), `needs` edges, and cycle detection with Kahn's algorithm. The plan is stored content-addressed in object storage (`plan_key`), so re-runs execute exactly the same graph.
6. In one transaction on the repository's cell it inserts the run (`UNIQUE (workflow_id, delivery_id)`), all jobs with `pending_needs = len(needs)`, and the step placeholders. Jobs with no needs become `queued` and get a `job.ready` outbox row. It also applies the concurrency-group rule (flow 4) and marks the event resolved. The Kafka offset is committed after the transaction, so a crash in between replays the event into a unique-constraint no-op.
7. A file that fails to parse produces a run with conclusion `startup_failure` and an annotation. The event is still marked resolved. A poison event must never block its Kafka partition.

```
build ──┬──▶ test (matrix: 3 Node versions × 2 OSes = 6 jobs) ──┬──▶ deploy-staging ──▶ deploy-prod
        │                                                        │                     (environment gate)
        └──▶ lint ───────────────────────────────────────────────┘
```

### 2. DAG Progression

Readiness is event-driven: no scheduler scans runs looking for ready jobs. Each job row carries `pending_needs`, the count of its `needs` that haven't completed. The completion of a job is one transaction on the cell:

```sql
BEGIN;
-- 1. Fenced, idempotent transition. 0 rows means a duplicate or stale report.
UPDATE jobs SET status = 'completed', conclusion = $1, completed_at = now(), version = version + 1
 WHERE id = $job AND lease_epoch = $epoch AND status <> 'completed'
RETURNING run_id, run_attempt, job_key;

-- 2. Release dependents exactly once, in the same transaction as the transition.
UPDATE jobs SET pending_needs = pending_needs - 1, version = version + 1
 WHERE run_id = $run AND run_attempt = $attempt AND $job_key = ANY(needs) AND status = 'pending'
RETURNING id, pending_needs, if_expr;

-- 3. For each dependent that reached pending_needs = 0, evaluate if_expr against its needs' conclusions:
--      true  → status = 'queued', INSERT outbox ('job.ready', dedupe 'job.ready:{id}:{epoch}')
--      false → status = 'completed', conclusion = 'skipped', then repeat step 2 for its dependents
-- 4. Matrix fail-fast: if this leg failed and fail_fast is set, cancel unfinished sibling legs.
-- 5. If no job in this attempt is unfinished, set the run's conclusion and INSERT outbox ('run.completed').
COMMIT;
```

The default `if:` is `success()`: all needs succeeded. `always()`, `failure()`, and `cancelled()` let cleanup and notification jobs run after upstream failures. Skip propagation (step 3's false branch) is iterative and bounded by the job count of the run (capped at 500).

### 3. Dispatch, Leases, and Execution

**Pools.** A `runs-on` label set maps to a pool, for example `ubuntu-24.04 · 4-core · x64 · us-east`. Self-hosted runners form pools per organization and label set. A runner registered with labels {self-hosted, linux, gpu} polls every pool whose required labels are a subset of its own (precomputed at registration).

**Queues.** The outbox relay pushes `job.ready` into a Redis sorted set per (pool, organization), scored by `queued_at`. The insert is idempotent, and order within an organization is FIFO. The broker serves organizations with deficit round robin and skips any organization at its plan's concurrency cap (a Redis counter reconciled from PostgreSQL every minute). PostgreSQL is the source of truth: a reconciler re-pushes any job that has been `queued` for 30 s without appearing in the broker, so losing Redis delays jobs but never loses them.

**Acquire.** Runners pull; nothing pushes to them. A runner long-polls `acquire` for up to 50 s. The broker pops a job and fences ownership in the cell:

```sql
UPDATE jobs SET status = 'assigned', lease_epoch = lease_epoch + 1, dispatch_count = dispatch_count + 1,
                runner_id = $runner, version = version + 1
 WHERE id = $job AND status = 'queued'
RETURNING lease_epoch;   -- 0 rows: cancelled or already taken; drop it and pop the next job
```

It then writes `lease:{job_id} = epoch` (TTL 60 s) plus an entry in a `lease_expiry` sorted set, fetches the job's secrets (flow 7), and returns the job message: resolved steps, environment, job token, encrypted secrets, and `lease_epoch`.

**Heartbeats.** Every 15 s the runner calls `heartbeat(job, epoch)`. The broker checks that Redis still holds the same epoch, extends the TTL, and replies with `cancel_requested`. Heartbeats never touch PostgreSQL. At 27.8K/s at peak they would double the cell write load for no durable benefit.

**Fencing.** Every runner write (step status, log chunk, segment sealed, complete) carries `(job_id, lease_epoch)`. Every ownership change, grant or revocation, increments the epoch. A runner whose lease was revoked gets `409 stale_epoch` on its next call and aborts the job. Its writes can never overwrite the new owner's state.

**Lease expiry.** A sweeper runs every 10 s over expired `lease_expiry` entries. It bumps the epoch in PostgreSQL (revoking the old holder) and applies the retry policy:

| Situation at expiry | Action | Why |
|---------------------|--------|-----|
| No user step started (`user_steps_started = false`) | Requeue automatically, up to 3 dispatches | Nothing user-visible ran; always safe |
| User steps started, no protected environment | Requeue once, annotated "re-dispatched after runner loss" | Builds and tests are idempotent; the user would click re-run anyway |
| Job targets a protected environment (deploy) | Complete as `failure`, reason `runner_lost`; no automatic retry | A deploy may have half-happened; a human decides |

If Redis loses lease data, nothing expires wrongly. A reconciler (every 5 minutes) finds `assigned`/`in_progress` jobs without a lease key and recreates one with a fresh 60 s TTL. Live runners keep refreshing it, and dead runners' leases expire normally. Redis loss delays loss detection but never causes a false expiry.

**Execution.** The runner sets up the workspace (checkout, action downloads, service containers), runs each step as a child process group, reports step transitions (monotonic, so replays are harmless), enforces `timeout-minutes` locally, and calls `complete`. A server-side watchdog also cancels `in_progress` jobs past their timeout plus a grace period, in case the runner itself is stuck. On completion the Fleet Manager destroys the VM.

### 4. Concurrency Groups and Cancellation

A workflow (or job) may declare `concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: true }`. The rule is **at most one running and one pending per group**. A newer arrival replaces the pending one, and with `cancel-in-progress` it also cancels the running one. Groups are scoped to a repository, so the group row and every run it touches live on the same cell. The rule is applied in the run-creation transaction while holding `SELECT ... FOR UPDATE` on `concurrency_groups (repo_id, group_key)`:

1. No holder: this run becomes `running_run_id` and proceeds.
2. Holder exists: cancel the current `pending_run_id` (superseded) and make this run pending (`pending_concurrency`). If `cancel-in-progress` is set, request cancellation of the holder.
3. When the holder completes, the pending run is promoted in the same transaction.

**Cancellation** sets the run to `cancelling`. In that same transaction, jobs that are `pending`, `waiting`, or `queued` complete as `cancelled`. The broker deletes queue entries lazily: its conditional `UPDATE ... WHERE status = 'queued'` simply fails. Jobs that are `assigned` or `in_progress` move to `cancelling` and get a `job.cancel` outbox row, which reaches the runner within about a second over its control long-poll. The heartbeat reply is the backstop, within 15 s. The runner sends SIGINT to the step's process group, escalates to SIGKILL after a 10 s grace period, runs `if: always()` post-steps under a 5-minute budget, and reports `cancelled`. If the runner never answers, lease expiry completes the job as `cancelled` and the Fleet Manager destroys the VM.

### 5. Logs: a Live Path and an Archival Path

```
runner ──chunk/1 s──▶ Log Service ──▶ Redis stream (unsealed tail) ──▶ SSE gateway ──▶ viewers
   │                                         ▲ trimmed when sealed
   └──seal every 60 s / 10K lines / step end──▶ object storage segment (gzip) ──▶ range reads
```

1. The runner captures each step's stdout and stderr, **masks secrets before any byte leaves the VM** (exact values plus their base64 and URL-encoded forms), numbers lines per step, and parses workflow commands: `::group::`/`::endgroup::` become structured group events, and `::error file=…,line=…::` becomes an annotation.
2. Every second (or every 64 KB) it POSTs a chunk `(job, epoch, step, first_line, lines)`. The Log Service validates the epoch (cached), appends the chunk to `log:{job}:{epoch}:{step}`, and ignores it if `first_line` is below the next expected line. That makes a retried chunk idempotent.
3. Every 60 s, every 10K lines, and at step end, the runner **seals** a segment: it gzips those lines from its local spool, PUTs them to object storage through a signed URL, and reports the segment and its line range. The Log Service trims the hot stream up to that line. The hot store therefore only holds unsealed tails, about 83 GB at peak.
4. SSE gateways hold one Redis reader per watched job per node and fan out in-process, so a public job with 5,000 viewers costs one Redis read per gateway node, not 5,000. Event IDs are `{epoch}:{step}:{line}`. A reconnecting client resumes with `Last-Event-ID`. If its position has already been sealed, the gateway sends a `resync` event pointing at the range API.
5. At job end the Log Service writes a manifest (segments and line ranges) and stores its key on the job. Range reads (`from_line`, `limit`) fetch at most a couple of segments of 10K lines (about 200 KB compressed), so the UI can jump to line 400,000 of a huge log without downloading the rest.

The archive is authoritative because the runner uploads it from its complete local spool. The live path may drop chunks under overload without losing anything permanently. If a VM dies, at most the last unsealed minute exists only in Redis. A finalizer seals that minute from the hot stream and marks the log "may be incomplete".

### 6. Artifacts and Caches

**Artifacts.** `create` inserts an `uploading` row and returns signed multipart URLs (8 MB parts). The runner uploads directly to object storage, then calls `finalize` with the size and SHA-256. Artifacts are immutable per `(run_id, name)`. Downloads are a 302 to a short-lived signed URL after an access check. A daily job deletes expired objects and marks their rows `expired`.

**Caches.** An entry is identified by `(repo_id, scope_ref, key, version)`, where `version` hashes the cached paths, compression method, and runner OS, so a Windows tarball never restores onto Linux. Restore resolution:

1. Exact key in the current ref's scope.
2. Each `restore-keys` prefix in the current scope, newest first.
3. Steps 1–2 in the pull request's base branch scope, then in the default branch scope.

Saves go only to the current scope. A pull request can read `main`'s cache but never write it, so a malicious branch cannot poison the cache that `main` restores. Saves `reserve` the key first (`INSERT ... ON CONFLICT DO NOTHING`, so the first writer wins and entries are immutable). Each repository has a 10 GB LRU quota, and entries unused for 7 days are evicted. `last_accessed_at` is updated at most hourly per entry, which avoids 20M row updates a day. Cache storage is regional, next to the runners that read it, because 1.1 Tbps of peak restore traffic cannot cross regions.

### 7. Secrets Delivery

At acquire time the broker asks the Secrets Service for the secrets **referenced by this job** in its scopes (organization → repository → environment, most specific wins). The service unwraps each data key with the KMS (unwrapped keys are cached in memory for at most 5 minutes) and encrypts the values to the runner's session public key, which the runner generated at boot. Plaintext secrets are never written to the database, the outbox, a queue, or a log.

- Pull requests from forks get **no secrets** and a read-only job token. First-time contributors' runs wait in `waiting` until a maintainer approves.
- Environment secrets are released only after the environment's required reviewers approve. Until then the job sits in `waiting`.
- The job token is scoped by the workflow's `permissions:` block, expires at the job timeout plus 10 minutes, and is revoked on completion. For cloud deploys, jobs exchange an OIDC token (claims: repo, ref, environment, run ID) for short-lived cloud credentials, so no long-lived cloud keys are stored at all.

### 8. Re-runs, Checks, and Badges

**Re-run failed jobs** creates attempt N+1 of the same run against the same `plan_key` and SHA. Jobs that succeeded in attempt N are copied as `completed` and linked to the originals for logs and artifacts. Failed and cancelled jobs, plus everything downstream of them, are recreated as `pending`, with `pending_needs` counting only needs that weren't copied. Secrets are read fresh at acquire time and are not snapshotted with the attempt. The request carries an `Idempotency-Key`, so a double-click creates one attempt.

**Checks.** Job transitions write `check_run.update` outbox rows. The relay publishes them to the Git host's Checks API behind a circuit breaker and coalesces per check run: if five updates are waiting, only the latest is sent. Required-check gating for merges is the Git host's decision. We only report.

**Badges.** Run completion upserts `workflow_branch_status` only if the new run number is higher, so an older run that finishes late can't regress the badge. The badge endpoint renders an SVG from that one row, served with `Cache-Control: public, max-age=60` from the CDN. Badges are embedded in READMEs across the web and must never reach the run tables.

### 9. UI

The run page combines a snapshot (`GET run`, with versions) with an SSE stream of job and step deltas. Deltas apply only if their version is newer. The DAG is laid out once per attempt, and status changes only recolor nodes. The log viewer virtualizes rows, parses ANSI escapes in a Web Worker, folds groups, and pages by line range for logs too large to hold in memory. The PR checks view lists check runs for the head SHA, and a new push marks the old ones outdated. The frontend answer covers this in depth.

## Database Schema

All control-plane tables are sharded by `repo_id`. Every row of a run lives on one cell, so DAG transitions never need distributed transactions.

```sql
CREATE TABLE repositories (
  id               BIGINT PRIMARY KEY,
  org_id           BIGINT NOT NULL,
  full_name        TEXT NOT NULL UNIQUE,
  visibility       TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  default_branch   TEXT NOT NULL DEFAULT 'main',
  actions_enabled  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE workflows (
  id               BIGSERIAL PRIMARY KEY,
  repo_id          BIGINT NOT NULL REFERENCES repositories(id),
  path             TEXT NOT NULL,                  -- .github/workflows/ci.yml
  name             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  next_run_number  INTEGER NOT NULL DEFAULT 1,     -- gaps are acceptable
  UNIQUE (repo_id, path)
);

CREATE TABLE trigger_events (
  delivery_id      UUID PRIMARY KEY,               -- Git host delivery ID: the dedupe key
  repo_id          BIGINT NOT NULL REFERENCES repositories(id),
  event_type       TEXT NOT NULL,                  -- push, pull_request, workflow_dispatch, schedule
  ref              TEXT NOT NULL,
  head_sha         CHAR(40) NOT NULL,
  actor_id         BIGINT,
  from_fork        BOOLEAN NOT NULL DEFAULT FALSE,
  payload_key      TEXT,                           -- object storage key for large payloads
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX idx_events_unresolved ON trigger_events (received_at) WHERE resolved_at IS NULL;

CREATE TABLE environments (
  id                  BIGSERIAL PRIMARY KEY,
  repo_id             BIGINT NOT NULL REFERENCES repositories(id),
  name                TEXT NOT NULL,               -- production, staging
  required_reviewers  BIGINT[] NOT NULL DEFAULT '{}',
  allowed_refs        TEXT[] NOT NULL DEFAULT '{}', -- branch globs that may deploy here
  UNIQUE (repo_id, name)
);

CREATE TABLE workflow_runs (
  id                 BIGSERIAL PRIMARY KEY,
  repo_id            BIGINT NOT NULL REFERENCES repositories(id),
  workflow_id        BIGINT NOT NULL REFERENCES workflows(id),
  delivery_id        UUID NOT NULL REFERENCES trigger_events(delivery_id),
  run_number         INTEGER NOT NULL,
  run_attempt        INTEGER NOT NULL DEFAULT 1,
  event_type         TEXT NOT NULL,
  ref                TEXT NOT NULL,
  head_sha           CHAR(40) NOT NULL,
  plan_key           TEXT NOT NULL,                -- immutable resolved job graph in object storage
  concurrency_group  TEXT,
  status             TEXT NOT NULL CHECK (status IN
                       ('pending_concurrency', 'queued', 'in_progress', 'cancelling', 'completed')),
  conclusion         TEXT CHECK (conclusion IN
                       ('success', 'failure', 'cancelled', 'skipped', 'startup_failure')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  version            BIGINT NOT NULL DEFAULT 1,    -- monotonic; clients drop older deltas
  UNIQUE (workflow_id, delivery_id),               -- a duplicate webhook maps to the same run
  UNIQUE (workflow_id, run_number),
  CHECK ((status = 'completed') = (conclusion IS NOT NULL))
);
CREATE INDEX idx_runs_repo_recent ON workflow_runs (repo_id, created_at DESC, id DESC);
CREATE INDEX idx_runs_workflow_ref ON workflow_runs (workflow_id, ref, created_at DESC);
CREATE INDEX idx_runs_head_sha ON workflow_runs (repo_id, head_sha);

CREATE TABLE jobs (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              BIGINT NOT NULL REFERENCES workflow_runs(id),
  repo_id             BIGINT NOT NULL,
  run_attempt         INTEGER NOT NULL,
  job_key             TEXT NOT NULL,               -- YAML id + matrix hash, e.g. "test(node=20,os=linux)"
  display_name        TEXT NOT NULL,
  needs               TEXT[] NOT NULL DEFAULT '{}',
  pending_needs       INTEGER NOT NULL CHECK (pending_needs >= 0),
  if_expr             TEXT,
  runs_on             TEXT[] NOT NULL,             -- label set → pool
  environment_id      BIGINT REFERENCES environments(id),
  matrix_values       JSONB,
  status              TEXT NOT NULL CHECK (status IN
                        ('pending', 'waiting', 'queued', 'assigned', 'in_progress', 'cancelling', 'completed')),
  conclusion          TEXT CHECK (conclusion IN
                        ('success', 'failure', 'cancelled', 'skipped', 'timed_out')),
  conclusion_reason   TEXT,                        -- runner_lost, step_failed, timeout, superseded
  lease_epoch         INTEGER NOT NULL DEFAULT 0,  -- fencing token: bumped on every grant and revocation
  dispatch_count      SMALLINT NOT NULL DEFAULT 0,
  runner_id           BIGINT,
  user_steps_started  BOOLEAN NOT NULL DEFAULT FALSE,
  copied_from_job_id  BIGINT,                      -- re-run of failed jobs: link to the successful original
  log_manifest_key    TEXT,
  timeout_minutes     INTEGER NOT NULL DEFAULT 360,
  queued_at           TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  version             BIGINT NOT NULL DEFAULT 1,
  UNIQUE (run_id, run_attempt, job_key),
  CHECK ((status = 'completed') = (conclusion IS NOT NULL))
);
CREATE INDEX idx_jobs_run_attempt ON jobs (run_id, run_attempt);
CREATE INDEX idx_jobs_active ON jobs (status, queued_at)
  WHERE status IN ('queued', 'assigned', 'in_progress', 'cancelling');
CREATE INDEX idx_jobs_timeout ON jobs (started_at) WHERE status = 'in_progress';

CREATE TABLE steps (
  job_id        BIGINT NOT NULL REFERENCES jobs(id),
  lease_epoch   INTEGER NOT NULL,                  -- a re-dispatch gets fresh step rows
  number        SMALLINT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
  conclusion    TEXT CHECK (conclusion IN ('success', 'failure', 'cancelled', 'skipped')),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  log_lines     INTEGER,
  PRIMARY KEY (job_id, lease_epoch, number)
);

CREATE TABLE runners (
  id              BIGSERIAL PRIMARY KEY,
  pool            TEXT NOT NULL,                   -- hosted:ubuntu-24.04:4core:x64:us-east | self:org-42:gpu
  org_id          BIGINT,                          -- NULL for hosted runners
  labels          TEXT[] NOT NULL,
  ephemeral       BOOLEAN NOT NULL DEFAULT TRUE,
  state           TEXT NOT NULL CHECK (state IN ('booting', 'idle', 'busy', 'draining', 'gone')),
  agent_version   TEXT NOT NULL,
  session_pubkey  BYTEA NOT NULL,                  -- secrets are encrypted to this key
  current_job_id  BIGINT,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ
);
CREATE INDEX idx_runners_pool_state ON runners (pool, state);

CREATE TABLE concurrency_groups (
  repo_id         BIGINT NOT NULL,
  group_key       TEXT NOT NULL,
  running_run_id  BIGINT,
  pending_run_id  BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, group_key)
);

CREATE TABLE artifacts (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES workflow_runs(id),
  job_id       BIGINT NOT NULL REFERENCES jobs(id),
  name         TEXT NOT NULL,
  size_bytes   BIGINT,
  sha256       CHAR(64),
  storage_key  TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('uploading', 'finalized', 'expired')),
  expires_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, name)                            -- immutable per run
);
CREATE INDEX idx_artifacts_expiry ON artifacts (expires_at) WHERE state = 'finalized';

CREATE TABLE cache_entries (
  id                BIGSERIAL PRIMARY KEY,
  repo_id           BIGINT NOT NULL,
  scope_ref         TEXT NOT NULL,                 -- refs/heads/main, refs/pull/42/merge
  cache_key         TEXT NOT NULL,
  version           CHAR(64) NOT NULL,             -- hash(paths, compression, runner OS)
  size_bytes        BIGINT,
  storage_key       TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('reserved', 'committed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, scope_ref, cache_key, version)  -- first writer wins
);
CREATE INDEX idx_cache_prefix ON cache_entries (repo_id, scope_ref, version, cache_key text_pattern_ops);
CREATE INDEX idx_cache_lru ON cache_entries (repo_id, last_accessed_at);

CREATE TABLE secrets (
  id           BIGSERIAL PRIMARY KEY,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('org', 'repo', 'environment')),
  scope_id     BIGINT NOT NULL,                    -- org id, repo id, or environments.id
  name         TEXT NOT NULL,
  ciphertext   BYTEA NOT NULL,                     -- AES-256-GCM under a per-scope data key
  wrapped_dek  BYTEA NOT NULL,                     -- data key wrapped by the KMS master key
  kms_key_id   TEXT NOT NULL,
  updated_by   BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, name)
);

CREATE TABLE workflow_branch_status (           -- badge source; one row per workflow and branch
  workflow_id   BIGINT NOT NULL REFERENCES workflows(id),
  ref           TEXT NOT NULL,
  run_id        BIGINT NOT NULL,
  run_number    INTEGER NOT NULL,                  -- upsert only WHERE excluded.run_number > run_number
  conclusion    TEXT NOT NULL,
  completed_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workflow_id, ref)
);

CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  repo_id       BIGINT NOT NULL,
  topic         TEXT NOT NULL,                     -- job.ready, job.cancel, check_run.update, run.completed
  dedupe_key    TEXT NOT NULL UNIQUE,              -- e.g. job.ready:{job_id}:{lease_epoch}
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

**Redis keys (per region):** `queue:{pool}:{org}` (sorted set, score `queued_at`), `org_running:{org}` (counter), `lease:{job}` (epoch, TTL 60 s), `lease_expiry` (sorted set), `log:{job}:{epoch}:{step}` (stream holding the unsealed tail), `log_segments:{job}` (list until the manifest is written), and `warm:{pool}` (idle runner IDs).

## API Design

```
# Public API (UI, CLI, integrations)
GET    /api/v1/repos/:owner/:repo/actions/runs?workflow=&branch=&status=&cursor=  → run list (cursor on created_at, id)
GET    /api/v1/repos/:owner/:repo/actions/runs/:runId?attempt=N                   → run + jobs + needs edges + versions
POST   /api/v1/repos/:owner/:repo/actions/runs/:runId/cancel                      → request cancellation
POST   /api/v1/repos/:owner/:repo/actions/runs/:runId/rerun                       → new attempt, all jobs
POST   /api/v1/repos/:owner/:repo/actions/runs/:runId/rerun-failed                → new attempt, failed jobs + dependents
POST   /api/v1/repos/:owner/:repo/actions/jobs/:jobId/rerun                       → new attempt, one job + dependents
POST   /api/v1/repos/:owner/:repo/actions/jobs/:jobId/approve                     → environment approval
GET    /api/v1/repos/:owner/:repo/actions/jobs/:jobId/logs?step=&from_line=&limit= → log line range (hot or archived)
GET    /api/v1/repos/:owner/:repo/actions/jobs/:jobId/logs/search?q=              → matching line numbers
GET    /api/v1/repos/:owner/:repo/actions/runs/:runId/artifacts                   → artifact list
GET    /api/v1/repos/:owner/:repo/actions/artifacts/:id/download                  → 302 to a signed URL
POST   /api/v1/repos/:owner/:repo/actions/workflows/:file/dispatches              → manual trigger
GET    /api/v1/repos/:owner/:repo/commits/:sha/check-runs                         → PR checks view
GET    /stream/v1/runs/:runId                                    (SSE)            → job and step status deltas
GET    /stream/v1/jobs/:jobId/logs?step=                         (SSE)            → live lines; resume via Last-Event-ID
GET    /badges/:owner/:repo/workflows/:file/badge.svg?branch=main                 → CDN-cached SVG
POST   /webhooks/v1/git                                                           → HMAC-verified trigger events

# Runner protocol (runner credential; every job-scoped call carries lease_epoch)
POST   /runner/v1/sessions                    → register: one-time token + session public key → runner credential
POST   /runner/v1/jobs/acquire                → long poll ≤ 50 s → job message, lease_epoch, job token
POST   /runner/v1/jobs/:id/heartbeat          → extend lease → { cancel_requested }
POST   /runner/v1/jobs/:id/steps/:n           → step transition (monotonic, fenced)
POST   /runner/v1/jobs/:id/logs               → chunk { step, first_line, lines[] }
POST   /runner/v1/jobs/:id/log-segments       → segment sealed { step, first_line, last_line, key }
POST   /runner/v1/jobs/:id/complete           → final conclusion (fenced, idempotent)
POST   /runner/v1/artifacts                   → create → signed multipart URLs; POST …/:id/finalize
GET    /runner/v1/cache?keys=&version=        → restore lookup → signed GET URL or 204
POST   /runner/v1/cache/reserve               → reserve key → signed PUT URL or 409
```

Example `complete` exchange:

```json
// POST /runner/v1/jobs/88121/complete
{ "lease_epoch": 3, "conclusion": "failure", "failed_step": 7 }
// 200 { "status": "completed", "conclusion": "failure" }   first call or identical replay
// 409 { "error": "stale_epoch", "current_epoch": 4 }       lease was revoked; runner aborts
```

## Key Design Decisions

### 1. Runners pull work; the control plane never pushes

Runners long-poll `acquire`, and the broker answers with a job only when the runner is ready for it. A push model has the scheduler choose a runner and send it the job. That needs an accurate, real-time view of every runner's health and reachability. With 417K VMs coming and going, the view is always stale, and a push to a runner that just died has to be detected and retried. Pull makes "this runner is alive and idle" true at the moment of assignment, and it works through NAT for self-hosted runners in customer networks, which accept no inbound connections. The cost: 50 s long polls hold about 42K idle connections at peak, and the scheduler can't do global placement optimization such as packing jobs onto hosts. We compensate with pools and warm-pool targets instead.

### 2. Leases with fencing epochs, and a retry policy that depends on what the job does

At-least-once comes from leases: a job whose runner stops heartbeating is revoked and dispatched again. Leases alone are unsafe. A partitioned runner (a "zombie") keeps executing and eventually reports success for a job that someone else now owns. The fencing epoch, checked in every conditional `UPDATE`, makes the stale report a no-op. The retry policy is deliberately not uniform. Auto-retrying a test job after runner loss is what a user wants. Auto-retrying a production deploy that may have half-completed is not. Jobs bound to protected environments therefore fail with `runner_lost` and wait for a human. What we give up: a job can execute twice (a zombie may finish its work before it learns it was fenced), so external side effects need their own idempotency. That is why deploys should also use concurrency groups.

### 3. PostgreSQL is the source of truth; the broker is a rebuildable cache

Job state lives in PostgreSQL rows that change with conditional updates. The Redis broker only indexes which queued jobs exist per pool and organization. Kafka was rejected as the job queue. Its partitions are FIFO logs with offset commits. A long-running job can't be acknowledged out of order, a cancelled job can't be removed, and one slow organization blocks a whole partition. RabbitMQ handles per-message acks but would become a second source of truth that can disagree with the database after a failover. With a rebuildable broker, a total Redis loss costs at most one 30 s reconciliation pass of latency.

### 4. Event-driven DAG readiness inside the completion transaction

Releasing dependents happens in the same transaction as the completion: decrement `pending_needs`, then queue or skip. Each dependent is released exactly once, even when a completion report is retried, because the second report matches zero rows in step 1. The alternative, a scheduler that periodically scans active runs for ready jobs, adds its polling interval to every DAG edge. A 4-level DAG with a 5 s scan pays up to 20 s of pure scheduling delay, and the scans read hundreds of thousands of active runs to find the few that changed. A general workflow engine (one durable workflow per run) would work, but it duplicates state we already keep in PostgreSQL and adds an operational system for what is a bounded graph of at most 500 nodes.

### 5. One ephemeral VM per job

Hosted jobs run in a fresh VM that is destroyed afterwards, never in a reused runner or a container on a shared kernel. Containers share the host kernel, and a CI job is by definition arbitrary code that often needs root, Docker-in-Docker, or kernel features. A container escape there would reach other tenants' jobs and secrets. Reused runners leak state between jobs: caches, credentials left in `~/.docker/config.json`, background processes. The cost is boot time (30 s from a snapshot) and the warm pool needed to hide it: about 42K idle or booting VMs at peak, about 10% overhead. Self-hosted runners are the customer's choice. We recommend their ephemeral mode.

### 6. Two log paths: live (loss-tolerant) and archival (authoritative)

Live viewing needs sub-2-second latency. Durability needs every line, in order, retained for 90 days. One pipeline can't optimize both cheaply. Making every live chunk durable would mean replicated writes of 417K small appends per second. Instead the live path is a Redis tail that can shed load, and the archive is uploaded by the runner from its local spool every 60 s, which bounds the live store to about 83 GB. The cost is two code paths and a `resync` protocol for viewers whose position was sealed while they were disconnected.

### 7. Cache writes are scoped to the ref that produced them

Pull requests restore from their own scope, then the base branch, then the default branch, but save only to their own scope. A shared, unscoped cache keyed only by `key` would let any branch, including one from a fork, write `node-modules-<hash>` that `main` then restores and executes, which is a supply-chain attack through the cache. The cost is duplicate entries across branches and lower hit rates for brand-new branches until they produce their own.

## Consistency and Idempotency

| Operation | Mechanism | Duplicate or retry behavior |
|-----------|-----------|-----------------------------|
| Webhook delivery | `trigger_events` PK on `delivery_id`; `UNIQUE (workflow_id, delivery_id)` on runs | Second delivery is a no-op |
| Resolver crash after commit | Kafka offset committed after the transaction | Replay hits the unique constraint |
| Job ready → broker | Outbox `dedupe_key`; sorted-set insert is idempotent | Re-publish leaves one queue entry |
| Acquire | Conditional `UPDATE ... WHERE status = 'queued'` | Two brokers racing: one wins, the other pops the next job |
| Step status | Monotonic rank `pending < in_progress < completed`, fenced by epoch | Replays and out-of-order arrivals are no-ops |
| Job completion | `WHERE lease_epoch = $e AND status <> 'completed'` | Replay → 200 with stored result; stale epoch → 409 |
| Dependent release | Same transaction as completion | Exactly once per completion |
| Log chunk | Accepted only if `first_line` = next expected line | Retried chunk ignored; a gap triggers a re-send from the spool |
| Re-run, cancel, dispatch | `Idempotency-Key` header, response cached 24 h in Redis | Double-click → same attempt |
| Cache save | `reserve` with `ON CONFLICT DO NOTHING` | Second writer skips its upload |
| Check-run publish | Coalesced per check run; Git host update is a PUT of full state | Replays converge |

Job status is monotonic **within a lease epoch**. The only backwards transition (`in_progress` → `queued` after runner loss) increments the epoch, so a client or worker ordering updates by `(lease_epoch, version)` never applies a stale state. Every row carries `version`, and SSE deltas include it so browsers drop out-of-order updates.

## Security / Auth

- **Users**: session auth locally, SSO in production. Repository read access lets a user view runs and logs; write access lets them cancel and re-run; admin access lets them manage secrets, environments, and runners. Logs of public repositories are public, so masking matters.
- **Runners**: a hosted VM boots with a one-time registration token injected by the Fleet Manager. It exchanges the token (plus its session public key) for a runner credential scoped to one pool, valid for one job. Self-hosted runners register with an org-scoped token.
- **Jobs**: a per-job token scoped by `permissions:`, expiring with the job. OIDC federation for cloud credentials.
- **Webhooks**: HMAC-SHA256 over the raw body with a constant-time compare; 5-minute timestamp window.
- **Untrusted pull requests**: no secrets, read-only token, approval for first-time contributors. `pull_request_target` workflows (which run with base-branch privileges) are flagged in the UI because checking out PR code inside them reintroduces the risk.
- **Secrets at rest**: AES-256-GCM per scope, data keys wrapped by a KMS master key, audit log on every read and write. Masking is defense in depth, not a boundary: a job that wants to exfiltrate a secret can transform it (reverse it, split it). The real boundary is not giving secrets to untrusted code.
- **Rate limiting**: per user on the API; per repository on `workflow_dispatch`; at most 500 queued runs per repository and a per-org concurrency cap, so an event storm or a tight loop of pushes can't monopolize a pool.
- **Isolation**: VM per job; hosted runners' egress has no route to metadata services or the control-plane network; runner credentials can't call any API except the runner protocol.

## Observability

| Metric (Prometheus) | Type | Why it matters |
|---------------------|------|----------------|
| `ci_event_to_run_seconds` | Histogram | Trigger SLO (p99 < 10 s) |
| `ci_jobs_queued{pool}` | Gauge | Demand signal for autoscaling and alerting |
| `ci_queue_wait_seconds{pool,org_tier}` | Histogram | The latency users feel most; fairness check across tiers |
| `ci_warm_pool_idle{pool}` / `ci_runner_boot_seconds{pool}` | Gauge / Histogram | Warm-pool sizing inputs |
| `ci_lease_expired_total{phase,action}` | Counter | Runner-loss rate. A spike means a fleet problem, not user failures |
| `ci_stale_epoch_rejections_total` | Counter | Zombie runners; partitions between runners and the broker |
| `ci_status_write_conflicts_total` | Counter | Duplicate or out-of-order reports (expected low, non-zero) |
| `ci_outbox_lag_seconds{topic}` | Gauge | Ready jobs waiting to reach the broker; checks lagging behind |
| `ci_log_ingest_lag_seconds` / `ci_log_resyncs_total` | Gauge / Counter | Live-log SLO and live-path drops |
| `ci_cache_restore_total{result}` | Counter | hit / partial (restore-key) / miss |

**Alerts**: queue wait p99 > 60 s for 10 minutes on any hosted pool; outbox lag > 30 s; lease expiries > 3× the weekly baseline; event-to-run p99 > 10 s; check-publish breaker open > 5 minutes.

**Conclusion reasons** separate infrastructure failures (`runner_lost`, `startup_failure`, `timeout` during setup) from user failures (`step_failed`). The platform's error budget is spent only on the former.

**Tracing and logs**: one trace from webhook `delivery_id` → run → job → runner session, with `run_id`, `job_id`, `run_attempt`, and `lease_epoch` on every structured log line. Health checks: `/health/live` (process up) and `/health/ready` (database, Redis, and Kafka reachable).

## Failure Handling

| Failure | Detection | Behavior |
|---------|-----------|----------|
| Runner VM dies mid-job | Missed heartbeats; lease expires (≤ 70 s) | Epoch bump, then requeue or fail by policy; old attempt's logs kept under the old epoch |
| Runner alive but partitioned (zombie) | Its heartbeat gets 409 after expiry | Runner kills the job; its completion is rejected by the fence |
| Acquire response lost in flight | No heartbeat from the assignee | Lease expiry → requeue (setup phase; always safe) |
| Broker Redis loses data | Reconcilers | Queues rebuilt from `queued` rows within 30 s; leases recreated with a grace TTL |
| Cell PostgreSQL failover (about 30 s) | Write errors | Runners keep executing, buffer status calls, and retry with backoff and jitter; idempotent replays |
| Orchestrator crashes mid-transition | — | Single transaction; outbox rows delivered after restart; no partial DAG updates |
| Poison workflow or event | Resolver exception | `startup_failure` run; event marked resolved; partition keeps moving |
| Git host Checks API down | Circuit breaker opens | Updates coalesce to the latest state per check and drain on recovery |
| Object storage degraded | Breaker on signed-URL issuance | Cache → miss (the job continues, slower); artifact upload → step fails as retryable; log segments stay in the runner spool and retry |
| Log Service overloaded | Ingest lag | Runner buffers up to 64 MB on disk, then drops live chunks; the archive stays complete |
| Fleet capacity exhausted | Queue-wait alert | Jobs wait in the queue (they never fail for lack of capacity); fair share keeps small orgs moving |
| Thundering herd after an outage | Backlog gauge | 834K backlog drained oldest-first per org, at the cloud's VM launch rate; warm pools refill before scale-up targets rise |

## Scalability Considerations

- **Control plane**: cells by `repo_id` hash. 16 cells at peak means about 2.1K status writes/s and about 87 job starts/s per cell, comfortable for one PostgreSQL primary with two replicas. Adding cells is the scaling path. A hot monorepo (thousands of jobs per push) is moved to a dedicated cell and capped by per-repo concurrency.
- **Dispatch**: brokers are regional and stateless apart from Redis. Heartbeats (27.8K/s at peak) shard by `job_id` across a Redis cluster.
- **Runner fleet**: the true bottleneck is cloud capacity and VM launch rate, not software. About 1,390 launches/s at peak need multiple regions and multiple instance families per pool. MicroVMs on large bare-metal hosts give faster boots and denser packing than cloud VMs.
- **Data plane**: object storage scales on its own. The constraint is bandwidth locality, so cache and artifact buckets live in each runner region.

**What breaks first**: (1) cache-restore bandwidth (1.1 Tbps at peak) if caches are not region-local; (2) VM launch rate and warm-pool cost during peaks and after outages; (3) log-chunk request rate at the Log Service (≤ 417K/s); (4) a single hot repository's cell. Status writes (33K/s across 16 cells) come a distant fifth.

**10× growth**: 4.2M concurrent jobs, 13.9K starts/s, about 11 Tbps of peak cache restores, 80 TB/day of compressed logs, and a warm pool of about 417K VMs. The control plane grows linearly by adding cells. The fleet and the cache network grow linearly in cost, which makes cost, not architecture, the binding constraint. At that point it pays to add runner-local caching (a host-level read-through cache shared by VMs on the same machine) and to shorten default artifact retention.

**Region outage**: with three runner regions at 139K concurrent jobs each at peak, losing one region drops about 139K jobs. Their leases expire within about 70 s, and they are re-dispatched or failed by policy. The surviving two regions must absorb 417K / 2 ≈ 208.5K each, so each region is provisioned for +50% headroom over normal peak. Caches are regional, so re-dispatched jobs run cold. Longer jobs increase concurrency (Little's law), which is part of why the headroom is 50% and not exactly the lost capacity. Control-plane cells replicate synchronously within a region and asynchronously across regions. Losing a cell's home region costs a failover with an RPO of a few seconds of status updates. Those updates are re-reported by runners, because runners retry until acknowledged.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Dispatch model | Runners long-poll (pull) | Scheduler pushes to runners | Liveness is true at assignment; works behind NAT |
| Execution guarantee | At-least-once with leases + fencing | Exactly-once via distributed transactions | Runner loss is routine; fencing makes duplicates harmless to state |
| Retry on runner loss | Policy by phase and environment | Always retry | Tests are idempotent; deploys are not |
| Job queue | Postgres truth + rebuildable Redis broker | Kafka / RabbitMQ as the queue | Cancel, out-of-order ack, fair share; one source of truth |
| DAG readiness | Counters updated in the completion transaction | Periodic scan of active runs | No polling delay per edge; exactly-once release |
| Isolation | Ephemeral VM per job | Containers on shared hosts / reused runners | Arbitrary code next to secrets needs a kernel boundary |
| Boot latency | Warm pools sized by Little's law | Cold boot per job | 30 s boot hidden for about 10% fleet overhead |
| Fairness | Per-org DRR + plan concurrency caps | Global FIFO | One org's 10K-job burst can't starve everyone |
| Log pipeline | Live Redis tail + runner-sealed archive | Single durable stream | Bounded hot memory; archive complete even if live drops |
| Live transport | SSE with Last-Event-ID | WebSocket | One-way stream; built-in resume; HTTP/2 multiplexing |
| Cache scope | Read up to default branch, write own ref | Repo-wide shared cache | Prevents cache poisoning from PRs |
| Secrets | Delivered per job at acquire; none for forks | Injected as env vars at queue time | Plaintext never at rest in queues; untrusted code gets nothing |
| Partitioning | Cells by repo_id | Global database | A run's DAG stays on one shard; no distributed transactions |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local build: Docker Compose for infrastructure, Node.js + Express + TypeScript services, and React 19 + Vite + TanStack Router + Zustand + Tailwind for the UI.

### Planned Local Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Local machine                                                                    │
│                                                                                  │
│  ┌──────────────┐   ┌────────────────┐   ┌────────────────────────────────────┐  │
│  │ Frontend     │──▶│ LB :3000       │──▶│ API instances :3001-3003           │  │
│  │ Vite :5173   │   │ round robin    │   │ REST · SSE · webhooks · runner API │  │
│  └──────────────┘   └────────────────┘   └─────────────────┬──────────────────┘  │
│                                                            │                     │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────────▼──────────────────┐  │
│  │ git-sim CLI  │   │ orchestrator   │   │ PostgreSQL :5432 · Valkey :6379    │  │
│  │ signed push  │   │ worker · sweep │   │ MinIO :9000 (logs, artifacts,      │  │
│  │ webhooks     │   │ · outbox relay │   │ caches, plans)                     │  │
│  └──────────────┘   └────────────────┘   └────────────────────────────────────┘  │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ runner agents ×3 (Node): long-poll the API; each job runs in a fresh       │  │
│  │ `docker run --rm` container; fleet-sim starts/stops agents by queue depth  │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| Planned process | Port | Role |
|-----------------|------|------|
| `lb` | 3000 | Round-robin proxy over the API instances |
| `api` ×3 | 3001–3003 | Public REST, SSE streams, webhook receiver, runner protocol |
| `orchestrator` | — | Resolver (consumes `trigger_events` via the outbox instead of Kafka), DAG transitions, lease sweeper, reconcilers, outbox relay |
| `runner-agent` ×3 | — | Long-poll acquire, execute steps in containers, stream logs, seal segments to MinIO |
| `fleet-sim` | — | Starts and stops runner agents from queue depth, with a configurable fake boot delay |
| `git-sim` | — | CLI that commits to a local bare repository and sends HMAC-signed push and PR webhooks |
| Frontend | 5173 | Runs list, run graph, log viewer, PR checks view, badge preview |

Infrastructure: PostgreSQL (5432), Valkey (6379), and MinIO (9000). Kafka (9092) and RabbitMQ (5672) are not needed locally. The planned build uses the PostgreSQL outbox plus Valkey, and documents Kafka's role in production.

### Production-Grade Patterns Planned

| Pattern | Why it matters at scale | Planned location |
|---------|-------------------------|------------------|
| Idempotency | Duplicate webhooks, retried runner calls, and double-clicked re-runs are routine | Unique constraints in the planned `backend/src/db/init.sql`; `Idempotency-Key` middleware planned for `backend/src/shared/idempotency.ts` |
| Leases + fencing | The core correctness mechanism; a demo kills and pauses runners to exercise it | Planned `backend/src/dispatch/lease.ts` |
| Circuit breakers (Opossum) | MinIO and the Git-host checks publisher must not stall the API when slow | Planned `backend/src/shared/circuit-breaker.ts` |
| Metrics (prom-client) | Queue wait, lease expiries, outbox lag, log-ingest lag at `GET /metrics` | Planned `backend/src/shared/metrics.ts` |
| Structured logging (Pino) | Every line tagged with `run_id`, `job_id`, `lease_epoch` | Planned `backend/src/shared/logger.ts` |
| Health checks | `/health/live` and `/health/ready` for the LB and Compose | Planned in each service's `index.ts` |
| Rate limiting | Per-user API limits and per-repo `workflow_dispatch` limits, stored in Valkey | Planned `backend/src/shared/rate-limit.ts` |

A brief sketch of the planned fenced completion handler (the SQL is the transaction in flow 2):

```typescript
// planned: backend/src/orchestrator/complete-job.ts
const res = await tx.query(COMPLETE_JOB_SQL, [jobId, epoch, conclusion]);
if (res.rowCount === 0) return replayOrReject(jobId, epoch, conclusion); // 200 replay or 409 stale
await releaseDependents(tx, res.rows[0]);  // decrement pending_needs, queue or skip, outbox rows
```

### Simplified or Simulated

| Production | Local plan | Impact |
|------------|------------|--------|
| Git host webhooks | `git-sim` against a local bare repository | No real GitHub integration; checks shown in the local PR view only |
| Kafka event log | `trigger_events` table polled with `SKIP LOCKED` | No partition-ordering lesson; per-repo ordering enforced by a per-repo advisory lock |
| VM per job | Fresh Docker container per job | Weaker isolation (shared kernel); still demonstrates the ephemeral lifecycle |
| Fleet autoscaling | `fleet-sim` with a fake boot delay | Warm-pool math observable; no real capacity limits |
| KMS | Master key from an environment variable; same envelope scheme | No HSM or key rotation service |
| Cells and regions | One PostgreSQL, one Valkey | Sharding is designed, not exercised |
| OIDC federation | Omitted; job token only | — |
| Marketplace actions | A few built-ins (`checkout`, `cache`, `upload-artifact`) implemented natively; `run:` steps | No action download or versioning |

### Omitted

Multi-region failover, cells, macOS and Windows runners, GPU pools, reusable workflows beyond one level, the marketplace, billing, and Kubernetes. Each is discussed above as production design only.
