/**
 * Delivery completion module.
 * Handles marking orders as delivered and updating driver state.
 *
 * @module services/order/delivery
 * @description Completing a delivery changes three things that must agree: the
 * order becomes delivered, the courier's delivery count goes up, and the
 * courier becomes available again if this was their last active order. They
 * commit together. The courier's availability is decided from the orders table
 * itself rather than from the Redis load set, which can drift.
 */
import { withTransaction } from '../../utils/db.js';
import { removeDriverOrder } from '../../utils/redis.js';
import { driverLogger } from '../../shared/logger.js';
import { ordersCompletedCounter, deliveriesCompletedCounter } from '../../shared/metrics.js';
import { transitionOrder, publishOrderStatus, ACTIVE_DELIVERY_STATUSES } from './stateMachine.js';
import type { Order } from './types.js';

/**
 * Marks an order as delivered by its assigned courier.
 *
 * @param orderId - The order's UUID
 * @param driverId - The courier completing it (must be the assigned courier)
 * @returns The delivered order
 * @throws OrderNotFoundError | OrderAccessError | OrderTransitionError
 */
export async function completeDelivery(orderId: string, driverId: string): Promise<Order> {
  const { order, vehicleType } = await withTransaction(async (client) => {
    const delivered = await transitionOrder(orderId, 'delivered', { driverId, client });

    const driver = await client.query<{ vehicle_type: string }>(
      `UPDATE drivers SET total_deliveries = total_deliveries + 1 WHERE id = $1 RETURNING vehicle_type`,
      [driverId]
    );

    // Available again only if this was the courier's last active order.
    await client.query(
      `UPDATE drivers SET status = 'available'
       WHERE id = $1 AND status = 'busy'
         AND NOT EXISTS (
           SELECT 1 FROM orders WHERE driver_id = $1 AND status = ANY($2::text[])
         )`,
      [driverId, ACTIVE_DELIVERY_STATUSES]
    );

    return { order: delivered, vehicleType: driver.rows[0]?.vehicle_type ?? 'unknown' };
  });

  await removeDriverOrder(driverId, orderId).catch((error: Error) => {
    driverLogger.warn({ driverId, orderId, error: error.message }, 'Failed to update cached driver load');
  });
  ordersCompletedCounter.inc({ status: 'delivered' });
  deliveriesCompletedCounter.inc({ vehicle_type: vehicleType });
  await publishOrderStatus(order);

  return order;
}
