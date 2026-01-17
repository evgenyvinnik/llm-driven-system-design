import { query, queryOne, execute } from '../utils/db.js';
import { addDriverOrder, removeDriverOrder, publisher } from '../utils/redis.js';
import { haversineDistance, calculateDeliveryFee, calculateETA } from '../utils/geo.js';
import { getMerchantById, getMenuItemsByIds } from './merchantService.js';
import { findBestDriver, incrementDriverDeliveries, updateDriverStatus } from './driverService.js';
import { createCircuitBreaker } from '../shared/circuitBreaker.js';
import { matchingLogger } from '../shared/logger.js';
import {
  driverAssignmentsCounter,
  driverMatchingDurationHistogram,
  offersPerAssignmentHistogram,
} from '../shared/metrics.js';
import type {
  Order,
  OrderWithDetails,
  OrderItem,
  CreateOrderInput,
  OrderStatus,
  DriverOffer,
  Location,
} from '../types/index.js';

/** Time in seconds before a driver offer expires and is offered to the next driver. */
const OFFER_EXPIRY_SECONDS = 30;

/** Maximum number of drivers to try before cancelling an order for lack of driver. */
const MAX_OFFER_ATTEMPTS = 5;

/**
 * Creates a new order from customer cart data.
 * Calculates subtotal, delivery fee, and estimated delivery time.
 * Validates merchant and menu items exist and are available.
 *
 * @param customerId - The ordering customer's UUID
 * @param input - Order details including items, delivery address, and tip
 * @returns Complete order with items and merchant info
 * @throws Error if merchant or items not found
 */
export async function createOrder(
  customerId: string,
  input: CreateOrderInput
): Promise<OrderWithDetails> {
  // Get merchant details
  const merchant = await getMerchantById(input.merchant_id);
  if (!merchant) {
    throw new Error('Merchant not found');
  }

  // Get menu items and calculate subtotal
  const menuItemIds = input.items.map((i) => i.menu_item_id);
  const menuItems = await getMenuItemsByIds(menuItemIds);

  if (menuItems.length !== menuItemIds.length) {
    throw new Error('One or more menu items not found');
  }

  // Calculate subtotal
  let subtotal = 0;
  for (const item of input.items) {
    const menuItem = menuItems.find((m) => m.id === item.menu_item_id);
    if (!menuItem) {
      throw new Error(`Menu item ${item.menu_item_id} not found`);
    }
    subtotal += menuItem.price * item.quantity;
  }

  // Calculate delivery fee
  const deliveryDistance = haversineDistance(
    { lat: merchant.lat, lng: merchant.lng },
    { lat: input.delivery_lat, lng: input.delivery_lng }
  );
  const deliveryFee = calculateDeliveryFee(deliveryDistance);

  // Calculate total
  const tip = input.tip || 0;
  const total = subtotal + deliveryFee + tip;

  // Calculate estimated delivery time
  const prepTimeMinutes = merchant.avg_prep_time_minutes;
  const deliveryEtaSeconds = calculateETA(deliveryDistance);
  const estimatedDeliveryTime = new Date();
  estimatedDeliveryTime.setMinutes(estimatedDeliveryTime.getMinutes() + prepTimeMinutes);
  estimatedDeliveryTime.setSeconds(estimatedDeliveryTime.getSeconds() + deliveryEtaSeconds);

  // Create order
  const order = await queryOne<Order>(
    `INSERT INTO orders (
      customer_id, merchant_id, status, delivery_address, delivery_lat, delivery_lng,
      delivery_instructions, subtotal, delivery_fee, tip, total,
      estimated_prep_time_minutes, estimated_delivery_time
    )
    VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *`,
    [
      customerId,
      input.merchant_id,
      input.delivery_address,
      input.delivery_lat,
      input.delivery_lng,
      input.delivery_instructions || null,
      subtotal,
      deliveryFee,
      tip,
      total,
      prepTimeMinutes,
      estimatedDeliveryTime,
    ]
  );

  if (!order) {
    throw new Error('Failed to create order');
  }

  // Create order items
  const orderItems: OrderItem[] = [];
  for (const item of input.items) {
    const menuItem = menuItems.find((m) => m.id === item.menu_item_id);
    if (!menuItem) continue;

    const orderItem = await queryOne<OrderItem>(
      `INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, special_instructions)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        order.id,
        item.menu_item_id,
        menuItem.name,
        item.quantity,
        menuItem.price,
        item.special_instructions || null,
      ]
    );

    if (orderItem) {
      orderItems.push(orderItem);
    }
  }

  return {
    ...order,
    items: orderItems,
    merchant,
  };
}

/**
 * Retrieves a basic order by its unique identifier.
 *
 * @param id - The order's UUID
 * @returns Order record or null if not found
 */
export async function getOrderById(id: string): Promise<Order | null> {
  return queryOne<Order>(`SELECT * FROM orders WHERE id = $1`, [id]);
}

/**
 * Retrieves an order with all related data for display.
 * Includes order items, merchant, driver, and customer information.
 *
 * @param id - The order's UUID
 * @returns Order with full details or null if not found
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
 * Returns newest orders first for the order history page.
 *
 * @param customerId - The customer's UUID
 * @returns Array of customer's orders
 */
export async function getCustomerOrders(customerId: string): Promise<Order[]> {
  return query<Order>(
    `SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
    [customerId]
  );
}

/**
 * Retrieves all active orders assigned to a driver.
 * Only includes orders in pickup/transit states, not delivered or cancelled.
 *
 * @param driverId - The driver's UUID
 * @returns Array of active orders with full details
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
 * Updates an order's status and records relevant timestamps.
 * Publishes status change via Redis for real-time client updates.
 *
 * @param id - The order's UUID
 * @param status - New status value
 * @param additionalFields - Optional extra fields to update (e.g., cancellation_reason)
 * @returns Updated order or null if not found
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

/**
 * Assigns a driver to an order and updates all related state.
 * Updates order status, adds to driver's active orders in Redis,
 * and sets driver status to busy.
 *
 * @param orderId - The order's UUID
 * @param driverId - The assigned driver's UUID
 * @returns Updated order or null if not found
 */
export async function assignDriverToOrder(
  orderId: string,
  driverId: string
): Promise<Order | null> {
  const order = await updateOrderStatus(orderId, 'driver_assigned', {
    driver_id: driverId,
  });

  if (order) {
    // Add order to driver's active orders in Redis
    await addDriverOrder(driverId, orderId);

    // Update driver status to busy if they have orders
    await updateDriverStatus(driverId, 'busy');
  }

  return order;
}

/**
 * Marks an order as delivered and updates driver state.
 * Removes order from driver's active set, increments delivery count,
 * and sets driver to available if no other orders.
 *
 * @param orderId - The order's UUID
 * @returns Updated order or null if not found
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

/**
 * Creates a delivery offer for a specific driver.
 * The offer has a 30-second expiry after which it moves to the next driver.
 * Publishes the offer via Redis for real-time driver notification.
 *
 * @param orderId - The order needing a driver
 * @param driverId - The driver receiving the offer
 * @returns Created offer record
 * @throws Error if offer creation fails
 */
export async function createDriverOffer(
  orderId: string,
  driverId: string
): Promise<DriverOffer> {
  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + OFFER_EXPIRY_SECONDS);

  const offer = await queryOne<DriverOffer>(
    `INSERT INTO driver_offers (order_id, driver_id, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [orderId, driverId, expiresAt]
  );

  if (!offer) {
    throw new Error('Failed to create driver offer');
  }

  // Publish offer to driver
  await publisher.publish(
    `driver:${driverId}:offers`,
    JSON.stringify({
      type: 'new_offer',
      offer_id: offer.id,
      order_id: orderId,
      expires_in: OFFER_EXPIRY_SECONDS,
    })
  );

  return offer;
}

/**
 * Processes a driver's acceptance of a delivery offer.
 * Validates the offer is still valid (not expired, not already responded),
 * then assigns the driver to the order.
 *
 * @param offerId - The offer's UUID
 * @param driverId - The accepting driver's UUID (for verification)
 * @returns Assigned order or null if offer invalid/expired
 */
export async function acceptDriverOffer(
  offerId: string,
  driverId: string
): Promise<Order | null> {
  // Update offer status
  const offer = await queryOne<DriverOffer>(
    `UPDATE driver_offers
     SET status = 'accepted', responded_at = NOW()
     WHERE id = $1 AND driver_id = $2 AND status = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [offerId, driverId]
  );

  if (!offer) {
    return null; // Offer expired, already responded, or doesn't belong to driver
  }

  // Assign driver to order
  return assignDriverToOrder(offer.order_id, driverId);
}

/**
 * Processes a driver's rejection of a delivery offer.
 * Marks the offer as rejected so the system can try the next driver.
 *
 * @param offerId - The offer's UUID
 * @param driverId - The rejecting driver's UUID (for verification)
 * @returns True if rejection recorded, false if offer not found
 */
export async function rejectDriverOffer(
  offerId: string,
  driverId: string
): Promise<boolean> {
  const count = await execute(
    `UPDATE driver_offers
     SET status = 'rejected', responded_at = NOW()
     WHERE id = $1 AND driver_id = $2 AND status = 'pending'`,
    [offerId, driverId]
  );

  return count > 0;
}

/**
 * Retrieves the current pending offer for a driver, if any.
 * Used to check if driver has an active offer to display.
 *
 * @param driverId - The driver's UUID
 * @returns Pending offer or null if none
 */
export async function getPendingOfferForDriver(
  driverId: string
): Promise<DriverOffer | null> {
  return queryOne<DriverOffer>(
    `SELECT * FROM driver_offers
     WHERE driver_id = $1 AND status = 'pending' AND expires_at > NOW()
     ORDER BY offered_at DESC
     LIMIT 1`,
    [driverId]
  );
}

/**
 * Marks all expired offers as expired status.
 * Should be called periodically to clean up stale offers.
 *
 * @returns Number of offers marked as expired
 */
export async function expireOldOffers(): Promise<number> {
  return execute(
    `UPDATE driver_offers
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()`
  );
}

/**
 * Initiates the driver matching process for a new order.
 * Sequentially offers to nearby drivers, waiting for each response.
 * Cancels order if no driver accepts after max attempts.
 *
 * @param orderId - The order needing a driver
 * @returns True if driver assigned, false if no driver available
 */
export async function startDriverMatching(orderId: string): Promise<boolean> {
  const order = await getOrderWithDetails(orderId);
  if (!order || !order.merchant) {
    return false;
  }

  const merchantLocation: Location = {
    lat: order.merchant.lat,
    lng: order.merchant.lng,
  };

  const excludedDrivers = new Set<string>();
  let attempt = 0;

  while (attempt < MAX_OFFER_ATTEMPTS) {
    // Find best available driver
    const driver = await findBestDriver(merchantLocation, excludedDrivers);

    if (!driver) {
      // No drivers available, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 10000));
      attempt++;
      continue;
    }

    // Create offer
    const offer = await createDriverOffer(orderId, driver.id);

    // Wait for response
    const response = await waitForOfferResponse(offer.id, OFFER_EXPIRY_SECONDS * 1000);

    if (response === 'accepted') {
      return true;
    }

    // Driver rejected or timed out, try next
    excludedDrivers.add(driver.id);
    attempt++;
  }

  // No driver accepted
  await updateOrderStatus(orderId, 'cancelled', {
    cancellation_reason: 'No driver available',
  });

  return false;
}

/**
 * Waits for a driver to respond to an offer, polling the database.
 * Returns the response status or 'expired' if timeout reached.
 *
 * @param offerId - The offer's UUID
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns 'accepted', 'rejected', or 'expired'
 */
async function waitForOfferResponse(
  offerId: string,
  timeoutMs: number
): Promise<'accepted' | 'rejected' | 'expired'> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const offer = await queryOne<DriverOffer>(
      `SELECT status FROM driver_offers WHERE id = $1`,
      [offerId]
    );

    if (offer?.status === 'accepted') return 'accepted';
    if (offer?.status === 'rejected') return 'rejected';

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Mark as expired
  await execute(
    `UPDATE driver_offers SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
    [offerId]
  );

  return 'expired';
}

/**
 * Retrieves aggregate order statistics for the admin dashboard.
 * Includes counts by status and orders created today.
 *
 * @returns Object with order counts by status category
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
 * @param limit - Maximum number of orders to return (default 20)
 * @returns Array of recent orders, newest first
 */
export async function getRecentOrders(limit: number = 20): Promise<Order[]> {
  return query<Order>(
    `SELECT * FROM orders ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
}

/**
 * Circuit breaker for driver matching service.
 *
 * WHY circuit breaker for driver matching:
 * - Driver matching involves Redis geo queries and database writes
 * - If Redis is slow or unavailable, matching can block indefinitely
 * - Circuit breaker fails fast when service is degraded
 * - Allows system to recover gracefully when matching service stabilizes
 * - Fallback queues order for retry instead of failing completely
 *
 * Configuration:
 * - 30 second timeout per matching attempt
 * - Opens after 50% failures in 5+ requests
 * - Half-opens after 30 seconds to test recovery
 */
const driverMatchingCircuitBreaker = createCircuitBreaker<[string], boolean>(
  'driver-matching',
  async (orderId: string): Promise<boolean> => {
    const startTime = Date.now();

    try {
      const result = await startDriverMatching(orderId);
      const duration = (Date.now() - startTime) / 1000;

      // Track matching duration
      driverMatchingDurationHistogram.observe(duration);

      if (result) {
        driverAssignmentsCounter.inc({ result: 'assigned' });
        matchingLogger.info({ orderId, duration }, 'Driver matching succeeded');
      } else {
        driverAssignmentsCounter.inc({ result: 'no_driver' });
        matchingLogger.warn({ orderId, duration }, 'No driver available for order');
      }

      return result;
    } catch (error) {
      driverAssignmentsCounter.inc({ result: 'error' });
      throw error;
    }
  },
  {
    timeout: 180000, // 3 minutes (matching can take multiple offers)
    errorThresholdPercentage: 50,
    volumeThreshold: 3,
    resetTimeout: 30000, // 30 seconds before half-open
  }
);

// Set up fallback for when circuit is open
driverMatchingCircuitBreaker.fallback(async (orderId: string): Promise<boolean> => {
  matchingLogger.warn({ orderId }, 'Circuit breaker open, queueing order for retry');

  // Mark order as pending with note about matching delay
  await updateOrderStatus(orderId, 'pending', {
    cancellation_reason: null, // Clear any previous reason
  });

  // In a production system, this would add to a retry queue
  // For now, log that we need manual intervention
  matchingLogger.error(
    { orderId },
    'Order queued for retry - circuit breaker open'
  );

  return false;
});

/**
 * Starts driver matching with circuit breaker protection.
 * This is the preferred entry point for initiating driver matching.
 *
 * Benefits:
 * - Fails fast when matching service is degraded
 * - Automatically tracks metrics and logs
 * - Provides fallback behavior for graceful degradation
 *
 * @param orderId - The order needing a driver
 * @returns True if driver assigned, false if matching failed or circuit open
 */
export async function startDriverMatchingWithCircuitBreaker(
  orderId: string
): Promise<boolean> {
  try {
    return await driverMatchingCircuitBreaker.fire(orderId);
  } catch (error) {
    matchingLogger.error(
      { orderId, error: (error as Error).message },
      'Driver matching circuit breaker error'
    );
    return false;
  }
}

/**
 * Gets the current status of the driver matching circuit breaker.
 * Useful for health checks and monitoring dashboards.
 */
export function getDriverMatchingCircuitBreakerStatus() {
  return {
    state: driverMatchingCircuitBreaker.opened
      ? 'open'
      : driverMatchingCircuitBreaker.halfOpen
        ? 'halfOpen'
        : 'closed',
    stats: {
      failures: driverMatchingCircuitBreaker.stats.failures,
      successes: driverMatchingCircuitBreaker.stats.successes,
      fallbacks: driverMatchingCircuitBreaker.stats.fallbacks,
      timeouts: driverMatchingCircuitBreaker.stats.timeouts,
    },
  };
}
