/**
 * Order tracking module.
 * Handles retrieving orders and order statistics.
 *
 * @module services/order/tracking
 * @description Provides query functions for retrieving order data, including
 * single orders, order lists by customer/driver, and aggregate statistics.
 */
import { query, queryOne } from '../../utils/db.js';
import { getMerchantById } from '../merchantService.js';
import type { Order, OrderWithDetails, OrderItem } from './types.js';

/**
 * Retrieves a basic order by its unique identifier.
 *
 * @description Fetches the raw order record from the database without any
 * related data (items, merchant, driver, customer).
 * @param {string} id - The order's UUID
 * @returns {Promise<Order | null>} Order record or null if not found
 * @example
 * const order = await getOrderById('123e4567-e89b-12d3-a456-426614174000');
 * if (order) {
 *   console.log(`Order status: ${order.status}`);
 * }
 */
export async function getOrderById(id: string): Promise<Order | null> {
  return queryOne<Order>(`SELECT * FROM orders WHERE id = $1`, [id]);
}

/**
 * Retrieves an order with all related data for display.
 *
 * @description Fetches the order along with its items, merchant details,
 * driver information, and customer data. Used for order detail pages and
 * real-time tracking displays.
 * @param {string} id - The order's UUID
 * @returns {Promise<OrderWithDetails | null>} Order with full details or null if not found
 * @example
 * const orderDetails = await getOrderWithDetails(orderId);
 * if (orderDetails) {
 *   console.log(`Merchant: ${orderDetails.merchant?.name}`);
 *   console.log(`Items: ${orderDetails.items.length}`);
 *   console.log(`Driver: ${orderDetails.driver?.name}`);
 * }
 */
export async function getOrderWithDetails(id: string): Promise<OrderWithDetails | null> {
  const order = await getOrderById(id);
  if (!order) return null;

  const items = await query<OrderItem>(
    `SELECT * FROM order_items WHERE order_id = $1`,
    [id]
  );

  const merchant = order.merchant_id
    ? await getMerchantById(order.merchant_id)
    : undefined;

  const driver = order.driver_id
    ? await queryOne<{ id: string; name: string; vehicle_type: string; rating: number }>(
        `SELECT d.id, u.name, d.vehicle_type, d.rating
         FROM drivers d
         JOIN users u ON d.id = u.id
         WHERE d.id = $1`,
        [order.driver_id]
      )
    : undefined;

  const customer = order.customer_id
    ? await queryOne<{ name: string; phone: string | null }>(
        `SELECT name, phone FROM users WHERE id = $1`,
        [order.customer_id]
      )
    : undefined;

  return {
    ...order,
    items,
    merchant: merchant || undefined,
    driver: driver ? { ...driver, status: 'busy' as const } as never : undefined,
    customer: customer || undefined,
  };
}

/**
 * Retrieves all orders placed by a customer.
 *
 * @description Returns the complete order history for a customer, sorted by
 * creation date with newest orders first. Used for the order history page.
 * @param {string} customerId - The customer's UUID
 * @returns {Promise<Order[]>} Array of customer's orders, newest first
 * @example
 * const orders = await getCustomerOrders(customerId);
 * orders.forEach(order => {
 *   console.log(`Order ${order.id}: ${order.status} - $${order.total}`);
 * });
 */
export async function getCustomerOrders(customerId: string): Promise<Order[]> {
  return query<Order>(
    `SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
    [customerId]
  );
}

/**
 * Retrieves all active orders assigned to a driver.
 *
 * @description Returns orders currently in progress for a driver, including
 * orders awaiting pickup, being picked up, or in transit. Excludes delivered
 * and cancelled orders. Each order includes full details (items, merchant, customer).
 * @param {string} driverId - The driver's UUID
 * @returns {Promise<OrderWithDetails[]>} Array of active orders with full details
 * @example
 * const activeOrders = await getDriverOrders(driverId);
 * console.log(`Driver has ${activeOrders.length} active orders`);
 * activeOrders.forEach(order => {
 *   console.log(`Deliver to: ${order.delivery_address}`);
 * });
 */
export async function getDriverOrders(driverId: string): Promise<OrderWithDetails[]> {
  const orders = await query<Order>(
    `SELECT * FROM orders
     WHERE driver_id = $1
     AND status IN ('driver_assigned', 'picked_up', 'in_transit')
     ORDER BY created_at`,
    [driverId]
  );

  const ordersWithDetails = await Promise.all(
    orders.map((o) => getOrderWithDetails(o.id))
  );

  return ordersWithDetails.filter((o): o is OrderWithDetails => o !== null);
}

/**
 * Retrieves aggregate order statistics for the admin dashboard.
 *
 * @description Calculates order counts grouped by status category: pending,
 * in-progress (confirmed through in_transit), completed (delivered), and
 * cancelled. Also includes total count and orders created today.
 * @returns {Promise<{total: number, pending: number, in_progress: number, completed: number, cancelled: number, today: number}>} Object with order counts by status category
 * @example
 * const stats = await getOrderStats();
 * console.log(`Total orders: ${stats.total}`);
 * console.log(`Pending: ${stats.pending}, In Progress: ${stats.in_progress}`);
 * console.log(`Completed: ${stats.completed}, Cancelled: ${stats.cancelled}`);
 * console.log(`Orders today: ${stats.today}`);
 */
export async function getOrderStats(): Promise<{
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  today: number;
}> {
  const result = await queryOne<{
    total: string;
    pending: string;
    in_progress: string;
    completed: string;
    cancelled: string;
    today: string;
  }>(`
    SELECT
      COUNT(*)::text as total,
      COUNT(*) FILTER (WHERE status = 'pending')::text as pending,
      COUNT(*) FILTER (WHERE status IN ('confirmed', 'preparing', 'ready_for_pickup', 'driver_assigned', 'picked_up', 'in_transit'))::text as in_progress,
      COUNT(*) FILTER (WHERE status = 'delivered')::text as completed,
      COUNT(*) FILTER (WHERE status = 'cancelled')::text as cancelled,
      COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::text as today
    FROM orders
  `);

  return {
    total: parseInt(result?.total || '0'),
    pending: parseInt(result?.pending || '0'),
    in_progress: parseInt(result?.in_progress || '0'),
    completed: parseInt(result?.completed || '0'),
    cancelled: parseInt(result?.cancelled || '0'),
    today: parseInt(result?.today || '0'),
  };
}

/**
 * Retrieves the most recent orders for admin monitoring.
 *
 * @description Fetches orders sorted by creation date (newest first) with
 * a configurable limit. Used for real-time order monitoring in the admin dashboard.
 * @param {number} [limit=20] - Maximum number of orders to return
 * @returns {Promise<Order[]>} Array of recent orders, newest first
 * @example
 * // Get last 10 orders
 * const recentOrders = await getRecentOrders(10);
 * recentOrders.forEach(order => {
 *   console.log(`${order.id}: ${order.status} at ${order.created_at}`);
 * });
 */
export async function getRecentOrders(limit: number = 20): Promise<Order[]> {
  return query<Order>(
    `SELECT * FROM orders ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
}
