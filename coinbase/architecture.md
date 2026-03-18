# Coinbase (Crypto Exchange) - System Architecture

## System Overview

A cryptocurrency exchange platform supporting real-time price feeds, order matching with price-time priority, multi-currency wallet management with DECIMAL precision, candlestick charting, and portfolio tracking. This design explores the unique challenges of financial exchanges: 24/7 market operations (no market close), sub-cent precision for both high-value (BTC at $65,000) and micro-value (DOGE at $0.15) assets, deterministic order matching, and the critical requirement that no money is created or destroyed during trades.

**Learning Goals:**
- Design an order matching engine with price-time priority
- Implement DECIMAL(28,18) precision for monetary values across the full stack
- Build real-time price simulation using Geometric Brownian Motion
- Handle per-currency wallets with reserved balance to prevent double-spending
- Stream price updates via WebSocket and Kafka
- Implement idempotent order placement to handle network retries safely

---

## Requirements

### Functional Requirements

1. **Account Management**: User registration, login, logout with session-based auth
2. **Market Data**: Real-time price feeds for 12+ trading pairs with 24h statistics
3. **Candlestick Charts**: 1-minute OHLCV candle aggregation, multiple timeframe support (1m, 5m, 15m, 1h, 1d)
4. **Order Book**: Live bid/ask depth visualization with spread calculation
5. **Order Placement**: Market orders (immediate fill at best price) and limit orders (fill at specified price or better)
6. **Order Matching**: Price-time priority matching engine -- best price first, earliest order wins ties
7. **Wallet Management**: Per-currency wallets with balance reservation on order placement
8. **Portfolio Dashboard**: Holdings summary with USD valuation and allocation breakdown
9. **Transaction History**: Complete audit trail of deposits, withdrawals, and trades
10. **Order Management**: View open/filled/cancelled orders, cancel pending orders

### Non-Functional Requirements (Production Scale)

| Requirement | Target |
|-------------|--------|
| Availability | 99.99% uptime (24/7/365, no scheduled downtime) |
| Matching Latency | p99 < 10ms for order matching |
| API Latency | p99 < 100ms for market data, p99 < 200ms for order placement |
| Throughput | 100K orders/second, 1M WebSocket subscribers |
| Price Feed | < 50ms propagation from matching engine to all WebSocket clients |
| Precision | DECIMAL(28,18) -- no floating point arithmetic on monetary values |
| Consistency | Strong consistency for wallet balances and order matching |
| Idempotency | All order placement operations must be idempotent |
| Durability | Zero lost trades, zero phantom balances |

---

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Registered Users | 100 million |
| Monthly Active Users | 10 million |
| Concurrent WebSocket connections | 1 million |
| Trading pairs | 500+ |
| Orders per day | 500 million |
| Trades per day | 100 million |
| Price updates per second | 50K (100 per pair x 500 pairs) |
| Order book depth | 10K levels per side per pair |
| Candle storage growth per day | ~2 GB (6 intervals x 500 pairs x 1440 minutes) |
| Trade storage growth per day | ~50 GB |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 2-5 |
| Trading pairs | 12 |
| Price ticks | Every 2 seconds |
| Concurrent WebSocket clients | 1-3 |
| Order book depth | 0-50 orders per side |
| Single PostgreSQL instance | Handles all data |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                                 │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Market   │  │  Candlestick │  │  Order Book  │  │   Trade      │   │
│  │ Overview  │  │    Chart     │  │    Depth     │  │    Form      │   │
│  └──────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │Portfolio │  │   Wallet     │  │    Order     │                     │
│  │Dashboard │  │  Balances    │  │   History    │                     │
│  └──────────┘  └──────────────┘  └──────────────┘                     │
└──────────────────────┬──────────────────┬─────────────────────────────┘
                       │ HTTPS (REST)     │ WSS (WebSocket)
                       ▼                  ▼
              ┌──────────────────────────────────────┐
              │         API Gateway / CDN             │
              │   (Rate Limiting, TLS Termination,    │
              │    DDoS Protection, WAF)              │
              └───────────────┬──────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  API Server  │  │  API Server  │  │  API Server  │
   │  (Node.js)   │  │  (Node.js)   │  │  (Node.js)   │
   │  + WebSocket │  │  + WebSocket │  │  + WebSocket │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
    ┌──────────┬─────────────┼─────────────┬──────────────┐
    ▼          ▼             ▼             ▼              ▼
┌────────┐ ┌────────┐  ┌────────┐  ┌──────────┐  ┌──────────┐
│Matching│ │Postgres│  │ Redis/ │  │  Kafka   │  │Prometheus│
│Engine  │ │  (Data)│  │ Valkey │  │ (Events) │  │+ Grafana │
│(In-Mem)│ │DECIMAL │  │Sessions│  │          │  │          │
│        │ │(28,18) │  │+ Cache │  │          │  │          │
└────────┘ └────────┘  └────────┘  └────┬─────┘  └──────────┘
                                        │
                             ┌──────────┼──────────┐
                             ▼          ▼          ▼
                       ┌──────────┐┌──────────┐┌──────────┐
                       │  Price   ││Portfolio ││Analytics │
                       │Broadcast││ Updater  ││  Worker  │
                       │ Worker  ││  Worker  ││          │
                       └──────────┘└──────────┘└──────────┘
```

---

## Core Components

### 1. API Server (Express + Node.js)

Handles all client requests through RESTful endpoints and WebSocket connections:

- **Auth Routes** (`/api/v1/auth/*`): Register, login, logout, session management
- **Market Routes** (`/api/v1/markets/*`): Trading pairs, current prices, order book depth, candlestick data, recent trades
- **Order Routes** (`/api/v1/orders/*`): Place orders (with idempotency), cancel orders, list user orders
- **Portfolio Routes** (`/api/v1/portfolio/*`): Holdings summary with USD valuation, portfolio history snapshots
- **Wallet Routes** (`/api/v1/wallets/*`): Wallet balances, simulate deposits
- **Transaction Routes** (`/api/v1/transactions/*`): Full transaction history

### 2. Order Matching Engine

The matching engine is the core of the exchange. It maintains an in-memory order book per trading pair with price-time priority:

**Data structure**: Two sorted arrays per trading pair:
- **Bids**: sorted by price DESC, then timestamp ASC (best bid = highest price, earliest)
- **Asks**: sorted by price ASC, then timestamp ASC (best ask = lowest price, earliest)

**Matching algorithm**:

```
placeOrder(userId, {tradingPairId, side, orderType, quantity, price, idempotencyKey})
├── Check idempotency key in Redis
│   └── If exists: return cached response (prevents duplicate orders)
├── Validate trading pair (active, size limits)
├── Determine execution price
│   ├── Market order: current market price
│   └── Limit order: user-specified price
├── Reserve funds in wallet
│   ├── Buy order: reserve quote currency (quantity * price)
│   └── Sell order: reserve base currency (quantity)
│   └── If insufficient: reject order
├── Insert order record in PostgreSQL
├── Add to in-memory order book
├── Run matching algorithm
│   ├── While best_bid >= best_ask:
│   │   ├── Match price = earlier order's price
│   │   ├── Match quantity = min(bid_remaining, ask_remaining)
│   │   ├── Record trade in PostgreSQL
│   │   ├── Execute wallet transfer (atomic transaction)
│   │   └── Remove filled orders from book
│   └── If market order with no matches: simulate fill at market price
├── Store idempotency result in Redis (TTL 24h)
└── Return order result
```

**Why in-memory, not database-backed?** Database-backed matching requires `SELECT ... FOR UPDATE` on the order book for every match attempt, serializing all matching through row locks. At 100K orders/second, row-level locking creates a bottleneck where orders queue behind each other. In-memory matching completes in microseconds, while a database round-trip takes milliseconds. The trade-off: the order book is lost on process restart. Production exchanges solve this by rebuilding from the trade log (event sourcing) or using replicated state machines.

**Why sorted arrays instead of a red-black tree?** For a learning project with < 1000 orders per book, array insertion with `splice` is fast enough. Production exchanges use price-level maps with FIFO queues per level, or custom B-tree variants. The algorithmic complexity difference (O(n) insert vs O(log n)) only matters with millions of orders.

### 3. Market Service (Price Simulation)

Simulates realistic price movement using Geometric Brownian Motion:

```
newPrice = price * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)
```

Where:
- `mu = 0.0001`: slight upward drift (crypto tends upward over time)
- `sigma`: per-asset volatility (BTC 1.5%, DOGE 5% -- more speculative assets are more volatile)
- `dt = 2/86400`: time step in days (2-second tick interval)
- `Z`: standard normal random variable via Box-Muller transform

GBM is the standard model behind Black-Scholes option pricing. It produces log-normal returns, meaning prices cannot go negative. The multiplicative nature means a 5% move on a $65,000 asset looks proportionally the same as on a $0.15 asset. Prices are clamped to [50%, 200%] of base price to prevent runaway values in long-running sessions.

### 4. Wallet Service (Reserved Balance Pattern)

Per-currency wallets prevent double-spending via balance reservation:

```
┌─────────────────────────────────────────────────────────────┐
│                    Wallet State Machine                      │
│                                                              │
│  balance = 1.5 BTC                                          │
│  reserved_balance = 0.3 BTC                                 │
│  available = balance - reserved = 1.2 BTC                   │
│                                                              │
│  ┌──────────┐  place order   ┌──────────────┐               │
│  │  Idle    │──────────────▶│   Reserved   │               │
│  │available │  +reserved    │   available  │               │
│  │  = 1.5   │               │   = 1.2      │               │
│  └──────────┘               └──────┬───────┘               │
│       ▲                            │                         │
│       │ cancel order          fill │                         │
│       │ -reserved                  ▼                         │
│       │                    ┌──────────────┐                  │
│       └────────────────────│   Filled     │                  │
│                            │ -balance     │                  │
│                            │ -reserved    │                  │
│                            │ +counterparty│                  │
│                            └──────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

The `executeTradeTransfer` function runs within a PostgreSQL transaction to atomically:
1. Deduct buyer's quote currency (both balance and reserved)
2. Add base currency to buyer (minus taker fee)
3. Deduct seller's base currency (both balance and reserved)
4. Add quote currency to seller (minus maker fee)
5. Record trade transactions for both parties

**Database constraint**: `CHECK (balance >= reserved_balance)` prevents the system from ever entering an inconsistent state where more is reserved than owned.

**Reserve flow** uses an atomic check-and-update:

```sql
UPDATE wallets
SET reserved_balance = reserved_balance + $amount, updated_at = NOW()
WHERE user_id = $1 AND currency_id = $2
  AND (balance - reserved_balance) >= $amount
RETURNING id
```

If the available balance is insufficient, zero rows are returned and the order is rejected. No separate SELECT is needed.

### 5. WebSocket Manager

Channel-based pub/sub for real-time data distribution:

```
WebSocket Protocol:

Client ──▶ Server:
  {"type": "subscribe", "channels": ["ticker:BTC-USD"]}
  {"type": "unsubscribe", "channels": ["ticker:BTC-USD"]}
  {"type": "auth", "userId": "uuid"}

Server ──▶ Client:
  {"type": "connected", "clientId": "client_1"}
  {"type": "subscribed", "channels": ["ticker:BTC-USD"]}
  {"type": "prices", "data": {"BTC-USD": {...}, "ETH-USD": {...}}}
  {"channel": "ticker:BTC-USD", "type": "ticker", "symbol": "BTC-USD", "price": 65123.45, ...}
```

The main server broadcasts per-symbol ticker updates to channel subscribers every 2 seconds, and an all-prices summary to all connected clients.

At production scale with 1M WebSocket connections, each API server handles ~50K connections across 20 servers. Kafka provides fan-out: the price broadcaster publishes once, all servers consume and broadcast to their local connections.

### 6. Price Broadcaster Worker

Separate Node.js process that:
- Simulates price ticks every 2 seconds for all 12 trading pairs
- Publishes price updates to Kafka (`price-updates` topic) keyed by symbol
- Stores completed 1-minute candles in PostgreSQL (`price_candles` table)
- Uses UPSERT to handle candle conflicts gracefully

### 7. Portfolio Updater Worker

Background worker that:
- Runs every 60 seconds
- Queries all users with non-zero wallet balances
- Calculates USD value of each holding using current market prices
- Stores portfolio snapshots in `portfolio_snapshots` table with JSONB breakdown
- Enables portfolio history tracking over time

---

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table with bcrypt password hashing
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  is_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Supported currencies (crypto + fiat)
CREATE TABLE currencies (
  id VARCHAR(10) PRIMARY KEY,      -- 'BTC', 'ETH', 'USD'
  name VARCHAR(50) NOT NULL,       -- 'Bitcoin', 'Ethereum'
  symbol VARCHAR(10) NOT NULL,     -- Unicode symbols
  icon_url TEXT,
  decimals INT DEFAULT 8,          -- Native decimal places
  is_fiat BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true
);

-- Trading pairs (e.g., BTC-USD, ETH-BTC)
CREATE TABLE trading_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) UNIQUE NOT NULL,     -- 'BTC-USD'
  base_currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  quote_currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  min_order_size DECIMAL(28,18) DEFAULT 0.00000001,
  max_order_size DECIMAL(28,18) DEFAULT 1000000,
  price_precision INT DEFAULT 2,          -- Decimal places for price display
  quantity_precision INT DEFAULT 8,       -- Decimal places for quantity display
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-currency wallets with balance reservation
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  balance DECIMAL(28,18) DEFAULT 0,
  reserved_balance DECIMAL(28,18) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, currency_id),
  CHECK (balance >= 0),
  CHECK (reserved_balance >= 0),
  CHECK (balance >= reserved_balance)     -- Invariant: can never reserve more than owned
);

-- Orders with full lifecycle tracking
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  trading_pair_id UUID NOT NULL REFERENCES trading_pairs(id),
  side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type VARCHAR(10) NOT NULL CHECK (order_type IN ('market', 'limit', 'stop')),
  quantity DECIMAL(28,18) NOT NULL,
  price DECIMAL(28,18),                   -- NULL for market orders
  stop_price DECIMAL(28,18),              -- For stop orders
  filled_quantity DECIMAL(28,18) DEFAULT 0,
  avg_fill_price DECIMAL(28,18),
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  idempotency_key VARCHAR(64) UNIQUE,     -- Prevents duplicate order placement
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trade records (each match between a buy and sell order)
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trading_pair_id UUID NOT NULL REFERENCES trading_pairs(id),
  buy_order_id UUID NOT NULL REFERENCES orders(id),
  sell_order_id UUID NOT NULL REFERENCES orders(id),
  price DECIMAL(28,18) NOT NULL,
  quantity DECIMAL(28,18) NOT NULL,
  buyer_fee DECIMAL(28,18) DEFAULT 0,
  seller_fee DECIMAL(28,18) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- OHLCV candlestick data
CREATE TABLE price_candles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) NOT NULL,
  interval VARCHAR(5) NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  open_time TIMESTAMPTZ NOT NULL,
  open DECIMAL(28,18) NOT NULL,
  high DECIMAL(28,18) NOT NULL,
  low DECIMAL(28,18) NOT NULL,
  close DECIMAL(28,18) NOT NULL,
  volume DECIMAL(28,18) DEFAULT 0,
  UNIQUE(symbol, interval, open_time)
);

-- Portfolio value snapshots for history tracking
CREATE TABLE portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  total_value_usd DECIMAL(28,18) NOT NULL,
  breakdown JSONB DEFAULT '{}',           -- {"BTC": {"balance": "1.5", "valueUsd": 97500}}
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Complete transaction audit trail
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'trade', 'fee')),
  currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  amount DECIMAL(28,18) NOT NULL,
  fee DECIMAL(28,18) DEFAULT 0,
  reference_id UUID,                      -- Links to order/trade ID
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes

```sql
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_pair_status ON orders(trading_pair_id, status);
CREATE INDEX idx_trades_pair ON trades(trading_pair_id, created_at DESC);
CREATE INDEX idx_price_candles_lookup ON price_candles(symbol, interval, open_time DESC);
CREATE INDEX idx_portfolio_snapshots_user ON portfolio_snapshots(user_id, created_at DESC);
CREATE INDEX idx_transactions_user ON transactions(user_id, created_at DESC);
```

### Entity Relationship Diagram

```
┌──────────┐     ┌──────────────┐     ┌────────────┐
│  users   │────▶│   wallets    │◀────│ currencies │
│          │     │              │     │            │
│ id       │     │ user_id (FK) │     │ id (PK)    │
│ username │     │ currency_id  │     │ name       │
│ email    │     │ balance      │     │ is_fiat    │
│ password │     │ reserved_bal │     │ decimals   │
└──────┬───┘     └──────────────┘     └──────┬─────┘
       │                                      │
       │         ┌──────────────┐             │
       │         │trading_pairs │◀────────────┘
       │         │              │
       │         │ symbol       │
       │         │ base_currency│
       │         │ quote_currency│
       │         │ precision    │
       │         └──────┬───────┘
       │                │
       ▼                ▼
┌──────────────┐  ┌──────────────┐
│   orders     │──│   trades     │
│              │  │              │
│ user_id (FK) │  │ pair_id (FK) │
│ pair_id (FK) │  │ buy_order_id │
│ side         │  │ sell_order_id│
│ order_type   │  │ price        │
│ quantity     │  │ quantity     │
│ price        │  │ buyer_fee    │
│ filled_qty   │  │ seller_fee   │
│ status       │  └──────────────┘
│ idempotency  │
└──────┬───────┘
       │
       ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ transactions │  │  price_candles   │  │portfolio_snapshots│
│              │  │                  │  │                  │
│ user_id (FK) │  │ symbol           │  │ user_id (FK)     │
│ type         │  │ interval         │  │ total_value_usd  │
│ currency_id  │  │ open_time        │  │ breakdown (JSONB)│
│ amount       │  │ open/high/low/   │  │                  │
│ fee          │  │ close/volume     │  │                  │
│ reference_id │  └──────────────────┘  └──────────────────┘
└──────────────┘
```

---

## API Design

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/auth/register` | No | Register new user, creates USD wallet |
| POST | `/api/v1/auth/login` | No | Login with username/password |
| POST | `/api/v1/auth/logout` | Yes | Destroy session |
| GET | `/api/v1/auth/me` | Yes | Get current user profile |

### Market Data

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/markets/pairs` | No | All active trading pairs with current prices |
| GET | `/api/v1/markets/currencies` | No | All supported currencies |
| GET | `/api/v1/markets/:symbol/price` | No | Current price and 24h stats for a pair |
| GET | `/api/v1/markets/:symbol/orderbook` | No | Order book depth (default 20 levels) |
| GET | `/api/v1/markets/:symbol/candles` | No | OHLCV candle data with interval/limit params |
| GET | `/api/v1/markets/:symbol/trades` | No | Recent trades for a pair |

### Trading

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/orders` | Yes | Place new order (with idempotency key) |
| DELETE | `/api/v1/orders/:id` | Yes | Cancel an open order |
| GET | `/api/v1/orders` | Yes | List user's orders (filterable by status) |

### Portfolio and Wallets

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/portfolio` | Yes | Portfolio summary with USD values |
| GET | `/api/v1/portfolio/history` | Yes | Portfolio value over time |
| GET | `/api/v1/wallets` | Yes | Wallet balances per currency |
| POST | `/api/v1/wallets/deposit` | Yes | Simulate a deposit |
| GET | `/api/v1/transactions` | Yes | Transaction history |

All DECIMAL values are returned as strings in API responses to prevent JSON floating-point precision loss.

---

## Key Design Decisions

### Decision 1: DECIMAL(28,18) for All Monetary Values

**Context**: A crypto exchange must handle values ranging from BTC at $65,000 to fractions of a Satoshi at 0.00000001 BTC, all without rounding errors.

**Why DECIMAL(28,18)?** 28 total digits with 18 after the decimal point gives 10 digits before the decimal. Supports values from 0.000000000000000001 to 9,999,999,999.999999999999999999. Matches Ethereum's 18-decimal precision natively. PostgreSQL DECIMAL is exact arithmetic, not IEEE 754 floating point.

**Why not FLOAT or BIGINT?** `FLOAT8` (double precision) has only ~15-17 significant digits. For a value like `65000.123456789012345678`, the trailing digits would silently round. In financial systems, these "small" rounding errors compound across millions of trades and create phantom money -- balances that do not reconcile. `BIGINT` (storing cents/satoshis) avoids rounding but requires every API consumer to know the scaling factor per currency (2 for USD, 8 for BTC, 18 for ETH). DECIMAL encodes the precision in the schema itself.

**String serialization**: All DECIMAL values are cast to `::text` in SQL queries and returned as JSON strings. JavaScript's `Number` type is IEEE 754 double, which cannot represent `0.1 + 0.2 === 0.3` correctly. By using strings, precision is preserved end-to-end, and the frontend displays values without performing arithmetic.

### Decision 2: In-Memory Order Book with Price-Time Priority

**Context**: The matching engine must find the best available price and, among orders at the same price, prioritize the earliest order.

**Why in-memory, not database-backed?** Database-backed matching requires `SELECT ... FOR UPDATE` on the order book for every match attempt, serializing all matching through row locks. At 100K orders/second, row-level locking creates a bottleneck where orders queue behind each other. In-memory matching completes in microseconds, while a database round-trip takes milliseconds.

The trade-off: the order book is lost on process restart. Production exchanges solve this by rebuilding from the trade log (event sourcing) or using replicated state machines. For this learning project, the trade-off is acceptable because the order book is small and can be rebuilt from the `orders` table on startup.

### Decision 3: Reserved Balance Pattern for Double-Spend Prevention

**Context**: When a user places a limit buy order for 1 BTC at $64,000, we need to guarantee that $64,000 is available when the order eventually fills -- possibly hours later.

**Pattern**: Each wallet tracks `balance` (total owned) and `reserved_balance` (locked by open orders). Available = balance - reserved. The database constraint `CHECK (balance >= reserved_balance)` prevents the system from ever entering an inconsistent state.

**Why not deduct immediately?** Immediate deduction would show a reduced balance before the order is actually filled. If the order is cancelled, we would need to "add back" the funds, which requires tracking what was deducted for which order. The reserved model cleanly separates "pending" from "completed" state transitions and makes cancellation trivial (just decrease reserved_balance).

### Decision 4: Geometric Brownian Motion for Price Simulation

**Context**: Need realistic price movement for development and testing without connecting to real market data APIs.

GBM is the standard model behind Black-Scholes option pricing. It produces log-normal returns, meaning prices cannot go negative. The multiplicative nature means a 5% move on a $65,000 asset looks proportionally the same as on a $0.15 asset. Different volatility parameters per asset (BTC: 1.5%, DOGE: 5%) create realistic relative movement patterns.

**Limitations**: GBM does not model fat tails (flash crashes) or mean reversion. Prices are clamped to [50%, 200%] of base price to prevent runaway values. Acceptable for a learning project; production would use real market data feeds from exchanges like Binance or Coinbase via WebSocket API.

### Decision 5: Kafka for Event Streaming

**Context**: Price updates and trade events need to flow from the matching engine to multiple consumers (WebSocket servers, analytics, candle aggregation).

**Why Kafka over direct WebSocket broadcasting?** Direct broadcasting works for a single-server deployment. At scale with 20+ API servers, each server only sees trades matched locally. Kafka provides fan-out: one producer (the matching engine) publishes once, and all consumers (WebSocket servers, analytics) receive the event. Kafka also provides durability: if a consumer goes down, it resumes from its last committed offset, ensuring no events are lost.

**Local simplification**: The price broadcaster worker publishes to Kafka, but the main API server also broadcasts directly via WebSocket. This dual path ensures the frontend works even if Kafka is not running.

### Decision 6: Idempotent Order Placement via Redis

**Context**: Network failures during order submission can result in duplicate orders if not handled.

**Implementation**: Client generates UUID v4 as idempotency key. Server checks Redis before processing. If found, cached response returned. If not, order processed and result cached with 24-hour TTL.

**Why Redis instead of database?** Idempotency checks happen before business logic begins. Redis GET is sub-millisecond; PostgreSQL adds 1-5ms. The keys are ephemeral (24h TTL), not worth permanent storage. If Redis is down, the `idempotency_key` UNIQUE constraint on the orders table provides a database-level fallback -- the order will fail with a constraint violation rather than creating a duplicate.

---

## Security and Auth

### Authentication

- **Session-based auth** using Express sessions stored in Redis
- Sessions prefixed with `coinbase:sess:` for namespace isolation
- `httpOnly` cookies prevent JavaScript access (XSS mitigation)
- `sameSite: 'lax'` prevents CSRF on cross-origin POST requests
- 24-hour session TTL with automatic expiry

### Password Security

- bcrypt with cost factor 12 (approximately 200ms per hash)
- Password minimum 8 characters, validated server-side

### Rate Limiting

Three tiers of rate limiting using `express-rate-limit`:

| Tier | Scope | Limit | Window |
|------|-------|-------|--------|
| API General | All `/api` routes | 100 req | 1 minute |
| Order Placement | POST `/api/v1/orders` | 10 req | 1 second |
| Authentication | Login/register | 20 req | 15 minutes |

### Input Validation

- Side must be `buy` or `sell`
- Order type must be `market`, `limit`, or `stop`
- Quantity validated against `min_order_size` and `max_order_size` per trading pair
- Idempotency key is VARCHAR(64) with UNIQUE constraint

---

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_request_duration_seconds` | Histogram | method, route, status_code | API latency SLO tracking |
| `order_counter` | Counter | side, type, status | Order volume by type |
| `trade_counter` | Counter | - | Total trades executed |
| `active_websocket_connections` | Gauge | - | Connection health |
| `order_book_depth` | Gauge | symbol, side | Book liquidity |

Metrics are exposed at `GET /metrics` in Prometheus exposition format.

### Structured Logging

Using Pino for JSON-structured logging with contextual fields: `error`, `symbol`, `userId`, `userCount`. Debug level in development, info level in production.

### Health Check

```
GET /api/v1/health

{
  "status": "healthy",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "uptime": 3600.5
}
```

---

## Failure Handling

### Circuit Breaker (Opossum)

Wraps external service calls (database, Redis, Kafka) with automatic failure detection:
- **Timeout**: 5 seconds per call
- **Error threshold**: 50% error rate opens the circuit
- **Volume threshold**: Minimum 5 requests before evaluating
- **Recovery**: 30-second wait, then one test request (half-open)

### Non-Critical Service Degradation

Kafka failures do not block order processing. The trade is recorded in PostgreSQL (the source of truth) regardless of whether the Kafka event was published. The trade event is used for real-time notifications, not for correctness.

### Database Transaction Safety

All multi-table operations (trade execution, deposit, order cancellation) use explicit PostgreSQL transactions with `BEGIN`/`COMMIT`/`ROLLBACK`. This prevents partial states like "buyer debited but seller not credited."

### Graceful Shutdown

SIGTERM and SIGINT handlers complete in-flight requests before process exit, preventing dropped connections during deployments.

### WebSocket Reconnection

The frontend WebSocket client implements exponential backoff reconnection:
```
delay = min(1000 * 2^attempt, 30000)   -- 1s, 2s, 4s, 8s, 16s, 30s max
maxAttempts = 10
```

On reconnect, the client re-subscribes to all previously subscribed channels.

---

## Scalability Considerations

### Matching Engine Scaling

**Single-threaded per trading pair**: Each trading pair's order book runs on a single thread to avoid synchronization overhead. This is the pattern used by real exchanges (e.g., LMAX Disruptor architecture). At scale:
- Shard matching engines by trading pair across servers
- Each server handles 10-50 trading pairs
- Use consistent hashing to route orders to the correct matching engine

### Price Feed Distribution

**At 1M WebSocket connections**:
- Each API server handles ~50K connections
- 20 API servers behind the load balancer
- Kafka fan-out: price broadcaster publishes once, all 20 servers consume
- Each server broadcasts to its local WebSocket connections
- Alternative: use a dedicated WebSocket gateway service (e.g., Centrifugo)

### Database Sharding

**User data sharding**: Shard wallets, orders, and transactions by `user_id` hash. Each shard contains all data for a subset of users. Cross-shard operations only happen during trade settlement (buyer and seller on different shards).

**Market data sharding**: Shard `price_candles` by `symbol` hash. Each shard contains all candle data for a subset of trading pairs. Read-heavy workload benefits from read replicas per shard.

### Caching Strategy

| Data | Cache Key | TTL | Invalidation |
|------|-----------|-----|-------------|
| Trading pairs | `pairs:all` | 300s | On pair activation/deactivation |
| Current prices | In-memory (MarketService) | Real-time | Updated every 2s |
| Order book depth | Computed from in-memory book | Real-time | Updated per order |
| User portfolio | `portfolio:{userId}` | 30s | On trade/deposit |
| Idempotency keys | `idempotency:{key}` | 24h | Auto-expire |
| Sessions | `coinbase:sess:{id}` | 24h | On logout |

### Horizontal Scaling Path

```
Phase 1 (Current): Single server
  1 API server + 1 price broadcaster + 1 portfolio worker

Phase 2: Multi-instance
  3 API servers behind nginx
  Sticky sessions for WebSocket
  Shared Redis for sessions

Phase 3: Service separation
  Dedicated matching engine process
  Kafka for inter-service communication
  Separate WebSocket gateway

Phase 4: Full scale
  Sharded matching engines by pair
  PostgreSQL read replicas for market data
  Time-partitioned candle data
  Dedicated user-data shards
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Monetary precision | DECIMAL(28,18) | FLOAT / BIGINT | Exact arithmetic, no rounding errors |
| Order book storage | In-memory arrays | Database rows | Sub-millisecond matching vs. multi-ms DB queries |
| Balance management | Reserved balance pattern | Immediate deduction | Clean state separation, easy cancellation |
| Price simulation | Geometric Brownian Motion | Random walk / static | Log-normal returns, configurable volatility |
| Event streaming | Kafka | RabbitMQ / direct | Durable, replayable, multi-consumer fan-out |
| Idempotency storage | Redis with 24h TTL | Database UNIQUE constraint | Sub-ms check before business logic |
| Session storage | Redis + cookie | JWT | Immediate revocation, no token size in requests |
| Real-time transport | WebSocket | SSE / polling | Bidirectional, per-channel subscriptions |
| Chart library | lightweight-charts | D3 / recharts | TradingView quality, purpose-built for OHLCV |
| API value format | Strings for DECIMAL | Numbers | Prevents silent precision loss in JSON |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker Compose.

### Local Setup Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    React SPA (Vite :5173)                     │
│                                                              │
│  /              Market overview (asset list, prices)         │
│  /trade/:symbol Trading view (chart, order book, form)      │
│  /portfolio     Portfolio dashboard (holdings, allocation)   │
│  /orders        Order history (open, filled, cancelled)     │
│  /login, /register                                           │
└────────────┬──────────────────────────┬──────────────────────┘
             │ HTTP (REST)              │ WebSocket
             ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│             Express API + WebSocket Server (:3000)            │
│             (or 3 instances :3001-3003)                       │
├──────────────────────────────────────────────────────────────┤
│  /api/v1/auth/*         Auth (register, login, logout)       │
│  /api/v1/markets/*      Prices, order book, candles, trades  │
│  /api/v1/orders         Place/cancel/list orders             │
│  /api/v1/portfolio      Holdings, history                    │
│  /api/v1/wallets        Balances, deposit                    │
│  /api/v1/transactions   Transaction history                  │
│  /api/v1/health         Health check                         │
│  /metrics               Prometheus metrics                   │
│  /ws                    WebSocket endpoint                   │
└──┬──────────┬──────────┬──────────────────────────────────────┘
   │          │          │
   ▼          ▼          ▼
┌──────┐  ┌──────┐  ┌──────────────────────────────────────┐
│Postgr│  │Valkey│  │           Kafka (:9092)              │
│:5432 │  │:6379 │  │   + Zookeeper (:2181)                │
│      │  │      │  │                                      │
│DECIMAL│  │sessns│  │  Topic: price-updates (keyed by sym) │
│(28,18)│  │cache │  │  Topic: trade-events (keyed by sym)  │
│      │  │idemp.│  │                                      │
└──────┘  └──────┘  └───────────────┬──────────────────────┘
                                    │
                         ┌──────────┼──────────┐
                         ▼                     ▼
                  ┌──────────────┐    ┌──────────────────┐
                  │ Price        │    │ Portfolio         │
                  │ Broadcaster  │    │ Updater Worker    │
                  │ Worker       │    │ (60s snapshots)   │
                  │ (2s ticks)   │    │                   │
                  └──────────────┘    └──────────────────┘
```

### Production-Grade Patterns Actually Implemented

**1. Idempotent Order Placement** -- Prevents duplicate orders caused by network retries. Client generates UUID v4 as idempotency key; server checks Redis before processing. If the key exists, the cached response is returned without creating a new order. Database UNIQUE constraint on `idempotency_key` provides a fallback.

File: `backend/src/services/idempotency.ts`

**2. Circuit Breaker (Opossum)** -- Wraps external service calls with automatic failure detection. Opens at 50% error rate across 5+ requests; recovers after 30-second timeout. Prevents cascading failures when PostgreSQL, Redis, or Kafka are unhealthy.

File: `backend/src/services/circuitBreaker.ts`

**3. Prometheus Metrics** -- HTTP request duration histograms, order counters (by side/type/status), trade counter, WebSocket connection gauge, and order book depth gauge. Exposed at `GET /metrics`.

File: `backend/src/services/metrics.ts`

**4. Structured Logging (Pino)** -- JSON-structured logs with contextual fields. Debug level in development, info in production.

File: `backend/src/services/logger.ts`

**5. Three-Tier Rate Limiting** -- General API (100/min), order placement (10/sec), authentication (20/15min). Uses `express-rate-limit` with Redis store.

File: `backend/src/services/rateLimiter.ts`

**6. Health Check** -- `GET /api/v1/health` returns status, timestamp, and uptime for load balancer probes.

File: `backend/src/app.ts`

**7. Graceful Shutdown** -- SIGTERM/SIGINT handlers complete in-flight requests before exit.

File: `backend/src/index.ts`

**8. Database Transaction Isolation** -- All multi-table wallet operations use explicit transactions. Wallet CHECK constraints provide a second line of defense against negative balances or over-reservation.

File: `backend/src/services/walletService.ts`

**9. WebSocket with Exponential Backoff Reconnection** -- Frontend client reconnects with 1s, 2s, 4s, 8s... up to 30s delay, re-subscribing to all channels.

File: `frontend/src/hooks/` (WebSocket hook)

**10. In-Memory Order Book with Price-Time Priority** -- Bids sorted DESC by price then ASC by time; asks sorted ASC by price then ASC by time. Matching runs after every order placement.

File: `backend/src/services/orderBook.ts`, `backend/src/services/orderService.ts`

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| Real market data feed (CoinGecko, Binance API) | Geometric Brownian Motion simulation | Self-contained, no API keys needed |
| Distributed matching engine (LMAX, Aeron) | Single-process in-memory arrays | Learning project, < 1000 orders |
| KYC/AML verification | Boolean `is_verified` flag | Regulatory compliance out of scope |
| Cold wallet / hot wallet separation | Single wallet table | Hardware security modules out of scope |
| Multi-region deployment | Single Docker Compose | Local development only |
| PostgreSQL sharding (Citus) | Single PostgreSQL instance | Sufficient for development scale |
| OAuth2 / API keys for programmatic access | Session cookies only | Simpler auth for learning project |
| Fee tiers (maker/taker volume-based) | Fixed 0.1% maker / 0.2% taker | Simplified fee structure |
| TimescaleDB for candles | PostgreSQL `price_candles` table | Avoids extra dependency |

### What Was Omitted

- **Blockchain integration**: No actual on-chain deposits/withdrawals, custody, or wallet addresses
- **CDN** for frontend static assets
- **Multi-region deployment**: No geographic distribution or latency optimization
- **Advanced order types**: No stop-limit, trailing stop, iceberg, or FOK/IOC orders
- **Margin trading / leverage**: No borrowing or liquidation engine
- **Market maker bots**: No automated liquidity provision
- **Compliance infrastructure**: No KYC, AML, SAR filing, or audit trail certification
- **Kubernetes / container orchestration**: Docker Compose only
- **SSL/TLS termination**: Plain HTTP in development
- **Read replicas**: Single PostgreSQL instance handles all reads and writes
- **ML-based fraud detection**: No anomaly detection on trading patterns
- **Grafana dashboards**: Prometheus metrics collected but not visualized
