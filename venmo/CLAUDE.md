# Venmo — P2P Payments — Development with Claude

## Project Context

A peer-to-peer payment app with a social layer: send and request money, fund from a balance/bank/card waterfall, cash out, and see a friends' feed of transactions with notes, likes, and comments. The defining tension is that it's **two products with opposite consistency requirements bolted together** — the money movement demands strict serializability (a negative balance is a company-ending bug), while the social feed wants cheap, eventually-consistent reads at high fan-out.

**Learning goals:** atomic wallet transfers under concurrency, idempotency for retried money operations, a multi-source funding waterfall, and fan-out-on-write social feeds — all on a single relational store.

## Architecture at a Glance (what actually runs)

Matches `docker-compose.yml` (two services) and `backend/package.json` — no queue, no WebSocket:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** | `pg` | Everything durable: wallets, transfers, requests, cashouts, feed_items, friendships, likes/comments, audit_log | One ACID store makes the locked-transfer + same-transaction fan-out easy to reason about |
| **Redis / Valkey** | `ioredis` | Session store, balance cache, idempotency fast-path | Sub-ms revocable sessions; cache the balance so reads don't fold the ledger |

**Money is integer cents** everywhere (`wallets.balance`, `transfers.amount`) — never floats. Single Express API (`backend/src/index.ts`) with routes `auth`, `transfers`, `requests`, `wallet`, `paymentMethods`, `friends`, `feed`. Shared modules under `backend/src/shared/`: `idempotency`, `audit`, `circuit-breaker` (hand-rolled, not Opossum), `retry`, `metrics` (prom-client), `logger` (pino), `archival`. **Frontend:** React 19 + TanStack Router + Zustand, routes for pay / request / wallet / profile / feed.

## Key Design Decisions

### 1. Pessimistic row locking on wallets, not optimistic versioning
`executeTransfer` runs inside a `transaction()` and takes `SELECT … FOR UPDATE` on the sender's (and receiver's) wallet before touching balances. Contention here is *per-sender* — a user's own concurrent sends are exactly the double-spend case that must be serialized anyway — so there's no parallelism for optimistic locking to preserve, and the correctness argument becomes trivial: the DB won't let two transactions hold the same wallet row. Trade-off: a hot receiver (a business taking thousands of payments) serializes on its row; the production fix is lock-free append-only credits with an async-materialized balance.

### 2. Two-layer idempotency (Redis fast-path + DB unique index)
Every transfer carries an idempotency key. The DB has a `UNIQUE (sender_id, idempotency_key)` index and `executeTransfer` also re-checks for an existing transfer *inside the transaction*, returning the cached row (`_cached: true`) on a hit. The shared Redis idempotency module catches most retries before any DB work. Trade-off: the two layers fail differently on purpose — Redis is fast but ephemeral, the unique index is the durable backstop when Redis is cold.

### 3. Funding waterfall, computed inside the lock
`determineFunding` resolves the source in priority order: balance → default verified bank → any verified bank → verified card, running while the wallet row is locked so the decision can't race a concurrent debit. Notably the sender is debited only for the *balance* portion while the receiver is credited the full amount — external (bank/card) money is simulated as entering from outside. Trade-off: crediting before ACH settles is a credit-risk decision, not just routing; the app accepts it (as real Venmo does) rather than holding funds for days.

### 4. Fan-out on write to `feed_items`, after commit
When a transfer completes, `fanOutToFeed` inserts feed rows for the sender, receiver, and the accepted-friends of both (private transfers go only to the two participants). This works precisely because Venmo is a **friend graph, not a follower graph** — fan-out is bounded, so the pattern that kills Twitter can't occur. Trade-off: privacy is resolved at fan-out time (one decision point, read path can't leak), so a later public→private edit isn't retroactive without a tombstone check. Fan-out failure is caught and logged, never rolls back the money.

### 5. Append-only audit log for compliance
Every money movement writes an immutable `audit_log` entry (`audit.ts`: actor, action, resource, IP, request ID, outcome). Holding balances makes this a regulatory requirement, not a nicety. Trade-off: extra write per transfer, justified by money-transmitter obligations.

## Current State

Implemented end to end: session auth (Redis, 24h TTL) with a payment PIN hash, atomic P2P transfers with locking + idempotency + funding waterfall, money requests with approve/decline that execute as a real transfer (linked via `transfers.id`), instant/standard cashout, payment-method linking (stored as tokens / encrypted, last-4 surfaced), friendships, the social feed via fan-out-on-write with public/friends/private visibility, likes and comments, balance-cache invalidation, a hand-rolled circuit breaker around external calls, retry helper, Prometheus metrics, pino logging, and the audit log.

Schema-present but not wired as features: **bill splitting** (`splits` / `split_participants` tables exist, no route yet). Intentionally omitted: fraud/velocity scoring, recurring payments, QR-code pay, real ACH/card integration, and any message queue (fan-out is synchronous within the request in local scale).

## Iteration & Repair Log

- **DB migrate + seed path** (`backend/src/db/migrate.ts`, `seed.ts`, `db-seed/seed.sql`): schema applies via `npm run db:migrate` and demo users via `npm run seed`; docker-compose runs Postgres + Valkey only.
- **Seed password normalization (repo-wide):** demo users `alice / bob / charlie / diana / admin` all log in with **`password123`**; README table matches. `bcryptjs` is the verify path (not native `bcrypt`).
- **Answer-file depth pass:** `system-design-answer-backend.md` was ~232 lines (under the 300 floor); added grounded sections for the request/approval and cashout flows, security/auth, capacity estimation, an exactly-once recap, and a metrics table to bring it into range without diluting the existing (strong) deep dives.
- **Doc drift fixes (this pass):** the old CLAUDE.md used banned Phase-1/2/3/4 checklists and referred to `transfer.js` — the code is TypeScript (`backend/src/services/transfer.ts`). Rewritten to real architecture + decisions; file references corrected. Verified `architecture.md` already frames RabbitMQ/Cassandra correctly as *production* extensions while the local build does synchronous Postgres fan-out — left as-is.
- **2026-08-03 — 1 of 5 screens captured; the seed never ran and login could never succeed.** Three faults:
  1. **48 seed UUID literals carried a mnemonic prefix** (`pm-`, `tr-`, `pr-`, `tc-`, `co-` glued onto a UUID), making them three characters too long and non-hex. Postgres rejected them outright. Folded each prefix into the first group as a distinct hex tag so values stay unique and every foreign-key reference rewrites identically.
  2. **12 more were not UUID-shaped at all** — `fi-01-alice` and friends sitting in UUID columns. Mapped each to an md5-derived UUID so the mapping is stable across re-seeds and all references agree.
  3. **The login form is a single "Username or Email" `type="text"` field**, but the screenshot config searched for `input[name='email'], input[type='email']` — which matched nothing, so every authenticated screen failed on a selector timeout. Config corrected, and the inputs were given proper `name`/`autoComplete` attributes (`Input` spreads props, so this is free and makes the form autofill-friendly as well as testable).
- **Screenshots:** 1 → 5 (login, social feed with likes/comments, pay, request, wallet).
- **CI note (repo-wide):** the GitHub Actions smoke-test workflow was removed; don't treat it as active.

## Open Questions

1. Wallet locks serialize a hot receiver — at what payments-per-second on one account do we need lock-free append-only credits with an async-materialized balance?
2. External funding credits the receiver before ACH settles. Without fraud/velocity scoring in place, what trust threshold should gate fronting money vs. forcing instant card funding?
3. `feed_items` grows ~400 rows per public transfer. At what row count does time-partitioning + TTL stop being enough and the Cassandra migration become mandatory?
4. Bill splitting has tables but no route — should a split be modeled as N linked payment requests, or its own settlement state machine?

## Resources

- [Designing a Payment System (Pragmatic Engineer)](https://newsletter.pragmaticengineer.com/p/designing-a-payment-system)
- [NACHA / ACH processing](https://www.nacha.org/) — the settlement semantics behind the funding waterfall's credit risk
- [PayPal/Venmo engineering](https://medium.com/paypal-tech)
