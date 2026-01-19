/**
 * Delivery completion module.
 * Handles marking orders as delivered and updating driver state.
 *
 * @module services/order/delivery
 * @description Manages the final stage of order fulfillment, including marking
 * orders as delivered, updating driver statistics, and managing driver availability.
 */
import { removeDriverOrder } from '../../utils/redis.js';
import { incrementDriverDeliveries, updateDriverStatus } from '../driverService.js';
import { getOrderById, getDriverOrders } from './tracking.js';
import { updateOrderStatus } from './status.js';
import type { Order } from './types.js';

/**
 * Marks an order as delivered and updates driver state.
 *
 * @description Completes a delivery by:
 * 1. Setting order status to 'delivered' with timestamp
 * 2. Removing order from driver's active order set in Redis
 * 3. Incrementing driver's total delivery count
 * 4. Setting driver to 'available' if no other active orders remain
 * @param {string} orderId - The order's UUID
 * @returns {Promise<Order | null>} Updated order or null if order not found or has no driver
 * @example
 * const completedOrder = await completeDelivery(orderId);
 * if (completedOrder) {
 *   console.log(`Order ${completedOrder.id} delivered at ${completedOrder.delivered_at}`);
 * } else {
 *   console.log('Order not found or not assigned to driver');
 * }
 */
export async function completeDelivery(orderId: string): Promise<Order | null> {
  const order = await getOrderById(orderId);
  if (!order || !order.driver_id) return null;

  const updatedOrder = await updateOrderStatus(orderId, 'delivered');

  if (updatedOrder) {
    // Remove order from driver's active orders
    await removeDriverOrder(order.driver_id, orderId);

    // Increment driver's delivery count
    await incrementDriverDeliveries(order.driver_id);

    // Check if driver has more orders, if not set to available
    const remainingOrders = await getDriverOrders(order.driver_id);
    if (remainingOrders.length === 0) {
      await updateDriverStatus(order.driver_id, 'available');
    }
  }

  return updatedOrder;
}
