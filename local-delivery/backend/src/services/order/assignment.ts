/**
 * Driver assignment module.
 * Handles driver offers, acceptance/rejection, and assignment.
 *
 * @module services/order/assignment
 * @description Manages the driver offer lifecycle including creating time-limited
 * offers, processing driver responses, and finalizing order assignments.
 */
import { queryOne, execute } from '../../utils/db.js';
import { addDriverOrder, publisher } from '../../utils/redis.js';
import { updateDriverStatus } from '../driverService.js';
import { updateOrderStatus } from './status.js';
import type { Order, DriverOffer } from './types.js';
import { OFFER_EXPIRY_SECONDS } from './types.js';

/**
 * Assigns a driver to an order and updates all related state.
 *
 * @description Finalizes driver assignment by:
 * 1. Updating order status to 'driver_assigned' with driver_id
 * 2. Adding order to driver's active order set in Redis
 * 3. Setting driver status to 'busy'
 * @param {string} orderId - The order's UUID
 * @param {string} driverId - The assigned driver's UUID
 * @returns {Promise<Order | null>} Updated order or null if not found
 * @example
 * const assignedOrder = await assignDriverToOrder(orderId, driverId);
 * if (assignedOrder) {
 *   console.log(`Order ${assignedOrder.id} assigned to driver ${driverId}`);
 * }
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
 * Creates a delivery offer for a specific driver.
 *
 * @description Creates a time-limited offer record in the database and publishes
 * a notification via Redis pub/sub for real-time driver notification. The offer
 * expires after OFFER_EXPIRY_SECONDS (30 seconds by default).
 * @param {string} orderId - The order needing a driver
 * @param {string} driverId - The driver receiving the offer
 * @returns {Promise<DriverOffer>} Created offer record with expiration time
 * @throws {Error} If offer creation fails in the database
 * @example
 * try {
 *   const offer = await createDriverOffer(orderId, driverId);
 *   console.log(`Offer ${offer.id} expires at ${offer.expires_at}`);
 * } catch (error) {
 *   console.error('Failed to create offer:', error.message);
 * }
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
 *
 * @description Validates the offer is still valid (pending status, not expired,
 * belongs to the driver), then marks it as accepted and assigns the driver to
 * the order. This is an atomic operation - the offer validation and acceptance
 * happen in a single query.
 * @param {string} offerId - The offer's UUID
 * @param {string} driverId - The accepting driver's UUID (for verification)
 * @returns {Promise<Order | null>} Assigned order or null if offer is invalid, expired, or belongs to another driver
 * @example
 * const order = await acceptDriverOffer(offerId, driverId);
 * if (order) {
 *   console.log(`Driver accepted order ${order.id}`);
 * } else {
 *   console.log('Offer expired or already responded');
 * }
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
 *
 * @description Marks the offer as rejected so the matching system can proceed
 * to offer the order to the next available driver. Only updates offers that
 * are still pending and belong to the specified driver.
 * @param {string} offerId - The offer's UUID
 * @param {string} driverId - The rejecting driver's UUID (for verification)
 * @returns {Promise<boolean>} True if rejection was recorded, false if offer not found or already responded
 * @example
 * const rejected = await rejectDriverOffer(offerId, driverId);
 * if (rejected) {
 *   console.log('Offer rejected, finding next driver...');
 * }
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
 *
 * @description Fetches the most recent pending (not expired) offer for a driver.
 * Used to check if the driver has an active offer to display in the driver app.
 * Returns only offers that haven't been responded to and haven't expired.
 * @param {string} driverId - The driver's UUID
 * @returns {Promise<DriverOffer | null>} Pending offer or null if none exists
 * @example
 * const pendingOffer = await getPendingOfferForDriver(driverId);
 * if (pendingOffer) {
 *   const timeLeft = new Date(pendingOffer.expires_at).getTime() - Date.now();
 *   console.log(`Offer expires in ${timeLeft / 1000} seconds`);
 * }
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
 *
 * @description Batch updates all offers that are still pending but have passed
 * their expiration time. Should be called periodically (e.g., via cron job or
 * background worker) to clean up stale offers and trigger next-driver matching.
 * @returns {Promise<number>} Number of offers marked as expired
 * @example
 * // Run periodically to clean up expired offers
 * const expiredCount = await expireOldOffers();
 * if (expiredCount > 0) {
 *   console.log(`Expired ${expiredCount} stale offers`);
 * }
 */
export async function expireOldOffers(): Promise<number> {
  return execute(
    `UPDATE driver_offers
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()`
  );
}
