import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

// Get user's orders (as buyer)
router.get('/', isAuthenticated, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT o.*, s.name as shop_name, s.slug as shop_slug
      FROM orders o
      JOIN shops s ON o.shop_id = s.id
      WHERE o.buyer_id = $1
    `;
    const params = [req.session.userId];

    if (status) {
      query += ` AND o.status = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get order items for each order
    for (const order of result.rows) {
      const itemsResult = await db.query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [order.id]
      );
      order.items = itemsResult.rows;
    }

    res.json({ orders: result.rows });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// Get single order
router.get('/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT o.*, s.name as shop_name, s.slug as shop_slug, s.location as shop_location,
              u.email as buyer_email, u.full_name as buyer_name
       FROM orders o
       JOIN shops s ON o.shop_id = s.id
       LEFT JOIN users u ON o.buyer_id = u.id
       WHERE o.id = $1`,
      [parseInt(id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = result.rows[0];

    // Check if user is buyer or shop owner
    const isOwner = req.session.shopIds && req.session.shopIds.includes(order.shop_id);
    const isBuyer = order.buyer_id === req.session.userId;

    if (!isOwner && !isBuyer) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get order items
    const itemsResult = await db.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [order.id]
    );
    order.items = itemsResult.rows;

    res.json({ order });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to get order' });
  }
});

// Create order (checkout)
router.post('/checkout', isAuthenticated, async (req, res) => {
  try {
    const { shippingAddress, notes } = req.body;

    if (!shippingAddress) {
      return res.status(400).json({ error: 'Shipping address is required' });
    }

    // Get cart items
    const cartResult = await db.query(
      `SELECT ci.*, p.title, p.price, p.quantity as available, p.images, p.shipping_price, p.shop_id
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.user_id = $1 AND p.is_active = true`,
      [req.session.userId]
    );

    if (cartResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Validate availability
    for (const item of cartResult.rows) {
      if (item.available < item.quantity) {
        return res.status(400).json({
          error: `${item.title} only has ${item.available} item(s) available`,
        });
      }
    }

    // Group by shop
    const byShop = cartResult.rows.reduce((acc, item) => {
      if (!acc[item.shop_id]) {
        acc[item.shop_id] = {
          shopId: item.shop_id,
          items: [],
          subtotal: 0,
          shippingTotal: 0,
        };
      }
      acc[item.shop_id].items.push(item);
      acc[item.shop_id].subtotal += parseFloat(item.price) * item.quantity;
      acc[item.shop_id].shippingTotal += parseFloat(item.shipping_price);
      return acc;
    }, {});

    const client = await db.getClient();
    const createdOrders = [];

    try {
      await client.query('BEGIN');

      // Create one order per shop
      for (const shopGroup of Object.values(byShop)) {
        const orderNumber = `ORD-${uuidv4().substring(0, 8).toUpperCase()}`;
        const total = shopGroup.subtotal + shopGroup.shippingTotal;

        const orderResult = await client.query(
          `INSERT INTO orders (buyer_id, shop_id, order_number, subtotal, shipping, total, shipping_address, notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
           RETURNING *`,
          [
            req.session.userId,
            shopGroup.shopId,
            orderNumber,
            shopGroup.subtotal,
            shopGroup.shippingTotal,
            total,
            JSON.stringify(shippingAddress),
            notes || null,
          ]
        );

        const order = orderResult.rows[0];

        // Create order items and update inventory
        for (const item of shopGroup.items) {
          await client.query(
            `INSERT INTO order_items (order_id, product_id, title, price, quantity, image_url)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              order.id,
              item.product_id,
              item.title,
              parseFloat(item.price),
              item.quantity,
              item.images && item.images.length > 0 ? item.images[0] : null,
            ]
          );

          // Decrement product quantity
          await client.query(
            'UPDATE products SET quantity = quantity - $1 WHERE id = $2',
            [item.quantity, item.product_id]
          );
        }

        // Update shop sales count
        await client.query(
          'UPDATE shops SET sales_count = sales_count + 1 WHERE id = $1',
          [shopGroup.shopId]
        );

        createdOrders.push(order);
      }

      // Clear cart
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.session.userId]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.status(201).json({
      message: 'Order placed successfully',
      orders: createdOrders,
    });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// Update order status (seller only)
router.put('/:id/status', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, trackingNumber } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get order and check shop ownership
    const orderResult = await db.query('SELECT shop_id FROM orders WHERE id = $1', [parseInt(id)]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const shopId = orderResult.rows[0].shop_id;
    if (!req.session.shopIds || !req.session.shopIds.includes(shopId)) {
      return res.status(403).json({ error: 'You do not own this shop' });
    }

    const result = await db.query(
      `UPDATE orders SET
        status = $1,
        tracking_number = COALESCE($2, tracking_number),
        updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, trackingNumber || null, parseInt(id)]
    );

    res.json({ order: result.rows[0] });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
