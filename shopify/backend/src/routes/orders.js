import { queryWithTenant, getClientWithTenant } from '../services/db.js';
import logger from '../services/logger.js';
import { withIdempotency } from '../services/idempotency.js';
import { logInventoryChange, logOrderCreated, logCheckoutEvent, logPaymentEvent, AuditAction, ActorType } from '../services/audit.js';
import { publishOrderCreated, publishInventoryUpdated, queueEmailNotification } from '../services/rabbitmq.js';
import { processPayment } from '../services/circuit-breaker.js';
import {
  checkoutsTotal,
  checkoutLatency,
  orderValue,
  ordersCreated,
  inventoryLevel,
  inventoryLow,
  inventoryOutOfStock,
} from '../services/metrics.js';
import config from '../config/index.js';

// List orders for store
export async function listOrders(req, res) {
  const { storeId } = req;

  const result = await queryWithTenant(
    storeId,
    `SELECT o.*,
            (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
     FROM orders o
     ORDER BY o.created_at DESC`
  );

  res.json({ orders: result.rows });
}

// Get single order
export async function getOrder(req, res) {
  const { storeId } = req;
  const { orderId } = req.params;

  const result = await queryWithTenant(
    storeId,
    `SELECT o.*,
            (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
     FROM orders o
     WHERE o.id = $1`,
    [orderId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }

  res.json({ order: result.rows[0] });
}

// Update order status
export async function updateOrder(req, res) {
  const { storeId } = req;
  const { orderId } = req.params;
  const { payment_status, fulfillment_status, notes } = req.body;

  // Get current state for audit
  const currentResult = await queryWithTenant(
    storeId,
    'SELECT payment_status, fulfillment_status, notes FROM orders WHERE id = $1',
    [orderId]
  );

  if (currentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const before = currentResult.rows[0];

  const updates = [];
  const values = [];
  let paramCount = 1;

  if (payment_status !== undefined) {
    updates.push(`payment_status = $${paramCount++}`);
    values.push(payment_status);
  }
  if (fulfillment_status !== undefined) {
    updates.push(`fulfillment_status = $${paramCount++}`);
    values.push(fulfillment_status);
  }
  if (notes !== undefined) {
    updates.push(`notes = $${paramCount++}`);
    values.push(notes);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push(`updated_at = NOW()`);
  values.push(orderId);

  const result = await queryWithTenant(
    storeId,
    `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramCount}
     RETURNING *`,
    values
  );

  const order = result.rows[0];

  // Audit log the update
  const auditContext = {
    storeId,
    userId: req.user?.id,
    userType: req.user?.role || ActorType.MERCHANT,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };

  await import('../services/audit.js').then(m => m.logOrderUpdated(
    auditContext,
    orderId,
    before,
    { payment_status: order.payment_status, fulfillment_status: order.fulfillment_status, notes: order.notes }
  ));

  res.json({ order });
}

// === Cart & Checkout (Storefront) ===

// Get or create cart
export async function getCart(req, res) {
  const { storeId } = req;
  const sessionId = req.cookies?.cartSession || req.headers['x-cart-session'];

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  if (!sessionId) {
    return res.json({ cart: null });
  }

  const result = await queryWithTenant(
    storeId,
    `SELECT c.*,
            (SELECT json_agg(json_build_object(
              'variant_id', v.id,
              'product_id', p.id,
              'product_title', p.title,
              'variant_title', v.title,
              'price', v.price,
              'image', (p.images->0->>'url'),
              'quantity', (SELECT (item->>'quantity')::int FROM jsonb_array_elements(c.items) item WHERE (item->>'variant_id')::int = v.id LIMIT 1)
            )) FROM jsonb_array_elements(c.items) item
            JOIN variants v ON v.id = (item->>'variant_id')::int
            JOIN products p ON p.id = v.product_id) as line_items
     FROM carts c
     WHERE c.session_id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return res.json({ cart: null });
  }

  res.json({ cart: result.rows[0] });
}

// Add item to cart
export async function addToCart(req, res) {
  const { storeId } = req;
  const { variantId, quantity = 1 } = req.body;
  let sessionId = req.cookies?.cartSession || req.headers['x-cart-session'];

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  if (!variantId) {
    return res.status(400).json({ error: 'Variant ID required' });
  }

  // Verify variant exists and has inventory
  const variant = await queryWithTenant(
    storeId,
    'SELECT id, price, inventory_quantity FROM variants WHERE id = $1',
    [variantId]
  );

  if (variant.rows.length === 0) {
    return res.status(404).json({ error: 'Variant not found' });
  }

  if (variant.rows[0].inventory_quantity < quantity) {
    return res.status(400).json({ error: 'Insufficient inventory' });
  }

  const client = await getClientWithTenant(storeId);

  try {
    await client.query('BEGIN');

    // Check if cart exists
    let cart;
    if (sessionId) {
      const existing = await client.query(
        'SELECT * FROM carts WHERE session_id = $1',
        [sessionId]
      );
      cart = existing.rows[0];
    }

    if (!cart) {
      // Create new cart
      sessionId = `cart_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const result = await client.query(
        `INSERT INTO carts (store_id, session_id, items, subtotal)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [storeId, sessionId, JSON.stringify([{ variant_id: variantId, quantity }]), variant.rows[0].price * quantity]
      );
      cart = result.rows[0];
    } else {
      // Update existing cart
      const items = cart.items || [];
      const existingIndex = items.findIndex(i => i.variant_id === variantId);

      if (existingIndex >= 0) {
        items[existingIndex].quantity += quantity;
      } else {
        items.push({ variant_id: variantId, quantity });
      }

      // Recalculate subtotal
      let subtotal = 0;
      for (const item of items) {
        const v = await client.query('SELECT price FROM variants WHERE id = $1', [item.variant_id]);
        if (v.rows.length > 0) {
          subtotal += v.rows[0].price * item.quantity;
        }
      }

      const result = await client.query(
        `UPDATE carts SET items = $1, subtotal = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [JSON.stringify(items), subtotal, cart.id]
      );
      cart = result.rows[0];
    }

    await client.query('COMMIT');

    res.cookie('cartSession', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 604800000, // 7 days
    });

    res.json({ cart, sessionId });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Update cart item quantity
export async function updateCartItem(req, res) {
  const { storeId } = req;
  const { variantId, quantity } = req.body;
  const sessionId = req.cookies?.cartSession || req.headers['x-cart-session'];

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  if (!sessionId) {
    return res.status(400).json({ error: 'No cart session' });
  }

  const client = await getClientWithTenant(storeId);

  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM carts WHERE session_id = $1', [sessionId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    const cart = existing.rows[0];
    let items = cart.items || [];

    if (quantity <= 0) {
      // Remove item
      items = items.filter(i => i.variant_id !== variantId);
    } else {
      // Update quantity
      const index = items.findIndex(i => i.variant_id === variantId);
      if (index >= 0) {
        items[index].quantity = quantity;
      }
    }

    // Recalculate subtotal
    let subtotal = 0;
    for (const item of items) {
      const v = await client.query('SELECT price FROM variants WHERE id = $1', [item.variant_id]);
      if (v.rows.length > 0) {
        subtotal += v.rows[0].price * item.quantity;
      }
    }

    const result = await client.query(
      `UPDATE carts SET items = $1, subtotal = $2, updated_at = NOW() WHERE session_id = $3 RETURNING *`,
      [JSON.stringify(items), subtotal, sessionId]
    );

    await client.query('COMMIT');

    res.json({ cart: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Process checkout with idempotency, audit logging, and async notifications
 *
 * This function demonstrates several reliability patterns:
 * 1. Idempotency - prevents duplicate orders if client retries
 * 2. Audit logging - tracks all checkout events for dispute resolution
 * 3. Circuit breaker - protects against payment gateway failures
 * 4. Async queues - reliable delivery of order notifications
 * 5. Metrics - tracks checkout latency and success rates
 */
export async function checkout(req, res) {
  const { storeId } = req;
  const { email, shippingAddress, billingAddress } = req.body;
  const sessionId = req.cookies?.cartSession || req.headers['x-cart-session'];
  const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

  // Track checkout start time for latency metrics
  const checkoutStartTime = Date.now();

  // Build audit context
  const auditContext = {
    storeId,
    userId: null, // Guest checkout
    userType: ActorType.CUSTOMER,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  if (!sessionId) {
    return res.status(400).json({ error: 'No cart session' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  // Log checkout started
  await logCheckoutEvent(auditContext, AuditAction.CHECKOUT_STARTED, {
    cartId: sessionId,
    email,
  });

  try {
    // If idempotency key provided, wrap in idempotency handler
    if (idempotencyKey) {
      const { result, deduplicated } = await withIdempotency(
        idempotencyKey,
        storeId,
        'checkout',
        async () => processCheckoutInternal(storeId, sessionId, email, shippingAddress, billingAddress, auditContext),
        { email, cartSession: sessionId }
      );

      // Record metrics
      const latency = (Date.now() - checkoutStartTime) / 1000;
      checkoutLatency.observe({ store_id: storeId.toString(), status: 'success' }, latency);
      checkoutsTotal.inc({ store_id: storeId.toString(), status: 'success' });

      if (deduplicated) {
        logger.info({ storeId, idempotencyKey }, 'Checkout deduplicated via idempotency key');
        return res.status(200).json({ order: result, deduplicated: true });
      }

      res.clearCookie('cartSession');
      return res.status(201).json({ order: result });
    }

    // No idempotency key - process directly (not recommended for production)
    const order = await processCheckoutInternal(storeId, sessionId, email, shippingAddress, billingAddress, auditContext);

    // Record metrics
    const latency = (Date.now() - checkoutStartTime) / 1000;
    checkoutLatency.observe({ store_id: storeId.toString(), status: 'success' }, latency);
    checkoutsTotal.inc({ store_id: storeId.toString(), status: 'success' });

    res.clearCookie('cartSession');
    res.status(201).json({ order });
  } catch (error) {
    // Record failure metrics
    const latency = (Date.now() - checkoutStartTime) / 1000;
    checkoutLatency.observe({ store_id: storeId.toString(), status: 'failed' }, latency);
    checkoutsTotal.inc({ store_id: storeId.toString(), status: 'failed' });

    // Log checkout failure
    await logCheckoutEvent(auditContext, AuditAction.CHECKOUT_FAILED, {
      cartId: sessionId,
      error: error.message,
    });

    logger.error({ err: error, storeId, sessionId }, 'Checkout failed');
    throw error;
  }
}

/**
 * Internal checkout processing with transaction, inventory updates, and audit logging
 */
async function processCheckoutInternal(storeId, sessionId, email, shippingAddress, billingAddress, auditContext) {
  const client = await getClientWithTenant(storeId);

  try {
    // Use SERIALIZABLE isolation for inventory consistency
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    // Get cart
    const cartResult = await client.query('SELECT * FROM carts WHERE session_id = $1', [sessionId]);
    if (cartResult.rows.length === 0) {
      throw new Error('Cart not found');
    }

    const cart = cartResult.rows[0];
    const items = cart.items || [];

    if (items.length === 0) {
      throw new Error('Cart is empty');
    }

    // Validate and reserve inventory with pessimistic locking
    const lineItems = [];
    for (const item of items) {
      // SELECT FOR UPDATE prevents concurrent modifications
      const variant = await client.query(
        `SELECT v.*, p.title as product_title
         FROM variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.id = $1
         FOR UPDATE`,
        [item.variant_id]
      );

      if (variant.rows.length === 0) {
        throw new Error(`Variant ${item.variant_id} no longer exists`);
      }

      const variantData = variant.rows[0];
      const oldQuantity = variantData.inventory_quantity;

      if (oldQuantity < item.quantity) {
        throw new Error(`${variantData.product_title} is out of stock (requested: ${item.quantity}, available: ${oldQuantity})`);
      }

      lineItems.push({
        variant: variantData,
        quantity: item.quantity,
        price: variantData.price,
        total: variantData.price * item.quantity,
        oldQuantity,
      });

      // Reserve inventory (decrement)
      const newQuantity = oldQuantity - item.quantity;
      await client.query(
        'UPDATE variants SET inventory_quantity = $1, updated_at = NOW() WHERE id = $2',
        [newQuantity, item.variant_id]
      );

      // Log inventory change for audit trail
      await logInventoryChange(
        auditContext,
        item.variant_id,
        oldQuantity,
        newQuantity,
        `checkout_reserve:${sessionId}`
      );

      // Update inventory metrics
      inventoryLevel.set(
        { store_id: storeId.toString(), variant_id: item.variant_id.toString(), sku: variantData.sku || '' },
        newQuantity
      );

      // Check for low/out of stock
      if (newQuantity === 0) {
        inventoryOutOfStock.inc({ store_id: storeId.toString(), variant_id: item.variant_id.toString() });
      } else if (newQuantity < config.inventory.lowStockThreshold) {
        inventoryLow.inc({ store_id: storeId.toString(), variant_id: item.variant_id.toString() });
      }

      // Publish inventory update event (async)
      await publishInventoryUpdated(storeId, item.variant_id, oldQuantity, newQuantity);
    }

    // Calculate totals
    const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const shippingCost = 0; // Free shipping for demo
    const tax = subtotal * 0.1; // 10% tax for demo
    const total = subtotal + shippingCost + tax;

    // Process payment with circuit breaker
    const paymentResult = await processPayment({
      amount: Math.round(total * 100), // cents
      storeId,
      cartId: sessionId,
      email,
    });

    // Log payment result
    await logPaymentEvent(auditContext, paymentResult.success, {
      amount: total,
      paymentIntentId: paymentResult.paymentIntentId,
      orderId: null, // Will be set after order creation
    });

    if (!paymentResult.success && !paymentResult.deferred) {
      // Payment failed - rollback inventory
      for (const item of lineItems) {
        await client.query(
          'UPDATE variants SET inventory_quantity = $1, updated_at = NOW() WHERE id = $2',
          [item.oldQuantity, item.variant.id]
        );

        // Log inventory restoration
        await logInventoryChange(
          auditContext,
          item.variant.id,
          item.oldQuantity - item.quantity,
          item.oldQuantity,
          'checkout_payment_failed:rollback'
        );
      }
      throw new Error('Payment failed');
    }

    // Generate order number
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (store_id, order_number, customer_email, subtotal, shipping_cost, tax, total,
                          payment_status, fulfillment_status, shipping_address, billing_address, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        storeId,
        orderNumber,
        email,
        subtotal,
        shippingCost,
        tax,
        total,
        paymentResult.deferred ? 'pending' : 'paid',
        'unfulfilled',
        JSON.stringify(shippingAddress || {}),
        JSON.stringify(billingAddress || shippingAddress || {}),
        paymentResult.paymentIntentId || null,
      ]
    );

    const order = orderResult.rows[0];

    // Create order items
    for (const item of lineItems) {
      await client.query(
        `INSERT INTO order_items (order_id, store_id, variant_id, title, variant_title, sku, quantity, price, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          order.id,
          storeId,
          item.variant.id,
          item.variant.product_title,
          item.variant.title,
          item.variant.sku,
          item.quantity,
          item.price,
          item.total,
        ]
      );
    }

    // Clear cart
    await client.query('DELETE FROM carts WHERE session_id = $1', [sessionId]);

    await client.query('COMMIT');

    // Record order metrics
    ordersCreated.inc({ store_id: storeId.toString() });
    orderValue.observe({ store_id: storeId.toString() }, total);

    // Log order created
    await logOrderCreated(auditContext, {
      ...order,
      items: lineItems.map(i => ({
        variantId: i.variant.id,
        quantity: i.quantity,
        price: i.price,
      })),
    });

    // Publish order created event for async processing
    await publishOrderCreated({
      ...order,
      items: lineItems.map(i => ({
        variantId: i.variant.id,
        title: i.variant.product_title,
        quantity: i.quantity,
        price: i.price,
      })),
    });

    // Queue email notification
    await queueEmailNotification(email, 'order_confirmation', {
      orderNumber: order.order_number,
      total: order.total,
      items: lineItems.length,
    });

    logger.info({ storeId, orderId: order.id, orderNumber: order.order_number, total }, 'Order created successfully');

    return order;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// List customers for store
export async function listCustomers(req, res) {
  const { storeId } = req;

  const result = await queryWithTenant(
    storeId,
    `SELECT c.*,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) as order_count,
            (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id) as total_spent
     FROM customers c
     ORDER BY c.created_at DESC`
  );

  res.json({ customers: result.rows });
}

// Get single customer
export async function getCustomer(req, res) {
  const { storeId } = req;
  const { customerId } = req.params;

  const result = await queryWithTenant(
    storeId,
    `SELECT c.*,
            (SELECT json_agg(a.*) FROM customer_addresses a WHERE a.customer_id = c.id) as addresses,
            (SELECT json_agg(o.* ORDER BY o.created_at DESC) FROM orders o WHERE o.customer_id = c.id) as orders
     FROM customers c
     WHERE c.id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json({ customer: result.rows[0] });
}
