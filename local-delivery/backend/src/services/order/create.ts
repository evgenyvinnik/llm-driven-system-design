/**
 * Order creation module.
 * Handles creating new orders from customer cart data.
 *
 * @module services/order/create
 * @description Creates an order and its line items in the caller's transaction
 * (the idempotency record commits in the same transaction, see
 * shared/idempotency.ts), prices it server-side, and claims the dispatch lease
 * for the creating instance so it can start matching right after COMMIT.
 */
import { pool } from '../../utils/db.js';
import type { Queryable } from '../../utils/db.js';
import { calculateETA, ROAD_DETOUR_FACTOR } from '../../utils/geo.js';
import { HttpError } from '../../shared/errors.js';
import { priceOrder, fromCents, OrderValidationError, MAX_TIP } from './pricing.js';
import type { CreateOrderRequest, QuoteOrderRequest, OrderQuote } from './pricing.js';
import { DISPATCH_LEASE_SECONDS } from './dispatch.js';
import { OrderNotFoundError, OrderAccessError, publishOrderStatus } from './stateMachine.js';
import type { Order, OrderWithDetails, OrderItem, Merchant } from './types.js';
import type { MenuItem } from '../../types/index.js';

/**
 * Loads the merchant and the referenced menu items, then prices the order.
 */
async function loadAndPrice(
  db: Queryable,
  request: QuoteOrderRequest
): Promise<{ merchant: Merchant; quote: OrderQuote }> {
  const merchant = (
    await db.query<Merchant>(`SELECT * FROM merchants WHERE id = $1`, [request.merchant_id])
  ).rows[0];
  if (!merchant) {
    throw new OrderValidationError('Merchant not found');
  }

  const ids = [...new Set(request.items.map((item) => item.menu_item_id))];
  const menuItems = (
    await db.query<MenuItem>(`SELECT * FROM menu_items WHERE id = ANY($1::uuid[])`, [ids])
  ).rows;

  return { merchant, quote: priceOrder(merchant, menuItems, request) };
}

/**
 * Prices a cart without creating anything. The cart page shows these numbers,
 * so the total on the button is the total that will be charged.
 *
 * @param request - Validated quote request
 */
export async function quoteOrder(request: QuoteOrderRequest): Promise<{
  subtotal: string;
  delivery_fee: string;
  tip: string;
  total: string;
  distance_km: number;
}> {
  const { quote } = await loadAndPrice(pool, request);
  return {
    subtotal: fromCents(quote.subtotal_cents),
    delivery_fee: fromCents(quote.delivery_fee_cents),
    tip: fromCents(quote.tip_cents),
    total: fromCents(quote.total_cents),
    distance_km: quote.distance_km,
  };
}

/**
 * Creates an order and its line items on the given transaction client.
 *
 * @param client - Transaction client (the caller commits)
 * @param customerId - The ordering customer's UUID
 * @param request - Validated order request
 * @param dispatchOwner - Instance that will run the matching loop; its lease starts now
 * @returns Complete order with items and merchant info
 * @throws OrderValidationError when the order cannot be priced or fulfilled
 */
export async function createOrder(
  client: Queryable,
  customerId: string,
  request: CreateOrderRequest,
  dispatchOwner: string
): Promise<OrderWithDetails> {
  const { merchant, quote } = await loadAndPrice(client, request);

  // Food ready after the merchant's prep time, then the trip to the customer.
  const prepTimeMinutes = merchant.avg_prep_time_minutes;
  const travelSeconds = calculateETA(quote.distance_km * ROAD_DETOUR_FACTOR);
  const estimatedDeliveryTime = new Date(Date.now() + prepTimeMinutes * 60_000 + travelSeconds * 1000);

  const order = (
    await client.query<Order>(
      `INSERT INTO orders (
        customer_id, merchant_id, status, delivery_address, delivery_lat, delivery_lng,
        delivery_instructions, subtotal, delivery_fee, tip, total,
        estimated_prep_time_minutes, estimated_delivery_time,
        dispatch_owner, dispatch_lease_until
      )
      VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
              NOW() + make_interval(secs => $14))
      RETURNING *`,
      [
        customerId,
        merchant.id,
        request.delivery_address,
        request.delivery_lat,
        request.delivery_lng,
        request.delivery_instructions ?? null,
        fromCents(quote.subtotal_cents),
        fromCents(quote.delivery_fee_cents),
        fromCents(quote.tip_cents),
        fromCents(quote.total_cents),
        prepTimeMinutes,
        estimatedDeliveryTime,
        dispatchOwner,
        DISPATCH_LEASE_SECONDS,
      ]
    )
  ).rows[0];

  if (!order) {
    throw new Error('Failed to create order');
  }

  // One statement for all lines; name and unit price are copied so the order
  // keeps what the customer was charged even if the menu changes later.
  const items = (
    await client.query<OrderItem>(
      `INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, special_instructions)
       SELECT $1, line.menu_item_id, line.name, line.quantity, line.unit_price, line.special_instructions
       FROM unnest($2::uuid[], $3::text[], $4::int[], $5::numeric[], $6::text[])
         AS line(menu_item_id, name, quantity, unit_price, special_instructions)
       RETURNING *`,
      [
        order.id,
        quote.lines.map((line) => line.menu_item_id),
        quote.lines.map((line) => line.name),
        quote.lines.map((line) => line.quantity),
        quote.lines.map((line) => fromCents(line.unit_price_cents)),
        quote.lines.map((line) => line.special_instructions),
      ]
    )
  ).rows;

  return { ...order, items, merchant };
}

/**
 * Changes the tip on a customer's own order, recomputing the total in SQL.
 * Ownership and status are part of the UPDATE, so there is no read-then-write
 * window. (The previous route passed the order's status as its id and
 * concatenated DECIMAL strings, so it always failed with a 500.)
 *
 * @param orderId - Order UUID
 * @param customerId - Must own the order
 * @param tip - New tip in dollars
 */
export async function updateOrderTip(orderId: string, customerId: string, tip: number): Promise<Order> {
  if (!Number.isFinite(tip) || tip < 0 || tip > MAX_TIP) {
    throw new OrderValidationError(`Tip must be between 0 and ${MAX_TIP}`);
  }
  const tipAmount = fromCents(Math.round(tip * 100));

  const updated = (
    await pool.query<Order>(
      `UPDATE orders
       SET tip = $3::numeric, total = subtotal + delivery_fee + $3::numeric, version = version + 1
       WHERE id = $1 AND customer_id = $2 AND status <> 'cancelled'
       RETURNING *`,
      [orderId, customerId, tipAmount]
    )
  ).rows[0];

  if (updated) {
    await publishOrderStatus(updated);
    return updated;
  }

  const row = (
    await pool.query<Pick<Order, 'customer_id' | 'status'>>(
      `SELECT customer_id, status FROM orders WHERE id = $1`,
      [orderId]
    )
  ).rows[0];
  if (!row) throw new OrderNotFoundError(orderId);
  if (row.customer_id !== customerId) throw new OrderAccessError(orderId);
  throw new HttpError('A cancelled order cannot be tipped', 409, 'ORDER_CANCELLED');
}
