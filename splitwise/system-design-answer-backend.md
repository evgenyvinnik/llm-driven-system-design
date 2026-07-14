# Design Splitwise — Backend Focus

> A 45–60 minute system-design walkthrough emphasizing service architecture, the data model, the balance/simplification engine, and how it scales and fails. I'll keep it conversational and lead with the reasoning behind each choice.

## 📋 Problem & Scope

Splitwise lets groups of people track shared expenses. One person pays for something; the cost is split among several; the system remembers who owes whom and, when people want to settle up, tells them the fewest payments that clear the group.

"The single most important framing I'd establish up front: **balances are not stored data, they're a computed view over an immutable ledger.** Almost every backend decision falls out of that."

**In scope:** groups & membership, expenses with four split strategies (equal / exact / percentage / shares), settlements, per-group and per-friend balances, debt simplification, an activity feed, idempotent writes.

**Out of scope for this session:** actually moving money (Splitwise integrates with payment providers; we only *record* that a payment happened), multi-currency FX, receipt OCR, notifications delivery.

## 🎯 Requirements

**Functional**
- Create groups, add members, add/delete expenses, record settlements.
- Split an expense equally, by exact amounts, by percentage, or by shares.
- Show each member's net balance in a group and the simplified transfers to settle.
- Show a personal dashboard (owed / owe / net, per friend) and an activity feed.

**Non-functional**
| Concern | Target | Why |
|---------|--------|-----|
| Correctness | Σ(splits)=total; Σ(group nets)=0 — always | Money bugs destroy trust |
| Balance read p99 | < 50 ms | It's on every screen |
| Idempotency | Retried write ⇒ exactly one effect | Mobile clients retry |
| Availability | 99.95% reads | Degrade, don't fail |

## 🧮 Back-of-envelope

"Let me size it to justify the storage choice." ~10M MAU, ~60M expenses/month ≈ **~23 writes/sec** average, ~230/sec peak. Reads dominate maybe 50:1 — opening the app loads a dashboard and a group. Expenses are ~720M rows/year, splits 2–4× that (~2B/year).

"Two conclusions. First, this is a **relational ledger** — bounded per-group reads, strong consistency on writes, no need for a wide-column store. Second, **reads of balances vastly outnumber writes of expenses**, so the balance aggregation is the thing to cache."

## 🏗️ Architecture

```
   Client ──▶ API Gateway ──▶ Splitwise API (stateless, horizontally scaled)
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        ▼                         ▼                          ▼
  ┌───────────┐            ┌──────────────┐          ┌───────────────┐
  │ PostgreSQL│            │ Redis/Valkey │          │ Event stream  │
  │  ledger    │            │ sessions      │          │ (Kafka)       │
  │ sharded by │◀── inval ──│ balance cache │          │ ⇒ activity /  │
  │ group_id   │            │ idempotency   │          │   notifications│
  └───────────┘            └──────────────┘          └───────────────┘
```

The API is stateless — sessions live in Redis, so any instance serves any request. Writes go to Postgres in a transaction and emit an event; balance reads are served from Redis when warm.

## 💾 Data Model

I'll describe tables as prose rather than DDL. Money is **integer cents** in every column.

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | id (UUID PK), email (unique), password_hash, name | bcrypt hashes |
| `groups` | id, name, group_type, avatar_color, created_by | type ∈ home/trip/couple/other |
| `group_members` | (group_id, user_id) PK, role | membership = authorization boundary |
| `expenses` | id, group_id, amount_cents, paid_by, split_type, created_by, idempotency_key, deleted_at | soft delete; partial unique on (created_by, idempotency_key) |
| `expense_splits` | (expense_id, user_id) PK, owed_cents, share_units, percentage | INVARIANT: Σ owed_cents = expense.amount_cents |
| `settlements` | id, group_id, from_user, to_user, amount_cents, idempotency_key | records a payment, doesn't make one |
| `activity_log` | id, group_id, actor_id, type, summary | the feed |

**Why this shape.** The `expenses` + `expense_splits` pair is the entire ledger. An expense says "Bob paid $84"; the splits say "Alice owes 28, Bob owes 28, Carol owes 28." Nothing stores "Alice's balance" — that's derived. Indexes that matter: `expenses(group_id, created_at DESC)` for the ledger view, `expense_splits(user_id)` for cross-group friend balances, and the partial unique indexes for durable idempotency.

## 🔌 API

```
POST /api/expenses                 Add expense        (Idempotency-Key)
GET  /api/expenses/group/:groupId  Group ledger
DELETE /api/expenses/:id           Soft-delete
POST /api/settlements              Record a payment   (Idempotency-Key)
GET  /api/groups/:id/balances      Net balances + simplified transfers
GET  /api/dashboard                Owed / owe / net + per-friend balances
GET  /api/activity                 Cross-group feed
```

No request/response bodies here — the interesting logic is behind `/expenses` and `/balances`, which I'll deep-dive.

## 🔧 Deep Dive 1: Deriving balances instead of storing them

**The decision:** store only the immutable ledger; compute every balance on read.

**Why the stored-balance alternative fails.** The obvious design keeps a `balance` column per (group, user) and adjusts it on each write. It's a great read — O(1). But it introduces a *second source of truth*. The moment an expense is edited, an expense is soft-deleted, a settlement is voided, or any handler has a bug, the stored balance and the ledger disagree — and now you genuinely cannot tell which one is correct without recomputing anyway. In a money product, "the number might be wrong and we can't prove it" is fatal. You'd bolt on nightly reconciliation jobs to detect drift, which is complexity that only exists because you stored a derivative.

**Why deriving works here.** A group is bounded — tens to low-thousands of expenses. Computing a group's balances is three aggregate queries (sum paid per payer, sum owed per participant, apply settlements) — single-digit milliseconds. Correctness is *structural*: net balances always sum to zero because they're the same split rows summed with opposite signs for payer and participant. There's no drift to reconcile because there's nothing to drift.

**What I give up, and how I buy it back.** A cold read scans the group's expenses. So I cache the computed balance payload in Redis keyed by `group_balance:{groupId}`, and **invalidate it on every write to that group**. Hot groups (the ones people actually open) serve from cache; the cache has a short TTL as a safety net if an invalidation is ever missed. The trade: balances are strongly consistent with the *ledger* on cold read and at most one write stale on warm read — perfectly acceptable, because a stale-by-one-expense balance self-corrects on the next read and the ledger (the truth) is never wrong.

> "I'll pay a recomputation cost on cache miss to guarantee I never serve a balance that disagrees with the ledger. In a money app, correctness beats a cheaper read."

## 🔧 Deep Dive 2: Money-safe splits with exact remainder distribution

**The decision:** integer cents everywhere, and split via the **largest-remainder method**.

**Why floats fail.** `0.1 + 0.2 = 0.30000000000000004`. Store money as float and, over thousands of expenses, sums drift and balances stop reconciling to zero. So every amount is an integer number of cents.

**The rounding problem integers create.** $10.00 split three ways is 333.33¢ each. Floor to 333 and you've allocated 999¢ — one penny has vanished, and now Σ(splits) ≠ total, which breaks the core invariant. Naively rounding each share can *over*-allocate instead. Either way the parts don't sum to the whole.

**The fix.** For any weighted split (equal is just equal weights; percentage and shares are weighted), I floor every share, then distribute the leftover pennies one at a time to the participants with the largest fractional remainder, breaking ties by position. This guarantees Σ = total, and it's **deterministic** — re-deriving the same expense always yields the same cents, which matters because balances are recomputed constantly. Exact splits are validated to sum to the total up front and rejected with a 400 otherwise.

"$10 three ways becomes 334 + 333 + 333 — the extra cent goes to the first person, every time, reproducibly."

## 🔧 Deep Dive 3: Debt simplification (min-cash-flow)

**The decision:** collapse a group's net balances into a minimal set of transfers using greedy max-creditor/max-debtor matching.

**The problem.** After a trip, six people have a mess of pairwise IOUs — up to n(n−1)/2 = 15 little debts. Nobody wants to make 15 Venmo payments. We want the *fewest* payments that settle everyone.

**The algorithm.** From the ledger I compute each person's single net number (sum of what they paid minus what they owe, adjusted by settlements). Positives are creditors, negatives are debtors, and — because money is conserved — they sum to zero. Then, greedily: take the person owed the most and the person who owes the most, transfer the smaller of the two amounts between them, and repeat. Each step zeroes out at least one person, so the result has **at most n−1 transfers**.

**The honest caveat.** Finding the true global minimum number of transfers is NP-hard — it's a partition problem. Greedy isn't always optimal, but it's optimal in the common case and always within a small factor, it's O(n log n), and it produces obviously-correct results a user can trust. For a UI that must feel instant on a phone, that's the right trade over an exact solver that could be exponential. I record a `debt_simplify_duration` metric so I'd notice if a pathological group ever got slow.

> "Six roommates with fifteen tangled IOUs collapse to five clean payments. That single feature is most of why people use the product."

## ⏱️ Consistency & Idempotency

Mobile clients retry. If a user taps *Add expense*, the request times out mid-flight, and the app retries, we must not create the $84 dinner twice.

- The client generates an **Idempotency-Key** (UUID) at tap time and sends it.
- Layer 1 — **Redis `SET NX`**: the first request wins a lock and records `processing`; a concurrent retry sees it and either waits (409) or replays the stored result.
- Layer 2 — **Postgres partial `UNIQUE(created_by, idempotency_key)`**: if Redis was cold and a duplicate slips through, the DB throws a unique violation, which we translate to a 409 with the original result.

"Two layers because they cover different failures: Redis catches near-simultaneous retries fast; the DB index catches retries that arrive after the cache forgot the key. Together: exactly-once, even if Redis is down."

Expense creation is a **single transaction** — the expense row, all split rows, and the activity row commit together, so no reader ever sees a half-written expense.

## 🚀 Scalability

```
   Shard key = group_id
   ┌───────────┐  ┌───────────┐  ┌───────────┐
   │  shard 0   │  │  shard 1   │  │  shard 2   │   a group + all its
   │ groups g%3=0│  │ groups g%3=1│  │ groups g%3=2│   expenses/splits/
   └───────────┘  └───────────┘  └───────────┘   settlements co-locate
```

- **Ledger shards by `group_id`.** A group is a self-contained unit — its expenses, splits, settlements, and balance math all live on one shard, so per-group reads and writes never cross shards. This is the clean scaling axis.
- **The one cross-shard query is the dashboard's per-friend balance**, which fans across every group two users share. At scale I'd stop computing it on read and instead maintain a per-user `(friend → net_cents)` aggregate updated on each write via the event stream — turning a fan-out read into an O(1) lookup.
- **Balance reads scale horizontally** behind the Redis cache; add read replicas for cold-cache recomputes.
- **Writes** are small transactions bounded by DB write capacity; the event stream absorbs notification/feed fan-out asynchronously.

**What breaks first:** the cross-group dashboard query, well before the sharded per-group paths. That's why it's the first thing to denormalize.

## 🛡️ Failure Handling & Observability

| Failure | Behavior |
|---------|----------|
| Redis down | Idempotency falls back to the PG unique index; balances recompute from Postgres. Product stays up. |
| Duplicate write race | PG `23505` → 409 with the original result |
| Invalid split | 400 before any write (amounts don't sum, bad percentage) |
| Non-member access | 403 — every group read re-checks membership |

Observability: Prometheus metrics (request latency, expenses/settlements by type, balance cache hit/miss, idempotency hits, simplify duration), Pino structured logs with sensitive-field redaction, and `/health/detailed` that pings Postgres and Redis.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Balances | Derived + cached | Stored running total | Single source of truth; no drift |
| Money | Integer cents | Float/decimal | Exactness |
| Rounding | Largest-remainder | Round each | Σ = total, deterministic |
| Simplify | Greedy min-cash-flow | Exact optimum | O(n log n) vs NP-hard; ≤ n−1 |
| Idempotency | Redis NX + PG unique | One layer | Fast + durable |
| Store | Sharded PostgreSQL | Wide-column | Relational ledger, bounded reads |
| Settlement | Record only | Move money | Splitwise tracks money movement |

## 🔮 Follow-ups I'd expect

- **Multi-currency:** store currency per expense, keep balances per-currency, convert only for display at a snapshotted rate.
- **Expense edits:** version the expense; since balances are derived, an edit just changes the rows and the next read is correct — no balance surgery.
- **"Simplify off" mode:** real Splitwise lets groups keep raw pairwise IOUs; I'd store the pairwise ledger and make simplification a view toggle (which is exactly how the UI already presents it).
