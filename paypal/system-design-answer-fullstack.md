# PayPal - System Design Answer (Full-Stack Focus)

## 🎯 Problem Statement

> "Design a peer-to-peer payment platform like PayPal where users can send money to each other, request payments, and manage digital wallets."

This system sits at the intersection of distributed systems and financial engineering. The central challenge is **money integrity** -- every dollar that enters the system must be accounted for, every transfer must be atomic, and every payment must be safely retryable. I'll cover the full stack: from the database ledger design that ensures financial consistency, through the API layer that provides idempotent payment processing, to the frontend that gives users confidence their money is being handled correctly.

## 📋 Requirements Clarification

**Functional:**
- User registration with automatic wallet creation
- Wallet management: deposit, withdraw, view balance
- P2P transfers between users with notes
- Money request flow (request, pay, decline)
- Transaction history with type filtering
- Payment method management (bank accounts, cards)

**Non-Functional:**
- Strong consistency for all money movement
- Idempotent payment operations (safe retries)
- 99.99% availability, p99 < 500ms for transfers
- Complete audit trail via double-entry ledger
- Mobile-responsive UI with instant feedback

**Scale Assumptions:**
- 50M registered users, 5M DAU
- 10M transactions/day (~115 TPS average, 500 TPS peak)
- Average transaction: $45

## 🏗️ Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐
│   React SPA  │     │   API GW     │     │   Payment Service    │
│              │────▶│  + Sessions  │────▶│                      │
│  Dashboard   │     │  + Rate Limit│     │  ┌────────────────┐  │
│  Send/Request│     │              │     │  │Transfer Engine │  │
│  Activity    │     └──────────────┘     │  └────────────────┘  │
│  Wallet Mgmt │                          │  ┌────────────────┐  │
└──────────────┘                          │  │Wallet Service  │  │
                                          │  └────────────────┘  │
                                          │  ┌────────────────┐  │
                                          │  │Idempotency Svc │  │
                                          │  └────────────────┘  │
                                          └──────────┬───────────┘
                                                     │
                              ┌───────────────────────┼────────────────┐
                              ▼                       ▼                ▼
                    ┌──────────────────┐     ┌──────────────┐  ┌──────────────┐
                    │   PostgreSQL     │     │   Redis      │  │  Kafka       │
                    │  Users, Wallets  │     │  Sessions    │  │  Events      │
                    │  Txns, Ledger    │     │  Cache       │  │  Notifs      │
                    └──────────────────┘     └──────────────┘  └──────────────┘
```

> "PostgreSQL is the source of truth for all financial data -- it gives us ACID transactions which are non-negotiable for money movement. Redis handles session storage and caching. The frontend talks to the API through a Vite dev proxy in development and an API gateway in production."

## 💾 Data Model

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| users | id (UUID PK), username (unique), email (unique), password_hash, role | Authentication and identity |
| wallets | id (UUID PK), user_id (FK unique), balance_cents (BIGINT), version (INT) | One wallet per user, optimistic locking |
| transactions | id (UUID PK), idempotency_key (unique), sender_id, recipient_id, amount_cents, type, status | Business event record |
| ledger_entries | id (UUID PK), transaction_id (FK), wallet_id (FK), entry_type (debit/credit), amount_cents, balance_after_cents | Double-entry accounting |
| transfer_requests | id (UUID PK), requester_id (FK), payer_id (FK), amount_cents, status | Money request workflow |
| payment_methods | id (UUID PK), user_id (FK), type (bank/card), label, last_four | Linked payment sources |
| idempotency_keys | key (PK), response (JSONB), expires_at | 24h TTL, prevents duplicate payments |

> "Amounts are stored as BIGINT cents, not DECIMAL. $10.50 is 1050. This eliminates floating-point arithmetic errors in the application layer. The database enforces `CHECK (balance_cents >= 0)` as a safety net -- even if there's a bug in the transfer logic, the database won't allow a negative balance."

### Why Two Tables for Financial Records?

The `transactions` table records the business event ("Alice sent $50 to Bob"). The `ledger_entries` table records the accounting impact. For a single transfer, we create one transaction and two ledger entries (debit sender, credit recipient). This separation enables:

- **Reconciliation**: For each wallet, SUM(credits) - SUM(debits) should equal `wallet.balance_cents`. If they disagree, we have a bug and can identify exactly where the divergence occurred.
- **Extensibility**: Adding fees, refunds, or multi-currency support means adding more ledger entries, not changing the transfer logic.
- **Audit compliance**: Financial regulators require a complete record of every balance change. The ledger provides this with timestamps and balance-after snapshots.

## 🔧 Deep Dive 1: Payment Atomicity (Full Stack)

**Backend: Database Transaction with Double-Entry Bookkeeping**

A P2P transfer creates five database operations within a single transaction:

1. Lock both wallets in user_id order (prevents deadlocks between concurrent bidirectional transfers)
2. Debit sender wallet -- decrement balance, increment version with optimistic lock check
3. Credit recipient wallet -- increment balance, increment version with optimistic lock check
4. Create transaction record with idempotency key
5. Create two ledger entries (debit for sender, credit for recipient)

If any step fails, PostgreSQL rolls back the entire transaction. The double-entry guarantee means: for every dollar debited, there's exactly one dollar credited. We can verify this at any time by summing all ledger entries.

**Why lock ordering matters:**

Without consistent lock ordering, two simultaneous transfers (Alice-to-Bob and Bob-to-Alice) could deadlock -- Transaction 1 holds Alice's wallet lock and waits for Bob's, while Transaction 2 holds Bob's and waits for Alice's. By always locking in ascending user_id order, one transaction always acquires both locks first, preventing the circular wait.

**Why optimistic locking on top of FOR UPDATE:**

We use `SELECT ... FOR UPDATE` to prevent deadlocks, but also check the `version` column in the UPDATE statement. This is belt-and-suspenders: the FOR UPDATE prevents concurrent reads, and the version check catches any bugs where we accidentally read outside the transaction boundary. In practice, the version check rarely fires, but it's a critical safety net for financial code.

| Approach | Pros | Cons |
|----------|------|------|
| Idempotency key in same DB txn | Can't have key without payment or vice versa | Slight write amplification |
| ❌ Redis-stored idempotency key | Faster lookup | Key and payment can diverge (Redis crash) |

> "Storing the idempotency key in the same database transaction as the payment is critical. If we used Redis, a crash between 'store key in Redis' and 'commit payment in PostgreSQL' could leave us in an inconsistent state -- the key exists but the payment didn't happen, so retries would return a cached response for a payment that never completed. Or worse, the payment committed but the key wasn't stored, allowing duplicate payments on retry."

**Frontend: The Send Flow UX**

The send flow is designed to prevent user error and handle every failure mode:

1. **User search with debouncing** -- 300ms debounce prevents excessive API calls. Selected user gets a green border confirmation so there's no ambiguity about the recipient. The dropdown shows both display name and username to avoid sending to the wrong person.

2. **Amount input** -- Large centered input with dollar prefix. The submit button dynamically shows "Send $50.00" so the user confirms the exact amount before tapping. No separate confirmation dialog needed -- the amount is always visible in the action button.

3. **Idempotency key** -- Generated client-side from `recipient_id + amount + timestamp`. If the network drops after the server processes the payment but before the response arrives, the user can safely retry. The backend recognizes the duplicate key and returns the original result without re-executing.

4. **Success state** -- Full-screen success card replaces the form entirely. We never show the populated form after a successful send, preventing confusion about whether the payment already processed. The user can choose "Send More" (which resets the form) or "Back to Dashboard."

5. **Error states** -- Different messages for each failure mode:
   - Insufficient funds: show current balance so the user knows how much they can send
   - Network timeout: "Payment may have been sent. Check your activity." -- we never say "failed" when it might have succeeded
   - Validation errors: inline messages next to the relevant field
   - Server errors: generic retry prompt

## 🔧 Deep Dive 2: Wallet Consistency

**Backend: Optimistic Locking**

Each wallet has a `version` column. Updates include `WHERE version = $expected`:

If the version changed between read and write, the UPDATE affects zero rows. We detect this and can retry or fail with a clear error. This prevents double-spending: two concurrent transfers from the same wallet can't both succeed because one will find a stale version.

Why not pessimistic locking alone? In a P2P system, a single user rarely sends multiple payments simultaneously. Optimistic locking avoids holding row-level locks during the transaction, improving throughput. Conflict rates are typically below 0.1%, making retries rare.

For the transfer case specifically, we do use `SELECT ... FOR UPDATE` to lock both wallets within the transaction boundary. This is because we need to atomically read-modify-write two rows, and optimistic locking alone would require complex retry logic for multi-row updates. The lock ordering (by user_id) prevents deadlocks.

**The balance integrity guarantee:**

At any point in time, for every wallet in the system:
- `wallet.balance_cents` equals `SUM(credit entries) - SUM(debit entries)`
- `wallet.balance_cents >= 0` (enforced by CHECK constraint)
- Every ledger entry has a `balance_after_cents` that forms a monotonic sequence

If any of these invariants are violated, the reconciliation job alerts the operations team. This is fundamentally different from a system that only tracks the balance column -- we can always prove the balance is correct by replaying the ledger.

**Frontend: Balance Display Strategy**

The wallet balance is the most sensitive piece of data in the app. We fetch it fresh on every dashboard visit rather than caching.

| Approach | Pros | Cons |
|----------|------|------|
| Always fresh balance | Financially accurate | 200ms latency on every dashboard load |
| ❌ Cached with stale-while-revalidate | Instant display | User might attempt transfer with stale balance |

> "For most apps, stale-while-revalidate is fine. For a payment app, showing $500 when the real balance is $50 could cause a user to attempt a transfer that will fail, or worse, give them false confidence about their financial state. The 200ms wait for a fresh balance is acceptable."

The dashboard fetches wallet balance, recent transactions, and pending requests in parallel using `Promise.all`. This reduces the perceived load time from sequential requests (~600ms) to the slowest single request (~200ms). The three API calls are independent, so parallelization is safe.

After a successful send, we optimistically subtract the amount from the displayed balance before the server confirms. This makes the UI feel instant. If the server rejects the transfer, we revert the displayed balance and show an error. Since the success screen covers the dashboard, the user doesn't see any balance flicker.

## 🔧 Deep Dive 3: Activity Feed and Request Management

**Backend: Transaction History**

The transaction history query joins `transactions` with `users` twice (for sender and recipient display names). Indexed on `(sender_id, created_at DESC)` and `(recipient_id, created_at DESC)` for efficient retrieval. The query uses `WHERE (sender_id = $1 OR recipient_id = $1)` to fetch all transactions involving the current user, regardless of direction.

Filtering by type (transfer, deposit, withdrawal) uses a WHERE clause on the indexed `type` column. The filter is passed as a query parameter and validated server-side against an allowlist of valid types.

Pagination uses LIMIT/OFFSET for simplicity, though cursor-based pagination would be more efficient at scale. At 10M transactions/day, the transactions table grows quickly. Monthly partitioning by `created_at` would keep each partition manageable and enable partition pruning on time-range queries.

**Frontend: Activity Page**

Filter pills at the top (All, Transfers, Deposits, Withdrawals) reload the transaction list when changed. Each transaction item dynamically renders based on the current user's relationship to it:

- If I'm the sender: red amount with minus sign, "To {recipient}" label, right-arrow icon
- If I'm the recipient: green amount with plus sign, "From {sender}" label, left-arrow icon
- Deposits: green with down-arrow, "Deposit" label
- Withdrawals: red with up-arrow, "Withdrawal" label

This context-aware rendering means the same transaction looks different for the sender and recipient. The `TransactionItem` component takes the `currentUserId` as a prop and derives all display logic from comparing it against `senderId` and `recipientId`.

Amount formatting uses `Intl.NumberFormat` with currency style for proper display: thousand separators, two decimal places, currency symbol. This handles edge cases that manual formatting misses.

**Request Management Flow:**

The request system uses a state machine:

```
pending ──▶ paid       (payer pays)
pending ──▶ declined   (payer declines)
pending ──▶ cancelled  (requester cancels)
```

From the frontend perspective:
- Incoming requests (where I'm the payer) show Pay and Decline buttons
- Outgoing requests (where I'm the requester) show a Cancel button
- Paying a request triggers a transfer through the same transfer engine -- the backend validates the payer, checks the request status, executes the transfer, and updates the request status
- The dashboard shows pending incoming requests prominently to drive engagement and resolution

The RequestCard component handles pay/decline actions with per-button loading states. After any action, the parent component re-fetches the request list to reflect the updated status. We use full re-fetches rather than optimistic updates for request state changes because the consequences of showing wrong request status (user thinks they already paid) are severe.

## 📊 API Design

```
POST /api/auth/register     Create account (wallet auto-created)
POST /api/auth/login        Session-based login
POST /api/auth/logout       Destroy session
GET  /api/auth/me           Current user info

GET  /api/wallet             Balance and wallet info
POST /api/wallet/deposit     Add funds (credit entry)
POST /api/wallet/withdraw    Remove funds (debit entry)

POST /api/transfers          P2P send (idempotency key in body)
GET  /api/transfers?type=    Transaction history with filter

POST /api/requests           Request money
GET  /api/requests           List requests (direction + status filter)
POST /api/requests/:id/pay   Pay pending request
POST /api/requests/:id/decline  Decline or cancel

GET    /api/payment-methods     List linked methods
POST   /api/payment-methods     Add method
DELETE /api/payment-methods/:id Remove method

GET /api/users/search?q=       Search users for send/request
```

**Registration creates a wallet automatically:** When a user registers, the backend creates both the user record and their wallet in the same database transaction. This ensures every user always has exactly one wallet -- no orphaned users without wallets, no wallets without users.

**User search for send/request:** The search endpoint uses ILIKE queries against username, display_name, and email. It returns at most 10 results and excludes the current user. The minimum query length is 2 characters to prevent overly broad searches that return too many results.

## 🔐 Security

**Backend:**
- bcrypt password hashing (10 rounds)
- Redis-backed sessions with HTTP-only, sameSite cookies
- Rate limiting: 50 auth/15min, 30 transfers/min, 1000 general/15min
- Database constraints as last line of defense (`CHECK balance >= 0`)
- Authorization checks on request pay/decline operations
- Parameterized SQL queries throughout (no string interpolation)

**Frontend:**
- No tokens in localStorage (HTTP-only cookies only)
- Session check on every route navigation via `checkAuth` in root component
- Client-side amount validation (defense-in-depth, server validates too)
- Payment methods show only last 4 digits, never full card numbers
- Auth state cleared from memory on logout

## 📈 Observability

- **Prometheus metrics**: Transfer duration histogram (labeled by completed/failed), wallet operation counters (deposit/withdraw/transfer), idempotency cache hit counter, HTTP request duration and count histograms
- **Structured logging**: Pino JSON logger with transaction IDs, user IDs, and amounts for financial operations. Error logs include stack traces for debugging. Request-level logging via pino-http middleware.
- **Health check**: `/api/health` tests database connectivity, returns 503 with `unhealthy` status if PostgreSQL is unreachable
- **Circuit breaker**: Opossum-based breaker with state transition logging. Opens after 50% error rate, resets after 30 seconds. Prevents cascade failures when external services degrade.
- **Reconciliation**: Periodic job comparing wallet balances against ledger entry sums. Any divergence triggers an immediate alert. This is the financial system's ultimate consistency check.

## 🔄 Failure Handling

**Database failures:** Every financial operation uses PostgreSQL transactions. On any error, ROLLBACK ensures no partial updates persist. The application logs the error with full context and returns an appropriate HTTP status.

**Redis unavailability:** Since Redis stores sessions, a Redis outage prevents authentication. The circuit breaker detects repeated failures and opens, returning 503 immediately. Non-auth operations that don't need Redis (like health checks) continue to function.

**Concurrent modification:** Optimistic locking detects when two transactions try to modify the same wallet simultaneously. The losing transaction receives a "Concurrent modification detected" error. The frontend can retry with a fresh balance, or the idempotency key prevents duplicate execution on automatic retries.

**Graceful shutdown:** SIGTERM and SIGINT handlers close the HTTP server (stop accepting connections), wait for in-flight requests to complete, then close database and Redis connections. This prevents data corruption during deployments.

## 📱 Responsive Design

- Desktop: 3-column dashboard layout (wallet+actions in left 2 columns, activity on right)
- Tablet: 2-column layout, wallet card spans full width
- Mobile: Single column, wallet card at top, stacked sections below
- Send/request forms: max-width 560px centered, large touch targets for amount input
- Navigation: horizontal on desktop, condensed for mobile

## 🔒 Two Wallets, One Lock Order

The transfer path is the only place in this system that touches **two** contended rows, and that's what makes it the interesting one.

Deposits and withdrawals touch a single wallet, so optimistic locking is enough: read the version, write conditionally, retry on conflict. A transfer locks both the sender's and the recipient's wallet — and two users paying each other at the same moment is the textbook deadlock. A locks its own wallet then reaches for B's; B locks its own then reaches for A's; neither can proceed and the database kills one after its deadlock timeout.

The fix is not a bigger lock or a longer timeout — it's **acquiring both locks in a consistent order** (here, by user id). Two transactions wanting the same pair of wallets will always take them in the same sequence, so one simply waits for the other. A cycle can't form because there's no ordering in which each holds what the other wants.

| Approach | Concurrent A→B and B→A | Cost |
|----------|------------------------|------|
| ✅ `SELECT … FOR UPDATE` in a consistent order | One waits a few ms, then both succeed | Transfers touching the same wallet serialize |
| ❌ Lock in request order | Deadlock; the database aborts one transaction | Retries, and a user-visible failure for a valid transfer |
| ❌ Optimistic version check on both | No deadlock, but conflicts are frequent on a hot wallet | Every conflict is a retry the *user* has to absorb |

> "The reason I'd reach for pessimistic locking here specifically, when optimistic is usually the better default, is what a failed retry *means*. For a deposit, retrying is invisible — same amount, same intent. For a transfer, by the time you retry the balance may no longer cover it, so a retry isn't a repeat of the same operation, it's a new decision the user has to make. Serializing on the row costs milliseconds; making the user re-confirm costs their trust in the product."

What we give up is throughput on a hot wallet: a popular payee serializes everyone paying them. That's the ceiling, and the escape hatch is an append-only ledger with an asynchronously projected balance — at which point "what's my balance" becomes eventually consistent, which is a much harder thing to explain to someone looking at their money.

## 📈 Scalability Path

**Phase 1 (Current):** Single PostgreSQL, single API server, Redis sessions. ~100 TPS.

**Phase 2 (1M users):** Read replicas for balance/history queries. Horizontal API scaling behind load balancer (stateless with Redis sessions). Kafka for event-driven notifications (transfer receipts, request alerts). ~1,000 TPS.

**Phase 3 (50M users):** Table partitioning by date for transactions/ledger. Wallet sharding by user_id hash across multiple PostgreSQL instances. Dedicated fraud service with ML pipeline consuming from Kafka. Multi-region deployment. ~10,000 TPS.

**What breaks first:** The single PostgreSQL instance under write-heavy transfer workloads. Read replicas help with balance queries and history, but transfers always hit the primary. Wallet sharding (distributing users across database instances) is the ultimate scaling solution for writes.

## 🎨 Design System Highlights

The PayPal color palette uses navy blue (#003087) for the navigation header and primary blue (#0070BA) for interactive elements. Success states use green (#019849) for incoming money and completed transactions. Danger red (#D20000) signals outgoing money and errors. This color language creates instant recognition: green = money in, red = money out.

The wallet card uses a gradient from navy to primary blue, making the balance the visual focal point of the dashboard. Quick action cards use subtle shadows that deepen on hover, providing tactile feedback.

## 🔄 State Management Decisions

**Why Zustand over Redux:**

The global state surface for a payment app is small -- just the authenticated user object. Zustand provides this with a single `create` call, no providers, no reducers, no action types. Payment forms use local `useState` because form data doesn't need to persist across navigations. If a user navigates away from the send form, they expect a fresh form when they return.

**Why no global data cache:**

For most applications, React Query or SWR provide excellent developer experience with caching, background refetching, and optimistic updates. For a payment app, these features work against us. A cached wallet balance that's 5 seconds stale could lead a user to attempt a transfer that will fail (showing $500 when the real balance is $50 after another transfer). We explicitly choose to fetch fresh data on every route navigation, accepting 200ms latency for financial accuracy.

**Form state isolation:**

Each payment form (send, request) manages its own state with `useState`. When the component unmounts (user navigates away), state is naturally discarded. There's no need to persist half-filled payment forms -- re-entering a recipient and amount takes seconds, and stale form data is dangerous (the recipient could have changed their username).

## 💰 Not Every Money Movement Is Two-Sided

A detail that shapes both the schema and the UI: **transfers are paired, deposits and withdrawals are not.**

A P2P transfer debits one wallet and credits another, and those two ledger entries must sum to zero — that's the invariant the whole double-entry model exists to protect. A deposit has no internal counterparty: money arrives from a bank the system doesn't control, so there is a credit and nothing to pair it with inside our books. A withdrawal is the mirror.

| Movement | Internal entries | Counterparty | What the invariant checks |
|----------|------------------|--------------|---------------------------|
| Transfer | Debit sender, credit recipient | Another wallet | Debits and credits cancel exactly |
| Deposit | Credit only | External funding source | `SUM(credits) − SUM(debits)` per wallet still equals `balance_cents` |
| Withdrawal | Debit only | External bank account | Same, in the other direction |

> "The reconciliation invariant is *per wallet*, not per transaction — `SUM(credits) − SUM(debits)` for a wallet must equal its stored balance. That holds for all three shapes. If I'd written the check as 'every transaction's entries sum to zero,' deposits and withdrawals would fail it, and the temptation would be to invent a fake internal account to balance against. Some ledgers do exactly that, modelling the bank as an account — it's defensible, and it makes the stronger per-transaction invariant hold. I'd only take it on if we needed to reconcile against bank statements, because that's the problem it actually solves."

**This shows up in the UI too.** The activity feed renders a transfer as "From Bob Smith" or "To Carol Williams" — it has a person to name. A deposit or withdrawal has no person, so it renders as the movement itself plus its funding source ("Transfer from Chase Checking"). A feed that assumed every row had a counterparty would render a blank name or crash on a null; the type field is what tells the client which shape it's looking at.

**And it's where status matters most.** A transfer between two internal wallets is atomic — it committed or it didn't. A withdrawal is `pending` until an external system confirms, which is a state the UI has to represent honestly rather than optimistically showing the money as gone.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Bookkeeping | Double-entry ledger | Direct balance updates | Audit trail, reconciliation, extensibility |
| Concurrency | Optimistic locking + FOR UPDATE | Pessimistic only | Best of both: deadlock prevention + conflict detection |
| Amount storage | BIGINT cents | DECIMAL | No floating-point errors in app code |
| Auth | Session cookies (HTTP-only) | JWT in localStorage | XSS-proof for financial app |
| Balance caching | Always fresh on navigation | Stale-while-revalidate | Financial accuracy is critical |
| State management | Zustand (auth only) | Redux / React Query | Minimal global state, no caching desired |
| Idempotency | Same DB transaction | Redis cache | Atomic with payment -- prevents divergence |
| Request state updates | Full re-fetch | Optimistic updates | Consequences of wrong status too severe |

## 📝 Key Takeaways

The full-stack design of a payment platform requires alignment between backend guarantees and frontend UX. The backend provides ACID transactions with double-entry bookkeeping -- every dollar is accounted for. The frontend provides idempotency keys and honest error messages -- users never accidentally pay twice, and they're never told a payment failed when it might have succeeded. The meeting point is the API contract: typed endpoints with clear error semantics that the frontend can translate into appropriate user guidance. This end-to-end thinking -- from database constraints to button labels -- is what separates a reliable payment system from one that loses user trust.
