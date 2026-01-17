import { Router } from 'express';
import { query, transaction } from '../services/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

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

    const result = await query(
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

// Create order (checkout)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { shippingAddress, billingAddress, paymentMethod = 'card', notes } = req.body;

    if (!shippingAddress || !shippingAddress.street || !shippingAddress.city) {
      return res.status(400).json({ error: 'Shipping address is required' });
    }

    const order = await transaction(async (client) => {
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

      // Create order
      const orderResult = await client.query(
        `INSERT INTO orders (user_id, subtotal, tax, shipping_cost, total, shipping_address, billing_address, payment_method, notes, status, payment_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', 'completed')
         RETURNING *`,
        [req.user.id, subtotal, tax, shippingCost, total, shippingAddress, billingAddress || shippingAddress, paymentMethod, notes]
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
      }

      // Clear cart
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);

      return order;
    });

    res.status(201).json({ order });
  } catch (error) {
    next(error);
  }
});

// Cancel order
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

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

    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Update order status (admin only)
router.put('/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

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

    res.json({ order: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

export default router;
