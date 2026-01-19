/**
 * Booking rescheduling logic.
 *
 * @description Handles moving bookings to new time slots with conflict detection,
 * optimistic locking, and proper notification handling. Ensures thread-safety
 * through database transactions and version-based concurrency control.
 *
 * @module services/booking/reschedule
 */

import { pool } from '../../db/index.js';
import { type Booking } from './types.js';
import { logger } from '../../shared/logger.js';
import { emailNotificationsTotal, recordBookingOperation } from '../../shared/metrics.js';
import { publishRescheduleNotification, sendRescheduleEmail } from './notifications.js';
import { invalidateAvailabilityCache } from './slots.js';
import { parseISO, addMinutes } from 'date-fns';

/**
 * Reschedules a booking to a new time slot.
 *
 * @description Moves a booking to a new start time, recalculating the end time
 * based on the meeting type's duration. Uses optimistic locking (version field)
 * to prevent concurrent modification race conditions.
 *
 * The function:
 * 1. Acquires a row lock on the existing booking
 * 2. Validates ownership (if userId provided) and booking status
 * 3. Calculates new time slot with buffer periods
 * 4. Checks for conflicts with other confirmed bookings
 * 5. Updates the booking with optimistic locking
 * 6. Publishes reschedule notifications
 *
 * @param {string} id - The UUID of the booking to reschedule
 * @param {string} newStartTime - New start time in ISO 8601 format (e.g., "2024-01-15T14:00:00Z")
 * @param {string} [userId] - Optional user ID for ownership verification
 * @returns {Promise<Booking>} The updated booking with new times and 'rescheduled' status
 * @throws {Error} "Booking not found" if the booking ID doesn't exist
 * @throws {Error} "Unauthorized to reschedule this booking" if userId doesn't match host
 * @throws {Error} "Cannot reschedule a cancelled booking" if booking is already cancelled
 * @throws {Error} "New time slot is not available" if there's a scheduling conflict
 * @throws {Error} "Booking was modified by another request" if version mismatch (concurrent modification)
 *
 * @example
 * const rescheduled = await rescheduleBooking(
 *   bookingId,
 *   '2024-01-20T15:00:00Z',
 *   currentUserId
 * );
 * console.log(`New meeting time: ${rescheduled.start_time}`);
 */
export async function rescheduleBooking(
  id: string,
  newStartTime: string,
  userId?: string
): Promise<Booking> {
  const rescheduleLogger = logger.child({ operation: 'reschedule', bookingId: id });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get the existing booking with locking
    const existingResult = await client.query(
      `SELECT b.*, mt.duration_minutes, mt.buffer_before_minutes, mt.buffer_after_minutes,
              mt.name as meeting_type_name, mt.id as meeting_type_id,
              u.name as host_name, u.email as host_email
       FROM bookings b
       JOIN meeting_types mt ON b.meeting_type_id = mt.id
       JOIN users u ON b.host_user_id = u.id
       WHERE b.id = $1
       FOR UPDATE`,
      [id]
    );

    if (existingResult.rows.length === 0) {
      throw new Error('Booking not found');
    }

    const existing = existingResult.rows[0];

    if (userId && existing.host_user_id !== userId) {
      throw new Error('Unauthorized to reschedule this booking');
    }

    if (existing.status === 'cancelled') {
      throw new Error('Cannot reschedule a cancelled booking');
    }

    const startTime = parseISO(newStartTime);
    const endTime = addMinutes(startTime, existing.duration_minutes);
    const bufferStart = addMinutes(startTime, -existing.buffer_before_minutes);
    const bufferEnd = addMinutes(endTime, existing.buffer_after_minutes);

    // Check for conflicts (excluding the current booking)
    const conflicts = await client.query(
      `SELECT id FROM bookings
       WHERE host_user_id = $1
         AND id != $2
         AND status = 'confirmed'
         AND start_time < $3
         AND end_time > $4`,
      [existing.host_user_id, id, bufferEnd.toISOString(), bufferStart.toISOString()]
    );

    if (conflicts.rows.length > 0) {
      recordBookingOperation('reschedule', 'conflict');
      throw new Error('New time slot is not available');
    }

    // Update the booking
    const result = await client.query(
      `UPDATE bookings
       SET start_time = $1, end_time = $2, status = 'rescheduled',
           updated_at = NOW(), version = version + 1
       WHERE id = $3 AND version = $4
       RETURNING *`,
      [startTime.toISOString(), endTime.toISOString(), id, existing.version]
    );

    if (result.rows.length === 0) {
      throw new Error('Booking was modified by another request. Please try again.');
    }

    await client.query('COMMIT');

    const booking = result.rows[0];

    // Record success metric
    recordBookingOperation('reschedule', 'success');

    // Invalidate cache
    await invalidateAvailabilityCache(existing.host_user_id, existing.meeting_type_id);

    // Publish reschedule notification to RabbitMQ
    publishRescheduleNotification(booking, existing).catch((error) => {
      rescheduleLogger.error({ error }, 'Failed to publish reschedule notification');
    });

    // Send reschedule notification (legacy path)
    sendRescheduleEmail(booking).catch((error) => {
      rescheduleLogger.error({ error }, 'Failed to send reschedule notification');
      emailNotificationsTotal.inc({ type: 'reschedule', status: 'failure' });
    });

    rescheduleLogger.info({ newStartTime }, 'Booking rescheduled successfully');

    return booking;
  } catch (error) {
    await client.query('ROLLBACK');
    rescheduleLogger.error({ error }, 'Failed to reschedule booking');
    throw error;
  } finally {
    client.release();
  }
}
