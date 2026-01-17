# Robinhood - Stock Trading - Architecture Design

## System Overview

A stock trading platform with real-time quotes, order placement, portfolio tracking, and price alerts. This is a local development learning project that simulates production patterns at a smaller scale.

## Requirements

### Functional Requirements

- **Real-time quotes**: WebSocket-based streaming with 1-second update intervals for 20 simulated stocks
- **Order placement**: Market, limit, stop, and stop-limit orders with buy/sell sides
- **Portfolio tracking**: Real-time P&L calculations, position management, cost basis tracking
- **Watchlists**: User-created lists of tracked symbols with price alerts
- **Authentication**: Session-based auth with user/admin roles

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| **Availability** | 99.9% (8.7 hours downtime/year) | Trading platforms require high uptime during market hours |
| **Read Latency** | p95 < 100ms for quotes, p95 < 200ms for portfolio | Real-time experience requires sub-second responses |
| **Write Latency** | p95 < 500ms for order placement | Orders must confirm quickly for user confidence |
| **Consistency** | Strong for orders/positions, eventual for quotes | Financial transactions require ACID; quotes can lag slightly |
| **Concurrency** | 100 concurrent WebSocket connections locally | Reasonable for local development testing |

## Capacity Estimation

### Local Development Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| **Simulated Users** | 10-50 | Local testing with demo accounts |
| **Concurrent WebSocket Connections** | 10-100 | Browser tabs + test scripts |
| **Quote Updates/Second** | 20 | One update per stock per second |
| **REST API RPS** | 10-50 | Manual testing + automated tests |
| **Orders/Day** | 100-500 | Simulated trading activity |

### Storage Requirements

| Data Type | Growth Rate | 1 Year | Storage Choice |
|-----------|-------------|--------|----------------|
| **Users** | ~10 rows | < 1KB | PostgreSQL |
| **Orders** | ~500/day | ~180K rows (~50MB) | PostgreSQL |
| **Executions** | ~500/day | ~180K rows (~30MB) | PostgreSQL |
| **Positions** | Static (~50) | < 10KB | PostgreSQL |
| **Quote Cache** | 20 symbols | ~5KB | Redis (ephemeral) |
| **Sessions** | ~50 active | < 10KB | PostgreSQL + Redis |

**Total estimated storage**: < 100MB PostgreSQL, < 1MB Redis

### Component Sizing

Based on the above targets:

| Component | Local Dev Size | Production Equivalent |
|-----------|----------------|----------------------|
| **PostgreSQL** | Single instance, 256MB RAM | Primary + 2 replicas |
| **Redis** | Single instance, 64MB RAM | 3-node cluster with persistence |
| **API Server** | Single Node.js process | 3+ instances behind load balancer |
| **WebSocket Server** | Single process, 100 connections | Horizontally scaled with sticky sessions |

## High-Level Architecture

```
                                    +------------------+
                                    |   React + Vite   |
                                    |    Frontend      |
                                    +--------+---------+
                                             |
                         HTTP REST           |  WebSocket
                    +--------------------+   |   +-------------------+
                    |                    |   |   |                   |
                    v                    v   v   v                   |
               +----+----+          +----+---+---+----+              |
               |  REST   |          |   WebSocket     |              |
               |  API    |          |   Handler       |              |
               +----+----+          +--------+--------+              |
                    |                        |                       |
                    |     +------------------+                       |
                    |     |                                          |
                    v     v                                          |
        +-----------+-----+-----------+                              |
        |        Services Layer       |                              |
        |  +-------+  +--------+      |                              |
        |  | Quote |  | Order  |      |                              |
        |  |Service|  |Service |      |                              |
        |  +---+---+  +---+----+      |                              |
        |      |          |           |                              |
        |  +---+---+  +---+----+      |                              |
        |  |Portfolio| |Watchlist|    |                              |
        |  |Service  | |Service  |    |                              |
        |  +---+-----+ +----+----+    |                              |
        +------+------------+---------+                              |
               |            |                                        |
    +----------+--+    +----+-------+                                |
    | PostgreSQL  |    |   Redis    |<-------------------------------+
    |  (primary)  |    | (cache +   |     Pub/Sub for quote updates
    +-------------+    |  pub/sub)  |
                       +------------+
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **REST API** | HTTP endpoints for auth, orders, portfolio, watchlists | Express.js |
| **WebSocket Handler** | Real-time quote streaming, user notifications | ws library |
| **Quote Service** | Simulates market data, caches in Redis, publishes updates | Node.js + Redis |
| **Order Service** | Order validation, execution, position updates | Node.js + PostgreSQL |
| **Portfolio Service** | P&L calculations, position aggregation | Node.js + PostgreSQL |
| **Watchlist Service** | Price alert monitoring, watchlist CRUD | Node.js + PostgreSQL |

## Request Flows

### Quote Subscription Flow

```
1. Client connects: ws://localhost:3000/ws?token=<session-token>
2. Server validates token against sessions table
3. Client sends: { "type": "subscribe", "symbols": ["AAPL", "GOOGL"] }
4. Server adds symbols to client's subscription set
5. Server immediately sends current quotes for subscribed symbols
6. Every 1 second:
   a. QuoteService simulates price movement (random walk with volatility)
   b. Quotes cached in Redis: HSET quote:AAPL data '{"last":178.50,...}'
   c. Published to Redis channel: PUBLISH quote_updates '[...]'
   d. WebSocketHandler filters quotes by client subscriptions
   e. Relevant quotes sent to each client
```

### Order Placement Flow (Market Order)

```
1. Client: POST /api/orders { symbol: "AAPL", side: "buy", order_type: "market", quantity: 10 }
2. Auth middleware validates Bearer token
3. Order Service:
   a. BEGIN transaction
   b. Validate symbol exists in quote service
   c. Check user buying_power >= quantity * ask_price (FOR UPDATE lock)
   d. INSERT order with status='pending'
   e. UPDATE users SET buying_power -= estimated_cost
   f. COMMIT
4. Market order executes immediately:
   a. BEGIN transaction
   b. Get current ask price from quote service
   c. INSERT execution record
   d. UPDATE order: status='filled', filled_quantity, avg_fill_price
   e. UPSERT position: add shares, recalculate avg_cost_basis
   f. Adjust buying_power for actual vs estimated cost
   g. COMMIT
5. Return order with execution details
```

### Order Placement Flow (Limit Order)

```
1-3. Same as market order
4. Order remains pending (no immediate execution)
5. Background limit order matcher runs every 2 seconds:
   a. SELECT orders WHERE status IN ('pending','submitted','partial') AND order_type='limit'
   b. For each order, check if current price meets limit condition:
      - Buy: ask <= limit_price
      - Sell: bid >= limit_price
   c. If condition met, execute using fillOrder() flow
```

### Authentication Flow

```
1. Client: POST /api/auth/login { email, password }
2. Server validates credentials against bcrypt hash
3. Generate UUID session token
4. INSERT session with 24-hour expiration
5. Return token + user profile
6. Client stores token, sends as Authorization: Bearer <token>
7. Auth middleware validates token on protected routes
```

## Data Model

### Database Schema (PostgreSQL)

```sql
-- Users: Authentication and account state
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,          -- bcrypt hash, 10 rounds
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    account_status VARCHAR(20) DEFAULT 'active',  -- active|suspended|closed
    buying_power DECIMAL(14,2) DEFAULT 10000.00,  -- Available cash
    role VARCHAR(20) DEFAULT 'user',              -- user|admin
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Positions: Current stock holdings per user
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(10) NOT NULL,
    quantity DECIMAL(14,6) NOT NULL DEFAULT 0,
    avg_cost_basis DECIMAL(14,4) NOT NULL,        -- For P&L calculations
    reserved_quantity DECIMAL(14,6) DEFAULT 0,    -- Locked for pending sells
    UNIQUE(user_id, symbol)
);

-- Orders: Trade orders with full lifecycle tracking
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    symbol VARCHAR(10) NOT NULL,
    side VARCHAR(4) NOT NULL,                     -- buy|sell
    order_type VARCHAR(20) NOT NULL,              -- market|limit|stop|stop_limit
    quantity DECIMAL(14,6) NOT NULL,
    limit_price DECIMAL(14,4),                    -- For limit orders
    stop_price DECIMAL(14,4),                     -- For stop orders
    status VARCHAR(20) DEFAULT 'pending',         -- pending|submitted|filled|partial|cancelled|rejected|expired
    filled_quantity DECIMAL(14,6) DEFAULT 0,
    avg_fill_price DECIMAL(14,4),
    time_in_force VARCHAR(10) DEFAULT 'day',      -- day|gtc|ioc|fok
    submitted_at TIMESTAMP,
    filled_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    version INTEGER DEFAULT 0                      -- Optimistic locking
);

-- Executions: Individual trade fills (orders can have multiple)
CREATE TABLE executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id),
    quantity DECIMAL(14,6) NOT NULL,
    price DECIMAL(14,4) NOT NULL,
    exchange VARCHAR(20) DEFAULT 'SIMULATOR',
    executed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Sessions: Token-based authentication
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    token VARCHAR(255) UNIQUE NOT NULL,           -- UUID token
    expires_at TIMESTAMP NOT NULL,                -- 24-hour default
    created_at TIMESTAMP DEFAULT NOW()
);

-- Watchlists and alerts
CREATE TABLE watchlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(100) NOT NULL DEFAULT 'My Watchlist',
    UNIQUE(user_id, name)
);

CREATE TABLE watchlist_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    watchlist_id UUID NOT NULL REFERENCES watchlists(id),
    symbol VARCHAR(10) NOT NULL,
    UNIQUE(watchlist_id, symbol)
);

CREATE TABLE price_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    symbol VARCHAR(10) NOT NULL,
    target_price DECIMAL(14,4) NOT NULL,
    condition VARCHAR(10) NOT NULL,               -- above|below
    triggered BOOLEAN DEFAULT FALSE,
    triggered_at TIMESTAMP
);
```

### Key Indexes

```sql
CREATE INDEX idx_orders_user_status ON orders(user_id, status);  -- User's active orders
CREATE INDEX idx_orders_symbol ON orders(symbol);                 -- Order matching by symbol
CREATE INDEX idx_positions_user_id ON positions(user_id);         -- Portfolio lookup
CREATE INDEX idx_sessions_token ON sessions(token);               -- Token validation
CREATE INDEX idx_price_alerts_active ON price_alerts(symbol) WHERE NOT triggered;
```

### Redis Data Structures

| Key Pattern | Type | Purpose | TTL |
|-------------|------|---------|-----|
| `quote:<SYMBOL>` | Hash | Current quote data | None (overwritten each second) |
| `session:<token>` | String | Optional session cache | 24 hours |

**Pub/Sub Channels:**
- `quote_updates`: All quote changes (20 quotes/second)

## Caching Strategy

### Quote Caching (Write-Through)

```
QuoteService.start():
  every 1 second:
    for each symbol:
      quote = simulatePriceMovement(currentQuote)
      currentPrices.set(symbol, quote)           // In-memory cache
      redis.hset(`quote:${symbol}`, quote)       // Redis cache
      redis.publish('quote_updates', quotes)     // Pub/sub
```

- **Pattern**: Write-through (memory + Redis updated together)
- **Consistency**: Strong within single process; eventual across processes
- **Invalidation**: Overwritten every second (no explicit invalidation needed)

### Session Caching (Cache-Aside, Optional Enhancement)

Currently sessions are validated against PostgreSQL on each request. For higher scale:

```
// Proposed enhancement (not implemented)
authMiddleware():
  cached = redis.get(`session:${token}`)
  if cached:
    return JSON.parse(cached)
  user = postgres.query(...)
  if user:
    redis.setex(`session:${token}`, 3600, JSON.stringify(user))
  return user
```

- **Pattern**: Cache-aside with 1-hour TTL
- **Invalidation**: On logout, delete from Redis and PostgreSQL
- **Trade-off**: Adds complexity; not needed at local dev scale

## API Design

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | No | Login with email/password |
| POST | `/api/auth/register` | No | Create new account |
| POST | `/api/auth/logout` | Yes | Invalidate session |
| GET | `/api/quotes/:symbol` | No | Get single quote |
| GET | `/api/quotes` | No | Get all quotes |
| GET | `/api/quotes/stocks` | No | List available symbols |
| POST | `/api/orders` | Yes | Place new order |
| GET | `/api/orders` | Yes | List user's orders |
| GET | `/api/orders/:id` | Yes | Get order details |
| DELETE | `/api/orders/:id` | Yes | Cancel order |
| GET | `/api/portfolio` | Yes | Get portfolio summary |
| GET | `/api/portfolio/positions` | Yes | List positions |
| GET | `/api/watchlists` | Yes | List watchlists |
| POST | `/api/watchlists` | Yes | Create watchlist |
| POST | `/api/watchlists/:id/items` | Yes | Add symbol to watchlist |
| DELETE | `/api/watchlists/:id/items/:symbol` | Yes | Remove symbol |

### WebSocket Protocol

**Connection**: `ws://localhost:3000/ws?token=<session-token>`

**Messages (Client to Server):**
```json
{ "type": "subscribe", "symbols": ["AAPL", "GOOGL"] }
{ "type": "unsubscribe", "symbols": ["AAPL"] }
{ "type": "subscribe_all" }
{ "type": "unsubscribe_all" }
{ "type": "ping" }
```

**Messages (Server to Client):**
```json
{ "type": "connected", "data": { "authenticated": true } }
{ "type": "quotes", "data": [{ "symbol": "AAPL", "last": 178.50, ... }] }
{ "type": "pong" }
{ "type": "alert", "data": { "symbol": "AAPL", "triggered": true } }
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + Vite + TypeScript | Fast dev experience, type safety |
| **State Management** | Zustand | Simple, minimal boilerplate |
| **Routing** | TanStack Router | Type-safe routing |
| **Styling** | Tailwind CSS | Rapid UI development |
| **Backend Runtime** | Node.js 20 + TypeScript | Async I/O, shared types with frontend |
| **HTTP Framework** | Express.js | Mature, well-documented |
| **WebSocket** | ws library | Native WebSocket implementation |
| **Primary Database** | PostgreSQL 16 | ACID transactions for financial data |
| **Cache/Pub-Sub** | Redis 7 | Sub-millisecond reads, pub/sub for quotes |
| **Password Hashing** | bcrypt | Industry standard, 10 rounds |
| **Containerization** | Docker Compose | One-command local setup |

## Security Considerations

### Authentication

| Control | Implementation | Notes |
|---------|---------------|-------|
| **Password Storage** | bcrypt with 10 rounds | ~100ms hash time per password |
| **Session Tokens** | UUID v4 (122 bits entropy) | Stored in database, not JWT |
| **Session Expiry** | 24 hours | Configurable via `config.session.expiresInHours` |
| **Token Transmission** | Bearer header over HTTPS | Local dev uses HTTP; production requires TLS |

### Authorization

| Role | Capabilities |
|------|-------------|
| **user** | Trade, view own portfolio/orders, manage watchlists |
| **admin** | All user capabilities + account management (not implemented) |

```typescript
// Role-based middleware
export function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
```

### Input Validation

- Symbol validation: Must exist in quote service
- Quantity validation: Must be positive number
- Order type validation: Database CHECK constraints
- SQL injection: Parameterized queries throughout

### Rate Limiting (Not Implemented)

For production, add:
```typescript
// Example with express-rate-limit
app.use('/api/orders', rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,               // 60 orders/minute
  message: 'Too many orders, please slow down'
}));
```

## Observability

### Health Checks

```
GET /health
{
  "status": "healthy",
  "database": "connected",
  "redis": "connected",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Logging (Current)

Console logging with structured context:
```
Quote service started with 1000ms interval
Limit order matcher started
Connected to Redis
Filled order abc-123 at $178.50
```

### Metrics (Proposed Enhancement)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, path, status | Request volume |
| `http_request_duration_ms` | Histogram | method, path | Latency distribution |
| `websocket_connections` | Gauge | authenticated | Connection count |
| `orders_placed_total` | Counter | side, order_type, status | Order activity |
| `quote_updates_total` | Counter | - | Quote service health |
| `postgres_pool_size` | Gauge | state (idle/busy) | Connection pool health |

**Implementation with prom-client:**
```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status']
});

app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestsTotal.inc({ method: req.method, path: req.route?.path, status: res.statusCode });
  });
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

### Tracing (Proposed Enhancement)

For distributed tracing with OpenTelemetry:
```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('robinhood-backend');

async function placeOrder(userId, request) {
  return tracer.startActiveSpan('placeOrder', async (span) => {
    span.setAttribute('user.id', userId);
    span.setAttribute('order.symbol', request.symbol);
    try {
      const result = await orderService.placeOrder(userId, request);
      span.setAttribute('order.id', result.order.id);
      return result;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### Dashboards (Proposed)

**Grafana Dashboard Panels:**
1. Request rate by endpoint (line chart)
2. P95 latency by endpoint (line chart)
3. Error rate percentage (stat panel with thresholds)
4. Active WebSocket connections (gauge)
5. Order fill rate (pie chart: filled vs cancelled)
6. Database connection pool utilization (gauge)

## Failure Handling

### Database Transaction Integrity

All financial operations use explicit transactions with rollback:

```typescript
async placeOrder(userId, request) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate and reserve funds
    await client.query(
      'SELECT buying_power FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    // Create order and update buying power
    await client.query('INSERT INTO orders ...');
    await client.query('UPDATE users SET buying_power = ...');

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

### Optimistic Locking for Concurrent Updates

```sql
-- orders table has version column
UPDATE orders SET status = 'filled', version = version + 1
WHERE id = $1 AND version = $2
RETURNING *;
-- If no rows returned, another process updated first -> retry or fail
```

### Retry Strategy

| Operation | Retries | Backoff | Notes |
|-----------|---------|---------|-------|
| Redis connection | Unlimited | Exponential (50ms to 2s) | Critical for quote service |
| Database query | 0 | - | Transactions should not retry (risk of double execution) |
| WebSocket reconnect | Client-side | Exponential | Frontend handles reconnection |

```typescript
// Redis retry configuration
const redis = new Redis({
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;  // Return milliseconds to wait before retry
  }
});
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');

  // Stop accepting new connections
  quoteService.stop();
  orderService.stopLimitOrderMatcher();
  priceAlertService.stopAlertChecker();

  // Close HTTP server (waits for active requests)
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
```

### WebSocket Heartbeat

```typescript
// Server pings every 30 seconds
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();  // Dead connection, clean up
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

ws.on('pong', () => {
  ws.isAlive = true;  // Client responded, connection healthy
});
```

### Disaster Recovery (Production Considerations)

| Scenario | Local Dev Impact | Production Mitigation |
|----------|-----------------|----------------------|
| PostgreSQL down | Service unavailable | Primary + sync replica with automatic failover |
| Redis down | Quotes stop updating | Redis Sentinel or Cluster mode |
| Server crash | Service restarts | Multiple instances behind load balancer |
| Data corruption | Re-run init.sql | Point-in-time recovery from WAL |

## Scalability Considerations

### Current Bottlenecks (Local Dev)

1. **Single PostgreSQL instance**: All writes go to one node
2. **In-memory quote storage**: Not shared across processes
3. **Single WebSocket server**: No horizontal scaling for connections

### Scaling Path (Production)

| Component | Scale Strategy |
|-----------|---------------|
| **API Servers** | Horizontal scaling behind load balancer; stateless design |
| **WebSocket** | Sticky sessions + Redis pub/sub for cross-instance messaging |
| **PostgreSQL** | Read replicas for portfolio/order queries; write to primary |
| **Redis** | Cluster mode for quote distribution across processes |
| **Order Matching** | Single leader process with distributed lock (Redis SETNX) |

### Local Multi-Instance Testing

```bash
# Run 3 API instances on different ports
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003

# All share same PostgreSQL and Redis
# WebSocket connections work with any instance (Redis pub/sub syncs quotes)
```

## Cost Trade-offs

### Local Development (This Project)

| Resource | Cost | Notes |
|----------|------|-------|
| PostgreSQL container | ~50MB RAM | Alpine image |
| Redis container | ~10MB RAM | Alpine image |
| Node.js backend | ~100MB RAM | Single process |
| React dev server | ~200MB RAM | Vite hot reload |
| **Total** | ~400MB RAM | Runs on any modern laptop |

### Production Estimates (If Deployed)

| Component | Small (100 users) | Medium (10K users) | Notes |
|-----------|-------------------|-------------------|-------|
| PostgreSQL | db.t3.micro ($15/mo) | db.r6g.large ($200/mo) | RDS with Multi-AZ |
| Redis | cache.t3.micro ($12/mo) | cache.r6g.large ($150/mo) | ElastiCache |
| API Servers | 2x t3.small ($30/mo) | 4x t3.medium ($120/mo) | ECS Fargate |
| Load Balancer | ALB ($20/mo) | ALB ($50/mo) | Application Load Balancer |
| **Monthly Total** | ~$80/mo | ~$520/mo | AWS pricing |

### Cost Optimization Strategies

1. **Reserved instances**: 30-50% savings with 1-year commitment
2. **Spot instances**: For non-critical background workers (limit order matcher)
3. **Connection pooling**: Reduce database connections with PgBouncer
4. **Quote throttling**: Reduce update frequency during low activity periods
5. **Session caching**: Reduce database reads with Redis session cache

## Trade-offs and Alternatives

### Real-Time Quotes: WebSocket vs SSE vs Polling

| Approach | Latency | Complexity | Browser Support | Decision |
|----------|---------|------------|-----------------|----------|
| WebSocket | Lowest | Higher | All modern | **Selected** |
| Server-Sent Events | Low | Medium | All modern | Good alternative |
| Long Polling | Medium | Low | Universal | Fallback option |

**Rationale**: WebSocket provides bidirectional communication (needed for subscription management) and lowest latency. SSE would work for one-way streaming but doesn't support client-to-server messages elegantly.

### Session Storage: Database vs Redis vs JWT

| Approach | Revocation | Scalability | Complexity | Decision |
|----------|------------|-------------|------------|----------|
| PostgreSQL sessions | Instant | Medium | Low | **Selected** |
| Redis sessions | Instant | High | Medium | Future enhancement |
| JWT tokens | Difficult | High | Medium | Not selected |

**Rationale**: Database sessions provide simple revocation (delete row) and avoid JWT complexity (refresh tokens, blacklists). Redis sessions would improve performance at scale.

### Order Execution: Synchronous vs Queue-Based

| Approach | Latency | Complexity | Reliability | Decision |
|----------|---------|------------|-------------|----------|
| Synchronous | Lowest | Low | Medium | **Selected for market orders** |
| Queue-based | Higher | Higher | Higher | Future enhancement |

**Rationale**: Synchronous execution provides immediate feedback for market orders. Queue-based would be necessary at scale for rate limiting and retry handling.

## Implementation Notes

This section documents the critical reliability and compliance features implemented in the trading platform, explaining **why** each feature is essential for a financial system.

### Idempotency for Trade Execution

**Why it's critical**: In financial systems, duplicate trade execution can cause catastrophic losses.

**Problem scenarios without idempotency:**
1. **Network timeout with success**: Client sends buy order, server executes it, but network drops before response. Client retries, server executes again = user buys 2x shares
2. **Load balancer retry**: ALB times out at 30s, retries to another server = duplicate execution
3. **User double-click**: User clicks "Buy" twice quickly = two separate orders
4. **Mobile network**: Flaky cellular connection causes automatic retries

**Implementation:**
```typescript
// Client sends unique idempotency key with order
POST /api/orders
X-Idempotency-Key: user-generated-uuid

// Server flow:
1. Check Redis for existing key
2. If found with status=completed, return cached result
3. If found with status=pending, return 409 Conflict
4. If not found, acquire lock with SETNX
5. Execute order
6. Store result with 24-hour TTL
7. Return result
```

**Trade-off**: Requires Redis availability for idempotency checks. We fail open (allow order) if Redis is down to maintain availability.

### Audit Logging for SEC Compliance

**Why it's required**: SEC Rule 17a-4 and FINRA Rule 4511 mandate broker-dealers maintain complete records of all securities transactions.

**Regulatory requirements:**
- **Record retention**: 6 years for most records (3 years readily accessible)
- **Immutability**: Records must be in non-rewritable, non-erasable format (WORM)
- **Completeness**: Every order placement, execution, modification, and cancellation
- **Accessibility**: Records must be immediately available for regulatory examination

**What we log:**
| Event | Data Captured |
|-------|---------------|
| ORDER_PLACED | User, symbol, side, type, quantity, price, timestamp, IP, user agent |
| ORDER_FILLED | Execution price, quantity, total value, partial/full fill |
| ORDER_CANCELLED | Reason, remaining quantity, user who cancelled |
| ORDER_REJECTED | Rejection reason (insufficient funds, invalid symbol, etc.) |

**Implementation:**
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(20) NOT NULL,
  entity_id UUID NOT NULL,
  details JSONB NOT NULL,       -- Full transaction context
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(100),      -- For distributed tracing
  idempotency_key VARCHAR(100), -- Links to order idempotency
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**Production considerations:**
- Use append-only table or write to immutable storage (S3 Glacier, WORM-enabled storage)
- Implement audit log archival for 6-year retention
- Consider separate audit database with different access controls
- Regular integrity verification (checksums, blockchain anchoring for tamper evidence)

### Circuit Breakers for External Dependencies

**Why it's essential**: Market data providers and execution venues can become unavailable. Without circuit breakers, the entire trading system fails.

**Failure scenarios protected:**
1. **Market data provider outage**: Quote API returns 503 for 5 minutes
2. **Execution venue timeout**: Order execution takes 30+ seconds
3. **Redis unavailability**: Cache layer goes down
4. **Database overload**: Connection pool exhausted

**Circuit breaker states:**
```
CLOSED (Normal)
    |
    | Failure rate > 50%
    v
  OPEN (Fast fail)
    |
    | After 30 seconds
    v
HALF-OPEN (Test)
    |
    | Success -> CLOSED
    | Failure -> OPEN
```

**Implementation:**
```typescript
// Quote service with circuit breaker
this.marketDataBreaker = createCircuitBreaker(fetchMarketData, {
  name: 'market-data',
  timeout: 5000,              // 5 second timeout per call
  errorThresholdPercentage: 50,  // Open after 50% failures
  volumeThreshold: 10,        // Need 10 requests to calculate
  resetTimeout: 30000,        // 30 seconds before half-open
});

// Fallback: return last known quote
this.marketDataBreaker.fallback((symbol) => {
  return lastKnownQuotes.get(symbol);
});
```

**Trade-offs:**
- **Stale data vs no data**: When circuit opens, we serve cached quotes. Users see slightly stale prices but can still trade.
- **Fast failure vs retry**: Open circuit fails immediately rather than waiting for timeout. Improves user experience during outages.
- **Recovery detection**: Half-open state tests if dependency recovered before fully closing circuit.

### Real-Time Metrics for Order Execution Optimization

**Why metrics matter**: You cannot optimize what you cannot measure. In trading, milliseconds matter.

**Key metrics for trading platforms:**
| Metric | Purpose | SLO Target |
|--------|---------|------------|
| `order_execution_duration_ms` | End-to-end order latency | p99 < 500ms |
| `orders_placed_total` | Order volume by type | Monitor for anomalies |
| `orders_rejected_total` | Failed orders by reason | < 1% rejection rate |
| `quote_updates_total` | Market data freshness | 20 updates/second |
| `circuit_breaker_state` | Dependency health | 0 (closed) = healthy |

**How metrics enable optimization:**
1. **Identify bottlenecks**: `order_execution_duration_ms` histogram shows where time is spent
2. **Capacity planning**: `orders_placed_total` rate predicts infrastructure needs
3. **Anomaly detection**: Sudden spike in `orders_rejected_total` indicates systemic issue
4. **SLO monitoring**: Alert when p99 latency exceeds 500ms

**Prometheus metrics exposed:**
```
# HELP orders_placed_total Total number of orders placed
# TYPE orders_placed_total counter
orders_placed_total{side="buy",order_type="market"} 1234
orders_placed_total{side="sell",order_type="limit"} 567

# HELP order_execution_duration_ms Order execution duration
# TYPE order_execution_duration_ms histogram
order_execution_duration_ms_bucket{order_type="market",le="50"} 890
order_execution_duration_ms_bucket{order_type="market",le="100"} 1150
order_execution_duration_ms_bucket{order_type="market",le="500"} 1230

# HELP circuit_breaker_state Circuit breaker state
# TYPE circuit_breaker_state gauge
circuit_breaker_state{name="market-data"} 0
circuit_breaker_state{name="redis-publish"} 0
```

**Grafana dashboard panels:**
1. Order execution latency (p50, p95, p99 over time)
2. Orders per second by type (stacked area chart)
3. Rejection rate percentage (with threshold alerts)
4. Circuit breaker states (traffic light visualization)
5. Quote update rate (line chart with expected baseline)

### Structured JSON Logging

**Why structured logs**: Traditional text logs are impossible to query at scale. JSON logs enable:
- Full-text search across all fields
- Aggregations (orders per user, errors by type)
- Correlation across distributed services
- Automated anomaly detection

**Log format:**
```json
{
  "level": "info",
  "time": 1705312800000,
  "service": "robinhood-backend",
  "requestId": "abc-123",
  "userId": "user-456",
  "orderId": "order-789",
  "symbol": "AAPL",
  "action": "order_placed",
  "duration": 45,
  "msg": "Order placed successfully"
}
```

**Key correlation fields:**
- `requestId`: Traces request across all log entries
- `userId`: All actions by a specific user
- `orderId`: Full lifecycle of a single order

## Future Optimizations

### Completed (Phase 1: Enhanced Observability)
- [x] Add Prometheus metrics endpoint (`/metrics`)
- [x] Implement structured JSON logging (pino)
- [x] Add request correlation IDs (X-Request-ID header)
- [ ] Create Grafana dashboards

### Completed (Phase 3: Reliability)
- [x] Implement circuit breaker for external dependencies
- [x] Add idempotency keys for order placement
- [ ] Add rate limiting on order endpoints
- [ ] Create database backup/restore procedures

### Completed (Session Caching)
- [x] Add Redis session caching (in auth middleware)

### Phase 2: Performance (Remaining)
- [ ] Implement database connection pooling with PgBouncer
- [ ] Add database query result caching for portfolio summaries
- [ ] Compress WebSocket messages

### Phase 4: Features
- [ ] Admin dashboard for account management
- [ ] Historical price charts (store quote history)
- [ ] Order history export
- [ ] Email notifications for price alerts
