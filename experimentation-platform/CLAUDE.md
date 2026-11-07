# Experimentation Platform - Development with Claude

## Project Context

**Prompt.** Feature flags and A/B experiments: assigning variants, delivering config, logging exposure, attributing conversions and a kill switch ([ROADMAP entry 9](../ROADMAP.md#9-experimentation-platform)).

**Signal.** A practice extension from the roadmap, especially useful for growth-engineering roles. No company attribution.

**The key question** is whether a user who was assigned a treatment but never saw it counts as exposed. They don't, and the system tells the cases apart by writing them from different places. `useVariant()` / `evaluate()` log a diagnostic *assignment*. `<Exposure>` logs an *exposure* when the variant mounts or becomes visible. The analysis reads only exposures and shows assignments next to them.

**The traps** named in the roadmap, and where each is handled:

- *Logging exposure at assignment time.* Handled by `sdk/src/react/Exposure.tsx` and `client.logExposure`, which refuses anything not `inExperiment`.
- *Reshuffling users when weights change.* Handled by `allocateStable` in `sdk/src/core/allocation.ts`, with the editor's move preview.
- *An SDK whose render path depends on the network.* Handled by the startup ladder in `sdk/src/client/client.ts` and the `maxWaitMs` provider.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed when it ran, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| api-a, api-b | 3000, 3001 | `backend/src/api/index.ts` | Console API, SDK surface, storefront API; `INSTANCE_ID`, `PORT` |
| Ingest worker | 3100 (metrics) | `backend/src/ingest/index.ts` | Valkey stream → ClickHouse; `WORKER_ID`, `WORKER_PORT` |
| Admin console | 5173 | `frontend/` | Proxies `/api` and `/sdk` to api-a; polls, never streams |
| Demo storefront | 5180 | `demo-app/` | Proxies to api-b, so pushes always cross Valkey pub/sub |
| SDK | n/a | `sdk/src/` | `core/` (shared with the backend and console), `client/`, `react/` |
| Traffic simulator | n/a | `backend/src/simulator/run.ts` | One Node SDK client, 4,000 visitors in real time |
| PostgreSQL 16 / Valkey 7 / ClickHouse 24.8 | 5432 / 6379 / 8123 + 9000 | `docker-compose.yml` | Compose host ports: `EXP_PG_PORT`, `EXP_VALKEY_PORT`, `EXP_CH_HTTP_PORT`, `EXP_CH_NATIVE_PORT` |

## Development Phases

1. **The shared core first, with tests.**
   - MurmurHash3 checked against the reference vectors.
   - `allocateStable` and `compareAllocations`, plus the two naive strategies for comparison.
   - Targeting and `evaluateFlag`.

   23 tests passed on the first run. The comparison numbers in the docs (10% vs ~26% moved, ~80% of treatment back) come straight from `allocation.test.ts`.
2. **Backend.**
   - Pure domain modules with tests: stats (Wilson, pooled z-test, delta-method lift, chi-square via the incomplete gamma), analysis (per-version SRM, crossovers), compile, flag model, and ingest batch preparation.
   - Then the services: compile-in-transaction snapshots, forward-only publish, pub/sub plus reconcile, the atomic batch dedup Lua script, and the identity alias.
   - Then the worker with insert tokens, and the routes.
   - The parity test imports the SDK client and an independent BigInt hash.
3. **SDK client and React bindings.**
   - The startup ladder, monotonic apply, and SSE over fetch with a watchdog.
   - The persisted batch queue with stable batch ids, and the beacon.
   - `useVariant`, `<Exposure whenVisible>` and `<Experiment>`.

   Tested against a scriptable fake server, plus jsdom React tests.
4. **Traffic simulator**, then the stack brought up on isolated ports and the results checked by eye.
5. **Admin console**: flags list with bucket bars, editor (status, kill switch, weights with live preview, rules with a try-a-unit evaluator, definition, history), results, live clients, audit.
6. **Demo storefront**: product page (`checkout_cta`), Rewards tab (`rewards_teaser`, `whenVisible`), cart (`shipping_banner`, deliberately broken), sign-in with the alias, and an inspector with offline and clear-cache switches.
7. **Docs.** `architecture.md` was written first from the running system. The three interview answers were written in parallel by subagents from it and the code, then checked against the no-code and length rules. Their accuracy notes were folded back in (salt immutability, jitter wording, the offline-trace wording).
8. **Live e2e suite** (scratch, not committed): 11 sections, 69 checks against the real processes. Then screenshots, smoke tests and this file.

## Key Implementation Decisions (and why)

- **The backend compiles the SDK's `core/` instead of copying it.** `backend/tsconfig.json` sets `rootDir: ".."`, and `backend/src/shared/evaluation.ts` re-exports `../../../sdk/src/core/index.js`. tsx, vitest and tsc all resolve it; `tsc` emits to `dist/backend/src/...`. The console uses a Vite alias plus a tsconfig path. The demo app maps `react` types to its own copy so the SDK's React files don't pull a second `@types/react`.
- **Snapshot version = ETag.** A version's body never changes, so `"prod-v18"` is the entity tag. Pushes carry only `{version}`, and clients fetch `/snapshots/:version`, which is safe even when the load balancer picks an instance that hasn't caught up.
- **The environment row is the per-environment sequence and lock.** Every compile runs `UPDATE environments SET snapshot_version = snapshot_version + 1 … RETURNING` inside the write transaction. The order is flag config row first, environment row second, the same in every writer.
- **The kill switch is a status change with a fixed target** (flag → paused, experiment → stopped), not a separate boolean. One code path, one audit shape, and `evaluateFlag` needs no extra case.
- **Assignment events are real events**, logged from `evaluate()` / `useVariant` and deduped per unit and version. Without them the results page couldn't show assigned vs exposed. They also make SRM localizable: balanced assignments with unbalanced exposures mean a logging bug.
- **SRM expectation per config version** from `flag_versions`, so the seeded 90/10 → 80/20 → 50/50 history doesn't trip it. Crossovers count toward SRM but not toward rates.
- **Read-time analysis with duplicate-insensitive aggregates**: `argMin`, `min`, `uniqExact` and "any conversion in (first, first + window]". Results are exact even before ReplacingMergeTree merges. Raw row counts use `FINAL` and are shown as "unmerged duplicates".
- **Skew correction per batch** (`receivedAt − sentAt`), and partitioning by the raw device time (`client_ts`). The SDK sets `sentAt` on every send, so a retried copy's corrected `ts` can differ, but its `client_ts` never does, and both copies land in the same partition where a merge can collapse them.
- **Fetch-based SSE** instead of EventSource: header auth, identical in Node, and our own watchdog and jittered reconnect.
- **No persistence by default in Node.** Serializing the queue and dedup keys on every event made the simulator take 53 s; Node clients now use a no-op storage (see the repair log).
- **The console polls.** It needs updates within seconds, not milliseconds, and the screenshot harness waits ~30 s per screen on any open stream. SSE is for SDK clients.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| Kafka for event ingest | Valkey stream + consumer group | One less container; the dedup and replay semantics (own pending entries, XAUTOCLAIM, insert tokens) are the same idea as Kafka offsets |
| One frontend | Two Vite apps (console, storefront) | The storefront is a customer's app with only a client key; it talks to the other API instance so every push crosses pub/sub |
| `valkey/valkey:7.2-alpine` | `valkey/valkey:7-alpine` | The image already cached on the build machine (same major version) |

## Iteration & Repair Log

Found by running things, in order:

1. **Test bug: a wrong expected z.** The stats test expected z = 2.966 for 10% vs 13% of 2,000; the correct value is 2.974. The code was right.
2. **Node's `RequestInit` has no `cache`.** The SSE fetch passed `cache: 'no-store'`, which type-checked in the SDK (DOM lib) but not when the backend compiled the same file with Node types. Removed; the server sends `Cache-Control: no-cache` anyway.
3. **The simulator took 53 s for 4,000 visitors.** Every queued event and every dedup key re-serialized the whole queue and key list into (memory) storage. Fix: a `noopStorage` default (`persistent: false`), queue persistence skipped for it, and dedup keys appended to a bounded array instead of rebuilding it. The run now takes ~1-2 s.
4. **The late cohort was rejected entirely.** Its timestamps were `now − 2.5 h` as floats, and the schema requires integer milliseconds. Fixed with `Math.round`; the e2e suite now checks that late events are counted.
5. **The live client view showed a streaming SDK as disconnected.** The client's version report and the stream's connect handler both read-modify-wrote one JSON field per client, so whichever finished last erased the other's `connected` flag. Fix: two hashes with one writer each (`exp:clients` for reports, `exp:streams` for connection state). A per-connection id also stops a late close from an old connection from marking a reconnected client offline. The e2e suite caught this (68/69 → 69/69).
6. **The deliberately broken banner wasn't broken in WebKit.** It logged exposure from a `loading="lazy"` image 120vh below the cart, and WebKit's lazy-load margin loaded it anyway. The bug now uses an illustration from a slow "CDN" (`/api/v1/shop/assets/free-shipping.svg` answers after 3.5 s), which is deterministic and just as realistic. Docs updated.
7. **Accuracy fixes from the doc review:**
   - The salt cannot change: no API edits it, so the docs now say it is fixed at creation.
   - Event retries use half-range jitter, not full jitter.
   - The failed trace no longer claims the analysis window ends at the stop; it doesn't filter by `stopped_at`.

## Open Questions

- **Two tabs share one event-queue storage key** (`exp:<clientKey>:events`). After a crash only the last tab's write survives, so a few events can be lost; nothing is double counted (batch ids and event ids dedupe). A per-tab key with a leader election, or a BroadcastChannel, would fix it.
- **A second device's pre-sign-in exposures stay a separate unit.** `identity_links` records the pairing; resolving unit ids through a ClickHouse dictionary at query time would merge them and turn real crossovers into visible ones.
- **Analysis windows after a ramp.** Per-version SRM handles the expected split, but the conversion comparison still mixes pre- and post-ramp cohorts. A "start analysis from version N" option is the usual answer.
- **Stale caches and the kill switch.** An offline device serves its last known good snapshot for up to 7 days. Should a killed flag carry a "kill even when stale" marker that the SDK enforces as soon as it has any network?
- **Sampling assignment events** (10%) at scale, with SRM-on-assignments adjusted for the sampling rate.
- **Explicit id lists are readable in client snapshots.** Production should hash them per salt or keep such rules server-side.
- **Sequential testing / CUPED.** The fixed-horizon z-test invites peeking; the results page polls every 5 s.

## Verification Environment Notes

- **Ports used here (shared machine):** PostgreSQL 5452, Valkey 6399, ClickHouse 8133/9031, api-a 3020, api-b 3021, worker metrics 3120, console 5175 (→ api-a), storefront 5178 (→ api-b). The defaults follow repo conventions and everything is overridable.
- **Stop processes by port, never by name:** `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`.
- **Build-time checks:** backend and SDK `type-check`, `lint`, `test` (40 + 40 tests) and `build` pass; console and storefront `type-check`, `lint` (zero warnings) and `build` pass.
- **Live e2e suite** (a scratch script run with tsx under `caffeinate -im`): 11 sections, **69/69 checks**, passed on three consecutive runs, the last on a freshly reset stack. It covers:
  - parity of api-a, api-b and the SDK on 900 (unit, flag) pairs;
  - two-device identity, and 0/300 flips at sign-in vs 51% for re-bucketing;
  - targeting: forced, excluded, not_in and fallthrough;
  - the 10 → 20% ramp: 9.7-9.9% moved, all control → treatment, vs re-hash at 26% moved and 80% of treatment back;
  - 304 from both instances; a push across instances; a lost publish recovered by reconcile in 3.5-4.6 s;
  - the kill switch over 10 cycles per run: p50 16-20 ms, max 19-28 ms;
  - offline startup from the last known good snapshot and from coded defaults;
  - exposures only for the 30 rendered units of 120 assigned; dedup across an SDK restart;
  - a retried batch through both instances: one row; a re-batched event: FINAL counts one; a repeated worker insert token: dropped;
  - attribution excluding before-exposure, same-millisecond and out-of-window conversions;
  - SRM firing only on `shipping_banner` (p ≈ 10⁻¹¹, its assignments at p ≈ 0.56);
  - units, conversions, Wilson intervals, p-values and SRM chi-square matching an independent recomputation from raw `FINAL` rows;
  - viewer 403s, stale `If-Match` → 409, and key scoping.

  Timing checks are stall-aware (a 20 ms ticker detects host stalls and excludes overlapping samples); none were excluded in the final runs.
- **Simulator result** (4,000 visitors, seed 20261107):
  - `checkout_cta`: +56% relative lift among exposed visitors (p ≈ 10⁻⁷) vs +29% among everyone assigned.
  - `rewards_teaser`: ~480 exposed of ~3,900 assigned, no effect.
  - `shipping_banner`: exposed 57/43, SRM p ≈ 5·10⁻⁷, assignments balanced.
- **Screenshots:**
  - Console screens 01-10 were taken with `SCREENSHOT_FRONTEND_PORT=5175 node scripts/screenshots.mjs experimentation-platform` (no `--start`).
  - Storefront screens 11-16 come from `tests/demo-screenshots.mts`. It picks a visitor who is in treatment for all three experiments using the SDK core.
  - The live-clients screen was captured while three scratch SDK clients were connected, after a resume-then-kill of `promo_ribbon`.
  - All 16 files are byte-distinct.
  - Danger UI uses rose tones, so the harness's "Login error banner" check stays meaningful.
- **Smoke tests:** generated with `node scripts/generate-smoke-tests.mjs experimentation-platform`. They were run through a scratch shim re-exporting the root `playwright/test` via `NODE_PATH`, with `--browser=webkit`, `SMOKE_BASE_URL=http://localhost:5175` and `SKIP_WEBSERVER=1`: 10/10 passed.
