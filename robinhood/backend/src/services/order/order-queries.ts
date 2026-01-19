import { pool } from '../../database.js';
import type { Order, Execution } from './types.js';

/**
 * Retrieves all orders for a user, optionally filtered by status.
 *
 * @description Queries the database for all orders belonging to the specified user.
 * Results are sorted by creation date in descending order (newest first).
 * An optional status filter can be applied to retrieve only orders with a
 * specific status (e.g., 'pending', 'filled', 'cancelled').
 *
 * @param userId - Unique identifier of the order owner
 * @param status - Optional order status filter. Valid values:
 *   - 'pending': Orders not yet submitted to market
 *   - 'submitted': Orders submitted but not filled
 *   - 'partial': Partially filled orders
 *   - 'filled': Completely filled orders
 *   - 'cancelled': Cancelled orders
 *   - 'rejected': Orders rejected due to validation failure
 * @returns Promise resolving to an array of orders, sorted by creation date (newest first)
 *
 * @example
 * ```typescript
 * // Get all orders for a user
 * const allOrders = await getOrders('user-123');
 *
 * // Get only pending orders
 * const pendingOrders = await getOrders('user-123', 'pending');
 * ```
 */
export async function getOrders(userId: string, status?: string): Promise<Order[]> {
  let query = 'SELECT * FROM orders WHERE user_id = $1';
  const params: (string | undefined)[] = [userId];

  if (status) {
    query += ' AND status = $2';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const result = await pool.query<Order>(query, params);
  return result.rows;
}

/**
 * Retrieves a specific order for a user.
 *
 * @description Fetches a single order by its ID, ensuring it belongs to the
 * specified user. This ownership check prevents users from viewing orders
 * that belong to other users.
 *
 * @param userId - Unique identifier of the order owner
 * @param orderId - Unique identifier of the order to retrieve
 * @returns Promise resolving to the order if found and owned by the user,
 *   or null if the order does not exist or belongs to a different user
 *
 * @example
 * ```typescript
 * const order = await getOrder('user-123', 'order-456');
 * if (order) {
 *   console.log(`Order status: ${order.status}`);
 * } else {
 *   console.log('Order not found');
 * }
 * ```
 */
export async function getOrder(userId: string, orderId: string): Promise<Order | null> {
  const result = await pool.query<Order>(
    'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
    [orderId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Retrieves all executions for an order.
 *
 * @description Fetches all execution records (fills) associated with a specific
 * order. Each execution represents a partial or complete fill of the order.
 * Results are sorted by execution time in descending order (most recent first).
 *
 * An order may have multiple executions if it was partially filled in multiple
 * transactions. For market orders, there is typically one execution for the
 * full quantity. For limit orders in volatile markets, there may be multiple
 * partial fills.
 *
 * @param orderId - Unique identifier of the order to get executions for
 * @returns Promise resolving to an array of executions, sorted by execution time
 *   (most recent first). Returns an empty array if no executions exist.
 *
 * @example
 * ```typescript
 * const executions = await getExecutions('order-456');
 * for (const exec of executions) {
 *   console.log(`Filled ${exec.quantity} shares at $${exec.price}`);
 * }
 * ```
 */
export async function getExecutions(orderId: string): Promise<Execution[]> {
  const result = await pool.query<Execution>(
    'SELECT * FROM executions WHERE order_id = $1 ORDER BY executed_at DESC',
    [orderId]
  );
  return result.rows;
}
