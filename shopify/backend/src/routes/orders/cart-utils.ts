import { PoolClient } from 'pg';
import type { CartItem } from './types.js';

/**
 * Recalculates the subtotal for a list of cart items by fetching current variant prices.
 *
 * @description Iterates through cart items, fetches the current price for each variant
 * from the database, and computes the total. This ensures the subtotal reflects
 * current pricing even if prices have changed since items were added to cart.
 *
 * @param client - PostgreSQL client with active transaction
 * @param items - Array of cart items containing variant IDs and quantities
 * @returns Promise resolving to the calculated subtotal as a number
 *
 * @example
 * const subtotal = await recalculateSubtotal(client, [
 *   { variant_id: 1, quantity: 2 },
 *   { variant_id: 5, quantity: 1 }
 * ]);
 * // Returns: 79.97 (if variant 1 is $29.99 and variant 5 is $19.99)
 */
export async function recalculateSubtotal(client: PoolClient, items: CartItem[]): Promise<number> {
  let subtotal = 0;
  for (const item of items) {
    const v = await client.query('SELECT price FROM variants WHERE id = $1', [item.variant_id]);
    if (v.rows.length > 0) {
      subtotal += (v.rows[0] as { price: number }).price * item.quantity;
    }
  }
  return subtotal;
}

/**
 * Generates a unique cart session identifier.
 *
 * @description Creates a session ID combining timestamp and random string for uniqueness.
 * Format: "cart_{timestamp}_{random}" where timestamp is milliseconds since epoch
 * and random is a 7-character alphanumeric string.
 *
 * @returns A unique cart session ID string
 *
 * @example
 * const sessionId = generateCartSessionId();
 * // Returns: "cart_1705678901234_a1b2c3d"
 */
export function generateCartSessionId(): string {
  return `cart_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Extracts the cart session ID from a request object.
 *
 * @description Checks for cart session in cookies first (preferred), then falls back
 * to the x-cart-session header for API clients that cannot use cookies.
 *
 * @param req - Request object containing cookies and headers
 * @returns The cart session ID string, or undefined if not present
 *
 * @example
 * // From cookie
 * const sessionId = getCartSessionFromRequest({ cookies: { cartSession: 'cart_123_abc' }, headers: {} });
 * // Returns: "cart_123_abc"
 *
 * // From header
 * const sessionId = getCartSessionFromRequest({ cookies: {}, headers: { 'x-cart-session': 'cart_456_def' } });
 * // Returns: "cart_456_def"
 */
export function getCartSessionFromRequest(req: { cookies?: { cartSession?: string }; headers: Record<string, unknown> }): string | undefined {
  return req.cookies?.cartSession || req.headers['x-cart-session'] as string | undefined;
}
