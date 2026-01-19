import { query, queryOne, execute } from '../utils/db.js';
import { updateDriverRating } from './driverService.js';
import { updateMerchantRating } from './merchantService.js';
import type { Rating, CreateRatingInput, Order } from '../types/index.js';

/**
 * Creates a rating for a driver or merchant from a completed order.
 * Validates the order is delivered and the rater is the customer.
 * Prevents duplicate ratings for the same order/target combination.
 * Automatically updates the target's average rating.
 *
 * @param raterId - The customer submitting the rating
 * @param input - Rating details including order ID, score, and optional comment
 * @param ratingType - Whether rating the driver or merchant
 * @returns Created rating record
 * @throws Error if order not found, not delivered, or already rated
 */
export async function createRating(
  raterId: string,
  input: CreateRatingInput,
  ratingType: 'driver' | 'merchant'
): Promise<Rating> {
  // Get the order to verify and get the ratee
  const order = await queryOne<Order>(`SELECT * FROM orders WHERE id = $1`, [input.order_id]);

  if (!order) {
    throw new Error('Order not found');
  }

  // Verify the rater is the customer of the order
  if (order.customer_id !== raterId) {
    throw new Error('You can only rate orders you placed');
  }

  // Verify order is delivered
  if (order.status !== 'delivered') {
    throw new Error('You can only rate delivered orders');
  }

  let ratedUserId: string | null = null;
  let ratedMerchantId: string | null = null;

  if (ratingType === 'driver') {
    if (!order.driver_id) {
      throw new Error('No driver assigned to this order');
    }
    ratedUserId = order.driver_id;

    // Check if already rated
    const existing = await queryOne(
      `SELECT id FROM ratings WHERE order_id = $1 AND rated_user_id = $2`,
      [input.order_id, ratedUserId]
    );
    if (existing) {
      throw new Error('You have already rated the driver for this order');
    }
  } else {
    if (!order.merchant_id) {
      throw new Error('No merchant for this order');
    }
    ratedMerchantId = order.merchant_id;

    // Check if already rated
    const existing = await queryOne(
      `SELECT id FROM ratings WHERE order_id = $1 AND rated_merchant_id = $2`,
      [input.order_id, ratedMerchantId]
    );
    if (existing) {
      throw new Error('You have already rated the merchant for this order');
    }
  }

  const rating = await queryOne<Rating>(
    `INSERT INTO ratings (order_id, rater_id, rated_user_id, rated_merchant_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.order_id,
      raterId,
      ratedUserId,
      ratedMerchantId,
      input.rating,
      input.comment || null,
    ]
  );

  if (!rating) {
    throw new Error('Failed to create rating');
  }

  // Update average rating
  if (ratedUserId) {
    await updateDriverRating(ratedUserId);
  }
  if (ratedMerchantId) {
    await updateMerchantRating(ratedMerchantId);
  }

  return rating;
}

/**
 * Retrieves all ratings associated with an order.
 * Typically includes one for driver and one for merchant.
 *
 * @param orderId - The order's UUID
 * @returns Array of rating records
 */
export async function getOrderRatings(orderId: string): Promise<Rating[]> {
  return query<Rating>(`SELECT * FROM ratings WHERE order_id = $1`, [orderId]);
}

/**
 * Retrieves recent ratings for a driver's profile display.
 *
 * @param driverId - The driver's UUID
 * @param limit - Maximum ratings to return (default 10)
 * @returns Array of ratings, newest first
 */
export async function getDriverRatings(
  driverId: string,
  limit: number = 10
): Promise<Rating[]> {
  return query<Rating>(
    `SELECT * FROM ratings
     WHERE rated_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [driverId, limit]
  );
}

/**
 * Retrieves recent ratings for a merchant's profile display.
 *
 * @param merchantId - The merchant's UUID
 * @param limit - Maximum ratings to return (default 10)
 * @returns Array of ratings, newest first
 */
export async function getMerchantRatings(
  merchantId: string,
  limit: number = 10
): Promise<Rating[]> {
  return query<Rating>(
    `SELECT * FROM ratings
     WHERE rated_merchant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [merchantId, limit]
  );
}
