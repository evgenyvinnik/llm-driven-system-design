# Multi-Org Dashboard - Development with Claude

## Project Context

Entry 7 of [ROADMAP.md](../ROADMAP.md). It replaced the earlier "Workspace Permissions" plan and kept its scope. It is aimed at frontend design rounds: the console of a multi-tenant AI product where one user belongs to several orgs with a different role in each, features switch on per org and role, and access can change while a page is open. The prompt-sharing variant (prompts private, shared with roles, or shared by revocable link) is built as one module, the prompt library, behind the one seeded feature flag.

A July–November 2026 audit of this repository found that most multi-tenant projects had no real authorization: IDs from another tenant worked everywhere. So this build treats enforcement as the point. Every claim the interview answers make about access is backed by a test against real PostgreSQL and Valkey, or by the scripted browser check.

Everything here is a practice reconstruction with invented data (Relay, Lumen Outfitters, Harbor Health Co-op, the `@example.com` users). No text from candidate portals or third-party practice sheets.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | REST + one SSE stream per tab; `dev:server1..3` for 3001-3003 |
| Export worker | - | `backend/src/worker/index.ts` | Polls `export_jobs` with `FOR UPDATE SKIP LOCKED`; `dev:worker2` adds a second one |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to `API_TARGET` (default 3000) |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, then `npm run db:seed` (`-- --reset` to reseed) |
| Valkey 7 | 6379 | - | Service named `redis` in `docker-compose.yml` because the repo's scripts look for that name |

Host ports in `docker-compose.yml` are overridable (`POSTGRES_PORT`, `VALKEY_PORT`). This was needed on the build machine, where another project held 5432 and 6379; verification ran on 5442/6389 with the API on 3010 and the frontend on 5183.

## Development Phases

1. **Backend first, verified with curl and integration tests.** Access model as pure functions (`shared/permissions.ts`), the versioned permission cache (`shared/access.ts`), the single org route gate (`shared/org-access.ts`), then the routes, the member-removal cascade, the event hub and the export worker. Checked against the real database: manifest per org, 403 vs 404, flag and plan gating, version headers.
2. **Tests.** 69 mocked unit tests (every role x plan x flag-rule shape, the gate's status codes, cache vs authoritative reads, a route inventory that walks the Express stack, the event hub's filtering) and 13 integration tests that build their own two orgs and five users in the live database and try cross-org IDOR on every resource type.
3. **Frontend.** Org-scoped query keys, the per-visit abort and late-response drop, the module registry and `decide()`, guards, loss tracking, the virtualized history with a deep-linked pane, exports, settings, preview mode.
4. **Scripted two-user check** (`scripts/two-user-check.mjs`, Playwright against the running stack): switch orgs with a held response, flag turned off and role demoted while a page is open, removal with and without another org left, deep links, export progress. 24/29 on the first run; the five failures were one bug (log entry 1 below). 29/29 after the fix.
5. **Screenshots, smoke tests, docs.** 16 screens from `scripts/screenshot-configs/multi-org-dashboard.json` plus two captured by a one-off script (the access-changed panel and preview mode need a second actor mid-session, which the harness can't do). Smoke tests generated from the config: 16/16. Then architecture.md and the three answers; writing the frontend answer against the code exposed two small gaps (log entries 4 and 5).

## Key Implementation Decisions (and why)

Build-time choices that architecture.md doesn't explain.

- **TanStack Query, unlike prompt-playground.** There, server state was small and page-scoped. Here the whole problem is a cache that holds several tenants' data: key scoping, cancellation on switch, removing everything for one org, and cursor pages for history are exactly what the library does. Every key comes from `lib/keys.ts` and starts with `['org', orgId]`, and a test asserts it.
- **The switch happens in the org route's `beforeLoad`, not in an effect.** Child effects run before parent effects in React, so an effect in the org layout would set the active org *after* the new pages had already started their requests. `beforeLoad` runs before any of them mount.
- **The org layout's subtree is keyed by org ID.** The same route component serves both orgs, so without the key a half-filled "New agent" form (with a project ID from the old org) would survive a switch.
- **`placeholderData` checks the org.** Keeping the previous rows while new filters load is good UX, but the previous query can belong to the previous org when the route component stays mounted across a switch. The function only keeps data whose key has the same org.
- **The export queue is the `export_jobs` table**, not RabbitMQ or a Valkey stream. Jobs are rare and long; PostgreSQL already holds the job's state, the lease and the fencing condition, so a broker would only duplicate them.
- **Roles are fixed in code** (`ROLE_PERMISSIONS`). Custom roles would move the table into PostgreSQL; the client never reads role names for decisions, only permissions, so it wouldn't change.
- **One event stream per tab for all orgs**, multiplexed per API instance on one Valkey pattern subscription. Switching orgs never reconnects, and an export finished in another org can still notify. That is the multiplexed reader prompt-playground lists as an open question.
- **Sharing a prompt doesn't bump the org's authz version.** It's a change to one resource; bumping would refetch every member's manifest on every share click. The resource's own query returns 404 on its next fetch instead.
- **Org IDs are readable text (`org_lumen`)**, validated by pattern before any query, so a malformed ID is a 404 that never reaches PostgreSQL.

## Iteration & Repair Log

1. **Manifest refetch loop (11,000+ requests in a few seconds).** Found by the scripted check: after a flag change, open pages never closed. The manifest response carried `X-Authz-Version`, and the client's rule "a response with a newer version than my manifest means refetch the manifest" fired on the manifest response itself, before its body was stored. That invalidated the query, which cancelled the very fetch that would have caught up, and started another, forever. Fix in `services/api.ts` and `services/wiring.ts`: the manifest's own response doesn't report its version, and invalidations use `cancelRefetch: false`, so they join a refresh in flight instead of restarting it.
2. **Detail pane squeezed the history table into overlapping columns** at narrow widths. With the pane open the table now shows a compact column set (started, subject, status).
3. **Smoke tests: strict-mode locator violations.** `[data-conversation]` matches every row, and Playwright's `toBeVisible` refuses multi-element locators. The config's `waitFor` uses `[data-conversation] >> nth=0`, which works for both the screenshot harness and the generated tests.
4. **The access-changed panel didn't move focus**, though the frontend answer said it did. It now focuses its heading on mount, so the reason is read out when a page closes.
5. **Only the manifest was `no-store`.** The gate now sets `Cache-Control: private, no-store` on every org-scoped response, so tenant data never sits in a browser or shared cache for the next person at the desk.
6. **Integration test flake (1 in 4 runs).** Two causes, both in the test. The login rate limit (20 per minute per IP) tripped when the suite ran back to back, so each run now signs in from its own `X-Forwarded-For` address. And the live dev worker sometimes claimed the test's queued export before the removal ran, so the export is now inserted as already running under a lease held by a fake worker, and the test asserts the cancel flag rather than a final status.

## Verification Environment Notes

- Docker Desktop on macOS, run alongside another session's stack, so all host ports were moved (see the table above). Nothing in the repo depends on those ports.
- The screenshot harness ran without `--start` (it kills processes on the configured ports, which could have hit another project's servers), against the already-running frontend via `SCREENSHOT_FRONTEND_PORT=5183`. Smoke tests ran with a temporary Playwright config overriding `baseURL`, for the same reason.
- `scripts/two-user-check.mjs` mutates data (roles, removals, flags, an export). Reseed with `npm run db:seed -- --reset` before screenshots.

## Open Questions / Next Steps

- **Version-bump stampede.** A flag change in a large org makes every open tab refetch its manifest at once, all cache misses. Add 0–3 s client jitter and coalesce recomputation per user on the server.
- **Prefetch on hover** in the org switcher, so a switch shows the new org's shell instantly instead of a loading state.
- **BroadcastChannel leader tab** to hold one event stream for all tabs and dedupe toasts.
- **Request access** only writes an audit event; it should notify the org's admins.
- **Custom roles and per-project roles** (`project_memberships` currently only grants visibility of restricted projects; it carries no role).
- **Support impersonation** distinct from admin preview: a staff session acting as a specific user, time-limited, with the real actor on every audit event.
- **Object storage for exports** with short-lived signed URLs, and a retention sweep; files are on local disk today and never deleted.
- **Search across conversations** beyond `ILIKE` on subject and customer: a search index, with the list API's cursor becoming the index's search-after value.
