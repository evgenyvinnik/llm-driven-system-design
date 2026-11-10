# LLM Eval Dashboard - Architecture

## System Overview

An eval dashboard answers one question for a team that ships prompts: **is this change actually better?** Developers keep versioned test datasets, prompt versions and model configurations, start asynchronous evaluation runs that execute every test case several times against a model, score the outputs with versioned scorers (exact match, regex, contains, JSON shape, a model-graded judge, humans), and compare runs.

The data model extends the [prompt playground](../prompt-playground/architecture.md): `prompt_version` and `model_config` are immutable, and a run pins them. An eval run adds a dataset version, scorer versions and a sample count, and fans out into case × sample tasks.

The hard part is not executing calls; it is making the numbers mean something:

- **Provenance.** A comparison is only meaningful when the dataset version and scorer version match and one factor changed. The system classifies every comparison and refuses to call a confounded or mixed one an improvement.
- **Partial failures.** Tasks fail transiently (429, overload, timeouts, broken streams) and permanently (context overflow). A run ends as "completed, N errored", with every aggregate computed over successful cases only and the errored count shown next to it.
- **Nondeterminism.** Outputs vary between samples. Runs report a confidence interval over cases, comparisons are paired by case, and the verdict is "not significant" whenever the interval crosses zero.
- **Re-scoring.** Fixing a scorer must not require generating again: scores live apart from outputs, keyed by (output, scorer version).

**The key question**, answered in [Provenance and the improvement claim](#9-provenance-and-the-improvement-claim): *the prompt, the dataset and the scoring function all changed; what information is required before a comparison can be called an improvement?*

**Learning goals:** a PostgreSQL `SKIP LOCKED` work queue with leases, fencing and per-tenant fairness; idempotent fan-out; retry classification; paired statistics; provenance as a first-class check; immutable versioning; re-scoring by separating facts (outputs) from judgments (scores).

## Requirements

### Functional Requirements

1. **Datasets** with immutable versions of test cases (input variables, reference output, tags). Editing creates a new version; a case-level diff shows added, removed and modified cases and which fields changed.
2. **Prompts** with immutable versions (system text and a `{{variable}}` template) and **model configs** (model, temperature, max tokens, seed), as in the playground.
3. **Scorers** with immutable versions: exact match, regex, contains, JSON shape, model-graded (judge model + rubric), human.
4. **Eval runs** pin a dataset version, prompt version, model config, ≥ 1 scorer versions, a sample count per case and a concurrency limit. Creation is idempotent (`Idempotency-Key`). Lifecycle: `queued → running → completed | cancelled | failed`.
5. **Execution** fans out case × sample tasks to workers, with a per-run concurrency limit and fairness between concurrent runs. Every task records attempts, output, usage (input/output tokens; queue, time-to-first-token and generation latency), status and error.
6. **Partial failures**: transient errors retry with backoff; permanent errors are recorded; "retry errored cases" re-runs only those; cancel stops new model calls within a second; a worker crash is recovered with no duplicate results.
7. **Results**: per-run mean with a 95% interval per scorer version, the errored count next to every aggregate, per-case variance across samples ("flaky cases"), every output and score inspectable.
8. **Comparisons**: paired by case on the same dataset version (mean difference, paired interval, win/loss/tie, verdict); every pinned version side by side; flags for mixed dataset versions, scorer-version mismatches and multi-factor changes.
9. **Re-scoring** an existing run's stored outputs with a new scorer version, keeping the old scores.
10. **Human annotation**: a per-run review queue, pass/fail labels with notes, judge-versus-human agreement.
11. **Workspaces**: users see only their workspace's datasets, prompts, scorers and runs.

### Non-Functional Requirements

| Property | Target (production) |
|----------|---------------------|
| Run creation (fan-out of 100k tasks) | p99 < 2 s, one transaction |
| Claim latency | p99 < 20 ms per task at 2,000 claims/s |
| Cancel → model calls stop | < 2 s fleet-wide |
| Crash recovery | A dead worker's tasks resume within one lease (≤ 2 min); zero duplicate results |
| Results page | p95 < 300 ms for a 10k-task run (aggregates precomputed beyond that) |
| Correctness | No aggregate silently drops a case; no comparison across scorer versions |
| Availability | 99.9% for the API; runs survive any single process failure |
| Retention | Runs, outputs and scores kept indefinitely (they are the audit trail of every claim) |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Teams / workspaces | 2,000 | Internal platform at a large company or a SaaS |
| Runs per day | 20,000 | Each team runs ~10 a day in CI and by hand |
| Tasks per run | 500 cases × 5 samples = 2,500 typical; 100k max | |
| Tasks per day | 50M | 20k × 2,500 |
| Peak claim rate | ~2,000/s | 50M/day ≈ 600/s average, 3× peak in working hours |
| Model calls in flight | ~20,000 | 2,000/s × ~10 s per call; bounded by provider rate limits, not by us |
| Output storage | 50M × 2 KB ≈ 100 GB/day | Outputs dominate; inputs are referenced, not copied |
| Score rows | 50M × 2 scorers × 100 B ≈ 10 GB/day | |
| Judge calls | ~30% of scores are model-graded | Judge capacity is a second rate-limited resource |

The model provider, not our infrastructure, is the scarce resource: per-run concurrency limits and per-workspace quotas exist to share it, and a claim rate of 2,000/s is comfortably within one PostgreSQL primary's reach for single-row `SKIP LOCKED` claims with partial indexes.

### Local Development Scale

| Component | Local size |
|-----------|------------|
| Datasets | 4 (12-24 cases each) |
| Runs | 15 seeded + those you start; ≤ 230 tasks each |
| Workers | 2 processes × 8 slots |
| Throughput | ~30 tasks/s with the mock's default latency |
| Database | One PostgreSQL 16 container, a few MB |

## High-Level Architecture

```
                ┌──────────────────────────────────────────────────────────────┐
                │ Browser: React dashboard (runs, run detail, compare,         │
                │ datasets, prompts, scorers, annotation)                      │
                └──────────────────────────────┬───────────────────────────────┘
                                               │ HTTPS, session cookie
                                     ┌─────────▼──────────┐
                                     │ API gateway / LB   │
                                     └─────────┬──────────┘
                     ┌─────────────────────────┼─────────────────────────┐
             ┌───────▼───────┐         ┌───────▼───────┐         ┌───────▼───────┐
             │ API service   │         │ API service   │   ...   │ API service   │   stateless
             └───────┬───────┘         └───────┬───────┘         └───────┬───────┘
                     │ writes: run + fan-out in one txn, NOTIFY           │ reads: results, compare
                     ▼                                                    ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │ PostgreSQL primary (source of truth)                                                │
   │  datasets ─ dataset_versions ─ dataset_cases      (immutable)                       │
   │  prompts ─ prompt_versions · model_configs        (immutable)                       │
   │  scorers ─ scorer_versions                        (immutable)                       │
   │  eval_runs ─ run_scorers                                                            │
   │  case_results  ◀── work queue: FOR UPDATE SKIP LOCKED, leases, fencing tokens        │
   │  case_attempts · scores (case_result × scorer_version) · annotations                │
   └───────────▲──────────────────────────────▲─────────────────────────┬────────────────┘
               │ claim / heartbeat / fenced    │ read replicas           │ LISTEN eval_tasks,
               │ write                         │ (results, compare)      │ eval_cancel
   ┌───────────┴─────────────────────────────────────────────────────────▼───────────────┐
   │ Eval workers (N processes × M slots): claim → render → call → classify → write       │
   │ → score inline (deterministic) or queue (judge) → finalize run                       │
   └───────────┬───────────────────────────────────────┬──────────────────────────────────┘
               │ streaming completions (SSE)            │ judge calls (JSON)
     ┌─────────▼─────────┐                    ┌─────────▼─────────┐
     │ Model provider(s) │                    │ Judge model       │
     │ rate limits, 429s │                    │ (separate quota)  │
     └───────────────────┘                    └───────────────────┘
   Sweeper (any worker holding an advisory lock): finalize stragglers, clean up cancelled runs
   Valkey: sessions, login rate limit (never a source of truth)
```

There is **no message broker**: the `case_results` table is the queue. Every task is a row that exists from the moment the run is created; claiming it, leasing it, retrying it and storing its result are updates to that row. See [Key Design Decisions](#1-postgresql-skip-locked-queue-not-rabbitmq).

## Core Components

### 1. Versioned, immutable inputs

Every input a run depends on is an immutable version:

- `dataset_versions` + `dataset_cases`: one row per (version, case). A case keeps its `case_key` across versions; `content_hash` = SHA-256 of canonical JSON of (input, reference, sorted tags). The version's `content_hash` hashes its case hashes in key order.
- `prompt_versions`: system text, template, extracted variables.
- `model_configs`: model, temperature, max tokens, seed. Immutable rows; "editing" creates a new named config.
- `scorer_versions`: kind-specific config (`{caseSensitive}`, `{pattern, flags}`, `{requiredKeys, stripFences}`, `{rubric, strictness, passGrade}`).

A PostgreSQL trigger (`forbid_mutation`) rejects `UPDATE` and `DELETE` on all five tables, so immutability doesn't depend on every code path behaving. A new version names its base (`baseVersion`); the head moves only if the base is still the head, otherwise `409 VERSION_CONFLICT` (optimistic concurrency, as for playground presets). Identical content is rejected (`422 NO_CHANGES`). The editors capture the base version when editing starts, not at save time: a background refresh that brings in a colleague's version must turn the save into a 409, not silently build on (and revert) their change.

**Diff** between versions is by `case_key`: added, removed, modified (with the changed fields: input, reference, tags) and an unchanged count. The diff is what tells a reviewer why two runs on different versions can't be paired.

### 2. Run creation: validate, pin, fan out, idempotently

`POST /api/v1/runs` with `Idempotency-Key`:

1. If `(workspace, user, key)` already exists: same request hash → `200` with the existing run and `Idempotent-Replayed: true`; different hash → `422 IDEMPOTENCY_KEY_REUSED`.
2. Validate pins belong to the workspace; **validate the template against every case** (a missing variable is `422 TEMPLATE_VARIABLES_MISSING`, not N errored tasks later); cap total tasks.
3. One transaction: insert `eval_runs` (`ON CONFLICT (workspace_id, created_by, idempotency_key) DO NOTHING`), `run_scorers` (origin `pinned`), and the fan-out:

```sql
INSERT INTO case_results (id, run_id, case_id, case_key, sample_index)
SELECT 'cr_' || substr(md5($run || ':' || c.id || ':' || s.i), 1, 20), $run, c.id, c.case_key, s.i
  FROM dataset_cases c CROSS JOIN generate_series(0, $samples - 1) AS s(i)
 WHERE c.dataset_version_id = $version;
SELECT pg_notify('eval_tasks', $run);
```

A run is never half fanned-out: either the run and all its tasks exist, or nothing does. Two concurrent requests with the same key serialize on the unique index; the loser's `ON CONFLICT` returns nothing and it answers with the winner's run.

### 3. The work queue: claim, lease, fence, fairness

A task is claimable when it is `pending` and due (`available_at <= now()`), or `running` with an expired lease (its worker died). A claim is one short transaction:

```sql
-- 1. Pick a run: least recently served first (round robin), skipping runs other claimers hold.
SELECT r.id, r.concurrency_limit FROM eval_runs r
 WHERE r.status IN ('queued','running')
   AND EXISTS (claimable task of r)
   AND (live leases of r) < r.concurrency_limit
 ORDER BY r.last_claimed_at NULLS FIRST, r.created_at
 LIMIT 1 FOR NO KEY UPDATE OF r SKIP LOCKED;
-- 2. Fresh statement (READ COMMITTED sees every committed claim): re-check the limit, take one task.
WITH task AS (SELECT c.id, c.status AS prior FROM case_results c
               WHERE c.run_id = $run AND (claimable) AND (live leases of $run) < $limit
               ORDER BY c.available_at, c.sample_index, c.case_key
               LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
UPDATE case_results c SET status = 'running', attempts = attempts + 1, round_attempts = round_attempts + 1,
       lease_owner = $worker, lease_token = $token, lease_expires_at = now() + $lease,
       queue_ms = now() - c.available_at
  FROM task WHERE c.id = task.id RETURNING ..., task.prior;
-- 3. Bookkeeping: run.last_claimed_at = clock_timestamp(); queued → running;
--    if prior = 'running', the previous attempt is marked lease_expired; insert the new attempt row.
```

- **Per-run concurrency limit, exactly.** All claimers of one run serialize on that run's row lock, and step 2 counts live leases in a new snapshot, so the limit can't be overshot by a race. A claimer that finds the run locked skips to another run; if every runnable run is momentarily locked it retries after 5-25 ms instead of idling.
- **Fairness.** `ORDER BY last_claimed_at` is round robin across runs: a 100k-task run and a 50-task run alternate claims, so the small run isn't stuck behind the big one. Per-run limits cap any one run's share of provider capacity; production adds per-workspace quotas the same way.
- **Order within a run.** Sample-major (`sample_index`, then case), so early results cover every case once before any case gets a second sample.
- **Leases and fencing.** A running task's worker heartbeats every `lease/3`. Every later write is `WHERE id = $1 AND lease_token = $2 AND status = 'running'`. A worker that stalls past its lease (a GC pause, a laptop sleep) and comes back finds zero rows and discards its result: the new owner's result stands. All deadlines use the database clock (`now() + interval`), never the host clock.

### 4. Executing a task and classifying failures

```
claim → render template with case input → POST /v1/generate (SSE) with seed = config.seed·1000 + sample
      → stream tokens: record TTFT at the first token, generation time to the done event
      → success: one txn = fenced UPDATE (output, usage) + attempt row + inline scores
      → failure: classify ─┬─ transient & attempts left → pending, available_at = now() + delay
                           └─ permanent or exhausted   → errored (code, message)
```

| Failure | Kind | Action |
|---------|------|--------|
| 429 | `rate_limited` | Retry after max(Retry-After, jittered backoff) |
| 529 / 503 | `overloaded` | Retry with backoff |
| 500-599 | `server_error` | Retry with backoff |
| Client deadline / 408 / 504 | `timeout` | Retry with backoff |
| Connection refused / reset before headers | `network` | Retry with backoff |
| Stream ends without `done`, or an `error` event | `stream_disconnected` / `stream_error` | Retry with backoff (partial output discarded) |
| 400 context overflow | `context_length_exceeded` | Record as errored; never retry |
| Other 4xx | `invalid_request`, `auth` | Record as errored; never retry |

Backoff is full jitter: attempt *n* waits `uniform(0, min(cap, base·2^(n−1)))`; at most `MAX_ATTEMPTS` (4) per retry round. Retrying a permanent error burns quota and delays the run for nothing; giving up on a transient one turns provider weather into a false regression.

### 5. Scoring: inline, queued, and re-scoring

Scores are a separate table keyed `(case_result_id, scorer_version_id)`.

- **Deterministic scorers** (exact, regex, contains, JSON shape) are computed by the worker and written in the same transaction as the output, so a finished output is scored atomically.
- **Model-graded scores** are inserted `pending` and claimed by workers like tasks (`FOR UPDATE SKIP LOCKED`, lease, fence, retry classification), calling the judge model with the rubric, output and reference. The judge returns a grade (1-5), pass/fail and a confidence.
- **Human** scores are written by annotations (component 10).
- **Re-scoring** `POST /runs/:id/rescore {scorerVersionId}` adds a `run_scorers` row (origin `rescore`) and inserts one `pending` score per *succeeded* output, `ON CONFLICT DO NOTHING` (idempotent). No generation task is created, so the model receives zero calls; existing scores, under other versions, are untouched. Re-scoring requires a finished run, so coverage is unambiguous.

This separation is what makes "fix the scorer, not the prompt" cheap. In the seeded data the JSON-shape scorer v1 can't parse fenced output and scores the orders run 0.000; v2 strips fences and the same stored outputs score 0.806.

### 6. Finalization and "completed, N errored"

After every terminal write, the worker runs one guarded statement:

```sql
UPDATE eval_runs SET status = CASE WHEN <any succeeded> THEN 'completed' ELSE 'failed' END, finished_at = now(), ...
 WHERE id = $1 AND status = 'running'
   AND NOT EXISTS (task pending/running) AND NOT EXISTS (score pending/running)
```

Many workers may call it at once; the status guard lets exactly one transition win. `failed` means nothing succeeded (e.g. a model whose context window fits no prompt); a run with some errored tasks is `completed` and the UI shows "completed, 5 errored". The sweeper repeats the check every few seconds for runs whose last worker died between its write and its finalize.

**Retry errored cases** (`POST /runs/:id/retry-errored`) reopens a finished run: errored tasks go back to `pending` with `round_attempts = 0`, errored scores to `pending`, the run to `running` with `retry_round + 1`. Successful tasks are not touched, and attempt history is kept.

### 7. Cancellation that reaches the model

`POST /runs/:id/cancel` is one transaction: run → `cancelled`; every `pending` task and score → `cancelled`; `pg_notify('eval_cancel', runId)`. Each worker LISTENs; on the notification it aborts the `AbortController` of every in-flight call for that run, the HTTP connection to the provider closes, and the provider stops generating. The aborted attempt is recorded `cancelled` and partial output is kept with `finish_reason = 'cancelled'`. Since the claim query only considers `queued`/`running` runs, no new call starts. Two fallbacks keep this correct when a NOTIFY is missed (listener reconnecting after a sleep): workers re-check the runs they have calls in flight for every second, and the sweeper cancels leftover pending tasks and expired leases of cancelled runs. Measured locally: in-flight calls stop 15-20 ms after the cancel returns.

### 8. Statistics: the case is the unit

Samples of one case share an input and a reference, so they are correlated. Pooling 5 samples × 22 cases as 110 independent observations would make every interval about √5 too narrow. So:

1. **Per-case value** = mean score over the case's scored samples. A case with no scored sample is excluded and counted (`erroredCases`, `unscoredCases`); a case with some errored samples is included and flagged `partial`.
2. **Run mean** = mean of per-case values; **95% interval** = Student-t on per-case values (`t_{0.975, n−1} · s/√n`), plus a percentile bootstrap over cases (2,000 resamples, seeded so the same rows always give the same interval).
3. **Flaky cases**: per-case variance across samples > 0, or samples disagree on pass/fail.
4. **More samples narrow the interval** by shrinking per-case noise, not the spread between easy and hard cases. Seeded: ×1 ± 0.130, ×5 ± 0.031, ×10 ± 0.020 on the same pins; live e2e: ×1 ± 0.130, ×3 ± 0.052, ×6 ± 0.029.
5. **Paired comparison** on the same dataset version: dᵢ = mean_B(i) − mean_A(i) over cases scored in both runs. Mean difference, paired t-interval and bootstrap interval, wins / losses / ties (dᵢ > 0, < 0, = 0). Verdict: improvement if the interval is above zero, regression if below, **not significant** if it crosses zero. Pairing removes case difficulty from the noise: in a unit test, B is always 0.05 better on 8 cases of wildly different difficulty, and the paired test calls it while Welch's unpaired test can't.
6. **Unpaired (Welch)** only for mixed dataset versions, over cases whose content hash is identical in both versions, and labelled "indicative only".

Cases errored or unscored in **either** run are excluded from **both** sides, counted, and above 10% the comparison is no longer claimable: survivorship (the cases that errored are often the hard ones) can manufacture an improvement.

### 9. Provenance and the improvement claim

The comparison service classifies the two runs' pins before computing anything (`shared/provenance.ts`):

| Situation | Mode | Verdict |
|-----------|------|---------|
| Different datasets | not comparable | blocked |
| Same dataset, different versions | unpaired over unchanged shared cases | "indicative only", never claimable |
| No scorer version scored fully on both runs | not comparable | "scores not comparable" + offer to re-score the run that lacks the newer version |
| Prompt **and** model config changed | paired | "B is better/worse, but the cause is unknown" (confounded) |
| Nothing changed | paired | A/A noise check; expect "not significant" |
| Seed-only change | paired | a different draw, not a different system |
| A run unfinished, or one sample at temperature > 0 | paired | shown, not claimable |

**The key question: the prompt, the dataset and the scoring function all changed. What is required before calling it an improvement?** Nothing about that pair can be claimed: three things moved, so no number isolates any of them. To get a claim you rebuild the comparison so exactly one thing differs:

1. **Same scorer version.** Re-score run A's stored outputs with the new scorer version (cheap: judge or regex calls, zero generations). Before relying on a changed scorer, check it against human labels on a sample: a scorer change changes what "better" means. In the seeded data the stricter judge rubric flips verdicts *and* disagrees with reviewers on padded-but-correct answers.
2. **Same dataset version.** Re-run A's prompt version on the new dataset version (this costs generations). Scores across dataset versions can move with no system change at all: in the seed, the same prompt and config score 0.890 on v1 and 0.973 on v2, and on the 17 unchanged shared cases the difference is exactly zero.
3. **One factor.** Prompt version *or* model config, not both.
4. **Both runs finished**, errored cases retried or listed, excluded cases ≤ 10%, and errored cases excluded from both sides, never averaged on one side only.
5. **Several samples per case** (≥ 2, 5 by default) unless temperature is 0.
6. **A paired 95% interval on per-case differences that excludes zero**, with win/loss/tie shown, because a mean can rise while a category of cases regresses.

The UI shows these six requirements with a check or cross on every comparison, and the verdict says "improvement" only when all hold.

### 10. Human annotation

Per run, a queue computed on read:

- `low_confidence`: any model-graded score with confidence < 0.5 (the judge's grade sits near the pass boundary);
- `samples_disagree`: the case's samples disagree under the run's first automated scorer;
- `spot_check`: a stable pseudo-random 1-in-8 slice of everything else (FNV hash of the output id).

A label (`pass`/`fail` + note) upserts `annotations` and a score row for every human scorer version on the run. **Agreement** (rate and Cohen's κ) is reported per judge version and split into spot checks vs queue items: agreement on items chosen *because* the judge was unsure is biased low by construction, so only the spot-check figure estimates how far to trust the judge on the rest.

### 11. Mock model and mock judge

Separate processes, per the shared LLM-project decisions:

- **Deterministic:** the output is a pure function of (model, system, rendered prompt, temperature, seed); the worker sends `seed = config.seed·1000 + sampleIndex`, so outputs depend on (prompt version, case, sample, seed). Every decision draws `u = (1−t)·u_case + t·u_sample`, so temperature 0 gives identical samples and higher temperatures give per-sample variation in proportion.
- **Quality depends on the prompt:** skills recognise the task (ticket classification, order extraction to JSON, HTTP status explanations). Listing categories and a tie-break rule cut errors on ambiguous tickets; few-shot examples help a little but bias toward the example labels, so v3 wins on some cases and loses on others; "respond with only the label" changes the format, which exact match and a naive regex care about.
- **Limits and chaos:** per-model context windows (the seeded long log exceeds `mock-small`), max tokens truncation, a concurrency cap (529), configurable TTFT and tokens/s, and armed-count chaos (`rate_limit`, `overloaded`, `timeout`, `disconnect`, `invalid`) so tests fail exactly the next N calls. Call counters per eval run (`X-Eval-Run-Id`) prove "zero model calls" and measure peak concurrency per run.
- **The judge** grades recall of the reference's content words (grade 1-5); the strict rubric docks two grades for padding; confidence is the distance from the pass boundary.

### Worked example: one successful trace

Alice starts "Triage v2" (23 cases × 3 samples, limit 4) from the New run form.

1. The browser sends `POST /runs` with the form's `Idempotency-Key`. API-1 validates pins and template variables, then in one transaction inserts the run (`queued`), 3 `run_scorers` rows and 69 `case_results`, and `NOTIFY eval_tasks`.
2. Both workers wake. Worker-1 locks the run row (`SKIP LOCKED`), sees 0 live leases < 4, claims `t-001/0`; the run becomes `running`. Worker-2, finding the row locked, retries in ~10 ms and claims the next task. Claims continue until 4 leases are live; further claims for this run stop at the limit.
3. Worker-1 renders the template, calls the model with seed 29,000; first token after 230 ms; done event with usage after 245 ms.
4. Worker-1 computes exact/contains/regex scores in memory, then one transaction: fenced `UPDATE case_results SET status='succeeded', output, tokens, ttft_ms, generation_ms`, the attempt row → `succeeded`, 3 `scores` rows. Then `finalizeRun` (no-op: tasks remain).
5. The run page polls `GET /runs/:id` every 1.5 s: progress bars, live leases 4/4, aggregates filling in.
6. `t-023` (the long log) returns `400 context_length_exceeded` three times: classified permanent, written `errored` after one attempt each.
7. The last task's worker calls `finalizeRun`: nothing pending → `completed`. The page shows "completed, 3 errored" and Exact label 0.955 ± 0.052 with "3 errored (1 case) excluded".

### Worked example: one failed trace

The same run, but the provider throttles and a worker dies.

1. Worker-2 claims `t-005/1`; the provider answers `429, Retry-After: 1`. Classified `rate_limited`; `round_attempts = 1 < 4`, so a fenced `UPDATE ... status='pending', available_at = now() + 1000 ms`; the attempt row records `retry_scheduled, 429, delay 1000`.
2. Worker-1 claims `t-009/1`; the stream drops after half the tokens. `stream_disconnected` is transient: the partial text is discarded, retry in ~300 ms.
3. Worker-1 is `SIGKILL`ed while holding 6 leases. Its sockets close, so the provider stops those generations. Nothing else happens yet: the rows stay `running` with leases ending 4 s later.
4. Lease expiry passes. Worker-2's next claim matches `status='running' AND lease_expires_at <= now()` for those 6 tasks, increments `attempts` to 2, marks attempt 1 `lease_expired`, and re-runs them. The unique key (run, case, sample) means there is still exactly one row per task, and the scores insert is `ON CONFLICT DO NOTHING`.
5. If the killed worker had only been frozen (a laptop sleep) and woke up holding a result, its fenced write would match zero rows; it marks its attempt `superseded` and moves on.
6. The run completes; the attempts panel shows `#1 lease_expired · worker-1`, `#2 succeeded · worker-2`. The e2e suite runs exactly this: 6 expired leases, 46/46 rows, no duplicate scores, completed 7 s after the kill.

### Design Review Checklist

| # | Question | Answer |
|---|----------|--------|
| 1 | Source of truth; when is a write successful? | PostgreSQL. A run exists when its creation transaction (run + all tasks) commits; an output exists when its fenced UPDATE commits together with its inline scores. Aggregates are derived on read, never stored as truth. |
| 2 | Client retries after losing the response? | Run creation is keyed by `Idempotency-Key` + request hash (replay → same run, `200`; different body → `422`). Cancel, retry-errored and re-score are idempotent state changes (a second call finds nothing to change). Annotation is an upsert. |
| 3 | Worker or server fails between two steps? | Between claim and result: the lease expires and another worker re-claims; the unique (run, case, sample) key and fencing tokens prevent duplicates or stale overwrites. Between result and finalize: the sweeper finalizes. API crash mid-creation: the transaction rolls back; the client retries with the same key. |
| 4 | Which ordering or consistency is required? | None across tasks: they are independent and run in any order. Per task, the lease token totally orders writers. Per run, status transitions are guarded UPDATEs (one winner). Comparisons need snapshot consistency only within a request. |
| 5 | Access with caches, indexes, async jobs? | Every API query is scoped by the session's workspace. Workers never take requests from users: they act on rows whose workspace was checked when the run, re-score or label was created. Mock admin views show only aggregate counters. |
| 6 | What breaks first at scale, and evidence? | The claim path on the PostgreSQL primary: every task costs about 5-6 row writes (claim, attempt row, heartbeats, result, scores), so ~12k row writes/s at 2,000 claims/s, plus the partial-index scans of the run-picking query. Next, results pages recomputing aggregates over 100k-task runs. See [Scalability](#scalability-considerations). |

## Database Schema

The full schema is `backend/src/db/init.sql`. Core tables:

```sql
CREATE TABLE dataset_versions (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id),
  version INT NOT NULL CHECK (version > 0), message TEXT NOT NULL DEFAULT '',
  case_count INT NOT NULL, content_hash CHAR(64) NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, version)
);
CREATE TABLE dataset_cases (
  id TEXT PRIMARY KEY, dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
  case_key TEXT NOT NULL,            -- identity across versions
  ordinal INT NOT NULL, input JSONB NOT NULL, reference TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}', content_hash CHAR(64) NOT NULL,
  UNIQUE (dataset_version_id, case_key)
);
-- prompt_versions, model_configs and scorer_versions follow the same pattern.
-- Trigger forbid_mutation(): BEFORE UPDATE OR DELETE on all five → RAISE EXCEPTION.

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
  prompt_version_id  TEXT NOT NULL REFERENCES prompt_versions(id),
  model_config_id    TEXT NOT NULL REFERENCES model_configs(id),
  samples_per_case INT NOT NULL CHECK (samples_per_case BETWEEN 1 AND 20),
  concurrency_limit INT NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled','failed')),
  total_tasks INT NOT NULL, retry_round INT NOT NULL DEFAULT 0, failure_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL, request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  last_claimed_at TIMESTAMPTZ,       -- round-robin fairness
  UNIQUE (workspace_id, created_by, idempotency_key)
);
CREATE INDEX idx_eval_runs_active ON eval_runs (last_claimed_at NULLS FIRST, created_at)
  WHERE status IN ('queued','running');

CREATE TABLE run_scorers (
  run_id TEXT REFERENCES eval_runs(id) ON DELETE CASCADE,
  scorer_version_id TEXT REFERENCES scorer_versions(id),
  origin TEXT NOT NULL CHECK (origin IN ('pinned','rescore')),
  added_by TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, scorer_version_id)
);

-- The task AND its result. The unique key is why a re-leased task can't produce a second result.
CREATE TABLE case_results (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES dataset_cases(id), case_key TEXT NOT NULL,
  sample_index INT NOT NULL CHECK (sample_index >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','errored','cancelled')),
  attempts INT NOT NULL DEFAULT 0, round_attempts INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT, lease_token TEXT, lease_expires_at TIMESTAMPTZ,
  output TEXT, finish_reason TEXT, input_tokens INT, output_tokens INT,
  queue_ms INT, ttft_ms INT, generation_ms INT, error_code TEXT, error_message TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  UNIQUE (run_id, case_id, sample_index)
);
CREATE INDEX idx_case_results_claimable ON case_results (run_id, available_at) WHERE status = 'pending';
CREATE INDEX idx_case_results_leased    ON case_results (run_id, lease_expires_at) WHERE status = 'running';
CREATE INDEX idx_case_results_run_status ON case_results (run_id, status);

CREATE TABLE case_attempts (
  case_result_id TEXT REFERENCES case_results(id) ON DELETE CASCADE, attempt INT NOT NULL,
  worker_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'in_progress' CHECK (outcome IN
    ('in_progress','succeeded','retry_scheduled','errored','lease_expired','cancelled','superseded')),
  error_code TEXT, http_status INT, delay_ms INT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  PRIMARY KEY (case_result_id, attempt)
);

-- Judgments apart from facts: re-scoring adds rows, never touches outputs or older scores.
CREATE TABLE scores (
  case_result_id TEXT REFERENCES case_results(id) ON DELETE CASCADE,
  scorer_version_id TEXT REFERENCES scorer_versions(id),
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','scored','errored','cancelled')),
  score NUMERIC(6,4), passed BOOLEAN, confidence NUMERIC(4,3), rationale TEXT,
  attempts INT NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT, lease_token TEXT, lease_expires_at TIMESTAMPTZ,
  error_code TEXT, error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), scored_at TIMESTAMPTZ,
  PRIMARY KEY (case_result_id, scorer_version_id)
);
CREATE INDEX idx_scores_claimable ON scores (available_at) WHERE status = 'pending';

CREATE TABLE annotations (
  case_result_id TEXT PRIMARY KEY REFERENCES case_results(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('pass','fail')), note TEXT NOT NULL DEFAULT '',
  annotated_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## API Design

All under `/api/v1`, session-authenticated, workspace-scoped; DTOs are camelCase.

```
POST /auth/login | POST /auth/logout | GET /auth/me

GET  /datasets                         list with head version, case count, runs
POST /datasets                         create with v1 cases
GET  /datasets/:id                     versions (message, case count, hash, runs)
GET  /datasets/:id/versions/:v         cases of one version
POST /datasets/:id/versions            {baseVersion, message, cases[]} → v+1 and diff; 409 if stale; 422 if unchanged
GET  /datasets/:id/diff?from=&to=      added / removed / modified (fields) / unchanged

GET  /prompts | POST /prompts | GET /prompts/:id | POST /prompts/:id/versions   {baseVersion, system, template, message}
GET  /model-configs | POST /model-configs                                       immutable rows
GET  /scorers | POST /scorers | POST /scorers/:id/versions                      config validated per kind

POST /runs                             Idempotency-Key required; 201 new, 200 replay, 422 key reuse
GET  /runs                             list: status, progress, primary aggregate ± CI, errored count
GET  /runs/:id                         pins, progress, usage, one aggregate per scorer version, same-pins siblings
GET  /runs/:id/cases                   per case: samples with output, usage, error, scores, labels; per-case stats
GET  /runs/:id/rows?scorerVersionId=   raw (case, sample, status, score) rows
GET  /runs/:id/case-results/:cr/attempts
POST /runs/:id/cancel                  idempotent
POST /runs/:id/retry-errored           409 while running; requeues errored tasks and scores
POST /runs/:id/rescore                 {scorerVersionId} → 202 {queued, alreadyScored}; 409 while running
GET  /runs/:id/annotations             queue + agreement
PUT  /runs/:id/annotations/:cr         {label, note}

GET  /compare?a=&b=&scorer=            provenance, paired/unpaired statistics, verdict, per-case table
GET  /system | PUT /system/:target/chaos | POST /system/:target/chaos/reset      mock model/judge view
```

```bash
curl -b jar -H 'Idempotency-Key: k1' -H 'Content-Type: application/json' localhost:3000/api/v1/runs -d '{
  "datasetVersionId":"dsv_triage_2","promptVersionId":"pv_triage_2","modelConfigId":"mc_small_t07",
  "scorerVersionIds":["scv_exact_1"],"samplesPerCase":5,"concurrencyLimit":4}'
# → 201 {"run":{"id":"run_01…","status":"queued","totalTasks":115,…},"replayed":false}
```

## Key Design Decisions

### 1. PostgreSQL SKIP LOCKED queue, not RabbitMQ

**Chosen:** the `case_results` rows are the queue. **Alternative:** RabbitMQ (or SQS) carrying one message per task.

The queue here has three requirements a FIFO broker doesn't model: a **per-run concurrency limit**, **fairness between runs**, and **cancel that discards queued work**. With rows, all three are a `WHERE` clause and an `ORDER BY`: count live leases, serve the least recently served run, skip cancelled runs. With a broker, a worker that pulls a message for a run at its limit must requeue it (hot-looping) or park it somewhere else; fairness needs a queue per run plus a dispatcher; and cancelling a 100k-task run leaves 100k messages to drain and discard. A broker also forces a dual write (run in PostgreSQL, messages in RabbitMQ), which means an outbox and a relay to avoid losing or duplicating tasks; with rows, fan-out is one transaction. Retries with backoff are `available_at = now() + delay` instead of delayed-message plugins, and crash recovery is lease expiry instead of unacked redelivery plus a separate dedup step.

**What we give up:** throughput ceiling and isolation. Every claim, heartbeat and result is a write on the primary, so the queue competes with the API for the same database, and claim throughput tops out around a few thousand per second per primary. Polling also costs a little latency (NOTIFY hides most of it). Model calls take seconds, so 2,000 claims/s supports ~20,000 concurrent calls, which exceeds most provider rate limits; when it doesn't, the path is to shard runs across queue databases by `run_id` (component 3 needs nothing cross-run except fairness, which becomes per shard), not to switch to a broker.

### 2. The case is the unit of analysis

**Chosen:** intervals over per-case means; paired by case. **Alternative:** pool all samples, or compare run means.

Pooling treats 5 samples of the same case as independent, which understates the variance by roughly the number of samples and turns noise into "significant" improvements. Comparing two run means without pairing leaves case difficulty in the noise: easy cases score 1 in both runs and hard cases 0 in both, so the between-case spread swamps a real, consistent 5-point gain (the unit test shows the paired test detecting what Welch can't). The cost: comparisons need the same dataset version, and the UI must explain why a mixed-version comparison is unpaired and indicative only.

### 3. Scores separate from outputs

**Chosen:** `scores(case_result_id, scorer_version_id)`. **Alternative:** a score column on the result row.

Outputs are expensive facts (model calls, money, time); scores are cheap judgments that change whenever someone fixes a regex or tightens a rubric. A score column forces regeneration to rescore, or overwrites history so old comparisons silently change meaning. A separate table makes re-scoring an insert, keeps every version's judgments for audit, and makes "scorer versions must match" checkable. The cost is a join on every aggregate and more rows (one per output per scorer version).

### 4. Retry errored reopens the run

**Chosen:** errored tasks go back to `pending` in the same run (`retry_round + 1`). **Alternative:** a child run with only the errored cases.

A child run splits one logical evaluation into two records that every aggregate and comparison must merge, and "which run is the result?" becomes ambiguous. Reopening keeps one run, one set of pins and one result set, which grows more complete; attempt history shows what happened. The cost: a `completed` run can change after the fact, so comparisons are computed on read and the run shows its retry round.

### 5. Copy cases per version, not content-addressed

**Chosen:** one `dataset_cases` row per (version, case). **Alternative:** content-addressed case blobs referenced by versions, as the playground does for prompt text.

Copying keeps foreign keys simple (`case_results.case_id` points at exactly the case that ran) and diffs trivial. At 500 cases per version it costs nothing; at 100k-case datasets with frequent small edits it would duplicate storage, and the content-addressed layout (`case_contents(hash)` + `version_cases(version, key, hash)`) is the upgrade path.

### 6. Aggregates computed on read

**Chosen:** aggregate from rows on every request. **Alternative:** maintain aggregates in a table as tasks finish.

On read is always consistent with the rows (re-scoring, retries and labels can't leave a stale aggregate), and it is what makes the e2e's "independent recomputation matches the API" check meaningful. It costs O(tasks) per page view; past ~10k tasks per run, aggregates would be materialized per (run, scorer version) when the run finalizes or a re-score completes, and recomputed from rows on demand.

## Consistency and Idempotency

| Operation | Mechanism | Retry behaviour |
|-----------|-----------|-----------------|
| Create run | Unique `(workspace, user, Idempotency-Key)` + request hash; run and fan-out in one transaction | Same body → same run (`200`, `Idempotent-Replayed`); different body → `422` |
| Claim | `FOR UPDATE SKIP LOCKED`, run row lock for the limit | Two claimers never get the same task |
| Write a result | Fenced by `lease_token` and `status = 'running'` | A stale or duplicate write matches 0 rows |
| Insert scores | PK `(case_result_id, scorer_version_id)`, `ON CONFLICT DO NOTHING` | A replayed completion or re-score adds nothing |
| Re-score | Same PK | Second call queues 0 |
| Retry errored | Run row lock; only `errored` rows move | Second call requeues 0 |
| Cancel | Run row lock; only `queued/running` runs move | Second call reports `alreadyFinished` |
| Finalize | `UPDATE ... WHERE status = 'running' AND nothing pending` | Exactly one of N concurrent callers wins |
| New version | Head row lock + `baseVersion` check | Stale base → `409` |

Retries schedule on the database clock (`now() + delay`), so host clock drift can't make a task run early or late.

## Security / Auth

- Session auth: opaque id in an httpOnly, SameSite=Lax cookie; session data in Valkey; bcrypt passwords; login rate limit per IP.
- Every user belongs to one workspace; every query below the routes filters by the session's `workspace_id`. Cross-workspace ids return `404`, not `403`, so ids don't leak existence.
- Run creation validates that every pin belongs to the caller's workspace before writing.
- Workers take no user input; they act on rows whose ownership was checked when the run, re-score or label was created. A worker can't widen access because it never decides access.
- Regex scorer patterns are validated when the version is created. Production would run user regexes with a time budget (or RE2) to rule out catastrophic backtracking.
- The mock admin endpoints are local infrastructure; production restricts provider settings to operators and exposes only per-workspace usage.

## Observability

Prometheus metrics per process (`/metrics`):

| Metric | Why |
|--------|-----|
| `evals_runs_created_total{outcome}` | created vs idempotent replay vs key conflict |
| `evals_tasks_finished_total{outcome,error}` | succeeded / retry_scheduled / errored / cancelled / superseded, by failure kind: provider weather vs our bugs |
| `evals_scores_finished_total{kind,outcome}` | judge failures separate from generation failures |
| `evals_claim_duration_seconds{kind,result}` | the first thing that degrades at scale (component 3) |
| `evals_model_call_seconds{phase}` | queue, TTFT, generation |
| `evals_leases_reclaimed_total{kind}` | workers dying or stalling |
| `evals_worker_in_flight` | slot utilisation |

Structured JSON logs (pino) carry `run`, `task`, `attempt` and `worker` fields, so one task's story can be grepped across workers. `/health` and `/ready` (database ping) on every process. Alerts in production: reclaimed leases > 1% of claims (workers dying), claim p99 > 50 ms, oldest due pending task age > 1 min (workers starved), errored rate by `error` kind per provider.

## Failure Handling

| Failure | Detection | Handling |
|---------|-----------|----------|
| Provider 429 / overload / 5xx | HTTP status | Retry with full-jitter backoff, honour Retry-After, ≤ 4 attempts per round |
| Provider hangs | Client deadline | `timeout`, retried |
| Stream breaks mid-generation | No `done` event | `stream_disconnected`, retried; partial discarded |
| Input too long / invalid | 400 | Errored once, shown, excluded from aggregates; "retry errored" available |
| Worker crash | Lease expiry | Re-claimed by any worker; attempt marked `lease_expired`; no duplicates |
| Worker stall past lease | Fenced write matches 0 rows | Result discarded, attempt `superseded` |
| Judge down | Same classification | Score rows retry independently of outputs |
| Finalizer missed | Sweeper | Finalizes running runs with nothing pending |
| NOTIFY lost | 1 s poll of in-flight runs; sweeper | Cancel still lands within ~1 s |
| Listener connection dies (sleep) | `end` event | Supervised reconnect with backoff; idle workers poll anyway |
| API crash mid-create | Transaction rollback | Client retries with the same key |
| Valkey down | Session lookups fail | Users signed out; runs and workers unaffected |
| A scorer throws on an output | Exception in inline scoring | Output still saved; score left `pending` for a re-score |

## Scalability Considerations

**What breaks first: the claim path on the primary.** Each task costs a claim UPDATE, an attempt INSERT, ≥ 1 heartbeat, a result UPDATE and score INSERTs: roughly 5-6 row writes. At 2,000 tasks/s that is ~12k row writes/s plus WAL, and the run-picking query scans active runs (counting live leases per run) on every claim. Evidence locally: a successful generation claim averages 4-6 ms (`evals_claim_duration_seconds`, ~500 claims over two workers, Docker PostgreSQL on a laptop), already several round trips per task; the shape of the query (a partial-index probe per active run) predicts linear cost in active runs, which is why production keeps a small `active_runs` table with an in-flight counter maintained by claims and finishes instead of counting leases.

The path, in order:
1. **Batch claims** (a worker takes k tasks of one run per transaction) and **longer heartbeat intervals**: cuts claim writes by k.
2. **Split the queue from the catalog**: case_results and scores on their own PostgreSQL cluster, the catalog and results UI on read replicas.
3. **Shard the queue by `run_id`**: runs are independent, so each shard runs the same claim logic; fairness becomes per shard, plus a global per-workspace token bucket for provider quota.
4. **Materialize aggregates** per (run, scorer version) on finalize and re-score; keep the on-read path for audits.
5. **Move outputs to object storage** (S3) beyond a size threshold, keeping a hash and preview in the row.
6. **Partition** `case_results`, `case_attempts` and `scores` by run creation month; old runs become read-only partitions.

The provider remains the true bottleneck: per-run limits and per-workspace quotas decide who gets the scarce calls, and the queue only has to keep those slots full.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Work queue | PostgreSQL rows + SKIP LOCKED | RabbitMQ | Per-run limits, fairness and cancel are SQL predicates; fan-out in one txn, no outbox |
| Crash recovery | Leases + fencing tokens | Broker redelivery + dedup | One mechanism for crash, stall and duplicate writes |
| Fairness | Round robin by `last_claimed_at` | FIFO | Small runs aren't stuck behind 100k-task runs |
| Unit of analysis | Per-case means, t-interval + bootstrap | Pooled samples | Samples of a case are correlated; pooling overstates confidence |
| Comparison | Paired by case | Difference of run means | Removes case difficulty from the noise |
| Mixed dataset versions | Unpaired over shared cases, indicative only | Pair by key anyway | Changed cases are different cases; the shared subset isn't representative |
| Scores | Separate table per scorer version | Column on the result | Re-score without regenerating; old scores kept |
| Errored cases | Excluded from both sides and counted | Treat as 0, or drop silently | Survivorship and failures both distort means |
| Retry errored | Reopen the run | Child run | One result set per pin set |
| Versions | Immutable rows + trigger | Mutable with history | Pins can't drift, enforced by the database |
| Dataset storage | Copy cases per version | Content-addressed blobs | Simple FKs and diffs at this size |
| Aggregates | Computed on read | Materialized | Always consistent; materialize past ~10k tasks |
| Live updates | Polling (1.5-3 s) | SSE | Seconds-scale state; no stream per page |
| Cancel delivery | NOTIFY + 1 s poll + sweeper | Poll only | ~20 ms typical, bounded by 1 s when NOTIFY is lost |

## Implementation Notes

### Local architecture

| Process | Default port | Entry point |
|---------|--------------|-------------|
| API (×2 for distributed testing) | 3000, 3001 | `backend/src/api/index.ts` |
| Eval workers (×2) | 3101, 3102 (metrics) | `backend/src/worker/index.ts` |
| Mock model | 3100 | `backend/src/model/index.ts` |
| Mock judge | 3105 | `backend/src/judge/index.ts` |
| Frontend | 5173 | `frontend/` (Vite) |
| PostgreSQL 16, Valkey 7 | 5432, 6379 | `docker-compose.yml` |

### Production-grade patterns actually implemented

- **SKIP LOCKED queue with leases, fencing, per-run limits and round-robin fairness** (`worker/tasks.ts`, `worker/score-tasks.ts`). Verified by a race test against PostgreSQL (`tasks.race.test.ts`: 10 parallel claimers never exceed a limit of 3 or share a task; a stale lease holder's writes match zero rows; round robin across two runs; finalize wins exactly once) and by the live e2e (SIGKILL a worker holding 6 leases → 6 `lease_expired`, 46/46 rows, no duplicate scores).

```ts
// worker/tasks.ts: every result write is fenced
UPDATE case_results SET status = 'succeeded', output = $3, ...
 WHERE id = $1 AND lease_token = $2 AND status = 'running'
```

- **Idempotent creation with fan-out in one transaction** (`api/services/runs.ts`), race-tested with 5 concurrent duplicates → 1 run, 23 tasks.
- **Retry classification and full-jitter backoff honouring Retry-After** (`shared/retry.ts`), tested against the real mock model over HTTP (`worker/model-client.test.ts`: 429, 529, hang → timeout, mid-stream disconnect, 400, context overflow, abort, refused connection).
- **Cancellation that reaches the model**: `LISTEN/NOTIFY` + per-run `AbortController`s (`worker/execute.ts`, `worker/listener.ts` with supervised reconnect) + a 1 s poll + the sweeper.
- **Statistics** (`shared/stats.ts`): Student-t via a regularized incomplete beta function, seeded bootstrap, paired and Welch intervals; tested against tabulated quantiles and hand-computed examples. The e2e recomputes a paired comparison from raw rows with an independent numeric t quantile and matches the API to 1e-4.
- **Provenance classification** (`shared/provenance.ts`) as a pure, unit-tested function; the verdict logic (`api/services/compare.ts`).
- **Immutability enforced by a trigger**; optimistic concurrency on version heads.
- **Observability**: Prometheus metrics (prom-client), pino structured logs, `/health` + `/ready` per process; a worker whose metrics port is taken keeps working (`shared/worker-http.ts`).

### Simplified or substituted

- **Mock model and mock judge** instead of real providers. They are deterministic, have skills whose quality depends on the prompt, and expose armed-count chaos and per-run call counters. A real provider adapter (the `callModel` signature in `worker/model-client.ts`) is not wired in.
- **Seeded runs are materialized in-process** (`db/materialize.ts`) with the same functions a live worker calls; a live run with the same pins reproduces their outputs exactly (an e2e check). Their timings and transient retries are simulated deterministically.
- **One PostgreSQL** for catalog, queue and results; no replicas or shards.
- **Session auth with one workspace per user**; no roles within a workspace.
- **Dataset editing is a JSON editor** for the whole case list.
- **Polling** for live progress (1.5 s run page, 2 s list), which also keeps the screenshot harness's `networkidle` waits short.

### Omitted

- Per-workspace provider quotas and cost budgets (per-run limits only).
- Batch claiming, aggregate materialization, partitioning, object storage for large outputs.
- CI integration (run on every prompt change, block a merge on a regression).
- Multi-turn or tool-using test cases; only single-turn templates.
- Inter-annotator agreement between humans (one label per output).
