# Robinhood (Stock Trading) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a retail stock-trading platform: streaming quotes, order placement across four order types, portfolio and P&L tracking, watchlists, and price alerts.

The first thing I want to establish, because it changes the entire design, is **what we are**. We are a **broker**, not an exchange. We do not match buyers against sellers. We accept an order, reserve the customer's money, and route it to a venue — an exchange or a market maker — which fills it and reports back. That distinction removes the hardest problem from the exchange version of this question (a low-latency matching engine) and replaces it with two different hard problems: **not letting a customer spend money they don't have**, and **fanning out a firehose of market data to a hundred thousand people who are all watching at once.**

## 🎯 Requirements Clarification

Questions I'd ask up front:

- **Are we an exchange or a broker?** Broker. Fills come from an external venue. Everything downstream must tolerate that being asynchronous, because a fill report can arrive milliseconds or minutes after submission.
- **Can a user go negative?** Never. Buying power is the hard invariant, and the entire order path is shaped by protecting it.
- **How stale can a quote be?** A second is fine for a portfolio view. It is *not* fine as the basis for a buying-power check — I'll come back to that, because it's the sharpest edge in this design.
- **Market hours?** Assume continuous trading for the core design. Market-hours gating and pre/post-market sessions are a policy layer on the order service, not a structural change.

### Functional Requirements

- **Quotes**: streaming, per-symbol, with subscribe/unsubscribe
- **Orders**: market, limit, stop, stop-limit; buy and sell; day / GTC / IOC / FOK
- **Portfolio**: positions with average cost basis, unrealized and day P&L
- **Watchlists and price alerts**
- **Audit**: every order event retained (SEC 17a-4 territory)

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Availability | 99.95% **during market hours** | Downtime at 3am costs nothing. Downtime at 9:31am is a regulatory event |
| Quote latency | p95 < 100ms tick-to-client | Users trade against what they see |
| Order latency | p95 < 500ms placement → confirmation | Below the threshold where users double-click |
| Consistency | Strong for orders/positions/buying power; eventual for quotes | Money is exact; prices are a stream |
| Concurrency | 100K+ WebSocket connections | And they all arrive within a 60-second window at the open |

### Scale Estimates

- **100K concurrent users** at the open, ~1M DAU
- **5,000 symbols × ~10 ticks/sec = 50K quote updates/second** ingested
- **500K–1M orders/day**, peaking around **1,000 orders/second** during volatility
- Each fill produces 3+ writes: order update, execution record, position upsert
- The number that actually matters, and I'll derive it in Deep Dive 2: **naive quote fan-out is ~30M messages/second.** That constraint is hiding inside "100K concurrent users" and appears nowhere in the requirements

## 🏗️ High-Level Architecture

```
┌────────────────────────────────────────────────────────────┐
│                  Clients (web, mobile)                     │
└────────┬──────────────────────────────────┬────────────────┘
         │ REST (orders, portfolio)         │ WSS (quotes, alerts)
         ▼                                  ▼
┌──────────────────┐              ┌──────────────────────────┐
│   API Servers    │              │   WebSocket Gateways     │
│   (stateless)    │              │   (~25K conns each)      │
└────────┬─────────┘              └───────────▲──────────────┘
         │                                    │ consume
         ▼                                    │
┌──────────────────┐   ┌────────────────────┐ │
│  Order Service   │──▶│       Kafka        │─┘
│ • validate       │   │  quotes (by symbol)│
│ • reserve BP     │   │  orders            │
│ • route to venue │   │  trades  (durable) │
│ • apply fills    │   └─────────┬──────────┘
└────────┬─────────┘             │
         │                       ▼
         │            ┌────────────────────────┐
         │            │ Workers                │
         │            │ • Quote broadcaster    │
         │            │ • Portfolio updater    │
         │            │ • Limit-order matcher  │
         │            │ • Alert evaluator      │
         │            └──────────┬─────────────┘
         ▼                       ▼
┌────────────────────┐   ┌────────────────────┐
│    PostgreSQL      │   │   Redis / Valkey   │
│ users(buying_power)│   │ • quote:{SYM} hash │
│ orders, executions │   │ • open-order index │
│ positions          │   │ • idempotency keys │
└────────┬───────────┘   │ • sessions         │
         │               └────────────────────┘
         ▼
┌────────────────────┐
│  Execution Venue   │  (exchange / market maker)
│  submit → fill rpt │
└────────────────────┘
```

Two structural decisions worth calling out:

1. **The order service is the only writer to `buying_power` and `positions`.** Everything else reads. One place enforces the money invariant, instead of auditing it across a codebase.
2. **Quote distribution never touches PostgreSQL.** Quotes flow ingest → Kafka → broadcaster → WebSocket, with Redis holding the current value for REST reads. A quote is never a database row on the hot path — 50K writes/second of data that's obsolete in 100ms is the textbook definition of a wasted write.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id, email, password_hash, **buying_power** (DECIMAL 14,2), account_status, role | unique(email) | `buying_power` is the invariant. Every write to it happens inside a transaction that locked this row |
| positions | id, user_id, symbol, quantity (14,6), avg_cost_basis (14,4), **reserved_quantity** | unique(user_id, symbol) | `reserved_quantity` does for shares what buying power does for cash |
| orders | id, user_id, symbol, side, order_type, quantity, limit_price, stop_price, status, filled_quantity, avg_fill_price, time_in_force, **version** | (user_id, created_at), (status, symbol) | pending → submitted → partial → filled / cancelled / rejected / expired |
| executions | id, order_id, quantity, price, venue, executed_at | (order_id) | Append-only. One row per fill; an order can have many |
| watchlists / watchlist_items | user_id, name / symbol | unique(user_id, name), unique(watchlist_id, symbol) | |
| price_alerts | user_id, symbol, target_price, condition, triggered | **(symbol)** — indexed by symbol, not user | The evaluator asks "which alerts fire at this price for this symbol," so the index must serve *that* query, not the user's |
| portfolio_snapshots | user_id, total_value, buying_power, snapshot_date | unique(user_id, snapshot_date) | Daily rollup. Turns the P&L chart into a range scan instead of a replay of every execution |

Three things worth defending:

**Money is DECIMAL, never float.** `DECIMAL(14,2)` for cash, `(14,4)` for prices, `(14,6)` for quantities (fractional shares). A float `buying_power` accumulates rounding error across a few thousand trades until a user's balance disagrees with the sum of their transactions — which, at a brokerage, isn't a bug, it's a reportable event.

**`executions` is separate from `orders`, and it's append-only.** An order is mutable state (`filled_quantity` climbs). An execution is an immutable historical fact. Conflating them means you cannot answer "what price did each piece actually fill at" after a partial fill — and that is precisely the question a regulator or an angry customer asks.

**`positions` carries `reserved_quantity`.** Cash has buying power; shares need the same treatment. Without it: a user with 100 AAPL places two sell orders for 100 shares each. Both pass a naive `quantity >= 100` check. Both fill. The user is now short 100 shares of a stock they never intended to short, and we created the short.

## 🔌 API Design

```
POST   /api/orders            → Place order (X-Idempotency-Key required)
GET    /api/orders            → List (filter by status/symbol)
DELETE /api/orders/:id        → Cancel (only if not yet filled)
GET    /api/portfolio         → Summary: buying power, positions, P&L
GET    /api/quotes/:symbol    → Current quote (Redis read)
GET    /api/watchlists        → Watchlists + items
POST   /api/alerts            → Create price alert
WSS    /ws?token=…            → subscribe / unsubscribe / subscribe_all / ping
```

## 🔄 The Order Lifecycle

Everything in this system is easier to reason about once the state machine is on the board, because every failure mode is "we're stuck in a state" or "we transitioned twice."

```
                  ┌──────────┐
   place ────────▶│ pending  │  BP reserved, not yet at the venue
                  └────┬─────┘
        ┌──────────────┼──────────────┐
        │ route        │ cancel       │ reject (validation)
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │ submitted │  │ cancelled │  │ rejected  │
  └─────┬─────┘  └───────────┘  └───────────┘
        │  fill report          (BP released in both)
   ┌────┴─────┐
   ▼          ▼
┌────────┐ ┌────────┐
│partial │ │ filled │ ── position upsert, BP settled
└───┬────┘ └────────┘
    │ more fills / EOD
    ▼
┌──────────┐
│ expired  │  (day order, unfilled)
└──────────┘
```

Two properties this diagram enforces:

- **Buying power is released on exactly one edge out of every terminal state.** Cancelled, rejected, expired → refund the full reservation. Filled → settle the difference between reserved and actual. If a state can be entered by two paths, the refund must be idempotent, which is why the release is conditional on the order's current status inside the same transaction.
- **`submitted` is the dangerous state.** It's the only one where the venue may know something we don't. Every recovery procedure in this system is, at bottom, a way of resolving orders stuck in `submitted`.

## 🔧 Deep Dive 1: The Buying-Power Invariant

This is the correctness core of the system. The rule: **a user's cash, plus their open buy-order reservations, plus the value of their positions, is conserved.** No code path may create money.

**The naive design and exactly how it breaks.** Check the balance, then place the order:

1. Read `buying_power` = $10,000
2. Order costs $9,000 → passes the check
3. Insert order, deduct $9,000

Two requests overlap between steps 1 and 3 — a double-clicked button, a mobile client retrying a request whose response was lost — and both read $10,000, both pass, both deduct. The user now sits at **−$8,000** with two orders that will both fill. It takes a few milliseconds of overlap to trigger, and it's the single most common bug in every naive trading backend.

**What I do instead — reserve at placement, inside a transaction that locks the user row:**

1. `BEGIN`
2. Select the user's `buying_power` **FOR UPDATE** — this serializes concurrent order placements *for this one user*
3. Compute the reservation (see below)
4. If `buying_power < reservation`, roll back and reject
5. Insert the order with status `pending`
6. Decrement `buying_power` by the reservation
7. `COMMIT`

> "The pessimistic row lock is the right tool *here specifically*, and the reason is the contention shape. That lock serializes writes to one row — and the only writer to that row is that one user's own orders. A human places maybe one order every few seconds; the lock is held for one small transaction, single-digit milliseconds. There is essentially no contention. Contrast the exchange case, where thousands of strangers contend for the same order-book row and pessimistic locking collapses into a queue. Same primitive, opposite verdict. What changed is the *contention graph*, not the primitive — and that's the thing to reason about, rather than pattern-matching 'locks are slow.'"

**Why not optimistic locking on the user row?** Optimistic locking wins when conflicts are rare *and* retries are cheap. Here conflicts are already rare, so optimistic buys nothing — and the retry is not cheap. Re-running a market order means re-pricing it against a quote that may have moved, so the retry can produce a *different reservation* than the original attempt. You'd have traded a 2ms lock for a re-pricing loop with its own correctness questions. On a low-contention row, pessimistic locking is simply the cheaper correct answer.

**The reservation amount is the interesting sub-problem.** For a limit buy it's exact: `quantity × limit_price`. For a **market** buy, we don't know the fill price yet. Reserve at the current ask, let the price move 2% against us between placement and fill, and the fill costs more than we held — the user goes negative anyway, just more slowly and more confusingly.

So the reservation is `ask × quantity × (1 + buffer)`, with the buffer sized to the symbol's volatility — a couple of percent for a mega-cap, much wider for a thin small-cap or a stock that just halted on news. On fill we settle: refund the unused reservation, or, if the fill would blow through the buffer, reject the order *before routing* rather than fill it into a negative balance.

**What we give up:** the buffer over-reserves. A user with exactly $1,000 of buying power cannot place a $995 market order, because we're holding back for slippage. That is a genuine product cost — it reads as a bug to the user — and the mitigations are to make the buffer volatility-aware and to show "estimated cost including buffer" in the UI rather than pretending the order is free. I'll take that over the alternative, which is customers with negative balances and a manual collections process.

**Where optimistic locking *is* right: the order row.** The limit-order matcher and the user's cancel button race for the same order. Here the conflict is between two *different* actors, both trying to move the order out of `pending`, and the loser should simply lose — there is nothing useful to retry. So `orders` carries a `version` column and the fill update is conditional on it. If the matcher's update touches zero rows, the user cancelled first and the matcher drops it. If the cancel touches zero rows, the fill won and the UI shows "filled." Critically, no locks are held across the matcher's scan — which matters a great deal, because that scan touches a lot of rows.

## 🔧 Deep Dive 2: Quote Fan-Out — the 30-Million-Messages Problem

**Do the arithmetic before designing anything.** 100K concurrent connections. The average active user watches a portfolio plus a watchlist — call it 30 symbols. Quotes tick roughly 10×/second.

> 100,000 connections × 30 symbols × 10 ticks/sec = **30,000,000 messages/second**

That number kills the naive design, and nothing in the requirements hints at it. The *ingest* rate — 50K updates/second — is trivial. It's the **fan-out multiplier** that's brutal, and it's the first thing I'd write on the whiteboard.

**How the obvious approaches concretely break:**

| Approach | The specific bottleneck |
|----------|-------------------------|
| ❌ Broadcast every tick to every connection | 100K × 50K = 5B msg/sec. Not a tuning problem; a physics problem |
| ❌ Per-connection filtering, one message per tick | 30M msg/sec. Each message is a JSON serialize plus a socket write. A Node process manages ~100K small writes/sec, so you'd need 300 gateway processes purely to push bytes — before any application logic |
| ❌ Poll `GET /api/quotes` every second | Same fan-out with 20× the per-message overhead: TLS records, HTTP headers, a Redis round-trip per request, and 100K req/sec hitting the API tier |
| ✅ Conflate + batch per connection | 400K msg/sec — see below |

**The design, in three moves:**

**1. Subscription-scoped delivery.** Each gateway keeps, per connection, the set of symbols that connection wants — and, crucially, the *inverted* index: symbol → set of connections. Kafka is partitioned by symbol; each gateway consumes all partitions and looks up the inverted index on each tick. Filtering must be an index lookup, not a walk over 100K connections per tick, or you've just moved the 30M problem into the CPU.

**2. Conflation.** This is the move that makes the whole thing tractable. A price is **idempotent state, not an event**: if AAPL ticks three times in 250ms, the first two values are worthless the instant the third arrives. So the gateway does not forward ticks. It marks `(connection, symbol)` pairs dirty and flushes on a **250ms timer**, sending only the latest value per dirty symbol.

> "Conflation works because of a property specific to quotes: newer strictly supersedes older. I want to be precise that this is not a general-purpose optimization I'd reach for anywhere. I would *never* conflate the user's own order events — 'partially filled at $150' followed by 'filled at $151' are two distinct facts, and dropping the first loses a fill price we're legally required to have. Knowing which streams are **state** and which are **events** is the entire game. Quotes are state. Fills are events. They ride the same Kafka cluster and get opposite delivery disciplines."

**3. Batching.** One flush per connection per 250ms carries an *array* of all changed quotes, not one message per quote. So a connection receives **4 messages/second** regardless of whether it watches 3 symbols or 300.

**The result**: 100K connections × 4 = **400K messages/second** across the fleet, spread over ~4 gateways at 25K connections each — about 100K messages/sec/process, comfortably inside a Node process's budget. We took 30M down to 400K by exploiting one property of the data.

**What we give up:** up to 250ms of quote staleness. For retail that is invisible — a human cannot perceive it and cannot act on it. For a high-frequency client it would be disqualifying, but that is not who this product serves, and designing for a user we don't have would cost us the users we do. If a pro tier later needs 50ms, the conflation interval becomes a per-connection parameter, not an architectural rewrite. That's the sign of a good boundary: the expensive property is a knob, not a rebuild.

**Why Kafka in the middle rather than Redis pub/sub?** For quotes *alone*, Redis pub/sub would honestly be fine — a lost tick is harmless, since the next one supersedes it. But the same pipeline carries `trades`, and there a lost message means a position that silently never updates. Redis pub/sub is fire-and-forget: if the portfolio-updater worker happens to be restarting when a fill event publishes, that fill is gone forever, the user's position is permanently wrong, and *nothing in the system can detect it* — there's no gap to notice. Kafka's committed offsets mean a crashed worker resumes exactly where it stopped. I'll pay Kafka's operational cost for the one topic that needs durability, and durable quotes come along for free.

## 🔧 Deep Dive 3: Matching Limit Orders Without Scanning the Table

A limit order sits until the market reaches its price. The naive matcher polls: every 2 seconds, select all open limit orders, compare each to the current quote.

**Why that breaks, specifically.** GTC orders accumulate — most users with a position have a standing "sell if it hits $200." At 1M open orders, a full scan every 2 seconds is **500K rows/second of pure read amplification** against the same PostgreSQL primary serving the order path. The scan competes for buffer cache with the writes, holds a snapshot that fights vacuum, and the latency of *placing* an order degrades because the *matching* of a million unrelated orders is hammering the database.

And it scales the wrong way. The cost grows with total open orders. The useful work — orders that actually became executable — grows with *price movement*, which is tiny. We are doing O(open orders) work to find O(a handful) of matches, forever.

**The inversion:** stop asking "which orders are executable?" Ask "which orders just *became* executable?" That's a range query on price, and price is one-dimensional.

Per symbol, maintain two Redis sorted sets — open buy limits scored by limit price, open sell limits scored by limit price. On every quote tick for that symbol:

- Buy limits become executable when `ask ≤ limit_price` → a single range query over `[ask, +∞)` returns exactly the newly-qualifying orders
- Sell limits become executable when `bid ≥ limit_price` → a range query over `(−∞, bid]`
- Stop orders live in the same structure with the comparisons inverted

Cost per tick is O(log n + k), where k is the number of newly-executable orders — usually zero. We went from "scan a million rows every 2 seconds" to "one indexed range query per tick, returning nothing 99.9% of the time." The database is touched only when there is actual work to do.

**Single-writer per symbol.** The matcher must be a **single leader per symbol.** Two matchers racing on the same order both attempt the fill; even with the optimistic `version` check saving us from a double-fill in the database, the loser has already *routed a real order to the venue*, and un-routing it is not a thing you can do. Leadership is a Redis lease with a TTL and a heartbeat; a matcher that loses its lease stops immediately. Symbols are independent, so N matchers each own a slice of the symbol space and this scales horizontally.

**What we give up:** Redis is now on the correctness path, and Redis is not durable the way PostgreSQL is. So the sorted sets are a **derived index, not the source of truth** — PostgreSQL still holds every open order. On matcher startup, or after a Redis failure, we rebuild the index by scanning open orders from PostgreSQL. That rebuild is exactly the expensive scan we were trying to avoid — but it happens on recovery, not every two seconds. That's the trade: pay O(n) once at startup to make the steady state O(log n) per tick.

## 🛡️ Idempotency, Failure Handling, and One Thing I'd Change

**Idempotency on order placement.** The client generates a key per order intent. Redis claims it atomically; a completed key returns the cached result; an in-progress key returns 409.

Here's a judgment call I want to flag, because the tempting answer is wrong. A common implementation **fails open** when Redis is unavailable — let the order through rather than reject it. That's defensible for a like button. It is not defensible here:

> "If Redis is down and we fail open on idempotency, every client retry during that outage places a *second real order*. And retries spike precisely during an outage, because the outage is what's making things slow. So the failure mode is: Redis blips for ninety seconds, and a subset of users buy twice as much stock as they intended, at market, in an unstable moment. Unwinding that means selling the unwanted shares at whatever price the market now offers — the customer eats a real loss caused by our infrastructure. I'd fail **closed**: reject with a 503 and 'please try again.' A rejected order costs a user thirty seconds of annoyance. A duplicate order costs them money and costs us a conversation with a regulator about supervision of the order path. Those are not comparable costs, so they don't get a symmetric default."

The durable backstop for the same problem is a unique constraint on `(user_id, idempotency_key)`. It catches whatever Redis misses and turns a duplicate into a constraint violation instead of a duplicate order.

**Dependency failure policy:**

| Failure | Behavior | Why |
|---------|----------|-----|
| Redis (quote cache) | Serve last known quote from gateway memory; REST quote endpoint degrades | Quotes are refreshable; brief staleness is survivable |
| Redis (idempotency) | Reject new orders (503) | Fail closed — see above |
| Redis (order index) | Matcher pauses and rebuilds from PostgreSQL | Correctness of matching beats availability of matching |
| PostgreSQL | Reject orders; portfolio serves read-only from cache | We won't do what we can't record |
| Kafka | Orders still execute (the synchronous path is unaffected); quote broadcast and portfolio updates lag; events buffer | The trade already committed in Postgres. Kafka is propagation, not truth |
| Venue timeout | Order stays `submitted`; **never** blind-retry | A retried submit can double-fill. Query the venue's order status instead |

That last row is the in-doubt problem every trading system has, and the rule is universal: **never retry a submission whose outcome you don't know.** Ask the venue what happened; don't guess and resubmit.

**Graceful shutdown** matters more here than in most systems. On SIGTERM: stop accepting orders, stop the matcher and *release its lease* so a peer picks up those symbols immediately, drain in-flight requests, flush Kafka, close pools. A matcher killed without releasing its lease leaves its symbols unmatched until the TTL expires — and during a volatile minute, that's a lot of stop-losses that didn't fire.

## 🧭 Consistency Model

Different data gets different guarantees. Being explicit about this is what lets us go fast where it's safe.

| Data | Guarantee | Why |
|------|-----------|-----|
| `buying_power` | Strong, serializable | The invariant. No exceptions, no caching, no replicas on the write path |
| `positions` | Strong | A position is money in a different shape |
| Order status | Strong, monotonic through the state machine | An order must never go backwards from `filled` |
| Portfolio view (positions × current price) | Eventual, ~250ms | It's a *derived* value combining strong data (quantity) with eventual data (price). The strong part must be right; the eventual part is a display |
| Quotes | Eventual, bounded ≤ 250ms by conflation | State, not events |
| Price alerts | At-least-once delivery | A duplicate alert notification is a mild annoyance. A missed one is a broken promise. When in doubt, deliver again |
| Watchlists | Eventual, optimistic on the client | Nobody loses money if a symbol takes 200ms to appear |

The interesting row is the portfolio view. It's tempting to say "the portfolio is eventually consistent" and move on — but that's sloppy, because it's a *composite*. The share count must be exactly right; the market value can be 250ms stale. If you treat the whole object as eventual you'll eventually cache the quantity too, and then a user sells 100 shares and the UI still shows them holding 100.

## 🔔 Price Alerts: A Fan-Out Problem in Disguise

Alerts look like a side feature. They're actually the same shape as limit-order matching, and they should reuse the same machinery.

The naive version — every tick, query `price_alerts` for the symbol and compare — is the table-scan mistake from Deep Dive 3, one level down. With 1M users each holding a handful of alerts, that's millions of rows re-evaluated against a 50K-tick/second stream.

Instead: alerts live in the same **per-symbol sorted-set-by-price** structure as limit orders. A tick does a range query and gets exactly the alerts that just crossed. When an alert fires:

1. Mark it `triggered` in PostgreSQL (conditional on `triggered = false`, so a duplicate tick can't fire it twice)
2. Emit an event to Kafka
3. A notifier worker fans it out to the user's WebSocket connection and/or a push notification

The idempotency here is the conditional update, not a key — it's cheaper and it's exactly as strong. And note that alerts, unlike quotes, are **events**: an alert that fires and is dropped is simply never seen. That's why it goes through the durable Kafka path and not the conflated quote path, even though the *trigger* comes from the quote stream. Same input, different delivery discipline, because the output has different semantics. That distinction — state versus events — shows up three separate times in this design, and it's the single most useful lens for reasoning about it.

## 🔐 Auth and Abuse Controls

- **Session tokens, not JWTs.** A brokerage needs *immediate* revocation — when we detect account takeover, "the token expires in 15 minutes" is not an acceptable answer while someone liquidates a portfolio. Sessions live in Redis (fast path) with a PostgreSQL backing row (durable), and a logout or a security event kills them instantly.
- **The WebSocket authenticates at connect time and re-validates on subscribe.** A connection that outlives its session must be closed, not merely denied new subscriptions — otherwise a revoked user keeps receiving a live feed.
- **Rate limits are tiered by cost, not by endpoint uniformity.** Order placement is limited per-user-per-second because each order costs a database transaction, a venue submission, and real money. Quote reads are cheap. Auth endpoints are limited hardest, per IP, because credential stuffing against a brokerage is the highest-value attack surface we have.
- **The limits matter most exactly when they're most annoying**: during volatility, everyone trades at once, which is both when we most need to shed load and when shedding load is most visible. That tension is worth naming rather than hiding behind a config value.

## 📊 Observability

| Signal | What it tells me |
|--------|------------------|
| `order_execution_duration_ms` p99, by order_type | The SLO. Market orders should be fast; if *limit* orders start showing up here, the matcher is backed up |
| `orders_rejected_total{reason}` | The most diagnostic metric in the system. A spike in `insufficient_buying_power` is normal user behavior; a spike in `stale_quote` means the quote pipeline is lagging and we are now rejecting perfectly valid orders |
| `orders_pending` gauge | Matcher backlog. Monotonic growth means the matcher is dead or lost its lease and nobody took over |
| Quote pipeline lag (ingest ts → broadcast ts) | Measures the 100ms SLO end to end, in the units the user experiences |
| `websocket_connections` gauge | Cliff-drops mean a gateway died — and the reconnect stampede is the next thing that will hurt |
| Nightly position reconciliation | For each position, replay `executions` and confirm quantity and cost basis match. Drift pages a human. This is the "we didn't invent shares" invariant, verified continuously rather than assumed |

## 📈 Scalability: What Breaks First

1. **WebSocket connections.** A Node process tops out near 25K connections before event-loop latency eats the 100ms SLO. Fix: horizontal gateways behind a load balancer with connection-count-aware routing — *not* round-robin, because a gateway that just restarted must not be handed 25K reconnects at once. The real hazard is the **reconnect stampede at market open**: 100K clients connecting inside 60 seconds. Mitigations are jittered client backoff and admission rate-limiting at the gateway, so a restart doesn't turn into a thundering herd that prevents the gateway from ever becoming healthy.

2. **PostgreSQL write throughput on fills.** Three-plus writes per fill; at 1,000 orders/sec that's 3K writes/sec plus buying-power updates, all contending. Fix in order: (a) **batch position updates** in the portfolio worker — ten fills for the same symbol collapse into one upsert; (b) **read replicas** for portfolio and history so reads stop competing with the order path; (c) **shard by `user_id`**. Sharding works cleanly here for a reason worth naming: *there are no cross-user transactions.* Unlike an exchange, where every trade touches two users on potentially different shards, a broker's order touches one user and an external venue. That property is what makes this system shard easily, and it comes directly from the "we're a broker, not an exchange" decision at the top.

3. **The single-leader matcher on a hot symbol.** A meme stock or an earnings surprise concentrates open orders on one symbol, and you cannot shard within a symbol without losing price-time fairness. The escape is vertical: the Redis sorted-set index already removed the scan, so what's left is genuinely small work — but it's a real ceiling and I'd rather say so than pretend otherwise.

4. **Quote ingest at 5,000 symbols.** Trivially partitionable by symbol. This is the easiest thing in the system to scale, and it's the thing most people worry about first.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Buying power | ✅ Reserve at placement, row lock on user | ❌ Check-then-write | Read-then-write races let a user spend the same dollar twice |
| Concurrency on user row | ✅ Pessimistic lock | ❌ Optimistic | Contention is per-user and near zero; a retry would force re-pricing |
| Concurrency on order row | ✅ Optimistic (`version`) | ❌ Pessimistic | Matcher vs. cancel is a real race with no useful retry; locks would block the scan |
| Market-order reservation | ✅ Ask × (1 + volatility buffer) | ❌ Reserve at last price | Slippage between placement and fill produces negative balances |
| Quote delivery | ✅ Conflate + batch on a 250ms tick | ❌ Forward every tick | 30M msg/sec → 400K msg/sec by exploiting that quotes are state, not events |
| Fill events | ✅ Never conflated; durable via Kafka | ❌ Same discipline as quotes | A lost fill is a permanently wrong position with no gap to detect |
| Limit matching | ✅ Redis sorted set by price, driven by ticks | ❌ Poll all open orders every 2s | O(log n) per tick vs. O(open orders) per poll — and the poll cost grows with a number that never shrinks |
| Idempotency when Redis is down | ✅ Fail **closed** (503) | ❌ Fail open | A duplicate market order costs the customer real money |
| Venue timeout | ✅ Query order status | ❌ Retry the submit | Blind retry double-fills |
| Money representation | ✅ DECIMAL | ❌ float | Rounding drift becomes an unreconcilable balance |

## 🚀 Closing: What I'd Build Next

The most interesting unsolved thing in this design is **the halt.** A stock halts on news. The quote stream stops. Limit orders sit. And when it reopens, the price gaps 30% straight through a thousand stop-losses at once. Every assumption in this architecture — continuous pricing, a liquid two-sided market, a quote you can trust as a fill estimate — fails exactly when it matters most, which is exactly when the customer is most upset. Doing it properly means market-state awareness in the matcher (a halted symbol must never fill against a stale quote), auction-open logic for the reopening print, and an honest product answer to what a $200 stop order *means* when there was no trade between $200 and $140.

Beyond that: **session and market-hours policy** (pre-market, after-hours, GTC expiry, which is mostly a state machine on the order), **fractional shares** (really a rounding-and-allocation problem, not a trading one — you must not create or destroy a share while splitting a fill across users), and **regulatory reconstruction**. The audit trail we're already writing exists so that, someday, someone can reconstruct exactly what a customer saw and exactly what we did about it. Making that reconstruction *possible* is a first-class design requirement, not a compliance chore to bolt on later — and it's the reason `executions` is append-only rather than a column on `orders`.
