# CLAUDE.md — Splitwise

Iteration history and the "why" behind key decisions. Design rationale lives in [`architecture.md`](./architecture.md); this file captures how the project came together and what was tried.

## What this is

A shared-expense tracker (groups → expenses → balances → simplify debts → settle up), built full-stack to study money-safe math, derived-vs-stored balances, a real graph algorithm behind a product feature, and a state-heavy React interaction (the split editor). It complements the existing **Venmo** project without overlapping: Venmo *moves* money (P2P transfers, wallet); Splitwise *tracks shared cost* and only *records* that money moved.

## Build phases

1. **Grounding in existing patterns.** Modeled the backend on `venmo/` — the same `routes / services / shared / db` layout, session auth via `x-session-id`, Pino logger, `prom-client` metrics, and the idempotency middleware (Redis `SET NX` + a Postgres partial-unique backstop). Frontend follows the repo defaults: Vite + React 19 + TanStack file-based routing + Zustand + Tailwind, icons as separate files with a barrel export.
2. **Data model.** Settled on `groups / group_members / expenses / expense_splits / settlements / activity_log`. The central choice: **do not store balances.** Store the immutable ledger; derive everything.
3. **Split engine** (`services/splits.ts`). Integer cents + largest-remainder allocation so Σ(splits) always equals the total across all four modes.
4. **Balance engine** (`services/balances.ts`). Net-per-member aggregation, greedy min-cash-flow simplification, per-group and cross-group (friend) balances, Redis cache with write-invalidation.
5. **Routes + seed.** Six route modules; a TypeScript seeder with rich demo data across all four split types and a settlement, using fixed UUIDs for the demo groups so screenshot/demo deep-links are stable.
6. **Frontend.** Dashboard, groups list, group detail (ledger + balances/simplify panel), activity. The **split editor** got the most attention — see below.
7. **Verification.** Type-checked backend, built the frontend, brought up Docker, migrated + seeded, and smoke-tested the API and every screen with Playwright (Chromium). Confirmed: balances sum to zero, simplification stays within n−1 transfers, idempotent double-submits create one row, `$10/3` → `334+333+333`, bad splits 400.

## Key decisions & the "why"

- **Derived balances, not stored.** A stored running total is a second source of truth that drifts after any edit/delete/bug, and then you can't tell which number is right. Deriving makes zero-sum correctness structural; a Redis cache (invalidated on write) buys back the read cost. This is the project's spine.
- **Integer cents + largest-remainder rounding.** Floats drift; naive integer rounding orphans pennies and breaks Σ(splits)=total. Largest-remainder distributes leftover cents deterministically. The client re-implements the *same* function so the split preview equals what the server stores.
- **Debt simplification = greedy min-cash-flow.** Exact minimization is NP-hard (partition); greedy is O(n log n), ≤ n−1 transfers, optimal in the common case, and always trustworthy — right for an instant UI. A `debt_simplify_duration` metric would surface any pathological case.
- **Settlements record, don't transfer.** Splitwise's real product integrates payment providers; modeling settlements as ledger entries (not money movement) keeps scope honest and mirrors the real system.
- **Idempotency on the money-adjacent writes** (add expense, settle up): client-generated key + Redis NX + PG partial-unique. Verified end to end.
- **Tiny global state.** Only auth is global (Zustand). Every page owns its data and refetches after writes — fewer cross-screen desync bugs. Balances are always refetched (never optimistically patched) because they must be right.

## The split editor (frontend centerpiece)

One `userId → { selected, exact, percent, shares }` map, one pure `computeOwed()` reducer returning per-person cents + a validation message, run in `useMemo`. Switching split modes keeps all entered data (just reads a different field). The Save button is disabled until the split is valid; the live banner shows "$X left to assign" / "adds up to 96%" / "ready to save ✓". Sharing the allocation math with the backend means the preview is exact, not approximate.

## What was simplified vs. production

- Single Postgres (not sharded by `group_id`), single Valkey (not clustered).
- Activity feed written inline in the expense transaction instead of via Kafka fan-out.
- Friend (cross-group) balances computed on read; at scale they'd be a maintained per-user aggregate.
- Session auth (not OAuth), DiceBear avatar URLs (not uploads), settlements recorded (not executed).

## Demo

Login: `alice@example.com` / `password123` (also bob/carol/dave/emma). Seeded groups: **Roommates** (equal splits + a settlement), **Tahoe Trip** (all four split types — equal, shares, exact, percentage), **Friday Lunch Crew**. Fixed group UUIDs (`11111111-…`, `22222222-…`, `33333333-…`) keep screenshots reproducible.

## Open ideas / next steps

- React Query for unified server-cache + mutation invalidation.
- Multi-currency (per-expense currency, per-currency balances, display-time conversion).
- Expense edits (versioned rows; balances just re-derive) and "simplify off" pairwise mode.
- Itemized splits ("who had the appetizer") — the per-member map generalizes to per-item.
- Virtualize the ledger and add a service worker for offline (queued writes are safe to replay — each carries an idempotency key).
