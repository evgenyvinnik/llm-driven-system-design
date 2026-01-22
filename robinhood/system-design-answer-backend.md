# Robinhood - Stock Trading Platform - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

"Design a stock trading platform like Robinhood that enables users to view real-time stock quotes, place orders, and track their portfolio. I'll focus on the backend architecture: market data ingestion, order execution engine, database design, caching strategies, and reliability patterns."

---

## 1. Requirements Clarification (3 minutes)

### Functional Requirements (Backend Scope)
1. **Market Data Ingestion** - Consume and distribute real-time quotes from exchange feeds
2. **Order Execution Engine** - Process buy/sell orders with ACID guarantees
3. **Portfolio Service** - Track positions, calculate P&L, manage buying power
4. **Alerting System** - Monitor price thresholds and trigger notifications
5. **Session Management** - Token-based authentication with secure session storage

### Non-Functional Requirements
| Requirement | Target | Backend Implication |
|-------------|--------|---------------------|
| Quote Latency | < 100ms from source | Kafka streaming, Redis caching |
| Order Latency | p95 < 500ms | Optimized transactions, connection pooling |
| Availability | 99.99% during market hours | Circuit breakers, graceful degradation |
| Consistency | Strong for orders | PostgreSQL transactions, row-level locking |
| Throughput | 3,000 orders/second at market open | Horizontal scaling, queue-based processing |

### Scale Estimates
- 15M registered users, 2M DAU during market hours
- 10,000 tradeable securities with 1 update/second each
- 4M orders/day, concentrated at market open (9:30 AM ET)
- Order history: 2 GB/day, 730 GB/year

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MARKET DATA PROVIDERS                              │
│                    (NYSE, NASDAQ, IEX - UDP/TCP Feeds)                      │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │     Feed Handler Pool     │
                    │  (Parse, Normalize, Emit) │
                    └─────────────┬─────────────┘
                                  │
              ┌───────────────────▼───────────────────┐
              │              Kafka Cluster            │
              │     quotes topic (partitioned by      │
              │           symbol hash)                │
              └───────┬───────────┬───────────┬───────┘
                      │           │           │
         ┌────────────▼──┐  ┌─────▼─────┐  ┌──▼────────────┐
         │  Quote Cache  │  │  Alert    │  │  Historical   │
         │   Consumer    │  │  Checker  │  │  Data Writer  │
         └───────┬───────┘  └───────────┘  └───────────────┘
                 │
         ┌───────▼───────┐
         │     Redis     │
         │ (Quote Cache) │
         └───────┬───────┘
                 │ Pub/Sub
    ┌────────────┼────────────┐
    │            │            │
┌───▼───┐   ┌────▼────┐   ┌───▼───┐
│ WS    │   │ WS      │   │ WS    │
│Server1│   │ Server2 │   │Server3│
└───────┘   └─────────┘   └───────┘

                    ┌─────────────────────────────────────┐
                    │           API Gateway               │
                    │  (Auth, Rate Limit, Load Balance)   │
                    └───────────────┬─────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼───────┐         ┌─────────▼─────────┐       ┌─────────▼─────────┐
│ Order Service │         │ Portfolio Service │       │ Watchlist Service │
│               │         │                   │       │                   │
└───────┬───────┘         └─────────┬─────────┘       └─────────┬─────────┘
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │         PostgreSQL            │
                    │   (Orders, Positions, Users)  │
                    └───────────────────────────────┘
```

---

## 3. Deep Dive: Market Data Pipeline (10 minutes)

### Feed Handler Architecture

The feed handler connects to exchange data feeds, parses proprietary protocols, and publishes normalized quotes to Kafka.

```typescript
class FeedHandler {
  private kafkaProducer: KafkaProducer;
  private circuitBreaker: CircuitBreaker;

  async connectToExchange(exchangeUrl: string): Promise<void> {
    const socket = await createExchangeConnection(exchangeUrl);

    socket.on('data', async (rawData: Buffer) => {
      const quote = this.parseExchangeFormat(rawData);

      // Partition by symbol for ordered processing
      await this.circuitBreaker.fire(() =>
        this.kafkaProducer.send({
          topic: 'quotes',
          messages: [{
            key: quote.symbol,
            value: JSON.stringify(quote),
            timestamp: Date.now().toString()
          }]
        })
      );
    });
  }

  private parseExchangeFormat(data: Buffer): Quote {
    // FIX protocol or binary format parsing
    return {
      symbol: data.slice(0, 10).toString().trim(),
      bid: parseFloat(data.slice(10, 20).toString()),
      ask: parseFloat(data.slice(20, 30).toString()),
      last: parseFloat(data.slice(30, 40).toString()),
      volume: parseInt(data.slice(40, 50).toString()),
      timestamp: Date.now()
    };
  }
}
```

### Quote Cache Consumer

Consumes from Kafka and updates Redis cache with latest prices.

```typescript
class QuoteCacheConsumer {
  private redis: Redis;
  private batchBuffer: Map<string, Quote> = new Map();
  private flushInterval = 50; // 50ms batching

  async run(): Promise<void> {
    const consumer = kafka.consumer({ groupId: 'quote-cache' });
    await consumer.subscribe({ topic: 'quotes' });

    // Batch flush timer
    setInterval(() => this.flushBatch(), this.flushInterval);

    await consumer.run({
      eachMessage: async ({ message }) => {
        const quote = JSON.parse(message.value.toString());
        // Buffer updates - last write wins per symbol
        this.batchBuffer.set(quote.symbol, quote);
      }
    });
  }

  private async flushBatch(): Promise<void> {
    if (this.batchBuffer.size === 0) return;

    const pipeline = this.redis.pipeline();
    const quotesArray: Quote[] = [];

    for (const [symbol, quote] of this.batchBuffer) {
      pipeline.hset(`quote:${symbol}`, {
        bid: quote.bid.toString(),
        ask: quote.ask.toString(),
        last: quote.last.toString(),
        volume: quote.volume.toString(),
        timestamp: quote.timestamp.toString()
      });
      quotesArray.push(quote);
    }

    // Publish batch for WebSocket servers
    pipeline.publish('quote_updates', JSON.stringify(quotesArray));

    await pipeline.exec();
    this.batchBuffer.clear();
  }
}
```

### Redis Pub/Sub for WebSocket Distribution

Each WebSocket server subscribes to Redis and filters quotes by client subscriptions.

```typescript
class WebSocketQuoteDistributor {
  private subscriptions: Map<string, Set<WebSocket>> = new Map(); // symbol -> clients
  private redis: Redis;

  async startDistributionLoop(): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.subscribe('quote_updates');

    subscriber.on('message', (channel, message) => {
      const quotes: Quote[] = JSON.parse(message);

      // Group quotes by subscribing clients
      const clientUpdates: Map<WebSocket, Quote[]> = new Map();

      for (const quote of quotes) {
        const subscribers = this.subscriptions.get(quote.symbol);
        if (!subscribers) continue;

        for (const ws of subscribers) {
          if (!clientUpdates.has(ws)) {
            clientUpdates.set(ws, []);
          }
          clientUpdates.get(ws)!.push(quote);
        }
      }

      // Send batched updates to each client
      for (const [ws, clientQuotes] of clientUpdates) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'quote_batch', data: clientQuotes }));
        }
      }
    });
  }
}
```

---

## 4. Deep Dive: Order Execution Engine (10 minutes)

### Order State Machine

```
┌─────────┐     ┌───────────┐     ┌────────────┐     ┌────────┐
│ Created │────▶│ Validated │────▶│ Submitted  │────▶│ Filled │
└─────────┘     └───────────┘     └────────────┘     └────────┘
     │               │                  │                │
     ▼               ▼                  ▼                ▼
┌─────────┐     ┌───────────┐     ┌────────────┐     ┌────────┐
│Rejected │     │ Rejected  │     │ Cancelled  │     │Partial │
└─────────┘     └───────────┘     └────────────┘     └────────┘
```

### Transactional Order Placement with Idempotency

```typescript
class OrderService {
  private redis: Redis;
  private pool: Pool;
  private metrics: PrometheusMetrics;

  async placeOrder(userId: string, request: OrderRequest, idempotencyKey: string): Promise<Order> {
    const timer = this.metrics.orderExecutionDuration.startTimer();

    // Check idempotency - prevent duplicate orders
    const existingResult = await this.redis.get(`idem:${idempotencyKey}`);
    if (existingResult) {
      const cached = JSON.parse(existingResult);
      if (cached.status === 'completed') {
        return cached.order;
      }
      throw new ConflictError('Order already in progress');
    }

    // Acquire idempotency lock
    const lockAcquired = await this.redis.set(
      `idem:${idempotencyKey}`,
      JSON.stringify({ status: 'pending', timestamp: Date.now() }),
      'EX', 86400, // 24 hour TTL
      'NX'
    );
    if (!lockAcquired) {
      throw new ConflictError('Duplicate request');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Reserve funds/shares with FOR UPDATE lock
      if (request.side === 'buy') {
        const { rows } = await client.query(
          'SELECT buying_power FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );
        const estimatedCost = await this.estimateCost(request);
        if (rows[0].buying_power < estimatedCost) {
          throw new InsufficientFundsError();
        }
        await client.query(
          'UPDATE users SET buying_power = buying_power - $1 WHERE id = $2',
          [estimatedCost, userId]
        );
      } else {
        const { rows } = await client.query(
          `SELECT quantity, reserved_quantity FROM positions
           WHERE user_id = $1 AND symbol = $2 FOR UPDATE`,
          [userId, request.symbol]
        );
        const available = rows[0]?.quantity - (rows[0]?.reserved_quantity || 0);
        if (!available || available < request.quantity) {
          throw new InsufficientSharesError();
        }
        await client.query(
          `UPDATE positions SET reserved_quantity = reserved_quantity + $1
           WHERE user_id = $2 AND symbol = $3`,
          [request.quantity, userId, request.symbol]
        );
      }

      // Create order record
      const { rows: [order] } = await client.query(
        `INSERT INTO orders (user_id, symbol, side, order_type, quantity, limit_price, stop_price, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING *`,
        [userId, request.symbol, request.side, request.orderType,
         request.quantity, request.limitPrice, request.stopPrice]
      );

      // Audit log
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, idempotency_key, status)
         VALUES ($1, 'ORDER_PLACED', 'order', $2, $3, $4, 'success')`,
        [userId, order.id, JSON.stringify(request), idempotencyKey]
      );

      await client.query('COMMIT');

      // Store result for idempotency
      await this.redis.set(
        `idem:${idempotencyKey}`,
        JSON.stringify({ status: 'completed', order }),
        'EX', 86400
      );

      // Execute market orders immediately, queue limit orders
      if (request.orderType === 'market') {
        await this.executeMarketOrder(order);
      }

      timer({ order_type: request.orderType, side: request.side });
      return order;

    } catch (error) {
      await client.query('ROLLBACK');
      await this.redis.del(`idem:${idempotencyKey}`);
      throw error;
    } finally {
      client.release();
    }
  }
}
```

### Smart Order Routing

```typescript
class OrderRouter {
  private brokers: Map<string, BrokerInterface> = new Map([
    ['citadel', new CitadelBroker()],
    ['virtu', new VirtuBroker()],
    ['nasdaq', new NasdaqDirectBroker()]
  ]);
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  constructor() {
    // Initialize circuit breakers for each broker
    for (const [name, broker] of this.brokers) {
      this.circuitBreakers.set(name, new CircuitBreaker(broker.execute.bind(broker), {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000
      }));
    }
  }

  async routeOrder(order: Order): Promise<ExecutionResult> {
    // Get quotes from all healthy venues
    const quotes = await Promise.allSettled(
      Array.from(this.brokers.entries()).map(async ([name, broker]) => {
        const breaker = this.circuitBreakers.get(name)!;
        if (breaker.opened) return null;

        const quote = await breaker.fire(() => broker.getQuote(order.symbol));
        return { name, quote };
      })
    );

    // Filter successful quotes
    const validQuotes = quotes
      .filter((r): r is PromiseFulfilledResult<{name: string, quote: Quote}> =>
        r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    // Select best execution price
    const best = order.side === 'buy'
      ? validQuotes.reduce((a, b) => a.quote.ask < b.quote.ask ? a : b)
      : validQuotes.reduce((a, b) => a.quote.bid > b.quote.bid ? a : b);

    // Execute with selected broker
    const broker = this.brokers.get(best.name)!;
    const breaker = this.circuitBreakers.get(best.name)!;

    return breaker.fire(() => broker.execute(order));
  }
}
```

### Fill Processing with Position Updates

```typescript
async processFill(fillEvent: FillEvent): Promise<void> {
  const client = await this.pool.connect();

  try {
    await client.query('BEGIN');

    // Record execution
    await client.query(
      `INSERT INTO executions (order_id, quantity, price, exchange, executed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [fillEvent.orderId, fillEvent.quantity, fillEvent.price,
       fillEvent.exchange, fillEvent.timestamp]
    );

    // Update order with optimistic locking
    const { rows: [order] } = await client.query(
      `UPDATE orders SET
         filled_quantity = filled_quantity + $1,
         avg_fill_price = ((avg_fill_price * filled_quantity) + ($2 * $1)) / (filled_quantity + $1),
         status = CASE WHEN filled_quantity + $1 >= quantity THEN 'filled' ELSE 'partial' END,
         filled_at = CASE WHEN filled_quantity + $1 >= quantity THEN NOW() ELSE NULL END,
         version = version + 1
       WHERE id = $3 AND version = $4
       RETURNING *`,
      [fillEvent.quantity, fillEvent.price, fillEvent.orderId, fillEvent.expectedVersion]
    );

    if (!order) {
      throw new OptimisticLockError('Order modified by another process');
    }

    // Update position (UPSERT)
    if (order.side === 'buy') {
      await client.query(
        `INSERT INTO positions (user_id, symbol, quantity, avg_cost_basis)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, symbol) DO UPDATE SET
           quantity = positions.quantity + $3,
           avg_cost_basis = (positions.avg_cost_basis * positions.quantity + $4 * $3)
                           / (positions.quantity + $3)`,
        [order.user_id, order.symbol, fillEvent.quantity, fillEvent.price]
      );
    } else {
      await client.query(
        `UPDATE positions SET
           quantity = quantity - $1,
           reserved_quantity = reserved_quantity - $1
         WHERE user_id = $2 AND symbol = $3`,
        [fillEvent.quantity, order.user_id, order.symbol]
      );
    }

    // Adjust buying power
    const adjustment = order.side === 'buy'
      ? order.estimated_cost - (fillEvent.quantity * fillEvent.price) // Refund overestimate
      : fillEvent.quantity * fillEvent.price; // Credit proceeds

    await client.query(
      'UPDATE users SET buying_power = buying_power + $1 WHERE id = $2',
      [adjustment, order.user_id]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, status)
       VALUES ($1, 'ORDER_FILLED', 'order', $2, $3, 'success')`,
      [order.user_id, order.id, JSON.stringify(fillEvent)]
    );

    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## 5. Deep Dive: Database Design (5 minutes)

### Schema with Partitioning Strategy

```sql
-- Orders partitioned by created_at for query performance and archival
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    symbol VARCHAR(10) NOT NULL,
    side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type VARCHAR(20) NOT NULL,
    quantity DECIMAL(14,6) NOT NULL,
    limit_price DECIMAL(14,4),
    stop_price DECIMAL(14,4),
    status VARCHAR(20) DEFAULT 'pending',
    filled_quantity DECIMAL(14,6) DEFAULT 0,
    avg_fill_price DECIMAL(14,4),
    time_in_force VARCHAR(10) DEFAULT 'day',
    submitted_at TIMESTAMP,
    filled_at TIMESTAMP,
    version INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE orders_2024_01 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE orders_2024_02 PARTITION OF orders
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Audit logs with WORM semantics for SEC compliance
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_id UUID NOT NULL,
    details JSONB NOT NULL,
    ip_address INET,
    user_agent TEXT,
    request_id VARCHAR(100),
    idempotency_key VARCHAR(100),
    status VARCHAR(20) NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Make audit logs append-only
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
```

### Performance Indexes

```sql
-- Order lookups
CREATE INDEX idx_orders_user_status ON orders(user_id, status)
    WHERE status IN ('pending', 'submitted', 'partial');
CREATE INDEX idx_orders_symbol_pending ON orders(symbol)
    WHERE status IN ('pending', 'submitted', 'partial');

-- Portfolio queries
CREATE INDEX idx_positions_user_id ON positions(user_id);

-- Session validation (hot path)
CREATE INDEX idx_sessions_token ON sessions(token) WHERE expires_at > NOW();

-- Audit log queries (for compliance reporting)
CREATE INDEX idx_audit_user_time ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
```

---

## 6. Deep Dive: Reliability Patterns (5 minutes)

### Circuit Breaker Implementation

```typescript
import CircuitBreaker from 'opossum';

function createServiceBreaker<T>(
  fn: (...args: any[]) => Promise<T>,
  options: { name: string; fallback?: (...args: any[]) => T }
): CircuitBreaker {
  const breaker = new CircuitBreaker(fn, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    volumeThreshold: 10,
    resetTimeout: 30000,
    name: options.name
  });

  // Metrics integration
  breaker.on('success', () => circuitBreakerMetric.set({ name: options.name }, 0));
  breaker.on('open', () => circuitBreakerMetric.set({ name: options.name }, 1));
  breaker.on('halfOpen', () => circuitBreakerMetric.set({ name: options.name }, 0.5));

  if (options.fallback) {
    breaker.fallback(options.fallback);
  }

  return breaker;
}

// Usage for market data
const marketDataBreaker = createServiceBreaker(
  (symbol: string) => marketDataProvider.getQuote(symbol),
  {
    name: 'market-data',
    fallback: (symbol) => redisCache.get(`quote:${symbol}`) // Stale data fallback
  }
);
```

### Graceful Shutdown

```typescript
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close();
  wsServer.close();

  // Stop background workers
  quoteService.stop();
  limitOrderMatcher.stop();
  alertChecker.stop();

  // Wait for in-flight requests (max 30 seconds)
  await Promise.race([
    waitForInflightRequests(),
    new Promise(resolve => setTimeout(resolve, 30000))
  ]);

  // Close database connections
  await pool.end();
  await redis.quit();

  console.log('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### End-of-Day Processing

```typescript
async function endOfDayProcessing(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Expire unfilled day orders
    await client.query(`
      UPDATE orders SET status = 'expired', version = version + 1
      WHERE status IN ('pending', 'submitted', 'partial')
        AND time_in_force = 'day'
        AND DATE(created_at) < CURRENT_DATE
    `);

    // Release reserved buying power from expired orders
    await client.query(`
      UPDATE users u SET buying_power = u.buying_power + expired.reserved
      FROM (
        SELECT user_id, SUM(estimated_cost - (filled_quantity * avg_fill_price)) as reserved
        FROM orders
        WHERE status = 'expired' AND side = 'buy'
        GROUP BY user_id
      ) expired
      WHERE u.id = expired.user_id
    `);

    // Archive old orders to cold storage
    await client.query(`
      INSERT INTO orders_archive SELECT * FROM orders
      WHERE created_at < NOW() - INTERVAL '90 days'
    `);
    await client.query(`
      DELETE FROM orders WHERE created_at < NOW() - INTERVAL '90 days'
    `);

    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## 7. Trade-offs Summary

| Decision | Chose | Alternative | Trade-off |
|----------|-------|-------------|-----------|
| Message Queue | Kafka | RabbitMQ | Higher throughput vs simpler operations |
| Quote Cache | Redis | In-memory | Shared across processes vs lower latency |
| Order Storage | PostgreSQL | Event sourcing | Simpler queries vs complete audit trail |
| Session Storage | PostgreSQL + Redis | JWT | Easy revocation vs stateless scaling |
| Order Routing | Smart routing | Single venue | Best execution vs simplicity |
| Idempotency | Redis + 24h TTL | Database | Fast lookup vs guaranteed durability |

---

## 8. Future Enhancements

1. **Event Sourcing for Orders** - Complete audit trail with replay capability
2. **CQRS Pattern** - Separate read/write models for portfolio queries
3. **Kafka Streams** - Real-time analytics on order flow
4. **Read Replicas** - Scale portfolio queries independently
5. **PgBouncer** - Connection pooling for higher concurrency
6. **Order Book Simulation** - Local matching engine for limit orders
