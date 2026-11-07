# LLM Eval Dashboard - Development with Claude

## Project Context

**Prompt.** Versioned test datasets, prompt and model configurations, asynchronous evaluation runs, inspection of results and comparisons between runs ([ROADMAP entry 10](../ROADMAP.md#10-llm-eval-dashboard)).

**Signal.** Practice extension; it reuses the [prompt playground](../prompt-playground/)'s data model (immutable prompt versions and model configs that a run pins).

**Key question.** The prompt, the dataset and the scoring function all changed: what information is required before a comparison can be called an improvement? The answer is in [architecture.md § 9](./architecture.md#9-provenance-and-the-improvement-claim) and is enforced by the comparison service: same dataset version, same fully scored scorer version, exactly one factor changed, both runs finished with ≤ 10% of cases excluded, ≥ 2 samples (unless temperature 0), and a paired 95% interval that excludes zero.

**The traps** named in the brief, and where they're stopped: comparing two single runs' averages (samples + intervals over cases + paired test + a first-class "not significant"); silently averaging survivors ("completed, N errored", counts beside every aggregate, exclusion from both sides, retry errored); comparing across dataset or scorer versions (pinned immutable versions + provenance classification).

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed when it ran, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API | 3000 (3001 via `dev:server1`) | `backend/src/api/index.ts` | Catalog, runs, results, compare, annotations, mock admin proxy |
| Eval workers | 3101, 3102 (metrics) | `backend/src/worker/index.ts` | `WORKER_ID`, `WORKER_CONCURRENCY` (slots), `LEASE_MS`; claim loop, LISTEN, sweeper |
| Mock model | 3100 | `backend/src/model/index.ts` | SSE; skills, context windows, chaos, per-run call counters |
| Mock judge | 3105 | `backend/src/judge/index.ts` | Deterministic grades; same chaos and counters |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | Also the work queue; `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | — | Sessions and login rate limit only; named `redis` in compose for the repo scripts |

Compose host ports are overridable (`EVAL_PG_PORT`, `EVAL_VALKEY_PORT`).

## Development Phases

1. **Brief and pure domain first.** Statistics (`shared/stats.ts`: Student t via the regularized incomplete beta, seeded bootstrap, paired and Welch intervals), aggregation rules (`shared/aggregate.ts`), provenance classification (`shared/provenance.ts`), retry classification (`shared/retry.ts`), scorers, dataset hashing and diff, chaos switches. Each with unit tests.
2. **The mock model before the data.** Skills for three task families (ticket classification, order extraction to JSON, HTTP status explanations) whose error rates depend on prompt features. A scratch simulation ran every planned seed run through the pure pipeline to check that the story holds: v1 → v2 significant, v2 → v3 not significant with wins and losses on both sides, the regex and JSON-shape fixes visible by re-scoring, intervals narrowing with samples. The config seed (29) was chosen by scanning seeds (see repair log 5).
3. **Schema, queue and services.** `init.sql` with immutability triggers; the claim/lease/fence queue (`worker/tasks.ts`, `worker/score-tasks.ts`); idempotent creation with fan-out; cancel, retry errored, re-score; compare; annotations. A race-test suite against real PostgreSQL (`tasks.race.test.ts`).
4. **Seed by materialization.** `db/materialize.ts` runs the same functions a worker runs, in-process, so the screenshot harness gets real data without the workers. The first live run with the same pins as a seeded run reproduced its aggregate to the last digit (0.97272 ± 0.03115), which became an e2e check.
5. **Frontend.** Runs list, run detail (progress, aggregate cards, same-pins table, case table with drill-down to attempts), compare (verdict, provenance, requirements, per-case differences), datasets (versions, diff, editor), prompts, scorers, annotation, mock model page. All polling.
6. **Live e2e** (scratch, not committed): 14 sections, 85 checks against two APIs, two workers and both mocks. Passed on the first full run; one check was then tightened (cancel promptness was asserted as `true`).
7. **Docs.** architecture.md and the full-stack answer written here; the frontend and backend answers by two subagents from architecture.md and the code, then checked against the no-code and length rules. The frontend subagent's code reading found repair-log item 7.

## Key Implementation Decisions (and why)

- **The task row is the result row.** `case_results` is created at fan-out, unique per (run, case, sample), and every lifecycle step is an update to it. Duplicate results are impossible by construction, not by deduplication.
- **Two-step claim.** Step 1 locks a run row with `FOR NO KEY UPDATE SKIP LOCKED` (NO KEY so score inserts' foreign-key checks, which take KEY SHARE on the run, don't wait behind a claimer); step 2 re-counts live leases in a fresh READ COMMITTED snapshot, which is what makes the per-run limit exact rather than approximate.
- **Round robin by `last_claimed_at = clock_timestamp()`.** Simplest fairness that stops a big run starving a small one; per-workspace quotas would sit on top.
- **Inline deterministic scoring, queued judge scoring.** A finished output is scored in the same transaction, so there is no "output without its cheap scores" state; judge calls get their own leases and retries so a judge outage doesn't fail outputs.
- **Re-scoring requires a finished run.** Otherwise outputs finishing after the re-score request would miss the new scorer version and coverage would be ambiguous.
- **Retry errored reopens the run** (`retry_round + 1`, `round_attempts = 0`) instead of creating a child run: one result set per pin set.
- **The seed is materialized, not executed.** Deterministic generation makes it equivalent to a live run; transient failures and timings are simulated from a hash of the task id.
- **The mock is honest about difficulty.** It solves tasks through an oracle and slips with a probability set by prompt features (listed categories, a tie-break rule, few-shot examples that bias labels, format instructions). That is what lets a "better" prompt lose on some cases, which the not-significant comparison needs.
- **Per-run call counters in the mocks** (`X-Eval-Run-Id`) are how "zero model calls during re-scoring", "cancel stops calls" and "peak concurrency per run ≤ limit" are proven from outside the system under test.
- **Polling, not SSE.** Run state changes on the scale of seconds; polling keeps pages simple and the screenshot harness fast.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ or Kafka for queues | PostgreSQL `SKIP LOCKED` | Per-run limits, fairness and cancel are SQL predicates; fan-out in one transaction with no outbox (architecture.md, Key Design Decision 1) |
| SSE for live UI | Polling | Seconds-scale state; avoids the harness's `networkidle` wait |
| Mutable presets with revisions (playground) | Immutable model configs | A run's pin must never drift; "edit" creates a new named config |
| Real provider adapter (optional) | Not wired in | Mock-only; the `callModel` signature in `worker/model-client.ts` is the seam |

## Iteration & Repair Log

1. **Claimers idled while a run was locked.** With `SKIP LOCKED` on the run row, nine of ten concurrent claimers found the only runnable run locked and returned "nothing to do", then slept a full idle interval: slow ramp-up. A claimer that finds nothing now checks (without locks) whether a runnable run exists and, if so, retries after 5-25 ms.
2. **Race-test cascade.** A failing race test left its run active; the next test's claim was served from that run by round robin and failed for an unrelated reason. Each test's runs are now cancelled in `afterEach`.
3. **Test bugs, not product bugs:** two hand-computed expectations in `stats.test.ts` were wrong (a paired SD and a Welch df quoted from memory). Recomputed by hand in the test comments.
4. **Full-page screenshots captured one viewport.** The shell used `h-screen overflow-hidden` with a scrolling `<main>`, so Playwright's full-page capture saw only the visible part. The document now scrolls and the nav is sticky.
5. **A single-sample run looked perfect and certain.** With the original config seed (7), the ×1 run happened to get all 22 cases right: mean 1.000, interval ±0.000. Correct arithmetic, terrible demo, and a good illustration of the trap. Scanning seeds picked 29, where ×1/×5/×10 give ±0.130/±0.031/±0.020.
6. **The tightened judge rubric never changed a verdict.** Docking one grade for padding took correct-but-padded answers from 5 to 4, still a pass at `passGrade` 4. It now docks two, so the strict rubric fails them, which also makes judge-vs-human agreement drop for that version: a real lesson about validating a scorer change.
7. **Editors read their base version at save time.** The dataset, prompt and scorer editors took `baseVersion` from data refreshed by polling, so a colleague's save followed by a refresh would let our save build on (and silently revert) theirs instead of returning 409; the dataset editor could also be swapped to the new head's cases mid-edit. The base is now captured when editing starts, and the dataset page pins the edited version.
8. **Seed-data oracle check caught a bad reference.** "no rush on this one" contains the priority keyword "rush", so the oracle said high priority while the reference said normal. The email was reworded; `seed-data.test.ts` now asserts that the only reference/oracle mismatches are the two deliberate mislabels in support-triage v1.

## Open Questions

- **Per-workspace provider quotas and cost budgets.** Per-run limits share capacity within a run; a token bucket per workspace (and per provider) would share it across teams.
- **Batch claims.** Taking k tasks per claim cuts queue writes by k at the cost of coarser fairness and larger loss on a crash.
- **Materialized aggregates** for runs past ~10k tasks, recomputed on finalize, retry and re-score.
- **Sequential testing for CI gates.** A gate that peeks at a running comparison inflates false positives; a sequential test (or a fixed decision point) would be needed before auto-blocking merges on partial runs.
- **Multiple-comparison correction** when a dashboard compares one baseline against many candidates.
- **Inter-annotator agreement** (two humans per item) to know whether disagreement with the judge is the judge's fault.
- **Content-addressed case storage** for large datasets with frequent small edits.
- **Multi-turn and tool-using test cases.**

## Verification Environment Notes

- **Ports used here** (other agents held the defaults): PostgreSQL 5462, Valkey 6409, APIs 3030/3031, mock model 3130, mock judge 3135, workers 3131/3132 (and 3133 for the e2e's crash victim), frontend 5176 proxied to 3031.
- **Stop processes by port, never by name:** `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`. Killing an `npx tsx` PID doesn't kill the node listener; the e2e spawns its crash-victim worker as `node --import tsx` so its PID is the worker itself.
- **The e2e replaces the regular workers** with its own (lease 4 s, model timeout 4 s, retry base 200 ms) and leaves two running at the end.
- **Race tests need the workers stopped**, otherwise live workers claim the test's tasks.
- **E2E result:** 14 sections, 85 checks, run under `caffeinate -im` against the live stack; every run passed 85/85 in about a minute. Highlights: cancel stopped in-flight calls 15-20 ms after the request returned; a SIGKILLed worker holding 6 leases → 6 `lease_expired`, 46/46 rows, completed 7 s after the kill; re-scoring 66 outputs left the mock model's call counter unchanged; the paired comparison recomputed from raw rows with an independent numeric t quantile matched the API to 1e-4.
- **Screenshots** were taken with `SCREENSHOT_FRONTEND_PORT=5176 node scripts/screenshots.mjs llm-eval-dashboard` (no `--start`) after a fresh `npm run db:seed` followed by `npm run demo:story` (which adds the three "Demo:" runs and the mock's call counters seen in the runs list and on the mock page). All 16 screens are byte-distinct. Red tones are rose, so the harness's "Login error banner" heuristic (`.bg-red-50`, `.text-red-700`) stays quiet.
- **Smoke tests:** the repo root has `playwright` 1.57 but not `@playwright/test`, and only WebKit is installed; the generated spec was run from a scratch runner with `@playwright/test@1.57.0`, a WebKit project, `SMOKE_BASE_URL=http://localhost:5176` and `SKIP_WEBSERVER=1`: 16/16 passed.
- **Unit tests:** 86 pass with `npm test`; with `TEST_DATABASE_URL` set (workers stopped) the 6 queue race tests run too, 92/92.
