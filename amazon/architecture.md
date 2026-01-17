# Design Amazon - Architecture

## System Overview

Amazon is an e-commerce platform handling massive product catalogs, real-time inventory, and complex order fulfillment. Core challenges involve inventory consistency, product search, and recommendation systems.

**Learning Goals:**
- Design inventory systems that prevent overselling
- Build product search with faceted filtering
- Implement "also bought" recommendations
- Handle order state machines

---

## Requirements

### Functional Requirements

1. **Catalog**: Browse and search products
2. **Cart**: Add items, manage quantities
3. **Checkout**: Purchase with payment
4. **Orders**: Track order status
5. **Recommendations**: Personalized suggestions

### Non-Functional Requirements

- **Availability**: 99.99% for browsing
- **Consistency**: Strong for inventory (no overselling)
- **Latency**: < 100ms for search
- **Scale**: 100M products, 1M orders/day

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Layer                                 │
│        React + Product pages + Cart + Checkout                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │ Cart Service  │    │ Order Service │
│               │    │               │    │               │
│ - Products    │    │ - Add/remove  │    │ - Checkout    │
│ - Categories  │    │ - Quantities  │    │ - Fulfillment │
│ - Search      │    │ - Inventory   │    │ - Tracking    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────┬─────────────┬─────────────┬───────────────────────┤
│ PostgreSQL  │Elasticsearch│   Valkey    │     Kafka             │
│ - Products  │ - Search    │ - Cart      │ - Order events        │
│ - Orders    │ - Facets    │ - Sessions  │ - Inventory updates   │
│ - Inventory │             │ - Inventory │                       │
└─────────────┴─────────────┴─────────────┴───────────────────────┘
```

---

## Core Components

### 1. Inventory Management

**Challenge**: Prevent overselling during high-concurrency checkout

**Approach: Optimistic Locking with Reserved Inventory**
```javascript
async function addToCart(userId, productId, quantity) {
  return await db.transaction(async (trx) => {
    // Check available inventory
    const product = await trx('inventory')
      .where({ product_id: productId })
      .first()

    const available = product.quantity - product.reserved
    if (available < quantity) {
      throw new Error('Insufficient inventory')
    }

    // Reserve inventory
    await trx('inventory')
      .where({ product_id: productId })
      .increment('reserved', quantity)

    // Add to cart with expiry
    await trx('cart_items').insert({
      user_id: userId,
      product_id: productId,
      quantity,
      reserved_until: new Date(Date.now() + 30 * 60 * 1000) // 30 min
    })
  })
}
```

**Background Job: Release Expired Reservations**
```javascript
async function releaseExpiredReservations() {
  const expired = await db('cart_items')
    .where('reserved_until', '<', new Date())
    .select('product_id', 'quantity')

  for (const item of expired) {
    await db('inventory')
      .where({ product_id: item.product_id })
      .decrement('reserved', item.quantity)
  }

  await db('cart_items')
    .where('reserved_until', '<', new Date())
    .delete()
}
```

### 2. Product Search

**Elasticsearch Index:**
```json
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "standard" },
      "description": { "type": "text" },
      "category": { "type": "keyword" },
      "brand": { "type": "keyword" },
      "price": { "type": "float" },
      "attributes": { "type": "nested" },
      "rating": { "type": "float" },
      "in_stock": { "type": "boolean" }
    }
  }
}
```

**Faceted Search Query:**
```javascript
async function searchProducts(query, filters, facets) {
  const body = {
    query: {
      bool: {
        must: [
          { match: { title: query } }
        ],
        filter: [
          filters.category && { term: { category: filters.category } },
          filters.priceMin && { range: { price: { gte: filters.priceMin } } },
          filters.inStock && { term: { in_stock: true } }
        ].filter(Boolean)
      }
    },
    aggs: {
      categories: { terms: { field: "category" } },
      brands: { terms: { field: "brand" } },
      price_ranges: {
        range: {
          field: "price",
          ranges: [
            { to: 25 },
            { from: 25, to: 50 },
            { from: 50, to: 100 },
            { from: 100 }
          ]
        }
      }
    }
  }

  return await es.search({ index: 'products', body })
}
```

### 3. Recommendations

**Collaborative Filtering: "Also Bought"**
```sql
-- Find products frequently bought together
SELECT p2.product_id, COUNT(*) as frequency
FROM order_items o1
JOIN order_items o2 ON o1.order_id = o2.order_id
WHERE o1.product_id = $1
  AND o2.product_id != $1
GROUP BY p2.product_id
ORDER BY frequency DESC
LIMIT 10;
```

**Precomputed Recommendations:**
```javascript
// Batch job: Update recommendations nightly
async function updateProductRecommendations() {
  const products = await db('products').select('id')

  for (const product of products) {
    const alsoBought = await db.raw(`
      SELECT o2.product_id, COUNT(*) as freq
      FROM order_items o1
      JOIN order_items o2 ON o1.order_id = o2.order_id
      WHERE o1.product_id = ?
        AND o2.product_id != ?
      GROUP BY o2.product_id
      ORDER BY freq DESC
      LIMIT 20
    `, [product.id, product.id])

    await redis.set(
      `recs:${product.id}`,
      JSON.stringify(alsoBought.rows),
      'EX', 86400
    )
  }
}
```

---

## Database Schema

```sql
-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id),
  price DECIMAL(10, 2) NOT NULL,
  images TEXT[],
  attributes JSONB,
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inventory (per warehouse)
CREATE TABLE inventory (
  product_id INTEGER REFERENCES products(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  quantity INTEGER DEFAULT 0,
  reserved INTEGER DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);

-- Shopping Cart
CREATE TABLE cart_items (
  user_id INTEGER REFERENCES users(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER DEFAULT 1,
  reserved_until TIMESTAMP,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',
  total DECIMAL(10, 2),
  shipping_address JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
  order_id INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER,
  price DECIMAL(10, 2),
  PRIMARY KEY (order_id, product_id)
);
```

---

## Key Design Decisions

### 1. Reserved Inventory Model

**Decision**: Track reserved quantity separately from available

**Rationale**:
- Prevents overselling during checkout
- Allows cart expiration without order
- Clear separation of concerns

### 2. Elasticsearch for Search

**Decision**: Separate search index from PostgreSQL

**Rationale**:
- Full-text search with relevance scoring
- Faceted filtering (aggregations)
- Better performance than LIKE queries

### 3. Precomputed Recommendations

**Decision**: Batch compute "also bought" nightly

**Rationale**:
- Expensive to compute on-demand
- Recommendations don't need real-time freshness
- Cache in Valkey for fast retrieval

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Inventory | Reserved model | Decrement on add | Prevent overselling |
| Search | Elasticsearch | PostgreSQL FTS | Performance, facets |
| Recommendations | Batch precompute | Real-time ML | Simplicity, cost |
| Cart | Database + cache | Cache only | Durability |

---

## Observability

### Metrics Collection

**Key Service Metrics (Prometheus format):**
```javascript
// Express middleware for request metrics
const promClient = require('prom-client');

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

const inventoryReservations = new promClient.Counter({
  name: 'inventory_reservations_total',
  help: 'Total inventory reservation attempts',
  labelNames: ['product_id', 'status'] // status: success, insufficient, error
});

const cartAbandonments = new promClient.Counter({
  name: 'cart_abandonments_total',
  help: 'Carts expired due to reservation timeout'
});

const orderValue = new promClient.Histogram({
  name: 'order_value_dollars',
  help: 'Distribution of order values',
  buckets: [10, 25, 50, 100, 250, 500, 1000]
});

const searchLatency = new promClient.Histogram({
  name: 'search_latency_seconds',
  help: 'Elasticsearch query latency',
  labelNames: ['query_type'], // faceted, simple, autocomplete
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
});
```

**Database and Infrastructure Metrics:**
```javascript
// PostgreSQL connection pool metrics
const pgPoolMetrics = {
  pg_pool_total_connections: 'Total connections in pool',
  pg_pool_idle_connections: 'Idle connections available',
  pg_pool_waiting_queries: 'Queries waiting for connection'
};

// Valkey/Redis metrics
const valkeyMetrics = {
  valkey_connected_clients: 'Current client connections',
  valkey_memory_used_bytes: 'Memory consumption',
  valkey_cache_hits_total: 'Cache hit count',
  valkey_cache_misses_total: 'Cache miss count'
};

// Kafka consumer metrics
const kafkaMetrics = {
  kafka_consumer_lag: 'Messages behind latest offset',
  kafka_messages_consumed_total: 'Messages processed',
  kafka_consumer_errors_total: 'Processing errors'
};
```

### Structured Logging

**Log Format (JSON for parsing):**
```javascript
const logger = require('pino')({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
});

// Request logging with correlation IDs
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.log = logger.child({
    correlationId: req.correlationId,
    userId: req.session?.userId,
    method: req.method,
    path: req.path
  });
  next();
});

// Example log entries
req.log.info({ productId: 123, quantity: 2 }, 'Adding to cart');
req.log.warn({ productId: 123, available: 1, requested: 5 }, 'Insufficient inventory');
req.log.error({ err, orderId: 456 }, 'Payment processing failed');
```

**Log Levels by Environment:**
| Level | Local Dev | Staging | Production |
|-------|-----------|---------|------------|
| debug | Yes | Yes | No |
| info | Yes | Yes | Yes |
| warn | Yes | Yes | Yes |
| error | Yes | Yes | Yes |

### Distributed Tracing

**OpenTelemetry Setup (local with Jaeger):**
```javascript
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(
  new JaegerExporter({
    endpoint: 'http://localhost:14268/api/traces'
  })
));
provider.register();

// Trace a checkout flow
const tracer = trace.getTracer('checkout-service');

async function checkout(userId, cartId) {
  return tracer.startActiveSpan('checkout', async (span) => {
    span.setAttribute('user.id', userId);
    span.setAttribute('cart.id', cartId);

    await tracer.startActiveSpan('validate-inventory', async (child) => {
      // Inventory validation
      child.end();
    });

    await tracer.startActiveSpan('process-payment', async (child) => {
      // Payment processing
      child.end();
    });

    span.end();
  });
}
```

### SLI Dashboards

**Key SLIs and Thresholds:**

| SLI | Target | Warning | Critical | Measurement |
|-----|--------|---------|----------|-------------|
| Search p99 latency | < 100ms | > 150ms | > 300ms | `histogram_quantile(0.99, search_latency_seconds)` |
| Checkout success rate | > 99% | < 98% | < 95% | `sum(checkout_success) / sum(checkout_attempts)` |
| Inventory accuracy | 100% | < 99.9% | < 99% | `1 - (oversells / total_orders)` |
| API availability | 99.9% | < 99.5% | < 99% | `1 - (5xx_errors / total_requests)` |
| Cart reservation success | > 95% | < 90% | < 80% | `reservations_success / reservations_total` |

**Grafana Dashboard Panels (local setup):**
```yaml
# docker-compose.yml addition
grafana:
  image: grafana/grafana:10.0
  ports:
    - "3000:3000"
  volumes:
    - ./grafana/dashboards:/var/lib/grafana/dashboards
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin

prometheus:
  image: prom/prometheus:v2.45
  ports:
    - "9090:9090"
  volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml
```

### Alert Thresholds

**Alert Rules (Prometheus AlertManager):**
```yaml
groups:
  - name: amazon-ecommerce
    rules:
      - alert: HighSearchLatency
        expr: histogram_quantile(0.99, rate(search_latency_seconds_bucket[5m])) > 0.3
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Search p99 latency above 300ms"

      - alert: InventoryOversell
        expr: increase(inventory_oversell_total[1h]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Inventory oversell detected"

      - alert: HighCartAbandonment
        expr: rate(cart_abandonments_total[1h]) > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High cart abandonment rate"

      - alert: KafkaConsumerLag
        expr: kafka_consumer_lag > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka consumer falling behind"

      - alert: DatabaseConnectionPoolExhausted
        expr: pg_pool_waiting_queries > 10
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool exhausted"
```

### Audit Logging

**Audit Events Schema:**
```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id INTEGER,           -- User or system ID
  actor_type VARCHAR(20),     -- 'user', 'admin', 'system'
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),  -- 'order', 'product', 'inventory'
  resource_id VARCHAR(100),
  old_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  correlation_id UUID
);

CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, actor_type);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
```

**Audit Events to Capture:**
```javascript
const auditEvents = {
  // Order lifecycle
  'order.created': { resource: 'order', severity: 'info' },
  'order.cancelled': { resource: 'order', severity: 'info' },
  'order.refunded': { resource: 'order', severity: 'warning' },

  // Inventory changes
  'inventory.adjusted': { resource: 'inventory', severity: 'warning' },
  'inventory.reserved': { resource: 'inventory', severity: 'info' },
  'inventory.released': { resource: 'inventory', severity: 'info' },

  // Admin actions
  'product.price_changed': { resource: 'product', severity: 'warning' },
  'product.deleted': { resource: 'product', severity: 'critical' },
  'seller.suspended': { resource: 'seller', severity: 'critical' }
};

async function logAudit(event, actor, resource, changes) {
  await db('audit_logs').insert({
    actor_id: actor.id,
    actor_type: actor.type,
    action: event,
    resource_type: resource.type,
    resource_id: resource.id,
    old_value: changes.old,
    new_value: changes.new,
    ip_address: actor.ip,
    correlation_id: actor.correlationId
  });
}
```

---

## Failure Handling

### Retry Strategy with Idempotency Keys

**Idempotency for Order Creation:**
```javascript
// Client generates idempotency key before checkout
const idempotencyKey = `order-${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

// Server-side handling
async function createOrder(idempotencyKey, orderData) {
  // Check if order already exists for this key
  const existing = await db('orders')
    .where({ idempotency_key: idempotencyKey })
    .first();

  if (existing) {
    // Return cached response
    return existing;
  }

  // Create order with idempotency key
  return await db.transaction(async (trx) => {
    const order = await trx('orders').insert({
      ...orderData,
      idempotency_key: idempotencyKey
    }).returning('*');

    return order[0];
  });
}

// Schema addition
ALTER TABLE orders ADD COLUMN idempotency_key VARCHAR(100) UNIQUE;
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);
```

**Exponential Backoff for External Services:**
```javascript
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    baseDelay = 100,
    maxDelay = 5000,
    factor = 2,
    retryOn = (err) => err.code === 'ECONNRESET' || err.status >= 500
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !retryOn(err)) {
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
      const jitter = delay * (0.5 + Math.random() * 0.5);
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }
  throw lastError;
}

// Usage for payment service
const paymentResult = await withRetry(
  () => paymentGateway.charge(orderId, amount),
  { maxAttempts: 3, baseDelay: 200 }
);
```

### Circuit Breakers

**Circuit Breaker Implementation:**
```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 30000; // 30 seconds
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

// Circuit breakers per external service
const circuitBreakers = {
  elasticsearch: new CircuitBreaker({ failureThreshold: 3, timeout: 10000 }),
  paymentGateway: new CircuitBreaker({ failureThreshold: 5, timeout: 60000 }),
  recommendationService: new CircuitBreaker({ failureThreshold: 3, timeout: 5000 })
};

// Usage
async function searchProducts(query) {
  try {
    return await circuitBreakers.elasticsearch.execute(
      () => es.search({ index: 'products', body: query })
    );
  } catch (err) {
    if (err.message === 'Circuit breaker is OPEN') {
      // Fallback to PostgreSQL full-text search
      return await pgFallbackSearch(query);
    }
    throw err;
  }
}
```

**Circuit Breaker Metrics:**
```javascript
const circuitBreakerState = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service']
});

// Update on state change
circuitBreakers.elasticsearch.onStateChange = (newState) => {
  const stateValue = { 'CLOSED': 0, 'HALF_OPEN': 1, 'OPEN': 2 };
  circuitBreakerState.set({ service: 'elasticsearch' }, stateValue[newState]);
};
```

### Multi-Region Disaster Recovery (Conceptual for Local Learning)

**Local Simulation of Multi-Region:**
```yaml
# docker-compose.yml - Simulate two "regions"
services:
  postgres-primary:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: amazon_primary

  postgres-replica:
    image: postgres:16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: amazon_replica
    # In production: configure streaming replication

  valkey-primary:
    image: valkey/valkey:7
    ports:
      - "6379:6379"

  valkey-replica:
    image: valkey/valkey:7
    ports:
      - "6380:6379"
    command: valkey-server --replicaof valkey-primary 6379
```

**Failover Strategy:**
```javascript
class DatabaseClient {
  constructor() {
    this.primary = new Pool({ connectionString: process.env.DATABASE_PRIMARY_URL });
    this.replica = new Pool({ connectionString: process.env.DATABASE_REPLICA_URL });
    this.usePrimary = true;
  }

  async query(sql, params, options = {}) {
    const { readOnly = false } = options;

    // Writes always go to primary
    if (!readOnly) {
      return this.primary.query(sql, params);
    }

    // Reads can go to replica
    try {
      if (this.usePrimary) {
        return await this.primary.query(sql, params);
      } else {
        return await this.replica.query(sql, params);
      }
    } catch (err) {
      if (this.usePrimary) {
        // Failover to replica for reads
        console.warn('Primary failed, failing over to replica for reads');
        this.usePrimary = false;
        return await this.replica.query(sql, params);
      }
      throw err;
    }
  }

  async healthCheck() {
    try {
      await this.primary.query('SELECT 1');
      this.usePrimary = true;
    } catch {
      console.warn('Primary database unhealthy');
    }
  }
}
```

### Backup and Restore Testing

**Backup Scripts:**
```bash
#!/bin/bash
# scripts/backup-database.sh
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups"

# PostgreSQL backup
pg_dump -h localhost -U postgres amazon_db \
  --format=custom \
  --file="${BACKUP_DIR}/amazon_db_${TIMESTAMP}.dump"

# Elasticsearch snapshot (requires snapshot repository configured)
curl -X PUT "localhost:9200/_snapshot/backups/snapshot_${TIMESTAMP}" \
  -H 'Content-Type: application/json' \
  -d '{"indices": "products", "include_global_state": false}'

# Valkey RDB snapshot
docker exec amazon-valkey valkey-cli BGSAVE
docker cp amazon-valkey:/data/dump.rdb "${BACKUP_DIR}/valkey_${TIMESTAMP}.rdb"

echo "Backup completed: ${TIMESTAMP}"
```

**Restore Testing Procedure:**
```bash
#!/bin/bash
# scripts/test-restore.sh
BACKUP_FILE=$1

echo "=== Restore Test Started ==="

# 1. Create test database
createdb -h localhost -U postgres amazon_restore_test

# 2. Restore backup
pg_restore -h localhost -U postgres -d amazon_restore_test "${BACKUP_FILE}"

# 3. Verify data integrity
psql -h localhost -U postgres -d amazon_restore_test -c "
  SELECT 'products' as table_name, COUNT(*) as count FROM products
  UNION ALL
  SELECT 'orders', COUNT(*) FROM orders
  UNION ALL
  SELECT 'inventory', COUNT(*) FROM inventory;
"

# 4. Run sample queries to verify relationships
psql -h localhost -U postgres -d amazon_restore_test -c "
  SELECT COUNT(*) as orders_with_items
  FROM orders o
  JOIN order_items oi ON o.id = oi.order_id;
"

# 5. Cleanup
dropdb -h localhost -U postgres amazon_restore_test

echo "=== Restore Test Completed ==="
```

**Backup Schedule (for reference):**
| Data Type | Frequency | Retention | Storage |
|-----------|-----------|-----------|---------|
| PostgreSQL full | Daily | 30 days | Local + S3 |
| PostgreSQL WAL | Continuous | 7 days | Local |
| Elasticsearch snapshots | Daily | 14 days | S3 |
| Valkey RDB | Hourly | 24 hours | Local |

---

## Data Lifecycle Policies

### Retention and TTL Policies

**Data Retention Rules:**
```sql
-- Orders: Keep for 7 years (legal requirement)
-- After 7 years, anonymize and archive

-- Cart items: Auto-expire after 30 minutes (reservation)
-- Already handled by reserved_until column

-- Session data: 24-hour TTL in Valkey
-- Search logs: 90-day retention
-- Audit logs: 3-year retention

-- Add retention metadata
ALTER TABLE orders ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN retention_expires_at TIMESTAMP
  GENERATED ALWAYS AS (created_at + INTERVAL '7 years') STORED;
```

**TTL Implementation:**
```javascript
// Valkey TTL for various data types
const ttlPolicies = {
  session: 86400,           // 24 hours
  cartReservation: 1800,    // 30 minutes
  productCache: 3600,       // 1 hour
  recommendations: 86400,   // 24 hours
  searchResults: 300,       // 5 minutes
  rateLimit: 60            // 1 minute
};

// Set with TTL
await valkey.setex(`session:${sessionId}`, ttlPolicies.session, sessionData);
await valkey.setex(`product:${productId}`, ttlPolicies.productCache, productData);
```

**Automated Cleanup Jobs:**
```javascript
// Run daily: Clean up expired data
const cleanupJobs = [
  {
    name: 'expired-cart-reservations',
    schedule: '*/5 * * * *', // Every 5 minutes
    async run() {
      const result = await db('cart_items')
        .where('reserved_until', '<', new Date())
        .delete();
      logger.info({ count: result }, 'Cleaned expired cart reservations');
    }
  },
  {
    name: 'old-search-logs',
    schedule: '0 2 * * *', // Daily at 2 AM
    async run() {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const result = await db('search_logs')
        .where('created_at', '<', cutoff)
        .delete();
      logger.info({ count: result }, 'Cleaned old search logs');
    }
  },
  {
    name: 'archive-old-orders',
    schedule: '0 3 * * 0', // Weekly on Sunday at 3 AM
    async run() {
      // Archive orders older than 2 years to cold storage
      const cutoff = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
      await archiveOrdersToColdStorage(cutoff);
    }
  }
];
```

### Archival to Cold Storage

**Archive Strategy:**
```javascript
// Archive old orders to MinIO (S3-compatible)
async function archiveOrdersToColdStorage(beforeDate) {
  const batchSize = 1000;
  let archived = 0;

  while (true) {
    const orders = await db('orders')
      .where('created_at', '<', beforeDate)
      .whereNull('archived_at')
      .limit(batchSize);

    if (orders.length === 0) break;

    // Export to JSON Lines format
    const archiveData = orders.map(order => JSON.stringify(order)).join('\n');
    const archiveKey = `orders/archive/${beforeDate.toISOString().slice(0, 7)}/${Date.now()}.jsonl`;

    // Upload to MinIO
    await minioClient.putObject(
      'amazon-archive',
      archiveKey,
      archiveData,
      { 'Content-Type': 'application/x-ndjson' }
    );

    // Mark as archived (keep minimal reference in DB)
    const orderIds = orders.map(o => o.id);
    await db('orders')
      .whereIn('id', orderIds)
      .update({
        archived_at: new Date(),
        shipping_address: null,  // Remove PII from hot storage
        archived_location: archiveKey
      });

    archived += orders.length;
    logger.info({ archived, batch: orders.length }, 'Archived orders batch');
  }

  return archived;
}
```

**Archive Schema:**
```sql
-- Add archive tracking columns
ALTER TABLE orders ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN archived_location VARCHAR(500);

-- Partitioning for older data (optional, for learning)
CREATE TABLE orders_archive (
  LIKE orders INCLUDING ALL
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_archive_2023 PARTITION OF orders_archive
  FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
```

### Backfill and Replay Procedures

**Elasticsearch Reindex from PostgreSQL:**
```javascript
// Full reindex when Elasticsearch data is stale or corrupted
async function reindexProducts() {
  const batchSize = 500;
  let offset = 0;
  let indexed = 0;

  // Create new index with timestamp
  const newIndex = `products_${Date.now()}`;
  await es.indices.create({
    index: newIndex,
    body: {
      mappings: productMappings,
      settings: productSettings
    }
  });

  while (true) {
    const products = await db('products')
      .join('inventory', 'products.id', 'inventory.product_id')
      .select('products.*', db.raw('SUM(inventory.quantity - inventory.reserved) as available'))
      .groupBy('products.id')
      .offset(offset)
      .limit(batchSize);

    if (products.length === 0) break;

    const bulkBody = products.flatMap(product => [
      { index: { _index: newIndex, _id: product.id } },
      {
        title: product.title,
        description: product.description,
        category: product.category_id,
        price: product.price,
        rating: product.rating,
        in_stock: product.available > 0
      }
    ]);

    await es.bulk({ body: bulkBody });

    offset += batchSize;
    indexed += products.length;
    logger.info({ indexed }, 'Reindex progress');
  }

  // Atomic swap using alias
  await es.indices.updateAliases({
    body: {
      actions: [
        { remove: { index: 'products_*', alias: 'products' } },
        { add: { index: newIndex, alias: 'products' } }
      ]
    }
  });

  logger.info({ totalIndexed: indexed }, 'Reindex completed');
}
```

**Kafka Message Replay:**
```javascript
// Replay events from a specific offset for recovery
async function replayOrderEvents(fromTimestamp) {
  const admin = kafka.admin();
  await admin.connect();

  // Get partition offsets for timestamp
  const offsets = await admin.fetchTopicOffsetsByTimestamp('order-events', fromTimestamp);

  // Reset consumer group to those offsets
  await admin.setOffsets({
    groupId: 'order-processor',
    topic: 'order-events',
    partitions: offsets.map(o => ({
      partition: o.partition,
      offset: o.offset
    }))
  });

  logger.info({ fromTimestamp, offsets }, 'Consumer offsets reset for replay');
  await admin.disconnect();

  // Consumer will replay from new offsets on restart
}

// Replay recommendations calculation
async function replayRecommendations(fromDate) {
  logger.info({ fromDate }, 'Starting recommendations replay');

  // Get all orders since fromDate
  const orders = await db('orders')
    .where('created_at', '>=', fromDate)
    .select('id');

  // Recompute "also bought" for affected products
  const affectedProducts = await db('order_items')
    .whereIn('order_id', orders.map(o => o.id))
    .distinct('product_id');

  for (const { product_id } of affectedProducts) {
    await updateProductRecommendations(product_id);
  }

  logger.info({ productsUpdated: affectedProducts.length }, 'Recommendations replay completed');
}
```

**Backfill Checklist:**
```markdown
## Backfill Runbook

### Before Backfill
- [ ] Notify team of upcoming backfill
- [ ] Check system load (avoid peak hours)
- [ ] Verify source data integrity
- [ ] Create backup of target data

### During Backfill
- [ ] Monitor memory/CPU usage
- [ ] Watch for replication lag
- [ ] Check error logs every 15 minutes
- [ ] Track progress metrics

### After Backfill
- [ ] Verify record counts match
- [ ] Spot-check random samples
- [ ] Run integration tests
- [ ] Update documentation with timestamp
```

---

## Implementation Notes

This section documents the rationale behind key resilience and observability features implemented in the backend codebase.

### Why Idempotency Prevents Duplicate Orders and Charges

**Problem Statement:**
In e-commerce, duplicate orders are a critical failure mode. They can occur from:
- Network timeouts causing client retries
- Users double-clicking the "Place Order" button
- Mobile apps retrying on connection drops
- Load balancer failovers mid-request

Each duplicate order means:
- Customer charged multiple times
- Inventory decremented incorrectly
- Fulfillment confusion and shipping costs
- Customer trust erosion and support burden

**Solution: Idempotency Keys**

The implementation uses a client-provided `Idempotency-Key` header to ensure exactly-once order creation:

```javascript
// Client sends unique key with checkout request
POST /api/orders
Headers: { "Idempotency-Key": "order-user123-1705432800000-abc123" }

// Server flow:
// 1. Check Redis for existing key
// 2. If found with status='completed', return cached response
// 3. If not found, create record with status='processing'
// 4. Process order
// 5. Update record with status='completed' and response
```

**Why This Works:**
- **Atomicity**: Redis `SETNX` ensures only one request "wins" the race
- **Durability**: PostgreSQL backup ensures keys survive Redis failures
- **Fast Lookups**: Redis provides sub-millisecond duplicate detection
- **Graceful Retries**: Failed requests (status='failed') allow retries with same key

**Key Design Decisions:**
1. **24-hour TTL**: Balances storage costs against legitimate retry windows
2. **Processing state**: Handles concurrent requests gracefully (returns 409 Conflict)
3. **PostgreSQL fallback**: Ensures durability if Redis is temporarily unavailable

See: `/backend/src/shared/idempotency.js`

---

### Why Circuit Breakers Protect Checkout Flow

**Problem Statement:**
E-commerce checkout depends on external services:
- Payment gateways (Stripe, PayPal)
- Inventory systems
- Tax calculation services
- Fraud detection

When these services fail, naive retry logic causes:
- **Cascade failures**: Overwhelmed services fail faster
- **Resource exhaustion**: Threads/connections blocked waiting
- **User frustration**: Slow failures are worse than fast failures

**Solution: Circuit Breaker Pattern**

```
CLOSED (normal) ──failures exceed threshold──> OPEN (fail fast)
     ↑                                              │
     │                                              │ timeout expires
     │                                              ▼
     └────successes exceed threshold───── HALF-OPEN (test)
```

**Implementation Details:**

```javascript
// Payment circuit breaker configuration
const paymentCircuitBreakerOptions = {
  timeout: 30000,           // Payment can take longer
  errorThresholdPercentage: 30,  // Trip faster for payment (critical)
  resetTimeout: 60000,      // Wait longer before retrying
  volumeThreshold: 3        // Trip after fewer failures
};

// Usage in checkout
const paymentBreaker = createPaymentCircuitBreaker(processPayment, paymentFallback);
const result = await paymentBreaker.fire(order, paymentDetails);
```

**Why This Works:**
- **Fast Failure**: Open circuit returns immediately (no waiting)
- **Automatic Recovery**: Half-open state tests if service recovered
- **Fallback Support**: Graceful degradation (queue for later, use backup gateway)
- **Metrics**: Circuit state exposed to Prometheus for alerting

**Service-Specific Configurations:**
| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| Payment Gateway | 30s | 30% | 60s |
| Inventory | 5s | 50% | 15s |
| Elasticsearch | 5s | 60% | 10s |

See: `/backend/src/shared/circuitBreaker.js`

---

### Why Audit Logging Enables Order Dispute Resolution

**Problem Statement:**
E-commerce disputes require answering questions like:
- "Did the customer actually place this order?"
- "When was the order cancelled, and by whom?"
- "What was the original price before the refund?"
- "Was this a valid refund or potential fraud?"

Without audit logs, resolving disputes requires:
- Guessing from database state
- Asking customers to prove claims
- Legal liability exposure

**Solution: Immutable Audit Trail**

Every order/payment operation creates an audit record:

```javascript
await createAuditLog({
  action: 'order.created',
  actor: { id: userId, type: 'user' },
  resource: { type: 'order', id: orderId },
  changes: {
    new: { total: 149.99, items: [...] }
  },
  context: { ip: '192.168.1.1', correlationId: 'uuid' }
});
```

**Audit Events Captured:**
| Event | Severity | Use Case |
|-------|----------|----------|
| order.created | info | Proof of purchase |
| order.cancelled | warning | Cancellation disputes |
| order.refunded | critical | Fraud investigation |
| payment.completed | info | Payment verification |
| payment.failed | warning | Debugging failures |
| inventory.adjusted | warning | Stock discrepancy investigation |
| admin.* | critical | Admin action accountability |

**Query Capabilities:**
```javascript
// Get complete order history for dispute resolution
const trail = await getOrderAuditTrail(orderId);
// Returns chronological list of all events for this order

// Find all actions by a user (fraud investigation)
const logs = await queryAuditLogs({
  actorId: userId,
  startDate: '2024-01-01',
  severity: 'critical'
});
```

**Why This Works:**
- **Immutability**: INSERT-only table, never UPDATE/DELETE
- **Correlation IDs**: Link related events across services
- **IP/User Agent**: Identify suspicious patterns
- **Old/New Values**: Full before/after state for reversibility

See: `/backend/src/shared/audit.js`

---

### Why Order Archival Balances History vs Storage Costs

**Problem Statement:**
E-commerce generates massive order data:
- 1M orders/day = 365M orders/year
- Each order has items, addresses, payment details
- Legal requirement: Keep 7 years (2.5B+ orders)

Keeping all data in PostgreSQL causes:
- **Storage costs**: Terabytes of expensive SSD storage
- **Query performance**: Indexes become huge, queries slow
- **Backup time**: Full backups take hours
- **Migration risk**: Schema changes on billion-row tables are dangerous

**Solution: Tiered Storage with Lifecycle Policies**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  HOT STORAGE    │ ──> │  WARM STORAGE   │ ──> │  COLD STORAGE   │
│  PostgreSQL     │     │  orders_archive │     │  MinIO/S3       │
│  < 2 years      │     │  2-7 years      │     │  > 7 years      │
│  Full queries   │     │  JSONB blob     │     │  Anonymized     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Retention Policies:**

```javascript
const RetentionPolicies = {
  ORDERS: {
    hotStorageDays: 730,        // 2 years in PostgreSQL
    archiveRetentionDays: 2555, // 7 years total
    anonymizeAfterDays: 2555    // Remove PII after 7 years
  },
  CART_ITEMS: {
    reservationMinutes: 30      // Short-lived
  },
  AUDIT_LOGS: {
    hotStorageDays: 365,        // 1 year queryable
    archiveRetentionDays: 1095  // 3 years total
  }
};
```

**Archival Process:**
1. **Identify**: Find orders older than 2 years with completed/cancelled status
2. **Export**: Serialize full order with items to JSONB
3. **Store**: Insert into `orders_archive` table
4. **Clean**: Remove PII from original order (shipping address, notes)
5. **Mark**: Set `archive_status = 'archived'`

**Why This Works:**
- **Query Performance**: Hot storage stays small and fast
- **Cost Efficiency**: Cold storage is 10x cheaper per GB
- **Legal Compliance**: 7-year retention maintained
- **Privacy Compliance**: GDPR/CCPA anonymization after retention period
- **Recoverability**: Archived data retrievable for disputes

**Automated Jobs:**
```javascript
// Run daily at 3 AM
setInterval(runArchivalJobs, 24 * 60 * 60 * 1000);

// Jobs run:
// - cleanupExpiredCartItems (every 5 minutes)
// - cleanupIdempotencyKeys (hourly)
// - archiveOrders (daily)
// - anonymizeOldOrders (daily)
```

See: `/backend/src/shared/archival.js`

---

### Observability Stack Summary

The implementation provides three pillars of observability:

**1. Metrics (Prometheus)**
- Endpoint: `GET /metrics`
- Key metrics: `orders_total`, `order_value_dollars`, `circuit_breaker_state`
- Dashboards: Order rates, payment success, search latency

**2. Logging (Pino JSON)**
- Structured JSON format for log aggregation
- Correlation IDs for request tracing
- Log levels: debug/info/warn/error

**3. Health Checks**
- `GET /api/health` - Simple liveness
- `GET /api/health/detailed` - Full service status
- `GET /api/health/ready` - Kubernetes readiness probe

**Files Added:**
```
backend/src/shared/
├── logger.js          # Pino structured logging
├── metrics.js         # Prometheus metrics
├── circuitBreaker.js  # Opossum circuit breakers
├── retry.js           # Exponential backoff
├── idempotency.js     # Duplicate order prevention
├── audit.js           # Order/payment audit trail
└── archival.js        # Data lifecycle management
```
