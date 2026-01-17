# System Design Interview: Shopify - Multi-Tenant E-Commerce Platform

## Opening Statement

"Today I'll design a multi-tenant e-commerce platform like Shopify, where each merchant has their own isolated store. The core technical challenges are designing multi-tenant architecture with complete data isolation, building custom domain routing for millions of stores, implementing secure checkout flows with payment processing, and creating a flexible theme/customization system."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Store**: Merchants create and brand their own stores
2. **Products**: Manage catalogs with variants and inventory
3. **Checkout**: Secure payment processing with multiple gateways
4. **Orders**: Process and fulfill orders
5. **Analytics**: Sales, customer, and inventory insights

### Non-Functional Requirements

- **Availability**: 99.99% for checkout (revenue-critical)
- **Isolation**: Complete data separation between merchants
- **Latency**: < 100ms for product pages
- **Scale**: 1M+ stores, 100M+ products across all stores

### Key Difference from Amazon

This is a platform-of-platforms. Each store is independent, not a marketplace:
- Customers shop from one store at a time
- Each merchant has their own branding, domain, and checkout
- Shopify provides infrastructure, not product listings

---

## Step 2: High-Level Architecture (7 minutes)

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

### Why This Architecture?

**Shared Database with RLS**: Unlike schema-per-tenant (operational nightmare at 1M stores), we use PostgreSQL Row-Level Security to enforce tenant isolation at the database level.

**Edge Domain Resolution**: Custom domains need sub-millisecond routing. We cache domain-to-store mappings at CDN edge.

**Stripe Connect**: Payment processing is the hardest part to build. Stripe Connect handles PCI compliance and marketplace payouts.

---

## Step 3: Multi-Tenant Data Architecture (12 minutes)

This is the most critical architectural decision.

### Option Analysis

**Option 1: Database Per Tenant**
```
store_12345_db → (products, orders, customers)
store_12346_db → (products, orders, customers)
...
```
- Pros: Complete isolation, easy backup per tenant
- Cons: Operational nightmare at scale, 1M databases

**Option 2: Schema Per Tenant**
```sql
CREATE SCHEMA store_12345;
CREATE TABLE store_12345.products (...);
```
- Pros: Good isolation, single database
- Cons: Schema migrations nightmare, connection pooling issues

**Option 3: Shared Database with Tenant Column (Chosen)**
```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  title VARCHAR(200),
  ...
);
```
- Pros: Simple operations, efficient, scales to millions
- Cons: Requires careful query discipline

### Row-Level Security Implementation

```sql
-- Enable RLS on all tenant tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- Policy: Can only see rows for current store
CREATE POLICY store_isolation ON products
  USING (store_id = current_setting('app.current_store_id')::integer);

CREATE POLICY store_isolation ON orders
  USING (store_id = current_setting('app.current_store_id')::integer);
```

### Setting Tenant Context

```javascript
// Middleware: Set tenant context for every request
async function tenantMiddleware(req, res, next) {
  const storeId = await resolveStore(req.hostname)

  if (!storeId) {
    return res.status(404).send('Store not found')
  }

  // Set PostgreSQL session variable
  await db.raw(`SET app.current_store_id = ${storeId}`)

  req.storeId = storeId
  next()
}
```

### Why RLS is Safer Than Query Discipline

Without RLS:
```javascript
// DANGEROUS: Developer might forget WHERE clause
const products = await db('products').select('*')  // Leaks all stores!
```

With RLS:
```javascript
// SAFE: RLS automatically filters to current store
const products = await db('products').select('*')  // Only current store's products
```

The database enforces isolation even if application code has bugs.

---

## Step 4: Custom Domain Routing (10 minutes)

Supporting millions of custom domains (mystore.com, mybrand.shop, etc.)

### Domain Resolution Flow

```
Request: mystore.com
    │
    ▼
┌─────────────────┐
│  DNS Points to  │
│  Shopify CDN    │  (Customer sets CNAME record)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Edge Domain     │──▶ Valkey: domain → store_id
│ Lookup (CDN)    │    (Sub-ms lookup)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ Route to Store  │──▶ Set tenant context, render storefront
└─────────────────┘
```

### Domain Registration

```javascript
async function registerCustomDomain(storeId, domain) {
  // 1. Verify domain ownership via DNS TXT record
  const verified = await verifyDomainOwnership(domain)
  if (!verified) {
    throw new Error('Domain verification failed. Add TXT record: shopify-verify=store_' + storeId)
  }

  // 2. Check domain not already registered
  const existing = await db('custom_domains').where({ domain }).first()
  if (existing) {
    throw new Error('Domain already registered to another store')
  }

  // 3. Store mapping
  await db('custom_domains').insert({
    store_id: storeId,
    domain,
    verified_at: new Date()
  })

  // 4. Update edge cache (propagates to all CDN nodes)
  await redis.set(`domain:${domain}`, storeId)

  // 5. Provision SSL certificate (Let's Encrypt)
  await sslService.provisionCertificate(domain)

  return { success: true, ssl_provisioning: 'in_progress' }
}
```

### SSL Certificate Management

```javascript
// Automated certificate provisioning via Let's Encrypt
async function provisionCertificate(domain) {
  // 1. Request certificate
  const cert = await letsEncrypt.requestCertificate({
    domain,
    challenge: 'http-01'  // or dns-01
  })

  // 2. Store in certificate store
  await certStore.save(domain, cert)

  // 3. Distribute to edge nodes
  await cdn.deployCertificate(domain, cert)

  // 4. Schedule renewal (60 days before expiry)
  await scheduleRenewal(domain, cert.expiresAt)
}
```

### Edge Resolution

```javascript
// At CDN edge (Cloudflare Workers, Lambda@Edge, etc.)
async function handleRequest(request) {
  const hostname = new URL(request.url).hostname

  // Check if it's a subdomain (store.myshopify.com)
  if (hostname.endsWith('.myshopify.com')) {
    const subdomain = hostname.split('.')[0]
    const storeId = await cache.get(`subdomain:${subdomain}`)
    return routeToStore(storeId, request)
  }

  // Custom domain lookup
  const storeId = await cache.get(`domain:${hostname}`)
  if (!storeId) {
    return new Response('Store not found', { status: 404 })
  }

  return routeToStore(storeId, request)
}
```

---

## Step 5: Checkout Flow (10 minutes)

Checkout must be rock-solid. A failed checkout is lost revenue.

### Secure Checkout Sequence

```javascript
async function processCheckout(storeId, cartId, paymentInfo) {
  const cart = await getCart(cartId)
  const store = await getStore(storeId)

  // ===== VALIDATION PHASE =====

  // 1. Validate all items still available
  for (const item of cart.items) {
    const variant = await db('variants')
      .where({ id: item.variantId, store_id: storeId })
      .first()

    if (!variant || variant.inventory_quantity < item.quantity) {
      throw new Error(`${item.title} is no longer available`)
    }
  }

  // ===== RESERVATION PHASE =====

  // 2. Reserve inventory (within transaction)
  await db.transaction(async (trx) => {
    for (const item of cart.items) {
      const updated = await trx('variants')
        .where({ id: item.variantId })
        .where('inventory_quantity', '>=', item.quantity)
        .decrement('inventory_quantity', item.quantity)

      if (updated === 0) {
        throw new Error(`${item.title} sold out during checkout`)
      }
    }
  })

  // ===== PAYMENT PHASE =====

  // 3. Calculate totals
  const totals = await calculateTotals(cart, store)

  // 4. Process payment via Stripe Connect
  try {
    const payment = await stripe.paymentIntents.create({
      amount: Math.round(totals.total * 100), // cents
      currency: store.currency,
      payment_method: paymentInfo.paymentMethodId,
      confirm: true,
      on_behalf_of: store.stripeAccountId,  // Merchant's Stripe account
      application_fee_amount: Math.round(totals.total * 0.029 * 100), // Shopify's cut
      metadata: {
        store_id: storeId,
        cart_id: cartId
      }
    })

    if (payment.status !== 'succeeded') {
      // Release inventory on payment failure
      await releaseInventory(cart.items)
      throw new Error('Payment failed: ' + payment.status)
    }
  } catch (error) {
    await releaseInventory(cart.items)
    throw error
  }

  // ===== ORDER CREATION PHASE =====

  // 5. Create order
  const order = await db('orders').insert({
    store_id: storeId,
    order_number: generateOrderNumber(storeId),
    customer_email: paymentInfo.email,
    subtotal: totals.subtotal,
    shipping: totals.shipping,
    tax: totals.tax,
    total: totals.total,
    payment_status: 'paid',
    fulfillment_status: 'unfulfilled',
    stripe_payment_id: payment.id
  }).returning('*')

  // 6. Create order line items
  for (const item of cart.items) {
    await db('order_items').insert({
      order_id: order[0].id,
      variant_id: item.variantId,
      quantity: item.quantity,
      price: item.price
    })
  }

  // ===== NOTIFICATION PHASE =====

  // 7. Send confirmations
  await sendOrderConfirmation(order[0], paymentInfo.email)
  await notifyMerchant(store, order[0])

  // 8. Clear cart
  await db('carts').where({ id: cartId }).delete()

  return order[0]
}
```

### Idempotency for Payment Reliability

```javascript
async function createPaymentIntent(storeId, cartId, amount) {
  // Idempotency key prevents double charges
  const idempotencyKey = `${storeId}:${cartId}:${amount}`

  return await stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    // ... other params
  }, {
    idempotencyKey
  })
}
```

If the network fails after payment but before our database update, retrying with the same idempotency key returns the original payment instead of charging again.

---

## Step 6: Theme System (5 minutes)

Merchants need customizable storefronts without security risks.

### Template Engine (Liquid-like)

```javascript
// Simplified template rendering
const templates = {
  'product.html': `
    <html>
      <head><title>{{ product.title }} | {{ store.name }}</title></head>
      <body>
        <h1>{{ product.title }}</h1>
        <p>{{ product.price | money }}</p>

        {% for image in product.images %}
          <img src="{{ image.url }}" alt="{{ product.title }}">
        {% endfor %}

        <form action="/cart/add" method="post">
          <select name="variant_id">
            {% for variant in product.variants %}
              <option value="{{ variant.id }}">{{ variant.title }}</option>
            {% endfor %}
          </select>
          <button type="submit">Add to Cart</button>
        </form>
      </body>
    </html>
  `
}

async function renderProductPage(storeId, productHandle) {
  const store = await getStore(storeId)
  const theme = await getTheme(store.themeId)
  const product = await getProduct(storeId, productHandle)

  const template = theme.templates['product.html']

  return liquidEngine.render(template, {
    store,
    product,
    cart: await getCurrentCart()
  })
}
```

### Why Liquid Templates?

- **Sandboxed**: No arbitrary code execution
- **Designer-friendly**: Simple syntax for non-developers
- **Cacheable**: Templates can be compiled and cached
- **Safe**: Cannot access database or filesystem directly

---

## Step 7: Database Schema (3 minutes)

```sql
-- Stores (tenants)
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  subdomain VARCHAR(50) UNIQUE,
  custom_domain VARCHAR(255),
  theme_id INTEGER REFERENCES themes(id),
  stripe_account_id VARCHAR(100),  -- Stripe Connect account
  settings JSONB,
  plan VARCHAR(50) DEFAULT 'basic',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products (tenant-isolated)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  handle VARCHAR(200),  -- URL slug
  title VARCHAR(200) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

-- Variants (size, color combinations)
CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  sku VARCHAR(100),
  price DECIMAL(10, 2),
  inventory_quantity INTEGER DEFAULT 0,
  options JSONB  -- {size: "M", color: "Blue"}
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  order_number VARCHAR(50),
  customer_email VARCHAR(255),
  subtotal DECIMAL(10, 2),
  shipping DECIMAL(10, 2),
  tax DECIMAL(10, 2),
  total DECIMAL(10, 2),
  payment_status VARCHAR(30),
  fulfillment_status VARCHAR(30),
  shipping_address JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS on tenant tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
```

---

## Step 8: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | Operational simplicity at 1M+ stores |
| Domains | Edge cache lookup | Database lookup | Sub-ms latency required |
| Payments | Stripe Connect | Build own gateway | PCI compliance, time to market |
| Themes | Liquid templates | React SSR | Security, designer accessibility |

### Why RLS Over Application-Level Filtering?

| Approach | Data Leak Risk | Performance |
|----------|---------------|-------------|
| WHERE store_id = ? | Developer error possible | Same |
| RLS policy | Enforced at DB level | Same |

RLS is a safety net. Even if application code is buggy, data cannot leak between tenants.

### Trade-off: Shared DB Limitations

- Cannot give merchants direct DB access
- Cross-tenant analytics requires careful handling
- Very large merchants might need dedicated resources

---

## Closing Summary

I've designed a multi-tenant e-commerce platform with four core systems:

1. **Multi-Tenant Architecture**: Shared PostgreSQL database with Row-Level Security for automatic tenant isolation, supporting millions of stores efficiently

2. **Custom Domain Routing**: Edge-cached domain-to-store mapping with automated SSL provisioning, enabling any domain to point to any store

3. **Secure Checkout**: Transaction-based inventory reservation, Stripe Connect for payment processing with idempotency, and proper error handling for reliability

4. **Theme System**: Sandboxed Liquid templates allowing merchant customization without security risks

**Key trade-offs:**
- Shared DB over schema-per-tenant (operations vs. pure isolation)
- Edge caching for domains (infrastructure cost vs. latency)
- Stripe Connect over custom payments (30-day integration vs. 6-month build)

**What would I add with more time?**
- GraphQL storefront API for headless commerce
- Multi-currency and multi-language support
- App store for third-party integrations
