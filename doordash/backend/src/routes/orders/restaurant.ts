/**
 * Restaurant orders route module.
 * @module routes/orders/restaurant
 * @description Handles order retrieval for restaurant owners and admins,
 * providing access to incoming orders with customer and item details.
 */

import { Router, Request, Response } from 'express';
import { query } from '../../db.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import logger from '../../shared/logger.js';

const router = Router();

/**
 * GET /orders/restaurant/:restaurantId
 * @description Retrieves orders for a specific restaurant with filtering options.
 *
 * Returns orders placed at the restaurant with customer contact information
 * and order items. Only accessible by the restaurant owner or admin users.
 * Results are sorted by placement time (newest first).
 *
 * @requires Authentication - User must be logged in
 * @requires Role - User must be 'restaurant_owner' or 'admin'
 *
 * @param req.params.restaurantId - The restaurant ID to get orders for
 * @param req.query.status - Optional status filter:
 *   - 'active': All orders not in DELIVERED, COMPLETED, or CANCELLED state
 *   - Specific status string (e.g., 'PREPARING', 'READY_FOR_PICKUP')
 * @param req.query.limit - Maximum number of orders to return (default: 50)
 *
 * @returns 200 - Array of orders with customer info and items
 * @returns 403 - User not authorized (not owner and not admin)
 * @returns 404 - Restaurant not found
 * @returns 500 - Server error
 *
 * @example
 * // Get all active orders for restaurant
 * GET /orders/restaurant/5?status=active
 *
 * @example
 * // Get orders ready for pickup
 * GET /orders/restaurant/5?status=READY_FOR_PICKUP&limit=20
 */
router.get(
  '/restaurant/:restaurantId',
  requireAuth,
  requireRole('restaurant_owner', 'admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { restaurantId } = req.params;
      const { status, limit = '50' } = req.query;

      // Check ownership
      const restaurant = await query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurantId]);
      if (restaurant.rows.length === 0) {
        res.status(404).json({ error: 'Restaurant not found' });
        return;
      }
      if (restaurant.rows[0].owner_id !== req.user!.id && req.user!.role !== 'admin') {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }

      let sql = `
      SELECT o.*, u.name as customer_name, u.phone as customer_phone
      FROM orders o
      JOIN users u ON o.customer_id = u.id
      WHERE o.restaurant_id = $1
    `;
      const params: unknown[] = [restaurantId];

      if (status) {
        if (status === 'active') {
          sql += ` AND o.status NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED')`;
        } else {
          params.push(status);
          sql += ` AND o.status = $${params.length}`;
        }
      }

      sql += ' ORDER BY o.placed_at DESC LIMIT $' + (params.length + 1);
      params.push(parseInt(limit as string));

      const result = await query(sql, params);

      // Get items for each order
      const orders = await Promise.all(
        result.rows.map(async (order: { id: number }) => {
          const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
          return { ...order, items: itemsResult.rows };
        })
      );

      res.json({ orders });
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message, restaurantId: req.params.restaurantId }, 'Get restaurant orders error');
      res.status(500).json({ error: 'Failed to get orders' });
    }
  }
);

/**
 * Express router for restaurant order endpoints.
 * @description Exports the router configured with the GET /restaurant/:restaurantId endpoint.
 */
export default router;
