# Design Splitwise — Full-Stack

> A 45–60 minute walkthrough balancing client and server: the data model, the balance/simplify engine, the split-editor UI, and how the two halves stay correct together. Conversational, decisions-first.

## 📋 Problem

Splitwise tracks shared expenses. A group of people (roommates, a trip) log expenses that one person paid but several share; the app remembers who owes whom and, at settle-up time, computes the fewest payments that clear the group. People then record settlements as they pay each other back.

"My north star for the whole design: **balances are a derived view over an immutable ledger of expenses and settlements — never stored state.** That one principle drives both the backend (compute + cache) and the frontend (refetch the truth, don't guess)."

**In scope:** groups, expenses with four split modes (equal/exact/percentage/shares), settlements, per-group + per-friend balances, debt simplification, activity feed, idempotent writes, the split-editor UI.
**Out of scope:** moving real money (we record payments, providers move them), multi-currency, notifications delivery.

## 🎯 Requirements

**Functional:** create groups & add members; add/delete expenses split four ways; record settlements; view group balances + simplified transfers; a personal dashboard and activity feed.

**Non-functional**
| Concern | Target |
|---------|--------|
| Correctness | Σ(splits)=total; Σ(group nets)=0 — always |
| Balance read p99 | < 50 ms (cached) |
| Idempotency | Retried write ⇒ exactly one effect |
| Feel | Instant on a phone; never submit an invalid split |

## 🏗️ Architecture

```
  ┌──────────────┐   /api/*    ┌───────────────────────────┐
  │  React SPA    │────────────▶│  Express API (stateless)   │
  │ TanStack Rtr │◀────────────│  auth · groups · expenses  │
  │ Zustand·TW   │   JSON      │  settlements · balances     │
  └──────────────┘             └───────┬───────────┬────────┘
     SplitEditor                        ▼           ▼
     BalancesPanel               ┌───────────┐ ┌──────────────┐
                                 │ PostgreSQL │ │ Redis/Valkey │
                                 │  ledger    │ │ sessions      │
                                 │ (group_id) │ │ balance cache │
                                 └───────────┘ │ idempotency   │
                                               └──────────────┘
```

Stateless API (sessions in Redis) so it scales horizontally. Postgres holds the ledger; Redis holds sessions, the balance cache, and idempotency state.

**Stack:** React 19 + TypeScript + Vite + TanStack Router + Zustand + Tailwind on the client; Node + Express + Postgres + Valkey on the server; Prometheus + Pino for observability.

## 💾 Data Model

Money is **integer cents** everywhere. Tables as prose:

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | id, email (unique), password_hash, name | bcrypt |
| `groups` | id, name, group_type, created_by | home/trip/couple/other |
| `group_members` | (group_id, user_id), role | membership = auth boundary |
| `expenses` | id, group_id, amount_cents, paid_by, split_type, idempotency_key, deleted_at | soft delete; partial unique (created_by, idempotency_key) |
| `expense_splits` | (expense_id, user_id), owed_cents, share_units, percentage | Σ owed = amount |
| `settlements` | id, group_id, from_user, to_user, amount_cents, idempotency_key | records, doesn't move money |
| `activity_log` | id, group_id, actor_id, type, summary | the feed |

The `expenses`+`expense_splits` pair *is* the ledger. "Bob paid $84" (expense) + "Alice/Bob/Carol each owe $28" (splits). No balance is stored.

## 🔌 API

```
GET  /api/dashboard                Owed / owe / net + per-friend balances
GET  /api/groups                   My groups (badged with my balance)
POST /api/groups                   Create group
GET  /api/groups/:id/balances      Net balances + simplified transfers
POST /api/expenses                 Add expense       (Idempotency-Key)
POST /api/settlements              Record payment    (Idempotency-Key)
GET  /api/activity                 Cross-group feed
```

## 🔧 Deep Dive 1: Derive balances, cache aggressively, invalidate on write

**Backend decision:** store only the ledger; compute balances on read; cache per group.

The stored-balance alternative gives an O(1) read but creates a second source of truth that drifts after any edit/delete/bug — and then you can't tell which number is right without recomputing anyway. Deriving makes correctness *structural*: a group's nets sum to zero because they're the same split rows summed with opposite signs. A group is bounded, so recompute is a few milliseconds; I cache the result in Redis (`group_balance:{groupId}`) and **invalidate on every write to the group**, with a short TTL as a safety net.

**Frontend consequence:** the client never optimistically patches balances. After saving an expense it closes the modal and **refetches** group + expenses + balances. Balances are the one thing that must be right, and they're a sub-50ms read — refetching the truth beats guessing.

> "This is the whole philosophy in one line: the ledger is the truth, balances are a fast, cached projection of it, and the UI always shows the projection — never a local guess about money."

## 🔧 Deep Dive 2: The split editor + shared money math

**The hard UI problem:** one control, four split models (equal/exact/percentage/shares), a dynamic participant set, and at every keystroke it must show each person's exact owed cents and whether the split is valid.

**Design:** one state map `userId → { selected, exact, percent, shares }`; the active tab selects which field matters. A single pure function `computeOwed(...)` reduces that into per-person cents + a validation message, in a `useMemo`. Switching modes keeps all data — it just reads a different field.

**The unifying trick:** the client re-implements the **same largest-remainder allocation** the server uses. Why it matters:
- **Money-safe math (server):** $10 three ways is 333.33¢; floor everyone to 333 and a penny vanishes, breaking Σ(splits)=total. Largest-remainder floors then hands leftover pennies to the largest fractional remainders, deterministically — so it's 334/333/333, always, reproducibly.
- **Instant, honest preview (client):** because the client runs that exact algorithm, the modal's "334 / 333 / 333" preview *is* what the server will store — not an approximation. The green "Splits add up ✓" / "$0.34 left to assign" banner is local and immediate, and the Save button is disabled until it's valid.

The server still validates (never trust the client) and returns 400 on a bad split — but that's the safety net, not the UX.

> "Sharing the allocation function across the wire means the preview can't lie. Client feedback is instant; server validation is authoritative; they agree by construction."

## 🔧 Deep Dive 3: Debt simplification, end to end

**Server:** from the ledger, each person gets one net number; positives (creditors) and negatives (debtors) sum to zero. Greedy min-cash-flow — match the biggest creditor with the biggest debtor, transfer the smaller amount, repeat — yields **at most n−1 transfers** versus up to n(n−1)/2 raw IOUs. The true optimum is NP-hard (partition problem); greedy is O(n log n), optimal in the common case, and always trustworthy — the right trade for an instant mobile UI. `GET /groups/:id/balances` returns both the raw nets and the simplified transfers.

**Client:** the "Settle up" panel toggles between **Balances** and **Simplify debts** over the same numbers, so the user *sees* the tangle collapse ("Bob owes $305, Carol owes $741" → "2 payments settles the whole group"). Each simplified transfer has an inline **Settle** button that opens the settle-up modal prefilled with that from/to/amount — a suggestion becomes one tap. The client renders the server's result; it never re-runs the graph, keeping the algorithm in exactly one place.

## ⏱️ Consistency & Idempotency (both halves)

Mobile clients retry, so add-expense and settle-up must be exactly-once:
- **Client:** `api.ts` attaches a fresh **Idempotency-Key** (UUID) generated at action time.
- **Server layer 1:** Redis `SET NX` — first request wins, retries replay the stored result or get a 409.
- **Server layer 2:** Postgres partial `UNIQUE(created_by, idempotency_key)` — durable backstop if Redis was cold; a duplicate throws `23505` → 409 with the original result.

Expense creation is one **transaction** (expense + splits + activity), so no reader sees a half-written expense.

## 🔐 Auth & authorization

Session-based auth: bcrypt password, session id in Redis behind an `x-session-id` header. **Authorization is per-group** — every group/expense/settlement read re-checks membership and 403s non-members; settlement writes require the actor to be one of the two parties. The React root guard redirects unauthenticated users to `/login` and hydrates the user from the session on load.

## 🚀 Scalability

- **Ledger shards by `group_id`** — a group and all its data co-locate, so per-group reads/writes stay on one shard.
- **The dashboard's per-friend balance** is the one cross-group (cross-shard) query; at scale I'd maintain a per-user `(friend → net)` aggregate updated on write via an event stream instead of computing it on read. That's what breaks first, so it's the first to denormalize.
- **Balance reads** scale behind the cache; **writes** are small transactions; **notifications/feed** fan out asynchronously off an event stream.
- **Frontend:** lists are short per group; if one grew huge I'd virtualize the ledger (the row is already isolated). A service worker could cache the last dashboard + open group for instant open and offline queueing (safe to replay — each write carries an idempotency key).

## 🛡️ Failure Handling

| Failure | Behavior |
|---------|----------|
| Redis down | Idempotency → PG unique index; balances recompute from Postgres; app stays up |
| Duplicate write | PG `23505` → 409 with original result |
| Invalid split | 400 before any write; client also blocks Save |
| Non-member access | 403 on every group read |

Observability: Prometheus (latency, expenses/settlements by type, cache hit/miss, idempotency hits, simplify duration), Pino structured logs with redaction, `/health/detailed` (Postgres + Redis).

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Balances | Derived + cached; client refetches | Stored total; optimistic UI | Single truth; money must be right |
| Money | Integer cents | Float | Exactness |
| Split math | Largest-remainder, shared client/server | Round each; client approximates | Σ=total; preview==reality |
| Simplify | Greedy min-cash-flow | Exact optimum | O(n log n) vs NP-hard; ≤ n−1 |
| Idempotency | Client key + Redis NX + PG unique | One layer | Exactly-once end to end |
| Global state | Zustand (auth only) | Redux everywhere | Minimal shared state |
| Store | Sharded PostgreSQL | Wide-column | Relational ledger, bounded reads |

## 🔮 Follow-ups

- **Multi-currency:** currency per expense, balances per-currency, convert only for display.
- **Expense edits:** version the row — because balances are derived, the next read is just correct.
- **React Query** for unified server-cache + mutation invalidation as the app grows.
- **Itemized splits** ("who had the appetizer") — the per-member map generalizes to per-item.
