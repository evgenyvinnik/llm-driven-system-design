# PayPal — Development with Claude

## Project Context

A simplified P2P payment platform: users hold a wallet, deposit/withdraw funds, send money to each other, and request money with a pay/decline/cancel workflow. The core hard problem is *moving money between two wallets correctly under concurrency* — a transfer must debit exactly one wallet and credit exactly one other, atomically, and never double-execute on a retry or deadlock when two people pay each other simultaneously.

**Learning goals:** double-entry bookkeeping, optimistic locking vs. `SELECT ... FOR UPDATE` for wallet balances, deadlock-free multi-row locking, and idempotency that survives a crash.

## Architecture at a Glance (what actually runs)

Two datastores in `docker-compose.yml` — this is deliberately a single-relational-DB design; money correctness lives in Postgres, not spread across systems:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Wallets, transactions, `ledger_entries`, transfer_requests, payment_methods, **and idempotency keys** | The transfer + its ledger entries + its idempotency key all commit in *one* ACID transaction — that atomicity is the whole point |
| **Valkey/Redis** (`ioredis`) | Session store (`connect-redis`) + rate-limit counters (`rate-limit-redis`) | Ephemeral, revocable session state and atomic counters — data whose loss on restart is tolerable, unlike ledger data |

Idempotency keys live in **Postgres, not Redis** — a deliberate inversion of the usual "cache it in Redis" instinct (see Decision 3). Backend: Express app (`app.ts`/`index.ts`) with routes `auth`, `wallet`, `transfers`, `requests`, `paymentMethods`, `users`, `admin`; services `walletService`, `transferService`, `idempotencyService`, `ledger` (platform account constants), `validation`, `errors`, plus `circuitBreaker` (Opossum, not wired), `metrics` (prom-client), `logger` (pino). Frontend: React 19 + TanStack Router + Zustand. Backend runs on :3001; the Vite proxy targets it.

## Key Design Decisions

### 1. Double-entry bookkeeping, including deposits and withdrawals
Every balance change writes a balanced debit/credit pair in `ledger_entries` inside the same transaction that mutates the wallet. The `transactions` row is the business event; the ledger rows are the accounting impact. Deposits and withdrawals post against a **platform cash account** (one `wallets` row, `account_type = 'platform_cash'`, debit-normal), so the books prove three things: every transaction nets to zero, every wallet equals its ledger, and customer balances sum to platform cash. `GET /api/admin/reconciliation` checks all three. Trade-offs: 2× write amplification per transfer versus a bare `UPDATE balance`, and a hot cash row that every deposit touches (locked last with an atomic increment; shard it at real volume).

### 2. Optimistic locking for single-wallet ops, ordered `FOR UPDATE` for transfers
Deposits/withdrawals use a `version` column (`WHERE version = $expected`) so a concurrent write is detected and retried rather than silently lost. But a P2P transfer touches *two* wallets, and two users paying each other at once is a classic deadlock: A locks A→tries B while B locks B→tries A. `transferService` avoids it by acquiring `SELECT ... FOR UPDATE` on both wallets in a **consistent order (by user_id)**, so the two transactions can't form a cycle. Trade-off: `FOR UPDATE` serializes concurrent transfers touching the same wallet — correct over fast, which is the right call for money.

### 3. Idempotency keys in Postgres, claimed first in the payment's own transaction
`idempotencyService` *claims* `(user_id, key, request_hash)` as the first statement of the payment's transaction, on the same `PoolClient`, and writes the response before commit. A concurrent duplicate blocks on the primary key and then replays; the same key with a different request gets 422; keys never cross users. If the transaction rolls back, the key rolls back with it — so it's impossible to have a stored key without a completed payment, or a completed payment without a key. Redis would be sub-ms faster, but a crash between "payment committed" and "Redis SET" would leave the next retry free to re-execute the charge. For money, that consistency gap outweighs the latency. (This is the opposite choice from the merchant-facing `payment-system` project, which caches in Redis with a DB `UNIQUE` backstop — worth contrasting.)

### 4. BIGINT cents everywhere, strictly typed at the edge
All amounts are integer cents (`BIGINT`) with DB `CHECK` constraints preventing negative balances. The API accepts only JSON integers (a string `"100"` is a 400, never coerced) and balance arithmetic runs in SQL. The frontend parses dollars to cents from the input string. Trade-off: callers must format cents→dollars at the edge, but that's cheap insurance against rounding drift.

### 5. Session auth over JWT
HTTP-only session cookies (`express-session` + `connect-redis`, bcryptjs password hashing) instead of JWT. Rationale: XSS can't read an HttpOnly cookie, and deleting the Redis session revokes access instantly — a JWT would need short expiry (bad UX) or a blacklist (which re-implements sessions anyway). For a financial app, instant revocation wins over statelessness.

## Current State

Implemented end to end: registration/login with session auth (ID regenerated on login), wallet balance plus deposit/withdraw from a linked payment method (optimistic locking, two-sided against platform cash), P2P transfers (ordered `FOR UPDATE`, double-entry), money-request lifecycle (pay/decline/cancel, each under a request row lock, 404 for outsiders), payment-method CRUD with one default per user, user search (no emails returned), per-user idempotency on every money endpoint (Postgres, 24h TTL, hourly cleanup), Redis-backed rate limits (per-user money budget shared across instances), admin ledger reconciliation, Prometheus metrics including HTTP, and pino logging. Frontend: dashboard (wallet card with Add money / Withdraw, pending requests, recent activity), send/request flows with per-attempt idempotency keys, "Your requests" with cancel, activity filters, admin reconciliation page. The Opossum circuit breaker helper exists but has no caller (no external calls locally).

Intentionally omitted: multi-currency / FX, transfer-request expiry, dispute/refund flows, real bank-transfer or card-processor integration (deposits/withdrawals are simulated and complete immediately), a withdrawal settlement lifecycle, and a WebSocket notification service (request pay/decline is poll/refresh, not push). The production architecture diagram shows Kafka + a notification service — those are the production layer, not built locally.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md restructure):** This file was already substantive but was organized around a "Development Phases" narrative and lacked an Architecture-at-a-Glance table, an accurate Current State, and a repair log. Restructured to the exemplar shape while keeping the (correct) key design decisions.
- **Idempotency location:** early instinct was Redis for speed; changed to Postgres-in-transaction after reasoning about the crash-consistency gap (Decision 3). `architecture.md` documents the same reasoning (§"Idempotency Keys in PostgreSQL (Not Redis)").
- **Repo-wide fixes that touched this project:** ESM `connect-redis` v7 named-import + `pino-http` named-import hardening; DB/Redis connection-string fallbacks to the docker-compose creds (`paypal:paypal123`, `redis://localhost:6379`); the schema-apply path is `db/migrate.ts` run via `npm run db:migrate` (also mounted at `docker-entrypoint-initdb.d`).
- **2026-07-31 — working, but thin.** Unlike most of the projects in this sweep, nothing was broken: login, the dashboard, wallet balance, pending requests and payment methods all rendered real seeded data. Two gaps closed:
  1. **The Activity page's Deposits and Withdrawals filters were permanently empty** — the seed only ever created two `transfer` rows, so two of the four filter tabs had nothing to show. The seed now covers all three transaction types plus a `pending` withdrawal, with wallet balances reconciled to the ledger's final `balance_after_cents` so the double-entry invariant actually holds against the seeded data. Also added the terminal request states (`paid`, `declined`) so the money-request lifecycle is visible rather than just its pending step.
  2. **`init.sql` indexes weren't idempotent** (`relation "idx_transactions_sender" already exists` on the second migrate) — the schema is applied by both the initdb mount and `npm run db:migrate`. All 7 `CREATE INDEX` statements now use `IF NOT EXISTS`; the tables already did.
- **Screenshots:** 6 → 8, adding the Deposits and Withdrawals filter views.
- **Answer docs:** backend 344→354 and fullstack 324→360, both of which were under the 350-line floor. Added the asymmetry that deposits/withdrawals are single-sided in the ledger while transfers are paired — which is why the reconciliation invariant is written *per wallet*, not per transaction — plus a deep dive on why the two-wallet transfer path uses ordered `FOR UPDATE` rather than the optimistic locking used everywhere else.
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).
- **2026-11-02 — money-correctness and authorization pass.** The app rendered fine but was not safe with money:
  1. **Money minting.** Amounts were checked with `!amountCents || amountCents <= 0`, so a JSON string passed, and `balance + "100"` in JS is string concatenation: a $1 deposit turned $50.00 into $50,001.00, and a string transfer did the same to the recipient. Now `parseAmountCents` accepts only safe integers within the caps, and balance arithmetic runs in SQL (`balance_cents + $1 ... RETURNING`).
  2. **Paying a request twice.** Pay checked `pending`, ran the transfer, then updated the status, all as separate statements with no lock, so a double click charged twice. Pay, decline and cancel now lock the request row and run in one transaction; the transfer shares the connection, and the request records its `transaction_id`. Outsiders get 404, the wrong party 403, a non-pending request 409. Added `POST /requests/:id/cancel`.
  3. **Idempotency didn't hold.** Keys were global, so user B's key could replay user A's receipt and skip B's payment. A reused key with a new amount replayed the old result. The check ran before the transaction, so concurrent retries both executed until a unique index threw a 500. The frontend also built the key from `Date.now()` at click time, so every retry was a new key. Now the PK is `(user_id, key)` with a request hash, claimed as the transaction's first statement (`INSERT ... ON CONFLICT DO UPDATE WHERE expired`). Replays carry `Idempotent-Replayed: true`, mismatches get 422, and deposits and withdrawals are covered too. Each form keeps one key per attempt.
  4. **Ledger wasn't double-entry.** Deposits and withdrawals were single-sided, and the seeded balances didn't match their ledgers (no opening entries; a "paid" request had no transfer). Ledger rows had random IDs, so re-seeding duplicated them. Added the platform cash account and the reconciliation endpoint and page. The seed has fixed IDs and opening deposits and reconciles to $9,750.00; its pending withdrawal is debited.
  5. **Deposits and withdrawals weren't usable.** `walletApi.deposit/withdraw` had no caller, so new users could never fund a wallet. Added an Add money / Withdraw modal. The API now requires a `paymentMethodId` the caller owns (404 otherwise), and the transaction records which method was used.
  6. **Other holes:**
     - unknown or malformed IDs returned 500 with Postgres text (now 404, and generic 500s);
     - requests had no amount cap, so paying one bypassed the $50k transfer limit;
     - user search returned everyone's email by substring (now exact-email match only, no emails returned, LIKE escaped);
     - no session regeneration, so session fixation was possible;
     - rate limiting was in-memory and per IP, despite the docs, and covered only POST /transfers (now Redis-backed, per user, across all money endpoints, fails open);
     - the idempotency cleanup and HTTP metrics were never wired;
     - `balance_cents` was nullable;
     - `limit=abc`, a 5-digit `lastFour` and a malformed payment-method ID each returned 500.
  7. **Frontend:**
     - pay errors were swallowed;
     - outgoing requests (and cancel) were unreachable;
     - the activity filter could show a stale response, and failed lint;
     - amounts went through `parseFloat`;
     - there was no `<main>` landmark, so the generated smoke tests failed;
     - `tsc -b` wrote `vite.config.js` next to the source.
  8. **Tooling:**
     - backend lint had no config, and its glob only matched one level;
     - there were no backend tests (now 50, with a scripted fake `pg` client);
     - `init.sql` upgrades older volumes (it drops the old global idempotency table and seeds platform cash with the customer total).
  Verified live, twice from a clean reset: 68/68 checks, including 50 concurrent opposite transfers (sum unchanged, no lost update, reconciliation balanced), 20 concurrent same-key transfers producing one transaction, 10 concurrent pays producing one charge, and the 31st money request returning 429 across two instances. Screenshots 8 → 11; smoke tests 11/11.

## Open Questions

1. Should wallet balance be cached in Redis with a short TTL for the read-heavy dashboard, and how do we invalidate it the instant a transfer commits? (It would have to be invalidated after COMMIT, never before.)
2. How should multi-currency transfers work — a per-currency wallet with an FX service, or a single base currency with conversion at send time?
3. Should money requests expire? An unbounded pending request is a UX and reconciliation smell.
4. Dispute/refund: refunds are just reverse ledger entries, but who authorizes them and how do we prevent a refund from being replayed?
5. `SELECT ... FOR UPDATE` serializes transfers on a hot wallet — at what throughput does a popular payee need a different model (e.g. append-only ledger with async balance projection)?
6. Withdrawals complete instantly. A real payout is `pending` until the bank settles or returns it — should the cash leg post at initiation (as now) or at settlement via a "payouts in transit" account?
7. The platform cash row is a single hot row. Random sub-account sharding or batched cash postings — which keeps the reconciliation report simplest?

## Resources

- [Accounting for Developers (double-entry)](https://www.moderntreasury.com/journal/accounting-for-developers-part-i)
- [PostgreSQL: explicit row locking & deadlocks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
