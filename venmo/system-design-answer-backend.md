# Design Venmo - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design Venmo: a peer-to-peer payment platform with a social layer. Users send money instantly, request money, and see a feed of their friends' transactions.

The tension that defines this system: **it is two products with opposite consistency requirements bolted together.** The money movement demands strict serializability — a balance that goes negative is a company-ending bug. The social feed demands cheap, fast, eventually-consistent reads at enormous fan-out. Design the whole thing to the payments bar and the feed becomes unaffordable; design it to the feed's bar and you create money.

## 🎯 Requirements Clarification

Questions I'd ask first:

- **Are we the ledger of record, or do we sit on top of banks?** I'll assume we hold a real balance (a stored-value wallet) and integrate with ACH/card networks for funding and cashout. This is what makes the funding waterfall a core problem rather than a detail.
- **Is the feed social-network-scale?** Friends lists, not follower graphs — a few hundred friends typical, not millions of followers. That single fact decides the fan-out strategy.
- **Do we need instant payouts?** Yes — instant cashout to debit card (with a fee) alongside free standard ACH. These have very different failure semantics.
- **What's the regulatory posture?** Holding balances makes us a money transmitter: KYC on signup, transaction monitoring, and immutable audit retention are hard requirements, not features to negotiate. I'll assume they constrain the design from day one rather than being bolted on later — it's why the ledger is append-only and the audit log has no UPDATE/DELETE grants.

### Functional Requirements

- **Send money**: atomic transfer between two users, funded from balance/bank/card
- **Request money**: a claim another user can approve, which then executes as a transfer
- **Social feed**: friends' transactions with notes, likes, comments, and privacy controls
- **Cashout**: balance → bank (ACH, slow, free) or → debit card (instant, fee)

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Transfer latency | p99 < 500ms | It should feel instant, like handing over cash |
| Balance correctness | Absolute — no negative balances, no double-spends | Non-negotiable; the product is trust |
| Availability | 99.99% for transfers | Weekend/evening peaks are 5–10x baseline |
| Feed latency | p99 < 200ms, staleness of seconds is fine | It's a social feed, not a ledger |
| Auditability | Every cent traceable, 7-year retention | Regulatory (money transmitter licensing) |

### Scale Estimates

- 80M users, ~10M sends/day (~120/sec average, ~1,000/sec at Friday-night peak)
- Average ~200 friends per user → feed fan-out ~400 rows per public transaction
- Feed reads dominate: ~50M app opens/day, each pulling a timeline

## 📐 Capacity Estimation

Sizing the two halves separately, because they scale on different axes:

| Dimension | Estimate | Consequence |
|-----------|----------|-------------|
| Transfer write QPS | ~120/s avg, ~1,000/s peak | Comfortably a single primary's territory — the constraint is lock contention on hot rows, not raw throughput |
| Feed read QPS | ~50M opens/day ≈ 600/s avg, multi-thousand peak | Read-replica territory; feeds tolerate replica lag by definition |
| Feed write amplification | 10M transfers/day × ~400 fan-out rows = **~4B feed rows/month** | The dominant storage cost by an order of magnitude; drives TTL + eventual Cassandra migration |
| Wallet/ledger size | 80M wallets (~tiny) + 2 ledger entries/transfer ≈ **20M rows/day** | Ledger is the durable core; grows linearly, partitioned by time, never deleted |
| Balance cache | 80M × ~16 bytes ≈ **~1.3GB** hot set | Fits in a single Redis node; invalidated per transfer, not written through |

The headline: **the ledger is small and precious; the feed is enormous and disposable.** That inversion — the thing you must never lose is tiny, the thing you can drop is huge — is what lets us pick a strict store for one and a cheap TTL'd store for the other, and is the single most important sizing insight for the whole design.

## 🏗️ High-Level Architecture

```
                     ┌────────────────────────────┐
                     │        API Gateway         │
                     │   auth, rate limiting      │
                     └──────────────┬─────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌────────────────┐        ┌────────────────┐        ┌────────────────┐
│   Transfer     │        │     Feed       │        │    Funding     │
│    Service     │        │    Service     │        │    Service     │
│                │        │                │        │                │
│ send, request  │        │ timeline read  │        │ waterfall,     │
│ idempotency    │        │ privacy filter │        │ ACH / card,    │
│ ledger writes  │        │                │        │ cashout        │
└───────┬────────┘        └───────▲────────┘        └───────┬────────┘
        │                         │                         │
        │ transfer.completed      │ reads                   │ circuit-broken
        │        event            │                         │ calls
        ▼                         │                         ▼
┌────────────────┐        ┌───────┴────────┐        ┌────────────────┐
│    RabbitMQ    │───────▶│  Fan-out       │        │  Bank / Card   │
│                │        │  Workers       │        │  Networks      │
└────────────────┘        └───────┬────────┘        │  (external)    │
                                  │                 └────────────────┘
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌────────────────┐      ┌──────────────────┐      ┌────────────────┐
│   PostgreSQL   │      │      Redis       │      │   Audit Log    │
│ wallets,       │      │ balance cache,   │      │  append-only,  │
│ ledger,        │      │ idempotency,     │      │  7-yr retention│
│ transfers      │      │ sessions         │      │                │
└────────────────┘      └──────────────────┘      └────────────────┘
```

The critical boundary: **the money path is synchronous and transactional; the social path is asynchronous and queued.** A transfer commits to PostgreSQL and returns to the user. The feed fan-out happens after commit, via RabbitMQ. If the fan-out workers are down, money still moves — friends just see the transaction a bit later.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username, email, phone, pin_hash | unique username, email | |
| wallets | user_id (PK/FK), balance_cents (BIGINT), pending_cents | — | **Integer cents, never floats.** CHECK (balance_cents >= 0) as the last-resort invariant |
| ledger_entries | id, transfer_id, user_id, delta_cents, balance_after, entry_type | (user_id, created_at), (transfer_id) | Append-only, double-entry: every transfer writes a matched debit and credit summing to zero |
| transfers | id, sender_id, receiver_id, amount_cents, note, visibility, status, idempotency_key | unique (sender_id, idempotency_key), (sender_id, created_at DESC) | Status: pending → completed / failed |
| payment_methods | id, user_id, type (bank/card), last4, token, is_default, verified | (user_id) | Only network **tokens** stored — never PANs or full account numbers |
| feed_items | id, user_id (the viewer), transfer_id, actor ids, denormalized note/amount | (user_id, created_at DESC) | Fan-out target. Denormalized so a feed read is one index scan |
| idempotency_keys | user_id, key, operation, status, response (JSONB) | unique (user_id, key, operation) | Durable backstop behind the Redis fast path |
| audit_log | id (BIGSERIAL), actor, action, resource, ip, details, outcome | (actor_id, ts DESC) | Append-only; no UPDATE/DELETE grants for the app role |

**Money is stored as integer cents, not DECIMAL and never floats.** Venmo's amounts are US-dollar-denominated with two decimal places and a $5,000 cap — the entire value range fits in a BIGINT with room to spare. Floats are disqualified outright (0.1 + 0.2 ≠ 0.3 compounds into unreconcilable balances). DECIMAL would also be correct, but cents-as-integers make every arithmetic operation exact by construction and impossible to accidentally round. The one discipline this requires: the boundary layer must convert at the edges, and the API must never emit a float.

> "Note that `wallets.balance_cents` is a cached aggregate — the **ledger is the source of truth.** The balance column exists because reading a running total from a growing append-only table on every request is O(history). We keep them consistent by only ever mutating the balance inside the same transaction that appends the ledger entries, and we run a nightly reconciliation job that re-derives every balance from its ledger and pages a human on any drift. That job is not a nicety — it is how you find out you have a bug before your users do."

## 🔌 API Design

```
POST   /api/v1/transfers             → Send money (Idempotency-Key header required)
GET    /api/v1/transfers?cursor=…    → Personal transaction history
POST   /api/v1/requests              → Request money from a user
POST   /api/v1/requests/:id/approve  → Approve → executes a transfer from the requestee
POST   /api/v1/requests/:id/decline  → Decline a pending request
GET    /api/v1/feed?cursor=…         → Friends' transaction feed (cursor-paginated)
POST   /api/v1/feed/:id/like         → Like a feed item
POST   /api/v1/feed/:id/comments     → Comment on a feed item
GET    /api/v1/wallet                → Balance + available balance
POST   /api/v1/cashout               → Withdraw to bank (ACH) or card (instant)
GET    /api/v1/payment-methods       → List linked banks/cards (last-4 only)
POST   /api/v1/payment-methods       → Link a bank/card (stored as a token)
GET    /api/v1/friends               → Friend list + pending requests
POST   /api/v1/friends               → Send / accept a friend request
```

Cursor pagination throughout, keyed on `created_at`. Offset pagination on a feed is a correctness bug as much as a performance one — new items shift the window and users see duplicates and gaps.

**The exactly-once guarantee, end to end.** A send is safe to retry indefinitely because five checks line up:

1. **Client** attaches a stable `Idempotency-Key` (a UUID minted once per user intent, reused across retries).
2. **Redis fast path** returns the stored response if the key was seen — most retries die here, before any DB work.
3. **DB backstop**: the transaction re-checks `transfers(sender_id, idempotency_key)`; if Redis was cold, the unique index makes the second insert fail loudly instead of double-paying.
4. **Wallet lock** serializes the sender's concurrent attempts so step 3's check can't race itself.
5. **Response is stored, not a flag** — the retry gets the *original* transfer's id and status, so the client reconciles instead of resubmitting.

Miss any one and you either double-charge (drop 2–5) or block a legitimate payment that never happened (write the key before the transfer commits). The ordering — key recorded *inside* the same transaction as the money movement — is the part that's easy to get subtly wrong.

## 🔧 Deep Dive 1: Balance Consistency — Why Pessimistic Locking Here

The classic failure: a user with $100 fires two concurrent sends, $80 to Alice and $70 to Bob. Both read a balance of $100, both see sufficient funds, both commit. The user has now spent $150 they didn't have, and we've created $50 out of nothing.

**My approach: `SELECT … FOR UPDATE` on the sender's wallet row, inside a serializable-enough transaction.**

The transfer executes as:

1. Look up the idempotency key — if this request already ran, return the stored response and stop
2. `SELECT … FOR UPDATE` the sender's wallet, which takes an exclusive row lock. A concurrent transfer from the same sender **blocks here** rather than reading stale state
3. Compute available balance (balance minus pending holds) and compare against the amount
4. Run the funding waterfall to decide how much comes from balance vs. an external source
5. Debit the sender, credit the receiver, append both ledger entries, insert the transfer row — all in the same transaction
6. Commit. Only now is the money moved
7. **After commit**, invalidate the balance caches, publish the feed fan-out event, and send push notifications

To avoid deadlock when two users pay each other simultaneously, wallet rows are always locked in a **deterministic order (by user UUID)**, never in "sender then receiver" order. Without this, transaction A locks Alice→Bob while B locks Bob→Alice, and they wait on each other forever. This is a two-line fix that prevents a class of production incident that is miserable to debug.

**Why pessimistic locking rather than optimistic (version numbers + retry)?**

> "Optimistic locking wins when contention is rare, because it lets everyone proceed in parallel and only pays a cost on the rare conflict. That's the right call for, say, editing a profile. But look at where contention actually occurs here: it's *per-sender*, and a single user's concurrent sends are exactly the double-spend scenario we must serialize anyway. There's no parallelism to preserve — a user's own transfers *must* be ordered. Meanwhile the cost of getting it wrong is asymmetric and unbounded: an optimistic retry storm under load degrades into repeated read-compute-fail cycles, and if a bug ever lets a stale version through, we've minted money. Pessimistic locking makes the correctness argument trivial: the database will not let two transactions hold the same wallet row. I'll take a few milliseconds of lock-hold time for an invariant I can prove in one sentence."

**What I give up**: throughput per sender is serialized, so a single hot account (a business receiving thousands of payments) becomes a lock bottleneck. But note the asymmetry — the *sender* is locked; receivers are only credited. If a merchant account became a hot receiver, I'd move credits to an append-only ledger-entry insert with the balance materialized asynchronously, so credits never contend. Debits stay locked. Money in can be eventually consistent; money out cannot.

**Why not event sourcing outright?** It's the "correct" answer for a ledger, and it's where this design would land at 10x scale. I'd resist it at first because it converts every read of "what is my balance" into either a fold over history or a materialized projection you have to keep consistent anyway — you've moved the consistency problem, not removed it, and you've added replay/snapshotting machinery. The double-entry ledger table plus a locked balance column gets 90% of the auditability with a fraction of the operational surface.

## 🔧 Deep Dive 2: Idempotency and the Funding Waterfall

Money transfers are the canonical case where **retries are dangerous**. A mobile client on a flaky connection sends a transfer, the server commits, the response is lost, and the client's automatic retry sends it again. Without protection, the user pays twice and blames us.

**Two layers, because they fail differently:**

| Layer | Speed | Durability | Role |
|-------|-------|------------|------|
| Redis key check | Sub-millisecond | Ephemeral (24h TTL, lost on flush) | Fast path — catches the overwhelming majority of retries before any work happens |
| Unique constraint on (sender_id, idempotency_key) | Adds ~1ms | Permanent | Backstop — if Redis is cold or down, the second insert fails loudly instead of double-paying |

The subtlety people miss: **you must store the *response*, not just a "seen" flag.** A retry has to receive the original transfer's ID and status, or the client can't reconcile. And the key must be recorded in the *same transaction* as the transfer — if you write the key first and then crash, you've permanently blocked a payment that never happened.

**The funding waterfall** decides where the money comes from when the balance is short. Priority order:

1. **Venmo balance** — free, instant, no external dependency. Always exhaust this first.
2. **Default verified bank account (ACH)** — free to the user, but settlement takes 1–3 business days.
3. **Any other verified bank account** — the fallback when there's no default set, so a linked-but-not-default bank still funds before we reach for a card.
4. **Debit/credit card** — instant but carries a fee, so it's the last resort.

Here's the interesting part, and it's a consistency question, not a routing question: **the ACH debit has not settled when we credit the receiver.** We have handed the recipient real, spendable money against funds that are days from actually arriving, and ACH transfers can fail after the fact (insufficient funds, closed account) — days later.

> "So the funding waterfall is really a credit-risk decision disguised as an engineering one. Three ways to handle it. First, hold the receiver's funds until ACH settles — safest, but it destroys the product; 'instant payment' that takes three days isn't Venmo. Second, credit immediately and eat the losses — which is roughly what Venmo does, treating ACH-return fraud as a cost of business, funded by the instant-transfer fees and managed with velocity limits and risk scoring on new/unverified accounts. Third, front the money only for users above a trust threshold and force card funding (instant, guaranteed) for everyone else. I'd ship the third: it's the only one that gives the product its feel while bounding the downside. The engineering consequence is that a transfer's lifecycle doesn't end at commit — it has a *pending external charge* attached that can fail asynchronously and force a claw-back, which means the ledger needs reversal entries as a first-class concept, not an afterthought."

Reversals are appended, never deleted. An append-only ledger where corrections are new compensating entries is the only design that survives an audit — you can always answer "what did we believe, and when did we believe it."

## 🔧 Deep Dive 3: Feed Fan-Out — Why Write-Time Wins Here

Every public transaction should appear in the feeds of both participants' friends. Two options:

| Approach | Read cost | Write cost | Verdict |
|----------|-----------|------------|---------|
| ✅ Fan-out on write | O(1) — one indexed scan of `feed_items` by user_id | ~400 row inserts per transaction, async | Chosen |
| ❌ Fan-in on read | O(friends) — query every friend's transactions, merge, sort, filter by privacy | Zero | Rejected |

> "Fan-out-on-write is often the wrong default — it's what breaks Twitter when a celebrity with 50M followers tweets, because you're doing 50M writes for one action. The reason it's *right* here is the shape of Venmo's graph: it's a **friend graph, not a follower graph.** Friendship is mutual and socially bounded — a few hundred people, with a hard cap. There is no Venmo user with ten million friends, so the pathological fan-out case that kills this pattern simply cannot occur. Meanwhile the read side is brutally read-heavy: 50M app opens a day, each wanting a timeline, versus 10M writes. Precomputing at write time converts the expensive, unpredictable operation (merge-and-sort across hundreds of friends, with per-item privacy filtering) into a single index scan. I'm trading a bounded, asynchronous write amplification for a hard bound on read latency — and if the graph ever *did* grow follower-like semantics (public business accounts), I'd add the hybrid: fan out for normal users, fan in at read time for the handful of high-degree accounts, exactly like Twitter."

Two more details that matter:

- **Fan-out is asynchronous, via RabbitMQ, after the transfer commits.** It must never be inside the money transaction — a slow fan-out would extend the wallet lock hold time, and a fan-out failure must never roll back a completed payment. The queue also absorbs the Friday-night spike.
- **Privacy is resolved at fan-out time, not read time.** A `private` transfer fans out only to the two participants; `friends` fans out to the friend union. Filtering at read time would mean reading rows you must then discard, and one bug leaks a payment note to the world. Deciding once, at write time, means the read path has no privacy logic to get wrong.

The cost I accept: **privacy changes are not retroactive.** If a user flips a transaction from public to private after the fact, the rows are already fanned out. That's handled with a tombstone check on read for the rare edit — the one place I deliberately pay a small read cost, because "leaked after I made it private" is the kind of bug that ends up on the news.

## 🔁 Requests, Approvals, and Cashout

Two flows sit around the core transfer and share its consistency machinery without duplicating it.

**A money request is a claim, not a transfer.** When Alice requests $20 from Bob, we write a `payment_requests` row (`requester_id`, `requestee_id`, `amount`, `status = pending`) — no money moves, no wallet is touched. The interesting decision is *who executes the transfer and when*. It has to be Bob's approval that triggers execution, funded from **Bob's** wallet, running the exact same locked-transfer path as a normal send. The request row then flips to `approved` and stores the resulting `transfer_id`, so the two are permanently linked for the audit trail.

> "The trap here is treating a request as a pre-authorized pull. If approving a request could debit the requestee without re-running the full funding-and-locking path, you've built a way to move money that bypasses your one hardened code path — and now you have two places that can create a negative balance instead of one. So a request approval is *literally* a transfer with a different button on it: it re-checks the balance, re-runs the waterfall, takes the same wallet lock. The request table is just a durable intent record that makes the transfer idempotent — approving twice finds the row already `approved` with a `transfer_id` and returns it."

**Cashout is the reverse valve: balance leaving the system.** The `cashouts` table records `speed` (`instant` or `standard`), `fee`, `payment_method_id`, and `estimated_arrival`. The two speeds have opposite risk profiles:

| Speed | Rail | Fee | Settlement | Failure mode |
|-------|------|-----|-----------|--------------|
| Standard | ACH | Free | 1–3 business days | Return after the fact (rare) |
| Instant | Debit-card push | ~1.75% | Seconds | Network decline at request time |

A cashout debits the wallet *inside the same locked transaction* that creates the cashout row — the money leaves the balance immediately even though the external payout is still in flight. That's the safe direction: we're holding the user's money and paying it out, so worst case a failed payout is *credited back*, never double-paid. Contrast with funding, where the danger is the opposite (we credit before external money arrives). The asymmetry is the whole game: **debits are safe to do eagerly, credits against unsettled external money are not.**

## 🔐 Security and Auth

Auth is deliberately boring so the money code can be interesting. Sessions are opaque tokens in Redis with a 24-hour TTL, checked on every request — server-side sessions over JWTs specifically because **a compromised payment session must be revocable in one `DEL`**, and a stateless JWT can't be. A stolen JWT is valid until it expires; a stolen session dies the moment we notice.

Two payment-specific protections:

- **A payment PIN** (`pin_hash`, bcrypt) gates high-value sends independently of the login session — so a phone left unlocked for a minute can't drain a wallet. It's a second factor scoped to the money action, not the login.
- **We never store raw instrument data.** Card numbers are network **tokens** (`card_token`); bank account numbers are encrypted at rest (`account_number_encrypted`) and only last-4 is ever returned. This keeps the PAN/account number out of our blast radius entirely — a database leak exposes tokens that are useless off our platform, which is the difference between an incident and a catastrophe.

Rate limiting is enforced at the gateway per user and per device, with tighter velocity limits on *external-funded* transfers and new/unverified accounts — the same population where ACH-return fraud concentrates.

## 🛡️ Failure Handling

**External networks (bank, card) are the least reliable component and the most dangerous to retry.** They're wrapped in circuit breakers: after a threshold of failures the breaker opens and calls fail immediately rather than piling up 30-second timeouts until the connection pool is exhausted and the *whole* API goes down with it. After a cooldown, a probe request tests recovery.

Degradation is deliberately graded by what's at stake:

| Component down | Behavior |
|----------------|----------|
| Card/bank network | Balance-funded transfers still work. External-funded transfers are rejected up front with a clear message — never queued, because we cannot promise money we can't source |
| RabbitMQ / fan-out workers | Transfers complete normally; feed lags. Events are durably persisted so the backlog drains on recovery |
| Redis | Idempotency falls back to the DB unique constraint (slower, still correct); sessions degrade to re-login |
| PostgreSQL primary | Transfers stop. This is correct — there is no safe way to move money without the ledger. Fail closed, loudly |

That last row is the philosophy of the whole system: **for the money path, unavailability is always preferable to incorrectness.** For the social path, the opposite — stale feeds are fine.

## 📊 Observability

Beyond the standard latency/error/saturation metrics, the payment-specific signals I'd alert on:

| Signal | Metric | Alerts when | Tells us |
|--------|--------|-------------|----------|
| Reconciliation drift | Nightly ledger re-derivation vs `wallets.balance` | Any non-zero delta | A balance bug — **P0, always** |
| Transfer outcome mix | `transfers_total{status,funding_source}` | `insufficient_funds` / `failed` ratio spikes | Funding or contention problems, sliced by source |
| Transfer duration by step | histogram: lock-wait, debit, credit, commit | p99 lock-wait climbing | Hot-account contention, the earliest warning |
| Feed fan-out lag | `feed_fanout_duration` | p99 > seconds, or queue depth grows | Workers falling behind the Friday-night spike |
| Circuit-breaker state | breaker open/half-open per external rail | Breaker opens | Bank/card network degraded |
| Idempotency hit rate | Redis + DB idempotency hits | Sudden spike | Clients retrying → something upstream is timing out |
| Post-settlement charge failures | ACH-return / late-decline rate | Above baseline | The fraud / credit-risk signal behind the waterfall |

The two that are unique to a payments system — and that a generic dashboard wouldn't have — are **reconciliation drift** (it's how you catch a money bug before your users do) and **post-settlement failures** (it's how you catch fraud you already paid out). Everything writes an immutable audit entry (actor, action, resource, IP, request ID, outcome) with 7-year retention, because regulators require reconstructing any transaction's full history on demand.

Every money movement writes an immutable audit entry (actor, action, resource, IP, request ID, outcome) with 7-year retention, because financial regulators require reconstructing any transaction's full history on demand.

## 📈 Scalability: What Breaks First

1. **The wallet row lock on hot accounts.** Ordinary users have no contention (you can't send money from two phones at once meaningfully), but a business account receiving thousands of payments serializes on its row. Fix: make credits lock-free append-only ledger inserts with an asynchronously materialized balance; keep debits locked.
2. **`feed_items` table growth.** 10M transactions/day × ~400 fan-out rows = billions of rows/month. PostgreSQL will not hold this forever. Fix, in order: time-partition and aggressively TTL old feed rows (nobody scrolls back six months), then move feed storage to Cassandra — partition by user_id, cluster by time descending, which is precisely this access pattern's shape.
3. **The single PostgreSQL primary for transfers.** Fix: shard wallets/ledger by user_id. This is genuinely hard, because a transfer touches two users who may live on different shards, and now you need distributed-transaction semantics. The ledger design pays off here: settle each side as an independent idempotent ledger entry coordinated by the transfer record, then reconcile asynchronously — rather than a two-phase commit that would double the latency and add a coordinator failure mode.
4. **Feed reads** — solvable with read replicas long before the above, since feeds tolerate replica lag by definition.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Concurrency control | ✅ Pessimistic row locks | ❌ Optimistic versioning | Per-sender contention *must* serialize anyway; correctness argument is provable |
| Money representation | ✅ Integer cents | ❌ Float / DECIMAL | Exact by construction; float is disqualifying |
| Source of truth | ✅ Append-only double-entry ledger + cached balance | ❌ Balance column alone | Auditable, reversible, reconcilable nightly |
| Feed generation | ✅ Fan-out on write (async) | ❌ Fan-in on read | Bounded friend graph makes fan-out cheap; reads are 5x writes |
| Privacy filtering | ✅ At fan-out time | ❌ At read time | One decision point; read path can't leak |
| Idempotency | ✅ Redis + DB unique constraint | ❌ Either alone | Fast path plus durable backstop; they fail differently |
| External charges | ✅ Credit receiver immediately, bear ACH-return risk | ❌ Hold until settled | Preserves the product; bounded by trust tiers + velocity limits |
| Failure posture (money) | ✅ Fail closed | ❌ Queue and retry | Never promise money we cannot source |

## 🚀 Closing

If I had more time, the three threads I'd pull: **fraud and risk scoring** (velocity limits, device fingerprinting, social-graph anomaly detection — the ACH-return decision above is only survivable with this in place); **the reversal/dispute lifecycle** as a first-class state machine rather than manual ops; and **sharding the ledger**, where the interesting problem is cross-shard settlement without two-phase commit.

The thing I'd want to leave the interviewer with: this system's design is driven almost entirely by *recognizing which half of it is a bank and which half is a social network*, and refusing to let either one's requirements contaminate the other.

If forced to name the single load-bearing decision, it's the append-only double-entry ledger with a cached balance: it's what makes correctness *provable* (reconcile against history), *reversible* (compensating entries, never deletes), and *shardable later* (each side settles independently) — every other choice here is downstream of getting the ledger right.
