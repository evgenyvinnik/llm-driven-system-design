# AI Code Review - Development with Claude

## Project Context

**Prompt.** A proposed system fetches a pull request's diff, asks a model to assess it and automatically approves what it judges acceptable. Find the consequential omissions, then build the corrected design ([ROADMAP entry 12](../ROADMAP.md#12-ai-code-review)).

**Signal.** Anthropic, guide-reported: the candidate critiqued an existing design document instead of designing from scratch. This project practices that format, so `proposed-design.md` and `design-review.md` are the priority deliverables, and the three answers are critique-led.

**Key question.** If the model were fully compromised right now, what could it do? In the proposal: approve anything, merge, and leak the App's private key. Here: nothing except escalate.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed when it ran, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API + webhook receiver | 3000 (3001 via `dev:server1`) | `backend/src/api/index.ts` | Console API, `/webhooks/git-host` |
| Workers | 3101, 3102 (metrics) | `backend/src/worker/index.ts` | Runs, sweeper, reconciler. Read-only host token |
| Poster | 3103 (metrics) | `backend/src/poster/index.ts` | The only write credential |
| Mock model | 3100 | `backend/src/model/index.ts` | SSE, chaos switches, deliberately gullible |
| Fixture Git host | 3105 | `backend/src/githost/index.ts` | Own schema; CAS on reviews; signed webhooks |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `CODEREVIEW_PG_PORT` |
| Valkey 7 | 6379 | — | Sessions and login limit; `CODEREVIEW_VALKEY_PORT` |

## Development Phases

1. **The two documents first.** The flawed proposal, then the critique, so the corrected design was shaped by the findings rather than the other way round. The critique names implementation files that didn't exist yet, which worked as a spec.
2. **Pure domain.** The gate, path normalization, category rules, `decide`, the schema parser, signatures and the audit chain have no IO.
3. **The host and the model, as real separate processes.** The host's token scopes and CAS make the guarantees testable from outside.
4. **State machine, worker, poster, API.** `syncPullRequest` became the single path for head changes once the receiver, the reconciler and the poster all needed it.
5. **Seed by materialization.** `db/materialize.ts` runs the real system in one process, so all seeded data is what the system actually did. The first seed run was also the first integration test.
6. **Tests, then the live e2e** (scratch, not committed): 442 checks against two APIs, two workers, the poster, the mock and the host, including SIGKILLing a worker, the poster and the model.
7. **Frontend, then the documents.** All pages poll.

## Key Implementation Decisions (and why)

- **The critique's four questions drove the structure.** "Assume the model is compromised" led to the separate poster and the structural tests; "which commit?" led to `syncPullRequest` and the CAS.
- **`decide` is deliberately small and monotone.** A test walks every combination of mode, kill switch, model signal and signals with each failed rule and asserts none reaches an approval.
- **The mock model obeys injections inside the untrusted tags.** Otherwise every test would pass for the wrong reason.
- **`unknown` is a rule status, not a failure.** It lets CI wait with a deadline while every other unknown fails closed.
- **`gate_only` runs** re-apply the gate when CI reports or someone reviews, reusing the stored opinion, so a flaky check costs no tokens.
- **Observe queues nothing for humans.** They are reviewing normally anyway; a flood of escalations would poison shadow mode as a measurement.
- **Dismissals list the host's reviews** instead of trusting a stored id, so a crash between the post and its record can't leave a live approval behind.
- **Polling, not SSE, in the console.** SSE is between the worker and the model, where it belongs. An always-open stream would also stall the screenshot harness.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ or Kafka | PostgreSQL `SKIP LOCKED` | State change, queue entry and audit entry commit together (architecture.md, Key Design Decision 6) |
| Vite 5 (in some earlier projects) | Vite 6 | `@tanstack/router-plugin` now has a peer of `vite >=6`, so a clean install without a lockfile hits ERESOLVE on 5 |
| Real provider adapter | `MODEL_URL` + `MODEL_API_KEY` | The mock speaks Messages API format, so the seam is a URL. Off by default, and not exercised here |
| Separate receiver process | Mounted in the API | Stateless and already horizontally scaled |

## Iteration & Repair Log

1. **A retargeted base looked like a bug in a test.** After a retarget the old approval is dismissed and a new run approves again at the same SHA. That is correct: the change was judged against its new target. The test was wrong.
2. **Dismissal and a later approval could race at the same SHA.** Two poster loops could run a dismissal after the new approval landed, dismissing the wrong review. Intents are now first-in first-out per PR.
3. **An approval in flight when its decision is withdrawn.** A dismissal could list reviews before the in-flight post landed, leaving a live approval. The dismissal now waits out the in-flight lease, and a poster that finds itself fenced after a successful post takes the approval back. Both found by reasoning about `poster/post.test.ts`, then covered by it.
4. **`.env` injection only read one path.** The mock's regex wanted "read" before each path, so the fixture read `.env` and never tried `../../etc/passwd`. The fixture text was reworded.
5. **`requirements.txt` counted as docs.** A bare `*.txt` glob would have let a dependency change into the docs scope. Docs are now by extension, with `.txt` only under `docs/`. `docs/setup.sh` had the same problem through a `docs/**` glob.
6. **`remember_token` didn't match `\btoken\b`.** Underscore is a word character, so the mock approved a login bypass. The word boundary came out.
7. **Literal invisible characters in regex source** tripped `no-irregular-whitespace`. They are escapes now, which also makes them visible in review.
8. **The stray `cat` incident.** A leftover command waiting on stdin hung a dry run for two minutes. Not a product bug; noted because it looked like one.

## Open Questions

- A worker can't currently tell a "reviewed" push from a rebase with no content change, so a clean rebase re-runs the model. Comparing diff hashes across SHAs could reuse an opinion; the audit story for that needs thought.
- The corpus is hand-authored by the gate's author. How would one mine real labeled history, and how would one keep it from being fit to the rules?
- Should a reported false approval add a corpus case automatically? Today it only demotes.
- A narrow window remains: an in-flight approval, a crashed poster and a same-SHA re-evaluation together. The lease wait covers it; no test kills the poster at exactly that point.
- Base-branch drift after approval is out of scope, and depends on the host's merge queue settings.

## Verification Environment Notes

- No `.env` ships. Everything has a default; every host port is overridable (`CODEREVIEW_PG_PORT`, `CODEREVIEW_VALKEY_PORT`, `PORT`, `MODEL_PORT`, `GITHOST_PORT`, `WORKER_PORT`, `POSTER_PORT`, `VITE_PORT`, `API_TARGET`).
- `npm test` creates a separate `ai_code_review_test` database when PostgreSQL is reachable, and skips the integration tests when it isn't.
- PR numbers in the screenshot config rely on the seed being deterministic and fresh. Run `npm run db:seed` first; a live e2e adds more PRs after them.
- With the default `CI_WAIT_MS`, seeded PR #36 (waiting for CI) escalates 30 seconds after a worker starts. That is the system working.
- Killing an `npx tsx` PID doesn't kill the node listener: stop servers with `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`.
