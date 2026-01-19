/**
 * Order retrieval route module.
 * @module routes/orders/get
 * @description Handles fetching individual orders and listing customer orders
 * with proper authorization checks.
 */

import { Router, Request, Response } from 'express';
import { query } from '../../db.js';
import { requireAuth } from '../../middleware/auth.js';
import logger from '../../shared/logger.js';
import { getOrderWithDetails } from './helpers.js';

const router = Router();

/**
 * GET /orders/:id
 * @description Retrieves a single order by ID with full details.
 *
 * Authorization is checked to ensure only authorized parties can view the order:
 * - The customer who placed the order
 * - The restaurant owner fulfilling the order
 * - The driver assigned to deliver the order
 * - Admin users
 *
 * @requires Authentication - User must be logged in
 *
 * @param req.params.id - The order ID to retrieve
 *
 * @returns 200 - Order found with full details (restaurant, driver, items)
 * @returns 403 - User not authorized to view this order
 * @returns 404 - Order not found
 * @returns 500 - Server error
 */
router.get('/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const order = await getOrderWithDetails(parseInt(id));

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // Check authorization
    const isCustomer = order.customer_id === req.user!.id;
    const isRestaurantOwner = order.restaurant?.owner_id === req.user!.id;
    const isDriver = order.driver?.user_id === req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    if (!isCustomer && !isRestaurantOwner && !isDriver && !isAdmin) {
      res.status(403).json({ error: 'Not authorized to view this order' });
      return;
    }

    res.json({ order });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message, orderId: req.params.id }, 'Get order error');
    res.status(500).json({ error: 'Failed to get order' });
  }
});

/**
 * GET /orders
 * @description Retrieves a paginated list of orders for the authenticated customer.
 *
 * Returns orders placed by the current user with basic restaurant information.
 * Results are sorted by placement time (newest first).
 *
 * @requires Authentication - User must be logged in
 *
 * @param req.query.status - Optional status filter (e.g., 'PLACED', 'DELIVERED')
 * @param req.query.limit - Maximum number of orders to return (default: 20)
 * @param req.query.offset - Number of orders to skip for pagination (default: 0)
 *
 * @returns 200 - Array of orders with basic restaurant info
 * @returns 500 - Server error
 *
 * @example
 * // Get first page of delivered orders
 * GET /orders?status=DELIVERED&limit=10&offset=0
 */
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, limit = '20', offset = '0' } = req.query;

    let sql = `
      SELECT o.*, r.name as restaurant_name, r.image_url as restaurant_image
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE o.customer_id = $1
    `;
    const params: unknown[] = [req.user!.id];

    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }

    sql += ' ORDER BY o.placed_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query(sql, params);

    res.json({ orders: result.rows });
  } catch (err) {
    const error = err as Error;
    logger.error({ error: error.message }, 'Get orders error');
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

/**
 * Express router for order retrieval endpoints.
 * @description Exports the router configured with GET endpoints for fetching orders.
 */
export default router;
