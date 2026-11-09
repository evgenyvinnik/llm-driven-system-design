# CI/CD Platform - Architecture

## System Overview

Repository events trigger workflows made of dependent jobs. Runners execute those jobs, people watch live logs and download artifacts, and bursts of pushes have to be absorbed without one repository starving the others. It extends the [job scheduler](../job-scheduler/) with the parts a job queue doesn't have: a dependency graph, untrusted code, credentials and repeatability.

The trap in this problem is designing only the queue. A queue answers "who runs this next". The hard questions are different:

- **Execution boundaries.** A workflow is arbitrary code, some of it from strangers. What separates it from the runner, from other jobs and from the secrets?
- **Credentials.** Which job gets which secret, decided where, and what stops a pull request from a fork from reading a deployment token?
- **Repeatability.** A run must mean the same thing forever. A later push can't change what it executes, and neither can its own re-run.
- **Unknown outcomes.** A runner vanishes after the deploy step started. Did production change? The platform can't know, and it has to say so rather than guess.

**The sentence this design is built around:** at-least-once execution is fine for a compile and unacceptable for a deploy, so the platform records intent before every step, and the lease-expiry decision is made from that record. An interrupted non-idempotent step goes to a state called `needs_attention`, is never retried automatically, and waits for a person.

**Learning goals:** readiness inside the completion transaction (the fan-in race), a PostgreSQL `SKIP LOCKED` queue with exact per-tenant limits and round-robin fairness, leases with fencing tokens, write-ahead intent, the fork trust boundary enforced at the claim, envelope-free AES-GCM secrets with an audit trail, stream masking across chunk boundaries, resumable SSE mapped to a log offset, and attempt-numbered re-runs over an immutable definition.

## Requirements

### Functional Requirements

1. **Trigger intake.** Signed webhooks (HMAC-SHA256 over the raw body, `X-Hub-Signature-256`, a delivery id) for `push` and `pull_request`. A redelivered event returns the existing run.
2. **Immutable runs.** A `workflow_run` pins the commit SHA and the SHA of the workflow file at that commit. Parsing is strict: cycles, unknown `needs` and unknown fields reject the workflow, with the error recorded on the run.
3. **Dependency-graph scheduling.** A job is ready when every job in its `needs` succeeded. A failure skips downstream jobs, with the reason. Bursts don't starve other repositories: per-repository limits and fairness.
4. **Runners.** Separate processes that register with labels, claim matching jobs under a lease with heartbeats, and whose writes are fenced.
5. **Lease expiry.** Re-queue with a new attempt only if no non-idempotent step started. Otherwise `needs_attention`: no automatic retry, a person decides.
6. **Execution boundary.** A fresh workspace per attempt, a scrubbed environment, per-step timeouts, resource limits, process-group kill.
7. **Secrets.** Scoped to a repository or environment, encrypted at rest, never returned by the API, delivered only at claim to an eligible job, audited per release. Forks never receive them and can't enter a protected environment. Values are masked in logs, including across chunk boundaries.
8. **Environments.** Branch restrictions and required human approval, which holds a job in `waiting`.
9. **Resumable logs.** Numbered chunks, idempotent, tolerant of out-of-order arrival; SSE with `Last-Event-ID` mapped to a log offset, through any API instance; archived to object storage on completion behind the same endpoint.
10. **Artifacts.** Per attempt, passed through `needs`, downloadable with an access check, with retention.
11. **Retry semantics.** Re-run one job, the failed jobs, or everything: new attempt numbers within the same run, against the same pins, with history kept. A non-idempotent job needs explicit confirmation. Dependents are re-evaluated. Cancel reaches the running step.

### Non-Functional Requirements

| Property | Target (production) |
|----------|---------------------|
| Webhook intake | p99 < 200 ms to a durable delivery row; 99.99% available (a lost webhook is a build that never happened) |
| Readiness | A dependent is queued in the same transaction that finished its last prerequisite |
| Claim | p99 < 50 ms, 2,000 claims/s across the fleet |
| Lost runner detected | Within one lease (2 to 5 min); 6 s locally |
| Log latency | p99 < 2 s from a runner's write to a viewer's screen |
| Log resume | Exactly the missing lines: no gaps, no duplicates, from any API instance |
| Execution correctness | A non-idempotent step is never run twice without a person saying so |
| Secret exposure | Zero releases to a fork; every release audited |
| Run history | Kept indefinitely; logs and artifacts kept per retention |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Repositories | 1M | A hosted service with many small repositories and a few enormous ones |
| Pushes and PR events | 10M/day, ~120/s average, 1,000/s peak | Working-hours peak, plus bursts when a bot pushes to thousands of repositories |
| Jobs per run | 5 average | Fan-out through matrices is the long tail |
| Jobs per day | 50M, ~600/s average, 2,000/s peak claims | Claim rate is what the database feels |
| Concurrent jobs | ~300,000 | 50M × ~8 min average / 86,400 s |
| Heartbeats | ~10,000/s | 300k jobs at one per 30 s, batched per runner |
| Log volume | ~200 GB/day of chunks, ~100 TB/day archived at peak retention | 50M jobs × ~1 MB average; compress and move out of the database quickly |
| Artifacts | ~1 PB/month | Retention is the only thing that keeps this bounded |

The primary constraint is write throughput on the job graph and the log path. Log writes dwarf everything else, which is why they leave the transactional store first at scale.

### Local Development Scale

| Component | Local size |
|-----------|------------|
| Repositories | 3 (two organizations) |
| Runs | 14 seeded plus what you start |
| API instances | 2 |
| Runners | 2 to 3 processes × 2 slots |
| Burst test | 48 pushes in about a second; ~5 jobs/s through 6 slots |
| Stores | One PostgreSQL, one Valkey, one MinIO container |

## High-Level Architecture

```
  Git host
     │  signed webhook (HMAC, delivery id)
     ▼
┌──────────────┐  one transaction: delivery row + pins + run +    ┌──────────────┐
│ Intake (API) │  jobs + first readiness pass                     │              │
│   × N        │─────────────────────────────────────────────────▶│  PostgreSQL  │
└──────────────┘                                                  │              │
                                                                  │  runs, jobs  │
┌──────────────┐  re-run, cancel, approve, resolve                │  attempts    │
│ Browser      │─────────────────────────────────────────────────▶│  steps       │
│  ▲   SSE     │                                                  │  queue       │
└──┼───────────┘                                                  │  leases      │
   │                                                              │  secrets     │
┌──┴───────────┐  read lines by offset                            │  audit       │
│ Log streams  │◀─────────────────────────────────────────────────│  log lines   │
│ (API) × N    │◀── wake-up ──┐                                   │              │
└──────────────┘              │                                   └──────┬───────┘
                         ┌────┴─────┐                                ▲   │
                         │  Valkey  │                                │   │ sweeps
                         │ sessions │                                │   ▼
                         │ wake-ups │                         ┌──────┴───────┐
                         └────▲─────┘                         │  Scheduler   │
                              │                               │ lease expiry │
┌──────────────┐  runner API: claim, heartbeat, step intent,  │ log archive  │
│ Runner API   │  log chunks, artifacts, complete. Every      │ retention    │
│ (API) × N    │  write checked against a fencing token       └──────┬───────┘
└──────▲───────┘                                                     │
       │ HTTPS only: runners have no database access                 ▼
┌──────┴───────┐      ┌──────────────────┐                    ┌──────────────┐
│ Runner fleet │─────▶│ Ephemeral VM per │                    │ Object store │
│ labels,slots │      │ job: the actual  │───artifacts───────▶│ artifacts,   │
│ claim, lease │      │ security boundary│                    │ archived logs│
└──────────────┘      └──────────────────┘                    └──────────────┘
```

Three boundaries matter more than the boxes. Runners reach the control plane only over HTTP, so every write can be fenced and a compromised runner reaches only the job it holds. Secrets leave the control plane in exactly one place, the claim response. And readiness has no box at all: it is a function called inside the transaction that finished a job.

## Core Components

### Trigger intake

One URL per repository, `POST /api/v1/webhooks/:owner/:repo`, so the HMAC is verified against the raw bytes before anything parses the body. An unknown repository and a bad signature get the same `401 BAD_SIGNATURE`, so the endpoint can't enumerate repositories.

Then one transaction does everything:

1. `INSERT INTO trigger_events ... ON CONFLICT (repo_id, delivery_id) DO NOTHING`. A concurrent duplicate blocks on the unique index until the first commits, then finds the row.
2. A duplicate increments `redeliveries` and returns the existing `run_id` with 200.
3. Look up the commit in the fixture store (production: fetch from Git, see below), read `.ci/workflow.yml`, hash it.
4. Parse and validate. A rejected file still creates a run, status `invalid`, with the errors recorded and no jobs. The push happened, and the author should see why nothing ran.
5. Apply the `on:` filter. Insert the content-addressed workflow file, take a run number, insert the run and one row per job with the definition copied onto it.
6. Run the first readiness pass under the same transaction.

**Who decides what is a fork.** `normalizeEvent` is the trust decision. A pull request counts as a fork if `head.repo.fork` is true, or the head repository differs from the base, or the payload doesn't name one (a deleted fork: fail closed). A pull request's `branch` is `pull/N/merge`, never its head ref, so a fork naming its branch `main` can't satisfy a branch rule that says `main`.

**Production note.** Fetching from Git inside a webhook request is wrong at scale: Git can be slow, and intake must not be. Production splits this into two steps, persist the delivery and return 202, then let a materializer create the run from an outbox. The local version can do it inline because the fixture store is in the same database. The deduplication and the pins are identical in both.

### The workflow parser

`workflow/parser.ts`. Strict, because the alternative is dangerous: a typo like `idempotnet: false` that's silently ignored turns off the one protection on a deploy step. So every level of the schema rejects unknown fields, with the field named in the error. After that: matrix expansion (a `needs` on a matrix job means every leg), unknown `needs`, and cycle detection with the cycle printed (`a -> c -> b -> a`). Size and alias limits stop a YAML alias bomb before it reaches the heap.

### Dependency-graph scheduling and the fan-in race

```
          ┌──── test-unit ────┐
 build ───┤                   ├─── package
          └── test-integration┘
```

Two test jobs finish at the same instant. Under READ COMMITTED, each completion transaction marks its own job `success`, then looks at `package`'s needs. Neither sees the other's uncommitted write. Each concludes "the other one is still running", and `package` is never enqueued. If both happened to read after the other's commit, both would enqueue it. Missing and doubling are the same bug.

The fix is one lock order and one function:

```typescript
// scheduling/engine.ts, heavily trimmed
export async function completeAttempt(jobId, attempt, token, input) {
  return withTransaction(async (client) => {
    const run = await lockRun(client, runId)      // SELECT ... FOR NO KEY UPDATE
    const job = await lockJob(client, jobId)      // fence check happens under this lock
    // ...write the job's final status...
    await advanceRun(client, run, actor)          // readiness, in this transaction
  })
}
```

`advanceRun` loads every job of the run under the lock, asks the pure `computeReadiness` what changed, applies it with `WHERE status = 'blocked'` guards, and loops until nothing does, because a skip can make another job skippable. It then derives the run's status from its jobs. Serializing per run makes the second completion see the first one's success. Contention is one run's own jobs, a handful of transactions a second at most, so the lock is cheap. The test runs 25 rounds of simultaneous completions against real PostgreSQL and asserts `job_transitions` shows exactly one `queued`; the e2e does the same across two API instances.

**A failure** marks dependents `skipped` with a reason naming the prerequisite (`Needs "Tests", which failed`), transitively. Unrelated branches keep running. **A dependent of a `needs_attention` job stays `blocked`**: the prerequisite's outcome isn't known yet, so neither "ready" nor "skipped" would be honest.

### The claim

`scheduling/claim.ts`. PostgreSQL is the queue, in one transaction:

1. Lock one repository with `SKIP LOCKED`, least recently served first (`ORDER BY last_claimed_at NULLS FIRST`), among those with a queued job this runner's labels can take (`runs_on <@ labels`) and room under their limit. Concurrent claimers move on to another repository.
2. Holding that lock, re-count its running jobs in a fresh statement. Claims per repository are serialized by the lock, so the limit is exact, not approximate.
3. Take the oldest matching job, lock its run and job (the same lock order as everything else).
4. **Re-check the environment gate.** The claim is the last moment before code and credentials leave the control plane, so it's the enforcement point. A fork job that reached the queue somehow, even with a forged approval row, is failed here and receives nothing.
5. Decide and decrypt secrets, write audit rows, take a new fencing token, set the lease, create the step rows and the log stream.

Fairness is round robin between repositories: a burst on one can only ever cost another one turn. Measured locally with the burst repository's limit raised to take the whole fleet: 48 jobs on 6 slots, the burst's worst wait was 9.2 s and the second repository's was 1.4 s, with 35 burst jobs still unfinished when the second repository was done.

### Leases, fencing and the write-ahead intent

A claim sets `lease_expires_at` from the database clock and assigns a token from a sequence. Each runner sends one batched heartbeat per second renewing all its leases. Every later write checks the token and the runner id. The token is sequential, so holding one proves nothing on its own; the caller must also be its holder.

The most important write in the system is `startStep`:

```typescript
// scheduling/runner-ops.ts, trimmed
const job = await lockFenced(client, fence, 'step_start')   // SELECT ... FOR NO KEY UPDATE, token + runner checked
await client.query(`UPDATE step_executions SET status = 'running', started_at = ... `)
```

It must commit **before** the process is spawned. If the runner dies one instruction later, the row says this step may have run. And the row lock closes the race with expiry: `expireLease` takes the same job lock before reading the steps. If the start got there first, expiry sees it (and usually sees a renewed lease too). If expiry got there first, the start is rejected and the process never exists. There's no window where a step starts and the decision misses it. A race test runs 30 rounds of this.

### Lease expiry: the decision

The scheduler sweeps `WHERE status = 'running' AND lease_expires_at <= now()`, using the database clock, because after a laptop sleep the host clock and the Docker VM clock disagree by seconds. Each job goes through `expireLease`, which re-checks under the lock and asks the pure `decideLeaseExpiry`:

```
Any step started with idempotent = false?   ─ yes ─▶  needs_attention. Never retried automatically.
          │ no
Exhausted the retry budget (2 re-queues)?   ─ yes ─▶  failure. This job may be what's killing runners.
          │ no
          ▼
re-queue: attempt + 1, same pinned definition
```

The rule is deliberately pessimistic. A non-idempotent step that started counts whether or not it finished, because a retry re-executes the whole job, and whether or not the process ever actually ran, because the intent row can't tell. A false positive costs a person one click. A false negative deploys twice.

The same evidence applies in two other paths. A non-idempotent step killed by a cancel, or killed by its own timeout, also goes to `needs_attention`: in neither case did the step get to say how far it got. A step that exited non-zero told us it failed, and that's a plain failure.

**Resolving it.** A maintainer checks the deployment target and records what happened: *it succeeded* (the job becomes `success`, dependents continue), *it failed* (`failure`, dependents skip), or *safe to run again* (a new attempt, with explicit confirmation, which then needs its environment approval again). The decision and note stay on the attempt. A generic re-run can't get around this: it returns `ATTENTION_UNRESOLVED`.

**Late reports.** If the lost runner comes back and reports "deploy exited 0", the write is rejected as truth, because it no longer holds the lease, but it's kept on the attempt as `late_report` and shown to whoever is deciding. Fencing protects state, not knowledge.

### Secrets and environments

`secrets/eligibility.ts` is pure and is the policy:

| Situation | Environment gate | Secrets |
|-----------|------------------|---------|
| Same-repository push, no environment | allow | Repository secrets it names |
| Job in an environment, gate passed | allow | Environment secrets shadow repository secrets of the same name |
| Job outside an environment, names an environment secret | allow | Withheld: "Scoped to an environment this job is not in" |
| Protected environment, no approval yet | wait (`waiting`) | Nothing released, not claimable |
| Branch not allowed | deny: job fails, downstream skipped | Nothing |
| Fork pull request, unprotected environment | allow | Nothing, ever |
| Fork pull request, protected environment | deny | Nothing, ever |

A job receives only what its workflow names (`secrets: [DEPLOY_TOKEN]`), so a compromise of one job doesn't expose the repository's whole list. What it asked for and didn't get is recorded as `secrets_withheld` and shown.

Values are AES-256-GCM encrypted, with `(repository, environment, name)` as associated data, so a ciphertext copied to another scope fails to decrypt. They're decrypted only in the claim path and returned only in the claim response. The audit row commits in the same transaction as the lease, so a release can't be missing from the trail. An approval belongs to one attempt: a person's re-run needs a new one, and only an automatic re-queue after a lost runner carries it over, because that's the same intent.

**Masking is hygiene, not a boundary.** A step holding a secret can print it reversed, or one character a line. That's why untrusted code doesn't get one in the first place.

### Log pipeline

```
Runner                API (any instance)                         PostgreSQL
  │ masks output         │                                           │
  │ numbers chunks       │  lock log_streams row (per attempt)       │
  ├── seq=2 ────────────▶│  store chunk encrypted ──────────────────▶│ log_chunks
  │                      │  next_seq is 1: nothing to assemble yet   │
  ├── seq=1 ────────────▶│  feed 1, 2 through the masker, in order   │
  │                      │  write complete lines, numbered ─────────▶│ log_lines
  │                      │  clear chunk content, keep the row        │ (idempotency)
  │                      │  save the partial line, encrypted ───────▶│ log_streams
  │                      ▼
  │                   PUBLISH wake-up ──▶ Valkey ──▶ every API instance
  │                                                     │
  │                                         viewer loop: SELECT lines WHERE line_no > cursor
```

- **Idempotent by (job, attempt, seq).** A retried chunk hits `ON CONFLICT DO NOTHING`, and its row stays after assembly with the content cleared so a retry is still recognized.
- **Out of order.** A chunk past a gap waits, encrypted. Readers see nothing past the gap, because line numbers are assigned only by contiguous assembly. If the gap never fills, closing the stream writes the stranded chunks with a marker: `2 log chunk(s) never arrived`.
- **Masking across chunks.** `StreamMasker` buffers until a line is complete and masks a whole line at a time, including base64, URL-encoded and per-line variants. The partial line is persisted encrypted in `log_streams`, so the next chunk can land on a different API instance. A very long line with no newline is cut only outside the longest secret's hold-back window. Runners mask too, so a value doesn't leave the machine in the clear; the API masks again because it can't assume every runner did.
- **`line_no` is the offset.** SSE `id:` is the line number, and `Last-Event-ID` resumes from it. "What did I miss?" is one indexed query.
- **Valkey is a nudge.** The publish carries no data. A viewer on any instance wakes up and reads PostgreSQL. A lost message costs at most the 2 s poll, and a paused Valkey changes nothing except latency (tested).

**Archival.** The scheduler writes NDJSON to MinIO first, then in one transaction marks the stream archived and deletes the rows. A crash in between leaves both copies, and the next sweep rewrites the same key with the same bytes. `readLines` hides the difference: a reader that races archival finds no rows but a `last_line` past its cursor, re-reads the stream row, and goes to the object. With MinIO down, logs stay in PostgreSQL and archival catches up (tested).

### Execution boundary

**Production:** one ephemeral VM or microVM per job, destroyed afterwards, on a network that can't reach the control plane's internals, with fork jobs on a separate pool from anything that ever holds a secret.

**Locally, steps run as child processes. This is a substitution and it is not a security boundary.** A child process shares the runner's filesystem, network and user. What's enforced is what's practical:

| Control | How | Tested by |
|---------|-----|-----------|
| Fresh workspace per attempt, removed afterwards | `mkdtemp`, `rm -rf` in `finally`; a restarted runner sweeps a dead incarnation's | The path from a step's `$PWD` no longer exists |
| Scrubbed environment | Built from nothing; `spawn` gets only that object | A canary in the runner's own env isn't in `env` output |
| Per-step timeout | Timer, then the group kill | A step past 1 s ends `timed_out` and its pid is gone |
| Resource limits | `ulimit -c/-t/-f/-n` before `exec` (`-v` isn't available on macOS) | Writing past 64 MB fails the step |
| Process-group kill | `detached: true`, `kill(-pid)`, SIGTERM then an unconditional SIGKILL | Shell, child and grandchild all die on cancel, even with SIGTERM trapped |
| Leftover processes | The group is killed after a normal exit too | A backgrounded `sleep` doesn't survive its step |
| Path confinement | `..`, absolute paths and symlinks don't leave the workspace | Unit tests; an artifact symlink to `/etc/passwd` is refused |
| Only known code | Workflow content comes only from the fixture catalog; the panel selects by name | A scenario name that isn't in the catalog is a 404 |

### Retry semantics

`rerunSet` chooses the jobs; `resetJob` gives each a new attempt in place:

| Action | Resets | Example attempts after (build, test, report) |
|--------|--------|----------------------------------------------|
| Start | | 1, 1, 1 (test fails, report skipped) |
| Re-run failed | Failed, cancelled, skipped, and everything downstream of them | 1, 2, 2 |
| Re-run job `test` | `test` and everything downstream | 1, 3, 3 |
| Re-run all | Everything | 2, 4, 4 |

Attempts are per job, and each is a permanent row with its own steps, log, artifacts, runner and fencing token. The job row carries the pinned definition, and nothing in a re-run reads Git or the workflow file, which is why it's repeatable. A trigger also blocks any `UPDATE` of the pins and the job definition. Dependents read artifacts from the current attempt of what they need, so a re-run producer feeds its re-run consumer.

Re-runs are refused while jobs are active (`RUN_NOT_FINISHED`), and they need `confirmNonIdempotent` if any job in the set has a non-idempotent step (`CONFIRM_REQUIRED`, with the steps named). The confirmation is recorded on the attempt.

**Cancel** flips what hasn't started immediately, and flags what has. The runner learns from its next heartbeat (1 s locally) and kills the group. A `needs_attention` job is left alone: cancelling a run doesn't answer whether the deploy landed.

## Database Schema

The full schema is `backend/src/db/init.sql`: 23 tables. The ones that carry the design:

```sql
CREATE TABLE trigger_events (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id),
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL, ref TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
  is_fork BOOLEAN NOT NULL DEFAULT false, head_repo TEXT,
  payload JSONB NOT NULL, outcome TEXT NOT NULL, run_id TEXT,
  redeliveries INT NOT NULL DEFAULT 0,
  UNIQUE (repo_id, delivery_id)                       -- this constraint is the deduplication
);

CREATE TABLE workflow_files (sha TEXT PRIMARY KEY, content TEXT NOT NULL);  -- content-addressed

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, run_number INT NOT NULL,
  commit_sha TEXT NOT NULL, workflow_sha TEXT NOT NULL REFERENCES workflow_files(sha),
  is_fork BOOLEAN NOT NULL, branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','needs_attention','success','failure','cancelled','invalid')),
  run_attempt INT NOT NULL DEFAULT 1,
  error_code TEXT, error_message TEXT, error_details JSONB,
  UNIQUE (repo_id, run_number)
);  -- a BEFORE UPDATE trigger rejects any change to the pins

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, repo_id TEXT NOT NULL, job_key TEXT NOT NULL,
  -- the definition, copied from the pinned workflow; a trigger makes it immutable
  needs TEXT[] NOT NULL, runs_on TEXT[] NOT NULL, environment TEXT, requested_secrets TEXT[] NOT NULL,
  steps JSONB NOT NULL, uploads JSONB NOT NULL, has_non_idempotent BOOLEAN NOT NULL,
  -- the state machine
  status TEXT NOT NULL CHECK (status IN ('blocked','queued','waiting','running','success','failure','cancelled','skipped','needs_attention')),
  status_reason TEXT, attempt INT NOT NULL DEFAULT 1, auto_requeues INT NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  runner_id TEXT, fencing_token BIGINT, lease_expires_at TIMESTAMPTZ, queued_at TIMESTAMPTZ,
  UNIQUE (run_id, job_key)
);
CREATE INDEX jobs_queued_idx ON jobs (repo_id, queued_at) WHERE status = 'queued';
CREATE INDEX jobs_running_repo_idx ON jobs (repo_id) WHERE status = 'running';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';

CREATE TABLE job_attempts (
  job_id TEXT NOT NULL, attempt INT NOT NULL, trigger TEXT NOT NULL, triggered_by TEXT,
  confirmed_non_idempotent BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL, status_reason TEXT, runner_id TEXT, fencing_token BIGINT,
  secrets_released TEXT[] NOT NULL DEFAULT '{}', secrets_withheld JSONB NOT NULL DEFAULT '[]',
  closed_by TEXT, late_report JSONB,
  resolved_decision TEXT, resolved_note TEXT, resolved_by TEXT, resolved_at TIMESTAMPTZ,
  PRIMARY KEY (job_id, attempt)
);

CREATE TABLE step_executions (                        -- the write-ahead intent
  job_id TEXT, attempt INT, step_index INT, name TEXT NOT NULL, idempotent BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',             -- pending|running|success|failure|timed_out|killed|skipped|unknown
  exit_code INT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  PRIMARY KEY (job_id, attempt, step_index)
);

CREATE TABLE log_streams (                            -- assembly state, per attempt
  job_id TEXT, attempt INT, next_seq BIGINT NOT NULL DEFAULT 1, next_line BIGINT NOT NULL DEFAULT 1,
  partial_enc TEXT, mask_enc TEXT, closed_at TIMESTAMPTZ, archived_key TEXT, archived_at TIMESTAMPTZ,
  PRIMARY KEY (job_id, attempt)
);
CREATE TABLE log_chunks (job_id TEXT, attempt INT, seq BIGINT, step_index INT, content_enc TEXT, PRIMARY KEY (job_id, attempt, seq));
CREATE TABLE log_lines  (job_id TEXT, attempt INT, line_no BIGINT, step_index INT, text TEXT, PRIMARY KEY (job_id, attempt, line_no));

CREATE TABLE secrets (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, environment_id TEXT, name TEXT NOT NULL, ciphertext TEXT NOT NULL
);
CREATE UNIQUE INDEX secrets_scope_name_idx ON secrets (repo_id, COALESCE(environment_id, ''), name);

CREATE TABLE secret_releases (
  id BIGSERIAL PRIMARY KEY, secret_id TEXT, secret_name TEXT NOT NULL, scope TEXT NOT NULL,
  repo_id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL, attempt INT NOT NULL, runner_name TEXT NOT NULL
);
```

Also: `orgs`, `users`, `repositories`, `repo_run_counters`, `repo_members`, `fixture_commits`, `runners`, `environments`, `environment_approvals`, `artifacts`, `job_transitions` (append-only, for the timeline and for proving "enqueued exactly once"), `chaos_arms` (fixture panel only).

The run counter has its own table so an intake burst doesn't contend with the claim's lock on the repository row.

## API Design

```
# Intake (signed, no session)
POST   /api/v1/webhooks/:owner/:repo            202 new run; 200 duplicate or no run; 401 bad signature

# People (session cookie; 404 outside your repositories, 403 read-only)
POST   /api/v1/auth/login | logout              GET /api/v1/auth/me
GET    /api/v1/repos                            GET /api/v1/repos/:id
GET    /api/v1/repos/:id/runs?status=&limit=
GET    /api/v1/runs/:id                         run, jobs, artifacts, trigger
GET    /api/v1/runs/:id/workflow                the pinned file
POST   /api/v1/runs/:id/cancel
POST   /api/v1/runs/:id/rerun                   { mode: failed|all, confirmNonIdempotent }
GET    /api/v1/jobs/:id                         attempts, steps, timeline, artifacts
POST   /api/v1/jobs/:id/rerun                   { confirmNonIdempotent }
POST   /api/v1/jobs/:id/approval                { decision: approved|rejected, comment }
POST   /api/v1/jobs/:id/resolve                 { decision: succeeded|failed|retry, note, confirmRetry }
GET    /api/v1/jobs/:id/attempts/:n/logs/stream SSE; Last-Event-ID is the line offset
GET    /api/v1/artifacts/:id/download           410 past retention
GET    /api/v1/repos/:id/environments           PUT /api/v1/repos/:id/environments/:name
GET    /api/v1/repos/:id/secrets                metadata only
PUT    /api/v1/repos/:id/secrets                { name, value, environment }; DELETE /secrets/:secretId
GET    /api/v1/repos/:id/secret-releases        the audit trail
GET    /api/v1/runners                          another org's job shows only as busy
GET    /api/v1/ops/overview                     GET /api/v1/ops/burst-report?since=
GET    /api/v1/fixtures/catalog | deliveries    POST trigger | redeliver | bad-signature | burst | kill-runner

# Runners (bearer token; every job write carries { attempt, fencingToken })
POST   /api/v1/runner/register                  shared registration token; returns a per-runner token
POST   /api/v1/runner/claim                     200 job, secrets included; 204 nothing
POST   /api/v1/runner/heartbeat                 batched; per-job { ok, cancel }, and { die } for the demo
POST   /api/v1/runner/jobs/:id/steps/:i/start   the write-ahead intent
POST   /api/v1/runner/jobs/:id/steps/:i/finish
POST   /api/v1/runner/jobs/:id/logs             numbered chunks
GET    /api/v1/runner/jobs/:id/checkout         the tree at the pinned commit
PUT    /api/v1/runner/jobs/:id/artifacts/:name
GET    /api/v1/runner/jobs/:id/needs-artifacts  and /:artifactId; 403 if not in needs
POST   /api/v1/runner/jobs/:id/complete
```

A stale runner's write gets `409 LEASE_LOST`, which means stop. Log event: `id: 41`, `event: line`, `data: {"n":41,"step":1,"text":"ok 3 - unit","at":"..."}`.

## Key Design Decisions

### 1. Readiness in the completion transaction, not a message or a poller

**Chosen:** the transaction that finishes a job decides what becomes ready, under a per-run row lock.

A completion event on a queue means two systems must agree: the job's status commits, then a message tells a consumer to look. If the process dies in between, the dependent waits forever, so you add an outbox and a reconciler. If two messages arrive at once, the consumer has the fan-in race anyway, and now needs its own lock. A periodic poller avoids the lost message but adds latency proportional to its interval and scans every active run. Doing it in the transaction means there's no state where a prerequisite is finished and its dependent doesn't know. What it costs: a per-run lock serializes completions of one run. For a 1,000-leg matrix finishing together that's a queue of 1,000 short transactions on one row, and it's the first thing I'd watch (see Scalability).

**Alternatives for the race itself.** A `remaining_needs` counter decremented in place handles success without a run lock, since row locks serialize the decrements. But it needs recomputing on every re-run, doesn't handle the failure path, and goes wrong silently if it ever drifts. SERIALIZABLE isolation is correct and needs no explicit lock, but aborts under exactly this contention, so every completion needs a retry loop. Recomputing from `needs` under one lock has no counter to drift.

### 2. PostgreSQL as the queue, not RabbitMQ

**Chosen:** jobs claimed with `SKIP LOCKED`, because what a claim has to decide isn't FIFO. It needs label containment, a per-repository limit, round-robin fairness, the environment gate and secret eligibility, and all of it atomic with the lease and the audit row.

A broker hands out the next message. Label matching means a queue per label combination, or requeue churn when the wrong runner gets a job. A per-repository limit means counters outside the broker that can disagree with it. And "job queued" must be atomic with "prerequisite finished", or we're back to an outbox. With PostgreSQL those are SQL predicates in one transaction. What it costs: claims hit the primary, so it's bounded by what one primary can do, roughly thousands of claims per second with partial indexes, and polling costs a query per idle runner. I'd accept that until the numbers force sharding by organization, and I'd add long-polling first. RabbitMQ isn't in this project at all.

### 3. Fencing tokens, not only lease expiry

**Chosen:** every runner write carries a monotonic token, checked under the job's row lock.

A lease alone only says when a job may be taken away. It can't stop a runner that was frozen (a GC pause, a suspended VM, this laptop's Maintenance Sleep) from waking up and finishing its write after the job has moved on. The fence rejects it. A SIGSTOPped runner in the e2e wakes up, gets `ok: false` on its heartbeat and kills its step. What it costs: one more column and a check on every write, and runner code must treat `LEASE_LOST` as "stop now". A token doesn't help with effects outside the platform: a stale deploy step that's already running keeps running until the runner kills it, which is exactly why non-idempotent steps get `needs_attention`.

### 4. `needs_attention`, not "retry" or "fail"

**Chosen:** a distinct state that holds downstream jobs and asks a person.

Retrying a job whose deploy may have succeeded runs the deploy twice: two migrations, two charges, two notifications. Marking it failed is also a lie: dependents skip, someone re-runs on the assumption nothing happened, and the same double deploy occurs with a human's signature on it. Only the deployment target knows what happened, and the platform can't ask it in general. What it costs: a stuck run until someone looks, and marking steps correctly is on the workflow's author. An unmarked deploy is idempotent as far as the platform knows, and will be retried. Strict parsing makes sure a typo in the marker can't silently switch it off, but it can't make someone add it.

### 5. Offset-based log resume, with the database as the source and Valkey as a nudge

**Chosen:** contiguous line numbers assigned at assembly, read by offset; Valkey only says "look now".

Fan-out through pub/sub alone loses whatever was published while a viewer was reconnecting, so resume would be impossible. Valkey Streams would solve resume, but makes a second copy of the log with its own retention, plus a second code path once logs are archived. A single numbered store makes "live", "resume" and "archived" one read. What it costs: PostgreSQL carries every line while a job runs, which is the most write-heavy thing it does. At scale this is the first component to move (see Scalability), and the offset contract survives that move.

### 6. Copying the definition onto job rows

**Chosen:** parse once at intake, and copy steps and needs onto the jobs, with a trigger against changes. Re-parsing the pinned file on every re-run would also be repeatable only if the parser never changed; a parser upgrade could make an old run invalid or mean something else. What it costs: storage, and the definition in the UI is the parsed form, so the original file is kept content-addressed alongside it.

## Consistency and Idempotency

| Operation | Key | On retry |
|-----------|-----|----------|
| Webhook | `(repo_id, delivery_id)` | Same run; `redeliveries` increments; 200 |
| Claim | None: it creates a lease | A lost response leaves a lease nobody heartbeats; it expires, and the job re-queues (or `needs_attention`, if a step had started, which it can't have) |
| Step start | `(job, attempt, step)`, fenced | Replaying is harmless: `started_at` is kept |
| Log chunk | `(job, attempt, seq)` | `ON CONFLICT DO NOTHING`; acknowledged even after the lease is gone, because it changes nothing |
| Artifact | `(job, attempt, name)` | Same key, upserted |
| Complete | `(job, attempt, token)` | A retry finds its own finished attempt and replays the answer (`closed_by = runner`) |
| Approval | `(job, attempt)` | A second decision gets `NOT_WAITING` |

**Ordering actually required:** completions of one run serialized, and log lines of one attempt in sequence. Nothing else. Jobs in different branches of a run have no order, and neither do different runs of a repository (a later push can finish first).

## Security / Auth

- **People:** session cookie, session in Valkey, repository role per request (`maintainer`, `read`). No membership means 404, not 403, so existence doesn't leak. An admin reads everything and acts on nothing by default. An open log stream re-checks access every 30 s.
- **Runners:** a shared registration token, then a per-runner bearer token stored hashed and rotated on every registration. Runners have no database access.
- **Webhooks:** HMAC verified before parsing, in constant time, with a per-repository key stored encrypted.
- **Secrets:** the eligibility table above, AES-256-GCM with associated data, a default development key documented as such (`CICD_MASTER_KEY`). Production uses a KMS-held key and short-lived credentials issued per job (OIDC to the cloud provider) rather than long-lived values at all.
- **Shared fleet:** a job from a repository you can't read shows only as "busy" in the runner list.
- **Workflow content:** only from the fixture catalog, selected by name. Nothing typed in a browser reaches a runner's shell.

### Design Review Checklist

1. **Source of truth, and when is a write successful?** PostgreSQL for everything but bytes. A delivery succeeded when its transaction committed the run and its jobs; a step has started when its intent row committed; a job finished when `completeAttempt` committed, which is the same moment its dependents became ready. Bytes in MinIO are referenced only after the object exists.
2. **A client retries after losing the response?** Every write in the table above is keyed. A Git host that retries gets the same run. A runner that retries a completion gets the same answer.
3. **A worker or server fails between two important steps?** A runner between intent and spawn: the row says started, so a non-idempotent step goes to a person, the conservative direction. An API instance mid-transaction: nothing happened, the runner retries against another instance. The scheduler between object write and row delete during archival: both copies exist, and the next sweep repeats it.
4. **Which ordering is actually required?** Per-run completions and per-attempt log lines, as above.
5. **Access through caches, indexes, async jobs?** The log stream checks access at open and every 30 s. Artifact bytes go through an access check on every download, with no presigned URLs that outlive a membership. Secrets are decided at claim, not when queued, so a change to an environment's rules applies to whatever hasn't been claimed.
6. **What breaks first at scale, and what's the evidence?** Log writes on the primary. The arithmetic: 50M jobs a day at ~1 MB each is more rows than everything else combined, and each one is a transactional insert. The evidence so far is local and partial: the API's 20-connection pool is what saturated first, with a 48-push burst running beside about 50 pollers of the run page, and it answered 503 rather than falling over. I haven't load-tested past that. Next I'd expect the per-run lock on huge matrices, then the claim path on one primary.

## Observability

Prometheus metrics in `shared/metrics.ts`, on `/metrics` of every process: `cicd_webhooks_total{outcome}`, `cicd_claims_total{outcome}`, `cicd_queue_wait_seconds`, `cicd_job_attempts_total{outcome}`, `cicd_lease_expiries_total{decision}`, `cicd_stale_writes_rejected_total{operation}`, `cicd_secret_releases_total`, `cicd_secrets_withheld_total{reason}`, `cicd_log_chunks_total{outcome}`, `cicd_log_stream_connections`, `cicd_queue_depth{label}`.

The alert I'd page on is `lease_expiries_total{decision="needs_attention"}`: each one is a deployment nobody knows the state of. Next: oldest queued age per label (no runners for a label looks like a quiet queue), and a rising stale-write count (a sign of a lease shorter than the real heartbeat gap).

Structured logs with pino, every process named. Health: `/health`, `/ready`. The ops page shows queue depth per label, per-repository concurrency against limits, job starts over time and how the last few minutes were shared out.

## Failure Handling

### Successful execution trace: the diamond

`build` → (`test-unit`, `test-integration`) → `package`, pushed by alice.

1. The Git host POSTs the signed event. API instance A verifies the HMAC against raw bytes, then in one transaction inserts the delivery, hashes the workflow, creates run #1 with its pins and four `blocked` jobs, and runs readiness: `build` has no needs, so it goes through the (empty) gate and becomes `queued`. 202.
2. The host retries because it lost the response. The insert conflicts, `redeliveries` becomes 1, and the same run comes back with 200.
3. runner-1 polls `claim`. In one transaction: lock `acme/web-app` with `SKIP LOCKED`, count running jobs (0 < 3), pick `build`, lock the run and job, gate allows, no secrets requested, token 41, lease now + 6 s. It writes step rows and a log stream, and returns the job.
4. The runner creates a fresh workspace, GETs the tree at the pinned commit, and for each step: POST `start` (committed), spawn in a new process group, masks and ships output as numbered chunks, POST `finish`. It uploads `app-bundle`, then POSTs `complete`.
5. `completeAttempt`: run lock, job lock, token matches, `build` becomes `success`, its stream closes, and `advanceRun` sees both tests ready and queues them. All in one commit.
6. Two runners take the tests and download the artifact through `needs`. Both complete in the same millisecond on different API instances. One gets the run lock first and sees `package` still blocked by the other. The second waits, then sees both successes, and queues `package`, once.
7. A viewer on instance B has been receiving lines: chunks land on A, A publishes a nudge, B reads lines past its cursor. The viewer's Wi-Fi drops at line 90. On reconnect it sends `Last-Event-ID: 90` to whichever instance answers and receives line 91 onward.
8. `package` completes. No blocked jobs remain, and the run derives `success`. The scheduler archives each log to MinIO and deletes the rows, and the endpoint keeps serving them.

### Failed execution trace: the runner dies during the deploy

`build` → `deploy` (environment `production`, step `Deploy` has `idempotent: false`) → `smoke`.

1. `build` succeeds. `advanceRun` finds `deploy` ready, and the gate says `wait`: the job goes to `waiting`, with no secret released and nothing claimable.
2. alice approves. An approval row for attempt 1, then the gate allows, and it's `queued`.
3. runner-2 (labels include `deploy`) claims it. Gate re-checked, `DEPLOY_TOKEN` decrypted, audit row written, token 57 issued, all in one commit.
4. `Prepare` runs. Before `Deploy`, the runner POSTs `start`: under the job lock the step row becomes `running`. It commits, and the process spawns.
5. The machine dies. Heartbeats stop. The deploy process may or may not finish; nobody is left to say.
6. 6 s later the sweep finds `lease_expires_at <= now()`. `expireLease` locks the run and job, re-checks, reads the steps: `Deploy` started and is non-idempotent. Decision: `needs_attention`. The job's token is cleared, the step becomes `unknown`, the log closes with a platform note, and `smoke` stays `blocked`. The run shows `needs_attention`.
7. The replacement runner registers and polls. Nothing is claimable: the job isn't `queued`. It can wait there forever, and no timer changes that.
8. alice checks the load balancer and clicks *It succeeded*, with a note. The job becomes `success`, the decision and note stay on the attempt, and `advanceRun` queues `smoke`, which runs against the production that's really there.
9. Had a frozen runner come back at step 7 and reported success, the write would get `LEASE_LOST`, but the report would be on the attempt for alice to read.

### Follow-ups

- **The same push event arrives twice?** The second insert hits `UNIQUE (repo_id, delivery_id)`, increments `redeliveries` and returns the existing run with 200. If they arrive at once, the second waits on the index until the first commits. Two different delivery ids for the same SHA make two runs: a person may genuinely want that.
- **How do dependent jobs learn their prerequisites finished?** They don't learn; they're told in the same transaction. The completion commits the job's status and every readiness consequence together, under the run lock. Nothing polls, and no message can be lost.
- **Resuming logs after a disconnect?** `Last-Event-ID` is the line number. Any instance reads `line_no > cursor` from PostgreSQL, or from the MinIO archive after completion, and sends exactly the missing lines.
- **Can an untrusted pull request access deployment secrets?** No. The claim path checks `is_fork` from the signed payload, and a fork gets an empty secrets object and no audit row. A protected environment denies it when it becomes ready, and again at the claim, even with a forged approval. Production adds separate runner pools, because a shared persistent runner is the other way in.
- **A runner disappears after a deployment succeeded?** The intent row says the step started, so the lease sweep can't assume anything. `needs_attention`, downstream held, never retried automatically. A person checks and records what happened.

### Other failures

| Failure | Behaviour |
|---------|-----------|
| Runner killed, idempotent job | Lease expires; new attempt on a live runner; dependents continue |
| A job that keeps killing runners | Failed after 2 re-queues |
| Runner frozen, then wakes | Heartbeat `ok: false`; it kills its step; its writes are rejected |
| Runner partitioned from the API | After one lease period with no renewal it fences itself and kills the step |
| Host sleep (all processes frozen) | The sweeper notices its own late tick and skips one sweep, so runners can heartbeat first |
| Scheduler down | Leases aren't swept until it's back; running jobs are unaffected; a second instance is safe |
| API instance down | Runners rotate to another instance; viewers reconnect and resume |
| Database pool saturated | 503 with `Retry-After`; a Git host redelivers, and the delivery id dedupes |
| Valkey down | Sessions fail, so people sign in again later; open streams keep flowing through the 2 s poll; log uploads aren't slowed, as the publish isn't awaited and commands have a 3 s timeout |
| MinIO down | Artifact uploads fail that attempt; logs stay in PostgreSQL and archival catches up; every call has a 15 s timeout, so a half-dead endpoint can't hold a job open while its heartbeat keeps the lease alive |
| Chunk never arrives | The stream closes with a marker saying which sequence numbers are missing |
| Bad workflow file | Run `invalid`, with the errors on it, no jobs |

## Scalability Considerations

**What breaks first, in order:**

1. **Log writes on the primary.** Every line is a row. Move log chunks out of PostgreSQL to an append-only store per attempt (S3 multipart or a log service), with a small hot buffer for the live tail, keeping line offsets as the contract. Viewers don't notice.
2. **Per-run lock on huge matrices.** 1,000 legs finishing together queue on one row. Shard readiness: group matrix legs behind a synthetic node, so only the last leg touches the dependent, or a per-dependent lock with a recheck.
3. **Claim on one primary.** Sharding by organization keeps every per-repository guarantee, since a run never spans shards. Long-polling with `LISTEN/NOTIFY` removes idle polling first. Cross-organization fairness then becomes a two-level round robin.
4. **Webhook spikes.** Split intake into persist-and-ack plus an async materializer, so Git fetches can't back up the request path.
5. **Per-repository burst.** Add `concurrency: cancel-in-progress` groups, so a tenth push to a branch supersedes the previous nine rather than queueing them. Per-organization quotas on top of per-repository limits.

**Runner fleet:** autoscale per label on queue depth and oldest-queued age. Ephemeral VMs mean a job's lease and the VM's life are the same thing. Fork jobs get their own pool.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Readiness | In the completion transaction, under a run lock | Completion events, a poller, a counter | No state where a dependent doesn't know; nothing to reconcile |
| Fan-in race | Per-run row lock, recompute from `needs` | `remaining_needs` counter; SERIALIZABLE | No counter to drift; no retry loop |
| Queue | PostgreSQL `SKIP LOCKED` | RabbitMQ, Kafka | Labels, limits, fairness and gates are one atomic SQL decision |
| Fairness | Round robin on `last_claimed_at` | Weighted fair queueing | Simple, starvation-free, one column |
| Lost runner | Lease, heartbeat, fencing token | Broker redelivery | Fence stops stale writes; the decision uses step evidence |
| Unknown outcome | `needs_attention`, never auto-retried | Retry, or mark failed | Only the target knows; both alternatives risk a double deploy |
| Step start | Write-ahead intent under the job lock | Report after spawning | A step can't exist without evidence of it |
| Runner access | HTTP only, fenced API | Direct database access | The boundary is what makes fencing and least privilege enforceable |
| Fork policy | Enforced at claim, by a pure function | Filter in the workflow or UI | The last moment before credentials leave |
| Secret delivery | Named by the job, at claim, audited | Environment-wide injection | Least privilege; one release point |
| Masking | Line-buffered, at runner and API | Per-chunk regex | Splits across chunks are the normal case |
| Log resume | Contiguous line offset in one store | Pub/sub fan-out, Valkey Streams | Live, resume and archive are one read |
| Fan-out | Valkey nudge only | Data over pub/sub | A lost message costs latency, never a line |
| Archive order | Object, then row update and delete | Delete first | A crash leaves two copies, not zero |
| Re-run | New attempts in the same run | New run | History stays together; the pins can't drift |
| Definition | Copied to job rows, immutable | Re-parse the file | Parser changes can't alter old runs |
| Strict parser | Unknown fields reject | Ignore them | A typo mustn't disable `idempotent: false` |
| Logs and SSE | `fetch` with `ReadableStream` | `EventSource` | The cookie, the header and the reconnect stay in our hands |

## Implementation Notes

The production design above maps onto Docker + Node.js + Express + React as follows.

### Production-grade patterns actually implemented

**Fan-in-safe readiness** (`backend/src/scheduling/engine.ts`, `graph.ts`). Exists because a dependent that's missed or doubled is the worst scheduler bug there is, and it only shows up under concurrency. Pure decisions in `graph.ts`, a transaction around them in `engine.ts`, proven by `engine.race.test.ts` against real PostgreSQL.

**Claim with limits, fairness and a gate** (`backend/src/scheduling/claim.ts`). At scale this query is the product: it decides who waits.

**Leases, fencing and write-ahead intent** (`backend/src/scheduling/runner-ops.ts`, `decisions.ts`). `decisions.ts` is pure and has every case in `decisions.test.ts`. The race between `startStep` and `expireLease` is the most delicate thing here, and it's tested.

**Secrets** (`backend/src/secrets/`, `shared/crypto.ts`). `eligibility.ts` is the policy, `masking.ts` the stream masker, and `store.ts` the only writer. Secret names are checked at parse time; values are decrypted only in `claim.ts`.

**Logs** (`backend/src/logs/`). `ingest.ts` assembles, `read.ts` hides where a log lives, `bus.ts` is the Valkey nudge, `archive.ts` moves it out.

**Runner** (`backend/src/runner/`). `process.ts` runs a step in its own group, `env.ts` builds the environment from nothing, `workspace.ts` confines paths, `log-shipper.ts` masks and numbers, `executor.ts` holds the order of operations, and `index.ts` the heartbeat and claim loops, including self-fencing.

**Observability and failure handling.** prom-client metrics (`shared/metrics.ts`), pino (`shared/logger.ts`), `/health` and `/ready`, timeouts on every MinIO call (`shared/storage.ts`) and Valkey command (`shared/cache.ts`), a 503 on pool saturation (`shared/errors.ts`).

### What was simplified or substituted

| Production | Local | Why it's acceptable here |
|------------|-------|--------------------------|
| Ephemeral VM or container per job | **Child processes** | **This is a substitution and not a security boundary.** A child process shares the runner's filesystem, network and user. Only fixture workflows run. |
| Real Git host | `fixture_commits` and a signing generator | Intake is the same code path: real HMAC over real HTTP |
| Persist-and-ack, async materializer | One intake transaction | The fixture store is in the same database |
| KMS, per-job OIDC credentials | AES-256-GCM with a local master key (a documented dev default) | The eligibility, audit and masking logic is unchanged |
| S3 | MinIO | Same API |
| Log store outside the database | PostgreSQL until archived | The offset contract is what matters |
| Autoscaled runner fleet | A supervisor restarting 2 runners | Lets the kill demo repeat |
| Long-poll claim | 400 ms poll with jitter | Fine at this scale |
| Lease 2 to 5 min | Lease 6 s, heartbeat 1 s | So a demo doesn't take minutes |

### What was omitted

Multi-region, a CDN, sharding, Kubernetes, marketplace actions, composite workflows, caches between jobs, `concurrency` groups, first-time-contributor approval, self-hosted runner enrollment beyond a shared token, OIDC, and a separate runner pool for forks (documented above as what production needs).
