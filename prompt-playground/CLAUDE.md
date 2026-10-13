# Prompt Playground - Development with Claude

## Project Context

This is the first project from [ROADMAP.md](../ROADMAP.md) (entry 1). The reported interview version is explicit that the model API already exists and the interviewer wants the product around it. So the build spends almost nothing on "inference" (a mock model service stands in) and nearly everything on the questions the follow-ups ask: which text belongs to a result, what happens when two people save, where a result appears when the user has navigated away, and how comparisons fit without a redesign.

The design is in [architecture.md](./architecture.md). This file records how the project was built, what changed along the way, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | REST + SSE; `dev:server1..3` for 3001-3003 |
| Executor | 3200 | `backend/src/executor/index.ts` | Pulls run IDs, leases runs, streams from the model, runs the sweeper; `dev:executor2` adds a second one on 3202 |
| Mock model | 3100 | `backend/src/model/index.ts` | Deterministic generator (`model/generator.ts`) with latency, slots and failure knobs |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to 3000 |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | Applied by `npm run db:migrate`; seeded by `npm run db:seed` |
| Valkey 7 | 6379 | - | Service named `redis` in `docker-compose.yml` because the repo's scripts look for that name |

`npm run dev` in `backend/` runs the three backend processes with `concurrently -k`, so if one dies they all stop rather than leaving a half-running stack.

## Development Phases

1. **Backend first, verified with curl.** Shared modules, schema, mock model, API and executor were written and then exercised against native PostgreSQL 16 and Redis 7 before any UI existed: streaming, `Last-Event-ID` resume, idempotent replay, key reuse with a different body (`422`), cancel while queued and while running, forced mid-stream failure, version and preset conflicts, share and revoke, workspace isolation, and the recovery paths (a SIGSTOPped executor failed by a second executor's sweeper, a lost queue entry re-enqueued).
2. **Frontend, verified with Playwright.** A scripted browser drove the real stack: streaming, refresh mid-run, Stop, comparisons, the navigate-away toast, both conflict flows, admin and share pages. Several bugs below were only visible there.
3. **Screenshots, smoke tests, docs.** Screenshot config in `scripts/screenshot-configs/prompt-playground.json`; smoke tests generated from it (7/7 pass against the running stack); architecture document; interview answers.

## Key Implementation Decisions (and why)

These are build-time choices that are not obvious from architecture.md.

- **Valkey Streams for the work queue instead of RabbitMQ/Kafka.** The stack defaults list RabbitMQ and Kafka, but the queue here is only a doorbell: ownership lives in PostgreSQL, and the sweeper re-rings lost doorbells. A Valkey stream with a consumer group (read with `NOACK`) does that with no extra service, and Valkey is already required for the per-run event logs. A real broker would add an acknowledgement protocol that duplicates what the conditional claim already guarantees.
- **`bcryptjs` instead of `bcrypt`.** No native build step, which keeps `npm install` working on any machine. Login is not a hot path.
- **No TanStack Query.** Server state is small and page-scoped (`usePromptDetail`); the only cross-page state is live runs, and that needed custom semantics (streams outlive components, state never regresses) that a query cache would fight. Zustand holds it.
- **Share link creation is a click, not an effect.** The first version created the link in a `useEffect` when the dialog opened. React StrictMode runs effects twice in development, which created two links per open. Side effects that create server state belong in event handlers.
- **The mock model generates text from prompt keywords**, not lorem ipsum, so outputs visibly change when the prompt changes, and comparisons look like comparisons. Temperature 0 is deterministic, which made the seed data and tests reproducible.
- **Seed runs use the mock model's own generator**, so historic outputs look exactly like live ones.

## Iteration & Repair Log

Bugs found by testing against the running stack, in the order they were found:

1. **Public share links returned 401.** The runs router is mounted at `/api/v1` next to the share routes and used `router.use(requireAuth)`. Router-level middleware runs for *every* request that enters the router, including ones that fall through to a later router. Fix: authentication per route in `routes/runs.ts`.
2. **A fenced-out executor could still write.** With a SIGSTOPped executor resumed after the sweeper had failed its run, two writes slipped through: `first_token_at` (that update lacked `status = 'running'`, so the run showed a TTFT larger than its total duration) and late `delta` events appended after the sweeper's `end`. Fix: the timestamp update is now fenced like every other write, and appends go through a Lua script that refuses anything after the first `end` (`shared/run-events.ts`). Keys gained a `{runId}` hash tag so the script is cluster-safe.
3. **`FLUSHALL` stopped all execution.** Deleting the queue stream also deletes its consumer group; the executor then failed every read with `NOGROUP` forever while runs piled up as `queued`. Fix: recreate the group on `NOGROUP`. The queued runs then recovered on their own through the sweeper's re-enqueue, which confirmed the doorbell design.
4. **Stop flipped a cancelled run back to "running" with empty output.** The executor finalized the cancel within milliseconds, so the stream's `end` reached the browser *before* the cancel endpoint's HTTP response, which still said `running` with no output. The store then overwrote the newer state. Fix: a run's stage only moves forward in `stores/runs-store.ts`; an older REST copy can update metadata but never status or output.
5. **Removed members could still list prompts.** Routes that act on the session's workspace trusted the workspace ID cached in the session. Fix: `requireWorkspaceMember` re-checks membership per request (`403 NOT_A_MEMBER`). Routes addressed by resource ID already joined `workspace_members`.
6. **Smoke tests never logged in.** The repo's generator waited with `waitForURL(/(?!.*login).*/)`, which is unanchored and matches `/login` itself, so each test navigated away and aborted the sign-in request. Fixed in `scripts/generate-smoke-tests.mjs` for `/login`-style login pages (configs with a login form at `/` keep the old line). Other projects' committed smoke tests pick this up when they are regenerated.
7. **Comparison columns could swap.** Seeded comparison runs had identical `created_at`, so A/B order depended on row order. Seeds now differ by a millisecond, and both the API and the UI tie-break on ID.
8. **A retried version save looked like a conflict.** If a save committed but its response was lost, the retry (same `baseVersion`) got `409 HEAD_MOVED` naming the user's own save. Found while writing the full-stack interview answer, which asked "what happens when a client retries after losing the response?" for every write. Fix: the server checks whether the submitted text is already the head *before* checking `baseVersion`, and answers `200 created: false` with that version.

## Verification Environment Notes

- The cloud session that built this had no Docker daemon, so verification used native PostgreSQL 16 (`initdb` in `/var/tmp`) and `redis-server` 7, with the same credentials as `docker-compose.yml`. The compose file itself was not run in that session.
- The repo's screenshot harness launches WebKit, which was not installed there; screenshots were captured by a temporary copy of the harness switched to the preinstalled Chromium (`/opt/pw-browsers/chromium`), and smoke tests ran with the same executable. Nothing in the repo depends on that substitution.

## Open Questions / Next Steps

- **Multiplexed SSE reader.** Each open stream holds its own Valkey connection (because `XREAD BLOCK` blocks it). One shared reader per API instance would remove the main per-instance scaling limit described in architecture.md.
- **Real provider adapter** behind an environment variable in `executor/model-client.ts`, with the mock remaining the default so setup, tests and screenshots stay offline.
- **Version diff view** and markdown rendering of outputs (output is shown raw today, which is also what most playgrounds do by default).
- **Workspace switcher.** Memberships support several workspaces, but sign-in picks the first.
- **History virtualization** with `@tanstack/react-virtual` once a prompt has thousands of runs (history is paginated 25 at a time today).
- **Token budgets per workspace**, enforced at run creation alongside the active-run cap.
- **Evaluation runs** (dataset × version × config) are a separate roadmap project; the snapshot + run model here was chosen so they can reuse it.
