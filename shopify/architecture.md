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

1. **Store**: Merchants create branded stores with custom themes
2. **Products**: Manage catalog with variants and inventory
3. **Checkout**: Secure payment processing with cart management
4. **Orders**: Process, fulfill, and track orders
5. **Analytics**: Sales and customer insights per store

### Non-Functional Requirements

- **Availability**: 99.99% for checkout flows
- **Isolation**: Complete data separation between merchants
- **Latency**: < 100ms for product pages, < 200ms for checkout
- **Scale**: 1M+ stores, 100M+ products across all tenants
- **Consistency**: Strong consistency for inventory and payments

---

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Active stores | 1M | Total merchant base |
| Products (total) | 100M | ~100 products/store average |
| Peak orders/second | 10,000 | Flash sales, holiday traffic |
| Custom domains | 500K | ~50% of stores use custom domains |
| Concurrent shoppers | 5M | Across all storefronts |

### Storage Estimates

| Data | Size | Growth Rate |
|------|------|------------|
| Product catalog | 2 TB | 200 GB/year |
| Orders (hot, < 2 years) | 5 TB | 2 TB/year |
| Media (product images) | 50 TB | 20 TB/year |
| Sessions + carts | 50 GB | Ephemeral |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Client Layer                                  │
│     Storefront (shoppers)  │  Admin Dashboard (merchants)                │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         CDN / Edge Layer                                 │
│   Custom Domain Resolution  │  SSL Termination  │  Static Asset Cache   │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          API Gateway                                     │
│          Tenant context injection  │  Rate limiting  │  Auth             │
└──────────────────────────────────────────────────────────────────────────┘
           │                        │                        │
           ▼                        ▼                        ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────────┐
│   Store Service    │  │  Product Service   │  │   Checkout Service     │
│                    │  │                    │  │                        │
│ - Settings/Themes  │  │ - Catalog CRUD     │  │ - Cart management      │
│ - Domain routing   │  │ - Variants         │  │ - Payment (Stripe)     │
│ - Merchant auth    │  │ - Collections      │  │ - Order creation       │
│ - Customer mgmt    │  │ - Inventory        │  │ - Idempotency          │
└────────────────────┘  └────────────────────┘  └────────────────────────┘
           │                        │                        │
           ▼                        ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Data Layer                                     │
├──────────────────┬──────────────────┬────────────────────────────────────┤
│    PostgreSQL    │   Valkey/Redis   │           RabbitMQ                 │
│  (with RLS per  │  (sessions,      │  (order events, webhooks,          │
│   tenant)       │   cart cache)    │   email notifications)             │
└──────────────────┴──────────────────┴────────────────────────────────────┘
```

---

## Core Components

### 1. Multi-Tenant Data Model

**Approach: Shared Database with Row-Level Security**

Every table includes a `store_id` column. PostgreSQL RLS policies enforce that queries only see rows belonging to the current tenant. The application sets `app.current_store_id` per connection before executing queries.

```sql
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_isolation_products ON products
  FOR ALL
  USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::integer);
```

**Why Shared DB + RLS over Schema-Per-Tenant:**

Schema-per-tenant creates one PostgreSQL schema per store. With 1M stores, this means 1M schemas, each with its own set of tables. This causes: (a) connection pool bloat since each schema needs separate connections, (b) migration nightmares as schema changes must apply to every schema, (c) catalog table bloat in `pg_class` degrading planner performance.

Shared DB + RLS keeps a single schema with a `store_id` column on every table. RLS enforces isolation at the database level, meaning even a bug in application code cannot leak data cross-tenant. The trade-off is that cross-tenant analytics queries are impossible by design -- admin analytics require a superuser connection that bypasses RLS.

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
│ Domain Lookup   │──▶ Valkey: domain → store_id (sub-ms)
│ (Edge/CDN)      │    Fallback: PostgreSQL custom_domains table
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Route to Store  │──▶ Set tenant context, render storefront
└─────────────────┘
```

Domain registration involves DNS TXT record verification, SSL certificate provisioning via Let's Encrypt, and caching the domain-to-store mapping in Valkey at the edge for sub-millisecond lookups.

### 3. Checkout Flow

The checkout is the most critical path in the system. It must handle concurrent buyers, prevent overselling, and tolerate network failures without creating duplicate orders.

**Sequence:**
1. Validate inventory (SELECT FOR UPDATE on variant rows)
2. Reserve inventory within a database transaction
3. Process payment via Stripe (circuit breaker protected)
4. Create order with idempotency key
5. Commit inventory deduction
6. Publish `order.created` event to RabbitMQ (non-blocking)
7. Return success to customer

If payment fails, reserved inventory is released. If the network times out and the customer retries, the idempotency key ensures the same order is returned without double-charging.

### 4. Theme System

Merchants customize their storefronts through theme configuration stored as JSONB in the `stores.theme` column. The theme defines primary/secondary colors, layout preferences, and branding. At production scale, themes would use a Liquid-like template engine with sandboxed rendering to prevent arbitrary code execution.

---

## Database Schema

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table (platform-level)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(200),
  role VARCHAR(20) DEFAULT 'merchant', -- 'admin', 'merchant'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Stores (tenants)
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  subdomain VARCHAR(50) UNIQUE NOT NULL,
  custom_domain VARCHAR(255),
  description TEXT,
  logo_url VARCHAR(500),
  currency VARCHAR(3) DEFAULT 'USD',
  stripe_account_id VARCHAR(100),
  settings JSONB DEFAULT '{}',
  theme JSONB DEFAULT '{"primaryColor": "#4F46E5", "secondaryColor": "#10B981"}',
  plan VARCHAR(50) DEFAULT 'basic',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Custom domains
CREATE TABLE custom_domains (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  domain VARCHAR(255) UNIQUE NOT NULL,
  verified BOOLEAN DEFAULT false,
  verification_token VARCHAR(100),
  ssl_provisioned BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products (tenant-isolated)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  handle VARCHAR(200),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  images JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'active', 'archived'
  tags JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

-- Variants (size, color combinations)
CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  sku VARCHAR(100),
  title VARCHAR(200),
  price DECIMAL(10, 2) NOT NULL,
  compare_at_price DECIMAL(10, 2),
  inventory_quantity INTEGER DEFAULT 0,
  options JSONB DEFAULT '{}',
  weight DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Collections (product groupings)
CREATE TABLE collections (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  handle VARCHAR(200),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  image_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

-- Collection products (many-to-many)
CREATE TABLE collection_products (
  id SERIAL PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  UNIQUE(collection_id, product_id)
);

-- Customers (per-store)
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(50),
  accepts_marketing BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, email)
);

-- Carts
CREATE TABLE carts (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  session_id VARCHAR(255),
  items JSONB DEFAULT '[]',
  subtotal DECIMAL(10, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  order_number VARCHAR(50) NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_email VARCHAR(255),
  subtotal DECIMAL(10, 2),
  shipping_cost DECIMAL(10, 2) DEFAULT 0,
  tax DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2),
  payment_status VARCHAR(30) DEFAULT 'pending',
  fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
  shipping_address JSONB,
  billing_address JSONB,
  notes TEXT,
  stripe_payment_intent_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order line items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  title VARCHAR(200),
  variant_title VARCHAR(200),
  sku VARCHAR(100),
  quantity INTEGER NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions (for auth)
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  data JSONB DEFAULT '{}',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Idempotency keys
CREATE TABLE idempotency_keys (
  id SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(64) NOT NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE NOT NULL,
  operation VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'processing',
  request_params JSONB,
  response_data JSONB,
  resource_id INTEGER,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(idempotency_key, store_id, operation)
);

-- Audit logs
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  actor_id INTEGER,
  actor_type VARCHAR(20),     -- 'merchant', 'customer', 'system', 'admin'
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),
  resource_id INTEGER,
  changes JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Processed webhooks (replay protection)
CREATE TABLE processed_webhooks (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(100) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- RLS policies on all tenant tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
```

### Index Strategy

```sql
CREATE INDEX idx_products_store_id ON products(store_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_variants_product_id ON variants(product_id);
CREATE INDEX idx_variants_store_id ON variants(store_id);
CREATE INDEX idx_orders_store_id ON orders(store_id);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_customers_store_id ON customers(store_id);
CREATE INDEX idx_carts_store_id ON carts(store_id);
CREATE INDEX idx_carts_session_id ON carts(session_id);
CREATE INDEX idx_stores_subdomain ON stores(subdomain);
CREATE INDEX idx_custom_domains_domain ON custom_domains(domain);
CREATE INDEX idx_idempotency_keys_lookup ON idempotency_keys(idempotency_key, store_id, operation);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);
CREATE INDEX idx_audit_logs_store_created ON audit_logs(store_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id, created_at DESC);
```

---

## API Design

### Merchant Admin API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Register merchant account |
| POST | `/api/auth/login` | Login and create session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/stores/:id` | Get store details |
| PUT | `/api/stores/:id` | Update store settings |
| GET | `/api/stores/:id/products` | List store products |
| POST | `/api/stores/:id/products` | Create product |
| PUT | `/api/stores/:id/products/:pid` | Update product |
| DELETE | `/api/stores/:id/products/:pid` | Delete product |
| GET | `/api/stores/:id/orders` | List store orders |
| PUT | `/api/stores/:id/orders/:oid` | Update order status |
| GET | `/api/stores/:id/customers` | List store customers |
| GET | `/api/stores/:id/analytics` | Dashboard analytics |

### Storefront API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/storefront/:subdomain` | Get store info + products |
| GET | `/api/storefront/:subdomain/products/:id` | Product detail |
| POST | `/api/storefront/:subdomain/cart` | Create/get cart |
| POST | `/api/storefront/:subdomain/cart/items` | Add item to cart |
| PUT | `/api/storefront/:subdomain/cart/items/:id` | Update cart item |
| DELETE | `/api/storefront/:subdomain/cart/items/:id` | Remove from cart |
| POST | `/api/storefront/:subdomain/checkout` | Process checkout |

---

## Key Design Decisions

### 1. Shared Database with Row-Level Security

**Decision**: Single PostgreSQL database, row-level security per tenant.

Shared DB + RLS was chosen over schema-per-tenant because operational simplicity scales better with 1M+ tenants. Schema-per-tenant would require creating and migrating 1M schemas for every DDL change, consuming excessive connection pool resources, and bloating PostgreSQL's catalog tables. RLS enforces isolation at the database layer -- even if application code has a bug, data cannot leak between tenants. The cost is that platform-wide analytics (e.g., "total GMV across all stores") requires a superuser connection that bypasses RLS, adding an extra layer of complexity for internal tooling.

### 2. Stripe Connect for Payments

**Decision**: Delegate payment processing to Stripe Connect.

Building payment processing in-house means achieving PCI-DSS Level 1 compliance, which requires annual audits, penetration testing, and dedicated security infrastructure. Stripe Connect handles all of this, plus marketplace-style payouts where the platform takes a cut and routes funds to merchants. The trade-off is vendor lock-in and Stripe's per-transaction fees (2.9% + $0.30). For a platform where payment reliability directly impacts merchant trust, the operational overhead of running our own payment infrastructure far outweighs Stripe's fees.

### 3. RabbitMQ for Async Processing

**Decision**: Use RabbitMQ for decoupling checkout from downstream processing.

The checkout critical path must be fast. Synchronous webhook delivery, email sending, and analytics aggregation during checkout would add latency and create fragile dependencies. If a merchant's webhook endpoint is slow or down, checkout should not fail. RabbitMQ decouples these concerns: the checkout publishes an `order.created` event and returns immediately. Dedicated workers consume events for email, webhooks, inventory alerts, and analytics. Kafka was considered but RabbitMQ's simpler operational model and built-in dead-letter queues are sufficient. The trade-off is that RabbitMQ does not retain messages for replay; once consumed and acknowledged, they are gone. For audit and replay needs, we rely on the audit_logs table.

---

## Consistency and Idempotency

### Write Consistency Model

**Order and Payment Writes: Strong Consistency**
- Use `SERIALIZABLE` isolation with `SELECT FOR UPDATE` on inventory rows during checkout
- All inventory deduction, order creation, and payment recording happen in a single transaction
- No eventual consistency for financial operations

**Product and Catalog Writes: Eventual Consistency**
- Product updates use read-committed isolation (default)
- Cache invalidation is asynchronous (1-5 second lag acceptable)

### Idempotency Implementation

The checkout endpoint requires an `Idempotency-Key` header. The flow:

1. Check `idempotency_keys` table for existing key with matching `store_id` and operation
2. If found with `status = 'completed'`, return the cached response (no reprocessing)
3. If found with `status = 'processing'`, reject with 409 Conflict (prevents concurrent duplicates)
4. If not found or `status = 'failed'`, insert/update with `status = 'processing'` and proceed
5. On success, update to `status = 'completed'` with cached response
6. On failure, update to `status = 'failed'` to allow retry

Keys have a 24-hour TTL enforced by a background cleanup job.

### Webhook Replay Handling

All webhook handlers are idempotent using event IDs stored in `processed_webhooks`. Stripe webhook signature verification prevents spoofed events. The table has 7-day retention.

---

## Async Queue Architecture

### Queue Topology

```
┌──────────────────────────────────────────────────────────────┐
│                    RabbitMQ Exchanges                         │
├──────────────────────────────────────────────────────────────┤
│  orders.events (fanout)        │  inventory.events (topic)   │
│  └── orders.created            │  └── inventory.low.*        │
│  └── orders.fulfilled          │  └── inventory.out.*        │
│  └── orders.cancelled          │                              │
├──────────────────────────────────────────────────────────────┤
│  notifications (direct)        │  background (direct)         │
│  └── email.send                │  └── search.index           │
│  └── webhook.deliver           │  └── analytics.aggregate    │
└──────────────────────────────────────────────────────────────┘
```

### Queue Delivery Semantics

| Queue | Durability | Delivery | TTL | Use Case |
|-------|-----------|----------|-----|----------|
| orders.processing | Durable | At-least-once, manual ack | 24h | Order fulfillment |
| notifications.email | Durable | At-least-once, 3 retries | 24h | Order confirmation emails |
| webhooks.deliver | Durable | At-least-once, 5 retries + backoff | 24h | Merchant webhook delivery |
| search.index | Non-durable | At-most-once | 5 min | Search re-indexing |

All order and payment queues use dead-letter exchanges for failed messages. Consumers implement their own idempotency via message IDs. At-least-once delivery is chosen over exactly-once because downstream operations (emails, webhooks) are inherently idempotent -- re-sending an email is annoying but acceptable; missing an email is not.

---

## Security / Auth

### Authentication

- **Merchant auth**: Session-based with cookies stored in Valkey. Sessions expire after 24 hours of inactivity.
- **Customer auth**: Per-store customer accounts with bcrypt-hashed passwords. Customers are scoped to a single store via `UNIQUE(store_id, email)`.
- **Storefront cart**: Session-based cart using `session_id` for anonymous shoppers, linked to `customer_id` after login.

### Authorization

- RLS policies enforce tenant isolation at the database level
- Application middleware sets `app.current_store_id` on every database connection
- A separate `shopify_app` database user with limited privileges runs application queries

### Rate Limiting

- Per-store API rate limits prevent a single merchant from degrading platform performance
- Checkout endpoints have stricter limits to prevent abuse
- Storefront endpoints scale independently from admin API

---

## Observability

### Metrics (Prometheus)

Key metrics exposed at `GET /metrics`:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_request_duration_seconds` | Histogram | method, route, status_code | API latency tracking |
| `shopify_checkouts_total` | Counter | store_id, status | Checkout success/failure rate |
| `shopify_order_value_dollars` | Histogram | store_id | Order value distribution |
| `shopify_inventory_level` | Gauge | store_id, variant_id | Real-time stock levels |
| `shopify_queue_depth` | Gauge | queue_name | RabbitMQ backlog monitoring |

### SLI/SLO Dashboard

| SLI | Target | Measurement |
|-----|--------|-------------|
| Checkout availability | 99.9% | `rate(checkouts_total{status="success"}[5m]) / rate(checkouts_total[5m])` |
| Product page latency p95 | < 100ms | `histogram_quantile(0.95, http_request_duration_seconds{route="/products"})` |
| API error rate | < 1% | `rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m])` |
| Queue processing lag | < 30s | `time() - oldest_message_timestamp` |

### Structured Logging (Pino)

JSON-formatted logs with request IDs, store IDs, and correlation IDs for distributed tracing. Every request gets a child logger with tenant context attached.

### Audit Logging

Immutable audit trail in `audit_logs` table tracking order lifecycle events, inventory adjustments, admin actions, and configuration changes. INSERT-only -- application code never updates or deletes audit records. Indexed on `(store_id, created_at)` for efficient tenant-scoped queries during dispute resolution.

---

## Failure Handling

### Circuit Breakers

Circuit breakers (Opossum library) protect against cascading failures from external services:

| Service | Timeout | Error Threshold | Reset Timeout | Fallback |
|---------|---------|-----------------|---------------|----------|
| Stripe (payments) | 30s | 25% of 5 requests | 60s | Queue as payment_pending |
| Valkey (cache) | 3s | 50% of 10 requests | 15s | Skip cache, query DB |
| RabbitMQ | 5s | 30% of 5 requests | 30s | Write to fallback DB table |

### Retry Strategy

Exponential backoff with jitter for transient failures. Maximum 3 retries for payment processing, 5 retries for webhook delivery.

### Graceful Degradation

- If RabbitMQ is down, order creation still succeeds but notifications are delayed (written to a fallback table)
- If Valkey is down, sessions fall back to PostgreSQL-backed sessions (higher latency)
- If Stripe is down, checkout returns a clear error; no silent failures

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless, scale horizontally behind a load balancer. Session state lives in Valkey.
2. **PostgreSQL read replicas**: Route read-heavy storefront queries to replicas. Writes (orders, inventory) go to primary.
3. **Tenant-based sharding**: At extreme scale (10M+ stores), shard PostgreSQL by `store_id` ranges. RLS policies work per-shard.
4. **Queue workers**: Scale independently based on queue depth. Add workers for specific queues during flash sales.

### What Breaks First

1. **Single PostgreSQL primary** becomes the write bottleneck as order volume grows. Solution: shard by store_id.
2. **RabbitMQ** under heavy webhook delivery load. Solution: add nodes to the cluster.
3. **Domain resolution latency** with 1M+ custom domains. Solution: edge caching with CDN workers.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | Operational simplicity at 1M+ stores |
| Domain routing | Edge cache (Valkey) | Database lookup per request | Sub-millisecond lookups for custom domains |
| Payments | Stripe Connect | Custom payment processing | PCI compliance, marketplace payouts |
| Themes | JSONB config | Liquid template engine | Simpler for learning; production would use Liquid |
| Message queue | RabbitMQ | Kafka | Simpler ops, DLQ support, sufficient throughput |
| Metrics | Prometheus + Grafana | Datadog | Self-hosted, free for development |
| Logging | Pino (JSON) | Winston | Better performance, native JSON output |

---

## Implementation Notes

This section documents the actual local implementation and maps production-scale design to what runs on Docker + Node.js + React.

### Local Architecture

```
┌───────────────────┐         ┌────────────────────┐
│  React Frontend   │────────▶│  Express Backend   │
│  localhost:5173   │         │  localhost:3001     │
└───────────────────┘         └────────────────────┘
                                 │      │      │
                    ┌────────────┘      │      └────────────┐
                    ▼                   ▼                    ▼
            ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
            │  PostgreSQL  │  │    Valkey     │  │   RabbitMQ     │
            │  :5432       │  │    :6379      │  │   :5672/:15672 │
            └──────────────┘  └──────────────┘  └────────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | File | Purpose |
|---------|------|---------|
| Idempotency | `backend/src/services/idempotency.ts` | Prevents duplicate orders on checkout retry |
| Circuit breaker | `backend/src/services/circuit-breaker.ts` | Protects against Stripe and Valkey failures (Opossum) |
| Async queues | `backend/src/services/rabbitmq.ts` | Decouples checkout from email/webhook/inventory workers |
| Structured logging | `backend/src/services/logger.ts` | JSON logs with Pino for request tracing |
| Prometheus metrics | `backend/src/services/metrics.ts` | Checkout counters, latency histograms, inventory gauges |
| Audit logging | `backend/src/services/audit.ts` | Immutable audit trail for orders and inventory changes |
| Row-Level Security | `backend/src/db/init.sql` | PostgreSQL RLS policies on all tenant tables |
| Background workers | `backend/src/workers/order-worker.ts`, `inventory-worker.ts`, `webhook-worker.ts`, `email-worker.ts` | Consume RabbitMQ queues for async processing |

### What Was Simplified or Substituted

| Production | Local | Reason |
|------------|-------|--------|
| Stripe Connect (real payments) | Mocked payment processing | No real Stripe account needed for learning |
| CDN + edge domain resolution | Direct subdomain routing via Express | No CDN infrastructure locally |
| Liquid template engine | JSONB theme config (colors only) | Simpler; demonstrates the concept |
| Multiple API instances + LB | Single Express server (supports 3001-3003) | Can test with multiple ports manually |
| Kubernetes + auto-scaling | docker-compose | Sufficient for local development |
| Multi-region PostgreSQL | Single PostgreSQL instance | No replication needed locally |

### What Was Omitted

- **CDN**: No static asset caching or edge workers
- **SSL certificate provisioning**: Custom domains table exists but Let's Encrypt integration is not implemented
- **Multi-region replication**: Single PostgreSQL instance
- **Kubernetes orchestration**: docker-compose only
- **Real Stripe webhooks**: No webhook endpoint for Stripe event processing
- **Search**: No Elasticsearch; product listing relies on PostgreSQL queries
- **Sharding**: Single database instance; no horizontal partitioning
- **OAuth / SSO**: Session-based auth only
