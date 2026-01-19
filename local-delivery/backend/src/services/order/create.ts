/**
 * Order creation module.
 * Handles creating new orders from customer cart data.
 *
 * @module services/order/create
 */
import { query, queryOne } from '../../utils/db.js';
import { haversineDistance, calculateDeliveryFee, calculateETA } from '../../utils/geo.js';
import { getMerchantById, getMenuItemsByIds } from '../merchantService.js';
import type {
  Order,
  OrderWithDetails,
  OrderItem,
  CreateOrderInput,
} from './types.js';

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
