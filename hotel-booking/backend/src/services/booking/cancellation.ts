/**
 * Booking Cancellation Service
 *
 * Handles booking cancellation and expiry of stale reservations.
 */

import { query } from '../../models/db.js';
import { logger, bookingsCancelledTotal } from '../../shared/index.js';
import { invalidateAvailabilityCache } from './cache.js';
import { formatBooking } from './formatter.js';
import type { Booking, BookingRow } from './types.js';

/**
 * @description Cancels an existing booking (either reserved or confirmed).
 * Updates the booking status to 'cancelled', making the room(s) available again.
 *
 * This function:
 * 1. Updates the booking status to 'cancelled'
 * 2. Records cancellation metrics with the reason for analytics
 * 3. Invalidates the availability cache so the freed rooms appear available
 *
 * @param {string} bookingId - The unique identifier of the booking to cancel
 * @param {string} userId - The ID of the user who owns the booking (for authorization)
 * @param {string} [reason='user_requested'] - The reason for cancellation (e.g., 'user_requested',
 *        'payment_failed', 'hotel_requested'). Used for analytics and reporting.
 * @returns {Promise<Booking>} The cancelled booking object
 * @throws {Error} Throws 'Booking not found or cannot be cancelled' if:
 *         - The booking doesn't exist
 *         - The booking doesn't belong to the specified user
 *         - The booking is not in 'reserved' or 'confirmed' status
 *
 * @example
 * // Cancel a booking with default reason
 * const booking = await cancelBooking('booking-123', 'user-456');
 * console.log(`Booking ${booking.id} has been cancelled`);
 *
 * @example
 * // Cancel with a specific reason
 * const booking = await cancelBooking(
 *   'booking-123',
 *   'user-456',
 *   'payment_failed'
 * );
 */
export async function cancelBooking(
  bookingId: string,
  userId: string,
  reason: string = 'user_requested'
): Promise<Booking> {
  const result = await query<BookingRow>(
    `UPDATE bookings
     SET status = 'cancelled'
     WHERE id = $1 AND user_id = $2 AND status IN ('reserved', 'confirmed')
     RETURNING *`,
    [bookingId, userId]
  );

  if (result.rows.length === 0 || !result.rows[0]) {
    throw new Error('Booking not found or cannot be cancelled');
  }

  const booking = formatBooking(result.rows[0]);

  // Record metrics
  bookingsCancelledTotal.inc({ hotel_id: booking.hotelId, reason });

  // Invalidate availability cache
  await invalidateAvailabilityCache(
    booking.hotelId,
    booking.roomTypeId,
    booking.checkIn.toISOString().split('T')[0] ?? '',
    booking.checkOut.toISOString().split('T')[0] ?? ''
  );

  logger.info({ bookingId, reason }, 'Booking cancelled');

  return booking;
}

/**
 * @description Expires stale reservations that have passed their hold time.
 * This function should be called by a background job (e.g., every minute) to
 * clean up abandoned bookings and make rooms available again.
 *
 * Reservations are created with a `reserved_until` timestamp (typically 15 minutes
 * from creation). If the user doesn't complete payment within this window,
 * the reservation expires and the rooms become available for others.
 *
 * This function:
 * 1. Updates all bookings with status 'reserved' and expired `reserved_until` to 'expired'
 * 2. Invalidates availability cache for each expired reservation
 * 3. Logs the number of expired reservations for monitoring
 *
 * @returns {Promise<number>} The number of reservations that were expired
 *
 * @example
 * // Run in a background job
 * setInterval(async () => {
 *   const count = await expireStaleReservations();
 *   if (count > 0) {
 *     console.log(`Expired ${count} stale reservations`);
 *   }
 * }, 60000); // Every minute
 *
 * @example
 * // Call manually for testing
 * const expiredCount = await expireStaleReservations();
 * console.log(`Cleaned up ${expiredCount} abandoned reservations`);
 */
export async function expireStaleReservations(): Promise<number> {
  const result = await query<{ hotel_id: string; room_type_id: string; check_in: Date; check_out: Date }>(
    `UPDATE bookings
     SET status = 'expired'
     WHERE status = 'reserved' AND reserved_until < NOW()
     RETURNING hotel_id, room_type_id, check_in, check_out`
  );

  // Invalidate cache for expired reservations
  for (const row of result.rows) {
    await invalidateAvailabilityCache(
      row.hotel_id,
      row.room_type_id,
      row.check_in.toISOString().split('T')[0] ?? '',
      row.check_out.toISOString().split('T')[0] ?? ''
    );
  }

  if (result.rowCount && result.rowCount > 0) {
    logger.info({ count: result.rowCount }, 'Expired stale reservations');
  }

  return result.rowCount ?? 0;
}
