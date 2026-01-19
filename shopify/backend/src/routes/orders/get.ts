import { Request, Response } from 'express';
import { queryWithTenant } from '../../services/db.js';

/**
 * Retrieves all orders for the current store with their line items.
 *
 * @description Fetches orders from the database ordered by creation date (newest first).
 * Each order includes its associated order items as a nested JSON array.
 * Results are automatically scoped to the current store via tenant isolation.
 *
 * @param req - Express request object with storeId populated by middleware
 * @param res - Express response object
 * @returns Promise that resolves when the response is sent
 *
 * @example
 * // GET /api/v1/orders
 * // Response: { orders: [{ id: 1, order_number: "ORD-ABC123", items: [...], ... }] }
 */
export async function listOrders(req: Request, res: Response): Promise<void> {
  const { storeId } = req;

  const result = await queryWithTenant(
    storeId!,
    `SELECT o.*,
            (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
     FROM orders o
     ORDER BY o.created_at DESC`
  );

  res.json({ orders: result.rows });
}

/**
 * Retrieves a single order by ID with its line items.
 *
 * @description Fetches a specific order from the database including all associated
 * order items as a nested JSON array. The order must belong to the current store.
 *
 * @param req - Express request object with storeId and orderId params
 * @param res - Express response object
 * @returns Promise that resolves when the response is sent, or returns 404 if not found
 *
 * @throws Returns 404 JSON response if order is not found
 *
 * @example
 * // GET /api/v1/orders/123
 * // Response: { order: { id: 123, order_number: "ORD-ABC123", items: [...], ... } }
 */
export async function getOrder(req: Request, res: Response): Promise<void | Response> {
  const { storeId } = req;
  const { orderId } = req.params;

  const result = await queryWithTenant(
    storeId!,
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
