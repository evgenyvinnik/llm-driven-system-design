# LLM Eval Dashboard — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → Run lifecycle → Scoring → Statistics → Deep dives → Key question → Traces → Scale*

> "An eval dashboard looks like a CRUD app with a job runner bolted on. If I design it that way, I'll get the easy half right and the numbers wrong. The product answers one question: is this change actually better? Three things can turn the answer into a lie. Tasks fail and silently drop out of the average. Samples vary from call to call. And comparisons get made where more than one thing moved. So I'll design two halves. The execution half fans a run out into case × sample tasks and runs them against a rate-limited model, with retries, crash recovery and cancel, and it never loses or duplicates a result. The analysis half turns rows into intervals, and it refuses to call anything an improvement unless the provenance supports it. Three rules carry the answer. Every input is an immutable version that a run pins. Outputs are facts and scores are judgments, so they're stored apart. And the case, not the sample, is the unit of analysis."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and scope | ~5 min | The provider is the scarce resource; the numbers must be honest |
| Architecture and data model | ~7 min | No broker: the task table is the queue; immutable pins; scores apart |
| Run lifecycle | ~9 min | Idempotent fan-out, fair claim with an exact limit, leases, retry, cancel |
| Scoring and statistics | ~5 min | Re-score with zero model calls; per-case means; paired intervals |
| Deep dives | ~10 min | SKIP LOCKED vs RabbitMQ; leases + fencing; the case as the unit |
| Key question, traces, checklist | ~6 min | What an "improvement" requires; one success, one failure |
| Scale and wrap-up | ~3 min | The claim path on the primary breaks first |

---

## 🎯 Requirements and Scope (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who runs evals, and how often? | Load shape, tenancy | ~2,000 workspaces, ~10 runs per team per day, by hand and from CI |
| How big is a run? | Fan-out size, claim rate | 500 cases × 5 samples typical; 100k tasks max |
| Which scorers? | Inline vs queued scoring | Exact, regex, contains, JSON shape, a model-graded judge, humans |
| Is the model ours? | What we optimise | No: a provider with rate limits and 429s; it is the bottleneck |
| Can scorers change after a run? | Storage layout | Yes, often. Fixing a scorer must not mean generating again |
| Do results need to be auditable? | Retention, immutability | Yes: every "B is better" claim must be reproducible forever |

### Functional requirements

1. Datasets, prompts, model configs and scorers with immutable versions; a case-level diff between dataset versions.
2. Eval runs pin a dataset version, a prompt version, a model config, ≥ 1 scorer versions, a sample count and a concurrency limit. Creation is idempotent.
3. Execution fans out case × sample tasks, with a per-run limit and fairness between runs. Every attempt records its output, usage, latency split and error.
4. Partial failures: transient errors retry, permanent ones are recorded, the run ends "completed, N errored", and "retry errored" re-runs only those tasks.
5. Cancel stops model calls within seconds; a worker crash recovers with no duplicate results.
6. Results: a mean with a 95% interval per scorer version, with the errored count next to it; flaky cases; every output inspectable.
7. Comparisons paired by case, with provenance flags; re-scoring with a new scorer version; human annotation with judge agreement.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Run creation | p99 < 2 s for 100k tasks | Fan-out as one set-based insert in one transaction |
| Claim | p99 < 20 ms at 2,000 claims/s | Single-row claims on partial indexes |
| Cancel | Model calls stop < 2 s fleet-wide | A push signal plus a polling fallback |
| Crash recovery | Within one lease (≤ 2 min), zero duplicates | Leases, fencing tokens, a unique task key |
| Correctness | No aggregate silently drops a case; no cross-scorer-version comparison | Errored counts everywhere; provenance checks before statistics |
| Availability | 99.9% API; runs survive any single process failure | No in-memory state that matters |

### Capacity

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Tasks per day | ~50M | 20k runs × 2,500 tasks |
| Peak claim rate | ~2,000/s | ~600/s average, 3× in working hours |
| Model calls in flight | ~20,000 | 2,000/s × ~10 s per call; capped by provider limits |
| Output storage | ~100 GB/day | 50M × 2 KB; inputs are referenced, not copied |
| Score rows | ~10 GB/day | 2 scorers per output, ~100 B each; ~30% need a judge call |

> "The numbers say the database isn't the scarce resource, the provider is. Two thousand claims a second keeps twenty thousand calls in flight, which is more than most provider quotas allow. So per-run limits and fairness exist to share provider capacity, and the queue only has to keep those slots full. That's why I can afford to put the queue in PostgreSQL."

---

## 🏗️ High-Level Architecture (~4 min)

```
                ┌──────────────────────────────────────────────┐
                │ React dashboard: runs · compare · datasets   │
                └──────────────────────┬───────────────────────┘
                                       │ HTTPS, session cookie
                             ┌─────────▼─────────┐
                             │ API gateway / LB  │
                             └─────────┬─────────┘
             ┌─────────────────────────┼─────────────────────────┐
     ┌───────▼───────┐         ┌───────▼───────┐         ┌───────▼───────┐
     │ API service   │         │ API service   │   ...   │ API service   │
     └───────┬───────┘         └───────┬───────┘         └───────┬───────┘
             │ run + fan-out, one txn, NOTIFY                    │ results, compare
             ▼                                                   ▼ (read replicas)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ PostgreSQL primary: source of truth AND work queue                       │
  │  immutable: dataset versions + cases · prompt versions · model configs   │
  │             · scorer versions (a trigger rejects UPDATE and DELETE)      │
  │  eval_runs ─ run_scorers                                                 │
  │  case_results ◀── one row per task: SKIP LOCKED claim, lease, fence      │
  │  case_attempts · scores (output × scorer version) · annotations          │
  └──────────▲───────────────────────────────────────────────────┬───────────┘
             │ claim · heartbeat · fenced write                  │ LISTEN eval_tasks,
             │                                                   │        eval_cancel
  ┌──────────┴───────────────────────────────────────────────────▼───────────┐
  │ Eval workers (N processes × M slots)                                     │
  │ claim → render → stream call → classify → fenced write + inline scores   │
  │ judge-score claims · finalize run · sweeper (advisory-lock holder)       │
  └──────────┬───────────────────────────────────────────┬───────────────────┘
             │ streaming completions (SSE)               │ judge calls (JSON)
   ┌─────────▼─────────┐                      ┌──────────▼────────┐
   │ Model provider(s) │                      │ Judge model       │
   │ rate limits, 429s │                      │ separate quota    │
   └───────────────────┘                      └───────────────────┘
   Valkey: sessions and the login rate limit only, never a source of truth
```

> "There is no message broker. Each task is a row that exists from the moment the run is created. Claiming it, leasing it, retrying it and storing its result are all updates to that row. The API is stateless and only writes runs, versions, cancels and labels. Workers do everything that talks to a model. NOTIFY is only a wake-up hint: if it's lost, workers poll, so correctness never depends on it."

---

## 💾 Data Model (~3 min)

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| dataset_versions | id, dataset_id, version, case_count, content_hash | unique (dataset_id, version) | Immutable; hash of its case hashes in key order |
| dataset_cases | id, dataset_version_id, case_key, input (JSON), reference, tags, content_hash | unique (version, case_key) | case_key is identity across versions; cases copied per version |
| prompt_versions · model_configs · scorer_versions | template + variables; model, temperature, max tokens, seed; scorer kind + config | unique (parent, version) | Immutable; new version names its base, stale base → 409 |
| eval_runs | id, workspace_id, four pins, samples_per_case (1-20), concurrency_limit (1-64), status, total_tasks, retry_round, idempotency_key, request_hash, last_claimed_at | unique (workspace, creator, idempotency_key); partial on (last_claimed_at, created_at) for active runs | State machine: queued → running → completed / cancelled / failed |
| run_scorers | run_id, scorer_version_id, origin (pinned or rescore) | PK (run, scorer version) | Which judgments a run carries |
| case_results | id, run_id, case_id, sample_index, status, attempts, round_attempts, available_at, lease_owner, lease_token, lease_expires_at, output, tokens, queue/TTFT/generation ms, error | unique (run, case, sample); partial (run, available_at) where pending; partial (run, lease_expires_at) where running | The task and its result in one row; id derived from (run, case, sample) |
| case_attempts | case_result_id, attempt, worker_id, outcome, error_code, http_status, delay_ms | PK (case_result, attempt) | succeeded · retry_scheduled · errored · lease_expired · cancelled · superseded |
| scores | case_result_id, scorer_version_id, run_id, status, score, passed, confidence, lease columns | PK (case_result, scorer_version); partial on available_at where pending | Judge scores are claimed like tasks |
| annotations | case_result_id, label (pass/fail), note, annotated_by | PK case_result | Upsert; also writes human-scorer score rows |

> "Two schema choices do a lot of work. The unique key on (run, case, sample) is why a re-leased task can never produce a second result: there is one row, and a crash can only overwrite it, never add to it. And the scores primary key on (output, scorer version) is why re-scoring is an insert, and why 'both runs used the same scorer version' is something I can check rather than hope. Immutability is enforced by a trigger, not by code review, because a pin that can drift isn't a pin."

---

## 🔌 API Design (~2 min)

```
POST /api/v1/runs                      Idempotency-Key required → 201 new, 200 replay, 422 key reuse
GET  /api/v1/runs                      status, progress, primary aggregate ± CI, errored count
GET  /api/v1/runs/:id                  pins, progress, usage, one aggregate per scorer version
GET  /api/v1/runs/:id/cases            per case: samples, outputs, scores, labels, per-case stats
GET  /api/v1/runs/:id/case-results/:cr/attempts    attempt history (worker, outcome, delay)
POST /api/v1/runs/:id/cancel           idempotent; second call reports alreadyFinished
POST /api/v1/runs/:id/retry-errored    409 while running; requeues errored tasks and scores
POST /api/v1/runs/:id/rescore          {scorerVersionId} → 202 {queued, alreadyScored}; 409 while running
PUT  /api/v1/runs/:id/annotations/:cr  {label, note} upsert
GET  /api/v1/compare?a=&b=&scorer=     provenance, paired or unpaired statistics, verdict, per-case table
POST /api/v1/datasets/:id/versions     {baseVersion, cases} → v+1 and diff; 409 stale; 422 unchanged
GET  /api/v1/datasets/:id/diff         added / removed / modified fields / unchanged
```

Every route is session-authenticated and workspace-scoped; another workspace's id is a 404, not a 403, so ids don't leak existence.

---

## ⚙️ Run Lifecycle (~9 min)

### Creation: validate, pin, fan out — in one transaction

1. Look up (workspace, user, Idempotency-Key). Same request hash → 200 with the existing run and an Idempotent-Replayed header. Different hash → 422 IDEMPOTENCY_KEY_REUSED.
2. Check that every pin belongs to the caller's workspace, and render the template against every case. A missing variable fails now with 422, not as N errored tasks ten minutes later. Cap the total task count.
3. One transaction inserts the run (conflict on the idempotency key does nothing), one run_scorers row per pinned scorer, and every case_results row as a single set-based insert: dataset cases crossed with the sample indices. Then it notifies eval_tasks.

> "A run is never half fanned out. Either the run and all its tasks exist, or nothing does. Two concurrent duplicates serialize on the unique index; the loser's insert returns nothing and it answers with the winner's run. Locally that's race-tested: five concurrent duplicates give one run and 23 tasks. With a broker, this step would be a dual write — the run in PostgreSQL, the messages in RabbitMQ — and I'd need an outbox and a relay to avoid losing or duplicating tasks."

### Claim: fair, with an exact per-run limit

A task is claimable when it is pending and due (available_at has passed), or running with an expired lease, because its worker died. A claim is one short transaction:

1. **Pick a run.** Among queued or running runs that have a claimable task and fewer live leases than their limit, take the least recently served one: ordered by last_claimed_at (never-served first), then creation time. Lock that run row with FOR NO KEY UPDATE SKIP LOCKED. A claimer that finds it locked skips to another run, and if every runnable run is momentarily locked it retries after 5-25 ms instead of idling.
2. **Re-count in a fresh statement.** Under READ COMMITTED each statement takes a new snapshot, so this one sees every claim committed before we got the lock, and nobody else can claim for this run while we hold it. If live leases are still under the limit, take one task with FOR UPDATE SKIP LOCKED, ordered by available_at, then sample index, then case. Set it running, increment attempts, write a new random lease token, and set the lease expiry to the database's now plus the lease length.
3. **Bookkeeping.** Set last_claimed_at to the wall clock at that moment, so the order reflects real claim times. Move the run from queued to running. If the task was re-claimed from an expired lease, mark the previous attempt lease_expired. Insert the new attempt row. Commit.

> "Three properties fall out. The limit is exact: all claimers for one run serialize on its row, and the count is taken after the lock. Fairness is round robin, so a 100k-task run and a 50-task run alternate claims, and the small one isn't stuck behind the big one. Order within a run is sample-major, so early results cover every case once before any case gets a second sample. One subtlety: I lock the run with NO KEY UPDATE, not plain UPDATE, so score inserts — whose foreign-key checks take a key-share lock on the run — never wait behind a claimer. And locks are always taken run row first, then task rows, so a cancel can't deadlock a worker."

### Execute and classify

The worker renders the template, streams a completion with seed = config seed × 1,000 + sample index, records time to first token and generation time, and heartbeats every third of the lease. Then it classifies the outcome:

| Failure | Kind | Action |
|---------|------|--------|
| 429 | rate_limited | ✅ Retry after max(Retry-After, jittered backoff) |
| 529 / 503 | overloaded | ✅ Retry with backoff |
| Other 5xx | server_error | ✅ Retry with backoff |
| Client deadline / 408 / 504 | timeout | ✅ Retry with backoff |
| Refused or reset before headers | network | ✅ Retry with backoff |
| Stream ends without done, or an error event | stream_disconnected / stream_error | ✅ Retry; partial output discarded |
| 400 context overflow | context_length_exceeded | ❌ Errored; never retried |
| Other 4xx (invalid, auth) | invalid_request / auth | ❌ Errored; never retried |

Backoff is full jitter: attempt *n* waits a uniform random delay between zero and min(cap, base × 2^(n−1)), at most 4 attempts per retry round. A retry is a fenced update back to pending with available_at = the database's now plus the delay. The worker decides the delay; the database clock schedules it, so host clock drift can't make a task run early or late.

> "Classification is a correctness decision, not a nicety. Retrying a context overflow burns quota and delays the run for nothing, because the input will never fit. Giving up on a 429 turns provider weather into a false regression in tomorrow's comparison. Full jitter matters because a provider throttle hits every in-flight call at once; without jitter they all come back in the same millisecond and get throttled again."

On success, one transaction does the fenced update (output, usage, latency), marks the attempt succeeded and inserts the deterministic scores. Every later write — heartbeat, success, retry, error — matches only if the row is still running under this worker's lease token.

### Finalize: "completed, N errored"

After every terminal write, the worker runs one guarded update: the run becomes completed if any task succeeded, or failed if none did, but only if it is still running and no task or score is pending or running. Many workers may call it at once; the status guard lets exactly one transition win. The sweeper repeats the check every few seconds for a run whose last worker died between its write and its finalize.

> "The status is 'completed' with a count of errored tasks shown next to it, never a silently smaller denominator. 'Failed' is reserved for nothing succeeding at all, such as a model whose context window fits no prompt. The errored count appears next to every aggregate in the API, so no client can display a mean without it."

### Retry errored reopens the run

Retry-errored requires a finished run. It moves errored tasks back to pending with round_attempts reset, errored scores back to pending, and the run back to running with retry_round incremented. Successful tasks aren't touched, and attempt history is kept.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Reopen the same run | One run, one pin set, one result set that grows more complete | A completed run can change later, so aggregates are computed on read |
| ❌ Child run with the errored cases | Old run never changes | Every aggregate and comparison must merge two records; "which run is the result?" is ambiguous |

### Cancel reaches the model

1. Cancel is one transaction: the run becomes cancelled, every pending task and score becomes cancelled, and the API notifies eval_cancel with the run id.
2. Every worker listens. On the notification it aborts the AbortController of each in-flight call for that run. The HTTP connection closes and the provider stops generating. The attempt is recorded cancelled, and partial output is kept with finish_reason cancelled.
3. No new call starts, because the claim only considers queued or running runs.
4. Fallbacks for a missed NOTIFY (say, a listener reconnecting after a laptop sleep): each worker re-checks the runs it has calls in flight for every second, and the sweeper cancels leftover pending tasks — a retry written just after the cancel — and expired leases of cancelled runs.

> "Measured locally, in-flight calls stop 15-20 ms after the cancel returns. The worst case with a lost notification is about one second, bounded by the poll. Cancelling a 100k-task run is one UPDATE, not 100k messages to drain and discard."

---

## 🧮 Scoring and Re-scoring (~2 min)

- **Deterministic scorers** (exact, regex, contains, JSON shape) run in the worker and are written in the same transaction as the output, so a finished output is scored atomically.
- **Judge scores** are inserted pending and claimed exactly like tasks — SKIP LOCKED, lease, fence, the same retry classification — against the judge's separate quota. The judge returns a grade from 1 to 5, pass/fail and a confidence.
- **Human scores** come from annotations.
- **Re-scoring** a finished run adds a run_scorers row with origin rescore and inserts one pending score per succeeded output, ignoring conflicts. No generation task is created, so the model receives zero calls, which per-run call counters on the mock model prove.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Scores table keyed (output, scorer version) | Re-score is an insert; old judgments kept for audit; version match is checkable | A join on every aggregate; one row per output per scorer version |
| ❌ Score column on the result row | Simple reads | Re-scoring means regenerating, or overwriting history so old comparisons silently change meaning |

> "Outputs are expensive facts: model calls, money and time. Scores are cheap judgments that change whenever someone fixes a regex or tightens a rubric. In the seeded data, the JSON-shape scorer v1 can't parse fenced output and scores the orders run 0.000. Version 2 strips fences, and the same stored outputs score 0.806, with zero generations."

---

## 📊 Statistics (~3 min)

1. **Per-case value** = the mean score over the case's scored samples. A case with no scored sample is excluded and counted; a case with some errored samples is included and flagged partial.
2. **Run mean** = the mean of per-case values. The **95% interval** is Student-t on per-case values (t at 0.975 with n−1 degrees of freedom, times s/√n), plus a percentile bootstrap over cases: 2,000 resamples, seeded, so the same rows always give the same interval.
3. **Flaky cases** have per-case variance above zero, or samples that disagree on pass/fail.
4. **Paired comparison** on the same dataset version: for each case scored in both runs, take dᵢ = mean_B(i) − mean_A(i). Report the mean difference, a paired t-interval, a bootstrap interval, and wins/losses/ties. Verdict: improvement if the interval is above zero, regression if below, not significant if it crosses zero.
5. **Welch's unpaired test** is used only when the dataset versions differ, over cases whose content hash is identical in both, and is labelled "indicative only".
6. **Excluded on both sides.** A case errored or unscored in either run is dropped from both, and counted. Above 10% excluded, the comparison is no longer claimable.

> "Real numbers from the seed: Triage v1 → v2, one factor changed (the prompt), Label contains v1, paired Δ +0.218 with a 95% interval of [+0.064, +0.373], 9 wins, 2 losses and 11 ties over 22 paired cases, and 1 of 23 excluded from both sides. That's an improvement I'm willing to put my name on, and the win/loss/tie column shows two cases got worse, which the mean alone hides."

---

## 🔧 Deep Dives (~10 min)

### Deep dive 1: A PostgreSQL SKIP LOCKED queue, not RabbitMQ

**Decision.** The case_results rows are the queue. Workers claim with FOR UPDATE SKIP LOCKED in one short transaction; there's no broker.

**Why it works here.** This queue has three requirements that a FIFO broker doesn't model. First, a per-run concurrency limit, because the provider is shared and one run mustn't take every slot. Second, fairness between runs, so a 50-task run from one team doesn't wait behind a 100k-task run from another. Third, a cancel that discards queued work instantly. With rows, all three are a WHERE clause and an ORDER BY: count live leases, serve the least recently served run, skip runs that aren't active. Fan-out is the same transaction as the run insert, so there's no dual write. Retries with backoff are just available_at in the future, with no delayed-message plugin. Crash recovery is lease expiry, the same predicate as "claimable". And the queue state is queryable: progress bars, live leases and "oldest due task" are aggregate queries over the same rows.

**Why the alternative fails.** With one message per task in RabbitMQ, a worker that pulls a message for a run already at its limit has two bad options. It can requeue it, which hot-loops the message around the broker while it burns CPU, or it can park it somewhere else, which is a second queue I now have to manage. Fairness needs a queue per run plus a dispatcher that round-robins between them, which means 20,000 queues a day created and torn down. Cancelling a 100k-task run leaves 100k messages that every consumer must pull, look up and discard, so model calls for other runs wait behind garbage. Fan-out needs an outbox table and a relay process, or a crash between "run committed" and "messages published" leaves a run that never starts. And unacked redelivery still needs a dedup step at the database, so the broker doesn't remove the row-level bookkeeping — it adds a second system next to it.

**What I give up.** Throughput ceiling and isolation. Every claim, heartbeat and result is a write on the primary, so the queue competes with the API for the same database, and claim throughput tops out at a few thousand per second per primary. Locally a claim transaction takes 1-3 ms with two workers, but the run-picking query does a partial-index probe per active run, so its cost grows with the number of active runs. I accept this because model calls take seconds: 2,000 claims/s keeps ~20,000 calls in flight, more than most provider quotas. When it isn't enough, the path is batch claims, then a separate queue database, then sharding by run_id. Runs are independent, so only fairness becomes per shard. Switching to a broker isn't on that path.

### Deep dive 2: Leases and fencing tokens, not broker redelivery

**Decision.** A claim writes a lease owner, a random lease token and an expiry computed on the database clock. The worker heartbeats every third of the lease. Every later write is fenced: it matches only if the row is still running under that token. An expired lease makes the task claimable again.

**Why it works here.** One mechanism covers three failures. A crashed worker stops heartbeating; its lease expires and the next claim takes the task over, marking the old attempt lease_expired. A stalled worker — a GC pause, a laptop sleep — comes back holding a result, and its fenced write matches zero rows. It marks its attempt superseded and discards the result, so the new owner's result stands. A duplicate completion can't add a row, because there is one row per (run, case, sample), and score inserts ignore conflicts on (output, scorer version). All deadlines use the database clock, so there's exactly one clock in the system. That matters because a Docker VM's clock lags the host after a sleep.

**Why the alternative fails.** Broker redelivery answers "did the consumer disconnect?", not "does this worker still own the task?". A consumer that stalls with its connection open keeps the message until the ack timeout fires. Then the message goes to a second worker, and the first one, when it wakes, still writes its result: the broker has no way to tell the database the first worker lost ownership. With an SQS-style visibility timeout it's the same race. Two workers both believe they own the task, and whichever writes last wins — possibly the stale one, overwriting a newer result. Dedup by task key keeps one row but doesn't decide which row is right. To fix that I'd add an ownership token checked at write time, which is exactly the fence, now on top of the broker.

**What I give up.** Recovery takes a full lease. I can't tell slow from dead faster than the lease, so a dead worker's tasks wait up to ~2 minutes in production (seconds locally). A shorter lease means more heartbeat writes and more false expirations on slow-but-alive calls. A worker that stalls past its lease wastes its model call, and the task pays for a second one: that's quota and money, bounded by the reclaim rate I alert on (above 1% of claims). And heartbeats are one more write per task every lease/3 on the primary, which feeds back into deep dive 1's ceiling.

### Deep dive 3: The case is the unit of analysis — paired, not pooled

**Decision.** Intervals are computed over per-case means, not samples, and comparisons on the same dataset version are paired by case.

**Why it works here.** Samples of one case share an input and a reference, so they're correlated: an easy case scores 1 on every sample, a hard one 0 on every sample. Averaging per case first gives n independent observations, where n is the number of cases. More samples then narrow the interval only by shrinking per-case noise, which is the honest behaviour. On the same pins, ×1 gives ± 0.130, ×5 gives ± 0.031, ×10 gives ± 0.020. Pairing removes case difficulty from the noise. dᵢ subtracts each case from itself, so the spread between easy and hard cases cancels and only the change remains. That's how the Triage v1 → v2 comparison gets a clean [+0.064, +0.373] on 22 cases.

**Why the alternatives fail.** Pooling 5 samples × 22 cases as 110 independent observations makes every interval about √5 too narrow, and turns sampling noise into "significant" improvements that vanish on the next run. Comparing two run means without pairing leaves the between-case spread in the noise, and it swamps a real, consistent gain. In a unit test, B is exactly 0.05 better on each of 8 cases of wildly different difficulty. The paired test calls it; Welch's unpaired test can't. And comparing two single-sample runs at temperature 0.7 is comparing two draws: in the A/A check, same pins twice, the run means still differ, by noise alone, which is why its expected verdict is "not significant".

**What I give up.** Pairing requires the same dataset version, so comparisons across versions fall back to an unpaired test over unchanged cases, labelled indicative only, and the UI has to explain why. Small datasets stay wide no matter how many samples: 20 cases can't give a tight interval, because samples don't shrink the spread between cases — only more cases do. And excluding errored cases from both sides shrinks n, which is why a 10% exclusion cap is a hard stop on claimability rather than a footnote.

---

## 🔑 The Key Question (~3 min)

**"The prompt, the dataset and the scoring function all changed. What information is required before a comparison can be called an improvement?"**

> "Nothing about that pair can be claimed. Three things moved, so no number isolates any of them. I don't try to rescue it statistically; I rebuild the comparison so exactly one thing differs."

1. **Same scorer version.** Re-score run A's stored outputs with the new scorer version: judge or regex calls, zero generations. Before trusting a changed scorer, check it against human labels on a sample, because a scorer change changes what "better" means. In the seed, the stricter judge rubric flips verdicts and also disagrees with reviewers on padded-but-correct answers.
2. **Same dataset version.** Re-run A's prompt version on the new dataset version. This one costs generations. Scores can move across dataset versions with no system change at all: in the seed, the same prompt and config score 0.890 on v1 and 0.973 on v2, and on the 17 unchanged shared cases the difference is exactly zero.
3. **One factor.** Prompt version or model config, not both. Both changed → "B is better, but the cause is unknown".
4. **Both runs finished**, errored cases retried or listed, at most 10% excluded, and excluded from both sides, never averaged on one side only.
5. **Several samples per case** (≥ 2, 5 by default) unless temperature is 0.
6. **A paired 95% interval on per-case differences that excludes zero**, with wins/losses/ties shown, because a mean can rise while one category of cases regresses.

The comparison service classifies the pins before it computes anything:

| Situation | Mode | Verdict |
|-----------|------|---------|
| Different datasets | Not comparable | Blocked |
| Same dataset, different versions | Unpaired over unchanged shared cases | Indicative only, never claimable |
| No scorer version fully scored on both | Not comparable | Offer to re-score the run that lacks it |
| Prompt and model config both changed | Paired | Confounded: direction shown, cause unknown |
| Nothing changed / seed only | Paired | A/A noise check; expect not significant |
| A run unfinished, or one sample at temperature > 0 | Paired | Shown, not claimable |

The UI shows all six requirements with a check or a cross, and the word "improvement" appears only when all six hold.

---

## 🪤 Traps I'm Deliberately Avoiding

| Trap | Why it's wrong | What the design does |
|------|----------------|----------------------|
| Comparing the averages of two single runs | Two draws at temperature > 0 differ by noise; no interval, no pairing | Several samples, per-case means, a paired interval, A/A runs to calibrate |
| Silently averaging only surviving cases | Errored cases are often the hard ones; dropping them on one side manufactures an improvement | "Completed, N errored"; errored count next to every aggregate; exclusion on both sides; > 10% blocks the claim |
| Comparing runs whose dataset or scorer versions differ | The ruler or the test changed, not the system | Provenance classification first: block, re-score, or label indicative only |

---

## 📜 Execution Traces (~4 min)

### Successful trace: "Triage v2", 23 cases × 3 samples, limit 4

1. **Browser** sends the create request with the form's Idempotency-Key. **API-1** validates the pins and template variables, then in one transaction inserts the run (queued), 3 run_scorers rows and 69 case_results rows, and notifies eval_tasks.
2. **Both workers** wake. **Worker-1** locks the run row with SKIP LOCKED, re-counts 0 live leases (under 4) and claims case t-001, sample 0. The run becomes running. **Worker-2** finds the row locked, retries ~10 ms later and claims the next task. Claims continue until 4 leases are live, then stop for this run.
3. **Worker-1** renders the template and calls the model with seed 29,000. First token arrives after 230 ms; the done event with usage after 245 ms.
4. **Worker-1** computes the exact, contains and regex scores in memory. Then one transaction: the fenced update to succeeded with output, tokens and timings; the attempt row marked succeeded; 3 score rows. Finalize is a no-op, because tasks remain.
5. **Run page** polls the run every 1.5 s: progress, live leases 4/4, aggregates filling in.
6. **Case t-023**, a long log, returns 400 context_length_exceeded on each of its 3 samples. It's classified permanent and written errored after one attempt each, with no retries burnt.
7. **Whichever worker writes the last task** calls finalize. Nothing is pending, so the run becomes completed. The page shows "completed, 3 errored" and Exact label 0.955 ± 0.050, "3 errored (1 case) excluded".

### Failed trace: throttling, a broken stream, a killed worker and a stalled one

1. **Worker-2** claims t-005/1. The provider answers 429 with Retry-After: 1. It's classified rate_limited, and with round_attempts 1 < 4 a fenced update sets it pending with available_at = now + 1,000 ms. The attempt row records retry_scheduled, 429, delay 1,000.
2. **Worker-1** claims t-009/1. The stream drops after half the tokens. stream_disconnected is transient: the partial text is discarded and a retry is scheduled ~300 ms out.
3. **Worker-1 is SIGKILLed** while holding 6 leases. Its sockets close, so the provider stops those generations. Nothing else happens yet: the rows stay running until their leases expire.
4. **Lease expiry passes.** Worker-2's next claims match "running with an expired lease" for those 6 tasks. Each claim increments attempts to 2, marks attempt 1 lease_expired and re-runs the call. The unique (run, case, sample) key means there is still exactly one row per task, and the score inserts ignore conflicts.
5. **Had worker-1 only been frozen** (a laptop sleep) and woken holding a result, its fenced write would match zero rows. It marks its attempt superseded and moves on; the new owner's result stands.
6. **The run completes.** The attempts panel shows #1 lease_expired on worker-1 and #2 succeeded on worker-2. The live e2e runs exactly this on a 46-task run: 6 expired leases, 46/46 rows, no duplicate scores, completed 7 s after the kill.

---

## ✅ Design Review Checklist (~2 min)

| # | Question | Answer |
|---|----------|--------|
| 1 | Source of truth; when is a write successful? | PostgreSQL. A run exists when its creation transaction — the run and every task — commits. An output exists when its fenced update commits together with its inline scores. Aggregates are derived on read, never stored as truth. Valkey holds only sessions |
| 2 | Client retries after losing the response? | Creation is keyed by Idempotency-Key plus a request hash: replay → same run (200); different body → 422. Cancel, retry-errored and re-score are idempotent state changes, so a second call finds nothing to change. Annotation is an upsert |
| 3 | Worker or server fails between two steps? | Between claim and result: the lease expires and another worker re-claims; the unique key and fencing tokens prevent duplicates and stale overwrites. Between result and finalize: the sweeper finalizes. API crash mid-creation: the transaction rolls back and the client retries with the same key |
| 4 | Which ordering or consistency is required? | None across tasks: they're independent and run in any order. Per task, the lease token totally orders writers. Per run, status transitions are guarded updates with one winner. Comparisons need snapshot consistency only within one request |
| 5 | Access with caches, indexes, async jobs? | Every API query is scoped by the session's workspace, including those served from read replicas. Pins are checked against the workspace before the run is written. Workers take no user input: they act on rows whose ownership was checked when the run, re-score or label was created, so they never decide access. No result cache exists to go stale |
| 6 | What breaks first at scale, and evidence? | The claim path on the primary: ~5-6 row writes per task (claim, attempt, heartbeat, result, scores), ~12k row writes/s at 2,000 tasks/s, plus a run-picking query whose cost grows with active runs. Evidence: 1-3 ms claims locally with two workers, and the query shape. Next, results pages recomputing aggregates over 100k-task runs |

---

## ❓ Follow-ups the Answer Must Handle

**A run ends with 5 errored tasks. What does the dashboard show?**
> "Completed, 5 errored. Every aggregate is over successful cases only, with the errored and excluded counts next to it, and 'retry errored' re-runs just those tasks in the same run. If nothing succeeded at all, the run is failed with the most common error code as the reason."

**Run B's single sample scores higher than run A's. Is B better?**
> "Not yet. One sample at temperature 0.7 is one draw. I'd need several samples per case and a paired interval on per-case differences that excludes zero. An A/A run on identical pins shows how big a pure-noise difference looks."

**The scorer had a bug. Do we regenerate every output?**
> "No. Create scorer v2 and re-score: one pending score per succeeded output, zero model calls, old scores kept. Then compare both runs on v2. The orders run went from 0.000 to 0.806 that way."

**A worker dies mid-call. Can a result be written twice?**
> "No. There's one row per (run, case, sample), the stale owner's write is fenced out, and score inserts ignore conflicts. The re-claim waits for lease expiry, and the attempts panel shows lease_expired then succeeded."

**A 100k-task run and a 50-task run start at the same moment. Does the small one wait?**
> "No. Claims round-robin across runs by last served time, so they alternate, and the big run's concurrency limit caps its share of the provider. In production I'd add a per-workspace token bucket so one team's many runs can't add up past its quota."

**Someone cancels a run with 40 calls in flight. How fast does spend stop?**
> "One transaction cancels the run and its pending work and sends a NOTIFY. Workers abort those calls' connections within milliseconds — 15-20 ms locally — and a one-second poll plus the sweeper cover a lost notification."

**The provider halves its rate limit mid-run.**
> "Calls start getting 429s. They retry after max(Retry-After, full-jitter backoff), up to 4 attempts per round, and the attempt history shows retry_scheduled with the delay. If a round runs out of attempts, those tasks end errored and can be re-run later with 'retry errored'; they are never averaged away."

**How do you know the judge is trustworthy?**
> "Humans label a review queue: low-confidence judge scores, cases whose samples disagree, and a stable 1-in-8 spot check. Agreement and Cohen's κ are reported per judge version, split by source. Only the spot-check figure estimates trust in the judge, because items picked *because* the judge was unsure are biased low."

---

## 🚨 Failure Handling (~1 min)

| Failure | Detection | Handling |
|---------|-----------|----------|
| Provider 429 / overload / 5xx / hang | Status or client deadline | Full-jitter retry, Retry-After honoured, ≤ 4 attempts per round |
| Stream breaks mid-generation | No done event | Retried; partial output discarded |
| Input too long | 400 | Errored once, excluded and counted |
| Worker crash / stall | Lease expiry / fenced write matches 0 rows | Re-claimed; old attempt lease_expired or superseded |
| Judge down | Same classification | Score rows retry independently of outputs |
| Finalizer missed / NOTIFY lost | Sweeper / 1 s poll | Run finalized; cancel lands within ~1 s |
| A scorer throws on one output | Exception in inline scoring | Output saved; score left pending for a re-score |
| Valkey down | Session lookups fail | Users signed out; runs and workers unaffected |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **The claim path on the primary.** First, batch claims (k tasks of one run per transaction) and longer heartbeat intervals, cutting claim writes by k. Replace "count live leases" with a small active-runs table whose in-flight counter claims and finishes maintain, so picking a run no longer scans every active run.
2. **Split the queue from the catalog.** Put case_results and scores on their own PostgreSQL cluster, and serve the catalog and results UI from read replicas.
3. **Shard the queue by run_id.** Runs are independent, so each shard runs the same claim logic. Fairness becomes per shard, plus a global per-workspace token bucket for provider quota.
4. **Materialize aggregates** per (run, scorer version) when a run finalizes or a re-score completes, keeping the on-read path for audits. On-read is fine up to ~10k tasks per run.
5. **Move outputs to object storage** above a size threshold, keeping a hash and a preview in the row. At ~100 GB/day, outputs dominate storage.
6. **Partition** case_results, case_attempts and scores by run creation month; old runs become read-only partitions.

> "Through all of this, the provider stays the true bottleneck. Per-run limits and per-workspace quotas decide who gets the scarce calls, and the queue's only job is to keep those slots full without losing, duplicating or misattributing a result."

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Work queue | ✅ PostgreSQL rows + SKIP LOCKED | ❌ RabbitMQ | Limits, fairness and cancel are SQL predicates; fan-out in one txn, no outbox |
| Crash recovery | ✅ Leases + fencing tokens | ❌ Broker redelivery + dedup | One mechanism for crash, stall and duplicate writes |
| Fairness | ✅ Round robin by last_claimed_at | ❌ FIFO | Small runs aren't stuck behind 100k-task runs |
| Retry policy | ✅ Transient vs permanent, full jitter, Retry-After | ❌ Retry everything | No quota burnt on overflow; no false regressions from 429s |
| Partial failure | ✅ "Completed, N errored", excluded from both sides | ❌ Drop silently or score 0 | Survivorship and failures both distort means |
| Retry errored | ✅ Reopen the run | ❌ Child run | One result set per pin set |
| Scores | ✅ Separate table per scorer version | ❌ Column on the result | Re-score without regenerating; old scores kept |
| Unit of analysis | ✅ Per-case means, t + bootstrap | ❌ Pooled samples | Samples of a case are correlated |
| Comparison | ✅ Paired by case | ❌ Difference of run means | Removes case difficulty from the noise |
| Versions | ✅ Immutable rows + trigger | ❌ Mutable with history | Pins can't drift, enforced by the database |
| Aggregates | ✅ Computed on read | ❌ Materialized | Always consistent with rows; materialize past ~10k tasks |
| Cancel delivery | ✅ NOTIFY + 1 s poll + sweeper | ❌ Poll only | ~20 ms typical, bounded at ~1 s |

---

## 📝 Wrap-up (~1 min)

> "To summarize: every input is an immutable version, and a run pins them all. Creation fans out every case × sample task in the same transaction as the run, keyed by an idempotency key. The task table is the queue. Claims lock one run with SKIP LOCKED, take turns round robin, and re-count leases after the lock so the limit is exact. Leases, fencing tokens and the database clock make crashes and stalls harmless. Failures are classified, so transient ones retry with jitter and permanent ones are counted, never averaged away. Scores live apart from outputs, so fixing a scorer costs zero generations. And the analysis treats the case as the unit, pairs by case, and calls something an improvement only when one factor changed, the versions match, and the paired interval clears zero."

### How the local implementation compares

| Production design | Local build |
|-------------------|-------------|
| Real model providers and a judge model | Deterministic mock model and mock judge with armed-count chaos (429, overload, timeout, disconnect) and per-run call counters |
| Queue cluster, replicas, shards | One PostgreSQL 16 for catalog, queue and results; 2 API processes, 2 workers × 8 slots |
| Leases of minutes | Leases of seconds, so crash recovery fits in a test |
| Per-workspace quotas, batch claims, materialized aggregates | Per-run limits only; single-task claims; aggregates on read |
| Verified by | A PostgreSQL race test (10 claimers never exceed a limit of 3 or share a task; stale writes match 0 rows; finalize wins once) and a live e2e (SIGKILL → 6 expired leases, 46/46 rows, paired comparison recomputed from raw rows to 1e-4) |
