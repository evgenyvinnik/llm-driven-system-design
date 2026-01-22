# Shopify - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design a multi-tenant e-commerce platform like Shopify where each merchant has an isolated store. The core challenges are multi-tenant architecture with complete data isolation, custom domain routing for millions of stores, secure checkout with payment processing, and horizontal scalability.

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

**Option 1: Database Per Tenant**
```
store_12345_db → (products, orders, customers)
store_12346_db → (products, orders, customers)
```
- Pros: Complete isolation, independent scaling
- Cons: Operational nightmare at 1M stores, connection pooling, migrations

**Option 2: Schema Per Tenant**
```sql
CREATE SCHEMA store_12345;
CREATE TABLE store_12345.products (...);
```
- Pros: Good isolation, single database
- Cons: Schema migrations across 1M schemas, connection pooling issues

**Option 3: Shared Database with RLS (Chosen)**
```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  title VARCHAR(200),
  ...
);
```
- Pros: Simple operations, efficient, scales to millions of tenants
- Cons: Requires careful query discipline (mitigated by RLS)

### Row-Level Security Implementation

```sql
-- Enable RLS on all tenant-specific tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Policy enforces isolation at database level
CREATE POLICY store_isolation ON products
  USING (store_id = current_setting('app.current_store_id')::integer);

CREATE POLICY store_isolation ON variants
  USING (store_id = current_setting('app.current_store_id')::integer);

CREATE POLICY store_isolation ON orders
  USING (store_id = current_setting('app.current_store_id')::integer);

-- Application role must use RLS policies
CREATE ROLE shopify_app NOINHERIT;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
```

### Tenant Context Middleware

```typescript
// middleware/tenant.ts
import { Request, Response, NextFunction } from 'express';
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';

interface TenantContext {
  storeId: number;
  subdomain: string;
  customDomain?: string;
  plan: 'basic' | 'professional' | 'enterprise';
}

async function resolveTenant(hostname: string): Promise<TenantContext | null> {
  // Check subdomain pattern (store.myshopify.com)
  if (hostname.endsWith('.myshopify.local')) {
    const subdomain = hostname.split('.')[0];
    const cacheKey = `tenant:subdomain:${subdomain}`;

    // Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Fallback to database
    const result = await pool.query(
      'SELECT id, subdomain, plan FROM stores WHERE subdomain = $1',
      [subdomain]
    );

    if (result.rows.length === 0) return null;

    const tenant: TenantContext = {
      storeId: result.rows[0].id,
      subdomain: result.rows[0].subdomain,
      plan: result.rows[0].plan,
    };

    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(tenant));
    return tenant;
  }

  // Check custom domain
  const cacheKey = `tenant:domain:${hostname}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const result = await pool.query(
    `SELECT s.id, s.subdomain, s.plan, cd.domain
     FROM stores s
     JOIN custom_domains cd ON s.id = cd.store_id
     WHERE cd.domain = $1 AND cd.verified_at IS NOT NULL`,
    [hostname]
  );

  if (result.rows.length === 0) return null;

  const tenant: TenantContext = {
    storeId: result.rows[0].id,
    subdomain: result.rows[0].subdomain,
    customDomain: result.rows[0].domain,
    plan: result.rows[0].plan,
  };

  await redis.setex(cacheKey, 300, JSON.stringify(tenant));
  return tenant;
}

export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const hostname = req.hostname;
  const tenant = await resolveTenant(hostname);

  if (!tenant) {
    return res.status(404).json({ error: 'Store not found' });
  }

  // Set PostgreSQL session variable for RLS
  await pool.query(
    `SET app.current_store_id = ${tenant.storeId}`
  );

  // Attach to request for application use
  req.tenant = tenant;

  next();
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}
```

### Database Schema (Core Tables)

```sql
-- Stores (tenants)
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  subdomain VARCHAR(50) UNIQUE NOT NULL,
  theme_id INTEGER REFERENCES themes(id),
  stripe_account_id VARCHAR(100),
  settings JSONB DEFAULT '{}',
  plan VARCHAR(50) DEFAULT 'basic',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Custom domains
CREATE TABLE custom_domains (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  domain VARCHAR(255) NOT NULL UNIQUE,
  verification_token VARCHAR(100),
  verified_at TIMESTAMP WITH TIME ZONE,
  ssl_provisioned_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products (tenant-isolated)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  handle VARCHAR(200),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

-- Variants with inventory tracking
CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  sku VARCHAR(100),
  title VARCHAR(200),
  price DECIMAL(10, 2) NOT NULL,
  compare_at_price DECIMAL(10, 2),
  inventory_quantity INTEGER DEFAULT 0,
  inventory_policy VARCHAR(20) DEFAULT 'deny', -- deny, continue
  options JSONB DEFAULT '{}',
  version INTEGER DEFAULT 1, -- Optimistic locking
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(store_id, sku)
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  order_number VARCHAR(50) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL,
  shipping DECIMAL(10, 2) DEFAULT 0,
  tax DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  payment_status VARCHAR(30) DEFAULT 'pending',
  fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
  stripe_payment_intent_id VARCHAR(100),
  shipping_address JSONB,
  billing_address JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(store_id, order_number)
);

-- Order items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  variant_id INTEGER REFERENCES variants(id),
  title VARCHAR(200),
  variant_title VARCHAR(200),
  sku VARCHAR(100),
  quantity INTEGER NOT NULL,
  price DECIMAL(10, 2) NOT NULL
);

-- Idempotency tracking for checkout
CREATE TABLE checkout_requests (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  cart_session_id VARCHAR(64),
  order_id INTEGER REFERENCES orders(id),
  status VARCHAR(20) DEFAULT 'processing',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(store_id, idempotency_key)
);

-- Indexes for performance
CREATE INDEX idx_products_store_status ON products(store_id, status);
CREATE INDEX idx_products_handle ON products(store_id, handle);
CREATE INDEX idx_variants_store_sku ON variants(store_id, sku);
CREATE INDEX idx_variants_product ON variants(product_id);
CREATE INDEX idx_orders_store_created ON orders(store_id, created_at DESC);
CREATE INDEX idx_orders_customer ON orders(store_id, customer_email);
CREATE INDEX idx_custom_domains_domain ON custom_domains(domain);
CREATE INDEX idx_checkout_requests_created ON checkout_requests(created_at);
```

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
      │─────────────────>│                   │              │
      │                  │                   │              │
      │                  │ Check idempotency │              │
      │                  │──────────────────>│              │
      │                  │                   │              │
      │                  │ BEGIN SERIALIZABLE│              │
      │                  │──────────────────>│              │
      │                  │                   │              │
      │                  │ SELECT FOR UPDATE │              │
      │                  │ (inventory)       │              │
      │                  │──────────────────>│              │
      │                  │                   │              │
      │                  │ Update inventory  │              │
      │                  │──────────────────>│              │
      │                  │                   │              │
      │                  │ Create PaymentIntent              │
      │                  │ (with idempotency_key)           │
      │                  │─────────────────────────────────>│
      │                  │                   │              │
      │                  │ Insert order      │              │
      │                  │──────────────────>│              │
      │                  │                   │              │
      │                  │ COMMIT            │              │
      │                  │──────────────────>│              │
      │                  │                   │              │
      │                  │ Publish order.created            │
      │                  │──────────────────>│ (RabbitMQ)   │
      │                  │                   │              │
      │  Order confirmed │                   │              │
      │<─────────────────│                   │              │
      │                  │                   │              │
```

### Checkout Service Implementation

```typescript
// services/checkout.ts
import { pool, withTransaction } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { publishOrderCreated } from '../shared/queue.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

interface CheckoutInput {
  cartSessionId: string;
  email: string;
  shippingAddress: Address;
  paymentMethodId: string;
  idempotencyKey: string;
}

interface CheckoutResult {
  order: Order;
  deduplicated: boolean;
}

export async function processCheckout(
  storeId: number,
  input: CheckoutInput
): Promise<CheckoutResult> {
  // 1. Check idempotency first
  const existing = await pool.query(`
    SELECT id, order_id, status, error_message
    FROM checkout_requests
    WHERE store_id = $1 AND idempotency_key = $2
  `, [storeId, input.idempotencyKey]);

  if (existing.rows.length > 0) {
    const request = existing.rows[0];

    if (request.status === 'completed' && request.order_id) {
      const order = await getOrder(storeId, request.order_id);
      return { order, deduplicated: true };
    }

    if (request.status === 'processing') {
      throw new Error('Checkout already in progress');
    }

    if (request.status === 'failed') {
      // Allow retry after failure - delete old record
      await pool.query(
        'DELETE FROM checkout_requests WHERE id = $1',
        [request.id]
      );
    }
  }

  // 2. Get cart from Redis
  const cart = await getCart(input.cartSessionId);
  if (!cart || cart.items.length === 0) {
    throw new Error('Cart is empty');
  }

  // 3. Get store for Stripe Connect account
  const store = await getStore(storeId);

  // 4. Create idempotency record
  await pool.query(`
    INSERT INTO checkout_requests (store_id, idempotency_key, cart_session_id, status)
    VALUES ($1, $2, $3, 'processing')
  `, [storeId, input.idempotencyKey, input.cartSessionId]);

  try {
    const order = await withTransaction(async (client) => {
      // 5. Lock and validate inventory (SERIALIZABLE + FOR UPDATE)
      for (const item of cart.items) {
        const variant = await client.query(`
          SELECT id, inventory_quantity, inventory_policy, price, title
          FROM variants
          WHERE id = $1 AND store_id = $2
          FOR UPDATE
        `, [item.variantId, storeId]);

        if (variant.rows.length === 0) {
          throw new Error(`Product no longer available: ${item.title}`);
        }

        const v = variant.rows[0];
        if (v.inventory_policy === 'deny' && v.inventory_quantity < item.quantity) {
          throw new Error(`Not enough stock for ${item.title}`);
        }

        // Decrement inventory
        await client.query(`
          UPDATE variants
          SET inventory_quantity = inventory_quantity - $1
          WHERE id = $2
        `, [item.quantity, item.variantId]);
      }

      // 6. Calculate totals
      const totals = calculateTotals(cart, store);

      // 7. Process payment with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totals.total * 100),
        currency: store.currency || 'usd',
        payment_method: input.paymentMethodId,
        confirm: true,
        on_behalf_of: store.stripeAccountId,
        application_fee_amount: Math.round(totals.total * 0.029 * 100),
        metadata: {
          store_id: String(storeId),
          cart_session_id: input.cartSessionId,
        },
      }, {
        idempotencyKey: `${input.idempotencyKey}:payment`,
      });

      if (paymentIntent.status !== 'succeeded') {
        throw new Error(`Payment failed: ${paymentIntent.status}`);
      }

      // 8. Generate order number
      const orderNumber = await generateOrderNumber(client, storeId);

      // 9. Create order
      const orderResult = await client.query(`
        INSERT INTO orders (
          store_id, order_number, customer_email,
          subtotal, shipping, tax, total,
          payment_status, fulfillment_status,
          stripe_payment_intent_id, shipping_address
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', 'unfulfilled', $8, $9)
        RETURNING *
      `, [
        storeId, orderNumber, input.email,
        totals.subtotal, totals.shipping, totals.tax, totals.total,
        paymentIntent.id, JSON.stringify(input.shippingAddress)
      ]);

      const order = orderResult.rows[0];

      // 10. Create order items
      for (const item of cart.items) {
        await client.query(`
          INSERT INTO order_items (
            order_id, store_id, variant_id,
            title, variant_title, sku, quantity, price
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          order.id, storeId, item.variantId,
          item.title, item.variantTitle, item.sku,
          item.quantity, item.price
        ]);
      }

      return order;
    }, { isolationLevel: 'SERIALIZABLE' });

    // 11. Update idempotency record as completed
    await pool.query(`
      UPDATE checkout_requests
      SET status = 'completed', order_id = $1, updated_at = NOW()
      WHERE store_id = $2 AND idempotency_key = $3
    `, [order.id, storeId, input.idempotencyKey]);

    // 12. Clear cart
    await redis.del(`cart:${input.cartSessionId}`);

    // 13. Publish order created event (async)
    await publishOrderCreated({
      orderId: order.id,
      storeId,
      email: input.email,
      total: order.total,
    });

    return { order, deduplicated: false };

  } catch (error) {
    // Update idempotency record as failed
    await pool.query(`
      UPDATE checkout_requests
      SET status = 'failed', error_message = $1, updated_at = NOW()
      WHERE store_id = $2 AND idempotency_key = $3
    `, [(error as Error).message, storeId, input.idempotencyKey]);

    throw error;
  }
}

async function generateOrderNumber(
  client: PoolClient,
  storeId: number
): Promise<string> {
  // Use store-specific sequence
  const result = await client.query(`
    UPDATE stores
    SET settings = jsonb_set(
      COALESCE(settings, '{}'),
      '{order_counter}',
      to_jsonb((COALESCE((settings->>'order_counter')::int, 1000) + 1))
    )
    WHERE id = $1
    RETURNING (settings->>'order_counter')::int as counter
  `, [storeId]);

  return `#${result.rows[0].counter}`;
}
```

### Inventory Locking Patterns

```typescript
// services/inventory.ts

// Optimistic locking for admin inventory adjustments
export async function adjustInventory(
  storeId: number,
  variantId: number,
  adjustment: number,
  expectedVersion: number
): Promise<{ success: boolean; newQuantity: number; version: number }> {
  const result = await pool.query(`
    UPDATE variants
    SET
      inventory_quantity = inventory_quantity + $1,
      version = version + 1,
      updated_at = NOW()
    WHERE id = $2
      AND store_id = $3
      AND version = $4
    RETURNING inventory_quantity, version
  `, [adjustment, variantId, storeId, expectedVersion]);

  if (result.rows.length === 0) {
    throw new Error('Inventory was modified by another process. Please refresh and try again.');
  }

  return {
    success: true,
    newQuantity: result.rows[0].inventory_quantity,
    version: result.rows[0].version,
  };
}

// Bulk inventory sync (e.g., from external system)
export async function syncInventory(
  storeId: number,
  updates: Array<{ sku: string; quantity: number }>
): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;

  for (const update of updates) {
    try {
      const result = await pool.query(`
        UPDATE variants
        SET inventory_quantity = $1, updated_at = NOW()
        WHERE store_id = $2 AND sku = $3
      `, [update.quantity, storeId, update.sku]);

      if (result.rowCount === 0) {
        errors.push(`SKU not found: ${update.sku}`);
      } else {
        synced++;
      }
    } catch (err) {
      errors.push(`Failed to update ${update.sku}: ${(err as Error).message}`);
    }
  }

  return { synced, errors };
}
```

---

## Deep Dive 3: Custom Domain Routing (8 minutes)

### Domain Registration Flow

```typescript
// services/domains.ts
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { resolveTxt } from 'dns/promises';
import crypto from 'crypto';

export async function registerCustomDomain(
  storeId: number,
  domain: string
): Promise<{
  success: boolean;
  verificationToken: string;
  instructions: string;
}> {
  // 1. Validate domain format
  if (!isValidDomain(domain)) {
    throw new Error('Invalid domain format');
  }

  // 2. Check if already registered
  const existing = await pool.query(
    'SELECT store_id FROM custom_domains WHERE domain = $1',
    [domain]
  );

  if (existing.rows.length > 0) {
    if (existing.rows[0].store_id === storeId) {
      throw new Error('Domain already registered to this store');
    }
    throw new Error('Domain already registered to another store');
  }

  // 3. Generate verification token
  const verificationToken = crypto.randomBytes(16).toString('hex');

  // 4. Insert pending domain
  await pool.query(`
    INSERT INTO custom_domains (store_id, domain, verification_token)
    VALUES ($1, $2, $3)
  `, [storeId, domain, verificationToken]);

  return {
    success: true,
    verificationToken,
    instructions: `Add a DNS TXT record: _shopify-verify.${domain} = ${verificationToken}`,
  };
}

export async function verifyDomain(
  storeId: number,
  domain: string
): Promise<{ verified: boolean; error?: string }> {
  // 1. Get pending domain
  const pending = await pool.query(`
    SELECT verification_token, verified_at
    FROM custom_domains
    WHERE store_id = $1 AND domain = $2
  `, [storeId, domain]);

  if (pending.rows.length === 0) {
    return { verified: false, error: 'Domain not found' };
  }

  if (pending.rows[0].verified_at) {
    return { verified: true };
  }

  // 2. Check DNS TXT record
  try {
    const records = await resolveTxt(`_shopify-verify.${domain}`);
    const flatRecords = records.flat();

    const expectedToken = pending.rows[0].verification_token;
    const found = flatRecords.includes(expectedToken);

    if (!found) {
      return {
        verified: false,
        error: `TXT record not found. Expected: ${expectedToken}`,
      };
    }

    // 3. Mark as verified
    await pool.query(`
      UPDATE custom_domains
      SET verified_at = NOW()
      WHERE store_id = $1 AND domain = $2
    `, [storeId, domain]);

    // 4. Update edge cache
    await redis.set(`tenant:domain:${domain}`, JSON.stringify({
      storeId,
      subdomain: (await getStore(storeId)).subdomain,
    }));

    // 5. Trigger SSL provisioning (async)
    await provisionSSL(domain);

    return { verified: true };

  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTFOUND') {
      return { verified: false, error: 'DNS TXT record not found' };
    }
    throw err;
  }
}

async function provisionSSL(domain: string): Promise<void> {
  // In production: Use ACME protocol with Let's Encrypt
  // For local dev: Skip or use self-signed

  // Simulate async provisioning
  await pool.query(`
    UPDATE custom_domains
    SET ssl_provisioned_at = NOW()
    WHERE domain = $1
  `, [domain]);
}

function isValidDomain(domain: string): boolean {
  const pattern = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i;
  return pattern.test(domain) && domain.length <= 253;
}
```

### Edge Resolution (CDN Worker)

```typescript
// edge/worker.ts (Cloudflare Workers / Lambda@Edge)

interface Env {
  DOMAIN_CACHE: KVNamespace;
  ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // 1. Check for subdomain pattern
    if (hostname.endsWith('.myshopify.com')) {
      const subdomain = hostname.split('.')[0];
      return await routeToOrigin(env, subdomain, 'subdomain', request);
    }

    // 2. Lookup custom domain in edge KV
    const storeData = await env.DOMAIN_CACHE.get(`domain:${hostname}`);

    if (!storeData) {
      return new Response('Store not found', { status: 404 });
    }

    const { storeId, subdomain } = JSON.parse(storeData);
    return await routeToOrigin(env, subdomain, 'custom', request, storeId);
  },
};

async function routeToOrigin(
  env: Env,
  subdomain: string,
  routeType: 'subdomain' | 'custom',
  request: Request,
  storeId?: number
): Promise<Response> {
  const originUrl = new URL(request.url);
  originUrl.hostname = env.ORIGIN;

  const headers = new Headers(request.headers);
  headers.set('X-Shopify-Subdomain', subdomain);
  headers.set('X-Shopify-Route-Type', routeType);
  if (storeId) {
    headers.set('X-Shopify-Store-Id', String(storeId));
  }

  return fetch(originUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
  });
}
```

---

## Deep Dive 4: Message Queue Architecture (5 minutes)

### Queue Topology

```typescript
// shared/queue.ts
import amqp from 'amqplib';

const EXCHANGES = {
  orders: { name: 'orders.events', type: 'fanout' },
  inventory: { name: 'inventory.events', type: 'topic' },
  notifications: { name: 'notifications', type: 'direct' },
};

const QUEUES = {
  'orders.email': {
    exchange: 'orders.events',
    durable: true,
    deadLetter: 'dlx.orders',
  },
  'orders.webhook': {
    exchange: 'orders.events',
    durable: true,
    deadLetter: 'dlx.orders',
  },
  'inventory.alerts': {
    exchange: 'inventory.events',
    routingKey: 'inventory.low.*',
    durable: true,
  },
};

export async function publishOrderCreated(order: OrderEvent): Promise<void> {
  const channel = await getChannel();

  channel.publish(
    'orders.events',
    '',
    Buffer.from(JSON.stringify({
      event: 'order.created',
      timestamp: new Date().toISOString(),
      idempotencyKey: `order_created_${order.orderId}`,
      data: order,
    })),
    {
      persistent: true,
      messageId: `order_created_${order.orderId}`,
    }
  );
}

export async function publishInventoryLow(event: InventoryEvent): Promise<void> {
  const channel = await getChannel();

  channel.publish(
    'inventory.events',
    `inventory.low.${event.storeId}`,
    Buffer.from(JSON.stringify(event)),
    { persistent: true }
  );
}
```

### Consumer Pattern

```typescript
// workers/email-worker.ts
import { consumeQueue } from '../shared/queue.js';
import { pool } from '../shared/db.js';

async function processOrderEmail(msg: amqp.ConsumeMessage): Promise<void> {
  const event = JSON.parse(msg.content.toString());

  // Idempotency check
  const processed = await pool.query(
    'SELECT 1 FROM processed_events WHERE event_key = $1',
    [event.idempotencyKey]
  );

  if (processed.rows.length > 0) {
    return; // Already processed
  }

  // Send email
  await sendOrderConfirmationEmail(event.data);

  // Mark as processed
  await pool.query(
    'INSERT INTO processed_events (event_key) VALUES ($1)',
    [event.idempotencyKey]
  );
}

// Start consumer
consumeQueue('orders.email', processOrderEmail, { prefetch: 10 });
```

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
