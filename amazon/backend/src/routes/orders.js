import { Router } from 'express';
import { query, transaction } from '../services/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import logger from '../shared/logger.js';
import {
  ordersTotal,
  orderValue,
  orderProcessingDuration,
  orderCancellationsTotal,
  inventoryReleasesTotal
} from '../shared/metrics.js';
import {
  handleIdempotentOrder,
  completeIdempotentOrder,
  failIdempotentOrder
} from '../shared/idempotency.js';
import {
  auditOrderCreated,
  auditOrderCancelled,
  auditOrderStatusChanged,
  auditPaymentCompleted
} from '../shared/audit.js';
import { withDatabaseRetry } from '../shared/retry.js';
import { createPaymentCircuitBreaker } from '../shared/circuitBreaker.js';

const router = Router();

// ============================================================
// Payment Processing with Circuit Breaker
// ============================================================

/**
 * Simulate payment processing
 * In production, this would call a real payment gateway
 */
async function processPayment(order, paymentDetails) {
  // Simulate payment gateway call
  await new Promise(resolve => setTimeout(resolve, 100));

  // Simulate occasional failures for testing
  if (process.env.SIMULATE_PAYMENT_FAILURES === 'true' && Math.random() < 0.1) {
    const error = new Error('Payment gateway timeout');
    error.code = 'GATEWAY_TIMEOUT';
    throw error;
  }

  return {
    success: true,
    transactionId: `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    amount: order.total,
    method: paymentDetails.method || 'card',
    lastFour: paymentDetails.lastFour || '****',
    processedAt: new Date().toISOString()
  };
}

/**
 * Fallback when payment circuit is open
 */
async function paymentFallback(order, paymentDetails) {
  logger.warn({ orderId: order.id }, 'Payment circuit open, using fallback');
  // Queue for later processing or use backup gateway
  return {
    success: false,
    queued: true,
    message: 'Payment will be processed shortly'
  };
}

// Create circuit breaker for payment
const paymentBreaker = createPaymentCircuitBreaker(processPayment, paymentFallback);

// ============================================================
// Routes
// ============================================================

// Get user's orders
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, page = 0, limit = 10 } = req.query;

    let whereClause = 'WHERE o.user_id = $1';
    const params = [req.user.id];

    if (status) {
      params.push(status);
      whereClause += ` AND o.status = $${params.length}`;
    }

    const offset = parseInt(page) * parseInt(limit);

    const result = await withDatabaseRetry(async () => {
      return await query(
        `SELECT o.*,
                json_agg(json_build_object(
                  'id', oi.id,
                  'product_id', oi.product_id,
                  'product_title', oi.product_title,
                  'quantity', oi.quantity,
                  'price', oi.price
                )) as items
         FROM orders o
         LEFT JOIN order_items oi ON o.id = oi.order_id
         ${whereClause}
         GROUP BY o.id
         ORDER BY o.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parseInt(limit), offset]
      );
    });

    const countResult = await query(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`,
      params
    );

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    next(error);
  }
});

// Get single order
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT o.*
       FROM orders o
       WHERE o.id = $1 AND (o.user_id = $2 OR $3 = 'admin')`,
      [id, req.user.id, req.user.role]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = result.rows[0];

    // Get order items
    const itemsResult = await query(
      `SELECT oi.*, p.images, p.slug
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [id]
    );

    order.items = itemsResult.rows;

    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Create order (checkout) - WITH IDEMPOTENCY
router.post('/', requireAuth, async (req, res, next) => {
  const startTime = process.hrtime.bigint();
  const log = req.log || logger;

  try {
    // ============================================================
    // IDEMPOTENCY CHECK - Prevent duplicate orders
    // ============================================================
    const idempotencyResult = await handleIdempotentOrder(req);

    if (idempotencyResult.isDuplicate) {
      log.info({ idempotencyKey: req.idempotencyKey }, 'Returning cached order response');

      if (idempotencyResult.isProcessing) {
        return res.status(409).json(idempotencyResult.response);
      }

      return res.status(200).json(idempotencyResult.response);
    }

    // ============================================================
    // Validate Request
    // ============================================================
    const { shippingAddress, billingAddress, paymentMethod = 'card', notes } = req.body;

    if (!shippingAddress || !shippingAddress.street || !shippingAddress.city) {
      await failIdempotentOrder(req, new Error('Shipping address is required'));
      return res.status(400).json({ error: 'Shipping address is required' });
    }

    // ============================================================
    // Create Order with Retry
    // ============================================================
    const order = await withDatabaseRetry(async () => {
      return await transaction(async (client) => {
        // Get cart items with FOR UPDATE to lock
        const cartResult = await client.query(
          `SELECT ci.product_id, ci.quantity, p.title, p.price
           FROM cart_items ci
           JOIN products p ON ci.product_id = p.id
           WHERE ci.user_id = $1
           FOR UPDATE OF ci`,
          [req.user.id]
        );

        if (cartResult.rows.length === 0) {
          const error = new Error('Cart is empty');
          error.status = 400;
          throw error;
        }

        const cartItems = cartResult.rows;
        log.info({ itemCount: cartItems.length }, 'Processing checkout');

        // Verify inventory and calculate total
        let subtotal = 0;
        for (const item of cartItems) {
          const invResult = await client.query(
            `SELECT COALESCE(SUM(quantity), 0) as total_quantity
             FROM inventory
             WHERE product_id = $1`,
            [item.product_id]
          );

          const available = parseInt(invResult.rows[0].total_quantity);
          if (available < item.quantity) {
            const error = new Error(`Insufficient inventory for ${item.title}`);
            error.status = 400;
            throw error;
          }

          subtotal += parseFloat(item.price) * item.quantity;
        }

        // Calculate tax and shipping
        const tax = subtotal * 0.08; // 8% tax
        const shippingCost = subtotal >= 50 ? 0 : 5.99; // Free shipping over $50
        const total = subtotal + tax + shippingCost;

        // Create order with idempotency key
        const orderResult = await client.query(
          `INSERT INTO orders (user_id, subtotal, tax, shipping_cost, total, shipping_address, billing_address, payment_method, notes, status, payment_status, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'pending', $10)
           RETURNING *`,
          [req.user.id, subtotal, tax, shippingCost, total, shippingAddress, billingAddress || shippingAddress, paymentMethod, notes, req.idempotencyKey]
        );

        const order = orderResult.rows[0];

        // Create order items and update inventory
        for (const item of cartItems) {
          // Create order item
          await client.query(
            `INSERT INTO order_items (order_id, product_id, product_title, quantity, price)
             VALUES ($1, $2, $3, $4, $5)`,
            [order.id, item.product_id, item.title, item.quantity, item.price]
          );

          // Decrement inventory (both quantity and reserved)
          await client.query(
            `UPDATE inventory
             SET quantity = quantity - $1,
                 reserved = GREATEST(0, reserved - $1)
             WHERE product_id = $2`,
            [item.quantity, item.product_id]
          );

          // Track inventory release
          inventoryReleasesTotal.inc({ reason: 'checkout' });
        }

        // Clear cart
        await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);

        return { order, cartItems };
      });
    });

    // ============================================================
    // Process Payment with Circuit Breaker
    // ============================================================
    let paymentResult;
    try {
      paymentResult = await paymentBreaker.fire(order.order, {
        method: paymentMethod,
        lastFour: req.body.cardLastFour
      });

      if (paymentResult.success) {
        // Update order status
        await query(
          `UPDATE orders SET status = 'confirmed', payment_status = 'completed', updated_at = NOW()
           WHERE id = $1`,
          [order.order.id]
        );
        order.order.status = 'confirmed';
        order.order.payment_status = 'completed';

        // Audit payment success
        await auditPaymentCompleted(req, order.order.id, paymentResult);
      } else if (paymentResult.queued) {
        // Payment queued due to circuit breaker
        log.warn({ orderId: order.order.id }, 'Payment queued for later processing');
      }
    } catch (paymentError) {
      log.error({ orderId: order.order.id, error: paymentError.message }, 'Payment failed');
      // Order is created but payment failed - will need manual intervention
      await query(
        `UPDATE orders SET payment_status = 'failed', updated_at = NOW()
         WHERE id = $1`,
        [order.order.id]
      );
      order.order.payment_status = 'failed';
    }

    // ============================================================
    // Record Metrics and Audit
    // ============================================================
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;

    ordersTotal.inc({ status: order.order.status, payment_method: paymentMethod });
    orderValue.observe(parseFloat(order.order.total));
    orderProcessingDuration.observe(duration);

    // Audit order creation
    await auditOrderCreated(req, order.order, order.cartItems);

    // Complete idempotency record
    await completeIdempotentOrder(req, order.order);

    log.info({
      orderId: order.order.id,
      total: order.order.total,
      durationSeconds: duration.toFixed(3)
    }, 'Order created successfully');

    res.status(201).json({ order: order.order });
  } catch (error) {
    // Mark idempotency record as failed
    await failIdempotentOrder(req, error);

    log.error({ error: error.message }, 'Order creation failed');
    next(error);
  }
});

// Cancel order - WITH AUDIT LOGGING
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  const log = req.log || logger;

  try {
    const { id } = req.params;
    const { reason = 'Customer requested' } = req.body;

    const order = await transaction(async (client) => {
      // Get order
      const orderResult = await client.query(
        `SELECT * FROM orders
         WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'confirmed')
         FOR UPDATE`,
        [id, req.user.id]
      );

      if (orderResult.rows.length === 0) {
        const error = new Error('Order not found or cannot be cancelled');
        error.status = 400;
        throw error;
      }

      const order = orderResult.rows[0];

      // Get order items
      const itemsResult = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [id]
      );

      // Restore inventory
      for (const item of itemsResult.rows) {
        await client.query(
          `UPDATE inventory
           SET quantity = quantity + $1
           WHERE product_id = $2`,
          [item.quantity, item.product_id]
        );
        inventoryReleasesTotal.inc({ reason: 'cancellation' });
      }

      // Update order status
      await client.query(
        `UPDATE orders
         SET status = 'cancelled', payment_status = 'refunded', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      return { ...order, status: 'cancelled' };
    });

    // Record metrics and audit
    orderCancellationsTotal.inc({ reason: 'customer_request' });
    await auditOrderCancelled(req, order, reason);

    log.info({ orderId: id, reason }, 'Order cancelled');

    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Update order status (admin only) - WITH AUDIT LOGGING
router.put('/:id/status', requireAdmin, async (req, res, next) => {
  const log = req.log || logger;

  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get current status for audit
    const currentResult = await query('SELECT status FROM orders WHERE id = $1', [id]);
    if (currentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const oldStatus = currentResult.rows[0].status;

    const result = await query(
      `UPDATE orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Audit status change
    await auditOrderStatusChanged(req, id, oldStatus, status);

    log.info({ orderId: id, oldStatus, newStatus: status }, 'Order status updated by admin');

    res.json({ order: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

export default router;
