# Storage Remediation - Development with Claude

## Project Context

**Prompt:** "Design a system that finds and fixes security misconfigurations across tens of thousands of cloud storage accounts in an enterprise (public blob access, shared-key/SAS authentication, TLS below 1.2, open network access, missing soft delete or diagnostics) without breaking the applications that depend on them."

**Signal and sources.** The project is also the repository's worked example of the **existing system review** round, where a candidate presents a system they built and defends its architecture, trade-offs, scale, production issues, monitoring and improvements. That round has been reported in BNSF Railway interview loops by candidate reports and preparation guides. **Not verified**: the reports were not independently checked, and the round format may vary by team. Treat it as a practice target, per the labels in [ROADMAP.md](../ROADMAP.md#about-the-sources). The storage prompt itself is a practice extension built for that round, using Azure-shaped concepts because that is the platform the practice targets.

The design is in [architecture.md](./architecture.md); the round itself is in [existing-system-review.md](./existing-system-review.md). This file records how it was built, what changed along the way, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| Cloud simulator | 3100 | `backend/src/cloud-sim/index.ts` | ARM-shaped API over a generated fleet; state in `.sim-state/fleet.json`; `/admin` for faults |
| API | 3000 | `backend/src/api/index.ts` | Sessions, posture, findings, campaigns (SSE), exceptions, controls, audit |
| Scanner | 3200 | `backend/src/scanner/index.ts` | Full scans, change feed, evidence, owner workflow, posture snapshots |
| Executor | 3300 | `backend/src/executor/index.ts` | Coordinator, worker slots, verifier; `dev:executor2` for a second instance |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` (target and port overridable with `VITE_API_TARGET`, `VITE_PORT`) |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | - | Service named `redis` in docker-compose because the repo scripts look for that name |

## Development Phases

1. **Domain first, as pure modules.** Controls (versioned, each with read, judge, desired and restore), evidence classification, risk, wave planning, the bake-time rollback decision, exception rules. All unit-tested before any I/O existed.
2. **The simulated cloud.** A deterministic fleet generator (1,500 accounts, 50 subscriptions, callers per account consistent with its config), then ARM semantics: etags and If-Match, per-subscription token buckets answering 429 with Retry-After, a Resource Graph quota and lag, a change feed with an expiring cursor, 5xx on writes (half of them applied anyway), policy effects, synthesized StorageBlobLogs rows and Transactions metrics derived from the same callers. Planted: quarter-end jobs whose last run is outside the 30-day window.
3. **Inventory and evaluation.** Version-guarded upserts, batched findings writes, evidence, the owner workflow and exception expiry. The seed runs the first scan in-process against the same fleet through an in-process control plane, so the dashboard has data before any service starts.
4. **Executor.** PostgreSQL target store with leases and fences, Valkey token buckets, apply and verify, the coordinator and reconciler, the stream queue. Exercised end to end with curl: a shared-key campaign over non-production (three automatic rollbacks, auto-pause), a fleet-wide soft-delete campaign under tight throttling, and a crash right after a write.
5. **API and tests.** Routes, the campaign service, SSE with Last-Event-ID; supertest tests with mocked shared modules.
6. **Mid-build requirements from the coordinator.** Re-read and revalidate before every write with a deliberate decision after a 412 (recompute, skip or escalate, plus a new `escalated` state), an operation ID per write recorded before the call, reconciliation of timeouts against actual state, bounded throttle retries with growing back-off, separate data-plane (Log Analytics) limits, and a stricter structure for the review document.
7. **Frontend.** Posture, findings, account, campaigns (live), exceptions, controls, audit. Driven through all three roles with Playwright, screenshots reviewed one by one.
8. **Docs.** architecture.md, the three answers, existing-system-review.md, README, this file. All numbers in the docs come from the local runs and are labelled measured or illustrative.

## Key Implementation Decisions (and why)

Build-time choices that aren't obvious from architecture.md.

- **A simulator, not mocks.** The hard parts (etag conflicts, ambiguous 5xx, throttling herds, Resource Graph lag, a dependency the logs missed) only show up against something with real state and real time. The simulator is a separate process with persisted state so killing the executor doesn't reset the cloud.
- **The same ControlPlane interface over HTTP and in-process.** The seed scans the fleet in-process with the simulator's own semantics, and executor tests run against the real fleet logic with a controllable clock instead of hand-written fakes. The crash test (`afterWrite` throws) and the 412 tests exercise the simulator's actual etag code.
- **The simulator evaluates policy with the remediation system's own control code.** Simpler than a second rule engine, at the price that policy and evaluation can't disagree locally. architecture.md calls that out, because in production a disagreement is a useful signal.
- **Periodic jobs fire during the bake (a fault switch).** A quarter can't fit in a demo. The switch makes the incident reproducible and is documented as compression, not realism; the real lesson (a bake window shorter than a job's period can't catch it) is in the docs.
- **The queue is a hint.** Valkey stream messages carry only target IDs. Every decision is a conditional UPDATE on `(id, fence, state)` in PostgreSQL, and the reconciler re-sends from the table, so a reseed that deletes the stream (and the consumer group) costs nothing; workers recreate the group on `NOGROUP`.
- **AIMD in the bucket after measuring the herd.** The first throttling run used fixed-rate buckets and produced 643 429s for 729 writes: every target deferred by a Retry-After block became due when it lifted. Halving the rate on each 429 and adding back 2% per granted token brought it to 220 for 753, with the same simulator limit.
- **Account names in URLs** (`/accounts/$name`). Storage account names are globally unique, and ARM IDs with slashes in a path segment are fragile through proxies.
- **No chart library.** Two small SVG components (a single-series burn-down with a crosshair tooltip, and sparklines as small multiples) following the repo's data-viz guidance; the three evidence colors were run through the palette validator (all checks pass; the aqua slot is under 3:1 on white, so it always has a text label).
- **No TanStack Query**, as in the templates: the only live object is a running campaign, which needs stream semantics (snapshots plus deduped events), so a hook owns it and pages fetch directly.

## Deviations from Repository Defaults

- **Database credentials** are `remediation` / `remediation_password` / `storage_remediation` rather than `user` / `password`, because `user` is a reserved word in PostgreSQL and makes native setup awkward (in-app-assistant deviates the same way). `scripts/screenshot-configs/storage-remediation.json` sets `dbUser` and `dbName` accordingly.
- **Frontend ESLint**: `react-refresh/only-export-components` is off for `src/routes/**`, because TanStack file routes export a `Route` object next to the component and the router plugin handles their HMR. The template projects have the same pattern without the override.
- **Four backend processes** instead of the usual API plus worker: the simulator, scanner and executor have different scaling and failure behavior, and the crash test needs the executor killable on its own.

## Iteration & Repair Log

Bugs and corrections found by running things, in order:

1. **The generator built callers its own config already broke.** A SAS "HTTP uploader" on accounts with shared key disabled, then (after the first fix) an anonymous one on accounts with public access off. Caught by a unit test asserting no generated caller is blocked; fixed by noting that bearer tokens require HTTPS, so plain-HTTP callers exist only where SAS or anonymous access is allowed.
2. **Throttling herd.** 643 429s for 729 writes under a tight limit (see AIMD above).
3. **Unbounded throttle retries.** A 429 deferred the target without counting, so a persistently throttled subscription retried forever. Added `throttle_count`, a bound of 12, and back-off that grows with consecutive throttles (`domain/revalidate.ts`).
4. **The seed got slow** (2 s → 22 s) after the simulator gained a Log Analytics quota: the in-process seed was throttling itself. The seed now relaxes the simulator's read, graph and log limits for its own in-process scan.
5. **A test expected 409 for a repeated transition.** The API correctly returns `changed: false`; the test now checks an invalid transition instead.
6. **The throttling-bound test passed for the wrong reason at first.** Honoring Retry-After exactly meant a token was available and the write succeeded. The test now stubs a platform that stays throttled (other automation sharing the budget).
7. **Rollbacks were buried** under routine verifications in the campaign's recent-targets table. Problem rows (rolled back, failed, escalated) now sort first; rolled-back rows show the full round trip (`true → false → true (restored)`).
8. **Awkward chart ticks** (5,695, 4,271…). The burn-down uses nice round steps.
9. **Reconciled outcomes were invisible.** The counter row showed "recovered" but not writes confirmed after a 5xx or timeout; it now shows both as "reconciled".
10. **The version guard looked unused** in the first runs (`staleSkipped: 0`) because scans ran after the graph lag had elapsed. A forced scan one second after an owner's change skipped exactly one stale row and kept the fresher ARM read.

## Verification Environment Notes

- Verified on Linux with native PostgreSQL 16 (`initdb` as the `postgres` user, port 54333) and redis-server 7.0 (port 63833), Node 22. Services on 3301-3304, frontend on 5193, all through environment variables; project defaults stay on the repo's conventional ports.
- No `ss` on the machine: processes were stopped by their listening port (`lsof -ti tcp:PORT -sTCP:LISTEN`) after checking the command line pointed at this project, never with broad `pkill` patterns, because other agents' services shared the machine.
- **The scratchpad was shared with other agents.** A generically named `env.sh` written for this project overwrote another agent's file of the same name, which briefly pointed that agent's API at this project's database (its migrations rolled back; this database was untouched). Helper files for this project now live in a `storage-remediation/` subfolder; use project-specific names in shared scratch space.
- Playwright: Chromium was preinstalled and `require('playwright')` resolved from the machine's global tools; screenshots at 1440×900, device scale factor 2. `tests/smoke.spec.ts` follows the repo's generated-smoke-test shape.

## Open Questions / Next Steps

- **Metrics as the first evidence tier.** Transactions split by authentication type (93-day retention, no diagnostic setting needed) would have caught the quarterly job; not simulated yet.
- **One breaking change per account across controls**, not only per control, so every regression is attributable.
- **Diff-only findings writes.** Every evaluation pass rewrites every open finding; fine at 1,500 accounts, the first database pressure point at fleet scale.
- **Per-scope posture history** (team, management group) so owners see their own trend, not the fleet's.
- **Policy exemptions mirrored from exceptions**, resource locks in the simulator (403 ScopeLocked), and a two-person rule for production waves.
- **Multiplexed SSE readers**: one Valkey subscription per campaign per API instance instead of one blocking read per viewer.
