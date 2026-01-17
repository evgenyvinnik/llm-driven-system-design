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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | Operational simplicity |
| Domains | Edge cache | Database lookup | Latency |
| Payments | Stripe Connect | Custom | Compliance, speed |
| Themes | Liquid templates | React SSR | Simplicity |
