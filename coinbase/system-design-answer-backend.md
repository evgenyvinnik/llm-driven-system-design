# Coinbase (Crypto Exchange) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a cryptocurrency exchange like Coinbase: real-time price feeds, an order matching engine, multi-currency wallets, and portfolio tracking. The defining constraints are financial correctness (no money created or destroyed, ever), 24/7 operation (crypto markets never close, so there is no maintenance window), and precision spanning ten orders of magnitude — BTC at $65,000 and DOGE at $0.15 must both settle to the exact unit.

## 🎯 Requirements Clarification

Questions I would ask the interviewer up front:

- **Custody or trading only?** I'll scope to the exchange core — matching, wallets, market data — and treat blockchain deposits/withdrawals as an external settlement layer behind an interface.
- **Order types?** Market and limit orders first; stop and iceberg orders are extensions of the same matching core.
- **Consistency bar?** Wallet balances and matching must be strongly consistent. Market data (candles, tickers) can be eventually consistent by hundreds of milliseconds.

### Functional Requirements

- **Order placement and matching**: Market and limit orders matched with price-time priority
- **Wallets**: Per-currency balances with funds locked while orders are open
- **Market data**: Live tickers, order book depth, OHLCV candles, recent trades
- **Portfolio**: Holdings valued in USD, with history over time
- **Audit trail**: Every balance change traceable to a deposit, withdrawal, trade, or fee

### Non-Functional Requirements

- **Matching latency**: p99 < 10ms from order receipt to match decision
- **Availability**: 99.99%, with no scheduled downtime — the market never closes
- **Throughput**: 100K orders/second across 500+ trading pairs, 1M concurrent WebSocket subscribers
- **Correctness**: Zero lost trades, zero phantom balances, exact decimal arithmetic
- **Idempotency**: A retried order submission must never create a duplicate order

### Scale Estimates

- 100M registered users, 10M monthly active
- 500M orders/day (~6K/sec average, 100K/sec peak) producing 100M trades/day
- 50K price updates/second fanned out to 1M WebSocket connections
- ~50 GB/day of trade records, ~2 GB/day of candle data

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      Clients (Web, Mobile, API)                  │
└──────────────┬──────────────────────────────┬────────────────────┘
               │ REST (orders, portfolio)     │ WSS (tickers, book)
               ▼                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              API Gateway (TLS, WAF, rate limiting)               │
└──────────────┬──────────────────────────────┬────────────────────┘
               ▼                              ▼
     ┌──────────────────┐          ┌────────────────────┐
     │   API Servers    │          │ WebSocket Gateway  │
     │  (stateless, xN) │          │  (~50K conns each) │
     └────────┬─────────┘          └─────────▲──────────┘
              │ route by pair                │ consume
              ▼                              │
     ┌──────────────────┐          ┌─────────┴──────────┐
     │ Matching Engines │─────────▶│       Kafka        │
     │ (sharded by pair,│  trades, │  price-updates,    │
     │  in-memory book) │  ticks   │  trade-events      │
     └────────┬─────────┘          └─────────┬──────────┘
              │ settle                       │
              ▼                              ▼
     ┌──────────────────┐          ┌────────────────────┐
     │    PostgreSQL    │          │ Workers: candles,  │
     │ wallets, orders, │          │ portfolio snapshots│
     │ trades DECIMAL   │          │ analytics          │
     │ (28,18)          │          └────────────────────┘
     └──────────────────┘
        + Redis (sessions, idempotency, hot caches)
```

The critical structural choice: the **matching engine is separated from the API servers** and sharded by trading pair. API servers are stateless and horizontally scalable; each matching engine owns the order books for its assigned pairs and is the single writer for them.

## 💾 Data Model

Described as tables rather than DDL:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username, email, password_hash | unique on username, email | bcrypt cost 12 |
| currencies | id ('BTC'), name, decimals, is_fiat | — | Static reference data, cached 300s |
| trading_pairs | symbol ('BTC-USD'), base/quote currency FKs, min/max order size, precision | unique on symbol | Drives validation and display |
| wallets | user_id, currency_id, balance, reserved_balance | unique (user_id, currency_id) | CHECK: balance ≥ reserved_balance ≥ 0 |
| orders | user_id, pair, side, type, quantity, price, filled_quantity, status, idempotency_key | (user_id, created_at), (pair, status), unique idempotency_key | Status: pending → open → partially_filled → filled / cancelled |
| trades | pair, buy_order_id, sell_order_id, price, quantity, fees | (pair, created_at) | One row per match; the append-only source of truth |
| price_candles | symbol, interval, open_time, OHLCV | unique (symbol, interval, open_time) | Time-partitioned at scale |
| transactions | user_id, type, currency, amount, fee, reference_id | (user_id, created_at) | Full audit trail; every balance delta has a row |

Every monetary column is DECIMAL(28,18) — I'll defend that choice in a deep dive below.

## 🔌 API Design

```
POST   /api/v1/orders               → Place order (requires idempotency key)
DELETE /api/v1/orders/:id           → Cancel open order
GET    /api/v1/orders?status=open   → List user's orders
GET    /api/v1/markets/pairs        → All pairs with current prices
GET    /api/v1/markets/:sym/orderbook → Depth (default 20 levels/side)
GET    /api/v1/markets/:sym/candles → OHLCV by interval
GET    /api/v1/portfolio            → Holdings with USD valuation
GET    /api/v1/wallets              → Balances (total, reserved, available)
POST   /api/v1/wallets/deposit      → Credit funds (simulated locally)
GET    /api/v1/transactions         → Audit trail
WSS    /ws                          → subscribe/unsubscribe to ticker:SYM, book:SYM channels
```

All decimal values are serialized as **strings**, never JSON numbers — a JSON number is an IEEE 754 double and silently corrupts the low-order digits of an 18-decimal value.

## 🔧 Deep Dive 1: The Matching Engine

This is the heart of the system, so I'll spend the most time here.

**The algorithm** is price-time priority. Per trading pair I keep two ordered books: bids sorted by price descending then arrival time ascending, asks sorted by price ascending then time ascending. On each incoming order:

1. Check the idempotency key; return the cached result if this is a retry
2. Validate against pair limits, then reserve funds in the taker's wallet
3. While the best bid price ≥ best ask price: match at the **resting order's price** (the earlier order sets the price — this rewards liquidity providers), for quantity = min of the two remainders
4. Record the trade, settle both wallets atomically, remove filled orders
5. Anything unfilled on a limit order rests in the book

**Why in-memory, single-threaded per pair — not database-backed?**

> "A database-backed book means every match attempt runs SELECT ... FOR UPDATE against the resting orders, serializing all matching for a pair through row locks with a network round-trip per step. At 100K orders/second that's not a bottleneck, it's a wall: each match takes single-digit milliseconds of lock-hold time, so a hot pair caps out around a few hundred matches per second while orders queue behind the lock. An in-memory book matches in microseconds. I make each pair's book single-threaded on purpose — matching is inherently sequential per pair (order N+1's outcome depends on order N's), so adding threads adds synchronization without adding throughput. This is the LMAX pattern: one writer, no locks, mechanical sympathy."

**What I give up**: the book is process state, lost on crash. Recovery has to be designed, not assumed:

- Every accepted order and every trade is durably written (order insert before matching, trade insert at match time)
- On restart, the engine replays open orders from PostgreSQL in original arrival order to rebuild the book deterministically
- At production scale I'd go further: an event-sourced input log (Kafka or Aeron) where the engine's state is a pure function of the ordered input stream, with a hot standby consuming the same stream a few milliseconds behind

**Sharding**: pairs are independent, so I shard matching engines by trading pair with consistent hashing — each engine node owns 10–50 pairs. There are no cross-pair transactions in matching itself; the only cross-entity operation is wallet settlement, which happens in PostgreSQL, not in the engine.

**Data structure honesty**: sorted arrays are O(n) insert and fine below ~1K resting orders. A production book uses a price-level map (price → FIFO queue) so inserts are O(log P) in the number of price levels and time priority within a level is free. I'd flag this as the first thing to swap when book depth grows.

## 🔧 Deep Dive 2: Money Correctness — Precision and the Reserved Balance

**Why DECIMAL(28,18) and not floats or integer cents?**

> "FLOAT8 carries ~15–17 significant digits. A value like 65000.123456789012345678 silently rounds — and in an exchange those 'tiny' errors compound across 100M trades a day into balances that don't reconcile, which is phantom money and a regulatory incident. BIGINT-of-smallest-unit avoids rounding but pushes a per-currency scaling factor (2 for USD, 8 for BTC, 18 for ETH) into every consumer — one missed conversion anywhere in the stack is a 10^8 error. DECIMAL(28,18) is exact arithmetic with the precision encoded in the schema itself: 18 fractional digits matches ETH's wei natively, 10 integer digits covers any realistic notional. The cost is storage and slower arithmetic than native ints — irrelevant next to the cost of being wrong."

The precision discipline extends end-to-end: SQL casts decimals to text, the API emits strings, and the frontend formats but never computes.

**The double-spend problem**: a user with $64,000 places a limit buy for 1 BTC at $64,000, then immediately tries to place a second identical order. Both must not be accepted.

I use a **reserved balance** on each wallet: `available = balance − reserved_balance`. Placing an order reserves the required funds via a single conditional UPDATE — increment reserved only where available ≥ amount, and if zero rows update, reject the order. This is one atomic statement, so two concurrent orders cannot both pass the check; there is no read-then-write race to exploit.

**Why reservation instead of deducting immediately?** Immediate deduction shows users a wrong balance for unfilled orders and forces a compensating "refund" on cancellation — a second money-moving operation that can itself fail, retry, or double-apply. Reservation makes cancellation trivial (decrement reserved) and keeps `balance` meaning exactly one thing: what you own.

**Settlement** runs in one PostgreSQL transaction touching both parties: debit buyer's quote currency (balance and reserved), credit buyer's base minus taker fee, debit seller's base, credit seller's quote minus maker fee, insert both transaction audit rows. A database CHECK constraint (`balance ≥ reserved_balance ≥ 0`) is the last line of defense — even a bug in application logic cannot commit an inconsistent wallet.

## 🔧 Deep Dive 3: Real-Time Fan-Out at 1M Connections

50K price updates/second must reach 1M WebSocket subscribers in under 50ms.

```
Matching Engines ──▶ Kafka (price-updates, keyed by symbol)
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   WS Gateway 1    WS Gateway 2   ... WS Gateway 20
   (50K conns)     (50K conns)        (50K conns)
        │               │               │
        ▼               ▼               ▼
   local subscribers filtered by channel (ticker:BTC-USD, book:ETH-USD)
```

**Why Kafka in the middle rather than direct broadcast?** With one server, direct broadcast works. With 20 gateways, each gateway only sees the trades matched on engines it talks to — every gateway needs every event. Kafka gives publish-once, consume-everywhere fan-out, plus durability: a gateway that restarts resumes from its committed offset instead of silently missing ticks. The trade-off is an extra hop of latency (single-digit ms) and another system to operate — acceptable against the alternative of building a bespoke mesh between engines and gateways.

**Backpressure discipline**: a slow consumer on a 4G connection must not buffer unbounded ticker updates server-side. For market data I use **conflation** — if a client is behind, drop the queued tick and send only the latest state, because the newest price supersedes the old one. Order/fill notifications for the user's own account are the opposite: never conflated, delivered via a per-user channel with sequence numbers so the client can detect gaps and re-sync via REST.

## 🛡️ Idempotency and Failure Handling

**Idempotent order placement**: the client generates a UUID per order intent and sends it with the request. Two layers enforce exactly-once:
1. Redis check before processing (sub-millisecond, 24h TTL, returns the cached result on retry)
2. A UNIQUE constraint on orders.idempotency_key as the database backstop — if Redis has flushed or failed, the retry gets a constraint violation, not a duplicate order

> "Two layers because they fail differently: Redis is fast but ephemeral; the constraint is durable but only catches the duplicate after business logic ran. Together, a network retry can never double-buy."

**Degradation policy**, in order of what I protect:
- PostgreSQL is the source of truth — if the trade row and wallet transfer committed, the trade happened, whether or not the Kafka event published. Kafka failure degrades real-time feeds, never correctness.
- Circuit breakers (50% error rate over a rolling window, 30s half-open recovery) wrap Redis and Kafka calls so a degraded dependency fails fast instead of queuing threads.
- If the matching engine for a pair is down, orders for that pair are **rejected, not queued** — accepting orders we can't match creates ambiguity about book state at restart. Other pairs are unaffected because engines are sharded.

**Rate limiting** protects the expensive path: order placement is limited per-user per-second (each order costs matching work plus wallet writes), general API per-minute, and auth endpoints aggressively (credential stuffing). During volatility spikes everyone trades at once — exactly when limits matter most.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Order placement latency histogram (p50/p99) | The core SLO; regression here is user-visible immediately |
| Trade counter per pair | The business heartbeat — a sudden drop on one pair usually means its matching engine is sick |
| Order book depth gauge per side | Liquidity monitoring; thin books produce bad fills |
| WebSocket connection gauge | A cliff-drop indicates a gateway or LB failure |
| Wallet reconciliation job | Nightly: sum of transactions per wallet must equal balance. Any drift pages a human — this is the "no phantom money" invariant, verified continuously |

Structured JSON logs (event, symbol, userId, orderId) let me trace one order's full lifecycle across API server, engine, and settlement.

## 📈 Scalability: What Breaks First

1. **First bottleneck: settlement writes to PostgreSQL.** Matching is in-memory and fast; every trade then needs a multi-row transaction. At 100M trades/day (~1.2K/sec average, 10x at peak), a single Postgres instance saturates on the wallet-update transactions. Fix: shard wallets/orders/transactions by user_id. The wrinkle — a trade's buyer and seller usually live on different shards. Options: two-phase commit (kills latency), or the ledger pattern — settle each side as an independent idempotent ledger entry with the trade record as the coordinator, reconciled asynchronously. Real exchanges take the second path.

2. **Second: a single hot trading pair.** BTC-USD alone can exceed what one single-threaded engine handles. You cannot shard within a pair without breaking price-time priority, so the answer is vertical: faster event-loop code, busy-spin cores, kernel-bypass networking — this is where exchanges get exotic, because the single-writer constraint is fundamental.

3. **Third: WebSocket fan-out** — solved horizontally by adding gateways; Kafka consumer groups make this near-linear.

4. **Market data reads** (candles, history) move to read replicas and time-partitioned tables; they never contend with the trading path.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Matching state | ✅ In-memory, single writer per pair | ❌ DB row locks | Microsecond matching; recovery via replay |
| Monetary type | ✅ DECIMAL(28,18) as strings on the wire | ❌ FLOAT / BIGINT units | Exact, self-describing precision end-to-end |
| Funds locking | ✅ Reserved balance + CHECK constraint | ❌ Immediate deduction | Trivial cancellation; one meaning per column |
| Event distribution | ✅ Kafka fan-out | ❌ Direct engine→gateway mesh | Publish-once, durable, resumes after gateway restart |
| Idempotency | ✅ Redis + DB unique constraint | ❌ Either alone | Fast path plus durable backstop |
| Slow WS consumers | ✅ Conflate market data, sequence user events | ❌ Buffer everything | Bounded memory; correctness where it matters |
| Engine failure mode | ✅ Reject orders for downed pair | ❌ Queue and replay | No ambiguity about book state on recovery |

## 🚀 Closing: What I'd Build Next

With more time I'd discuss: event-sourcing the matching engine input for deterministic replay and hot standby; advanced order types (stop-limit, IOC/FOK) as policies layered on the same matching core; the cold/hot wallet split and blockchain settlement; and surveillance for wash trading and spoofing — an exchange's trust is its product, and market-integrity tooling is as load-bearing as the matcher itself.
