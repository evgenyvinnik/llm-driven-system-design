# Yard Switch Lists - Development with Claude

## Project Context

**Prompt.** A classification yard receives inbound trains, sorts their cars into blocks on classification tracks, and assembles outbound trains. Design the service that produces each shift's switch list (the ordered moves), and replans it when trains run late.

**Signal.** A practice extension from the [roadmap](../ROADMAP.md#24-yard-switch-lists). BNSF publicly describes generating optimized switch lists with AI at its Alliance yard, but the prompt isn't known to have been asked in interviews. The docs say so. No yard, train or number here comes from BNSF or any railroad.

**The trap the roadmap names:** spending the round on the optimizer and ignoring replanning, overrides and execution feedback. So the planner got one design pass, and most of the work went to those three.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Stateless; `dev:server1` adds 3001 |
| Planner worker | 3100 (metrics) | `backend/src/worker/index.ts` | Coalescer, plan lane, analysis lane, hold consumer |
| Simulator | 3110 (control) | `backend/src/simulator/index.ts` | Starts paused; proxied through the API with a role check |
| Frontend | 5173 | `frontend/` | `VITE_PORT` and `API_TARGET` override the port and proxy |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `YARD_PG_PORT` moves the host port |
| Valkey 7 | 6379 | - | Sessions and the hold-feed stream. Service name `redis` for the repo scripts |

Layout of the backend, in reading order:

- `domain/`: types, seeded scenario, diff, edit operations. No I/O.
- `planner/`: `problem.ts` (what may and may not change), `decode.ts` (decisions to a timed plan), `greedy.ts`, `search.ts`, `exact.ts`, `outcome.ts` (conflicts, consequences), `solve.ts`.
- `validator/`: independent. Imports only types.
- `plans/`, `holds/`, `execution/`, `metrics/`: services over PostgreSQL.
- `worker/`, `simulator/`, `replay/`, `api/`: processes and the pure replay.

## Development Phases

1. **Pure core first.** Types, seeded scenario, decoder, greedy, annealing, branch and bound, validator, with no I/O. The first trial runs compared planner output against the validator on several seeds.
2. **Replay engine as a stress test.** Running whole shifts in memory, with disruptions, is what found most of the decoder's bugs (see the log below), well before any UI.
3. **Services.** Yard state and its version, immutable versions and publish, edits, locks, holds, crew reports, coalescing, durable jobs.
4. **API, simulator and seed.** The simulator runs through a port interface, either HTTP or direct, so the seed produces its demo with the real code.
5. **Frontend.** Board with pointer drag and a keyboard path, plan diff, handheld with an outbox, compare, metrics, holds and simulator pages.
6. **Unit tests, then the live e2e.** 142 live checks passed on the first complete run, because the replay had already shaken out the logic. That run did expose that small instances were too easy (see below).
7. **Docs, screenshots, smoke tests, real-browser drag.**

## Key Implementation Decisions (and why)

- **State version counts surprises, not changes.** As-planned reports don't bump it. Otherwise nothing could publish while crews work. An arrival within 15 minutes of ETA isn't news; a move 25 minutes late is. The validator at publish is the backstop if a threshold is wrong.
- **Validator shares no code with the planner, and a test enforces it.** The test scans the folder's imports. Only type-only imports may cross the boundary. It has its own timeline, duration formula and consist walk.
- **Operating overrides change the fact, not the rule.** Departure revision, a track added to the standing order for the shift, a raised length limit. An exception list would need storing, matching, carrying across versions and expiring.
- **Facts aren't re-judged.** A car already coupled or a move in progress can't fail a plan, or one bad report would block every plan forever. Only what the plan is still adding is judged.
- **Move keys are stable, and never reused.** Cancelled moves keep their key in `move_executions`, so a replacement gets `#2`. Otherwise a new move would inherit a cancelled status and no crew would ever pick it up.
- **Frozen moves come from `move_executions`, not the baseline plan.** A crew's "moved different cars" rewrites that record, so later versions show what really happened.
- **Drag pins a sequence lock.** The change penalty alone would mostly keep a reorder, but "mostly" is the wrong promise to a yardmaster.
- **Lock comparison ignores the from-track.** A locked cut on a train that hasn't arrived can legitimately start from a different receiving track. A lock pins where cars go.
- **Local search is deterministic for a fixed iteration count.** The clock only truncates. That's what makes stepped simulator runs reproducible.
- **Exact uses group-level decisions, same as local search.** So a gap can never be negative. Car-level moves would give local search a larger space than exact can enumerate.
- **`db:seed` runs the whole story in-process.** Through the same services and simulator engine, with the planner inline. So screenshots show what the code really does, and the harness's `--start` flow gets rich data with nothing else running.
- **Polling instead of SSE.** Two-second freshness is enough, and an always-open stream makes the screenshot harness wait out `networkidle` on every screen.
- **Two worker lanes.** A comparison or replay can run for a minute; it mustn't delay a replan.
- **Rose rather than red in the UI.** The screenshot harness reports a login error whenever it sees `.bg-red-50` or `.text-red-700`.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ or Kafka | PostgreSQL job queue with leases; Valkey stream for the hold feed | One commit covers job and plan. The stream stands in for #19's Kafka topic |
| Numbered services per port | One worker process with lanes | Fewer processes; `dev:worker1/2` for more |
| Wall-clock time | Simulated yard clock | A 12-hour shift in minutes. Leases and retries still use the database clock |
| TanStack Query | Small `usePolling` hook | A whole-snapshot poll is all the board needs |
| Service-layer unit tests with mocks only | Also a small in-memory fake for hold and report statements | These rules are the point. The live e2e covers the real SQL |

## Iteration & Repair Log

Bugs the independent validator or live runs found, in order:

1. **Hazmat buffer defeated by pull order.** Placement was checked in one order, then cars were grouped by source track, so the real consist differed. A placarded car ended up fourth from the locomotive. The validator caught it on the very first replay. Placement is now walked in real pull order.
2. **Crews coupling out of block sequence.** The replay's crew skipped an unready pull and took the train's next one. Now an unready pull holds up that train's later pulls, in the replay and the crew API alike.
3. **In-progress moves failing the validator.** A running move finishing late was treated as a plan violation, so no plan could pass. Facts are no longer judged.
4. **Key reuse.** A cut re-created after a hold release had the same key as a done move: `DUPLICATE_MOVE`, and then a car stuck in a phantom state. Keys with execution records are now never reused.
5. **Two trains on one departure track.** A train could reserve a track, have its first pull dropped, and leave the track looking free. It now takes the track only on emission.
6. **Fixed-move check didn't advance.** `every(placeOk)` judged each car of a pinned move against the same counters, so a placarded car behind five clean cars in the same move still failed. It then blocked the trim queue, and five trains were annulled from one replan. This was the worst of them. Fixed by walking a trial copy, and a dropped pin now gives up its place in line.
7. **Setout scheduled twice.** A held car with a set-out in progress got a second one. In-flight set-outs are excluded.
8. **Time travel on failed attempts.** A retry at a far-future time applied releases up to that time, then placed nothing. A later move starting earlier saw space that wasn't free yet: `TRACK_CONFLICT`. It only showed on one tight small instance out of 14. Releases applied during an attempt are now journaled, and rolled back if nothing was placed. A test now runs the validator over 20 tight instances.
9. **Gaps were all zero.** The first live comparison reported 0% for greedy, because the small instances were too loose to need any search. They're tighter now (short tracks, tight departures, at most two blocks per inbound train), so the exact search still proves optimality but greedy has a real gap.
10. **`plan_needs_review` alerts piled up**, one per draft. New drafts now supersede older ones and resolve the old alert.
11. **`planner_output_invalid` fired on a lock conflict.** A conflict is for a person, not a planner bug. Filtered.
12. **Decoder speed.** `Object.entries` on a dictionary-mode object was 50% of decode time. Replaced with a running total.
13. **Negative "later" in a rolled-car message.** "18 cars rolled ... (-30 min later)". A car can move to an earlier train when its old one is annulled. The message now says earlier.

## Open Questions

- **Is auto-publish the right default for rolled cars?** Today they're reported but don't stop publishing. A railroad with strict service commitments may want them to stop too.
- **Group-level decisions.** A group goes to one train, with spills. A car-level search could do better on a full train, at the cost of an exact search that could no longer keep up.
- **A CP-SAT candidate.** For bounds at full scale, and a real yard's in-track order.
- **Report lock contention.** Every report takes the yard's row lock. As-planned ones needn't. I'd measure before changing it.
- **The inspection and repair variant** is designed in the docs and not built.

## Verification Environment Notes

- Verified with Docker on non-default ports alongside other projects: PostgreSQL 5462, Valkey 6409, API 3030 and 3031, worker 3130, simulator 3131, frontend 5176. All can be moved by env var.
- `scripts/screenshots.mjs --start` wasn't used, because it kills whatever holds the configured ports. Instead the stack was started by hand, followed by `SCREENSHOT_FRONTEND_PORT=5176 node scripts/screenshots.mjs yard-switch-lists`.
- Reseeding wipes operational tables and non-session Valkey keys. Stop the worker first, or it will compete for the demo's inline solves.
- `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill` stops a server. Killing an `npx tsx` PID leaves the node process running.
- `@tanstack/router-plugin` is pinned to `~1.168.48`. Version 1.169 requires Vite 6, and lockfiles aren't committed, so a caret range breaks `npm install` on Vite 5.
- `routeTree.gen.ts` is committed, because `npm run build` runs `tsc -b` before Vite generates it.
- Timing checks in the e2e use the search's own clock, and allow for a host stall. Correctness checks are never retried.
