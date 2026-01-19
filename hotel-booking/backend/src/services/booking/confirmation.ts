/**
 * Booking Confirmation Service
 *
 * Handles booking confirmation after payment.
 */

import { query } from '../../models/db.js';
import { logger, bookingsConfirmedTotal } from '../../shared/index.js';
import { invalidateAvailabilityCache } from './cache.js';
import { formatBooking } from './formatter.js';
import type { Booking, BookingRow } from './types.js';

/**
 * @description Confirms a reserved booking after payment has been processed.
 * Updates the booking status from 'reserved' to 'confirmed' and optionally
 * associates a payment transaction ID.
 *
 * This function:
 * 1. Updates the booking status to 'confirmed'
 * 2. Stores the payment transaction ID for reference
 * 3. Records a confirmation metric for monitoring
 * 4. Invalidates the availability cache to reflect the confirmed booking
 *
 * @param {string} bookingId - The unique identifier of the booking to confirm
 * @param {string} userId - The ID of the user who owns the booking (for authorization)
 * @param {string | null} [paymentId=null] - Optional payment transaction ID from the payment provider
 * @returns {Promise<Booking>} The confirmed booking object
 * @throws {Error} Throws 'Booking not found or cannot be confirmed' if:
 *         - The booking doesn't exist
 *         - The booking doesn't belong to the specified user
 *         - The booking is not in 'reserved' status
 *
 * @example
 * // Confirm a booking after successful payment
 * const booking = await confirmBooking(
 *   'booking-123',
 *   'user-456',
 *   'stripe_pi_abc123'
 * );
 * console.log(`Booking ${booking.id} confirmed!`);
 *
 * @example
 * // Confirm without a payment ID (e.g., pay at hotel)
 * const booking = await confirmBooking('booking-123', 'user-456');
 */
export async function confirmBooking(
  bookingId: string,
  userId: string,
  paymentId: string | null = null
): Promise<Booking> {
  const result = await query<BookingRow>(
    `UPDATE bookings
     SET status = 'confirmed', payment_id = $3
     WHERE id = $1 AND user_id = $2 AND status = 'reserved'
     RETURNING *`,
    [bookingId, userId, paymentId]
  );

  if (result.rows.length === 0 || !result.rows[0]) {
    throw new Error('Booking not found or cannot be confirmed');
  }

  const booking = formatBooking(result.rows[0]);

  // Record metrics
  bookingsConfirmedTotal.inc({ hotel_id: booking.hotelId });

  // Invalidate availability cache
  await invalidateAvailabilityCache(
    booking.hotelId,
    booking.roomTypeId,
    booking.checkIn.toISOString().split('T')[0] ?? '',
    booking.checkOut.toISOString().split('T')[0] ?? ''
  );

  logger.info({ bookingId, paymentId }, 'Booking confirmed');

  return booking;
}
