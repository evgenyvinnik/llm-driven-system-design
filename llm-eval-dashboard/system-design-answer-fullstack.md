# LLM Eval Dashboard — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Data and API → Execution → Statistics → UI → Key question → Deep dives → Traces → Scale*

> "An eval dashboard exists to answer one question for a team that ships prompts: is this change actually better? Executing the calls is the easy half. The hard half is making the number mean something. Three things go wrong in practice: people compare the averages of two single runs, a run quietly averages only the cases that survived a provider outage, and runs are compared whose dataset or scorer changed underneath them. So I'll design the system so the data model makes those mistakes detectable, the backend refuses to call them improvements, and the UI shows what changed before it shows by how much. I'll reuse the prompt playground's model: immutable prompt versions and model configs that a run pins. An eval run adds a dataset version, scorer versions and a sample count, and fans out into case × sample tasks."

| Phase | Time | Focus |
|-------|------|-------|
| Requirements | ~5 min | Users, entities, scale, what "correct" means |
| Architecture, data, API | ~8 min | Immutable versions, runs, the queue, scores |
| Execution | ~7 min | Fan-out, claims, retries, cancel, "N errored" |
| Statistics and UI | ~8 min | Intervals over cases, paired comparison, the pages |
| Key question | ~3 min | What has to hold before "improvement" |
| Deep dives | ~9 min | Queue in PostgreSQL; provenance before the number; re-scoring |
| Traces, checklist, scale | ~5 min | One success, one failure, what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who uses it? | Two audiences for one number | Prompt engineers run evals; reviewers open a comparison from a pull request |
| How big is a run? | Queue design, page design | 500 cases × 5 samples = 2,500 tasks typical, 100k max |
| What is scarce? | What to protect | Provider rate limits and money, not our CPUs |
| How are outputs judged? | Scorer model | Exact match, regex, contains, JSON shape, a model judge with a rubric, humans |
| Are outputs deterministic? | Statistics | No: temperature > 0, so several samples per case |
| Multi-tenant? | Access | Workspaces; alice and carol share one, bob is in another |

### Functional requirements

1. **Datasets** with immutable versions of test cases (input variables, reference, tags); an edit creates a new version, with a case-level diff.
2. **Prompt versions** and **model configs** (model, temperature, max tokens, seed), as in the playground; **scorer versions** of six kinds.
3. **Eval runs** pin a dataset version, prompt version, model config, scorer versions, a sample count and a concurrency limit. Created idempotently; lifecycle `queued → running → completed | cancelled | failed`.
4. **Execution** with retries for transient errors, recorded permanent errors, "retry errored cases", cancel that stops model calls, and recovery from worker crashes with no duplicates.
5. **Results**: mean with a 95% interval per scorer, the errored count next to every aggregate, flaky cases, every output and score inspectable, usage per task.
6. **Comparisons** paired by case, with every pin side by side and flags for mixed versions and confounded changes.
7. **Re-scoring** stored outputs with a new scorer version; **human annotation** with judge-versus-human agreement.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Fan-out of a 100k-task run | One transaction, p99 < 2 s |
| Cancel → model calls stop | < 2 s |
| Worker crash | Its tasks resume within one lease; zero duplicate results |
| Run page | p95 < 300 ms for 10k tasks; progress at most ~2 s old |
| Correctness | No aggregate silently drops a case; no comparison across scorer versions |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Runs | 20k/day | 2,000 teams × ~10 runs |
| Tasks | 50M/day, ~2,000/s at peak | 2,500 tasks per run |
| Calls in flight | ~20k | 2,000/s × ~10 s per call; capped by provider limits |
| Outputs | ~100 GB/day | 2 KB each; scores are ~10× smaller |

> "The provider is the bottleneck, not us. That shapes the queue: per-run limits and fairness decide who gets the scarce calls, and 2,000 claims a second is well within a single PostgreSQL primary for single-row claims."

---

## 🏗️ Architecture (~4 min)

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ React dashboard: runs · run detail · compare · datasets · prompts   │
 │ · scorers · annotation   (polls run state every 1.5-3 s)            │
 └──────────────────────────────────┬──────────────────────────────────┘
                                    │ session cookie
                        ┌───────────▼───────────┐
                        │ API (stateless, ×N)   │── validate, pin, fan out, compare
                        └───────────┬───────────┘
                                    │ one txn: run + all tasks, NOTIFY
 ┌──────────────────────────────────▼──────────────────────────────────┐
 │ PostgreSQL (source of truth)                                        │
 │ immutable: dataset_versions/cases · prompt_versions · model_configs │
 │            · scorer_versions                                        │
 │ eval_runs · case_results (= the work queue) · case_attempts         │
 │ scores (output × scorer version) · annotations                      │
 └───────▲───────────────────────────────────────────────┬─────────────┘
         │ claim (SKIP LOCKED) · heartbeat · fenced write │ LISTEN tasks/cancel
 ┌───────┴───────────────────────────────────────────────▼─────────────┐
 │ Eval workers (×N, M slots each): claim → call → classify → write    │
 └───────┬──────────────────────────────────────┬──────────────────────┘
         │ streamed completions                 │ rubric grading
 ┌───────▼────────┐                     ┌───────▼────────┐
 │ Model provider │                     │ Judge model    │
 └────────────────┘                     └────────────────┘
```

> "There's no message broker. The tasks are rows that exist from the moment the run is created; claiming, leasing, retrying and storing the result are updates to the same row. I'll defend that in deep dive 1."

---

## 💾 Data Model and API (~4 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| dataset_versions | dataset, version, case_count, content_hash | Immutable; a trigger rejects UPDATE and DELETE |
| dataset_cases | version, case_key, input (JSON), reference, tags, content_hash | case_key is identity across versions; the hash covers input, reference and tags |
| prompt_versions, model_configs, scorer_versions | version and its content/config | Immutable, same trigger; edits name a base version (409 if stale) |
| eval_runs | the four pins, samples, concurrency limit, status, retry round, idempotency key + request hash, last_claimed_at | Unique (workspace, user, key) |
| run_scorers | run, scorer version, origin (pinned or rescore) | Which judgments a run has |
| case_results | run, case, sample index, status, attempts, available_at, lease owner/token/expiry, output, tokens, queue/TTFT/generation ms, error | Unique (run, case, sample): the task and its result |
| case_attempts | result, attempt number, worker, outcome, error, delay | outcomes include retry_scheduled, lease_expired, superseded |
| scores | (result, scorer version) primary key, score 0-1, passed, confidence, rationale, lease | Judgments kept apart from facts |
| annotations | result, label, note, who | Feeds human scorers and agreement |

```
POST /runs                         Idempotency-Key required; 201 new · 200 replay · 422 key reused
GET  /runs · GET /runs/:id         status, progress, usage, one aggregate per scorer version
GET  /runs/:id/cases               every sample: output, usage, error, scores, label
POST /runs/:id/cancel              stops queued work and in-flight calls
POST /runs/:id/retry-errored       re-queues only errored tasks
POST /runs/:id/rescore             {scorerVersionId}: scores stored outputs, no generation
GET  /runs/:id/annotations         review queue + agreement · PUT .../annotations/:result
GET  /compare?a=&b=&scorer=        provenance, statistics, verdict, per-case differences
POST /datasets/:id/versions        {baseVersion, cases}: new version + diff · 409 stale
GET  /datasets/:id/diff?from=&to=  added / removed / modified fields / unchanged
```

---

## ⚙️ Execution (~7 min)

### Creating a run

1. Same key seen before → same request hash returns the existing run (`200`, `Idempotent-Replayed`); a different body returns `422`.
2. Validate that every pin belongs to the workspace, and that **every case has every variable the template uses**. A missing variable is a 422 now, not 2,500 errored tasks later.
3. One transaction inserts the run, its pinned scorers and one task row per (case, sample) with a generated series, then notifies workers. A run is never half fanned out.

### Claiming work fairly

Each claim is one short transaction:

1. Lock one runnable run row with `SKIP LOCKED`, ordered by the time it was last served. That ordering is round robin: a 50-task run alternates with a 100k-task run instead of waiting behind it, and concurrent claimers skip each other's runs.
2. In a fresh statement, count the run's live leases; claim one due task only if under the run's concurrency limit. Because every claimer of one run serializes on its row, the limit is exact.
3. Record the attempt. A task whose lease expired is claimable too; its previous attempt is marked `lease_expired`.

The worker heartbeats while the call runs, and **every write is fenced by the lease token**: a worker that stalled past its lease comes back to a write that matches zero rows. Retry delays are written as `now() + delay` on the database clock.

### Calling the model and classifying failures

| Failure | Classification | Action |
|---------|----------------|--------|
| 429 | rate limited | Retry after max(Retry-After, jittered backoff) |
| 529, 503, 5xx | overloaded / server error | Retry, full-jitter backoff |
| Client deadline | timeout | Retry |
| Stream ends without "done" | stream disconnected | Retry; partial text discarded |
| 400 context too long, other 4xx | permanent | Record as errored; never retry |

At most four attempts per round. Retrying a permanent error burns quota; giving up on a transient one turns provider weather into a fake regression.

### Finishing: "completed, N errored"

After each terminal write, one guarded update moves the run to `completed` (something succeeded) or `failed` (nothing did) once no task or score is pending; concurrent callers can't both win, and a sweeper catches runs whose last worker died first. A run with errored tasks is **completed, N errored**, and those tasks are excluded from every aggregate and counted next to it. **Retry errored** puts only the errored tasks back to pending, reopens the run with a retry round, and leaves successful tasks alone.

### Cancel

One transaction cancels the run and every pending task, then notifies `eval_cancel`. Workers abort the in-flight calls for that run, so the provider sees the disconnect and stops generating. A one-second poll and the sweeper cover a missed notification. Locally, in-flight calls stop about 20 ms after the cancel returns.

### Scoring

Deterministic scorers run inside the same transaction that saves the output. Judge scores are queued as rows and claimed like tasks. **Re-scoring** inserts one pending score per stored output for a new scorer version: no generation task exists, so the model gets zero calls, and older versions' scores stay.

---

## 📊 Statistics (~3 min)

> "The case is the unit, not the sample. Five samples of one case share an input and a reference, so they're correlated; pooling them as independent observations would make every interval about √5 too narrow."

1. **Per case**: mean over its scored samples. A case with no scored sample is excluded and counted; partial cases are flagged.
2. **Per run**: mean of case means, a Student-t 95% interval and a seeded bootstrap over cases. **Flaky** cases have variance across samples.
3. **More samples narrow the interval** by shrinking per-case noise: on identical pins, ±0.130 with one sample, ±0.031 with five, ±0.020 with ten.
4. **Paired comparison** on the same dataset version: per-case differences, their mean, a paired interval, wins, losses and ties. "Not significant" whenever the interval crosses zero. Pairing removes case difficulty from the noise: easy cases score 1 in both runs and stop drowning out a consistent gain.
5. Cases errored or unscored in **either** run are excluded from **both** sides and counted; over 10% excluded, the comparison stops being claimable.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Interval over per-case means, paired by case | Honest width; detects small consistent gains | Needs the same dataset version |
| ❌ Pool every sample | Narrow intervals | Wrong: samples of a case aren't independent |
| ❌ Difference of two run means | Simple | Case difficulty swamps the effect; no sense of noise |

---

## 🖥️ Frontend (~5 min)

| Page | What it shows |
|------|---------------|
| Runs list | Status chip ("completed, 5 errored"), progress bar, primary score ± half-width, "N errored excluded", pins |
| Run detail | Progress and usage tiles (calls, tokens, queue/TTFT/generation), one card per scorer version (mean, 95% CI bar, n of total cases, errored, flaky, "re-scored" badge), a same-pins table showing the interval narrowing with samples, a per-case table with filters (errored, flaky, failing) and drill-down to every sample's output, scores and attempts |
| Compare | Verdict card (paired Δ, CI on an axis with zero marked, win/loss/tie, excluded count); provenance panel with every pin side by side; the six-requirement checklist; per-case differences sorted by largest regression, outputs side by side |
| Datasets | Versions, case list, case-level diff, an editor that saves a new version against its base (409 on conflict) |
| Annotation | Queue of low-confidence and disagreeing outputs plus random spot checks; agreement split by source |

State by kind: server state is polled (1.5 s on a run page, paused when the tab is hidden); the comparison's run A, run B and scorer live in the URL, so a reviewer can paste a link; editor buffers are local and keep the base version they started from. The New Run form mints one `Idempotency-Key` per form, so a double click or a retry after a dropped response opens the same run.

> "The browser never computes a verdict. It renders the server's classification, so the claim on screen is the same claim the API, the tests and a CI gate would make."

---

## 🔑 The Key Question (~3 min)

**"The prompt, the dataset and the scoring function all changed. What information is required before a comparison can be called an improvement?"**

> "For that pair, nothing can be claimed: three things moved, and no number isolates any of them. To get a claim I rebuild the comparison so exactly one thing differs."

1. **Same scorer version.** Re-score run A's stored outputs with the new scorer. That's cheap, no generations. And validate the changed scorer against human labels first, because changing the scorer changes what "better" means.
2. **Same dataset version.** Re-run A's prompt on the new dataset version; this does cost generations. In the seed, the same prompt and config score 0.890 on v1 and 0.973 on v2, and on the 17 unchanged shared cases the difference is exactly zero: the "gain" was the dataset.
3. **Exactly one factor changed**: prompt version or model config.
4. **Both runs finished**, errored cases listed, at most 10% excluded, and excluded from both sides.
5. **Several samples per case** (≥ 2; 5 by default) unless temperature is 0.
6. **A paired 95% interval on per-case differences that excludes zero**, with win/loss/tie shown, because a mean can rise while a category regresses.

The compare page shows these six as a checklist with a tick or a cross, and the verdict reads "improvement" only when all six hold. Otherwise it reads "not significant", "indicative only", "can't be claimed yet", "cause unknown" or "scores not comparable", with a "re-score with vN" button when that's the fix.

---

## 🔧 Deep Dives (~9 min)

### Deep dive 1: The work queue lives in PostgreSQL, not RabbitMQ

**Decision.** The task rows are the queue: claimed with `FOR UPDATE SKIP LOCKED`, leased, fenced.

**Why it works here.** This queue needs three things a FIFO broker doesn't model: a per-run concurrency limit, fairness between runs, and a cancel that discards queued work. In SQL they're a lease count, an ORDER BY on last-served time, and a status filter. Fan-out is one transaction with the run, so a run and its tasks always exist together. Backoff is a future `available_at`. Crash recovery is lease expiry, and the same unique key that makes the row the result also makes duplicates impossible.

**How the alternative fails.** With RabbitMQ, a worker that pulls a task for a run already at its limit must requeue it (hot looping) or park it elsewhere. Fairness needs a queue per run plus a dispatcher. Cancelling a 100k-task run leaves 100k messages to drain and discard. Creating a run becomes a dual write, run in PostgreSQL and messages in the broker, so you need an outbox and a relay or you lose or duplicate tasks. And after a redelivery you still need the database to deduplicate.

**What we give up.** Throughput and isolation. Every claim, heartbeat and result is a write on the primary, about five or six row writes per task, competing with the API. That tops out in the low thousands of claims per second per primary. Model calls take seconds, so that supports tens of thousands of concurrent calls, which is more than most provider limits. Past that, I'd shard the queue by run before reaching for a broker.

### Deep dive 2: Provenance before the number

**Decision.** The server classifies every comparison from the two runs' pins before computing statistics, and the UI leads with that classification: what changed, what must match, the six requirements, then Δ.

**Why it works here.** The common failure isn't arithmetic, it's comparing the wrong things. Classifying first catches each trap: different dataset versions become an unpaired comparison over unchanged shared cases, labelled indicative only. Scorers without a common fully scored version are blocked as "not comparable", with the fix offered: re-score the run that lacks the newer version. Prompt and config both changed is flagged as confounded. Same pins is an A/A noise check. Because one tested function makes the call, the dashboard, the API and a future CI gate can't disagree.

**How the alternative fails.** A headline "Δ = +4.2%" over two run means invites every trap at once. It looks equally confident when B was scored with a fixed regex and A with the broken one, which in the seed moves the same outputs from 0.000 to 0.736. It looks the same when B ran on a dataset version whose relabelled cases are easier. And it looks the same when the interval crosses zero. Reviewers approve on the headline.

**What we give up.** Friction and screen space. Some comparisons people want are refused or demoted, and the page is denser than a single number. Re-scoring or re-running to satisfy the checklist costs time and sometimes money. I accept that: an eval tool whose "improvement" can't be trusted is worse than none.

### Deep dive 3: Scores live apart from outputs

**Decision.** Scores are rows keyed by (output, scorer version), not a column on the output.

**Why it works here.** Outputs are expensive facts: model calls, money, minutes. Scores are cheap judgments that change whenever someone fixes a regex or tightens a rubric. With a separate table, re-scoring is an insert over stored outputs, idempotent by primary key, with zero model calls. The e2e checks the mock model's call counter stays flat while 66 new scores appear. Old scores stay for audit, and "same scorer version" becomes a checkable fact. The seeded orders run scores 0.000 under the strict JSON parser and 0.806 when the fixed version re-scores the same outputs. The prompt was never the problem.

**How the alternative fails.** A score column forces one of two bad choices. Regenerate everything to re-score, which costs money and also changes the outputs, so you've confounded the scorer change with sampling noise. Or overwrite the score, so every past comparison silently changes meaning and the scorer-version check becomes impossible.

**What we give up.** More rows (one per output per scorer version), a join in every aggregate, and a second work type (judge scores) that needs its own leases and retries.

---

## 📜 Execution Traces (~4 min)

### Successful trace: Triage v2, 23 cases × 3 samples, limit 4

1. **Browser**: Alice submits the New Run form with its Idempotency-Key.
2. **API**: validates pins and template variables; one transaction inserts the run (queued), three scorer pins and 69 task rows; notifies workers.
3. **Workers**: wake; worker 1 locks the run row, sees 0 of 4 leases, claims case t-001 sample 0, and the run becomes running. Worker 2 finds the row locked, retries ~10 ms later, and claims the next task. Claims stop at 4 live leases.
4. **Worker 1**: renders the template, calls the model with seed 29,000, records time to first token and generation time, scores exact/contains/regex in memory, and in one transaction writes the fenced result, the attempt and three scores.
5. **Model**: the long-log case t-023 returns 400 context too long three times; each is written errored after one attempt.
6. **Browser**: the run page polls, showing progress, live leases 4/4, and cards filling in.
7. **Worker**: the last write's finalize finds nothing pending, so the run is completed. The page shows "completed, 3 errored" and Exact label 0.955 ± 0.052 with "3 errored (1 case) excluded".

### Failed trace: throttling, a broken stream and a dead worker

1. **Model**: answers worker 2 with 429, Retry-After 1. Worker 2 classifies it rate limited; with attempts left, its fenced write sets the task pending and due in one second; the attempt row records the 429 and the delay.
2. **Model**: drops worker 1's stream halfway through. That's transient: the partial text is discarded and the task is due again in a few hundred ms.
3. **Worker 1**: is killed with SIGKILL while holding six leases. Its sockets close and the provider stops those generations; the rows stay running until their leases lapse.
4. **Worker 2**: once the leases expire, its claims match those six tasks, bump them to attempt 2, mark attempt 1 lease_expired and re-run them. The unique (run, case, sample) key means still one row per task; score inserts are on-conflict-do-nothing.
5. **A stalled worker** (a laptop sleep, not a crash) that wakes holding a result would find its fenced write matching zero rows, mark the attempt superseded and drop it.
6. **Browser**: the attempts panel shows "#1 lease_expired · worker-1, #2 succeeded · worker-2". In the live e2e: six expired leases, 46/46 rows, no duplicate scores, completed seven seconds after the kill.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL. A run exists when the transaction holding it and all its tasks commits; an output exists when its fenced update commits with its inline scores. Aggregates are derived on read. |
| Client retries after losing the response? | Run creation replays by Idempotency-Key and request hash. Cancel, retry-errored and re-score find nothing left to change on a second call. Labels are upserts. The form reuses its key. |
| Failure between two steps? | Claimed but not finished: the lease expires and another worker re-claims; fencing and the unique key prevent stale or duplicate results. Written but not finalized: the sweeper finalizes. API crash mid-create: rollback, and the retry with the same key creates it once. |
| Ordering or consistency required? | None across tasks. Per task, the lease token orders writers. Per run, status changes are guarded updates with one winner. A comparison reads both runs in one request. |
| Access with async jobs and caches? | Every query filters by the session's workspace; foreign ids are 404. Workers take no user input: they act on rows whose ownership was checked when the run, re-score or label was created. |
| What breaks first at scale, and evidence? | The claim path on the primary: five or six row writes per task plus the run-picking scan; a claim averages 4-6 ms locally. Then results pages aggregating 100k-task runs on read. |

---

## 🪤 The Traps, and Where the Design Stops Them

| Trap | Stopped by |
|------|------------|
| Comparing the averages of two single runs | Several samples per case, intervals over cases, a paired test, "not significant" as a first-class verdict |
| Silently averaging only surviving cases | "completed, N errored", errored counts on every aggregate, exclusion from both sides, the 10% rule, retry errored |
| Comparing runs with different dataset or scorer versions | Immutable pinned versions, provenance classification, unpaired-and-indicative for mixed datasets, "not comparable" plus re-score for scorers |

---

## ❓ Follow-ups the Answer Must Handle

**"A worker dies mid-run. Can a case be counted twice?"**
> "No. The task row is the result and it's unique per (run, case, sample). A new worker re-claims it after the lease expires, and the old worker's late write is fenced out."

**"The provider throttles for ten minutes."**
> "Tasks back off with Retry-After and jitter, and the run's concurrency limit stops it from hammering. If attempts run out, those tasks end errored, the run says so, and retry errored picks them up later."

**"Why not just treat errored cases as zero?"**
> "Then a provider outage looks like a model regression. And dropping them on one side only creates survivorship bias, because the cases that error are often the hard ones."

**"Someone fixes the judge rubric. What happens to old runs?"**
> "Nothing changes in place. They re-score with the new version; old scores stay, and comparisons use the newest version both runs share. I'd also check the new rubric against human labels. In the seed, the stricter rubric disagrees with reviewers on padded but correct answers."

**"How do you know the judge is any good?"**
> "The annotation queue mixes low-confidence items with random spot checks, and agreement is reported separately for each. Agreement on items picked because the judge was unsure is biased low; the spot-check figure is the estimate."

**"Two people edit the same dataset."**
> "Each save names its base version; the second gets a 409 with their buffer intact. Versions are immutable, so nothing is lost."

**"How would this gate a pull request?"**
> "CI creates a run with a key derived from the commit, waits for it, and calls the compare endpoint against the main branch's baseline. It blocks on 'regression' and warns on anything not claimable. It's the same verdict function the UI uses."

---

## 🚨 Failure Handling (~1 min)

| Failure | Handling |
|---------|----------|
| 429 / overload / 5xx / timeout / broken stream | Classified transient, retried with full-jitter backoff ≤ 4 times, Retry-After honoured |
| Context too long / invalid | Errored once, shown, excluded, retryable on demand |
| Worker crash or stall | Lease expiry re-claim; fenced writes; attempt marked lease_expired or superseded |
| Judge down | Score rows retry on their own; outputs are unaffected |
| Missed notification | One-second poll for cancels; idle workers poll for work |
| Sessions store down | Users signed out; runs keep executing |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **The claim path** on the primary (writes per task, the per-run lease count). Batch claims of k tasks per transaction; keep an active-runs table with in-flight counters instead of counting leases.
2. **Queue and catalog on one database.** Move task and score tables to their own cluster; serve results and comparisons from replicas.
3. **One queue database.** Shard by run id. Runs are independent, so fairness becomes per shard, plus a per-workspace token bucket for provider quota.
4. **Aggregates on read for huge runs.** Materialize per (run, scorer version) on finalize and re-score.
5. **Output storage.** Large outputs to object storage, partitions by month for results, attempts and scores.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Work queue | PostgreSQL rows, SKIP LOCKED | RabbitMQ | Limits, fairness and cancel are predicates; no dual write |
| Crash recovery | Leases + fencing tokens | Redelivery + dedup | One mechanism for crash, stall and duplicate writes |
| Fairness | Round robin by last served | FIFO | Small runs don't wait behind big ones |
| Statistics | Per-case means, t + bootstrap | Pooled samples | Samples of a case are correlated |
| Comparison | Paired by case | Difference of means | Removes case difficulty from the noise |
| Mixed datasets | Unpaired over shared cases, indicative | Pair by key | Changed cases are different cases |
| Scores | Separate rows per scorer version | Column on the output | Re-score without regenerating |
| Errored cases | Excluded from both sides, counted | Zero or silent drop | Both distort the mean |
| Retry errored | Reopen the run | Child run | One result set per pin set |
| Versions | Immutable, trigger-enforced | Mutable with history | Pins can't drift |
| Live progress | Polling | SSE | Seconds-scale state, simpler pages |

---

## 📝 Wrap-up (~1 min)

> "The design rests on three separations. Immutable inputs are apart from runs, so a run always means the same thing. Tasks are apart from the brokers they'd usually need, so limits, fairness, cancel and crash recovery are row predicates. Judgments are apart from facts, so fixing a scorer costs a re-score, not a regeneration. On top of that, the statistics treat the case as the unit, and the comparison refuses to call anything an improvement until the dataset version, the scorer version, a single changed factor, finished runs, enough samples and a paired interval all line up. The UI's job is to say so plainly, before it shows the number."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Real providers and a judge model | Deterministic mock model and mock judge (separate processes) with chaos switches and per-run call counters |
| Sharded queue, replicas | One PostgreSQL 16; two API instances; two workers × 8 slots |
| SSO, roles | Session auth, one workspace per user |
| Materialized aggregates | Computed on read; the e2e recomputes a paired comparison from raw rows and matches the API |
| Measured | 85 live e2e checks: idempotent create, retries by kind, "N errored" + retry errored, cancel in ~20 ms, SIGKILL recovery, re-score with zero model calls, provenance flags, intervals narrowing with samples, isolation |
