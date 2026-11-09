# CI/CD Platform - Development with Claude

## Project Context

**Prompt.** Repository events trigger workflows made of dependent jobs; users inspect status, live logs and artifacts; the system handles bursts ([ROADMAP entry 11](../ROADMAP.md#11-cicd-platform)).

**Signal.** OpenAI (community attribution). It extends the [job scheduler](../job-scheduler/).

**The trap.** Designing only the queue, and neglecting execution boundaries, credentials and repeatability. Where each is handled: execution boundaries in `backend/src/runner/` (with the local substitution stated plainly in the README); credentials in `backend/src/secrets/` and the claim; repeatability in the pins and the immutable job rows.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed when it ran, and what's still open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API | 3000 (3001 via `dev:server1`) | `backend/src/api/index.ts` | Intake, people's API, SSE, runner API, fixture panel. Stateless |
| Scheduler | 3100 (metrics) | `backend/src/scheduler/index.ts` | Lease sweep, log archive, artifact retention. Safe to run twice |
| Runners | 3101+ (metrics) | `backend/src/runner/index.ts` | Only speak HTTP. `supervisor.ts` restarts a dead one |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | Source of truth and queue |
| Valkey 7 | 6379 | | Sessions, login rate limit, log wake-ups; named `redis` in compose for the repo scripts |
| MinIO | 9000, 9001 | | Artifacts and archived logs |

Compose host ports are overridable (`CICD_PG_PORT`, `CICD_VALKEY_PORT`, `CICD_MINIO_PORT`, `CICD_MINIO_CONSOLE_PORT`).

## Development Phases

1. **Pure decisions first.** Parser, readiness (`scheduling/graph.ts`), the lease-expiry and completion decisions (`scheduling/decisions.ts`), secret eligibility (`secrets/eligibility.ts`), the stream masker (`secrets/masking.ts`), signature checks, each with unit tests. Keeping them pure is what makes the rules testable without a race.
2. **Schema and engine.** `init.sql` with immutability triggers; the engine (`scheduling/engine.ts`), claim, fenced runner writes, log ingest, intake.
3. **Runner.** Process groups, scrubbed environment, workspace, log shipper, executor, supervisor. Unit tests spawn real process trees.
4. **Seed by materialization.** `db/seed-stories.ts` drives the real engine with a scripted stand-in for a runner, so the screenshot harness gets real data with no child processes and known ids.
5. **Race tests against real PostgreSQL** (`scheduling/engine.race.test.ts`, gated on `TEST_DATABASE_URL`): fan-in, limits, fairness, step-start versus expiry, fencing, forged fork rows, attempts, log assembly.
6. **Live e2e** (scratch, not committed): 14 sections, 326 checks against two APIs, a scheduler and real runner processes, including real SIGKILL and SIGSTOP, and pausing MinIO and Valkey. It ran before the frontend existed, so the API was settled when the UI was written against it.
7. **Frontend, demo and load scripts, docs, screenshots, smoke tests.** Plus a scratch click-through in WebKit (22 checks: drop-and-resume, approval, a real runner kill, the three decisions, confirmations, cancel, secrets, read-only views), because smoke tests only prove that pages render.

## Key Implementation Decisions (and why)

- **Readiness in the completion transaction, under a run lock.** Not a counter, not events, not a poller. See architecture.md, Key Design Decision 1. The counter was tempting, but it doesn't cover failures and must be rebuilt on every re-run.
- **One lock order: repository (claim only) → run → job → log stream.** Heartbeats touch one job row and take no other lock. The PostgreSQL log of the final e2e run shows no deadlock.
- **`step_executions` row before the process.** `startStep` holds the job row lock while writing intent, and `expireLease` takes the same lock before reading steps. That lock is the whole answer to the race.
- **Fence check includes the runner id.** Tokens come from a sequence, so they're guessable. The token alone isn't a credential.
- **A stale completion is rejected, but kept** as `late_report` on the attempt. Added once it was clear the person resolving `needs_attention` would want it. Fencing protects state, not knowledge.
- **A killed or timed-out non-idempotent step also goes to `needs_attention`.** Not in the brief, which only names lease expiry. The same reasoning applies: the step didn't get to say how far it went.
- **Chunks and partial lines are encrypted at rest.** A held-back partial line may contain half a secret, and it sits in the database between requests.
- **Masks are snapshotted per attempt** (`log_streams.mask_enc`): rotating a secret mid-job doesn't unmask what was released.
- **Lines are numbered only by contiguous assembly.** The reader's offset can then never point at a gap.
- **Webhook URL per repository**, so the signature check precedes all parsing.
- **Pull request `branch` is `pull/N/merge`,** so a fork naming its branch `main` can't pass a branch rule.
- **Secrets named in the workflow** (`secrets: [X]`), not injected wholesale: least privilege, and it gives the UI something precise to say about what was withheld.
- **Self-fencing runner.** A partition should behave like a crash, not like two owners.
- **The sweeper skips one sweep after its own stall.** When a laptop sleeps, every lease looks expired on wake, unfairly: the runners were frozen too.
- **Polling for state, SSE only for logs,** and only on the job page, which also keeps the screenshot harness fast.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ or Kafka for queues | PostgreSQL `SKIP LOCKED` | Labels, limits, fairness, gates and readiness are one atomic decision (Key Design Decision 2) |
| Containers for isolation | Child processes | The ROADMAP's local scope; stated plainly as a substitution |
| `@tanstack/router-plugin` with a caret range | Tilde pin, `~1.168.48` | 1.169.0 requires Vite ≥ 6, so a caret range hits ERESOLVE on a fresh install with Vite 5. Lockfiles are gitignored, so the pin has to live in `package.json`. A clean copy installs and builds with no lockfile |

## Iteration & Repair Log

1. **`needs: []` was rejected.** The parser's shared string-list schema required at least one item, which is right for `runs-on` and wrong for `needs`. Found by the first race-test run, when 31 tests failed with no jobs on their runs.
2. **A step's output can die with its runner.** The first e2e expected attempt 1's log to contain output from the step running when it was killed, and it didn't: the kill landed within the 200 ms flush window. Not a bug, and worth knowing. The test now waits for the output, and the docs don't promise the last 200 ms.
3. **Connection pool saturation became a 500.** 48 pushes alongside about 50 pollers of the run page (the e2e's own waiting loops) exhausted the pool's 5 s checkout timeout. Fixed twice: the API answers 503 with `Retry-After`, because a Git host retries and the delivery id dedupes, and the test polls once in SQL so its waiting isn't the load being measured.
4. **Log uploads awaited the Valkey publish.** Noticed while writing the outage section: a paused Valkey would hold up every chunk. The publish is now fire-and-forget, with a command timeout on the client.
5. **A file-size fixture passed when it should have failed.** `dd ... | tail -1` hid dd's status from `sh -e`. The pipe went away.
6. **"On a different runner" was a wrong assumption.** The frozen runner sometimes re-claimed its own job on waking, with a new attempt and a new token, which is correct. The test now waits until another runner has it before waking the frozen one.
7. **Claim with `onlyJobId` returns null under contention.** A seeding and test convenience, so the tests claim sequentially when concurrency isn't what they're testing. Real claims retry.
8. **Fan-in test commit SHAs collided** (`padEnd` turned 1 and 10 into the same string). A test bug that looked like an engine bug for a minute.
9. **Sidebar stopped at the first viewport** in full-page screenshots. It's now a full-height column, with the nav sticky inside it.
10. **A killed runner never looked offline.** Found by clicking through the UI in a real browser: the supervisor brought it back in 4 s, before the 5 s offline threshold, so the row only changed its incarnation. The supervisor's default is now 8 s, which also lets the lease expire while the runner is visibly gone.
11. **The next person landed on the previous person's page.** Returning to a deep link after sign-in also fired after an explicit sign-out. It now applies only before the first sign-in of the page's life. Found the same way.

## Open Questions

- **Should the pusher be able to approve their own deploy?** Allowed today. Production needs a "required reviewers exclude the author" rule.
- **Fork jobs on a separate runner pool.** Documented as what production needs; not built, because locally there's no boundary to separate anyway.
- **A step that's safe to retry if the previous one finished.** Resume-from-step would reduce `needs_attention` for a job whose deploy finished and a later note step was running. Today the whole job re-executes, so the rule stays conservative.
- **Who gets paged on `needs_attention`?** The metric exists. There's no notification path.
- **Browser memory on very long logs.** Rendering is virtualized, but every line stays in an array. Not measured.
- **Load beyond the local burst.** Nothing here has been tested past about 50 jobs in 10 s. The scale predictions are arithmetic, not measurement.

## Verification Environment Notes

- **Race tests need `TEST_DATABASE_URL`,** pointing at a migrated database. They create and delete their own repositories, and leave seeded data alone.
- **Seed ids are stable** (`run_demo_attention`, `job_run_demo_attention_deploy`), which is what `scripts/screenshot-configs/ci-cd-platform.json` links to.
- **Seeded data has rewritten timestamps** (`spreadInTime`) so lists read like a history. Statuses, attempts and tokens are real.
- **Run `demo:story` and `load:burst` shortly before capturing:** the ops screens show only the last 5 minutes.
- **The Mac can sleep.** Timing checks in the e2e detect host stalls and exclude those samples, and the sweeper tolerates them. Correctness checks aren't retried.
- **A killed runner's step keeps running** as an orphan until it notices its dead pipe or finishes. That's the realistic behaviour, and a reason fixture steps are short.
- **Stopping servers:** killing an `npx tsx` PID doesn't kill the node listener. Stop by port: `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`.
