import { query, queryOne, execute } from '../utils/db.js';
import { addDriverOrder, removeDriverOrder, publisher } from '../utils/redis.js';
import { haversineDistance, calculateDeliveryFee, calculateETA } from '../utils/geo.js';
import { getMerchantById, getMenuItemsByIds } from './merchantService.js';
import { findBestDriver, incrementDriverDeliveries, updateDriverStatus } from './driverService.js';
import type {
  Order,
  OrderWithDetails,
  OrderItem,
  CreateOrderInput,
  OrderStatus,
  DriverOffer,
  Location,
} from '../types/index.js';

const OFFER_EXPIRY_SECONDS = 30;
const MAX_OFFER_ATTEMPTS = 5;

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

export async function getOrderById(id: string): Promise<Order | null> {
  return queryOne<Order>(`SELECT * FROM orders WHERE id = $1`, [id]);
}

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

export async function getCustomerOrders(customerId: string): Promise<Order[]> {
  return query<Order>(
    `SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
    [customerId]
  );
}

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

// Driver offer management
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

export async function expireOldOffers(): Promise<number> {
  return execute(
    `UPDATE driver_offers
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()`
  );
}

// Start driver matching process for an order
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

// Get order statistics for admin dashboard
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

export async function getRecentOrders(limit: number = 20): Promise<Order[]> {
  return query<Order>(
    `SELECT * FROM orders ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
}
