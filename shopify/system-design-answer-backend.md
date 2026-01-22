# Shopify - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

"Design a multi-tenant e-commerce platform like Shopify where each merchant has an isolated store. The core challenges are multi-tenant architecture with complete data isolation, custom domain routing for millions of stores, secure checkout with payment processing, and horizontal scalability."

---

## Requirements Clarification (3 minutes)

### Backend-Specific Requirements
1. **Multi-Tenancy**: Complete data isolation between 1M+ merchants
2. **Checkout Reliability**: 99.99% availability for payment processing
3. **Domain Routing**: Sub-millisecond custom domain resolution
4. **Inventory Management**: ACID guarantees for stock operations
5. **Scalability**: Handle 100M+ products across all stores

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Total stores | 1M+ |
| Total products | 100M+ |
| Concurrent checkouts | 10K+ |
| Custom domains | 500K+ |
| Orders per minute (peak) | 50K |

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EDGE LAYER                                         │
│          CDN (Domain Resolution + SSL Termination + Caching)                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API GATEWAY                                        │
│            (Rate Limiting + Tenant Context + Request Routing)                │
└─────────────────────────────────────────────────────────────────────────────┘
           │                         │                         │
           ▼                         ▼                         ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Store Service  │      │ Product Service │      │Checkout Service │
│                 │      │                 │      │                 │
│ - Merchant CRUD │      │ - Catalog CRUD  │      │ - Cart Session  │
│ - Domain Mgmt   │      │ - Variants      │      │ - Payment Proc  │
│ - Theme Config  │      │ - Inventory     │      │ - Order Create  │
│ - Settings      │      │ - Search Index  │      │ - Fulfillment   │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │                        │                        │
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  PostgreSQL (RLS)  │    Valkey/Redis    │   RabbitMQ    │    Stripe        │
│  - All tenant data │    - Sessions      │   - Webhooks  │    - Payments    │
│  - Row-Level Sec   │    - Domain cache  │   - Emails    │    - Payouts     │
│  - SERIALIZABLE    │    - Cart data     │   - Analytics │    - Connect     │
└────────────────────┴────────────────────┴───────────────┴──────────────────┘
```

---

## Deep Dive 1: Multi-Tenant Data Architecture (12 minutes)

### Option Analysis

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| Database Per Tenant | Separate DB for each store | Complete isolation, independent scaling | Operational nightmare at 1M stores, connection pooling, migrations |
| Schema Per Tenant | Separate schema per store | Good isolation, single database | Schema migrations across 1M schemas, connection issues |
| **Shared DB + RLS** | Single DB with row-level security | Simple operations, efficient, scales to millions | Requires careful query discipline (mitigated by RLS) |

"I chose shared database with PostgreSQL Row-Level Security. At 1M+ stores, managing separate databases or schemas becomes an operational nightmare. RLS provides database-level isolation, preventing bugs at the application layer from leaking data."

### Row-Level Security Implementation

```
┌─────────────────────────────────────────────────────────────────┐
│                    RLS ENFORCEMENT MODEL                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Session Variable: app.current_store_id                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  POLICY: store_isolation                                  │  │
│  │  USING (store_id = current_setting('app.current_store_id')│  │
│  │  ::integer)                                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Applied to tables:                                              │
│  ├── products (store_id)                                        │
│  ├── variants (store_id)                                        │
│  ├── orders (store_id)                                          │
│  ├── customers (store_id)                                       │
│  └── order_items (store_id)                                     │
│                                                                  │
│  FORCE ROW LEVEL SECURITY: Ensures even table owners use RLS    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Tenant Context Middleware

```
┌─────────────────────────────────────────────────────────────────┐
│                    TENANT RESOLUTION FLOW                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXTRACT HOSTNAME                                                │
│  └── req.hostname                                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│  SUBDOMAIN PATTERN   │        │   CUSTOM DOMAIN      │
│  *.myshopify.local   │        │   verified domain    │
└──────────┬───────────┘        └──────────┬───────────┘
           │                               │
           ▼                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  CHECK REDIS CACHE: tenant:{type}:{identifier}                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│     CACHE HIT        │        │     CACHE MISS       │
│  Return tenant ctx   │        │  Query PostgreSQL    │
└──────────────────────┘        │  Cache for 5 min     │
                                └──────────┬───────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  SET PostgreSQL SESSION VARIABLE                                 │
│  └── SET app.current_store_id = {storeId}                        │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ATTACH TO REQUEST: req.tenant                                   │
│  └── { storeId, subdomain, customDomain, plan }                  │
└─────────────────────────────────────────────────────────────────┘
```

### Database Schema (Core Tables)

**stores** (tenants):
- id, owner_id, name, subdomain (unique), theme_id
- stripe_account_id, settings (JSONB), plan
- created_at, updated_at

**custom_domains**:
- id, store_id, domain (unique)
- verification_token, verified_at, ssl_provisioned_at

**products** (tenant-isolated):
- id, store_id, handle, title, description, status
- UNIQUE(store_id, handle)

**variants** (with inventory tracking):
- id, product_id, store_id, sku, title, price
- compare_at_price, inventory_quantity
- inventory_policy (deny/continue), options (JSONB)
- version (optimistic locking)
- UNIQUE(store_id, sku)

**orders**:
- id, store_id, order_number, customer_email
- subtotal, shipping, tax, total
- payment_status, fulfillment_status
- stripe_payment_intent_id
- shipping_address (JSONB), billing_address (JSONB)

**order_items**:
- id, order_id, store_id, variant_id
- title, variant_title, sku, quantity, price

**checkout_requests** (idempotency tracking):
- id, store_id, idempotency_key (unique with store_id)
- cart_session_id, order_id, status, error_message

### Key Indexes

| Index | Purpose |
|-------|---------|
| idx_products_store_status | Filter products by store and status |
| idx_products_handle | Lookup by URL slug |
| idx_variants_store_sku | Inventory lookups |
| idx_orders_store_created | Order history (descending) |
| idx_custom_domains_domain | Domain resolution |
| idx_checkout_requests_created | Idempotency cleanup |

---

## Deep Dive 2: Checkout Flow with Idempotency (12 minutes)

### Checkout Sequence

```
┌────────────┐   ┌────────────────┐   ┌─────────────┐   ┌────────┐
│  Customer  │   │ Checkout Svc   │   │ PostgreSQL  │   │ Stripe │
└─────┬──────┘   └───────┬────────┘   └──────┬──────┘   └───┬────┘
      │                  │                   │              │
      │ POST /checkout   │                   │              │
      │ Idempotency-Key  │                   │              │
      │─────────────────▶│                   │              │
      │                  │                   │              │
      │                  │ Check idempotency │              │
      │                  │──────────────────▶│              │
      │                  │                   │              │
      │                  │ BEGIN SERIALIZABLE│              │
      │                  │──────────────────▶│              │
      │                  │                   │              │
      │                  │ SELECT FOR UPDATE │              │
      │                  │ (inventory)       │              │
      │                  │──────────────────▶│              │
      │                  │                   │              │
      │                  │ Update inventory  │              │
      │                  │──────────────────▶│              │
      │                  │                   │              │
      │                  │ Create PaymentIntent             │
      │                  │ (with idempotency_key)          │
      │                  │─────────────────────────────────▶│
      │                  │                   │              │
      │                  │ Insert order      │              │
      │                  │──────────────────▶│              │
      │                  │                   │              │
      │                  │ COMMIT            │              │
      │                  │──────────────────▶│              │
      │                  │                   │              │
      │                  │ Publish order.created           │
      │                  │──────────────────▶│ (RabbitMQ)  │
      │                  │                   │              │
      │  Order confirmed │                   │              │
      │◀─────────────────│                   │              │
```

### Idempotency Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    IDEMPOTENCY CHECK                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  SELECT FROM checkout_requests                                   │
│  WHERE store_id = ? AND idempotency_key = ?                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
      ┌────────────────────┼────────────────────┐
      ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐    ┌──────────────┐
│   COMPLETED  │   │  PROCESSING  │    │    FAILED    │
│              │   │              │    │              │
│ Return saved │   │ Return 409   │    │ Delete old   │
│ order result │   │ Conflict     │    │ Allow retry  │
└──────────────┘   └──────────────┘    └──────────────┘
```

"I use idempotency keys to prevent duplicate orders. If a request fails mid-checkout, the client can safely retry with the same key. Stripe also uses this key, so we never double-charge."

### Checkout Service Flow

**Step 1**: Check idempotency - return cached result or reject in-progress

**Step 2**: Get cart from Redis using session ID

**Step 3**: Get store for Stripe Connect account

**Step 4**: Create idempotency record with 'processing' status

**Step 5-6**: BEGIN SERIALIZABLE transaction, lock variants FOR UPDATE

**Step 7**: Validate inventory, decrement quantities

**Step 8**: Create Stripe PaymentIntent (with idempotency key)

**Step 9**: Generate order number using store-specific sequence

**Step 10**: INSERT order and order_items

**Step 11**: COMMIT transaction

**Step 12**: Update idempotency record to 'completed'

**Step 13**: Clear cart from Redis

**Step 14**: Publish order.created event to RabbitMQ

### Inventory Locking Patterns

**Pessimistic (Checkout)**:
- SELECT ... FOR UPDATE during transaction
- SERIALIZABLE isolation level
- Guarantees no overselling

**Optimistic (Admin Adjustments)**:
- Version column for conflict detection
- UPDATE WHERE version = expected_version
- Retry on conflict with user notification

**Bulk Sync (External Systems)**:
- Direct quantity set (no version check)
- Report errors for missing SKUs

---

## Deep Dive 3: Custom Domain Routing (8 minutes)

### Domain Registration Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    DOMAIN REGISTRATION                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. VALIDATE DOMAIN FORMAT                                       │
│     └── Regex: ^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. CHECK UNIQUENESS                                             │
│     └── SELECT store_id FROM custom_domains WHERE domain = ?     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. GENERATE VERIFICATION TOKEN                                  │
│     └── crypto.randomBytes(16).toString('hex')                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. INSERT PENDING DOMAIN                                        │
│     └── Store with verification_token, verified_at = NULL       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. RETURN INSTRUCTIONS                                          │
│     └── "Add TXT record: _shopify-verify.{domain} = {token}"    │
└─────────────────────────────────────────────────────────────────┘
```

### Domain Verification Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    DOMAIN VERIFICATION                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. GET PENDING DOMAIN                                           │
│     └── Check verification_token, verified_at                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. DNS TXT LOOKUP                                               │
│     └── resolveTxt(`_shopify-verify.${domain}`)                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   TOKEN MATCHES      │        │   TOKEN NOT FOUND    │
│                      │        │                      │
│ Mark verified        │        │ Return error with    │
│ Update Redis cache   │        │ expected token       │
│ Trigger SSL prov     │        │                      │
└──────────────────────┘        └──────────────────────┘
```

### Edge Resolution (CDN Worker)

```
┌─────────────────────────────────────────────────────────────────┐
│                    EDGE WORKER FLOW                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXTRACT HOSTNAME FROM REQUEST                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│  SUBDOMAIN PATTERN   │        │   CUSTOM DOMAIN      │
│  *.myshopify.com     │        │                      │
│                      │        │ KV lookup:           │
│ Extract subdomain    │        │ domain:{hostname}    │
│ Route to origin      │        │                      │
└──────────────────────┘        └──────────┬───────────┘
                                           │
                                           ▼
                                ┌──────────────────────┐
                                │  ADD HEADERS         │
                                │  X-Shopify-Subdomain │
                                │  X-Shopify-Route-Type│
                                │  X-Shopify-Store-Id  │
                                └──────────────────────┘
                                           │
                                           ▼
                                ┌──────────────────────┐
                                │  FETCH ORIGIN        │
                                └──────────────────────┘
```

"Edge KV lookup provides sub-millisecond domain resolution. The origin never queries the database for domain mapping - it trusts the headers from the edge."

---

## Deep Dive 4: Message Queue Architecture (5 minutes)

### Queue Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                    RABBITMQ EXCHANGES                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  orders.events (fanout)                                   │   │
│  │  └── All order lifecycle events                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│              ┌───────────────┴───────────────┐                   │
│              ▼                               ▼                   │
│  ┌──────────────────────┐        ┌──────────────────────┐       │
│  │  orders.email        │        │  orders.webhook      │       │
│  │  (confirmation mail) │        │  (merchant notify)   │       │
│  └──────────────────────┘        └──────────────────────┘       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  inventory.events (topic)                                 │   │
│  │  └── Routing key: inventory.{action}.{store_id}          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  inventory.alerts                                         │   │
│  │  └── Binding: inventory.low.*                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Consumer Pattern with Idempotency

```
┌─────────────────────────────────────────────────────────────────┐
│                    MESSAGE PROCESSING                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  RECEIVE MESSAGE                                                 │
│  └── Parse event with idempotencyKey                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  CHECK processed_events TABLE                                    │
│  └── SELECT 1 FROM processed_events WHERE event_key = ?         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   ALREADY PROCESSED  │        │   NOT PROCESSED      │
│                      │        │                      │
│ ACK message          │        │ Execute handler      │
│ (skip processing)    │        │ INSERT event_key     │
│                      │        │ ACK message          │
└──────────────────────┘        └──────────────────────┘
```

### Message Publishing Pattern

Messages include:
- **event**: Event type (e.g., order.created)
- **timestamp**: ISO timestamp
- **idempotencyKey**: Unique identifier (e.g., order_created_{orderId})
- **data**: Event payload

Options:
- **persistent**: true (survives broker restart)
- **messageId**: Same as idempotencyKey

---

## Trade-offs Summary

| Decision | Choice | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | 1M schemas is operational nightmare |
| Isolation | PostgreSQL RLS | Application filtering | Database-level prevents bugs |
| Checkout isolation | SERIALIZABLE | Optimistic locking | Payment cannot fail after success |
| Domain cache | Edge KV | Database lookup | Sub-ms latency required |
| Payment | Stripe Connect | Custom gateway | PCI compliance, time to market |
| Queue | RabbitMQ | Kafka | Simpler for transactional workloads |

---

## Future Enhancements

1. **Sharding Strategy**: Shard by store_id hash when single PostgreSQL reaches limits
2. **Read Replicas**: Route read-heavy analytics to replicas
3. **Distributed Caching**: Multi-region edge cache invalidation
4. **Event Sourcing**: Full audit trail for financial operations
5. **Multi-Region**: Active-active deployment with conflict resolution
