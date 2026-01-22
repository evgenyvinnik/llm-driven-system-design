# Shopify - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

---

## 1. Problem Statement (2 minutes)

We are designing a multi-tenant e-commerce platform where merchants create branded online stores, manage products and inventory, and customers complete purchases through a secure checkout flow.

**Fullstack Scope:**
- **End-to-End Checkout Flow** - Cart to order confirmation with payment processing
- **Multi-Tenant Data Isolation** - Ensuring merchants only see their own data
- **Product Management** - CRUD operations with inventory tracking
- **Custom Domain Routing** - Resolving custom domains to the correct store

---

## 2. Requirements Clarification (3 minutes)

**Functional Requirements:**
1. Merchants create stores with custom subdomains
2. Products with variants (size, color) and inventory tracking
3. Customers browse products, add to cart, and checkout
4. Secure payment processing with Stripe
5. Order creation and confirmation

**Non-Functional Requirements:**
- **Availability:** 99.99% for checkout flow
- **Latency:** Product pages under 100ms
- **Isolation:** Complete data separation between tenants
- **Idempotency:** Double-click on checkout must not create duplicate orders

**Clarifying Questions:**
- "How do we handle payment failures?" (Rollback inventory reservation, notify customer)
- "Can customers have accounts across multiple stores?" (Yes, but orders are store-scoped)
- "How do we handle concurrent checkout for last item?" (Pessimistic locking on inventory)

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  React + TypeScript + Tanstack Router                                   ││
│  │  ┌───────────────────┐  ┌───────────────────┐  ┌────────────────────┐  ││
│  │  │    Storefront     │  │   Admin Dashboard │  │   Zustand Stores   │  ││
│  │  │   /store/:sub     │  │   /admin/:storeId │  │   useStorefront    │  ││
│  │  │   - Products      │  │   - ProductsTab   │  │   useAuth          │  ││
│  │  │   - Cart          │  │   - OrdersTab     │  │   useStore         │  ││
│  │  │   - Checkout      │  │   - Settings      │  │                    │  ││
│  │  └───────────────────┘  └───────────────────┘  └────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                              HTTPS / JSON API
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Layer                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Express.js + TypeScript                                                ││
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────┐││
│  │  │ Tenant Context │  │   Idempotency  │  │    Route Handlers          │││
│  │  │   Middleware   │  │   Middleware   │  │                            │││
│  │  │                │  │                │  │  /api/storefront/:sub/*    │││
│  │  │ Sets store_id  │  │ Checks/stores  │  │  /api/admin/:storeId/*     │││
│  │  │ in pg session  │  │ idempotency    │  │  /api/checkout             │││
│  │  └────────────────┘  └────────────────┘  └────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
┌────────────────────────┐ ┌────────────────┐ ┌───────────────────────────┐
│      PostgreSQL        │ │   Valkey       │ │       RabbitMQ            │
│                        │ │                │ │                           │
│  stores, products,     │ │  - Sessions    │ │  - order.created          │
│  variants, orders      │ │  - Cart data   │ │  - email.send             │
│  (RLS enabled)         │ │  - Domain map  │ │  - webhook.deliver        │
└────────────────────────┘ └────────────────┘ └───────────────────────────┘
                                                          │
                                                          ▼
                                               ┌───────────────────────┐
                                               │   Background Workers  │
                                               │   - Email service     │
                                               │   - Webhook delivery  │
                                               └───────────────────────┘
```

---

## 4. Deep Dives

### Deep Dive 1: End-to-End Checkout Flow (10 minutes)

**Checkout Sequence Diagram:**

```
Customer          Frontend              Backend                Stripe          PostgreSQL
   │                 │                     │                     │                 │
   │ Click Checkout  │                     │                     │                 │
   │────────────────>│                     │                     │                 │
   │                 │  POST /checkout     │                     │                 │
   │                 │  + Idempotency-Key  │                     │                 │
   │                 │────────────────────>│                     │                 │
   │                 │                     │                     │                 │
   │                 │                     │ BEGIN SERIALIZABLE  │                 │
   │                 │                     │─────────────────────────────────────>│
   │                 │                     │                     │                 │
   │                 │                     │ Check idempotency   │                 │
   │                 │                     │─────────────────────────────────────>│
   │                 │                     │                     │                 │
   │                 │                     │ SELECT FOR UPDATE   │                 │
   │                 │                     │ (inventory check)   │                 │
   │                 │                     │─────────────────────────────────────>│
   │                 │                     │                     │                 │
   │                 │                     │ Reserve inventory   │                 │
   │                 │                     │ UPDATE variants     │                 │
   │                 │                     │─────────────────────────────────────>│
   │                 │                     │                     │                 │
   │                 │                     │ Create PaymentIntent│                 │
   │                 │                     │────────────────────>│                 │
   │                 │                     │                     │                 │
   │                 │                     │ clientSecret        │                 │
   │                 │                     │<────────────────────│                 │
   │                 │                     │                     │                 │
   │                 │  { clientSecret }   │                     │                 │
   │                 │<────────────────────│                     │                 │
   │                 │                     │                     │                 │
   │                 │ stripe.confirmPayment()                   │                 │
   │                 │──────────────────────────────────────────>│                 │
   │                 │                     │                     │                 │
   │                 │                 succeeded                 │                 │
   │                 │<──────────────────────────────────────────│                 │
   │                 │                     │                     │                 │
   │                 │  POST /confirm      │                     │                 │
   │                 │────────────────────>│                     │                 │
   │                 │                     │                     │                 │
   │                 │                     │ INSERT order        │                 │
   │                 │                     │─────────────────────────────────────>│
   │                 │                     │                     │                 │
   │                 │                     │ COMMIT              │                 │
   │                 │                     │─────────────────────────────────────>│
   │                 │                     │                     │                 │
   │                 │                     │ Publish order.created                │
   │                 │                     │──────────────────────────────────────>│
   │                 │                     │                     │  (RabbitMQ)    │
   │                 │  { order }          │                     │                 │
   │                 │<────────────────────│                     │                 │
   │  Order Success  │                     │                     │                 │
   │<────────────────│                     │                     │                 │
```

**Frontend Checkout Component:**

```tsx
// CheckoutView.tsx
export function CheckoutView({ subdomain }: { subdomain: string }) {
  const { cart, cartSessionId, clearCart } = useStorefrontStore();
  const stripe = useStripe();
  const elements = useElements();

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate idempotency key once per checkout attempt
  const idempotencyKey = useMemo(
    () => `checkout_${cartSessionId}_${Date.now()}`,
    [cartSessionId]
  );

  const handleSubmit = async (formData: CheckoutFormData) => {
    if (!stripe || !elements) return;

    setIsProcessing(true);
    setError(null);

    try {
      // Step 1: Create checkout session on backend
      const response = await fetch(`/api/storefront/${subdomain}/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Cart-Session': cartSessionId!,
        },
        body: JSON.stringify({
          email: formData.email,
          shippingAddress: formData.shippingAddress,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Checkout failed');
      }

      const { clientSecret, orderId } = await response.json();

      // Step 2: Confirm payment with Stripe
      const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: {
          return_url: `${window.location.origin}/store/${subdomain}/success`,
        },
        redirect: 'if_required',
      });

      if (stripeError) {
        throw new Error(stripeError.message);
      }

      if (paymentIntent?.status === 'succeeded') {
        // Step 3: Confirm order on backend
        await fetch(`/api/storefront/${subdomain}/checkout/${orderId}/confirm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
        });

        clearCart();
        navigate(`/store/${subdomain}/success?order=${orderId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <CheckoutForm
      cart={cart}
      isProcessing={isProcessing}
      error={error}
      onSubmit={handleSubmit}
    />
  );
}
```

**Backend Checkout Handler:**

```typescript
// routes/checkout.ts
router.post('/storefront/:subdomain/checkout', async (req, res) => {
  const { subdomain } = req.params;
  const { email, shippingAddress } = req.body;
  const cartSessionId = req.headers['x-cart-session'] as string;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const client = await pool.connect();

  try {
    // Get store from subdomain
    const storeResult = await client.query(
      'SELECT id, stripe_account_id FROM stores WHERE subdomain = $1',
      [subdomain]
    );
    const store = storeResult.rows[0];
    if (!store) {
      return res.status(404).json({ message: 'Store not found' });
    }

    // Set tenant context for RLS
    await client.query(`SET LOCAL app.current_store_id = '${store.id}'`);

    // Begin serializable transaction
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    // Check idempotency
    const existingRequest = await client.query(
      `SELECT id, status, order_id FROM checkout_requests
       WHERE store_id = $1 AND idempotency_key = $2`,
      [store.id, idempotencyKey]
    );

    if (existingRequest.rows.length > 0) {
      const existing = existingRequest.rows[0];
      if (existing.status === 'completed') {
        await client.query('COMMIT');
        const order = await getOrder(existing.order_id);
        return res.json({ order, deduplicated: true });
      }
      if (existing.status === 'processing') {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Request already in progress' });
      }
    }

    // Record checkout request
    await client.query(
      `INSERT INTO checkout_requests (store_id, idempotency_key, cart_session_id, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT (store_id, idempotency_key) DO UPDATE SET status = 'processing'`,
      [store.id, idempotencyKey, cartSessionId]
    );

    // Get cart from Valkey
    const cart = await getCart(store.id, cartSessionId);
    if (!cart || cart.items.length === 0) {
      throw new Error('Cart is empty');
    }

    // Lock and validate inventory
    for (const item of cart.items) {
      const result = await client.query(
        `SELECT id, inventory_quantity FROM variants
         WHERE id = $1 AND store_id = $2
         FOR UPDATE`,
        [item.variantId, store.id]
      );

      const variant = result.rows[0];
      if (!variant || variant.inventory_quantity < item.quantity) {
        throw new Error(`Insufficient inventory for ${item.title}`);
      }
    }

    // Reserve inventory
    for (const item of cart.items) {
      await client.query(
        `UPDATE variants
         SET inventory_quantity = inventory_quantity - $1,
             reserved_quantity = reserved_quantity + $1
         WHERE id = $2 AND store_id = $3`,
        [item.quantity, item.variantId, store.id]
      );
    }

    // Calculate totals
    const subtotal = cart.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const shipping = 5.00; // Simplified
    const total = subtotal + shipping;

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100), // cents
      currency: 'usd',
      metadata: {
        store_id: store.id.toString(),
        cart_session_id: cartSessionId,
        idempotency_key: idempotencyKey,
      },
    }, {
      stripeAccount: store.stripe_account_id, // Stripe Connect
      idempotencyKey: `pi_${idempotencyKey}`,
    });

    // Create pending order
    const orderResult = await client.query(
      `INSERT INTO orders (store_id, order_number, customer_email, shipping_address, subtotal, shipping, total, status, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING id, order_number`,
      [
        store.id,
        generateOrderNumber(),
        email,
        JSON.stringify(shippingAddress),
        subtotal,
        shipping,
        total,
        paymentIntent.id,
      ]
    );

    const order = orderResult.rows[0];

    // Create order items
    for (const item of cart.items) {
      await client.query(
        `INSERT INTO order_items (order_id, store_id, variant_id, product_title, variant_title, quantity, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, store.id, item.variantId, item.title, item.variantTitle, item.quantity, item.price]
      );
    }

    await client.query('COMMIT');

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderId: order.id,
      orderNumber: order.order_number,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    // Mark request as failed
    await client.query(
      `UPDATE checkout_requests SET status = 'failed', error_message = $1
       WHERE store_id = $2 AND idempotency_key = $3`,
      [error.message, store.id, idempotencyKey]
    );

    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
});
```

**Order Confirmation Handler:**

```typescript
router.post('/storefront/:subdomain/checkout/:orderId/confirm', async (req, res) => {
  const { subdomain, orderId } = req.params;
  const { paymentIntentId } = req.body;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const client = await pool.connect();

  try {
    const store = await getStoreBySubdomain(subdomain);
    await client.query(`SET LOCAL app.current_store_id = '${store.id}'`);

    await client.query('BEGIN');

    // Verify payment with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { stripeAccount: store.stripe_account_id }
    );

    if (paymentIntent.status !== 'succeeded') {
      throw new Error('Payment not completed');
    }

    // Update order status
    await client.query(
      `UPDATE orders SET status = 'confirmed', payment_status = 'paid', confirmed_at = NOW()
       WHERE id = $1 AND store_id = $2 AND status = 'pending'`,
      [orderId, store.id]
    );

    // Commit reserved inventory (remove from reserved, already deducted from available)
    const orderItems = await client.query(
      `SELECT variant_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );

    for (const item of orderItems.rows) {
      await client.query(
        `UPDATE variants SET reserved_quantity = reserved_quantity - $1
         WHERE id = $2 AND store_id = $3`,
        [item.quantity, item.variant_id, store.id]
      );
    }

    // Mark checkout request as completed
    await client.query(
      `UPDATE checkout_requests SET status = 'completed', order_id = $1
       WHERE store_id = $2 AND idempotency_key = $3`,
      [orderId, store.id, idempotencyKey]
    );

    await client.query('COMMIT');

    // Publish order.created event (async)
    await publishToQueue('orders.events', {
      event: 'order.created',
      orderId: parseInt(orderId),
      storeId: store.id,
      timestamp: new Date().toISOString(),
    });

    // Clear cart
    await clearCart(store.id, req.headers['x-cart-session'] as string);

    const order = await getOrderById(store.id, orderId);
    res.json({ order });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
});
```

---

### Deep Dive 2: Multi-Tenant Data Isolation (8 minutes)

**Row-Level Security Implementation:**

```sql
-- Database schema with RLS
CREATE TABLE stores (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  subdomain VARCHAR(50) UNIQUE NOT NULL,
  custom_domain VARCHAR(255),
  stripe_account_id VARCHAR(255),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  sku VARCHAR(100),
  title VARCHAR(100),
  price DECIMAL(10, 2) NOT NULL,
  inventory_quantity INTEGER DEFAULT 0,
  reserved_quantity INTEGER DEFAULT 0,
  options JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) NOT NULL,
  order_number VARCHAR(50) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  shipping_address JSONB,
  subtotal DECIMAL(10, 2),
  shipping DECIMAL(10, 2),
  total DECIMAL(10, 2),
  status VARCHAR(30) DEFAULT 'pending',
  payment_status VARCHAR(30),
  payment_intent_id VARCHAR(255),
  confirmed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS on all tenant tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Create isolation policies
CREATE POLICY store_isolation_products ON products
  USING (store_id = current_setting('app.current_store_id')::integer);

CREATE POLICY store_isolation_variants ON variants
  USING (store_id = current_setting('app.current_store_id')::integer);

CREATE POLICY store_isolation_orders ON orders
  USING (store_id = current_setting('app.current_store_id')::integer);
```

**Tenant Context Middleware:**

```typescript
// middleware/tenantContext.ts
export function tenantContext() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Extract store identifier from route
    const subdomain = req.params.subdomain || req.params.storeId;

    if (!subdomain) {
      return next();
    }

    try {
      // Lookup store (cached in Valkey)
      const cacheKey = `store:subdomain:${subdomain}`;
      let store = await redis.get(cacheKey);

      if (!store) {
        const result = await pool.query(
          'SELECT id, name, subdomain, settings FROM stores WHERE subdomain = $1 OR id::text = $1',
          [subdomain]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ message: 'Store not found' });
        }

        store = result.rows[0];
        await redis.setex(cacheKey, 300, JSON.stringify(store)); // 5 min cache
      } else {
        store = JSON.parse(store);
      }

      // Attach to request for handlers
      req.store = store;

      // Will be set in transaction for RLS
      req.tenantId = store.id;

      next();
    } catch (error) {
      next(error);
    }
  };
}

// Usage in route handlers
router.get('/storefront/:subdomain/products', tenantContext(), async (req, res) => {
  const client = await pool.connect();

  try {
    // Set tenant context for RLS
    await client.query(`SET LOCAL app.current_store_id = '${req.tenantId}'`);

    // Query automatically filtered by RLS policy
    const result = await client.query(
      `SELECT p.*, json_agg(v.*) as variants
       FROM products p
       LEFT JOIN variants v ON v.product_id = p.id
       WHERE p.status = 'active'
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );

    res.json(result.rows);
  } finally {
    client.release();
  }
});
```

**Admin Route Protection:**

```typescript
// middleware/adminAuth.ts
export function requireStoreOwner() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { storeId } = req.params;
    const userId = req.session?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const result = await pool.query(
      'SELECT id FROM stores WHERE id = $1 AND owner_id = $2',
      [storeId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    req.tenantId = parseInt(storeId);
    next();
  };
}

// Admin routes with owner check
router.get('/admin/:storeId/products', requireStoreOwner(), async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query(`SET LOCAL app.current_store_id = '${req.tenantId}'`);

    const result = await client.query(
      `SELECT p.*, json_agg(v.*) as variants
       FROM products p
       LEFT JOIN variants v ON v.product_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );

    res.json(result.rows);
  } finally {
    client.release();
  }
});
```

---

### Deep Dive 3: Product Management with Inventory (8 minutes)

**Product CRUD API Contract:**

```typescript
// API Endpoints
// GET    /api/admin/:storeId/products       - List all products
// POST   /api/admin/:storeId/products       - Create product
// GET    /api/admin/:storeId/products/:id   - Get single product
// PUT    /api/admin/:storeId/products/:id   - Update product
// DELETE /api/admin/:storeId/products/:id   - Delete product

// Request: Create Product
interface CreateProductRequest {
  title: string;
  description?: string;
  status: 'draft' | 'active';
  variants: {
    title: string;      // e.g., "Small / Black"
    sku?: string;
    price: number;
    inventory_quantity: number;
    options?: {
      size?: string;
      color?: string;
    };
  }[];
  images?: string[];    // URLs after upload
}

// Response: Product with Variants
interface ProductResponse {
  id: number;
  store_id: number;
  title: string;
  description: string | null;
  status: 'draft' | 'active';
  variants: VariantResponse[];
  images: string[];
  created_at: string;
  updated_at: string;
}

interface VariantResponse {
  id: number;
  title: string;
  sku: string | null;
  price: number;
  inventory_quantity: number;
  reserved_quantity: number;
  options: Record<string, string>;
}
```

**Product Creation Handler:**

```typescript
router.post('/admin/:storeId/products', requireStoreOwner(), async (req, res) => {
  const { title, description, status, variants, images } = req.body;
  const storeId = req.tenantId;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_store_id = '${storeId}'`);

    // Create product
    const productResult = await client.query(
      `INSERT INTO products (store_id, title, description, status, images)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [storeId, title, description, status, JSON.stringify(images || [])]
    );

    const product = productResult.rows[0];

    // Create variants
    const createdVariants = [];
    for (const variant of variants) {
      const variantResult = await client.query(
        `INSERT INTO variants (store_id, product_id, title, sku, price, inventory_quantity, options)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          storeId,
          product.id,
          variant.title,
          variant.sku,
          variant.price,
          variant.inventory_quantity,
          JSON.stringify(variant.options || {}),
        ]
      );
      createdVariants.push(variantResult.rows[0]);
    }

    await client.query('COMMIT');

    // Log audit event
    await auditLog({
      storeId,
      actorId: req.session.userId,
      actorType: 'merchant',
      action: 'product.created',
      resourceType: 'product',
      resourceId: product.id,
      changes: { after: { title, variants: variants.length } },
    });

    res.status(201).json({
      ...product,
      variants: createdVariants,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
});
```

**Inventory Update with Optimistic Locking:**

```typescript
router.patch('/admin/:storeId/variants/:variantId/inventory', requireStoreOwner(), async (req, res) => {
  const { variantId } = req.params;
  const { quantity, version } = req.body;
  const storeId = req.tenantId;

  const client = await pool.connect();

  try {
    await client.query(`SET LOCAL app.current_store_id = '${storeId}'`);

    // Get current state
    const current = await client.query(
      'SELECT inventory_quantity, version FROM variants WHERE id = $1',
      [variantId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ message: 'Variant not found' });
    }

    const oldQuantity = current.rows[0].inventory_quantity;

    // Optimistic lock update
    const result = await client.query(
      `UPDATE variants
       SET inventory_quantity = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2 AND version = $3
       RETURNING *`,
      [quantity, variantId, version]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        message: 'Conflict: inventory was modified by another request',
        currentVersion: current.rows[0].version,
      });
    }

    // Audit log
    await auditLog({
      storeId,
      actorId: req.session.userId,
      actorType: 'merchant',
      action: 'inventory.adjusted',
      resourceType: 'variant',
      resourceId: parseInt(variantId),
      changes: {
        before: { inventory_quantity: oldQuantity },
        after: { inventory_quantity: quantity },
      },
    });

    res.json(result.rows[0]);
  } finally {
    client.release();
  }
});
```

**Frontend Product Form:**

```tsx
// components/admin/ProductFormModal.tsx
interface ProductFormData {
  title: string;
  description: string;
  status: 'draft' | 'active';
  variants: {
    title: string;
    sku: string;
    price: string; // String for form input
    inventory_quantity: string;
  }[];
}

export function ProductFormModal({ product, onClose, onSave }: ProductFormModalProps) {
  const [formData, setFormData] = useState<ProductFormData>(
    product ? mapProductToForm(product) : initialFormData
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    // Validate
    const newErrors: Record<string, string> = {};
    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    }
    if (formData.variants.length === 0) {
      newErrors.variants = 'At least one variant is required';
    }
    formData.variants.forEach((v, i) => {
      if (!v.price || parseFloat(v.price) <= 0) {
        newErrors[`variant_${i}_price`] = 'Valid price required';
      }
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setIsSaving(true);
    try {
      await onSave({
        title: formData.title,
        description: formData.description,
        status: formData.status,
        variants: formData.variants.map(v => ({
          title: v.title,
          sku: v.sku || null,
          price: parseFloat(v.price),
          inventory_quantity: parseInt(v.inventory_quantity) || 0,
        })),
      });
    } catch (error) {
      setErrors({ submit: error.message });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <h2 className="text-xl font-bold mb-4">
          {product ? 'Edit Product' : 'Create Product'}
        </h2>

        {/* Title */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Title</label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            className="w-full border rounded-lg px-3 py-2"
          />
          {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
        </div>

        {/* Description */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Description</label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            rows={3}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>

        {/* Variants */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Variants</label>
          {formData.variants.map((variant, index) => (
            <div key={index} className="flex gap-2 mb-2">
              <input
                type="text"
                placeholder="Title (e.g., Small)"
                value={variant.title}
                onChange={(e) => updateVariant(index, 'title', e.target.value)}
                className="flex-1 border rounded px-2 py-1"
              />
              <input
                type="number"
                placeholder="Price"
                value={variant.price}
                onChange={(e) => updateVariant(index, 'price', e.target.value)}
                className="w-24 border rounded px-2 py-1"
              />
              <input
                type="number"
                placeholder="Stock"
                value={variant.inventory_quantity}
                onChange={(e) => updateVariant(index, 'inventory_quantity', e.target.value)}
                className="w-20 border rounded px-2 py-1"
              />
              <button
                type="button"
                onClick={() => removeVariant(index)}
                className="text-red-500"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addVariant}
            className="text-blue-600 text-sm"
          >
            + Add Variant
          </button>
        </div>

        {/* Status */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-1">Status</label>
          <select
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value as 'draft' | 'active' })}
            className="border rounded-lg px-3 py-2"
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
          </select>
        </div>

        {errors.submit && (
          <div className="bg-red-50 text-red-700 px-4 py-2 rounded mb-4">
            {errors.submit}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2">
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Product'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
```

---

### Deep Dive 4: Cart Session and API Integration (8 minutes)

**Cart Data Model:**

```typescript
// Cart stored in Valkey (Redis)
interface Cart {
  storeId: number;
  sessionId: string;
  items: CartItem[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string; // 7-day expiry
}

interface CartItem {
  variantId: number;
  productId: number;
  title: string;
  variantTitle: string;
  price: number;
  quantity: number;
  imageUrl?: string;
}

// Valkey key pattern
// cart:{storeId}:{sessionId}
```

**Cart API Endpoints:**

```typescript
// Create cart session
router.post('/storefront/:subdomain/cart', tenantContext(), async (req, res) => {
  const sessionId = crypto.randomUUID();
  const cart: Cart = {
    storeId: req.tenantId,
    sessionId,
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const key = `cart:${req.tenantId}:${sessionId}`;
  await redis.setex(key, 7 * 24 * 60 * 60, JSON.stringify(cart));

  res.json({ sessionId });
});

// Get cart
router.get('/storefront/:subdomain/cart', tenantContext(), async (req, res) => {
  const sessionId = req.headers['x-cart-session'] as string;
  if (!sessionId) {
    return res.status(400).json({ message: 'Cart session required' });
  }

  const key = `cart:${req.tenantId}:${sessionId}`;
  const data = await redis.get(key);

  if (!data) {
    return res.status(404).json({ message: 'Cart not found' });
  }

  const cart = JSON.parse(data);

  // Calculate totals
  const subtotal = cart.items.reduce(
    (sum: number, item: CartItem) => sum + item.price * item.quantity,
    0
  );

  res.json({
    ...cart,
    subtotal,
    itemCount: cart.items.reduce((sum: number, item: CartItem) => sum + item.quantity, 0),
  });
});

// Add item to cart
router.post('/storefront/:subdomain/cart/items', tenantContext(), async (req, res) => {
  const { variantId, quantity = 1 } = req.body;
  const sessionId = req.headers['x-cart-session'] as string;

  const client = await pool.connect();

  try {
    await client.query(`SET LOCAL app.current_store_id = '${req.tenantId}'`);

    // Get variant with product info
    const result = await client.query(
      `SELECT v.*, p.title as product_title, p.images
       FROM variants v
       JOIN products p ON p.id = v.product_id
       WHERE v.id = $1 AND p.status = 'active'`,
      [variantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const variant = result.rows[0];

    // Check inventory
    if (variant.inventory_quantity < quantity) {
      return res.status(400).json({
        message: 'Insufficient inventory',
        available: variant.inventory_quantity,
      });
    }

    // Update cart
    const key = `cart:${req.tenantId}:${sessionId}`;
    const cartData = await redis.get(key);

    if (!cartData) {
      return res.status(404).json({ message: 'Cart not found' });
    }

    const cart: Cart = JSON.parse(cartData);

    // Check if item exists
    const existingIndex = cart.items.findIndex(
      (item) => item.variantId === variantId
    );

    if (existingIndex >= 0) {
      const newQuantity = cart.items[existingIndex].quantity + quantity;
      if (newQuantity > variant.inventory_quantity) {
        return res.status(400).json({
          message: 'Exceeds available inventory',
          available: variant.inventory_quantity,
          inCart: cart.items[existingIndex].quantity,
        });
      }
      cart.items[existingIndex].quantity = newQuantity;
    } else {
      cart.items.push({
        variantId,
        productId: variant.product_id,
        title: variant.product_title,
        variantTitle: variant.title,
        price: parseFloat(variant.price),
        quantity,
        imageUrl: variant.images?.[0],
      });
    }

    cart.updatedAt = new Date().toISOString();
    await redis.setex(key, 7 * 24 * 60 * 60, JSON.stringify(cart));

    res.json(cart);
  } finally {
    client.release();
  }
});

// Update item quantity
router.patch('/storefront/:subdomain/cart/items/:variantId', tenantContext(), async (req, res) => {
  const { variantId } = req.params;
  const { quantity } = req.body;
  const sessionId = req.headers['x-cart-session'] as string;

  const key = `cart:${req.tenantId}:${sessionId}`;
  const cartData = await redis.get(key);

  if (!cartData) {
    return res.status(404).json({ message: 'Cart not found' });
  }

  const cart: Cart = JSON.parse(cartData);

  if (quantity === 0) {
    // Remove item
    cart.items = cart.items.filter(
      (item) => item.variantId !== parseInt(variantId)
    );
  } else {
    // Check inventory
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_store_id = '${req.tenantId}'`);
      const result = await client.query(
        'SELECT inventory_quantity FROM variants WHERE id = $1',
        [variantId]
      );

      if (result.rows.length > 0 && quantity > result.rows[0].inventory_quantity) {
        return res.status(400).json({
          message: 'Exceeds available inventory',
          available: result.rows[0].inventory_quantity,
        });
      }
    } finally {
      client.release();
    }

    // Update quantity
    const index = cart.items.findIndex(
      (item) => item.variantId === parseInt(variantId)
    );
    if (index >= 0) {
      cart.items[index].quantity = quantity;
    }
  }

  cart.updatedAt = new Date().toISOString();
  await redis.setex(key, 7 * 24 * 60 * 60, JSON.stringify(cart));

  res.json(cart);
});
```

**Frontend API Service:**

```typescript
// services/api.ts
const API_BASE = import.meta.env.VITE_API_URL || '';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const cartSessionId = useStorefrontStore.getState().cartSessionId;
  const authToken = useAuthStore.getState().token;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (cartSessionId) {
    headers['X-Cart-Session'] = cartSessionId;
  }

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
    credentials: 'include', // For session cookies
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new ApiError(response.status, error.message);
  }

  return response.json();
}

export const api = {
  // Storefront
  getProducts: (subdomain: string) =>
    apiFetch<Product[]>(`/api/storefront/${subdomain}/products`),

  getProduct: (subdomain: string, productId: number) =>
    apiFetch<Product>(`/api/storefront/${subdomain}/products/${productId}`),

  // Cart
  createCartSession: (subdomain: string) =>
    apiFetch<{ sessionId: string }>(`/api/storefront/${subdomain}/cart`, {
      method: 'POST',
    }),

  getCart: (subdomain: string) =>
    apiFetch<Cart>(`/api/storefront/${subdomain}/cart`),

  addToCart: (subdomain: string, variantId: number, quantity: number) =>
    apiFetch<Cart>(`/api/storefront/${subdomain}/cart/items`, {
      method: 'POST',
      body: JSON.stringify({ variantId, quantity }),
    }),

  updateCartItem: (subdomain: string, variantId: number, quantity: number) =>
    apiFetch<Cart>(`/api/storefront/${subdomain}/cart/items/${variantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity }),
    }),

  // Checkout
  createCheckout: (subdomain: string, data: CheckoutData, idempotencyKey: string) =>
    apiFetch<{ clientSecret: string; orderId: number }>(`/api/storefront/${subdomain}/checkout`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(data),
    }),

  // Admin
  getAdminProducts: (storeId: string) =>
    apiFetch<Product[]>(`/api/admin/${storeId}/products`),

  createProduct: (storeId: string, data: CreateProductData) =>
    apiFetch<Product>(`/api/admin/${storeId}/products`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateProduct: (storeId: string, productId: number, data: Partial<CreateProductData>) =>
    apiFetch<Product>(`/api/admin/${storeId}/products/${productId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteProduct: (storeId: string, productId: number) =>
    apiFetch<void>(`/api/admin/${storeId}/products/${productId}`, {
      method: 'DELETE',
    }),
};
```

---

## 5. Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Multi-tenancy | Shared DB + RLS | Schema per tenant | Operational simplicity, scales to millions of stores |
| Cart storage | Valkey (Redis) | PostgreSQL | Fast read/write, natural expiry, session-like data |
| Payment flow | Two-step (intent + confirm) | Single charge | Allows client-side payment confirmation with Stripe |
| Idempotency | DB table | Redis with TTL | Durability for financial operations |
| Inventory lock | SERIALIZABLE + FOR UPDATE | Optimistic only | Prevents overselling on concurrent checkouts |
| Session auth | Express session + Redis | JWT | Simpler for SSR, revocable sessions |
| Message queue | RabbitMQ | Kafka | Simpler setup, sufficient for order processing volume |

---

## 6. Future Enhancements

1. **Webhook Delivery System**
   - Reliable delivery to merchant endpoints
   - Retry with exponential backoff
   - Signature verification for security

2. **Custom Domain Routing**
   - Edge worker for domain resolution
   - Automatic SSL provisioning via Let's Encrypt
   - DNS verification flow

3. **Inventory Webhooks**
   - Real-time inventory sync with external systems (ERP, warehouse)
   - Low stock alerts to RabbitMQ queue

4. **Order Fulfillment**
   - Shipping label generation
   - Tracking number updates
   - Automatic status transitions

5. **Analytics Dashboard**
   - Real-time sales metrics
   - Conversion funnel tracking
   - Revenue by product/variant
