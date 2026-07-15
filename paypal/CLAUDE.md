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

Idempotency keys live in **Postgres, not Redis** — a deliberate inversion of the usual "cache it in Redis" instinct (see Decision 3). Backend: Express app (`app.ts`/`index.ts`) with routes `auth`, `wallet`, `transfers`, `requests`, `paymentMethods`, `users`; services `walletService`, `transferService`, `idempotencyService`, plus `circuitBreaker` (Opossum), `metrics` (prom-client), `logger` (pino). Frontend: React 19 + TanStack Router + Zustand.

## Key Design Decisions

### 1. Double-entry bookkeeping as the reconciliation invariant
Every balance change writes paired debit/credit rows in `ledger_entries` inside the same transaction that mutates the wallet. The `transactions` row is the business event; the ledger rows are the accounting impact. The invariant that makes the system auditable: `SUM(credits) − SUM(debits)` for a wallet must equal `wallet.balance_cents`. Trade-off given up: 2× write amplification per transfer versus a bare `UPDATE balance` — accepted because a single mutable balance can't be reconciled or audited after a bug.

### 2. Optimistic locking for single-wallet ops, ordered `FOR UPDATE` for transfers
Deposits/withdrawals use a `version` column (`WHERE version = $expected`) so a concurrent write is detected and retried rather than silently lost. But a P2P transfer touches *two* wallets, and two users paying each other at once is a classic deadlock: A locks A→tries B while B locks B→tries A. `transferService` avoids it by acquiring `SELECT ... FOR UPDATE` on both wallets in a **consistent order (by user_id)**, so the two transactions can't form a cycle. Trade-off: `FOR UPDATE` serializes concurrent transfers touching the same wallet — correct over fast, which is the right call for money.

### 3. Idempotency keys in Postgres, in the payment's own transaction
`idempotencyService` reads/writes `idempotency_keys` through the *same* `PoolClient` as the transfer. If the transaction rolls back, the key rolls back with it — so it's impossible to have a stored key without a completed payment, or a completed payment without a key. Redis would be sub-ms faster, but a crash between "payment committed" and "Redis SET" would leave the next retry free to re-execute the charge. For money, that consistency gap outweighs the latency. (This is the opposite choice from the merchant-facing `payment-system` project, which caches in Redis with a DB `UNIQUE` backstop — worth contrasting.)

### 4. BIGINT cents everywhere
All amounts are integer cents (`BIGINT`) with DB `CHECK` constraints preventing negative balances. No floating-point money in application code, ever. Trade-off: callers must format cents→dollars at the edge, but that's cheap insurance against rounding drift.

### 5. Session auth over JWT
HTTP-only session cookies (`express-session` + `connect-redis`, bcryptjs password hashing) instead of JWT. Rationale: XSS can't read an HttpOnly cookie, and deleting the Redis session revokes access instantly — a JWT would need short expiry (bad UX) or a blacklist (which re-implements sessions anyway). For a financial app, instant revocation wins over statelessness.

## Current State

Implemented end to end: registration/login with session auth, wallet deposit/withdraw/balance, P2P transfers with double-entry ledger + optimistic locking + ordered `FOR UPDATE`, money-request lifecycle (create/pay/decline/cancel with authorization checks), payment-method CRUD with default management, debounced user search, idempotency (Postgres, 24h TTL, background cleanup), Opossum circuit breaker on external calls, `express-rate-limit` backed by Redis, Prometheus metrics, and pino structured logging. Frontend: dashboard (wallet card, pending requests, recent activity), send/request flows, activity page with type filters.

Intentionally omitted: multi-currency / FX, transfer-request expiry, dispute/refund flows, real bank-transfer or card-processor integration (deposits/withdrawals are simulated), and a WebSocket notification service (request pay/decline is poll/refresh, not push). The production architecture diagram shows Kafka + a notification service — those are the production layer, not built locally.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md restructure):** This file was already substantive but was organized around a "Development Phases" narrative and lacked an Architecture-at-a-Glance table, an accurate Current State, and a repair log. Restructured to the exemplar shape while keeping the (correct) key design decisions.
- **Idempotency location:** early instinct was Redis for speed; changed to Postgres-in-transaction after reasoning about the crash-consistency gap (Decision 3). `architecture.md` documents the same reasoning (§"Idempotency Keys in PostgreSQL (Not Redis)").
- **Repo-wide fixes that touched this project:** ESM `connect-redis` v7 named-import + `pino-http` named-import hardening; DB/Redis connection-string fallbacks to the docker-compose creds (`paypal:paypal123`, `redis://localhost:6379`); the schema-apply path is `db/migrate.ts` run via `npm run db:migrate` (also mounted at `docker-entrypoint-initdb.d`).
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).

## Open Questions

1. Should wallet balance be cached in Redis with a short TTL for the read-heavy dashboard, and how do we invalidate it the instant a transfer commits?
2. How should multi-currency transfers work — a per-currency wallet with an FX service, or a single base currency with conversion at send time?
3. Should money requests expire? An unbounded pending request is a UX and reconciliation smell.
4. Dispute/refund: refunds are just reverse ledger entries, but who authorizes them and how do we prevent a refund from being replayed?
5. `SELECT ... FOR UPDATE` serializes transfers on a hot wallet — at what throughput does a popular payee need a different model (e.g. append-only ledger with async balance projection)?

## Resources

- [Accounting for Developers (double-entry)](https://www.moderntreasury.com/journal/accounting-for-developers-part-i)
- [PostgreSQL: explicit row locking & deadlocks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
