/**
 * Order status update module.
 * Handles status transitions and timestamp updates.
 *
 * @module services/order/status
 * @description Manages order status lifecycle transitions, automatically setting
 * relevant timestamps and publishing real-time updates via Redis pub/sub.
 */
import { queryOne } from '../../utils/db.js';
import { publisher } from '../../utils/redis.js';
import type { Order, OrderStatus } from './types.js';

/**
 * Updates an order's status and records relevant timestamps.
 *
 * @description Transitions an order to a new status, automatically setting
 * the appropriate timestamp field (confirmed_at, picked_up_at, delivered_at,
 * or cancelled_at). Publishes status change via Redis for real-time client updates.
 * @param {string} id - The order's UUID
 * @param {OrderStatus} status - New status value (pending, confirmed, preparing, ready_for_pickup, driver_assigned, picked_up, in_transit, delivered, cancelled)
 * @param {Record<string, unknown>} [additionalFields] - Optional extra fields to update (e.g., cancellation_reason, driver_id)
 * @returns {Promise<Order | null>} Updated order or null if not found
 * @throws {Error} Database errors are propagated
 * @example
 * // Simple status update
 * const order = await updateOrderStatus(orderId, 'confirmed');
 *
 * // Status update with additional fields
 * const cancelled = await updateOrderStatus(orderId, 'cancelled', {
 *   cancellation_reason: 'Customer requested cancellation'
 * });
 *
 * // Assign driver during status update
 * const assigned = await updateOrderStatus(orderId, 'driver_assigned', {
 *   driver_id: driverId
 * });
 */
export async function updateOrderStatus(
  id: string,
  status: OrderStatus,
  additionalFields?: Record<string, unknown>
): Promise<Order | null> {
  const fields = ['status = $1'];
  const values: unknown[] = [status];
  let paramIndex = 2;

  // Add timestamp fields based on status
  switch (status) {
    case 'confirmed':
      fields.push(`confirmed_at = NOW()`);
      break;
    case 'picked_up':
      fields.push(`picked_up_at = NOW()`);
      break;
    case 'delivered':
      fields.push(`delivered_at = NOW()`, `actual_delivery_time = NOW()`);
      break;
    case 'cancelled':
      fields.push(`cancelled_at = NOW()`);
      if (additionalFields?.cancellation_reason) {
        fields.push(`cancellation_reason = $${paramIndex++}`);
        values.push(additionalFields.cancellation_reason);
      }
      break;
  }

  // Add any additional fields
  if (additionalFields) {
    for (const [key, value] of Object.entries(additionalFields)) {
      if (key !== 'cancellation_reason') {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(value);
      }
    }
  }

  values.push(id);

  const order = await queryOne<Order>(
    `UPDATE orders SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (order) {
    // Publish status update
    await publisher.publish(
      `order:${id}:status`,
      JSON.stringify({ status, timestamp: new Date().toISOString() })
    );
  }

  return order;
}
