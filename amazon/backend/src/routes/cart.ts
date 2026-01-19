import { Router } from 'express';
import { query, transaction } from '../services/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const RESERVATION_MINUTES = parseInt(process.env.CART_RESERVATION_MINUTES) || 30;

// Get cart
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ci.id, ci.quantity, ci.reserved_until, ci.added_at,
              p.id as product_id, p.title, p.slug, p.price, p.images,
              COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE ci.user_id = $1
       GROUP BY ci.id, p.id
       ORDER BY ci.added_at DESC`,
      [req.user.id]
    );

    const items = result.rows;
    const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);

    res.json({
      items,
      subtotal: subtotal.toFixed(2),
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0)
    });
  } catch (error) {
    next(error);
  }
});

// Add to cart
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { productId, quantity = 1 } = req.body;

    await transaction(async (client) => {
      // Check available inventory
      const inventoryResult = await client.query(
        `SELECT COALESCE(SUM(quantity - reserved), 0) as available
         FROM inventory
         WHERE product_id = $1`,
        [productId]
      );

      const available = parseInt(inventoryResult.rows[0].available);

      // Check existing cart item
      const existingResult = await client.query(
        'SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [req.user.id, productId]
      );

      const existingQuantity = existingResult.rows[0]?.quantity || 0;
      const totalQuantity = existingQuantity + quantity;

      if (available < totalQuantity) {
        const error = new Error(`Only ${available} items available`);
        error.status = 400;
        throw error;
      }

      // Reserve inventory
      await client.query(
        `UPDATE inventory
         SET reserved = reserved + $1
         WHERE product_id = $2`,
        [quantity, productId]
      );

      // Calculate reservation expiry
      const reservedUntil = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);

      // Upsert cart item
      await client.query(
        `INSERT INTO cart_items (user_id, product_id, quantity, reserved_until)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, product_id)
         DO UPDATE SET quantity = cart_items.quantity + $3, reserved_until = $4`,
        [req.user.id, productId, quantity, reservedUntil]
      );
    });

    // Return updated cart
    const cart = await getCart(req.user.id);
    res.json(cart);
  } catch (error) {
    next(error);
  }
});

// Update cart item quantity
router.put('/:productId', requireAuth, async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { quantity } = req.body;

    if (quantity < 1) {
      return res.status(400).json({ error: 'Quantity must be at least 1' });
    }

    await transaction(async (client) => {
      // Get current cart item
      const currentResult = await client.query(
        'SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [req.user.id, productId]
      );

      if (currentResult.rows.length === 0) {
        const error = new Error('Item not in cart');
        error.status = 404;
        throw error;
      }

      const currentQuantity = currentResult.rows[0].quantity;
      const quantityDiff = quantity - currentQuantity;

      if (quantityDiff > 0) {
        // Need more - check availability
        const inventoryResult = await client.query(
          `SELECT COALESCE(SUM(quantity - reserved), 0) as available
           FROM inventory
           WHERE product_id = $1`,
          [productId]
        );

        const available = parseInt(inventoryResult.rows[0].available);
        if (available < quantityDiff) {
          const error = new Error(`Only ${available + currentQuantity} items available`);
          error.status = 400;
          throw error;
        }
      }

      // Update reservation
      await client.query(
        `UPDATE inventory
         SET reserved = reserved + $1
         WHERE product_id = $2`,
        [quantityDiff, productId]
      );

      // Update cart item
      const reservedUntil = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);
      await client.query(
        `UPDATE cart_items
         SET quantity = $1, reserved_until = $2
         WHERE user_id = $3 AND product_id = $4`,
        [quantity, reservedUntil, req.user.id, productId]
      );
    });

    const cart = await getCart(req.user.id);
    res.json(cart);
  } catch (error) {
    next(error);
  }
});

// Remove from cart
router.delete('/:productId', requireAuth, async (req, res, next) => {
  try {
    const { productId } = req.params;

    await transaction(async (client) => {
      // Get cart item quantity
      const cartResult = await client.query(
        'SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [req.user.id, productId]
      );

      if (cartResult.rows.length === 0) {
        return; // Nothing to remove
      }

      const quantity = cartResult.rows[0].quantity;

      // Release reservation
      await client.query(
        `UPDATE inventory
         SET reserved = GREATEST(0, reserved - $1)
         WHERE product_id = $2`,
        [quantity, productId]
      );

      // Remove cart item
      await client.query(
        'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [req.user.id, productId]
      );
    });

    const cart = await getCart(req.user.id);
    res.json(cart);
  } catch (error) {
    next(error);
  }
});

// Clear cart
router.delete('/', requireAuth, async (req, res, next) => {
  try {
    await transaction(async (client) => {
      // Get all cart items
      const cartResult = await client.query(
        'SELECT product_id, quantity FROM cart_items WHERE user_id = $1',
        [req.user.id]
      );

      // Release all reservations
      for (const item of cartResult.rows) {
        await client.query(
          `UPDATE inventory
           SET reserved = GREATEST(0, reserved - $1)
           WHERE product_id = $2`,
          [item.quantity, item.product_id]
        );
      }

      // Clear cart
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);
    });

    res.json({ items: [], subtotal: '0.00', itemCount: 0 });
  } catch (error) {
    next(error);
  }
});

// Helper function to get cart
async function getCart(userId) {
  const result = await query(
    `SELECT ci.id, ci.quantity, ci.reserved_until, ci.added_at,
            p.id as product_id, p.title, p.slug, p.price, p.images,
            COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
     FROM cart_items ci
     JOIN products p ON ci.product_id = p.id
     LEFT JOIN inventory i ON p.id = i.product_id
     WHERE ci.user_id = $1
     GROUP BY ci.id, p.id
     ORDER BY ci.added_at DESC`,
    [userId]
  );

  const items = result.rows;
  const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);

  return {
    items,
    subtotal: subtotal.toFixed(2),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0)
  };
}

export default router;
