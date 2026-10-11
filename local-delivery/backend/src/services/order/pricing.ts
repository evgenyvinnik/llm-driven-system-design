/**
 * Order validation and pricing.
 *
 * @module services/order/pricing
 * @description The server is the only place money is computed. The request
 * carries menu item ids and quantities; prices come from the database, and the
 * delivery fee from the merchant-to-customer distance. Arithmetic is done in
 * integer cents so repeated additions never drift (0.1 + 0.2 problems).
 *
 * Before this module existed, a quantity of -3 produced a negative total, and
 * items from a different merchant's menu were accepted into the order.
 */
import { z } from 'zod';
import { haversineDistance, calculateDeliveryFee } from '../../utils/geo.js';
import { HttpError } from '../../shared/errors.js';
import type { Merchant, MenuItem } from '../../types/index.js';

/** Largest tip accepted, in dollars. */
export const MAX_TIP = 500;

/** Largest quantity on one line. */
export const MAX_ITEM_QUANTITY = 50;

/** Most lines in one order. */
export const MAX_ORDER_LINES = 50;

/** Merchants deliver within this straight-line distance. */
export const MAX_DELIVERY_RADIUS_KM = 15;

const coordinates = {
  delivery_lat: z.number().finite().min(-90).max(90),
  delivery_lng: z.number().finite().min(-180).max(180),
};

const orderLines = z
  .array(
    z.object({
      menu_item_id: z.string().uuid(),
      quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
      special_instructions: z.string().trim().max(500).nullish(),
    })
  )
  .min(1)
  .max(MAX_ORDER_LINES);

const tip = z.number().finite().min(0).max(MAX_TIP).nullish();

/** Body of POST /api/v1/orders. */
export const createOrderSchema = z.object({
  merchant_id: z.string().uuid(),
  delivery_address: z.string().trim().min(1).max(500),
  delivery_instructions: z.string().trim().max(500).nullish(),
  items: orderLines,
  tip,
  ...coordinates,
});

/** Body of POST /api/v1/orders/quote: what is needed to price, nothing more. */
export const quoteOrderSchema = z.object({
  merchant_id: z.string().uuid(),
  items: orderLines,
  tip,
  ...coordinates,
});

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type QuoteOrderRequest = z.infer<typeof quoteOrderSchema>;

/** The order request is malformed or cannot be fulfilled as asked. */
export class OrderValidationError extends HttpError {
  constructor(message: string, details?: string[]) {
    super(message, 422, 'ORDER_INVALID', details);
  }
}

/**
 * Parses a request body against a schema, turning zod issues into a 422.
 */
export function parseOrderBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new OrderValidationError(
      'Invalid order request',
      result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    );
  }
  return result.data;
}

/** Converts a dollar amount (number, or the string pg returns for DECIMAL) to integer cents. */
export function toCents(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

/** Converts integer cents to a 2-decimal string suitable for a DECIMAL parameter. */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * One priced order line.
 */
export interface PricedLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  special_instructions: string | null;
}

/**
 * The server's price for an order. Every amount is integer cents.
 */
export interface OrderQuote {
  lines: PricedLine[];
  subtotal_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  distance_km: number;
}

/**
 * Prices an order against the merchant's real menu.
 * Pure: the caller loads the merchant and the referenced menu items.
 *
 * @param merchant - The merchant the order is for
 * @param menuItems - Rows for (at least) every referenced menu item id
 * @param request - The validated request
 * @throws OrderValidationError when the merchant is closed, an item is not on
 *   this merchant's menu or is unavailable, or the address is out of range
 */
export function priceOrder(
  merchant: Pick<Merchant, 'id' | 'lat' | 'lng' | 'is_open'>,
  menuItems: Pick<MenuItem, 'id' | 'merchant_id' | 'name' | 'price' | 'is_available'>[],
  request: QuoteOrderRequest & { items: CreateOrderRequest['items'] }
): OrderQuote {
  if (!merchant.is_open) {
    throw new OrderValidationError('This merchant is closed right now');
  }

  const menu = new Map(menuItems.map((item) => [item.id, item]));
  const lines: PricedLine[] = request.items.map((line) => {
    const item = menu.get(line.menu_item_id);
    if (!item || item.merchant_id !== merchant.id) {
      throw new OrderValidationError(`Menu item ${line.menu_item_id} is not on this merchant's menu`);
    }
    if (!item.is_available) {
      throw new OrderValidationError(`${item.name} is not available right now`);
    }
    return {
      menu_item_id: item.id,
      name: item.name,
      quantity: line.quantity,
      unit_price_cents: toCents(item.price),
      special_instructions: line.special_instructions ?? null,
    };
  });

  const distanceKm = haversineDistance(
    { lat: Number(merchant.lat), lng: Number(merchant.lng) },
    { lat: request.delivery_lat, lng: request.delivery_lng }
  );
  if (distanceKm > MAX_DELIVERY_RADIUS_KM) {
    throw new OrderValidationError(
      `The delivery address is ${distanceKm.toFixed(1)} km away; this merchant delivers within ${MAX_DELIVERY_RADIUS_KM} km`
    );
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.unit_price_cents * line.quantity, 0);
  const deliveryFeeCents = toCents(calculateDeliveryFee(distanceKm));
  const tipCents = toCents(request.tip ?? 0);

  return {
    lines,
    subtotal_cents: subtotalCents,
    delivery_fee_cents: deliveryFeeCents,
    tip_cents: tipCents,
    total_cents: subtotalCents + deliveryFeeCents + tipCents,
    distance_km: Math.round(distanceKm * 100) / 100,
  };
}
