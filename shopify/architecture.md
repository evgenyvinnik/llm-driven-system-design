# Design Shopify - Architecture

## System Overview

Shopify is a multi-tenant e-commerce platform where each merchant has an isolated store. Core challenges involve tenant isolation, custom domain routing, and scalable checkout processing.

**Learning Goals:**
- Design multi-tenant architecture
- Build custom domain routing
- Implement secure checkout flows
- Handle theme/customization systems

---

## Requirements

### Functional Requirements

1. **Store**: Merchants create branded stores
2. **Products**: Manage catalog and inventory
3. **Checkout**: Secure payment processing
4. **Orders**: Process and fulfill orders
5. **Analytics**: Sales and customer insights

### Non-Functional Requirements

- **Availability**: 99.99% for checkout
- **Isolation**: Complete data separation between merchants
- **Latency**: < 100ms for product pages
- **Scale**: 1M+ stores, 100M+ products

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Request Routing                             │
│    Custom Domains → Tenant Resolution → Store Rendering         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│              (Tenant context in every request)                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Store Service │    │Product Service│    │Checkout Service│
│               │    │               │    │               │
│ - Settings    │    │ - Catalog     │    │ - Cart        │
│ - Themes      │    │ - Variants    │    │ - Payment     │
│ - Domains     │    │ - Inventory   │    │ - Orders      │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
│         PostgreSQL (with Row-Level Security per tenant)         │
│              + Valkey (sessions, cart) + Stripe                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Multi-Tenant Data Model

**Approach 1: Shared Database, Tenant Column**
```sql
-- Every table has store_id
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  title VARCHAR(200),
  price DECIMAL(10, 2),
  ...
);

-- Row-Level Security
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON products
  USING (store_id = current_setting('app.current_store_id')::integer);
```

**Approach 2: Schema Per Tenant**
```sql
-- Each store gets own schema
CREATE SCHEMA store_12345;
CREATE TABLE store_12345.products (...);
```

**Chosen: Shared Database with RLS**
- Simpler operations (one schema)
- Efficient for millions of stores
- RLS enforces isolation at database level

### 2. Custom Domain Routing

**Domain Resolution Flow:**
```
Request: mystore.com
    │
    ▼
┌─────────────────┐
│  DNS Points to  │
│  Shopify CDN    │
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Domain Lookup   │──▶ Valkey: domain → store_id
│ (Edge/CDN)      │
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Route to Store  │──▶ Set tenant context, render
└─────────────────┘
```

**Domain Registration:**
```javascript
async function registerCustomDomain(storeId, domain) {
  // Validate domain ownership (DNS TXT record check)
  const verified = await verifyDomainOwnership(domain)
  if (!verified) throw new Error('Domain verification failed')

  // Store mapping
  await db('custom_domains').insert({ store_id: storeId, domain })

  // Update edge cache
  await redis.set(`domain:${domain}`, storeId)

  // Provision SSL certificate (Let's Encrypt)
  await provisionSSL(domain)
}
```

### 3. Checkout Flow

**Secure Checkout Sequence:**
```javascript
async function processCheckout(storeId, cartId, paymentMethodId) {
  const cart = await getCart(cartId)

  // 1. Validate inventory
  for (const item of cart.items) {
    const available = await checkInventory(storeId, item.variantId, item.quantity)
    if (!available) {
      throw new Error(`${item.title} is no longer available`)
    }
  }

  // 2. Reserve inventory
  await reserveInventory(cart.items)

  // 3. Calculate totals
  const totals = await calculateTotals(cart)

  // 4. Process payment (Stripe)
  const payment = await stripe.paymentIntents.create({
    amount: totals.total * 100, // cents
    currency: 'usd',
    payment_method: paymentMethodId,
    confirm: true,
    metadata: { store_id: storeId, cart_id: cartId }
  })

  if (payment.status !== 'succeeded') {
    await releaseInventory(cart.items)
    throw new Error('Payment failed')
  }

  // 5. Create order
  const order = await createOrder(storeId, cart, payment)

  // 6. Commit inventory reduction
  await commitInventory(cart.items)

  // 7. Send confirmations
  await sendOrderConfirmation(order)

  return order
}
```

### 4. Theme System

**Template Engine:**
```javascript
// Simplified Liquid-like template rendering
const themes = {
  default: {
    'index.html': `
      <html>
        <head><title>{{ store.name }}</title></head>
        <body>
          {% for product in products %}
            <div class="product">
              <h2>{{ product.title }}</h2>
              <p>{{ product.price | money }}</p>
            </div>
          {% endfor %}
        </body>
      </html>
    `
  }
}

async function renderStorefront(storeId, page, data) {
  const store = await getStore(storeId)
  const theme = await getTheme(store.themeId)
  const template = theme.templates[page]

  return render(template, { store, ...data })
}
```

---

## Database Schema

```sql
-- Stores (tenants)
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  subdomain VARCHAR(50) UNIQUE,
  custom_domain VARCHAR(255),
  theme_id INTEGER REFERENCES themes(id),
  settings JSONB,
  plan VARCHAR(50) DEFAULT 'basic',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products (tenant-isolated)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Variants (size, color combinations)
CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  sku VARCHAR(100),
  price DECIMAL(10, 2),
  inventory_quantity INTEGER DEFAULT 0,
  options JSONB
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  order_number VARCHAR(50),
  customer_email VARCHAR(255),
  total DECIMAL(10, 2),
  status VARCHAR(30) DEFAULT 'pending',
  shipping_address JSONB,
  payment_status VARCHAR(30),
  fulfillment_status VARCHAR(30),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS on all tenant tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
```

---

## Key Design Decisions

### 1. Shared Database with RLS

**Decision**: Single database, row-level security per tenant

**Rationale**:
- Simpler operations than schema-per-tenant
- PostgreSQL RLS provides strong isolation
- Scales to millions of tenants

**Trade-off**: Cross-tenant queries impossible (by design)

### 2. Edge Domain Resolution

**Decision**: Cache domain → store mapping at CDN edge

**Rationale**:
- Sub-millisecond lookups
- Handles millions of custom domains
- CDN handles SSL termination

### 3. Stripe for Payments

**Decision**: Use Stripe Connect for payment processing

**Rationale**:
- Handles PCI compliance
- Supports marketplace payouts
- Simple integration

---

## Consistency and Idempotency Semantics

### Write Consistency Model

**Order and Payment Writes: Strong Consistency**
- Use PostgreSQL transactions with `SERIALIZABLE` isolation for inventory updates during checkout
- All order creation, inventory deduction, and payment recording happen in a single transaction
- No eventual consistency for financial operations

```sql
-- Checkout transaction with serializable isolation
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- Reserve inventory (SELECT FOR UPDATE prevents concurrent modifications)
UPDATE variants
SET inventory_quantity = inventory_quantity - $quantity
WHERE id = $variant_id AND store_id = $store_id AND inventory_quantity >= $quantity;

-- Create order only if inventory update succeeded
INSERT INTO orders (store_id, order_number, total, status, idempotency_key)
VALUES ($store_id, $order_number, $total, 'confirmed', $idempotency_key);

COMMIT;
```

**Product and Catalog Writes: Eventual Consistency**
- Product updates use read-committed isolation (default)
- Cache invalidation is asynchronous (1-5 second lag acceptable)
- Collections and search indices update via background jobs

### Idempotency Implementation

**Idempotency Key Pattern for Checkout:**
```javascript
async function processCheckoutIdempotent(storeId, cartId, paymentMethodId, idempotencyKey) {
  // Check for existing completed request
  const existing = await db('checkout_requests')
    .where({ idempotency_key: idempotencyKey, store_id: storeId })
    .first();

  if (existing) {
    if (existing.status === 'completed') {
      return { order: await getOrder(existing.order_id), deduplicated: true };
    }
    if (existing.status === 'processing') {
      throw new Error('Request already in progress');
    }
  }

  // Insert or update idempotency record
  await db('checkout_requests')
    .insert({
      idempotency_key: idempotencyKey,
      store_id: storeId,
      cart_id: cartId,
      status: 'processing',
      created_at: new Date()
    })
    .onConflict(['idempotency_key', 'store_id'])
    .merge({ status: 'processing', updated_at: new Date() });

  try {
    const order = await processCheckout(storeId, cartId, paymentMethodId);

    await db('checkout_requests')
      .where({ idempotency_key: idempotencyKey, store_id: storeId })
      .update({ status: 'completed', order_id: order.id });

    return { order, deduplicated: false };
  } catch (error) {
    await db('checkout_requests')
      .where({ idempotency_key: idempotencyKey, store_id: storeId })
      .update({ status: 'failed', error_message: error.message });
    throw error;
  }
}
```

**Idempotency Table:**
```sql
CREATE TABLE checkout_requests (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  cart_id INTEGER,
  order_id INTEGER REFERENCES orders(id),
  status VARCHAR(20) DEFAULT 'processing', -- processing, completed, failed
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, idempotency_key)
);

-- TTL cleanup: remove records older than 24 hours
CREATE INDEX idx_checkout_requests_created ON checkout_requests(created_at);
```

### Conflict Resolution

**Inventory Conflicts:**
- Last-write-wins is NOT acceptable for inventory
- Use optimistic locking with version column for non-checkout inventory updates
- Checkout uses pessimistic locking (SELECT FOR UPDATE)

```sql
-- Optimistic locking for admin inventory adjustments
UPDATE variants
SET inventory_quantity = $new_quantity, version = version + 1
WHERE id = $variant_id AND store_id = $store_id AND version = $expected_version;
-- If 0 rows affected, retry with fresh data
```

**Webhook Replay Handling:**
- All webhook handlers are idempotent using event IDs
- Store processed event IDs in `processed_webhooks` table (7-day retention)
- Stripe webhook signature verification before processing

---

## Async Queue Architecture

### Queue Infrastructure (RabbitMQ)

**Local Development Setup:**
```yaml
# docker-compose.yml
rabbitmq:
  image: rabbitmq:3-management
  ports:
    - "5672:5672"
    - "15672:15672"  # Management UI
  environment:
    RABBITMQ_DEFAULT_USER: shopify
    RABBITMQ_DEFAULT_PASS: shopify_dev
```

### Queue Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                        RabbitMQ Exchanges                       │
├─────────────────────────────────────────────────────────────────┤
│  orders.events (fanout)     │  inventory.events (topic)        │
│  └── orders.created         │  └── inventory.low.*             │
│  └── orders.fulfilled       │  └── inventory.out.*             │
│  └── orders.cancelled       │                                   │
├─────────────────────────────────────────────────────────────────┤
│  notifications (direct)     │  background (direct)              │
│  └── email.send             │  └── search.index                │
│  └── sms.send               │  └── analytics.aggregate         │
│  └── webhook.deliver        │  └── image.resize                │
└─────────────────────────────────────────────────────────────────┘
```

### Queue Definitions

```javascript
// Queue configuration with delivery semantics
const queues = {
  // Order processing - at-least-once delivery, manual ack
  'orders.processing': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.orders',
      'x-message-ttl': 86400000  // 24 hours
    }
  },

  // Email notifications - at-least-once, 3 retries
  'notifications.email': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.notifications',
      'x-max-retries': 3
    }
  },

  // Search indexing - at-most-once acceptable (eventual consistency)
  'search.index': {
    durable: false,
    arguments: {
      'x-message-ttl': 300000  // 5 minutes
    }
  },

  // Webhook delivery - at-least-once with exponential backoff
  'webhooks.deliver': {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx.webhooks',
      'x-max-retries': 5
    }
  }
};
```

### Background Job Patterns

**Order Created Fanout:**
```javascript
// Publisher (after order created)
async function publishOrderCreated(order) {
  const message = {
    event: 'order.created',
    timestamp: new Date().toISOString(),
    idempotency_key: `order_created_${order.id}`,
    data: {
      order_id: order.id,
      store_id: order.store_id,
      total: order.total,
      items: order.items
    }
  };

  await channel.publish('orders.events', '', Buffer.from(JSON.stringify(message)), {
    persistent: true,
    messageId: message.idempotency_key
  });
}

// Consumer (email service)
async function handleOrderCreated(msg) {
  const event = JSON.parse(msg.content.toString());

  // Idempotency check
  if (await isEventProcessed(event.idempotency_key)) {
    channel.ack(msg);
    return;
  }

  try {
    await sendOrderConfirmationEmail(event.data);
    await markEventProcessed(event.idempotency_key);
    channel.ack(msg);
  } catch (error) {
    // Requeue with backoff (up to 3 times)
    if (msg.fields.deliveryTag < 3) {
      channel.nack(msg, false, true);
    } else {
      // Send to dead letter queue
      channel.nack(msg, false, false);
    }
  }
}
```

### Backpressure Handling

**Consumer Prefetch Limits:**
```javascript
// Limit concurrent processing per consumer
channel.prefetch(10);  // Process max 10 messages at a time

// For heavy operations like image processing
channel.prefetch(2);
```

**Queue Length Monitoring:**
```javascript
// Check queue depth before publishing
async function checkBackpressure(queueName) {
  const queue = await channel.checkQueue(queueName);
  if (queue.messageCount > 10000) {
    logger.warn(`Queue ${queueName} has high backlog: ${queue.messageCount}`);
    // Could implement: reject new requests, enable sampling, alert
  }
  return queue.messageCount;
}
```

### Dead Letter Queue Processing

```javascript
// DLQ consumer for manual review or retry
async function processDLQ(queueName) {
  const dlqName = `dlq.${queueName}`;

  channel.consume(dlqName, async (msg) => {
    const headers = msg.properties.headers;
    const originalError = headers['x-death']?.[0]?.reason;

    // Log for investigation
    logger.error({
      queue: queueName,
      messageId: msg.properties.messageId,
      error: originalError,
      payload: msg.content.toString()
    });

    // Could implement: retry after delay, send to manual review queue
    channel.ack(msg);
  });
}
```

---

## Observability

### Metrics (Prometheus)

**Key Business Metrics:**
```yaml
# prometheus.yml scrape config
scrape_configs:
  - job_name: 'shopify-api'
    static_configs:
      - targets: ['localhost:3001', 'localhost:3002', 'localhost:3003']
    metrics_path: '/metrics'
```

**Application Metrics (Express middleware):**
```javascript
const promClient = require('prom-client');

// Request metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code', 'store_id'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

// Business metrics
const checkoutsTotal = new promClient.Counter({
  name: 'shopify_checkouts_total',
  help: 'Total checkout attempts',
  labelNames: ['store_id', 'status']  // status: success, failed, abandoned
});

const orderValue = new promClient.Histogram({
  name: 'shopify_order_value_dollars',
  help: 'Order value distribution',
  labelNames: ['store_id'],
  buckets: [10, 50, 100, 250, 500, 1000, 5000]
});

const inventoryLevel = new promClient.Gauge({
  name: 'shopify_inventory_level',
  help: 'Current inventory level per variant',
  labelNames: ['store_id', 'variant_id']
});

const queueDepth = new promClient.Gauge({
  name: 'shopify_queue_depth',
  help: 'RabbitMQ queue message count',
  labelNames: ['queue_name']
});
```

### SLI/SLO Dashboard

**Service Level Indicators:**

| SLI | Target | Measurement |
|-----|--------|-------------|
| Checkout availability | 99.9% | `rate(checkouts_total{status="success"}[5m]) / rate(checkouts_total[5m])` |
| Product page latency p95 | < 100ms | `histogram_quantile(0.95, http_request_duration_seconds{route="/products"})` |
| API error rate | < 1% | `rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m])` |
| Queue processing lag | < 30s | `time() - oldest_message_timestamp` |

**Grafana Dashboard Panels:**
```json
{
  "dashboard": {
    "title": "Shopify SLI Dashboard",
    "panels": [
      {
        "title": "Checkout Success Rate (5m rolling)",
        "type": "stat",
        "targets": [{
          "expr": "sum(rate(shopify_checkouts_total{status='success'}[5m])) / sum(rate(shopify_checkouts_total[5m])) * 100"
        }],
        "thresholds": [
          { "value": 99.9, "color": "green" },
          { "value": 99, "color": "yellow" },
          { "value": 0, "color": "red" }
        ]
      },
      {
        "title": "API Latency p95 by Route",
        "type": "timeseries",
        "targets": [{
          "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (route, le))"
        }]
      },
      {
        "title": "Queue Depth",
        "type": "timeseries",
        "targets": [{
          "expr": "shopify_queue_depth"
        }]
      }
    ]
  }
}
```

### Alert Thresholds

```yaml
# alerting_rules.yml
groups:
  - name: shopify-critical
    rules:
      - alert: CheckoutSuccessRateLow
        expr: |
          sum(rate(shopify_checkouts_total{status="success"}[5m]))
          / sum(rate(shopify_checkouts_total[5m])) < 0.99
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Checkout success rate below 99%"
          description: "Current rate: {{ $value | humanizePercentage }}"

      - alert: HighAPILatency
        expr: |
          histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
          > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "API p95 latency exceeds 500ms"

      - alert: QueueBacklogHigh
        expr: shopify_queue_depth > 5000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Queue {{ $labels.queue_name }} has high backlog"

      - alert: InventoryOutOfStock
        expr: shopify_inventory_level == 0
        for: 1m
        labels:
          severity: info
        annotations:
          summary: "Variant {{ $labels.variant_id }} is out of stock"
```

### Structured Logging

**Log Format (JSON):**
```javascript
const logger = require('pino')({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'shopify-api',
    version: process.env.APP_VERSION
  }
});

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || uuidv4();
  req.log = logger.child({
    request_id: requestId,
    store_id: req.storeId,
    method: req.method,
    path: req.path
  });

  const start = Date.now();
  res.on('finish', () => {
    req.log.info({
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
      user_agent: req.headers['user-agent']
    }, 'request completed');
  });

  next();
});
```

**Example Log Output:**
```json
{
  "level": "info",
  "time": 1705420800000,
  "service": "shopify-api",
  "request_id": "abc-123",
  "store_id": 42,
  "method": "POST",
  "path": "/api/checkout",
  "status_code": 200,
  "duration_ms": 245,
  "msg": "request completed"
}
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { NodeTracerProvider } = require('@opentelemetry/node');
const { SimpleSpanProcessor } = require('@opentelemetry/tracing');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(new JaegerExporter({
    serviceName: 'shopify-api',
    host: 'localhost',
    port: 6831
  }))
);
provider.register();

// Trace checkout flow
const tracer = opentelemetry.trace.getTracer('checkout');

async function processCheckoutWithTracing(storeId, cartId, paymentMethodId) {
  return tracer.startActiveSpan('checkout.process', async (span) => {
    span.setAttribute('store_id', storeId);
    span.setAttribute('cart_id', cartId);

    try {
      // Each step creates child span
      await tracer.startActiveSpan('checkout.validate_inventory', async (childSpan) => {
        await validateInventory(cartId);
        childSpan.end();
      });

      await tracer.startActiveSpan('checkout.process_payment', async (childSpan) => {
        childSpan.setAttribute('payment_provider', 'stripe');
        await processPayment(paymentMethodId);
        childSpan.end();
      });

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

### Audit Logging

**Audit Events Table:**
```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  actor_id INTEGER,           -- user who performed action
  actor_type VARCHAR(20),     -- 'merchant', 'customer', 'system', 'admin'
  action VARCHAR(50) NOT NULL,-- 'order.created', 'product.updated', etc.
  resource_type VARCHAR(50),  -- 'order', 'product', 'variant'
  resource_id INTEGER,
  changes JSONB,              -- { before: {...}, after: {...} }
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_store_created ON audit_logs(store_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
```

**Audit Logger:**
```javascript
async function auditLog(context, action, resource, changes) {
  await db('audit_logs').insert({
    store_id: context.storeId,
    actor_id: context.userId,
    actor_type: context.userType,
    action: action,
    resource_type: resource.type,
    resource_id: resource.id,
    changes: JSON.stringify(changes),
    ip_address: context.ipAddress,
    user_agent: context.userAgent
  });
}

// Usage in order creation
await auditLog(
  { storeId: 42, userId: 123, userType: 'customer', ipAddress: '192.168.1.1' },
  'order.created',
  { type: 'order', id: order.id },
  { after: { total: order.total, items: order.items.length } }
);
```

**Audit Events to Track:**
- `order.created`, `order.cancelled`, `order.refunded`
- `product.created`, `product.updated`, `product.deleted`
- `inventory.adjusted` (manual adjustments)
- `settings.updated` (store configuration changes)
- `domain.verified`, `domain.removed`
- `api_key.created`, `api_key.revoked`

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | Operational simplicity |
| Domains | Edge cache | Database lookup | Latency |
| Payments | Stripe Connect | Custom | Compliance, speed |
| Themes | Liquid templates | React SSR | Simplicity |
| Message Queue | RabbitMQ | Kafka | Simpler for local dev, sufficient for learning |
| Tracing | OpenTelemetry + Jaeger | Zipkin | Vendor neutral, better ecosystem |
| Metrics | Prometheus + Grafana | Datadog | Self-hosted, free for local dev |

---

## Implementation Notes

This section documents the actual implementation of reliability patterns in the backend codebase, explaining **why** each pattern is critical for e-commerce operations.

### 1. Why Idempotency Prevents Inventory Overselling

**The Problem:**
When a customer clicks "Place Order" and the network times out, they naturally retry. Without idempotency, this can create duplicate orders and decrement inventory twice, leading to overselling.

```
Customer clicks "Buy" → Network timeout → Customer retries
Without idempotency:
  - Order 1 created, inventory -1
  - Order 2 created, inventory -1 (OVERSOLD!)

With idempotency:
  - Order 1 created, inventory -1
  - Retry detected via idempotency key → Return Order 1 (no duplicate)
```

**Implementation:**
The `withIdempotency()` wrapper in `/backend/src/services/idempotency.js`:
1. Checks if the idempotency key already exists in the database
2. If found with status `completed`, returns the cached result
3. If found with status `processing`, rejects (prevents race conditions)
4. If not found or `failed`, processes the operation and stores the result

**Why PostgreSQL for Idempotency Storage:**
- ACID guarantees prevent race conditions during key insertion
- Unique constraint on `(idempotency_key, store_id, operation)` enforces exactly-once semantics
- 24-hour TTL cleanup prevents unbounded growth

**Critical Insight:**
The checkout uses `SERIALIZABLE` isolation level combined with `SELECT FOR UPDATE` on inventory rows. This prevents the "lost update" problem where two concurrent transactions both read the same inventory level before either writes.

### 2. Why Async Queues Enable Reliable Webhook Delivery

**The Problem:**
Synchronous webhook delivery during checkout creates fragile dependencies:
- If the merchant's webhook endpoint is slow, checkout is slow
- If it's down, checkout fails entirely
- Retry logic in the critical path adds latency and complexity

**Implementation:**
RabbitMQ queues in `/backend/src/services/rabbitmq.js` decouple order creation from downstream processing:

```
Checkout (synchronous, fast):
  1. Validate inventory (SELECT FOR UPDATE)
  2. Process payment (circuit breaker protected)
  3. Create order in database
  4. Publish to RabbitMQ (non-blocking)
  5. Return success to customer

Async Workers (eventual, reliable):
  - orders.created → Send confirmation email
  - orders.created → Deliver merchant webhook (with retries)
  - inventory.low → Alert merchant
  - inventory.out → Pause product visibility
```

**Queue Delivery Semantics:**
- `durable: true` - Messages survive RabbitMQ restarts
- `persistent: true` - Messages written to disk
- Manual acknowledgment - Only ack after successful processing
- Dead Letter Queues - Failed messages preserved for investigation

**Why At-Least-Once is Correct:**
Webhooks and emails are idempotent operations (re-sending is safe). We choose at-least-once delivery over exactly-once because:
1. Exactly-once is expensive (2-phase commit, distributed transactions)
2. Consumers implement their own idempotency via message IDs
3. Duplicate email is annoying but acceptable; missing email is not

### 3. Why Inventory Metrics Enable Stockout Prevention

**The Problem:**
Stockouts are invisible until customers complain. By the time you notice, you've lost sales and frustrated customers who see "out of stock" on popular items.

**Implementation:**
Real-time Prometheus metrics in `/backend/src/services/metrics.js`:

```
shopify_inventory_level{store_id="1", variant_id="42", sku="TS-M-BLACK"} 5
shopify_inventory_low_total{store_id="1", variant_id="42"} 3
shopify_inventory_out_of_stock_total{store_id="1", variant_id="42"} 1
```

**Alerting Rules (defined in architecture.md):**
```yaml
# Alert when inventory approaches zero
- alert: InventoryLow
  expr: shopify_inventory_level < 10
  for: 5m
  labels:
    severity: warning

# Alert immediately when sold out
- alert: InventoryOutOfStock
  expr: shopify_inventory_level == 0
  for: 1m
  labels:
    severity: info
```

**Dashboard Insights:**
- **Trend Analysis:** `rate(shopify_inventory_out_of_stock_total[24h])` shows stockout frequency
- **Reorder Point:** When `shopify_inventory_level` crosses reorder threshold, alert for purchase order
- **Velocity Tracking:** Combine with order metrics to calculate days-of-inventory-remaining

**Why Prometheus Over Database Queries:**
- Real-time (no query latency)
- Historical data (track trends over time)
- Alerting built-in (PagerDuty, Slack integration)
- Aggregation at scale (no N+1 queries across all variants)

### 4. Why Audit Logging Enables Order Dispute Resolution

**The Problem:**
Customer disputes require forensic reconstruction:
- "I was charged but never received confirmation"
- "The inventory said 10 available but checkout said out of stock"
- "Someone changed my order without my authorization"

**Implementation:**
Comprehensive audit trail in `/backend/src/services/audit.js`:

```javascript
// Every checkout step is logged
await logCheckoutEvent(context, AuditAction.CHECKOUT_STARTED, { cartId, email });
await logInventoryChange(context, variantId, oldQty, newQty, 'checkout_reserve');
await logPaymentEvent(context, success, { amount, paymentIntentId });
await logOrderCreated(context, order);

// Query for dispute resolution
const trail = await getOrderAuditTrail(storeId, orderId);
// Returns chronological list:
// - checkout.started (timestamp, IP, cart contents)
// - inventory.adjusted (each SKU reserved)
// - payment.processed (Stripe intent ID)
// - order.created (final order state)
```

**What We Capture:**
- `actor_id` + `actor_type` - Who did it (customer, merchant, admin, system)
- `ip_address` - Where the request came from
- `changes.before` + `changes.after` - What changed
- `created_at` - When it happened

**Retention and Compliance:**
- Audit logs are immutable (INSERT only, no UPDATE/DELETE in application code)
- Indexes on `(store_id, created_at)` for efficient time-range queries
- 7+ year retention for financial records (PCI-DSS, tax compliance)

**Why Database Over Log Files:**
- Queryable (SQL WHERE clauses for investigation)
- Relational (JOIN with orders, products for context)
- Transactional (audit log and business operation in same transaction)
- Secure (database-level access controls, no need for log file permissions)

---

## Reliability Patterns Summary

| Pattern | File | Purpose |
|---------|------|---------|
| Idempotency | `services/idempotency.js` | Prevent duplicate orders on retry |
| Circuit Breaker | `services/circuit-breaker.js` | Protect against payment gateway failures |
| Async Queues | `services/rabbitmq.js` | Decouple checkout from notifications |
| Structured Logging | `services/logger.js` | Debug production issues |
| Prometheus Metrics | `services/metrics.js` | SLI/SLO dashboards and alerting |
| Audit Logging | `services/audit.js` | Dispute resolution and compliance |

---

## Running the Implementation

### Prerequisites
```bash
# Start infrastructure
docker-compose up -d

# Wait for services to be healthy
docker-compose ps
```

### Starting the Backend
```bash
cd backend
npm install
npm run dev
```

### Verifying the Implementation

**Health Check:**
```bash
curl http://localhost:3001/health
# Returns: { status, checks: { database, redis, rabbitmq }, circuitBreakers }
```

**Prometheus Metrics:**
```bash
curl http://localhost:3001/metrics
# Returns: Prometheus-formatted metrics
```

**Idempotent Checkout:**
```bash
# First request creates order
curl -X POST http://localhost:3001/api/storefront/demo/checkout \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: checkout-abc123" \
  -H "X-Cart-Session: your-cart-session" \
  -d '{"email": "test@example.com"}'

# Retry returns same order (deduplicated: true)
curl -X POST http://localhost:3001/api/storefront/demo/checkout \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: checkout-abc123" \
  -H "X-Cart-Session: your-cart-session" \
  -d '{"email": "test@example.com"}'
```

### RabbitMQ Management UI
```
URL: http://localhost:15672
User: shopify
Pass: shopify_dev
```

---

## Frontend Architecture

The frontend is built with React, TypeScript, and Vite, following a modular component architecture designed for maintainability and reusability.

### Directory Structure

```
frontend/src/
├── components/
│   ├── admin/                    # Admin dashboard components
│   │   ├── index.ts              # Barrel export
│   │   ├── AdminLayout.tsx       # Sidebar and header layout
│   │   ├── DashboardTab.tsx      # Analytics dashboard
│   │   ├── ProductsTab.tsx       # Product CRUD management
│   │   ├── OrdersTab.tsx         # Order list and fulfillment
│   │   ├── CustomersTab.tsx      # Customer list
│   │   └── SettingsTab.tsx       # Store settings form
│   ├── common/                   # Shared UI components
│   │   ├── index.ts              # Barrel export
│   │   ├── LoadingSpinner.tsx    # Loading indicators
│   │   └── EmptyState.tsx        # Empty/error state displays
│   ├── icons/                    # SVG icon components
│   │   ├── index.ts              # Barrel export
│   │   ├── CartIcon.tsx
│   │   ├── BackArrowIcon.tsx
│   │   ├── ImagePlaceholderIcon.tsx
│   │   └── CheckIcon.tsx
│   └── storefront/               # Customer-facing components
│       ├── index.ts              # Barrel export
│       ├── StorefrontLayout.tsx  # Header and footer
│       ├── ProductsView.tsx      # Product grid display
│       ├── ProductDetailView.tsx # Single product view
│       ├── CartView.tsx          # Shopping cart
│       ├── CheckoutView.tsx      # Checkout form
│       └── SuccessView.tsx       # Order confirmation
├── routes/                       # Tanstack Router pages
│   ├── admin/
│   │   └── $storeId.tsx          # Admin dashboard (127 lines)
│   └── store/
│       └── $subdomain.tsx        # Storefront (239 lines)
├── services/
│   └── api.ts                    # API client functions
├── stores/
│   ├── auth.ts                   # Authentication state (Zustand)
│   └── storefront.ts             # Storefront state (Zustand)
└── types/
    └── index.ts                  # TypeScript interfaces
```

### Component Design Principles

**1. Single Responsibility**
Each component handles one concern. For example, `ProductCard` only displays a single product; `ProductsView` orchestrates the grid layout.

**2. Composition Over Inheritance**
Complex UIs are built by composing smaller components:
```tsx
<CartView>
  <CartItem />      {/* Individual item row */}
  <CartSummary />   {/* Subtotal and actions */}
</CartView>
```

**3. Props Down, Callbacks Up**
Components receive data via props and communicate changes via callback functions:
```tsx
<ProductsTab storeId={123} />  // Data flows down
<CartItem onUpdateQuantity={(id, qty) => {...}} />  // Events flow up
```

**4. Colocation of Related Code**
Helper components (like `StatusBadge`, `QuantityControls`) are defined in the same file as their parent when they're not reused elsewhere.

### State Management

**Global State (Zustand)**
- `useAuthStore` - User authentication, login/logout
- `useStorefrontStore` - Store data, products, cart for customer view
- `useStoreStore` - Current store for admin context

**Local State (React useState)**
- Form inputs and validation
- UI state (modals, active tabs)
- Loading/processing indicators

### Component Size Guidelines

| Component Type | Target Lines | Example |
|---------------|--------------|---------|
| Page/Route | < 200 | `$storeId.tsx` (127 lines) |
| Container | < 150 | `ProductsTab.tsx` (145 lines) |
| Presentational | < 100 | `CartView.tsx` (95 lines) |
| Helper | < 50 | `StatusBadge` (15 lines) |

### Import Conventions

Components are exported via barrel files for clean imports:

```tsx
// Clean imports via barrel exports
import { ProductsView, CartView, CheckoutView } from '../../components/storefront';
import { AdminSidebar, DashboardTab } from '../../components/admin';
import { LoadingSpinner, EmptyState } from '../../components/common';
import { CartIcon, BackArrowIcon } from '../../components/icons';
```

### JSDoc Documentation

All components include JSDoc comments describing their purpose and props:

```tsx
/**
 * Product card component for grid display.
 * Shows product image, title, price, and add to cart button.
 *
 * @param props - Product card configuration
 * @returns Product card element with image, details, and actions
 */
export function ProductCard({ product, primaryColor, onSelectProduct, onAddToCart }: ProductCardProps) {
  // ...
}
```

### Key Design Decisions

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Routing | Tanstack Router | React Router | Type-safe routing, file-based routes |
| State | Zustand | Redux | Simpler API, less boilerplate |
| Styling | Tailwind CSS | CSS Modules | Utility-first, rapid development |
| Icons | SVG components | Icon library | Full control, tree-shaking |
| Forms | Controlled inputs | React Hook Form | Simpler for current scale |
