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

---

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (RootLayout)
├── /login ─── LoginPage (unauthenticated)
├── /register ─── RegisterPage (unauthenticated)
└── Header + <Outlet> (authenticated)
    ├── / ─── HomePage (auth-guarded via beforeLoad)
    │   ├── PortfolioSummary (total value, buying power, day P&L)
    │   ├── HoldingsList (positions with real-time prices)
    │   └── RecentActivity (latest 5 orders)
    ├── /stock/$symbol ─── StockDetailPage (dynamic route)
    │   ├── PriceDisplay (real-time quote with color-coded change)
    │   ├── Position info (shares, market value, avg cost, P&L)
    │   ├── Statistics grid (open, high, low, volume, 52W, P/E)
    │   ├── TradeForm (buy/sell with order type selection)
    │   └── AddToWatchlistModal
    ├── /stocks ─── StocksPage (all available symbols)
    ├── /orders ─── OrdersPage (full order history)
    └── /watchlist ─── WatchlistPage
        └── Watchlist (CRUD for watchlists + items)
```

The root layout provides a persistent `Header` component with navigation links. Auth guards are implemented via TanStack Router's `beforeLoad` hook on protected routes -- if `useAuthStore.getState().isAuthenticated` is false, the hook throws a `redirect({ to: '/login' })`. This is a synchronous check against the persisted Zustand store (no async API call), so route transitions are instant.

### Routing (TanStack Router, File-Based)

Routes are defined under `frontend/src/routes/`. The project includes one dynamic route segment: `/stock/$symbol` (`stock.$symbol.tsx`), where `$symbol` is the stock ticker. The `useParams` hook extracts the symbol for API calls and WebSocket subscriptions. A separate `router.ts` file configures the TanStack router instance. The route tree is auto-generated at `routeTree.gen.ts`.

### Zustand Stores

Three Zustand stores manage distinct domains with clear boundaries:

**`useAuthStore`** -- Manages user identity, session token, and auth lifecycle. Uses Zustand's `persist` middleware to save `user`, `token`, and `isAuthenticated` to `localStorage` via `partialize` (only persisting those three fields, not `isLoading` or `error`). The token is also stored separately in `localStorage` under the key `token` for the WebSocket service to access outside of React. Provides `login`, `register`, `logout`, and `clearError` actions.

**`useQuoteStore`** -- Manages real-time stock quote data and the WebSocket connection lifecycle. The core data structure is a `Map<string, Quote>` mapping stock symbols to their current quote data. The `initializeConnection` action initializes the WebSocket service (a singleton), registers message and connection state handlers, and is guarded by a module-level `initialized` flag to prevent duplicate connections. When quote updates arrive via WebSocket, the handler creates a new `Map` (for React immutability detection) and updates all changed symbols. Components access individual quotes via `getQuote(symbol)` and manage subscriptions via `subscribe(symbols)` and `unsubscribe(symbols)`.

**`usePortfolioStore`** -- Manages portfolio holdings, orders, watchlists, and price alerts. This is the largest store with 15+ actions. The `placeOrder` action calls the API and then refreshes both portfolio and orders via `Promise.all` to ensure the UI reflects the new position immediately. Watchlist mutations (`addToWatchlist`, `removeFromWatchlist`) use optimistic updates -- they update the store immediately and do not re-fetch from the server.

### Real-Time Data: WebSocket Service

The `WebSocketService` class (`frontend/src/services/websocket.ts`) is a singleton that manages the WebSocket connection to the backend. Key behaviors:

**Connection management:** Connects to `ws://<host>:3001/ws?token=<session-token>`. The token is read from `localStorage` (not the Zustand store) to avoid React dependency. The service tracks connection state and prevents duplicate connections via an `isConnecting` flag.

**Automatic reconnection:** When the WebSocket closes (server restart, network interruption), the service schedules a reconnection attempt after 3 seconds. On reconnection, it automatically re-subscribes to all previously subscribed symbols, so components do not need to re-subscribe manually.

**Subscription management:** Components subscribe to specific stock symbols. The service maintains a `subscribedSymbols` Set and sends subscribe/unsubscribe messages to the server. The server then filters quote updates to only include subscribed symbols, reducing network bandwidth.

**Message handling:** The service uses an observer pattern -- components register message handlers via `onMessage()`, which returns a cleanup function. When a `quotes` message arrives (an array of Quote objects), all registered handlers are notified. The quote store's handler updates its `Map` with the new data.

### Data Fetching Pattern

REST API calls are centralized in `frontend/src/services/api.ts`, organized by domain: `authApi`, `quotesApi`, `ordersApi`, `portfolioApi`, and `watchlistsApi`. A generic `fetchApi<T>()` wrapper injects the Bearer token from `localStorage`, handles JSON serialization, and throws on non-OK responses.

Data fetching is split between two channels:
1. **REST API** for transactional operations (placing orders, managing watchlists, fetching portfolio) -- used in Zustand store actions triggered by `useEffect` on mount.
2. **WebSocket** for real-time quote streaming -- used via the quote store, which updates its `Map` reactively as messages arrive.

The stock detail page (`/stock/$symbol`) demonstrates both channels: it fetches stock details (company info, fundamentals) via REST on mount, while subscribing to the symbol's real-time quotes via WebSocket in a `useEffect` with cleanup (`unsubscribe` on unmount).

### Key UI Patterns

**Portfolio Dashboard (HomePage):** A two-column layout. The main column shows `PortfolioSummary` (total portfolio value, buying power, day P&L with color coding) and `HoldingsList` (each position with real-time market value computed from WebSocket quotes). The sidebar shows `RecentActivity` (latest 5 orders with status badges). The dark theme (`bg-robinhood-gray-800`) with green/red accent colors mirrors Robinhood's visual identity.

**Stock Detail Page (/stock/$symbol):** A two-column layout with stock information on the left (real-time price display, position details if held, statistics grid, company description) and the `TradeForm` on the right. The `PriceDisplay` component updates in real-time as WebSocket quotes arrive, with color-coded change values (green for positive, red for negative). The statistics grid shows 8 metrics (open, high, low, volume, 52W high/low, market cap, P/E ratio) with human-readable formatting (K/M/B suffixes for volume and market cap).

**Trade Form:** A form supporting buy/sell sides and four order types (market, limit, stop, stop-limit). The side toggle is a pair of pill buttons. Order type selection conditionally shows limit price and/or stop price inputs. Quantity and prices are validated client-side. On submission, the order is placed via the portfolio store's `placeOrder` action, which refreshes portfolio and orders after the API call completes.

**Real-Time Price Updates:** The `PriceDisplay` component in `QuoteDisplay.tsx` takes a `Quote` object and renders the current price, dollar change, and percentage change. It supports a `size` prop for different display contexts (compact for lists, large for the stock detail header). The component re-renders whenever the quote store updates with new data for its symbol -- this happens every ~1 second for subscribed symbols.

**Skeleton Loading:** The stock detail page uses animated pulse placeholders (`animate-pulse` with `bg-robinhood-gray-700` blocks) that match the shape of the actual content, providing a polished loading experience.

### Type Safety

Domain types are defined in `frontend/src/types/index.ts`: `User`, `Quote` (with all 11 fields from the backend), `Order` (with full lifecycle status), `Portfolio` (with holdings array), `Position` (with P&L fields), `Watchlist`, `WatchlistItem`, and `PriceAlert`. The WebSocket service types (`MessageHandler`, `ConnectionHandler`) are defined locally in the service file.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Idempotency

**What it is:** Idempotency is a property of an operation where performing it multiple times produces the same result as performing it once. For a stock trading platform, it means that if a user clicks "Buy 10 shares of AAPL" and the network drops, retrying the request will not place a second order.

**Why it matters for order placement:** A duplicate buy order means the user owns 20 shares instead of 10, and their buying power is reduced by double the expected amount. Unlike a duplicate charge (which can be refunded), a duplicate stock order may execute at a different price, creating a position the user never intended. The user might not notice until they see an unexpected loss, and reversing a filled order requires selling at the current market price -- potentially at a loss.

**How it works here:** The client sends an `X-Idempotency-Key` header with each order. The server uses Redis `SET NX` (set-if-not-exists) to atomically claim the key. The idempotency service (`backend/src/shared/idempotency.ts`) exposes five methods: `check` (is this key known?), `start` (claim the key as pending), `complete` (store the result), `fail` (mark the key as failed so it can be retried), and `remove` (clean up). If Redis is unavailable, the system fails open (allows the request through) rather than blocking all orders -- a deliberate trade-off favoring availability over duplicate prevention.

### Redis Cache-Aside (Quote Cache)

**What it is:** Cache-aside is a caching strategy where the application checks the cache first, queries the database on a cache miss, and stores the result in the cache for future reads. The application is responsible for managing the cache -- it is not automatically populated.

**Why it matters:** The quote service generates 20 quote updates per second (one per simulated stock). The REST API endpoint `GET /api/quotes/:symbol` needs to return the current quote instantly without querying the quote service's in-memory state (which may be on a different process or machine in production). Redis serves as the shared quote cache that all API instances can read from.

**How it works here:** Each second, the quote service writes all 20 quotes to Redis as hashes (`quote:<SYMBOL>`). When the REST API receives a quote request, it reads from Redis. There is no TTL -- quotes are overwritten every second, so staleness is bounded to 1 second. This is a write-through pattern (the quote service writes to cache proactively) rather than a traditional cache-aside (read-triggered), but the Redis data structure and access pattern are the same. The Redis `HSET` / `HGETALL` commands provide efficient partial reads when only specific quote fields are needed.

### Circuit Breaker

**What it is:** A circuit breaker prevents an application from making calls to a service that is known to be failing. It operates in three states: CLOSED (requests pass through normally), OPEN (requests fail immediately without trying), and HALF_OPEN (a single test request is allowed to check if the service has recovered).

**Why it matters:** The trading platform depends on three external systems: market data feeds, Redis (for quote caching and publishing), and PostgreSQL (for order persistence). If Redis goes down and the quote service keeps trying to publish quotes, each attempt waits for the connection timeout (3 seconds), blocking the quote update loop. With 20 stocks updating per second, this creates a 60-second backlog in under a minute. The circuit breaker detects the failure pattern and stops trying, allowing the quote service to continue updating its in-memory state even if Redis is unavailable.

**How it works here:** The implementation uses the Opossum library (`backend/src/shared/circuitBreaker.ts`) with a factory function `createCircuitBreaker` that wraps any async function. Three breakers are configured: market data (3s timeout, 50% error threshold over 5 requests, 30s reset), Redis publish (same thresholds), and database (same thresholds). Each breaker has a specific fallback: market data returns the last known quote, Redis publish is silently skipped (quotes are still in memory), and database returns 503. Circuit breaker state is exposed as a `circuit_breaker_state` Prometheus gauge with the breaker name as a label.

### Structured Logging

**What it is:** Structured logging produces log entries as JSON objects with consistent, queryable fields rather than free-form text. Each entry has a standard schema (timestamp, level, service, context fields) that log analysis tools can parse, index, and query.

**Why it matters:** In a multi-process trading system (API server, quote broadcaster, portfolio updater), a single order placement generates log entries across multiple processes. When debugging why an order was rejected, you need to correlate entries by `orderId` across the API server (where the order was received), the order execution service (where it was filled or rejected), and the portfolio updater (where positions were updated). Structured logs with a shared `orderId` field make this correlation a single query.

**How it works here:** Pino is configured (`backend/src/shared/logger.ts`) with context fields: `service` (which process -- api, quote-broadcaster, portfolio-updater), `port` (which instance), `requestId`, `userId`, `orderId`, and `symbol`. In development, Pino's pretty-print transport formats logs with colors for readability. In production, raw JSON is emitted for ingestion by a log aggregator. Child loggers are created per request to carry context through all downstream calls.

### Prometheus Metrics

**What it is:** Prometheus is a monitoring system that collects numeric measurements (metrics) from applications by scraping an HTTP endpoint at regular intervals. Metrics answer questions about system behavior over time: "How many orders were placed in the last hour?" "What is the 95th percentile order execution latency?" "How many WebSocket connections are active right now?"

**Why it matters:** For a trading platform, metrics are the primary operational signal. A spike in `orders_rejected_total` indicates a systemic issue (perhaps the quote service is lagging, causing stale price checks). A drop in `websocket_connections` suggests a connectivity problem. A sustained increase in `order_execution_duration_ms` p99 signals database contention. These patterns are invisible in logs -- they only emerge from aggregated numeric measurements over time windows.

**How it works here:** The implementation uses `prom-client` (`backend/src/shared/metrics.ts`) with 15+ metrics exposed at `/metrics`. Trading metrics include `orders_placed_total` (counter by side and order type), `orders_filled_total`, `orders_cancelled_total`, `orders_rejected_total` (by rejection reason), `order_execution_duration_ms` (histogram), `orders_pending` (gauge by order type), and `execution_value_total` (counter by side -- total dollar volume). Infrastructure metrics include `http_requests_total`, `http_request_duration_ms`, `quote_updates_total`, `websocket_connections` (gauge by authentication status), `circuit_breaker_state`, `idempotency_hits_total`, and `db_pool_size`.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is an authorization model where permissions are assigned to roles (e.g., "user", "admin"), and roles are assigned to users. Instead of checking "does user X have permission to view all orders?", the system checks "does user X have the admin role, and does the admin role include the view-all-orders permission?" This simplifies permission management because adding a new admin user only requires assigning the admin role, not individually granting every permission.

**Why it matters:** A trading platform has different user types with different access needs. Regular users should only see their own portfolio, orders, and watchlists. Administrators need to see all users, monitor system health, manage account statuses, and investigate suspicious activity. Without RBAC, every endpoint would need custom authorization logic. With RBAC, a single middleware checks the user's role against the required role for the endpoint.

**How it works here:** Users have a `role` column in the database with a CHECK constraint limiting values to `user` and `admin`. The auth middleware (`backend/src/middleware/auth.ts`) validates the session token and attaches the full user object (including role) to the request. Protected admin endpoints check `req.user.role === 'admin'` and return 403 Forbidden if the check fails. The role is also included in the persisted Zustand auth store on the frontend, allowing the UI to conditionally render admin-only navigation items.

### Health Checks

**What it is:** Health checks are HTTP endpoints that report whether an application and its dependencies are functioning correctly. Load balancers use them to route traffic only to healthy instances. Container orchestrators use them to restart failed containers.

**Why it matters:** A trading platform that cannot reach PostgreSQL cannot process orders, but it can still serve cached quotes via Redis. A trading platform that cannot reach Redis cannot cache quotes, but it can still process orders via PostgreSQL. Health checks enable the infrastructure to make informed routing decisions based on which specific capabilities are degraded, rather than treating the instance as entirely up or entirely down.

**How it works here:** A single `/health` endpoint (`backend/src/index.ts`) checks three dependencies: PostgreSQL (via a test query), Redis (via a PING command), and Kafka (via producer metadata request). The response includes the status of each dependency and an overall status. If all three are healthy, the endpoint returns 200. If any dependency is unreachable, the response indicates which one failed, enabling operators to diagnose the issue without logging into the server.

### Audit Logging

**What it is:** Audit logging records a permanent trail of all significant user and system actions. Unlike application logs (which focus on debugging), audit logs focus on accountability: who performed what action, on which resource, at what time, and what was the outcome.

**Why it matters:** For a stock trading platform, regulatory requirements (SEC Rule 17a-4, FINRA Rule 4511) mandate retention of all order-related records. Beyond compliance, audit logs enable fraud investigation ("did this user's IP change to a foreign country before placing unusual orders?") and dispute resolution ("the user claims they never placed that sell order -- the audit log shows it was placed from their verified device").

**How it works here:** The audit service (`backend/src/shared/audit.ts`) records all order placements, fills, cancellations, and rejections with user context (user ID, IP address, user agent). Each entry includes the action type, the resource (order ID, symbol), the outcome (success/failure), and a details field with action-specific metadata. The `audit_entries_total` Prometheus counter tracks audit volume by action and status for monitoring.
