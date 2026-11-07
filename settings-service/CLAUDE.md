# Settings Service - Development with Claude

## Project Context

**Prompt.** An application already has a preferences screen. Design the APIs and the server side it needs to work correctly: persistence, validation, and sync across tabs and devices.

**Signal.** ROADMAP #3. A candidate report attributed to OpenAI: the candidate was handed an existing preferences UI and asked to design its APIs and server side. It is self-reported and not verified. The trap named in the roadmap is overengineering a small system while leaving the basic update semantics ambiguous. So the **backend contract is the product**: exact per-key PATCH semantics, effective-value resolution, validation, and sync. The architecture stays deliberately modest.

Requirements added by the coordinator on top of the roadmap bullets, all implemented, demonstrable in the UI and covered by tests:

1. Every read returns `{ value, source, locked }` per key. Org enforcement changes push live, and the locked control updates without a reload.
2. Per-key PATCH: different keys from two devices both succeed. Same-key conflicts use a per-user revision counter plus per-key changed-at revisions and `If-Match`; a stale same-key write gets `409` with the current state. A write to an enforced key is rejected with a per-field error.
3. Validation per definition. Unknown keys get `422` per field; deprecated keys are accepted and ignored with a warning inside a grace window. Definitions are added at runtime with no backfill.
4. BroadcastChannel plus SSE invalidations keyed by revision, fanned out across **two API instances** through Valkey pub/sub. A revision gap triggers a refetch.
5. A dev chaos switch that drops the next PATCH response after commit (an armed count), so the UI shows "outcome unknown → refetch → reconcile".
6. The "given" preferences screen, an org policy admin screen, a catalog screen, and a two-devices demo view. Two orgs, seven users.
7. The storage trade-off (typed columns vs a JSON document vs key-value rows) documented and the chosen option implemented.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API instance A | 3000 | `backend/src/api/index.ts` | `npm run dev` starts A and B (`INSTANCE_ID`, `PORT`) |
| API instance B | 3001 | same | The two-devices view talks to B through `/api-b` |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` (A) and `API_TARGET_B` (B) override |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed`; host port via `SETTINGS_PG_PORT` |
| Valkey 7 | 6379 | — | Sessions, chaos counter, pub/sub channel `ss:events`; host port via `SETTINGS_VALKEY_PORT` |

Code map:

| Concern | Files |
|---------|-------|
| The contract (pure) | `backend/src/domain/resolve.ts`, `patch.ts`, `validate.ts` (+ tests) |
| Transactions | `backend/src/services/settings-service.ts`, `policy-service.ts`, `catalog-service.ts` |
| Catalog cache | `backend/src/services/catalog.ts` |
| Fan-out | `backend/src/shared/events.ts` (publish), `backend/src/api/live.ts` (subscribe, filter, write) |
| Chaos | `backend/src/shared/chaos.ts`, used in `api/routes/settings.ts` |
| Client sync rules (pure) | `frontend/src/lib/sync-rules.ts` (+ tests) |
| Client store and write queue | `frontend/src/lib/settings-store.ts`, `live-sync.ts` |

## Development Phases

1. **Contract first.** The domain types, the resolution rule and the PATCH decision table as pure functions, with 40 unit tests before any I/O. Settled here: equal-value-before-conflict ordering, tombstones, atomic patches, precedence 400 → 428 → 412 → 422 → 409 → 200.
2. **Schema and services.** `init.sql` (key-value rows, revisions, tombstones, change log); the PATCH transaction with a user-row lock; snapshot reads; org policy with the same If-Match contract; catalog create and deprecate.
3. **Fan-out and chaos.** Valkey pub/sub with per-stream filtering, `hello` with revisions, the catalog cache with TTL, invalidation and reload-on-unknown, and the Lua take-one chaos switch.
4. **HTTP contract tests** (supertest, mocked services): status codes, headers, envelopes, access, the dropped socket.
5. **Frontend.** A settings-client factory (server document + pending map + write queue + live sync), catalog-driven controls, source badges and lock explanations, live appearance via CSS variables, then the two-devices view, policy and catalog consoles.
6. **Live verification.** A 75-check end-to-end script against two running instances, a Playwright script for live UI behaviour (BroadcastChannel, live lock, live new definition), screenshots, smoke tests. Repairs are listed below.
7. **Docs.** Architecture and the three answers.

## Key Implementation Decisions (and why)

- **Key-value rows storing only explicit choices.** A new definition needs no backfill, each row carries its own changed-at revision, and the org overlay has the same shape. Typed columns would need a migration per setting; a JSON document hides per-key versions and defaults inside a blob.
- **One revision in If-Match, compared per key.** The client sends the document revision it read. The server rejects a key only if that key's `rev` is newer. This avoids the false conflicts of a whole-document ETag without making clients track per-key versions.
- **Equal value is a no-op, checked before the conflict.** PATCH sets values, so a retry after a lost response (carrying the old If-Match) returns 200 `unchanged` instead of a false 409. No idempotency-key table.
- **Tombstones on reset.** `value = NULL` keeps `rev`, so reset-then-set can't look unchanged to a stale client (ABA). Covered by a unit test and an e2e check.
- **Missing If-Match is 428; `If-Match: *` is the explicit opt-in to last-write-wins.** Never an implicit overwrite.
- **Enforcement shadows instead of overwriting**, and the response carries `userValue`, so the UI can say the user's own choice is kept. A user write to an enforced key is rejected (`LOCKED`) rather than silently stored.
- **Snapshot reads (`REPEATABLE READ READ ONLY`).** Otherwise a client could pair revision N with values from N-1, then ignore event N as already seen.
- **User events carry a delta plus the org and catalog revisions it was resolved against.** The client applies only at held + 1 with matching org and catalog revisions; anything else is a refetch. Org and catalog events are invalidations, with jitter.
- **The SSE client registers before reading revisions for `hello`.** An event committed in between is then delivered (possibly ahead of hello) instead of falling into a gap.
- **Catalog cache: TTL + pub/sub invalidation + reload on unknown key.** A definition created a moment ago on the other instance is never rejected with `UNKNOWN_KEY`. The e2e script writes a brand-new key on instance B right after creating it on A.
- **Chaos switch in Valkey, per user, armed count.** It works whichever instance receives the PATCH, and parallel demos don't interfere. It's consumed with a Lua take-one, so exactly N responses are dropped.
- **Client: server document + pending map, one PATCH in flight.** Every server answer maps onto a key's pending entry (cleared, conflict, error, unknown). The queue stops a fast toggle from conflicting with its own first write.
- **Two simulated devices on different instances.** The Vite proxy maps `/api-b` to instance B, so every cross-device change in the demo crosses instances through Valkey, and the sync log says "via SSE on api-b, written on api-a".
- **CSS variables for theme surfaces.** The user's theme setting swaps one token set (`:root.dark`), with Tailwind `dark:` variants only for a few accent chips.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ / Kafka | Valkey pub/sub | Events are hints; revalidation repairs loss, so durability buys nothing |
| `postgres:16` image | `postgres:16-alpine` | The full image's pull stalled on the shared verification machine; the alpine image was already cached. Functionally identical |
| TanStack Query | Zustand vanilla stores + pure sync rules | Per-key pending state and a merged write queue don't map onto per-request mutations |
| One API on 3000 | `npm run dev` starts two instances (3000, 3001) | Cross-instance fan-out is a core requirement, so it's always exercised |
| Frontend without tests | `vitest` for `lib/sync-rules.ts` | The client sync rules are part of the contract |

## Iteration & Repair Log

Bugs and rough edges found by running the stack, in order:

1. **BroadcastChannel ping-pong (caught in review before it shipped).** `adopt()` broadcast every adopted document, including ones that had just arrived from another tab, so two tabs would have echoed forever. Documents from other tabs are now adopted with `fromTab` and never re-broadcast, and a document is broadcast only when its revisions moved.
2. **The catalog cache couldn't go backwards.** The first version refused to replace a cached catalog with a lower revision, so after a reseed (or a restore) an instance would have kept the old catalog forever. Ordering is now by load start sequence: the read that started last wins.
3. **Slider for a 30-3650 range.** Message retention and session timeout rendered as unusable sliders. Integer settings with a range over 200 now get a number field.
4. **Reset button on a deprecated row**, which would send a write that is only ignored. It's now hidden for deprecated keys.
5. **Catalog table clipped the Deprecate button** at 1440 px. Type and rules are merged into one column.
6. **Duplicate `instance` field** in the startup log line (the logger base already carries it).
7. **Verified, not a bug: the Vite proxy turns a destroyed socket into a plain 500.** The client classifies anything without the error envelope as "outcome unknown", so the chaos path works the same through the proxy (500) and directly (connection reset).
8. **Verified ordering: the SSE echo of a write usually arrives before its PATCH response.** The echo is applied as a delta (N+1), the response is adopted as equal-or-newer, and the pending edit is cleared once the confirmed value matches. The sync log in the screenshots shows this order.

## Open Questions

- **Per-device settings** (e.g. "mute notifications on this phone only"): a third scope between org and user, keyed by an install id. Resolution would grow one layer.
- **Translating deprecated keys** onto their replacement (`compact_mode: true` → `density: compact`) instead of ignoring them. This needs a mapping function per deprecation; worth it only for high-traffic keys.
- **Leader-tab election** (Web Locks) to hold one stream per browser instead of one per tab.
- **Transactional outbox** instead of publish-after-commit, to shorten staleness during a Valkey outage.
- **Org events carrying org rows** so clients can re-resolve locally instead of refetching. That matters only for very large orgs.
- **Cleanup of retired-key rows** and expiry of `setting_changes`.

## Verification Environment Notes

- Verified with Docker on non-default ports, because other agents shared the machine: PostgreSQL on 5442, Valkey on 6389 (`SETTINGS_PG_PORT=5442 SETTINGS_VALKEY_PORT=6389 docker compose up -d`), API instances on 3010 and 3011 (`INSTANCE_ID=api-a PORT=3010`, `INSTANCE_ID=api-b PORT=3011`), frontend on 5174 (`VITE_PORT=5174 API_TARGET=http://localhost:3010 API_TARGET_B=http://localhost:3011`).
- Screenshots: `SCREENSHOT_FRONTEND_PORT=5174 node scripts/screenshots.mjs settings-service` (without `--start`, which kills whatever listens on the configured ports). The capture order matters: 05 and 06 write to alice's settings. Reseed before re-capturing so the conflict step starts from the seeded revision.
- Smoke tests: the root `playwright` (1.57) couldn't launch Chromium on this machine (its headless-shell build wasn't installed), but WebKit works. The generated spec was run unchanged from a scratch runner with `@playwright/test@1.57.0` and a WebKit project: 8/8 passed.
- Every SSE-holding page makes the screenshot harness wait ~30 s for `networkidle` before it falls back. Expected, not a hang.
- Stop servers by port (`lsof -ti tcp:3010 -sTCP:LISTEN | xargs kill`), not by process name: other projects use the same entry paths.
- `npm run db:seed` truncates every table and deletes `ss:*` keys with SCAN + DEL. Running instances pick up the reseeded catalog within the 30 s TTL (or immediately on an unknown key).
