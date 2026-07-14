# Splitwise — Architecture

## System Overview

Splitwise is a shared-expense tracker. People form **groups** (roommates, a trip, a couple), log **expenses** that one person paid but several people share, and the system keeps a running tally of **who owes whom**. When it is time to square up, a **debt-simplification** algorithm collapses the tangle of individual IOUs into the smallest set of payments that settles everyone, and users record **settlements** as they pay each other back.

The interesting engineering is not storing expenses — it is that **balances are a derived value**. Every balance shown anywhere in the product is an aggregation over the immutable log of expenses and settlements. Getting that aggregation correct to the penny (under integer-cents rounding), fast (under caching + invalidation), and safe (under retries and concurrent writes) is the whole game.

**Learning goals:** money-safe integer math with exact remainder distribution; deriving-vs-storing balances; a real graph algorithm (min-cash-flow debt reduction) behind a product feature; idempotency for money-adjacent writes; and a polished, state-heavy React front end (the split editor).

## Requirements

### Functional
- Users register / log in; search for other users to add to groups.
- Create groups; add members; a group has a type (home / trip / couple / other).
- Add an expense to a group: a payer, a total, a category, and a **split** across participants using one of four strategies — **equal, exact, percentage, shares**.
- View a group's expenses, each member's **net balance**, and a **simplified** set of transfers to settle up.
- Record a settlement (payment) between two members.
- See a personal **dashboard**: total you are owed, total you owe, net, and per-friend balances.
- See an **activity feed** across all your groups.
- Soft-delete an expense (history preserved; balances recompute without it).

### Non-Functional (production targets)
| NFR | Target |
|-----|--------|
| Availability | 99.95% for reads; balance reads must never 5xx a whole screen |
| Balance read latency | p99 < 50 ms (served from cache for hot groups) |
| Write latency | p99 < 150 ms for add-expense (transactional, N split rows) |
| Correctness | Σ(splits) == expense total, always; Σ(group net balances) == 0, always |
| Idempotency | An add-expense or settlement retried with the same key never double-writes |
| Durability | No lost writes; expenses/settlements are an append-mostly ledger |

## Capacity Estimation

Splitwise-scale planning numbers (illustrative): ~10M MAU, ~60M expenses/month ≈ **23 writes/sec average**, ~10× peak. Reads dominate — opening the app hits the dashboard + a group, so call it ~50:1 read:write. Balances are read far more than expenses are written, which is exactly why the balance aggregation is the component to cache.

- Expenses/year ≈ 720M rows; splits ≈ 2–4× that (≈ 2B split rows/year). Well within a partitioned relational store; no need for a wide-column DB.
- A single group's balance computation touches only that group's expenses (tens to low thousands of rows) — cheap, and cacheable.

### Local Development Scale
Single Postgres + single Valkey in Docker, one API process, one Vite dev server. Seed data: 5 users, 3 groups, ~10 expenses across all four split types, plus a settlement. Concurrency is a handful of tabs, not thousands of RPS — but the code paths (transactions, idempotency, cache invalidation) are the real ones.

## High-Level Architecture

```
                         ┌──────────────────────────────┐
                         │        Web / Mobile client    │
                         │   React SPA · optimistic UI    │
                         └───────────────┬──────────────┘
                                         │ HTTPS (session cookie / header)
                                         ▼
                                 ┌────────────────┐
                                 │   CDN / Edge    │  static assets
                                 └───────┬────────┘
                                         ▼
                                 ┌────────────────┐
                                 │  API Gateway    │  authN, rate limit, routing
                                 └───────┬────────┘
                                         ▼
        ┌────────────────────────────────────────────────────────────┐
        │                     Splitwise API (stateless)                │
        │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
        │  │  Groups  │ │ Expenses │ │ Settle-  │ │  Balances /     │  │
        │  │  service │ │  service │ │  ments   │ │  Simplify engine│  │
        │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬────────┘  │
        └───────┼────────────┼────────────┼───────────────┼──────────┘
                │            │            │               │
       ┌────────▼───────┐   │   ┌────────▼────────┐  ┌────▼──────────┐
       │   PostgreSQL    │◀──┴──▶│  Redis / Valkey │  │  Event stream │
       │  (ledger + meta)│       │ sessions·balance │  │ (Kafka) →     │
       │  sharded by     │       │ cache·idempotency│  │ notifications │
       │  group_id       │       └─────────────────┘  │ / activity     │
       └─────────────────┘                            └───────────────┘
```

At production scale the write path also emits an event (expense added / settled) to a stream that fans out to notifications ("Bob added *Dinner*, you owe $24") and to a denormalized activity feed. Locally we write the activity row inline in the same transaction and skip the stream.

## Core Components / Request Flows

**Add-expense flow (the critical write path):**
1. Client generates an **Idempotency-Key** (UUID) at the moment the user taps *Save*, and sends it with the request.
2. API validates membership (payer + all participants must belong to the group).
3. The **split engine** resolves the chosen strategy into concrete `owed_cents` per participant, asserting the parts sum to the total.
4. In a single DB transaction: insert the `expenses` row, insert N `expense_splits` rows, insert an `activity_log` row.
5. Invalidate the group's cached balance in Redis.
6. Return the created id; store the idempotency result so retries replay it.

**Balance read flow:**
1. Check Redis for `group_balance:{groupId}`. Hit → return (this is the common case for hot groups).
2. Miss → aggregate: sum `amount_cents` per payer, subtract sum `owed_cents` per participant, apply settlements, producing each member's **net**. Run debt-simplification. Cache and return.

**Sign convention (used everywhere):** positive net = the user is **owed** money (creditor); negative = the user **owes** (debtor). Within a group all nets sum to exactly zero.

## Database Schema

Money is `INTEGER` cents throughout — never floating point. (`0.1 + 0.2 !== 0.3` in IEEE-754; pennies drift.)

```sql
-- Groups and membership
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  group_type VARCHAR(30) DEFAULT 'other',   -- home | trip | couple | other
  avatar_color VARCHAR(20) DEFAULT 'green',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE group_members (
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id  UUID REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'member',         -- admin | member
  PRIMARY KEY (group_id, user_id)
);

-- Expenses + splits (the ledger)
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  description VARCHAR(200) NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category VARCHAR(30) DEFAULT 'general',
  paid_by UUID NOT NULL REFERENCES users(id),
  split_type VARCHAR(20) NOT NULL DEFAULT 'equal',   -- equal|exact|percentage|shares
  created_by UUID REFERENCES users(id),
  idempotency_key VARCHAR(64),
  deleted_at TIMESTAMP,                               -- soft delete
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_expenses_idempotency
  ON expenses(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE expense_splits (
  expense_id UUID REFERENCES expenses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  owed_cents INTEGER NOT NULL,          -- what this user owes the payer
  share_units INTEGER,                  -- for split_type = shares
  percentage NUMERIC(6,3),              -- for split_type = percentage
  PRIMARY KEY (expense_id, user_id)
);

-- Settlements ("I paid you back") — Splitwise records money movement, doesn't move it
CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,   -- NULL = direct
  from_user UUID NOT NULL REFERENCES users(id),
  to_user   UUID NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  idempotency_key VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);
```

Key indexes: `expenses(group_id, created_at DESC)` for the ledger view, `expense_splits(user_id)` for cross-group friend balances, and the partial unique indexes on `(created_by, idempotency_key)` for durable idempotency.

## API Design

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` \| `/login` \| `/logout` | Session auth |
| GET | `/api/auth/search?q=` | Find users to add |
| GET | `/api/dashboard` | Totals + per-friend balances |
| GET | `/api/groups` | My groups, each badged with my net balance |
| POST | `/api/groups` | Create a group (+ initial members) |
| GET | `/api/groups/:id` | Group + members |
| GET | `/api/groups/:id/balances` | Net balances + simplified transfers |
| POST | `/api/groups/:id/members` | Add a member |
| GET | `/api/expenses/group/:groupId` | Group ledger |
| POST | `/api/expenses` | Add expense (Idempotency-Key) |
| GET | `/api/expenses/:id` | Expense detail (splits + comments) |
| DELETE | `/api/expenses/:id` | Soft-delete |
| POST | `/api/settlements` | Record a payment (Idempotency-Key) |
| GET | `/api/activity` | Cross-group activity feed |

## Key Design Decisions

### 1. Derive balances, don't store them
A "running balance" column is tempting and fast to read, but it is a second source of truth that drifts the instant an edit, delete, or bug touches it — and then you cannot tell which number is the lie. We store only the immutable ledger (expenses, splits, settlements) and **derive** every balance on read. Correctness is structural: nets always sum to zero because they are the same rows summed with opposite signs. We buy back the read cost with a Redis cache keyed by group, invalidated on every write to that group. The trade-off is a cold-cache read that scans a group's expenses; acceptable because a group has bounded size and the result is immediately re-cached.

### 2. Integer cents + explicit remainder distribution
$10 split three ways is 333.33¢ each — floor to 333 and 1¢ is orphaned. We use the **largest-remainder method**: floor everyone, then hand the leftover pennies one at a time to the participants with the largest fractional remainder, deterministically (ties break by order). This guarantees `Σ owed == total` for every split type and is reproducible, so re-deriving a balance always yields the same cents.

### 3. Debt simplification as min-cash-flow (see deep dive)
Positive/negative nets → a minimal set of transfers via greedy max-creditor / max-debtor matching.

## Consistency and Idempotency

- **Add-expense and settlement** carry a client-generated Idempotency-Key. Two layers enforce exactly-once: a Redis `SET NX` gate (fast, catches simultaneous retries) and a Postgres partial `UNIQUE(created_by, idempotency_key)` index (durable, catches retries after cache eviction). A duplicate returns the original result, not a second write.
- **Split creation is transactional** — expense row + all split rows + activity row commit together or not at all, so a balance can never observe a half-written expense.
- **Balances are eventually consistent with the cache** for at most one write: we invalidate on write, and the cache has a short TTL as a safety net against a missed invalidation.

## Security / Auth

Session-based auth (Redis-backed session id in an `x-session-id` header), bcrypt password hashing. **Authorization is per-group**: every group/expense/settlement read re-checks membership (`getGroupMembership`) and 403s non-members — group financial data must never leak. Settlement writes additionally require the actor to be one of the two parties. Production would add rate limiting at the gateway and CSRF protection for cookie auth.

## Observability

Prometheus metrics via `prom-client` (`src/shared/metrics.ts`): request latency/counts, expenses/settlements by type, balance cache hit/miss, idempotency hits, and a `debt_simplify_duration` histogram. Structured JSON logging via Pino with sensitive-field redaction (`src/shared/logger.ts`). Health endpoints: `/health`, `/health/detailed` (checks Postgres + Redis), `/health/live`, `/health/ready`.

## Failure Handling

- **Redis down:** idempotency degrades gracefully — the request still processes, protected by the Postgres unique index; balance reads fall through to recompute from Postgres. The product stays up.
- **Duplicate write race:** the unique index throws `23505`, translated to a `409` with the original result.
- **Invalid split:** rejected with a `400` and a human message before any write.

## Scalability Considerations

The ledger shards cleanly by `group_id` — a group is a natural, self-contained unit; all of its expenses, splits, settlements, and balance math live on one shard. Cross-group "friend balances" (the dashboard) is the one query that fans out across shards; at scale it becomes a per-user denormalized aggregate maintained on write rather than computed on read. Balance reads scale horizontally behind the cache. The write path is a small transaction and scales with the DB's write capacity; the event stream absorbs notification/feed fan-out.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Balances | Derived on read + cache | Stored running balance | One source of truth; can't drift |
| Money type | Integer cents | Float / decimal | Exact; no penny drift |
| Rounding | Largest-remainder | Naive round each | Σ splits == total, deterministic |
| Debt reduction | Greedy min-cash-flow | Raw pairwise IOUs | ≤ n−1 payments vs up to n(n−1)/2 |
| Idempotency | Redis NX + PG unique | Single layer | Fast + durable |
| Settlement model | Record only | Move real money | Splitwise tracks, doesn't transfer |
| Auth | Session + Redis | JWT | Simple, revocable |
| Store | PostgreSQL | Wide-column | Relational ledger, bounded per-group reads |

## Implementation Notes

This section maps the production design to what actually runs locally (Docker + Node + React).

**Production-grade patterns actually implemented:**
- **Idempotency** — `src/shared/idempotency.ts`: Redis `SET NX` state machine (processing/completed/failed) plus the Postgres partial-unique backstop. Verified end-to-end: the same key sent twice creates one row and replays the first result.
- **Integer-cents split math with largest-remainder** — `src/services/splits.ts`. Mirrored on the client (`frontend/src/utils` → `allocateByWeights`) so the split editor previews the exact per-person cents the server will compute.
- **Debt simplification** — `src/services/balances.ts` → `simplifyDebts()`.
- **Balance cache + invalidation** — `src/db/redis.ts` (`getCachedGroupBalance` / `invalidateGroupBalance`), invalidated on every expense/settlement write.
- **Prometheus metrics** (`prom-client`), **structured logging** (Pino), and **health checks** — `src/shared/metrics.ts`, `src/shared/logger.ts`, `src/index.ts`.

**What was simplified or substituted:**
- Single PostgreSQL instead of a `group_id`-sharded cluster; single Valkey instead of a Redis cluster.
- The activity feed is written inline in the expense transaction instead of via an event stream (Kafka) with async fan-out.
- Session auth instead of OAuth; DiceBear URLs instead of uploaded avatars.
- "Friend balances" are computed on read; at scale they'd be a maintained per-user aggregate.

**What was omitted:** CDN, API gateway, multi-region, notifications, multi-currency FX, receipt OCR, and real payment rails (Splitwise integrates with third-party payment providers; here settlements are records only).
