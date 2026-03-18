# Robinhood - Stock Trading - Architecture Design

## System Overview

A stock trading platform with real-time quotes, order placement, portfolio tracking, and price alerts. Core challenges involve real-time data distribution, order execution integrity, and financial transaction safety.

**Learning Goals:**
- Real-time data feeds via WebSocket and Kafka
- Order matching with transaction integrity
- Portfolio P&L calculations
- Market data distribution at scale

---

## Requirements

### Functional Requirements

1. **Real-time quotes**: WebSocket-based streaming with configurable update intervals
2. **Order placement**: Market, limit, stop, and stop-limit orders with buy/sell sides
3. **Portfolio tracking**: Real-time P&L calculations, position management, cost basis tracking
4. **Watchlists**: User-created lists of tracked symbols with price alerts
5. **Authentication**: Session-based auth with user/admin roles

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| **Availability** | 99.95% during market hours | Trading platforms must be up when markets are open |
| **Quote Latency** | p95 < 100ms end-to-end | Real-time experience requires sub-second updates |
| **Order Latency** | p95 < 500ms placement to confirmation | Orders must confirm quickly for user confidence |
| **Consistency** | Strong for orders/positions, eventual for quotes | Financial transactions require ACID; quotes can lag |
| **Throughput** | 10K+ concurrent WebSocket connections | Market open generates connection surge |

---

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Concurrent Users | 100K+ | Market open peak |
| WebSocket Connections | 100K+ | One per active client |
| Quote Updates/Second | 50K+ | 5000 symbols * 10 updates/second |
| Order Submissions/Second | 1,000 | Peak during market volatility |
| Position Updates/Trade | 2-3 DB writes | Order + execution + position upsert |
| Daily Orders | 500K-1M | Active trading day |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Simulated Stocks | 20 |
| Quote Updates/Second | 20 (one per stock per second) |
| Concurrent WebSocket Connections | 10-100 |
| REST API RPS | 10-50 |
| Total Storage | < 100 MB |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│              React + Vite + TypeScript + Zustand                 │
│         Portfolio │ Stock Detail │ Orders │ Watchlists           │
└─────────────────────────────────────────────────────────────────┘
            │ HTTP REST                    │ WebSocket
            ▼                              ▼
┌───────────────────┐          ┌───────────────────────┐
│    REST API       │          │   WebSocket Server     │
│   (Express)       │          │   (ws library)         │
│                   │          │                        │
│  Auth, Orders,    │          │  Quote subscriptions,  │
│  Portfolio,       │          │  Price alerts,          │
│  Watchlists       │          │  Client filtering      │
└───────┬───────────┘          └────────────┬──────────┘
        │                                   │
        ▼                                   ▼
┌───────────────────────────────────────────────────────────────┐
│                    Services Layer                              │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
│  │  Quote   │  │  Order   │  │ Portfolio │  │ Watchlist  │  │
│  │ Service  │  │ Service  │  │ Service   │  │ Service    │  │
│  │          │  │          │  │           │  │            │  │
│  │ Simulate │  │ Validate │  │ P&L calc  │  │ Alerts     │  │
│  │ prices   │  │ Execute  │  │ Positions │  │ CRUD       │  │
│  │ Publish  │  │ Fill     │  │ History   │  │ Monitor    │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └─────┬──────┘  │
│       │             │              │              │           │
└───────┼─────────────┼──────────────┼──────────────┼───────────┘
        │             │              │              │
        ▼             ▼              ▼              ▼
┌───────────────┐  ┌─────────────┐  ┌──────────────────┐
│    Kafka      │  │ PostgreSQL  │  │  Redis / Valkey   │
│               │  │             │  │                   │
│  quotes topic │  │ Users       │  │ Quote cache       │
│  orders topic │  │ Orders      │  │ Sessions          │
│  trades topic │  │ Executions  │  │ Idempotency       │
│               │  │ Positions   │  │ Pub/Sub (quotes)  │
└───────────────┘  │ Watchlists  │  │                   │
                   │ Sessions    │  └──────────────────┘
                   └─────────────┘
```

**Worker Processes:**
```
┌───────────────────┐     ┌────────────────────┐
│ Quote Broadcaster │     │ Portfolio Updater   │
│                   │     │                    │
│ Consumes: quotes  │     │ Consumes: trades   │
│ Publishes: Redis  │     │ Updates: positions │
│ Pushes: WebSocket │     │ Recalculates: P&L  │
└───────────────────┘     └────────────────────┘
```

---

## Core Components

### 1. Quote Service

The quote service simulates market data using a random walk algorithm with configurable volatility per stock. Every second:

1. For each of 20 simulated stocks, apply price movement
2. Update in-memory cache and Redis hash (`quote:{SYMBOL}`)
3. Publish batch to Kafka `quotes` topic (Snappy compression, symbol as partition key)
4. Redis pub/sub publishes to `quote_updates` channel

Consumers (Quote Broadcaster workers) read from Kafka and push to WebSocket clients based on their subscription sets.

**Quote Data Structure:**

| Field | Type | Description |
|-------|------|-------------|
| symbol | string | Ticker (e.g., AAPL) |
| last | number | Last trade price |
| bid | number | Best bid |
| ask | number | Best ask |
| open | number | Opening price |
| high | number | Day high |
| low | number | Day low |
| volume | number | Trading volume |
| change | number | Price change from open |
| changePercent | number | Percentage change |
| timestamp | number | Unix timestamp |

### 2. Order Service

Order placement follows a two-phase approach with transactional integrity:

**Market Order Flow:**
1. Validate symbol, quantity, and order type
2. Begin PostgreSQL transaction
3. Lock user row (`SELECT buying_power FROM users WHERE id = $1 FOR UPDATE`)
4. Check buying power >= estimated cost (quantity * ask price)
5. Insert order with status `pending`
6. Deduct estimated cost from buying power
7. Commit transaction
8. Execute immediately: get current ask, create execution record, update order status to `filled`
9. Upsert position: add shares, recalculate average cost basis
10. Adjust buying power for actual vs estimated cost
11. Publish order and trade events to Kafka

**Limit Order Flow:**
1. Steps 1-7 same as market order
2. Order remains in `pending` status
3. Background limit order matcher runs every 2 seconds:
   - Query all pending/submitted limit orders
   - Check if current price meets limit condition (buy: ask <= limit, sell: bid >= limit)
   - Execute matching orders using the same fill flow

**Optimistic Locking:** Orders have a `version` column. The fill query includes `WHERE version = $expected` to detect concurrent updates. If no rows are updated, another process filled the order first.

### 3. Portfolio Service

Portfolio calculations combine static position data (from PostgreSQL) with real-time quotes (from Redis/in-memory):

| Calculation | Formula |
|-------------|---------|
| Market Value | quantity * current_price |
| Cost Basis | quantity * avg_cost_basis |
| Unrealized P&L | market_value - cost_basis |
| Unrealized P&L % | (current_price - avg_cost_basis) / avg_cost_basis * 100 |
| Day P&L | quantity * (current_price - open_price) |
| Total Portfolio Value | buying_power + sum(market_values) |

Portfolio updates are driven by the Portfolio Updater worker, which consumes trade events from Kafka and recalculates affected positions.

### 4. WebSocket Protocol

**Connection:** `ws://host:3000/ws?token=<session-token>`

**Client Messages:**

| Type | Payload | Description |
|------|---------|-------------|
| `subscribe` | `{ symbols: ["AAPL", "GOOGL"] }` | Subscribe to specific quotes |
| `unsubscribe` | `{ symbols: ["AAPL"] }` | Unsubscribe from symbols |
| `subscribe_all` | -- | Subscribe to all symbols |
| `unsubscribe_all` | -- | Unsubscribe from all |
| `ping` | -- | Keepalive |

**Server Messages:**

| Type | Description |
|------|-------------|
| `connected` | Auth confirmation |
| `quotes` | Array of quote updates (filtered by subscription) |
| `alert` | Price alert triggered |
| `pong` | Keepalive response |

**Heartbeat:** Server pings every 30 seconds. Clients that do not respond with pong are terminated as stale connections.

---

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users: Authentication and account state
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    account_status VARCHAR(20) DEFAULT 'active'
      CHECK (account_status IN ('active', 'suspended', 'closed')),
    buying_power DECIMAL(14,2) DEFAULT 10000.00,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Positions: Current stock holdings per user
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(10) NOT NULL,
    quantity DECIMAL(14,6) NOT NULL DEFAULT 0,
    avg_cost_basis DECIMAL(14,4) NOT NULL DEFAULT 0,
    reserved_quantity DECIMAL(14,6) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, symbol)
);

-- Orders: Full lifecycle tracking
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(10) NOT NULL,
    side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type VARCHAR(20) NOT NULL
      CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
    quantity DECIMAL(14,6) NOT NULL,
    limit_price DECIMAL(14,4),
    stop_price DECIMAL(14,4),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'submitted', 'filled', 'partial', 'cancelled', 'rejected', 'expired')),
    filled_quantity DECIMAL(14,6) DEFAULT 0,
    avg_fill_price DECIMAL(14,4),
    time_in_force VARCHAR(10) DEFAULT 'day'
      CHECK (time_in_force IN ('day', 'gtc', 'ioc', 'fok')),
    submitted_at TIMESTAMP,
    filled_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    version INTEGER DEFAULT 0
);

-- Executions: Individual trade fills
CREATE TABLE executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    quantity DECIMAL(14,6) NOT NULL,
    price DECIMAL(14,4) NOT NULL,
    exchange VARCHAR(20) DEFAULT 'SIMULATOR',
    executed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Sessions: Token-based authentication
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Watchlists and alerts
CREATE TABLE watchlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT 'My Watchlist',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, name)
);

CREATE TABLE watchlist_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    watchlist_id UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(watchlist_id, symbol)
);

CREATE TABLE price_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(10) NOT NULL,
    target_price DECIMAL(14,4) NOT NULL,
    condition VARCHAR(10) NOT NULL CHECK (condition IN ('above', 'below')),
    triggered BOOLEAN DEFAULT FALSE,
    triggered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Portfolio snapshots
CREATE TABLE portfolio_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_value DECIMAL(14,2) NOT NULL,
    buying_power DECIMAL(14,2) NOT NULL,
    snapshot_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, snapshot_date)
);

-- Indexes for common queries
CREATE INDEX idx_positions_user_id ON positions(user_id);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_symbol ON orders(symbol);
CREATE INDEX idx_executions_order_id ON executions(order_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_price_alerts_symbol ON price_alerts(symbol);
CREATE INDEX idx_price_alerts_user_id ON price_alerts(user_id);
```

### Redis Data Structures

| Key Pattern | Type | Purpose | TTL |
|-------------|------|---------|-----|
| `quote:<SYMBOL>` | Hash | Current quote data | None (overwritten each second) |
| `session:<token>` | String | Session cache | 24 hours |
| `idempotency:<userId>:<key>` | String | Order idempotency | 24 hours |

**Pub/Sub Channels:**
- `quote_updates`: All quote changes (20 quotes/second)

---

## API Design

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | No | Login with email/password |
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/logout` | Yes | Invalidate session |
| GET | `/api/quotes/:symbol` | No | Get single quote |
| GET | `/api/quotes` | No | Get all quotes |
| GET | `/api/quotes/stocks` | No | List available symbols |
| POST | `/api/orders` | Yes | Place order (with X-Idempotency-Key) |
| GET | `/api/orders` | Yes | List user's orders |
| GET | `/api/orders/:id` | Yes | Get order details |
| DELETE | `/api/orders/:id` | Yes | Cancel order |
| GET | `/api/portfolio` | Yes | Portfolio summary with P&L |
| GET | `/api/portfolio/positions` | Yes | List positions |
| GET | `/api/watchlists` | Yes | List watchlists |
| POST | `/api/watchlists` | Yes | Create watchlist |
| POST | `/api/watchlists/:id/items` | Yes | Add symbol |
| DELETE | `/api/watchlists/:id/items/:symbol` | Yes | Remove symbol |
| GET | `/metrics` | Internal | Prometheus metrics |
| GET | `/health` | None | Health check |

### WebSocket

**Connection:** `ws://localhost:3000/ws?token=<session-token>`

---

## Key Design Decisions

### 1. WebSocket for Real-Time Quotes (vs SSE vs Polling)

**Chosen:** WebSocket with subscription-based filtering.
**Alternative:** Server-Sent Events (SSE) or long polling.
**Rationale:** WebSocket provides bidirectional communication needed for subscription management (subscribe/unsubscribe messages from client to server). SSE is one-directional -- the client could not dynamically change subscriptions without separate HTTP requests. Polling at 1-second intervals would generate 60 requests/minute per user, overwhelming the API at 100K concurrent users. WebSocket maintains a single persistent connection with sub-10ms message delivery. The tradeoff is connection management complexity: heartbeat detection for stale connections, graceful reconnection logic, and sticky sessions for horizontal scaling.

### 2. Kafka for Event Streaming (vs Redis Pub/Sub Only)

**Chosen:** Kafka for quotes, orders, and trades topics with dedicated consumer workers.
**Alternative:** Redis Pub/Sub for all event distribution.
**Rationale:** Redis Pub/Sub is fire-and-forget -- if a consumer is down, messages are lost. For trade events that update portfolio positions, this is unacceptable. Kafka provides durable, partitioned event streams with consumer group semantics: if a Portfolio Updater worker crashes and restarts, it resumes from the last committed offset. For quotes, durability matters less (stale quotes are overwritten), but Kafka's partitioning by symbol ensures ordering guarantees. The tradeoff is operational complexity -- Kafka requires Zookeeper and more memory -- but the durability guarantee for financial events justifies it.

### 3. Synchronous Market Order Execution (vs Queue-Based)

**Chosen:** Synchronous execution for market orders within the HTTP request lifecycle.
**Alternative:** Enqueue orders and execute asynchronously.
**Rationale:** Users expect immediate feedback when placing a market order. Queue-based execution adds latency and requires the client to poll for status. Since market orders execute at the current price (no matching needed in our simulation), synchronous execution provides sub-100ms feedback. The tradeoff: at high volume, synchronous execution creates database contention. For production scale, a hybrid approach would use synchronous for market orders and async for limit orders, with the async path providing order status via WebSocket push.

---

## Consistency and Idempotency

**Order Idempotency:**
- Client sends `X-Idempotency-Key` header with each order
- Server checks Redis via `SET NX` (atomic lock)
- If key exists with `completed` status, return cached order result
- If key exists with `pending` status, wait or return 409
- Result cached with 24-hour TTL

**Order Execution Integrity:**
- All balance modifications (buying power, positions) within PostgreSQL transactions
- `SELECT FOR UPDATE` on user row prevents concurrent balance corruption
- Optimistic locking on orders (`version` column) prevents double fills
- Execution records provide an audit trail for every fill

**Consistency Guarantees:**
- Orders/Positions: Strong (PostgreSQL ACID)
- Quotes: Eventual (1-second staleness acceptable)
- Portfolio P&L: Eventual (depends on quote freshness)

---

## Security / Auth

| Control | Implementation |
|---------|---------------|
| Password Storage | bcrypt with 10 rounds |
| Session Tokens | UUID v4, stored in PostgreSQL + Redis cache |
| Session Expiry | 24 hours |
| Token Transmission | Bearer header (HTTPS in production) |
| Input Validation | Symbol existence, positive quantities, valid order types |
| SQL Injection | Parameterized queries throughout |
| Role-Based Access | `user` and `admin` roles with middleware check |

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, path, status | Request volume |
| `http_request_duration_ms` | Histogram | method, path | Latency distribution |
| `orders_placed_total` | Counter | side, order_type | Order activity |
| `orders_filled_total` | Counter | side, order_type | Fill rate |
| `orders_cancelled_total` | Counter | -- | Cancellation tracking |
| `orders_rejected_total` | Counter | reason | Rejection analysis |
| `order_execution_duration_ms` | Histogram | order_type | End-to-end order latency |
| `orders_pending` | Gauge | order_type | Pending order backlog |
| `execution_value_total` | Counter | side | Trading volume |
| `quote_updates_total` | Counter | -- | Quote service health |
| `websocket_connections` | Gauge | authenticated | Connection count |
| `circuit_breaker_state` | Gauge | name | Dependency health |
| `idempotency_hits_total` | Counter | -- | Duplicate detection |
| `audit_entries_total` | Counter | action, status | Compliance tracking |
| `db_pool_size` | Gauge | state | Connection pool health |

### SLI Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Order execution p99 | < 500ms | > 750ms for 5 min |
| Quote update rate | 20/second | < 15/second for 1 min |
| Order rejection rate | < 1% | > 5% for 5 min |
| WebSocket connection success | > 99% | < 95% for 2 min |
| API availability | 99.9% | < 99.5% for 5 min |

### Structured Logging

JSON logs via Pino with: `service`, `port`, `requestId`, `userId`, `orderId`, `symbol`. Pretty-printed in development, raw JSON in production.

---

## Failure Handling

### Circuit Breakers

Circuit breakers protect against cascading failures when external dependencies become unavailable:

| Service | Library | Timeout | Error Threshold | Reset Timeout | Fallback |
|---------|---------|---------|-----------------|---------------|----------|
| Market data | Opossum | 3s | 50% of 5 requests | 30s | Return last known quote |
| Redis publish | Opossum | 3s | 50% of 5 requests | 30s | Skip quote caching |
| Database | Opossum | 3s | 50% of 5 requests | 30s | Return 503 |

### Transaction Integrity

All financial operations use explicit PostgreSQL transactions with rollback:
1. Acquire connection from pool
2. `BEGIN` transaction
3. Lock affected rows (`FOR UPDATE`)
4. Validate and execute
5. `COMMIT` on success, `ROLLBACK` on any error
6. Release connection in `finally` block

### Retry Strategy

| Operation | Retries | Backoff | Notes |
|-----------|---------|---------|-------|
| Redis connection | Unlimited | Exponential (50ms-2s) | Critical for quotes |
| Database query | 0 | -- | Transactions should not retry |
| Kafka publish | 5 | Exponential (100ms) | Built into kafkajs |
| WebSocket reconnect | Client-side | Exponential | Frontend handles |

### Graceful Shutdown

On SIGTERM:
1. Stop accepting new connections
2. Stop quote service and limit order matcher
3. Close HTTP server (waits for in-flight requests)
4. Disconnect Kafka producer
5. Close Redis and PostgreSQL connections
6. Exit

---

## Scalability Considerations

### Scaling Path

| Component | Current | Production Scale |
|-----------|---------|-----------------|
| API Server | Single process | Stateless fleet behind load balancer |
| WebSocket | Single process | Sticky sessions + Redis pub/sub for cross-instance messaging |
| PostgreSQL | Single instance | Primary + read replicas for portfolio/order queries |
| Redis | Single instance | Cluster mode for quote distribution |
| Kafka | Single broker | Multi-broker cluster with replication |
| Quote Service | In-process | Dedicated service with real market data feed |
| Order Matcher | In-process interval | Single leader with distributed lock (Redis SETNX) |

### What Breaks First

1. **WebSocket connections** -- a single Node.js process handles ~10K connections. Solution: horizontal scaling with sticky sessions and Redis pub/sub for cross-instance quote distribution.
2. **PostgreSQL write throughput** -- order execution generates 3+ writes per trade. Solution: read replicas for portfolio queries, write batching for position updates.
3. **Quote distribution fan-out** -- 100K clients * 20 quotes/second = 2M messages/second. Solution: Kafka consumer groups with multiple broadcaster instances, client-side subscription filtering.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | WebSocket | SSE / Polling | Bidirectional, lowest latency |
| Event streaming | Kafka | Redis Pub/Sub only | Durable events for financial data |
| Session storage | PostgreSQL + Redis cache | Redis-only / JWT | Instant revocation, persistence |
| Market order execution | Synchronous | Queue-based async | Immediate user feedback |
| Quote simulation | Random walk | Replay historical data | Simpler, sufficient for testing |
| Circuit breaker | Opossum library | Custom implementation | Battle-tested, easy fallback config |

---

## Implementation Notes

### Local Architecture

```
┌─────────────┐       ┌──────────────────────────────────────┐
│  Frontend    │       │  Backend (Express + ws)  :3000       │
│  React+Vite  │──────▶│                                      │
│  :5173       │ REST  │  Routes: auth, orders, portfolio,    │
│              │       │  quotes, watchlists                   │
│              │──────▶│                                      │
│              │  WS   │  Services: quoteService, orderService │
│              │       │  (execution, limit-orders, position   │
│              │       │  updates, validation, cancellation),  │
│              │       │  portfolioService, watchlistService   │
│              │       │                                      │
│              │       │  Shared: logger, metrics, audit,     │
│              │       │  circuitBreaker, idempotency, kafka  │
└─────────────┘       └────────┬─────────┬─────────┬────────┘
                               │         │         │
                    ┌──────────▼──┐ ┌────▼─────┐ ┌─▼───────────┐
                    │ PostgreSQL  │ │  Redis   │ │   Kafka      │
                    │ :5432       │ │  :6379   │ │   :9092      │
                    │ robinhood   │ │ quotes,  │ │ quotes,      │
                    │             │ │ sessions,│ │ orders,      │
                    │             │ │ idempot. │ │ trades       │
                    └─────────────┘ └──────────┘ └──────┬──────┘
                                                        │
                              ┌──────────────────┬──────┘
                              ▼                  ▼
                    ┌──────────────────┐ ┌───────────────────┐
                    │Quote Broadcaster │ │Portfolio Updater   │
                    │ :3010            │ │ :3011              │
                    │ Kafka → Redis    │ │ Kafka → PostgreSQL │
                    │ → WebSocket push │ │ Position updates   │
                    └──────────────────┘ └───────────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File(s) | Why It Matters |
|---------|---------|---------------|
| **Kafka event streaming** | `backend/src/shared/kafka.ts`, `backend/src/workers/quote-broadcaster.ts`, `backend/src/workers/portfolio-updater.ts` | Quotes, orders, and trades published to Kafka topics. Dedicated workers consume events for WebSocket broadcasting and portfolio updates. Uses Snappy compression and consumer groups. |
| **Idempotency** | `backend/src/shared/idempotency.ts` | Prevents duplicate order execution. Redis `SET NX` with 24h TTL. Exposes `check`, `start`, `complete`, `fail`, `remove` methods. Fails open if Redis is unavailable. |
| **Circuit breakers** | `backend/src/shared/circuitBreaker.ts` | Uses Opossum library. `createCircuitBreaker` factory with configurable timeout, error threshold, and reset timeout. Metrics-integrated state tracking via Prometheus gauges. |
| **Prometheus metrics** | `backend/src/shared/metrics.ts` | 15+ metrics covering HTTP requests, orders (placed/filled/cancelled/rejected), executions, portfolio updates, quotes, WebSocket connections, circuit breakers, idempotency, and audit entries. Exposed at `/metrics`. |
| **Structured logging** | `backend/src/shared/logger.ts` | Pino with pretty-print in dev, JSON in production. Child loggers with context (requestId, userId, orderId, symbol). |
| **Audit logging** | `backend/src/shared/audit.ts` | Tracks all order placements, fills, cancellations, and rejections with user context. |
| **WebSocket heartbeat** | `backend/src/websocket.ts` | Server pings every 30 seconds. Dead connections terminated. Subscription-based filtering per client. |
| **Optimistic locking** | `backend/src/services/order/execution.ts` | Orders use `version` column to detect concurrent fills. |
| **Limit order matcher** | `backend/src/services/order/limit-orders.ts` | Background interval (2s) checks pending limit orders against current prices. |
| **Multi-process workers** | `backend/package.json` scripts | `dev:quote-broadcaster`, `dev:portfolio-updater` run as separate processes consuming Kafka topics. |
| **Health checks** | `backend/src/index.ts` | `/health` endpoint checking PostgreSQL, Redis, and Kafka connectivity. |

### What Was Simplified or Substituted

| Production Component | Local Substitute | Notes |
|---------------------|-----------------|-------|
| Real market data feed | Quote simulation (random walk) | `backend/src/services/quoteService.ts` with configurable volatility per stock |
| Exchange order matching | Direct execution at simulated price | Market orders fill at current ask/bid, no order book |
| Multi-region deployment | Single-process + multi-port (`dev:server1/2/3`) | Stateless design supports horizontal scaling |
| OAuth / JWT | Session-based (PostgreSQL + Redis cache) | `backend/src/middleware/auth.ts` |
| Real Kafka cluster | Single-broker with Zookeeper | `docker-compose.yml` runs single Kafka instance |
| Rate limiting | Not implemented | Would use `express-rate-limit` + Redis counters |
| Admin dashboard | Role exists, UI not implemented | `admin` role in auth middleware |

### What Was Omitted

- CDN and static asset distribution
- Multi-region deployment and failover
- Kubernetes orchestration
- Real exchange connectivity (FIX protocol)
- Market hours enforcement (pre-market, after-hours)
- Options and fractional share trading
- Historical price charts and candlestick data
- Email/push notifications for alerts
- Account funding (ACH deposits/withdrawals)
- Tax lot tracking and wash sale rules
- SEC/FINRA regulatory compliance logging
- Order history export
- Database connection pooling (PgBouncer)
