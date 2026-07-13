# Coinbase (Crypto Exchange) - System Design Answer (Full-Stack Focus)

*45-60 minute system design interview format - Full-Stack Engineer Position*

## 📋 Problem Statement

Design a cryptocurrency exchange end to end: users watch live prices, place market and limit orders against an order book, and track a multi-currency portfolio. The full-stack framing makes the interesting problems the **seams**: how a match deep in the engine becomes a wallet update, a WebSocket event, and a re-rendered balance — correctly, exactly once, and fast enough that traders trust what they see.

## 🎯 Requirements Clarification

- **Scope**: trading core (matching, wallets, market data, portfolio). Blockchain custody sits behind a deposit/withdrawal interface.
- **Consistency**: wallet balances strongly consistent; market data can lag by ~100ms.
- **Scale targets**: 100K orders/sec peak, 1M concurrent WebSocket subscribers, 500+ pairs, 24/7 with no maintenance window.
- **Correctness bar**: no money created or destroyed; a network retry never duplicates an order; 18-decimal precision preserved from database to pixel.

### Functional Requirements

- Live market overview, per-pair trading view (candles, order book, trade form)
- Market and limit orders with price-time priority matching
- Per-currency wallets; funds locked while orders rest
- Portfolio valuation, order history, full transaction audit trail

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    React SPA (Vite + TS)                     │
│   marketStore ◀── WS singleton      portfolioStore ◀── REST  │
│   (prices, book, candles)           (wallets, orders)        │
└─────────────┬───────────────────────────────┬────────────────┘
              │ WSS (push)                    │ HTTPS (pull)
              ▼                               ▼
┌──────────────────────────────────────────────────────────────┐
│           API Gateway → stateless API / WS servers           │
└─────┬────────────────────────────────────────────┬───────────┘
      │ orders (routed by pair)                    │ reads
      ▼                                            ▼
┌───────────────────┐    trades/ticks    ┌──────────────────┐
│ Matching Engines  │───────────────────▶│      Kafka       │
│ (sharded by pair, │                    │ price-updates,   │
│  in-memory books) │                    │ trade-events     │
└─────────┬─────────┘                    └────────┬─────────┘
          │ settlement (ACID)                     │
          ▼                                       ▼
┌───────────────────┐                    ┌──────────────────┐
│    PostgreSQL     │                    │ Workers: candles,│
│ DECIMAL(28,18):   │                    │ portfolio snaps, │
│ wallets, orders,  │                    │ WS fan-out       │
│ trades, txns      │                    └──────────────────┘
└───────────────────┘
   + Redis: sessions, idempotency keys, hot caches
```

## 💾 Data Model

| Table | Key Columns | Notes |
|-------|-------------|-------|
| wallets | user_id, currency_id, balance, reserved_balance | Unique per (user, currency); CHECK balance ≥ reserved ≥ 0 |
| orders | user_id, pair, side, type, qty, price, filled_qty, status, idempotency_key (unique) | pending → open → partially_filled → filled/cancelled |
| trades | pair, buy/sell order ids, price, qty, fees | Append-only; the settlement source of truth |
| price_candles | symbol, interval, open_time, OHLCV | Unique (symbol, interval, open_time); time-partitioned at scale |
| transactions | user_id, type, currency, amount, reference_id | Every balance delta is a row — auditability invariant |
| trading_pairs / currencies | symbol, precisions, size limits | Reference data, cached aggressively |

All monetary columns are DECIMAL(28,18); the API serializes them as **strings** because a JSON number is an IEEE 754 double and silently corrupts 18-decimal values. This one decision touches every layer, which is why I flag it in a full-stack interview: schema type → SQL text cast → JSON string → frontend fixed-point utility. Precision is an end-to-end property; any single layer can destroy it.

## 🔌 API Design

```
POST   /api/v1/orders                  → Place order (idempotency key required)
DELETE /api/v1/orders/:id              → Cancel open order
GET    /api/v1/orders?status=open      → User's orders
GET    /api/v1/markets/pairs           → Pairs + current prices
GET    /api/v1/markets/:sym/orderbook  → Depth snapshot
GET    /api/v1/markets/:sym/candles    → OHLCV for charting
GET    /api/v1/portfolio               → Holdings valued in USD
GET    /api/v1/wallets                 → balance / reserved / available
WSS    /ws                             → channels: ticker:SYM, book:SYM, user:ID
```

## 🔧 Deep Dive 1: The Life of an Order (Every Seam, End to End)

The full-stack story I'd walk through on the whiteboard:

1. **Client**: user enters quantity; total = quantity × price computed in fixed-point (BigInt), never `parseFloat`. Submission attaches a client-generated UUID **idempotency key**. Button disables in-flight, but the key is the real duplicate-protection — UI state is advisory.
2. **API server**: checks the key in Redis (retry? return cached result), validates against pair limits, then **reserves funds**: one conditional UPDATE that increments `reserved_balance` only where `balance − reserved ≥ amount`. Zero rows updated = insufficient funds = reject. Atomic, so two concurrent orders can't both pass.
3. **Matching engine** (in-memory, single-threaded for this pair): price-time priority — while best bid ≥ best ask, match at the resting order's price. Microseconds, no locks.
4. **Settlement**: one PostgreSQL transaction moves both sides — debit buyer quote (balance and reserved), credit buyer base minus fee, mirror for seller, write both audit rows. A CHECK constraint (`balance ≥ reserved_balance ≥ 0`) backstops even buggy application code.
5. **Events**: trade and tick published to Kafka; WS servers fan out to `ticker:*` subscribers and to both parties' `user:*` channels.
6. **Client again**: the user's fill arrives on their channel → portfolioStore refetches wallets; the tick conflates into marketStore → price flashes. Two different update disciplines for two different data classes.

> "The reserved-balance pattern is the hinge of the whole flow. Deducting money at order time shows users wrong balances and turns cancellation into a compensating refund — a second money-moving operation that can itself fail or double-apply. Reservation keeps `balance` meaning exactly one thing, makes cancellation a decrement, and the available-funds check compiles down to a single atomic UPDATE. Simple invariants survive concurrency; clever flows don't."

**Failure honesty**: if Kafka is down, the trade still happened — PostgreSQL is the source of truth and real-time feeds degrade, never correctness. If the pair's matching engine is down, orders for that pair are rejected outright rather than queued, because queued orders create ambiguity about book state at recovery.

## 🔧 Deep Dive 2: Matching in Memory — the Core Backend Trade-off

**Why not match in the database?** Every match attempt would take `SELECT ... FOR UPDATE` row locks over resting orders, serializing a pair's matching through multi-millisecond round-trips. A hot pair caps at a few hundred matches/sec while orders queue behind the lock. In-memory matching is microseconds, and I keep it **single-threaded per pair on purpose**: matching is inherently sequential (order N+1's result depends on order N), so threads add synchronization cost without throughput — the LMAX single-writer insight.

**What that costs**: the book is process state. Recovery is designed, not assumed — every accepted order is durably inserted before matching, so a restarted engine rebuilds its book by replaying open orders in arrival order. At real scale I'd event-source the input stream (Kafka/Aeron) so engine state is a pure function of an ordered log, with a hot standby a few milliseconds behind.

**Scaling shape**: pairs are independent, so engines shard by pair via consistent hashing. The one thing you cannot do is shard *within* a pair — that breaks price-time priority. A single hot pair (BTC-USD) scales vertically only, which is why real exchanges get exotic (busy-spin cores, kernel bypass) on exactly that path.

## 🔧 Deep Dive 3: Real-Time Fan-Out — Server and Client Sides of One Problem

50K ticks/second must reach 1M browsers within ~100ms, and each browser must render them without melting.

**Server side**: matching engines publish once to Kafka; ~20 WS gateway servers (50K connections each) consume everything and forward to their locally-subscribed channels. Kafka buys publish-once fan-out plus resume-from-offset after a gateway restart. Slow consumers get **conflation** for market data — drop queued ticks, send latest state — because the newest price supersedes the old. User order events are never conflated; they carry sequence numbers so a client can detect gaps and re-sync via REST.

**Client side mirrors this**: one singleton WebSocket owned outside React; components declare channel interest via hooks; ticks land in a Zustand store keyed by symbol so a BTC tick re-renders only BTC subscribers; the socket layer batches store writes to one flush per animation frame. The chart is canvas (lightweight-charts) updated imperatively through a ref — candle arrays as React props would re-diff on every tick for nothing.

> "Conflation appears on both sides of the wire, and that's not a coincidence — it's the same decision made once: market data is a *state stream* (latest value wins), order events are an *event stream* (every element matters). Classify each stream correctly and both the server buffers and the client frame budget fall out naturally."

**Reconnection**: exponential backoff with jitter, resubscribe from the service's desired-channel set, then one REST snapshot to heal missed state. While stale (>5s without ticks), the UI dims prices and says so — traders must never act on a frozen number they believe is live.

## 🛡️ Security and Correctness Rails

- **Sessions** in Redis via httpOnly cookies (immediate revocation; no token juggling in a SPA)
- **Idempotency, two layers**: Redis key check (fast path, 24h TTL) + UNIQUE constraint on `orders.idempotency_key` (durable backstop if Redis flushed) — they fail differently, together they guarantee a retry can't double-buy
- **Rate limiting by cost**: order placement per-second per-user (each order costs matching + wallet writes), reads per-minute, auth aggressively — volatility spikes are when everyone trades at once and limits matter most
- **Nightly reconciliation**: sum of `transactions` per wallet must equal `balance`; drift pages a human. The "no phantom money" invariant is verified continuously, not assumed

## 📈 What Breaks First

1. **Settlement writes to PostgreSQL** — matching is fast; the per-trade wallet transaction saturates a single instance around low thousands of trades/sec. Fix: shard by user_id; since buyer and seller usually land on different shards, settle each side as an idempotent ledger entry coordinated by the trade record, reconciled asynchronously — the ledger pattern, not two-phase commit.
2. **A single hot pair** — vertical-only scaling of that engine (single-writer constraint is fundamental).
3. **WS fan-out** — horizontal; add gateways behind Kafka consumer groups.
4. **Frontend at 500+ pairs** — virtualize the asset list; visible rows subscribe, scrolled-away rows cost zero renders and zero socket traffic; SharedWorker to share one socket across a trader's six open tabs.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Matching | ✅ In-memory, single writer per pair | ❌ DB row-lock matching | Microseconds vs. lock serialization; replay for recovery |
| Money type | ✅ DECIMAL(28,18) → strings → BigInt | ❌ floats / integer cents | Exact end-to-end; precision is a cross-layer property |
| Funds hold | ✅ Reserved balance + CHECK | ❌ Deduct-then-refund | One atomic check; trivial cancel; simple invariant |
| Duplicate orders | ✅ Redis + DB-unique idempotency | ❌ Either layer alone | Fast path + durable backstop fail differently |
| Event transport | ✅ Kafka fan-out to WS gateways | ❌ Direct engine→client mesh | Publish once, resume after restart |
| Stream handling | ✅ Conflate state streams only | ❌ Uniform buffering | Bounded memory server-side, frame budget client-side |
| Client state | ✅ Zustand per-symbol selectors + canvas chart | ❌ Context/props-driven chart | Surgical re-renders under tick load |
| Engine failure | ✅ Reject orders for downed pair | ❌ Queue and replay later | No ambiguity about book state |

## 🚀 Closing

If I had another 15 minutes I'd extend three seams: event-sourcing the matching input for deterministic replay and hot standby; the cold/hot wallet boundary where exchange balances meet actual blockchains; and market-surveillance (spoofing, wash-trade detection) — because an exchange's real product is trust, and every layer of this design, from CHECK constraints to staleness banners, is trust engineering.
