# CI/CD Platform — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → Intake → Scheduling → Runners → Secrets → Logs → Deep dives → Traces → Scale*

> "A CI/CD platform looks like a job queue with a nice UI. If I design it that way, I'll build the easy third and miss what makes it dangerous. A queue answers 'who runs this next'. The questions that hurt are different. What separates a workflow, which is arbitrary code and sometimes a stranger's, from the deployment credentials? Can a run mean the same thing forever? And when a runner vanishes after the deploy step started, what do we do? The platform can't know whether production changed. So one sentence carries this answer: at-least-once execution is fine for a compile and unacceptable for a deploy, so I record intent before every step, and the decision after a lost runner is made from that record."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and scope | ~5 min | The queue is the easy part; boundaries, credentials and repeatability are the job |
| Architecture and data model | ~6 min | PostgreSQL as source of truth and queue; runners only speak HTTP |
| Intake and immutable runs | ~4 min | Delivery id deduplicates; a run pins commit and workflow |
| Dependency scheduling | ~5 min | Readiness lives in the completion transaction |
| Runners, leases, execution | ~6 min | Fencing tokens and write-ahead intent |
| Secrets and logs | ~5 min | Fork policy at the claim; resume by offset |
| Deep dives | ~9 min | Fan-in race; `needs_attention`; SKIP LOCKED versus a broker |
| Traces, checklist, scale | ~5 min | One success, one failure; what breaks first |

---

## 🎯 Requirements and Scope (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Whose code runs? | Sets the whole security model | Maintainers', and strangers' through pull requests from forks |
| Do workflows deploy? | Whether retries are safe | Yes, with real credentials to production |
| How are jobs related? | Queue versus graph | A DAG per workflow, with fan-out and fan-in |
| Do runners share machines between jobs? | Isolation | No: one ephemeral VM per job in production |
| What's bursty? | Fairness | A bot pushing to thousands of repositories, or one monorepo pushing constantly |
| Hosted or internal? | Tenancy | Multi-tenant: organizations must not see each other |

### Functional requirements

1. Signed webhooks for push and pull request events, deduplicated by delivery id.
2. A run pins the commit SHA and the SHA of the workflow file at that commit; a later change never alters it.
3. Strict workflow validation: cycles, unknown `needs` and unknown fields reject with an error on the run.
4. A job is ready when every job it needs has succeeded; a failure skips downstream, with the reason.
5. Runners register with labels and claim matching jobs under a lease with heartbeats and a fencing token.
6. After a lost runner: a new attempt if safe, otherwise `needs_attention` and a person decides.
7. Secrets scoped to a repository or environment, encrypted, never returned, delivered at claim, audited, never to a fork.
8. Environments with branch restrictions and required approval.
9. Logs as numbered chunks; SSE resumable by offset through any API instance; archived on completion.
10. Artifacts passed through `needs`, with access checks and retention.
11. Re-run one job, the failed jobs, or all: new attempts in the same run, same pins.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Intake | p99 < 200 ms, 99.99% available | A durable delivery row first; a lost webhook is a build that never happened |
| Readiness | Same transaction as the completion | No message in between that could be lost |
| Claim | p99 < 50 ms at ~2,000/s | Single-row claims on partial indexes |
| Lost runner | Detected within one lease (2-5 min) | Heartbeats, database-clock expiry |
| Log resume | No gaps, no duplicates, any instance | Line numbers assigned once, in one store |
| Deploy safety | A non-idempotent step never runs twice without a person | Evidence recorded before execution |
| Secret exposure | Zero releases to a fork; all audited | One release point |

### Capacity

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Events | 10M/day, ~120/s, peak ~1,000/s | Working hours plus bot bursts |
| Jobs | 50M/day; peak ~2,000 claims/s | ~5 jobs per run |
| Concurrent jobs | ~300,000 | 50M × ~8 min ÷ 86,400 s |
| Heartbeats | ~10,000/s | 300k jobs every 30 s, batched per runner |
| Logs | ~50 TB/day raw | 50M × ~1 MB; has to leave the transactional store fast |
| Artifacts | ~1 PB/month | Retention is what bounds it |

> "Logs are the biggest number and claims are the most contended one. I'll design the claim and the graph around correctness first, and make sure log storage can move without changing what a reader sees."

---

## 🏗️ High-Level Architecture (~3 min)

```
  Git host
     │ signed webhook
     ▼
┌──────────────┐  one transaction: delivery + pins + run +    ┌──────────────┐
│ Intake (API) │  jobs + first readiness pass                 │              │
│     × N      │─────────────────────────────────────────────▶│              │
└──────────────┘                                              │  PostgreSQL  │
┌──────────────┐  re-run, cancel, approve, resolve            │              │
│ People's API │─────────────────────────────────────────────▶│  runs, jobs  │
└──────────────┘                                              │  attempts    │
┌──────────────┐  read lines by offset                        │  step intent │
│ Log streams  │◀─────────────────────────────────────────────│  queue       │
│ SSE  × N     │◀── wake-up ── Valkey ◀── publish             │  leases      │
└──────────────┘                                              │  secrets     │
┌──────────────┐  claim, heartbeat, intent, chunks, complete  │  audit       │
│ Runner API   │─────────────────────────────────────────────▶│  log lines   │
│ fenced  × N  │                                              └──────┬───────┘
└──────▲───────┘                                                     │ sweeps
       │ HTTP only: no database access                        ┌──────▼───────┐
┌──────┴───────┐      ┌───────────────────┐                   │  Scheduler   │
│ Runner fleet │─────▶│ Ephemeral VM per  │                   │ lease expiry │
│ labels,slots │      │ job: the boundary │──▶ Object store   │ log archive  │
└──────────────┘      └───────────────────┘   artifacts, logs │ retention    │
                                                              └──────────────┘
```

Three things to notice, because they matter more than the boxes:

1. **Runners only speak HTTP.** So every write can be checked, and a compromised runner reaches only the job it holds. A runner with database access would make fencing a matter of good manners.
2. **Secrets leave the control plane in one place:** the claim response.
3. **Readiness has no box.** It's a function called inside the transaction that finished a job. There is no "job completed" topic.

---

## 💾 Data Model (~3 min)

| Table | Key columns | Why it exists |
|-------|-------------|---------------|
| trigger_events | (repo, delivery_id) unique, commit, is_fork, payload, redeliveries, run_id | The unique constraint is the deduplication |
| workflow_files | sha (primary key), content | Content-addressed, so it can't change meaning |
| workflow_runs | commit_sha, workflow_sha, is_fork, branch, status, run_attempt, error | A trigger rejects any change to the pins |
| jobs | job_key, needs[], runs_on[], environment, requested_secrets[], steps, has_non_idempotent, status, attempt, fencing_token, lease_expires_at | Definition copied from the pin and immutable; plus the state machine and the queue |
| job_attempts | (job, attempt), trigger, triggered_by, runner, token, secrets_released, secrets_withheld, late_report, resolution | History; a re-run adds a row and replaces nothing |
| step_executions | (job, attempt, index), idempotent, status, started_at | The write-ahead intent |
| job_transitions | job, attempt, from, to, reason, actor | Append-only: the timeline, and proof of "enqueued once" |
| runners | name, labels, slots, token_hash, last_seen_at | Token hashed, rotated on each registration |
| environments | required_approval, allowed_branches | Protection rules |
| environment_approvals | (job, attempt), decision, decided_by | Per attempt: a person's re-run needs a new one |
| secrets | (repo, environment, name) unique, ciphertext | AES-256-GCM with the scope as associated data |
| secret_releases | secret, run, job, attempt, runner, at | Written with the lease, in one transaction |
| log_streams | (job, attempt), next_seq, next_line, partial_enc, mask_enc, archived_key | Assembly state, so any API instance can take the next chunk |
| log_chunks | (job, attempt, seq), content_enc | Idempotency and the out-of-order buffer; content cleared on assembly |
| log_lines | (job, attempt, line_no), text | Masked and contiguous; line_no is the offset |
| artifacts | (job, attempt, name), object_key, sha256, retention_days, expires_at | One row per attempt |

**Job states:** blocked → queued (or waiting → queued) → running → success, failure, cancelled, needs_attention. Also skipped, from blocked.

**Partial indexes carry the queue:** (repo, queued_at) where queued; (repo) where running; (lease_expires_at) where running. Finished jobs, the vast majority, cost the claim path nothing.

> "A run's status is derived from its jobs every time, never set by hand. It can't disagree with them. And `needs_attention` outranks `running`: a long sibling must not hide that a deploy's outcome is unknown."

---

## 🔌 API Design (~2 min)

```
Intake
POST /api/v1/webhooks/:owner/:repo           202 new run · 200 duplicate · 401 bad signature

People (session; 404 outside your repositories, 403 if read-only)
GET  /api/v1/repos/:id/runs                  GET /api/v1/runs/:id
POST /api/v1/runs/:id/rerun                  mode: failed | all, confirmNonIdempotent
POST /api/v1/runs/:id/cancel
POST /api/v1/jobs/:id/rerun                  confirmNonIdempotent
POST /api/v1/jobs/:id/approval               approved | rejected
POST /api/v1/jobs/:id/resolve                succeeded | failed | retry
GET  /api/v1/jobs/:id/attempts/:n/logs/stream   SSE; Last-Event-ID is the offset
GET  /api/v1/artifacts/:id/download          access-checked; 410 past retention
PUT  /api/v1/repos/:id/secrets               write-only: nothing returns a value

Runners (bearer token; every job write carries attempt + fencing token)
POST /api/v1/runner/register                 POST /api/v1/runner/claim
POST /api/v1/runner/heartbeat                batched; per job: ok, cancel
POST /api/v1/runner/jobs/:id/steps/:i/start  the write-ahead intent
POST /api/v1/runner/jobs/:id/steps/:i/finish
POST /api/v1/runner/jobs/:id/logs            numbered chunks
GET  /api/v1/runner/jobs/:id/checkout        the tree at the pinned commit
PUT  /api/v1/runner/jobs/:id/artifacts/:name
POST /api/v1/runner/jobs/:id/complete
```

A stale write gets 409 `LEASE_LOST`, which means stop. A re-run of a non-idempotent job without confirmation gets 409 `CONFIRM_REQUIRED`, naming the steps.

---

## 📥 Intake and Immutable Runs (~4 min)

### One URL per repository, and the signature first

The webhook URL names the repository, so I can verify the HMAC over the raw bytes before anything parses the body. Nothing unauthenticated reaches a JSON or YAML parser. An unknown repository and a bad signature get the same 401, so the endpoint can't be used to enumerate names.

### One transaction

1. Insert the delivery with on-conflict-do-nothing on (repo, delivery id).
2. If it existed: increment the redelivery count, return the existing run with 200. If two copies arrive at once, the second waits on the unique index until the first commits, then finds the row.
3. Read the commit, find the workflow file, hash it.
4. Parse and validate. A rejected file still creates a run, status `invalid`, with the errors recorded and no jobs. The push happened; the author should see why nothing ran.
5. Create the run and one row per job, with the definition copied on. Run the first readiness pass.

> "In production I'd split this: persist and acknowledge, then materialize from an outbox, because fetching from Git inside a webhook request ties intake latency to Git's. The deduplication and the pins don't change."

### Who decides what is a fork

This is a trust decision on data from a signed source, and it fails closed. A pull request is a fork if the payload says so, or if the head repository differs from the base, or if there's no head repository at all, which is what a deleted fork looks like.

A pull request's branch for policy purposes is `pull/N/merge`, never the head ref. Otherwise a fork names its branch `main` and passes a rule that says `main`.

### Why strict parsing is a safety feature

Every level of the schema rejects unknown fields. If `idempotnet: false` were silently ignored, a typo would turn off the one protection on a deploy step, and nobody would find out until the double deploy. Cycles are reported with their path. Matrix legs expand first, so needing a matrix job means needing every leg. There's a size limit and an alias limit, because YAML has bombs.

### Repeatability

A run pins two SHAs, and the definition is copied onto the job rows. A re-run reads the job rows, not Git, and not the file. A database trigger rejects any update to the pins or the definition. I test this directly: push v1, push v2, re-run v1, and it still prints v1 and checks out v1's files.

---

## 🕸️ Dependency Scheduling (~5 min)

> "How do dependent jobs learn their prerequisites finished? They don't learn. They're told, in the same transaction."

The completion does this, as one commit:

1. Lock the run row.
2. Lock the job row and check the fencing token.
3. Write the job's final status, close its log stream.
4. Load all the run's jobs and ask a pure function what changed.
5. For each blocked job: every prerequisite succeeded → it enters its environment gate; any prerequisite failed, cancelled or skipped → skipped, with a reason naming which. Repeat until nothing changes, because a skip can make another job skippable.
6. Derive the run's status from the jobs.

**A prerequisite in `needs_attention` leaves its dependents blocked.** The outcome isn't known, so neither "ready" nor "skipped" would be honest.

**The gate** has three answers: allow (queued), wait (a person has to approve), deny (the job fails, and downstream is skipped). It runs here and again at the claim.

**Lock order, everywhere:** run → job → log stream. The claim adds repository before run, and nothing takes a repository lock after a run lock. So nothing deadlocks, and heartbeats need only one row.

### Bursts and fairness

Per-repository limit plus round robin between repositories, both enforced in the claim; see the third deep dive. Measured on the local build, with the burst repository's limit raised so it could take the whole fleet: 48 jobs on 6 slots, the burst's worst queue wait was 9.2 s and a second repository's was 1.4 s, and that repository finished with 35 burst jobs still unfinished. The per-repository limit held exactly: peak 3 of 3.

---

## 🏃 Runners, Leases and Execution (~6 min)

### The claim, in one transaction

1. Lock one repository with `SKIP LOCKED`, least recently served first, among those with a queued job these labels can take and room under their limit.
2. Holding that lock, re-count running jobs in a fresh statement. Claims per repository are serialized, so the limit is exact.
3. Take the oldest matching job, lock its run and the job.
4. Re-check the environment gate. This is the last moment before code and credentials leave.
5. Decide and decrypt secrets, write audit rows, take a new token from a sequence, set the lease from the database clock, create step rows and a log stream.

### Fencing

The token is checked under the job's row lock on every write, together with the runner id, since a sequential token is guessable. A lease alone only says when a job may be taken away. It can't stop a frozen runner, one that hit a long GC pause or a suspended VM, from waking and finishing its write after the job moved on. The fence rejects that write.

### The write-ahead intent

The step-start write commits **before** the process is spawned. If that write fails, the step doesn't run. So a step that may have had effects always has a row saying it started.

The row lock closes the race with expiry. Expiry takes the same job lock before reading the steps. If the start wins, expiry sees it. If expiry wins, the start is rejected and the process never exists.

### Execution boundary

> "This is where I'd slow down, because it's the part people skip."

**Production:** one ephemeral VM or microVM per job, destroyed afterwards. A network that can't reach control-plane internals. Fork jobs on a separate pool from anything that ever holds a secret, because a shared, persistent runner is the classic way one job poisons the next.

**Inside that boundary, and what I built locally:**

| Control | How |
|---------|-----|
| Fresh workspace per attempt | Created at claim, removed afterwards |
| Scrubbed environment | Built from nothing, never inherited |
| Per-step timeout | Then a kill of the whole group |
| Resource limits | File size, CPU, open files |
| Process-group kill | SIGTERM, then an unconditional SIGKILL, so a trap can't save a child |
| Leftovers | The group is killed after a normal exit too |
| Path confinement | `..`, absolute paths and symlinks don't leave the workspace |

**Locally those steps are child processes. That's a substitution and it isn't a security boundary**: a child shares the runner's filesystem, network and user. It's acceptable only because workflows come from a fixed catalog in the code, and I say so plainly in the README.

### Self-fencing

A runner that can't renew for a whole lease period kills its own step. The server has probably given the job away by then, and two runners must not keep working on it. A partition then behaves like a crash.

---

## 🔐 Secrets and Environments (~3 min)

> "Can an untrusted pull request access deployment secrets? No, and the UI has nothing to do with why."

| Situation | Gate | Secrets |
|-----------|------|---------|
| Same-repository push | allow | Repository secrets it names |
| In an environment, gate passed | allow | Environment secrets too, shadowing repository ones |
| Names an environment secret from outside it | allow | Withheld, with the reason recorded |
| Protected environment, not yet approved | wait | Nothing, and not claimable |
| Branch not allowed | deny: fails, downstream skipped | Nothing |
| Fork, unprotected environment | allow | Nothing, ever |
| Fork, protected environment | deny | Nothing, ever |

**The enforcement point is the claim.** It's a pure function, it reads `is_fork` from the run, and that came from the signed payload. I test it with a forged row: a fork job set to `queued` by hand, with an approval row inserted. The claim fails the job and releases nothing.

**Least privilege.** A job gets only what its workflow names, and what it asked for and didn't get is shown on the job.

**At rest.** AES-256-GCM, with (repository, environment, name) as associated data, so a ciphertext moved to another scope won't decrypt. Decrypted only in the claim path. Production uses a KMS-held key, and better still short-lived credentials per job through OIDC, so there's no long-lived value to steal.

**Audit.** A release row commits with the lease, so a release can't be missing from the trail.

**Approval is per attempt.** A person's re-run needs a new one. An automatic re-queue after a lost runner carries it over, because that's the same intent.

**Masking is hygiene, not a boundary.** It stops accidents. A step holding a secret can print it reversed. That's why untrusted code doesn't get one in the first place.

---

## 📜 Logs and Artifacts (~3 min)

### Ingest

Runners upload numbered chunks. The API locks the attempt's stream row, stores the chunk, and feeds every chunk that's now contiguous through the masker into numbered lines.

- **Idempotent** by (job, attempt, seq). A retry changes nothing. The row stays after assembly, with its content cleared, so a retry is still recognized.
- **Out of order.** A chunk past a gap waits, encrypted. Readers see nothing past the gap, since line numbers are assigned only by contiguous assembly. If the gap never fills, the stream closes with a line saying which sequence numbers never arrived.
- **Masking across chunks.** A value split across two chunks is the normal case, so the masker buffers until a line is complete and masks whole lines, including base64 and URL-encoded variants. The partial line is persisted encrypted, so the next chunk can land on another API instance. A very long line is cut only outside the longest secret's hold-back window.
- **Twice.** Runners mask so a value doesn't leave the machine; the API masks because it can't assume every runner did.

### Reading

SSE, with the line number as `id`. On reconnect, `Last-Event-ID` is the cursor, and any instance answers with exactly the lines after it.

Valkey carries no data, only a nudge that says "look now". A lost message costs at most a 2 s poll, never a line. I tested this by pausing Valkey during a live stream.

### Archive

Object first, then in one transaction point at it and delete the rows. A crash leaves two copies, not zero, and the next sweep rewrites the same key with the same bytes. A reader that races it finds no rows but a last-line number past its cursor, re-reads the stream row, and goes to the object. With MinIO down, logs stay readable from PostgreSQL and archival catches up.

### Artifacts

Keyed per attempt, written to object storage. A dependent can read only artifacts of the current attempt of a job in its `needs`, so a re-run producer feeds its re-run consumer, and an unrelated job gets 403. People's downloads check repository access per request, with no presigned URL that outlives a membership. Retention is a sweep: delete the object, then mark the row, so history still says it existed.

---

## 🔁 Retry Semantics (~1 min)

| Action | Resets | Attempts after (build, test, report) |
|--------|--------|--------------------------------------|
| First run | | 1, 1, 1: test fails, report skipped |
| Re-run failed | Failed, cancelled, skipped, plus downstream | 1, 2, 2 |
| Re-run job `test` | The job plus downstream | 1, 3, 3 |
| Re-run all | Everything | 2, 4, 4 |

Attempts are per job, and each keeps its own steps, log, artifacts, runner and token. A non-idempotent job in the set needs confirmation, whichever button got there, and the confirmation is recorded. Re-runs are refused while jobs are active, and refused for an unresolved `needs_attention`.

**Cancel** flips what hasn't started immediately and flags what has. The runner learns from its next heartbeat and kills the group. A `needs_attention` job is left alone: cancelling a run doesn't answer whether the deploy landed.

---

## 🔧 Deep Dives (~9 min)

### Deep dive 1: The fan-in race, and why readiness lives in the transaction

**The decision.** The transaction that finishes a job decides what becomes ready, under a row lock on the run. A dependent's readiness is recomputed from `needs` each time, not counted.

**Why it works.** Two prerequisites finish at the same instant. Under READ COMMITTED each transaction marks itself done and reads the other as still running, so neither enqueues the dependent. It's never run, and nothing ever notices. Serializing completions per run makes the second one see the first one's success. The guard on `status = 'blocked'` means even a duplicate pass can't enqueue twice. Contention is only a run's own jobs, a few transactions a second, and the same transaction also records the status, so there is no state where a prerequisite is finished and its dependent doesn't know. A race test against real PostgreSQL does 25 rounds of simultaneous completions and asserts exactly one `queued` transition per dependent; the end-to-end run repeats it across two API instances.

**Why the alternatives fail.**

| Approach | How it breaks |
|----------|---------------|
| ✅ Readiness in the completion transaction | One commit, nothing to reconcile |
| ❌ Completion event on a queue | Crash between commit and publish loses the dependent, so you add an outbox and a reconciler; two events at once and the consumer has the same race anyway |
| ❌ Periodic poller | Latency equal to its interval, and a scan of every active run |
| ❌ `remaining_needs` counter | Handles success with no run lock, but doesn't cover the failure path, must be recomputed on every re-run, and drifts silently if it ever goes wrong |
| ❌ SERIALIZABLE | Correct, but aborts under exactly this contention, so every completion needs a retry loop |

**What I'm giving up.** Completions of one run are serialized. A thousand-leg matrix finishing together is a thousand short transactions queued on one row. I'd handle that by grouping legs behind a synthetic node so only the last leg touches the dependent, and I wouldn't build it until a matrix that size exists.

### Deep dive 2: `needs_attention`, and what a runner's death actually means

**The decision.** If a step marked non-idempotent had started, the job goes to `needs_attention`: downstream stays blocked, no timer ever changes it, and a person records what happened. Otherwise it's re-queued as a new attempt.

**Why it works.** The evidence exists because of the write-ahead intent: a step can't run without a committed row saying so. The rule is deliberately pessimistic. A started step counts whether or not it finished, because a retry re-executes the whole job, and whether or not its process ever ran, because the row can't tell. A false positive costs a person one click. A false negative deploys twice. The same rule covers a non-idempotent step killed by a cancel or by its own timeout: neither got to say how far it went. A step that exited non-zero told us, so that's a plain failure.

**Why the alternatives fail.** Retrying is what a job queue does by default, and here it runs the migration twice, or charges customers twice. Marking the job failed is also a lie. Dependents skip, someone assumes nothing happened, clicks re-run, and the same double deploy occurs with a human's signature on it. Asking the deployment target would be ideal, but the platform can't do that in general: only the workflow knows what it touched. An exactly-once promise isn't available either, since the effect is outside our transaction.

| Approach | Outcome after the runner vanishes mid-deploy |
|----------|----------------------------------------------|
| ✅ `needs_attention` | Honest; waits for someone who can look |
| ❌ Automatic retry | Possibly two deploys |
| ❌ Mark failed | Lies, then invites the same double deploy |
| ❌ Mark succeeded | Lies in the other direction: dependents act on a deploy that may not exist |

**What I'm giving up.** Availability of the pipeline: a run sits until someone looks, so this needs a page, not a dashboard. And the marker is on the author: an unmarked deploy is retried. Strict parsing stops a typo, but it can't make someone add the marker. I'd also keep one small thing the fence would otherwise throw away: if the lost runner comes back and reports "deploy exited 0", that write is rejected as truth but kept on the attempt as evidence. Fencing protects state, not knowledge.

### Deep dive 3: A PostgreSQL queue, not a broker

**The decision.** Queued jobs are rows, claimed with `FOR NO KEY UPDATE SKIP LOCKED` on a repository row, then a fresh count, then the job.

**Why it works.** What a claim decides isn't "next message". It's: do these labels satisfy this job, is this repository under its limit, whose turn is it, does the environment gate still allow it, and what secrets does it get. All of that has to be atomic with the lease and the audit row, and "job queued" has to be atomic with "prerequisite finished". Those are SQL predicates in one transaction. Fairness is one column: serve the least recently served repository, so a burst can only cost another repository one turn.

**Why a broker fails here.** Label matching becomes a queue per label combination, or requeue churn when the wrong runner gets a job. A per-repository limit becomes a counter outside the broker that can disagree with it. Round robin across a million repositories isn't a broker feature; per-repository queues are operationally absurd at that count. And "enqueue when ready" needs an outbox, which brings back the lost-message problem deep dive 1 removed.

| Approach | Limits and fairness | Atomic with state | Throughput |
|----------|---------------------|-------------------|------------|
| ✅ PostgreSQL SKIP LOCKED | SQL predicates, exact | Yes | Thousands of claims/s per primary |
| ❌ RabbitMQ | Counters outside the broker | Needs an outbox | Higher |
| ❌ Kafka | Partitions don't do per-tenant limits | Needs an outbox | Highest |

**What I'm giving up.** Claims hit the primary, and idle runners cost a query per poll. I'd add long-polling with LISTEN/NOTIFY first, then shard by organization, which keeps every guarantee, because a run never spans shards.

---

## 📜 Execution Traces (~3 min)

### Successful trace: a diamond

`build` → (`test-unit`, `test-integration`) → `package`, pushed by alice.

1. Git host POSTs the signed event. API A verifies the HMAC on raw bytes, then in one transaction inserts the delivery, creates run #1 with its pins and four blocked jobs, and runs readiness: `build` becomes queued. 202.
2. The host lost the response and retries. The insert conflicts, the redelivery count becomes 1, and the same run comes back.
3. runner-1 claims: lock the repository, 0 of 3 running, pick `build`, gate allows, token 41, lease set. Step rows and a log stream are created.
4. Fresh workspace, checkout at the pinned commit. For each step: intent committed, process spawned in its own group, output masked and shipped as numbered chunks, finish reported. Artifact uploaded. Complete.
5. The completion transaction marks `build` success and queues both tests, in one commit.
6. Two runners download the artifact through `needs`. Both complete in the same millisecond, on different API instances. One gets the run lock and sees `package` still blocked. The other waits, then sees both successes, and queues `package` once.
7. A viewer on API B has been getting lines: chunks land on A, A publishes a nudge, B reads past its cursor. Their connection drops at line 90. They reconnect with `Last-Event-ID: 90` to whichever instance answers, and get line 91 onward.
8. `package` completes, and the run derives success. The scheduler archives the logs. The same endpoint keeps serving them.

### Failed trace: the runner dies during the deploy

`build` → `deploy` (environment production, step `Deploy` non-idempotent) → `smoke`.

1. `build` succeeds. `deploy` enters the gate: wait. No secret released, nothing claimable.
2. alice approves. An approval row for attempt 1, the gate allows, and the job is queued.
3. runner-2, which has the `deploy` label, claims it. Gate re-checked, `DEPLOY_TOKEN` decrypted, audit row and lease written in one commit, token 57.
4. `Prepare` runs. Before `Deploy`, the intent commits under the job lock. The process spawns.
5. The machine dies. Heartbeats stop. The deploy may or may not finish, and nobody is left to say.
6. After one lease, the sweep finds it expired by the database clock. It locks the run and job, re-checks, reads the steps: `Deploy` started and is non-idempotent. Decision: `needs_attention`. The token is cleared, the step becomes `unknown`, the log closes with a platform note, `smoke` stays blocked.
7. A replacement runner polls. Nothing to claim. This can last forever; no timer changes it.
8. A page fires. alice checks the load balancer and records "it succeeded", with a note. The job becomes success, and `smoke` is queued, in one commit.
9. Had the old runner come back and reported, its write would get `LEASE_LOST`, and the report would be on the attempt for alice to read.

---

## ✅ Design Review Checklist (~1 min)

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | PostgreSQL. A delivery succeeded when its transaction committed the run and jobs; a step started when its intent committed; a job finished when the completion committed, the same moment its dependents became ready |
| A client retries after losing the response? | Every write is keyed. Same delivery id, same run. A retried chunk changes nothing. A retried completion replays its answer |
| A worker fails between two important steps? | Runner between intent and spawn: the row says started, so a non-idempotent step goes to a person, the conservative direction. Scheduler between object write and row delete: both copies exist, and the next sweep repeats it |
| Which ordering is actually required? | Completions within one run, and log lines within one attempt. Nothing else: different branches and different runs have no order |
| Access through caches, indexes, async jobs? | The log stream checks at open and every 30 s; artifact bytes check on every download; secrets are decided at claim, so a rule change applies to whatever hasn't been claimed |
| What breaks first, and what evidence? | Log writes on the primary: 50M jobs × ~1 MB is more rows than everything else. Locally the connection pool saturated first, answering 503 under a burst plus heavy polling. I haven't load-tested past that |

---

## ❓ Follow-ups the Answer Must Handle

**What happens when the same push event arrives twice?**
The second insert hits the unique constraint on (repository, delivery id), increments the redelivery count, and returns the existing run with 200. If they arrive together, the second waits on the index until the first commits. A concurrent test across two API instances makes ten copies produce one run. Two different delivery ids for one SHA make two runs, because a person may want that.

**How do dependent jobs learn that their prerequisites finished?**
They don't poll and there's no message. The completion transaction decides, under the run lock, and commits the job's status and every readiness consequence together.

**How does a user resume watching logs after a disconnect?**
`Last-Event-ID` is the line number. Any API instance reads lines past the cursor from PostgreSQL, or from the archive after completion, and sends exactly what was missed.

**Can an untrusted pull request access deployment secrets?**
No. The claim path sees `is_fork`, from the signed payload, and hands out an empty object with no audit row. A protected environment denies it when it becomes ready and again at the claim, even with a forged approval. Production also runs fork jobs on a separate pool.

**What happens when a runner disappears after a deployment succeeded?**
The intent row says the step started, so the sweep can't assume anything. `needs_attention`, downstream held, never retried automatically. A person checks and records what happened, and that decision stays on the attempt.

---

## 🚨 Failure Handling (~1 min)

| Failure | Behaviour |
|---------|-----------|
| Runner killed, idempotent job | Lease expires; new attempt elsewhere; dependents continue |
| A job that keeps killing runners | Failed after 2 re-queues |
| Runner frozen, then wakes | Heartbeat says no; it kills its step; its writes are rejected |
| Runner partitioned | After one lease with no renewal it fences itself |
| Whole host asleep | The sweeper notices its own late tick and skips one sweep, so runners heartbeat first |
| API instance down | Runners rotate; viewers reconnect and resume |
| Connection pool saturated | 503 with Retry-After; a Git host redelivers; the delivery id dedupes |
| Valkey down | Sessions fail; open streams keep flowing through the poll; uploads aren't slowed |
| Object store down | Artifact uploads fail that attempt; logs stay in PostgreSQL; every call has a timeout, so a half-dead endpoint can't hold a job open |
| Bad workflow | `invalid` run with errors, no jobs |

---

## 📈 What Breaks First and How It Scales (~2 min)

| Order | What breaks | Why | What I'd do |
|-------|-------------|-----|-------------|
| 1 | Log writes on the primary | A row per line, per running job | Append-only store per attempt, small hot buffer; line offsets stay the contract |
| 2 | Per-run lock on huge matrices | All legs queue on one row | A synthetic node between legs and dependent |
| 3 | Claim on one primary | Every claim touches it | Long-poll first, then shard by organization |
| 4 | Webhook spikes | Git fetch in the request path | Persist and acknowledge, async materializer |
| 5 | One repository's own burst | Limits queue it, but it still waits | Cancel-in-progress groups; per-organization quotas |

Runner autoscaling keys on queue depth and oldest queued age per label: no runners for a label looks exactly like a quiet queue, so age is the signal that matters.

**Observability:** counters for webhooks by outcome, claims, queue wait, lease expiries by decision, stale writes rejected, secrets released and withheld, chunks by outcome. The page I'd set up first is lease expiries with decision `needs_attention`: each one is a deployment nobody knows the state of.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Readiness | ✅ In the completion transaction | ❌ Events, poller | Nothing to reconcile |
| Fan-in | ✅ Run lock, recompute | ❌ Counter, SERIALIZABLE | Nothing to drift, no retry loop |
| Queue | ✅ PostgreSQL SKIP LOCKED | ❌ RabbitMQ, Kafka | One atomic decision |
| Fairness | ✅ Round robin per repository | ❌ FIFO | A burst costs others one turn |
| Lost runner | ✅ Lease + fencing + evidence | ❌ Broker redelivery | The decision uses what happened |
| Unknown outcome | ✅ `needs_attention` | ❌ Retry, fail | Only the target knows |
| Step start | ✅ Intent before spawn | ❌ Report after | No step without evidence |
| Runner access | ✅ HTTP only | ❌ Database access | Least privilege, enforceable fence |
| Fork policy | ✅ At the claim | ❌ In the UI or workflow | Last moment before credentials leave |
| Log resume | ✅ Line offset in one store | ❌ Pub/sub, Streams | Live, resume, archive are one read |
| Definition | ✅ Copied, immutable | ❌ Re-parse | A parser change can't alter old runs |
| Parser | ✅ Strict | ❌ Ignore unknown | A typo mustn't disable a protection |

---

## 📝 Wrap-up (~1 min)

> "The queue was the small part. The answer hinges on three small writes: a delivery row, a step-intent row, and a claim that re-checks policy at the last moment. Those let me say what happened when things go wrong. Where the honest answer is 'the platform doesn't know', it says so and asks someone who can find out."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Ephemeral VM per job | Child processes: **a substitution, not a security boundary** |
| Git host | Fixture store plus a signing generator; intake is the same path |
| KMS, OIDC credentials | AES-256-GCM with a documented dev key |
| Lease of minutes | 6 s lease, 1 s heartbeat |
| Autoscaled fleet | A supervisor restarting two runners |
| Separate log store | PostgreSQL until archived to MinIO |

Everything above runs: two API instances, a scheduler and real runner processes, verified end to end with 326 checks, including SIGKILL and SIGSTOP on real runners, paused Valkey and paused MinIO, and race tests against real PostgreSQL.
