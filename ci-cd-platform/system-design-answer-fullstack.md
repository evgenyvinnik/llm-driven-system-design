# CI/CD Platform — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · Requirements → Architecture → Data model → Run lifecycle → Runner safety → Secrets → Live logs → UI → Deep dives → Traces*

> "I'll treat this as one product with two users: a runner, which is a program that can die at any instruction, and a person, who has to be able to trust what the screen says. A queue is the easy part. What makes this hard is that workflows are arbitrary code holding real credentials, so I need to pin what a run means, say who gets which secret, and be honest when the platform doesn't know what happened. The clearest example is the one I'll keep coming back to: a runner disappears after the deploy step started. The backend records intent before each step so that it has evidence, and the UI's job is to say 'outcome unknown' and ask a person, not to show a green tick or a red cross it can't justify."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Graph, lease, credentials, repeatability |
| Architecture and data | ~6 min | PostgreSQL as source of truth and queue; runners only speak HTTP |
| Run lifecycle | ~8 min | Delivery dedupe, pins, readiness in the transaction, attempts |
| Runner safety | ~5 min | Fencing, write-ahead intent, `needs_attention` |
| Secrets | ~3 min | The fork path, enforced at the claim |
| Live logs | ~4 min | One offset contract, client and server |
| UI | ~5 min | The DAG, the attention panel, confirmation from the server |
| Deep dives | ~7 min | Readiness; unknown outcomes; resumable logs |
| Traces and scale | ~3 min | One success, one failure |

---

## 🎯 Requirements and Scope (~4 min)

### Functional

1. Signed webhooks for push and pull request, deduplicated by delivery id.
2. A run pins its commit SHA and the SHA of its workflow file; parsing is strict.
3. Jobs form a graph: ready when all `needs` succeeded; a failure skips downstream, with the reason.
4. Runners with labels claim jobs under a lease, with heartbeats and a fencing token.
5. A lost runner means a new attempt only if no non-idempotent step started; otherwise a person decides.
6. Secrets scoped to repository or environment, encrypted, never shown, never given to a fork. Environments can require approval.
7. Live logs that resume after a disconnect, then keep working once archived. Artifacts passed through `needs`.
8. Re-run one job, the failed jobs, or everything: new attempts, same pins, history kept.
9. A UI for all of it: runs, a DAG, live logs, approvals, secrets, runners, operations.

### Non-functional

| Property | Target | What it forces |
|----------|--------|----------------|
| Intake | p99 < 200 ms | A durable delivery row first |
| Log latency | p99 < 2 s, write to screen | Push wake-ups, not a slow poll |
| Log resume | No gaps, no duplicates | Numbered lines, one store |
| Lost runner | Detected within one lease | Heartbeats, database clock |
| Deploy safety | Never run twice without a person | Evidence before execution |
| UI honesty | Status never contradicts jobs | Derived on the server, not assembled on the client |

### Scale

About 10M events a day, 50M jobs, peak 2,000 claims a second, 300k concurrent jobs and 50 TB of logs a day. Logs and claims are what the backend feels. On the frontend it's a single job's log, which can be millions of lines, and that decides the rendering approach.

---

## 🏗️ High-Level Architecture (~3 min)

```
                 ┌──────────────────────────────────────────────┐
  Browser        │ Repos · Runs · Run (DAG) · Job (live logs)   │
                 │ Secrets · Environments · Runners · Ops       │
                 └───────┬──────────────────────────▲───────────┘
                         │ REST, polled every 1.5 s │ SSE with fetch
                         ▼                          │ Last-Event-ID
  Git host ──signed──▶ ┌────────────────────────────┴───────┐
                       │          API instances × N         │
  Runner fleet ──HTTP─▶│ intake · people · streams · runner │◀── nudge ── Valkey
  fenced writes        └──────────────┬─────────────────────┘
       │                              │ one transaction per decision
       ▼                              ▼
  Ephemeral VM per job         ┌──────────────┐     ┌──────────────┐
  (the real boundary)          │  PostgreSQL  │◀────│  Scheduler   │
       │                       │ truth, queue,│     │ lease expiry │
       └── artifacts, logs ──▶ │ leases,audit │     │ archive      │
                 ┌─────────────┴──────────────┘     │ retention    │
                 ▼                                  └──────────────┘
           Object store
```

The API is stateless, so a chunk can land on one instance and a viewer can read from another. Runners have no database access, which is what makes fencing enforceable. Readiness isn't a service at all: it's a function called in the transaction that finished a job.

---

## 💾 Data Model (~3 min)

| Table | Key columns | Why |
|-------|-------------|-----|
| trigger_events | (repo, delivery_id) unique, redeliveries, run_id | The constraint is the deduplication |
| workflow_runs | commit_sha, workflow_sha, is_fork, status, run_attempt, error | A trigger rejects changes to the pins |
| jobs | needs[], runs_on[], steps, status, attempt, fencing_token, lease_expires_at | Immutable definition plus the state machine; partial indexes make it the queue |
| job_attempts | (job, attempt), trigger, runner, secrets_released, secrets_withheld, resolution | A re-run adds a row and replaces nothing |
| step_executions | (job, attempt, index), idempotent, status, started_at | The write-ahead intent |
| environments, environment_approvals | rules; (job, attempt) decision | Approval belongs to one attempt |
| secrets, secret_releases | ciphertext; run, job, attempt, runner | Encrypted; every release audited |
| log_streams, log_chunks, log_lines | next_seq, next_line, partial_enc; (job, attempt, line_no) | Assembly state; line_no is the offset |
| artifacts | (job, attempt, name), retention_days, expires_at | Per attempt |

**The status vocabulary is the API's contract with the UI.** A job is blocked, queued, waiting, running, success, failure, cancelled, skipped or needs_attention. A run's status is derived from those on the server every time, so a screen can't show a run that disagrees with its jobs, and `needs_attention` outranks `running` so a long sibling can't hide it.

### API

```
POST /api/v1/webhooks/:owner/:repo              signed; 202 new, 200 duplicate, 401 bad signature

GET  /api/v1/repos/:id/runs                     GET /api/v1/runs/:id
POST /api/v1/runs/:id/rerun                     failed | all, confirmNonIdempotent
POST /api/v1/runs/:id/cancel
GET  /api/v1/jobs/:id                           attempts, steps, timeline
POST /api/v1/jobs/:id/rerun                     confirmNonIdempotent
POST /api/v1/jobs/:id/approval                  approved | rejected
POST /api/v1/jobs/:id/resolve                   succeeded | failed | retry
GET  /api/v1/jobs/:id/attempts/:n/logs/stream   SSE; Last-Event-ID is the line offset
GET  /api/v1/artifacts/:id/download             access-checked
PUT  /api/v1/repos/:id/secrets                  write-only

POST /api/v1/runner/claim                       job, secrets included
POST /api/v1/runner/heartbeat                   per job: ok, cancel
POST /api/v1/runner/jobs/:id/steps/:i/start     the intent
POST /api/v1/runner/jobs/:id/logs               numbered chunks
POST /api/v1/runner/jobs/:id/complete           fenced
```

Errors carry a machine code the UI acts on: `CONFIRM_REQUIRED`, `ATTENTION_UNRESOLVED`, `RUN_NOT_FINISHED`, `LEASE_LOST`. A user with no membership gets 404, not 403, so a repository's existence doesn't leak across organizations.

---

## ⚙️ Run Lifecycle (~8 min)

### 1. Intake

One URL per repository, so the HMAC is checked over raw bytes before anything parses the body. Then one transaction: insert the delivery with on-conflict-do-nothing; a duplicate increments the redelivery count and returns the existing run. Otherwise read the commit, hash the workflow, parse it strictly, create the run and its jobs, and run the first readiness pass.

A rejected workflow still creates a run, status `invalid`, with errors recorded and no jobs. The UI shows the reasons in a banner, because a push that silently does nothing is the worst outcome.

> "Strict parsing is a safety feature. If `idempotnet: false` were ignored, a typo would disable the one protection on a deploy step."

### 2. Repeatability

The pinned workflow is parsed once and copied onto job rows, which a trigger makes immutable. A re-run reads the job rows, not Git. The run page shows both SHAs as "pinned", with the original file behind a button.

### 3. Readiness

The transaction that finishes a job locks the run, writes the status, and asks a pure function what changed: every prerequisite succeeded means the job enters its environment gate; a prerequisite failed, cancelled or skipped means skipped with a reason. It repeats until nothing changes, then derives the run's status. A prerequisite in `needs_attention` leaves dependents blocked, since the outcome isn't known.

The UI gets this for free: the DAG redraws from statuses on its next poll, and a skipped node says why.

### 4. The claim

PostgreSQL is the queue. Lock one repository with `SKIP LOCKED`, least recently served first, among those with a queued job these labels can take and room under their limit. Re-count running jobs under the lock, so the limit is exact. Take the oldest job, re-check its gate, release secrets, write audit rows, take a fencing token and a lease. One transaction.

Round robin means a burst costs another repository one turn. Measured locally, with 48 pushes saturating 6 slots: the burst's worst wait was 9.2 s and a second repository's was 1.4 s. The ops page shows this as job starts over time per repository, and a table of peak concurrency against limit.

### 5. Attempts

Each attempt is a permanent row with its own steps, log, artifacts, runner and token.

| Action | Resets | Attempts after (build, test, report) |
|--------|--------|--------------------------------------|
| First run | | 1, 1, 1 |
| Re-run failed | Failed, cancelled, skipped, plus downstream | 1, 2, 2 |
| Re-run job `test` | The job plus downstream | 1, 3, 3 |
| Re-run all | Everything | 2, 4, 4 |

The job page has an attempt selector that reads every attempt's log through the same endpoint, including older ones in the archive.

---

## 🛡️ Runner Safety (~5 min)

**Lease and fence.** A claim sets a lease from the database clock. One batched heartbeat a second renews everything a runner holds. Every write carries a token, checked under the job's row lock, together with the runner id. A frozen runner that wakes up gets rejected, and its heartbeat tells it to kill its step.

**Write-ahead intent.** The step-start write commits before the process is spawned. If it fails, the step doesn't run. Expiry takes the same row lock before reading the steps, so a step either is visible to it or is rejected. There's no window where a step starts and the decision misses it.

**The decision when a lease expires:**

```
Any step started with idempotent: false?  ─ yes ─▶ needs_attention. Never retried automatically.
          │ no
Retry budget used up?                     ─ yes ─▶ failure: this job may be killing runners.
          │ no
          ▼
new attempt, same pinned definition
```

A non-idempotent step killed by cancel or by its own timeout gets the same treatment, because neither got to report how far it went.

**The execution boundary.** Production is an ephemeral VM per job with fork jobs on a separate pool. Inside that: a fresh workspace per attempt, a scrubbed environment, per-step timeouts, resource limits, and killing the whole process group. Locally the steps are child processes, which is a substitution and not a security boundary, and it's acceptable only because workflows come from a fixed catalog in the code. The fixture panel selects a scenario by name, so nothing typed in a browser reaches a shell.

---

## 🔐 Secrets (~3 min)

> "Can an untrusted pull request read deployment secrets? No, and the UI has nothing to do with why."

The policy is a pure function called from the claim, reading `is_fork` from the signed payload. A pull request counts as a fork if the payload says so, or the head repository differs, or there's no head repository; that last one is a deleted fork, and it fails closed. A fork gets an empty secrets object and no audit row. A protected environment denies it when the job becomes ready, and again at the claim, even with a forged approval row in the database, which I test.

| Situation | Environment gate | Secrets |
|-----------|------------------|---------|
| Same-repo push | allow | What the workflow names |
| In an environment, approved | allow | Environment secrets too |
| Protected, not approved | wait | None, not claimable |
| Fork, protected environment | deny | None |
| Fork, unprotected | allow | None |

Values are AES-256-GCM encrypted with the scope as associated data. The API has no field for a value, only metadata, so the secrets screen can't leak what it never receives. The form is write-only: the value goes up once and the field clears.

Masking is line-buffered, so a value split across two chunks is caught, at the runner and again at the API. It's hygiene and not a boundary. A step holding a secret can print it backwards.

The UI shows what a job asked for and didn't get, with the reason: `NPM_TOKEN withheld: Pull requests from forks never receive secrets`. People debugging a fork's failure need to see that, not an unexplained empty variable. A release audit lists every release with its run, job, attempt and runner.

---

## 📜 Live Logs (~4 min)

One contract runs through the whole stack: **a line's number is its offset, and it's the SSE id.**

```
Runner                  API (any instance)                 Viewer
  │ masks, numbers        │                                  │
  ├── chunk seq=2 ───────▶│ stored, encrypted; gap: wait     │
  ├── chunk seq=1 ───────▶│ assemble 1, 2 → lines 41-58      │
  │                       │ publish nudge ──▶ Valkey ──▶ any instance
  │                       │                  read line_no > cursor
  │                       │◀──────────────── id: 58 ─────────┤
  │                                      connection drops    ✂
  ├── chunk seq=3 ───────▶│ lines 59-70                      │
  │                       │◀── GET, Last-Event-ID: 58 ───────┤ to another instance
  │                       │─── id: 59 ... id: 70 ───────────▶│ exactly the missing lines
```

**Server.** Chunks are idempotent by (job, attempt, seq) and may arrive out of order; line numbers are assigned only by contiguous assembly. Valkey carries no data, only a nudge, so a lost message costs a 2 s poll and never a line. After completion, the scheduler archives to MinIO, and the same endpoint reads from there, keeping the same ids.

**Client.** I read SSE with `fetch` and a `ReadableStream`, not `EventSource`, because I want the cookie, the header and the reconnect under my control. The hook keeps a cursor, which is the last line it holds. On any drop it reconnects with backoff, sending the cursor as `Last-Event-ID`. A line whose number isn't past the cursor is dropped, so a duplicate can't render even if the server sent one.

**Rendering.** A job can log a million lines, so the viewer virtualizes with a fixed row height, batches state updates on a 150 ms timer, and appends to the end. Text is rendered as text, so log content can't inject markup.

The log panel shows its state: live, reconnecting, complete; which instance is serving; whether the source is PostgreSQL or the archive. A "Drop connection" button aborts the fetch, and a note says what happened on resume: "Reconnected with Last-Event-ID 58: received 12 lines starting at 59, no gap, no duplicates."

---

## 🖥️ The UI (~5 min)

| Route | What it does | State |
|-------|--------------|-------|
| `/repos`, `/repos/:id` | Lists; runs with filters | Polling |
| `/repos/:id/secrets` | Metadata, write-only form, release audit | Polling |
| `/repos/:id/environments` | Protection rules | Polling |
| `/runs/:id` | Pins, attention and approval panels, DAG, jobs, artifacts | Polling at 1.5 s |
| `/runs/:id/jobs/:jobId` | Attempt selector, steps, live logs, timeline | Polling + SSE |
| `/runners`, `/ops` | Leases, queue depth, per-repo concurrency, burst behaviour | Polling |
| `/fixtures` | Push, duplicate delivery, fork PR, runner kill | Polling |

**Polling except for logs.** Job state changes every few seconds; a poll per open page is cheap and simple. Logs arrive many times a second, and resume matters, so only they hold a connection, and only on the job page.

**The DAG** is an SVG I lay out myself: columns by longest path from the roots, rows ordered to keep edges short. Each node shows its name, its status in words and its attempt, so color isn't the only signal. Skipped and blocked nodes are dashed. A node is keyboard reachable and links to its job.

**The attention panel** is the most important screen in the product. It sits above everything. It says what's known: "Outcome unknown: step Deploy is marked non-idempotent and had started when runner-2 stopped responding. It may have succeeded." It offers three decisions, not one: it succeeded (continue), it failed (skip downstream), or it's safe to run again (retry, behind a second confirmation). A note field records what the person checked, and that stays on the attempt.

**Confirmation comes from the server.** The re-run button doesn't work out whether a job is non-idempotent. It sends the request, and on `CONFIRM_REQUIRED` it opens a dialog listing the steps the server named. The rule lives in one place, and the UI can't drift from it.

**Permissions** are also the server's: `canManage` comes with the run, carol sees no buttons, and if she crafted the request she'd get 403. Bob sees 404, and a shared runner busy with Acme's job shows him only "busy with a job you cannot see".

---

## 🔧 Deep Dives (~7 min)

### Deep dive 1: Readiness in the completion transaction

**The decision.** The transaction finishing a job decides what becomes ready, under a row lock on the run.

**Why it works.** Two prerequisites finish at the same instant. Under READ COMMITTED each sees the other as still running, and the dependent is never enqueued. Locking the run serializes them, so the second sees the first's success. A guard on `status = 'blocked'` means a repeat can't enqueue twice. The status and its consequences commit together, so the DAG never shows a finished prerequisite with a dependent that doesn't know. A race test does 25 rounds of simultaneous completions against real PostgreSQL.

**Why the alternatives fail.**

| Approach | How it breaks |
|----------|---------------|
| ✅ In the transaction | One commit, nothing to reconcile |
| ❌ Completion event | A crash between commit and publish loses the dependent; two events at once and the consumer has the same race |
| ❌ Poller | Latency equal to the interval; scans every active run |
| ❌ Counter | Doesn't cover failures, must be rebuilt on re-runs, drifts silently |

**What I'm giving up.** Completions of one run are serialized, so a thousand-leg matrix queues on one row. I'd add a synthetic node between legs and dependent when that matrix exists.

### Deep dive 2: Saying "I don't know"

**The decision.** A started non-idempotent step on a lost runner produces a distinct state, `needs_attention`, which holds downstream and asks a person. The API exposes that state, and the UI gives it its own color, its own panel and three decisions.

**Why it works.** The backend has real evidence: a committed intent row. The UI can then say something precise, naming the step and the runner. A false positive costs one click, while a false negative deploys twice.

**Why the alternatives fail.** Retrying is the queue's default, and it can double-deploy. A red "failed" is a lie the UI tells on the backend's behalf: someone reads it, assumes nothing happened, clicks re-run, and causes the double deploy themselves. A green tick lets dependents act on something that may not exist. A yellow "warning" that doesn't block downstream is the worst of them, since the pipeline carries on.

| Display | What the person does | Result |
|---------|----------------------|--------|
| ✅ "Outcome unknown", three decisions | Checks, then decides | Correct either way |
| ❌ "Failed", re-run button | Re-runs | Possibly two deploys |
| ❌ "Succeeded" | Nothing | Smoke tests run against a deploy that may not exist |

**What I'm giving up.** Runs sit until someone looks, so it needs a page, not only a banner. And the marker is on the workflow's author: an unmarked deploy is retried. I also keep a late report from the lost runner as evidence, rejected as truth but shown in the panel, since fencing protects state, not knowledge.

### Deep dive 3: Resumable logs with one offset

**The decision.** Line numbers, assigned once on the server by contiguous assembly, are the only cursor. Client and server both trust them.

**Why it works.** "Missing lines" becomes a single query: line number greater than the cursor. It works on any instance, because the data is in PostgreSQL; it works after archival, because the object has the same numbers; and the client can deduplicate with one comparison. A chunk arriving out of order doesn't confuse a reader, since lines don't exist until the gap is filled.

**Why the alternatives fail.** Pub/sub fan-out alone loses what was published during a reconnect, so resume is impossible. Valkey Streams would work for resume, but that's a second copy of the log with its own retention, and a second code path once it's archived. Chunk sequence as the cursor is awkward, because chunks are a transport detail with variable sizes, and masking moves text between them. Client-side deduplication by content can't work when log lines legitimately repeat.

| Approach | Resume | After archival | Cost |
|----------|--------|----------------|------|
| ✅ Line offset in one store | One query | Same contract | PostgreSQL carries the live tail |
| ❌ Pub/sub only | Impossible | Separate path | Cheap |
| ❌ Valkey Streams | Works | Separate path | Second source of truth |

**What I'm giving up.** PostgreSQL carries every line while a job runs, which is its heaviest write path and the first thing I'd move. The offset contract survives the move, so neither the client nor the runner changes.

---

## 📜 Execution Traces (~2 min)

### Successful trace

1. Git host POSTs a signed push. HMAC checked, one transaction creates the delivery, run #1 and four blocked jobs; `build` is queued. A retried delivery returns the same run.
2. The repository's run list polls and shows `#1 running`.
3. runner-1 claims `build` with token 41. It records intent, spawns the process in its own group, and ships masked, numbered chunks.
4. A viewer opens the job page. The hook sends no header, and gets lines from 1. Their Wi-Fi drops at line 90; the panel says reconnecting; `Last-Event-ID: 90` goes to the other API instance, and line 91 arrives, with a note saying so.
5. `build` completes. In one commit, both test jobs are queued. The DAG shows them on its next poll.
6. The tests finish at the same instant, and the run lock serializes them. `package` is queued once.
7. The run derives success. The log moves to MinIO and the panel says so; a reconnect still works.

### Failed trace

1. `deploy` is ready; its gate says wait. The approval panel appears. Carol sees no buttons; alice approves.
2. runner-2 claims it, gets `DEPLOY_TOKEN`, and the audit row commits with the lease. The UI shows the secret as released.
3. The `Deploy` intent commits. The process spawns. The machine dies.
4. Log lines stop. The panel still says live, because the stream is healthy and nothing has happened yet. The job page's lease badge counts down.
5. One lease later, the sweep decides `needs_attention`. The log gets a highlighted platform note, the DAG node turns amber, the step shows "outcome unknown", and `smoke` stays blocked. The attention panel appears on the next poll.
6. alice checks the load balancer, types a note, and clicks "It succeeded". `smoke` is queued in the same commit. Her decision stays on the attempt.

---

## ✅ Design Review Checklist (~1 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL. When the transaction commits: delivery + run; intent; completion + readiness. The UI shows only what's committed |
| Client retries after losing the response? | Every write is keyed. Same delivery id, same run; a retried chunk or completion changes nothing. A browser re-run retried after success gets `RUN_NOT_FINISHED` |
| Worker fails between two steps? | Between intent and spawn, the row says started, so a non-idempotent step goes to a person. Between archive write and row delete, both copies exist |
| Which ordering is required? | Completions within a run; log lines within an attempt. Nothing else |
| Access through caches and async jobs? | Log stream checks at open and every 30 s; artifact bytes check per request; secrets are decided at claim; the fleet view hides other organizations' job names |
| What breaks first, and what evidence? | Log writes on the primary: arithmetic says more rows than everything else. Locally the connection pool saturated first, with 503s under a burst plus heavy polling. I haven't load-tested beyond that |

---

## ❓ Follow-ups the Answer Must Handle

**The same push event arrives twice?** The unique constraint on (repository, delivery id) means the second finds the first's run and returns it with 200. The run page says "received 2×, one run".

**How do dependent jobs learn that their prerequisites finished?** In the same transaction that finished them. Nothing polls, and no message can be lost.

**How does a user resume watching logs after a disconnect?** The hook reconnects with `Last-Event-ID` set to its last line. Any instance sends what's after it, from PostgreSQL or the archive. The panel shows the reconnect and what arrived.

**Can an untrusted pull request access deployment secrets?** No. The claim path gives a fork an empty object and refuses it a protected environment, even with a forged approval. The UI reports the withheld secrets and why.

**A runner disappears after a deployment succeeded?** The intent row proves the step started, so the job goes to `needs_attention` and is never retried automatically. The UI says the outcome is unknown and a person decides.

---

## 🚨 Failure Handling

| Failure | Backend | What the person sees |
|---------|---------|----------------------|
| Runner killed, idempotent job | New attempt elsewhere | Attempt 1 `lease expired`, attempt 2 running |
| Runner killed, deploy | `needs_attention` | The attention panel |
| Frozen runner wakes | Writes rejected, kills its step | A rejected report, if it sent one |
| API instance down | Runners rotate | Log panel reconnects, resumes |
| Valkey down | Poll fallback | Logs arrive up to 2 s late |
| Object store down | Logs stay in PostgreSQL | "from PostgreSQL" in the panel |
| Server unreachable | | Log panel shows reconnecting; polled pages keep their last data with an error note |
| Bad workflow | `invalid`, errors recorded | A banner listing the errors |

---

## 📈 What Breaks First (~1 min)

1. **Log writes on the primary.** Move to an append-only store per attempt; offsets remain.
2. **Per-run lock on huge matrices.** A synthetic node between legs and dependent.
3. **Claim on one primary.** Long-polling first, then shard by organization.
4. **Polling at scale.** Many open run pages; a per-run change feed over one connection, keyed by a version.
5. **Very large logs in the browser.** Virtualization handles rendering, but memory grows with lines held; keep a window and fetch older lines on scroll.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Readiness | ✅ In the transaction | ❌ Events, poller | Nothing to reconcile |
| Queue | ✅ PostgreSQL SKIP LOCKED | ❌ Broker | Limits, fairness and gates are one atomic decision |
| Lost runner | ✅ Fencing + intent | ❌ Redelivery | The decision uses evidence |
| Unknown outcome | ✅ A state and a panel | ❌ Retry, or failed | Only the target knows |
| Fork policy | ✅ At the claim | ❌ In the UI | Last moment before credentials leave |
| Live state | ✅ Polling, SSE only for logs | ❌ WebSockets everywhere | Seconds-scale state; one stream where it matters |
| SSE client | ✅ `fetch` | ❌ `EventSource` | Header, cookie and reconnect in our hands |
| Log cursor | ✅ Line number | ❌ Chunk seq, byte offset | Stable through masking and archival |
| Log view | ✅ Virtualized | ❌ Full DOM | A million lines |
| DAG | ✅ Hand-rolled SVG layers | ❌ A graph library | Small graphs, no dependency |
| Confirmation | ✅ Server names the steps | ❌ Client decides | One rule, one place |

---

## 📝 Wrap-up (~1 min)

> "The same idea shows up on both sides. The backend writes down what it's about to do before doing it, so it never has to guess, and when it still can't know, the frontend tells a person exactly that and records their answer."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Ephemeral VM per job | Child processes: **a substitution, not a security boundary** |
| Git host | Fixture store plus a signing generator; a panel to drive it |
| KMS, OIDC | AES-256-GCM with a documented dev key |
| Lease of minutes | 6 s, so the demo doesn't take minutes |
| Autoscaled fleet | A supervisor restarting two runners |

It runs and it's verified: 326 end-to-end checks against real runner processes, including real SIGKILL and SIGSTOP, and race tests against real PostgreSQL.
