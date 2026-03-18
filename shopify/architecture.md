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

## Frontend Architecture

### Technology Stack

React 19 + TypeScript + Vite + TanStack Router (file-based routing) + Zustand (state management) + Tailwind CSS. SVG icons are isolated in `components/icons/` with a barrel export.

### Component Hierarchy

```
__root.tsx (minimal root with Outlet)
├── index.tsx              → HomePage: landing page (unauthenticated) or store list (authenticated)
├── login.tsx              → Login form for merchants
├── register.tsx           → Registration form for merchants
├── admin/$storeId.tsx     → AdminLayout: sidebar nav + tabbed content for store management
│   ├── DashboardTab       → Revenue, order, and customer stats
│   ├── ProductsTab        → Product CRUD with variant management
│   ├── OrdersTab          → Order list with status updates
│   ├── CustomersTab       → Customer list
│   └── SettingsTab        → Store name, description, theme colors
└── store/$subdomain.tsx   → StorefrontPage: customer-facing shopping experience
    ├── ProductsView       → Product grid with add-to-cart buttons
    ├── ProductDetailView  → Single product with variant selection
    ├── CartView           → Cart items with quantity controls
    ├── CheckoutView       → Shipping/billing form + order summary
    └── SuccessView        → Order confirmation
```

### Zustand Stores

**`useAuthStore`** (in `stores/auth.ts`) -- manages merchant authentication: login, registration, logout, and session validation via `checkAuth()`. The store drives the home page's conditional rendering: unauthenticated users see a landing page with sign-in/register buttons, while authenticated merchants see their store list.

**`useStoreStore`** (in `stores/auth.ts`) -- manages the merchant's store list. The `fetchStores()` action loads all stores owned by the current merchant. The `createStore()` action creates a new store and appends it to the local stores array, providing an optimistic update (the new store appears in the list immediately without a full refetch). The `setCurrentStore()` action tracks which store is currently being managed in the admin panel.

**`useStorefrontStore`** (in `stores/storefront.ts`) -- manages the customer-facing shopping experience for a single tenant. This store is scoped to a subdomain (the `subdomain` field tracks which store the customer is browsing). It stores the `store` metadata (name, theme, logo), `products` array, and `cart` object. The `addToCart()` and `updateCartItem()` actions send requests to the storefront API and update the local cart state with the server's response (the server is the source of truth for cart contents since inventory validation happens server-side). The `getCartItemCount()` derived getter sums quantities across all line items for the cart badge.

### Dual-Persona Architecture

The frontend serves two completely different user experiences from the same application:

1. **Merchant Admin** (`/admin/$storeId`) -- a sidebar-navigated dashboard where merchants manage their store's products, orders, customers, and settings. The admin panel uses a traditional tabbed layout with `AdminSidebar` for navigation and individual tab components for content. Data is fetched per-tab to avoid loading unnecessary data.

2. **Customer Storefront** (`/store/$subdomain`) -- a customer-facing shopping experience themed with the store's colors. The storefront uses a state-machine navigation pattern rather than URL-based routing: a `view` state variable controls which component renders (`'products'`, `'product'`, `'cart'`, `'checkout'`, `'success'`). This simplifies the storefront flow because transitions between views can carry data (like the selected product) without URL serialization.

### Theme System

Each store has a `theme` JSONB column with `primaryColor` and `secondaryColor`. The storefront dynamically applies the primary color to buttons, headers, and accents via inline `style` attributes (e.g., `style={{ backgroundColor: primaryColor }}`). This allows each merchant's storefront to feel unique without separate CSS bundles. The `StorefrontHeader` and `StorefrontFooter` components receive `primaryColor` as a prop and apply it to their background.

### Data Fetching Patterns

The API client (`services/api.ts`) is organized into domain-specific modules: `authApi`, `storesApi`, `productsApi`, `variantsApi`, `collectionsApi`, `ordersApi`, `customersApi`, and `storefrontApi`. Each module exports typed functions wrapping the generic `request()` helper, which includes `credentials: 'include'` for cookie-based session auth and handles JSON error responses.

**Parallel loading**: The admin layout uses `Promise.all` to fetch store details and analytics simultaneously when the page mounts, halving the perceived load time.

**Storefront initialization**: When a customer visits `/store/$subdomain`, three requests fire in parallel: `fetchStore()`, `fetchProducts()`, and `fetchCart()`. The storefront renders a loading spinner until all three resolve, ensuring the customer sees a complete page rather than a partially loaded one.

### Cart Management

The storefront cart uses a server-authoritative model. When the customer clicks "Add to Cart," the frontend calls `storefrontApi.addToCart()` and replaces the local cart state with the server's response. This ensures the cart always reflects accurate inventory and pricing (the server validates stock availability before adding items). The trade-off is that every cart interaction requires a network round-trip, adding latency. For a learning project, this is acceptable; a production system might use optimistic updates with server-side reconciliation.

The cart persists via a `session_id` cookie for anonymous shoppers. If the customer has a customer account, the cart is linked to their `customer_id`, allowing cart recovery across sessions.

### Store Creation Flow

The home page includes a modal for creating new stores. The form validates subdomain format on the client side (lowercase alphanumeric + hyphens only, enforced via regex in the `onChange` handler). On submission, `useStoreStore.createStore()` sends a POST request and, on success, appends the new store to the local store list and navigates to `admin/$storeId` for the new store. This provides a seamless onboarding experience where merchants go from "Create Store" to "Manage Store" in one click.

### Key UI Patterns

- **Conditional landing**: Unauthenticated users see a gradient hero with sign-in/register CTAs; authenticated users see their store grid with status badges and manage/view links
- **Store cards**: Grid of store cards showing name, subdomain, status badge (active/inactive), description excerpt, and two action buttons (Manage, View Store)
- **Admin sidebar**: Persistent sidebar with store name, navigation items (Dashboard, Products, Orders, Customers, Settings), and a link back to the store list
- **Product grid**: Storefront products displayed in a responsive grid with image placeholders (using `ImagePlaceholderIcon`), price, and "Add to Cart" button styled in the store's primary color
- **Checkout flow**: Multi-step form (cart review, shipping address, order confirmation) with a sticky order summary sidebar
- **Loading states**: Consistent spinner component (`LoadingSpinner`) and empty state component (`EmptyState`) used across all pages
- **SVG icon components**: Separated into `components/icons/` directory with dedicated components for cart, check, back arrow, and image placeholder, avoiding inline SVG clutter

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Role-Based Access Control (RBAC)

RBAC restricts system access based on roles assigned to users rather than managing permissions per user individually. In a multi-tenant e-commerce platform, RBAC operates at two levels: platform-level roles (merchant vs. platform admin) and tenant-level roles (store owner vs. store staff).

In this project, the `users` table has a `role` column with values `'merchant'` and `'admin'`. Merchants can only access stores they own (enforced by checking `stores.owner_id = users.id`). Platform admins bypass tenant restrictions for support and moderation tasks. At the database level, PostgreSQL Row-Level Security policies enforce that queries only return rows where `store_id` matches the current tenant context, regardless of what the application code requests. This means even a bug in the application code cannot leak data between tenants.

The frontend enforces RBAC by conditionally rendering UI elements. The admin panel is only accessible to authenticated merchants for their own stores. The `beforeLoad` hook in the root route checks auth status before rendering.

### Redis Cache-Aside

Cache-aside means the application checks a cache (Valkey/Redis) before querying the database. On a cache hit, the cached data is returned immediately. On a cache miss, the application queries PostgreSQL, writes the result to the cache with a TTL, and returns the result.

In this project, cache-aside is used for domain-to-store lookups and cart sessions. When a customer visits a custom domain (e.g., `mystore.com`), the system first checks Valkey for a `domain:mystore.com -> store_id` mapping. If found, the request proceeds immediately. If not found, the system queries the `custom_domains` table, caches the result, and proceeds. At production scale with 500K custom domains, this avoids a database query on every page load.

Cart sessions use Valkey to cache cart contents. Since cart data changes frequently (every add/remove), the TTL is kept short and the cache is invalidated on every cart mutation.

The "aside" in cache-aside means the cache is a side-channel -- the database remains the source of truth. If Valkey goes down, the application falls back to direct database queries (slower but functional). This is implemented as part of the circuit breaker fallback strategy.

### Circuit Breaker

A circuit breaker prevents cascading failures by detecting when a downstream service is failing and short-circuiting requests to it. The name comes from electrical circuit breakers that trip to prevent damage from excessive current.

The breaker has three states. **CLOSED** (normal): requests flow through and failures are counted. **OPEN** (tripped): all requests immediately fail with a fallback response, giving the failing service time to recover. **HALF-OPEN** (testing): after a timeout, a few test requests are allowed through to check recovery.

In this project, circuit breakers protect three external service calls:

- **Stripe (payments)**: If Stripe is down, checkout queues the order as `payment_pending` rather than failing outright. The merchant can reconcile later.
- **Valkey (cache)**: If Valkey is down, the application skips caching and queries PostgreSQL directly. Latency increases but functionality is preserved.
- **RabbitMQ (queues)**: If RabbitMQ is down, order events are written to a fallback database table instead of being published to the queue. Background workers process the fallback table when RabbitMQ recovers.

The implementation uses the Opossum library (`backend/src/services/circuit-breaker.ts`). Each breaker is configured with service-specific parameters: Stripe has a 30-second timeout and 60-second reset (payments are slow and important), while Valkey has a 3-second timeout and 15-second reset (cache misses are tolerable).

### Structured Logging

Structured logging emits log entries as JSON objects instead of freeform text. A traditional log line like `"Order 456 created for store 12, total $89.99"` is human-readable but machine-hostile. A structured entry like `{"orderId":456,"storeId":12,"total":89.99,"action":"order.created","level":"info"}` can be indexed, searched, and aggregated by log management systems.

In this project, structured logging uses Pino (`backend/src/services/logger.ts`). Every request gets a child logger with tenant context attached (`storeId`, `requestId`, `correlationId`). This means when debugging a checkout failure for store 12, an operator can filter all log entries by `storeId=12` and see the complete request flow: session validation, inventory check, payment attempt, order creation. Without structured logging, the operator would need to manually correlate freeform log lines by timestamp, which is error-prone in a high-throughput system.

The multi-tenant nature of the platform makes structured logging especially valuable. Since all tenants share the same application instances, freeform logs from different stores would be interleaved. The `storeId` field in every log entry makes tenant-scoped debugging possible.

### Prometheus Metrics

Prometheus is a time-series database that scrapes metrics from application HTTP endpoints. The application exposes counters, gauges, and histograms at `GET /metrics`, and Prometheus periodically fetches this endpoint to collect the data.

In this project, metrics are implemented using `prom-client` (`backend/src/services/metrics.ts`). The key metrics include:

- `shopify_checkouts_total{store_id, status}` (Counter): tracks checkout success/failure rate per store. An alert fires if the success rate drops below 99%.
- `shopify_order_value_dollars{store_id}` (Histogram): tracks order value distribution, useful for detecting anomalies (e.g., a sudden spike in high-value orders might indicate fraud).
- `shopify_inventory_level{store_id, variant_id}` (Gauge): real-time stock levels, enabling low-stock alerts.
- `shopify_queue_depth{queue_name}` (Gauge): RabbitMQ backlog monitoring. A growing queue depth indicates workers cannot keep up.

SLIs (Service Level Indicators) are defined from these metrics: checkout availability (99.9% target), product page p95 latency (< 100ms target), API error rate (< 1% target), and queue processing lag (< 30 seconds target).

### Rate Limiting

Rate limiting restricts request frequency to prevent abuse and ensure fair resource distribution. In a multi-tenant platform, rate limiting is especially important because one tenant's traffic spike should not degrade other tenants' experience.

In this project, rate limits operate at two levels. Per-store API limits prevent a single merchant from consuming disproportionate backend resources (e.g., by running aggressive inventory sync scripts). Checkout endpoints have stricter limits to prevent abuse (e.g., automated checkout bots). Storefront endpoints (customer-facing) scale independently from admin API endpoints because customer traffic is higher volume and more latency-sensitive.

The implementation uses sliding window counters in Valkey, keyed by `store_id` for merchant APIs and by IP address for storefront APIs. When a limit is exceeded, the API returns 429 Too Many Requests with a `Retry-After` header.

### Idempotency

Idempotency ensures that performing the same operation multiple times produces the same result as performing it once. This is critical for checkout because network failures can cause retries: the customer clicks "Place Order," the server creates the order, but the response is lost. The customer clicks again. Without idempotency, a second order is created and the customer is charged twice.

In this project, the checkout endpoint requires an `Idempotency-Key` header. The flow is:

1. Check the `idempotency_keys` table for an existing key matching this `store_id` and operation.
2. If found with `status = 'completed'`, return the cached response (no reprocessing).
3. If found with `status = 'processing'`, return 409 Conflict (concurrent duplicate detected).
4. If not found, insert with `status = 'processing'` and proceed.
5. On success, update to `status = 'completed'` and cache the response.
6. On failure, update to `status = 'failed'` to allow retry.

The implementation (`backend/src/services/idempotency.ts`) stores idempotency keys in a dedicated PostgreSQL table with a 24-hour TTL enforced by a background cleanup job. The table's `UNIQUE(idempotency_key, store_id, operation)` constraint prevents cross-tenant key collisions.

Stripe webhook processing has its own idempotency layer: the `processed_webhooks` table stores event IDs to prevent duplicate webhook handling, with 7-day retention.

### Health Checks

Health checks are HTTP endpoints that report service status. Load balancers use them to route traffic only to healthy instances. Kubernetes uses them to restart failed containers and to delay traffic to instances that are still initializing.

There are three common types:

- **Liveness** (`/api/health`): "Is the process running?" Returns 200 if the HTTP server can respond. If this fails, the process should be restarted.
- **Readiness** (`/api/health/ready`): "Can this instance handle traffic?" Returns 200 only when all critical dependencies (PostgreSQL, Valkey) are connected. A newly started instance returns 503 until connections are established.
- **Detailed** (`/api/health/detailed`): Reports per-dependency status (PostgreSQL, Valkey, RabbitMQ). Used by operators to quickly diagnose which component is failing.

In this project, each dependency check runs a lightweight operation (`SELECT 1` for PostgreSQL, `PING` for Valkey) with its own timeout. The overall status is "unhealthy" if any critical dependency is down and "degraded" if a non-critical dependency (like RabbitMQ, which has a database fallback) is unavailable.

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
