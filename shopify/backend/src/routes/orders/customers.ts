import { Request, Response } from 'express';
import { queryWithTenant } from '../../services/db.js';

/**
 * Retrieves all customers for the current store with order statistics.
 *
 * @description Fetches customers from the database ordered by creation date (newest first).
 * Each customer includes aggregated statistics: total order count and total amount spent.
 * Results are automatically scoped to the current store via tenant isolation.
 *
 * @param req - Express request object with storeId populated by middleware
 * @param res - Express response object
 * @returns Promise that resolves when the response is sent
 *
 * @example
 * // GET /api/v1/customers
 * // Response: { customers: [{ id: 1, email: "john@example.com", order_count: 5, total_spent: 499.99, ... }] }
 */
export async function listCustomers(req: Request, res: Response): Promise<void> {
  const { storeId } = req;

  const result = await queryWithTenant(
    storeId!,
    `SELECT c.*,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) as order_count,
            (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id) as total_spent
     FROM customers c
     ORDER BY c.created_at DESC`
  );

  res.json({ customers: result.rows });
}

/**
 * Retrieves a single customer by ID with addresses and order history.
 *
 * @description Fetches a specific customer from the database including their saved
 * addresses and complete order history. The customer must belong to the current store.
 *
 * @param req - Express request object with storeId and customerId params
 * @param res - Express response object
 * @returns Promise that resolves when the response is sent, or returns 404 if not found
 *
 * @throws Returns 404 JSON response if customer is not found
 *
 * @example
 * // GET /api/v1/customers/456
 * // Response: { customer: { id: 456, email: "john@example.com", addresses: [...], orders: [...], ... } }
 */
export async function getCustomer(req: Request, res: Response): Promise<void | Response> {
  const { storeId } = req;
  const { customerId } = req.params;

  const result = await queryWithTenant(
    storeId!,
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
