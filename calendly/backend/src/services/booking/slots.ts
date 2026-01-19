/**
 * Available time slot computation and booking retrieval logic.
 *
 * @description Handles querying bookings for date ranges, fetching booking details,
 * computing dashboard statistics, and managing availability cache invalidation.
 * This module provides the read-side operations for the booking service.
 *
 * @module services/booking/slots
 */

import { pool, redis } from '../../db/index.js';
import { type Booking, type BookingWithDetails, type DashboardStats } from './types.js';
import { activeBookingsGauge } from '../../shared/metrics.js';
import { logger } from '../../shared/logger.js';
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';

/**
 * Retrieves a booking by its unique ID.
 *
 * @description Performs a simple lookup in the bookings table. Returns the raw
 * booking data without any joined relations.
 *
 * @param {string} id - The UUID of the booking to retrieve
 * @returns {Promise<Booking | null>} The booking if found, null otherwise
 *
 * @example
 * const booking = await findById('550e8400-e29b-41d4-a716-446655440000');
 * if (booking) {
 *   console.log(`Found booking for ${booking.invitee_name}`);
 * }
 */
export async function findById(id: string): Promise<Booking | null> {
  const result = await pool.query(
    `SELECT * FROM bookings WHERE id = $1`,
    [id]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Retrieves a booking with full related entity details.
 *
 * @description Fetches a booking along with joined data from meeting_types and users
 * tables. Includes meeting type name, duration, and host information. Useful for
 * displaying complete booking details to users.
 *
 * @param {string} id - The UUID of the booking to retrieve
 * @returns {Promise<BookingWithDetails | null>} Booking with details if found, null otherwise
 *
 * @example
 * const booking = await findByIdWithDetails('550e8400-e29b-41d4-a716-446655440000');
 * if (booking) {
 *   console.log(`Meeting: ${booking.meeting_type_name} with ${booking.host_name}`);
 * }
 */
export async function findByIdWithDetails(id: string): Promise<BookingWithDetails | null> {
  const result = await pool.query(
    `SELECT b.*,
            mt.name as meeting_type_name,
            mt.duration_minutes as meeting_type_duration,
            u.name as host_name,
            u.email as host_email
     FROM bookings b
     JOIN meeting_types mt ON b.meeting_type_id = mt.id
     JOIN users u ON b.host_user_id = u.id
     WHERE b.id = $1`,
    [id]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Retrieves all bookings for a host user with optional filtering.
 *
 * @description Fetches bookings for a given host with full meeting type and host
 * details included. Supports filtering by status and/or upcoming meetings only.
 * Results are sorted by start time in ascending order.
 *
 * @param {string} userId - The UUID of the host user
 * @param {string} [status] - Optional status filter ('confirmed', 'cancelled', 'rescheduled')
 * @param {boolean} [upcoming=false] - If true, only returns future bookings
 * @returns {Promise<BookingWithDetails[]>} Array of bookings sorted by start time ascending
 *
 * @example
 * // Get all upcoming confirmed bookings
 * const bookings = await getBookingsForUser(userId, 'confirmed', true);
 *
 * @example
 * // Get all bookings regardless of status or time
 * const allBookings = await getBookingsForUser(userId);
 */
export async function getBookingsForUser(
  userId: string,
  status?: string,
  upcoming: boolean = false
): Promise<BookingWithDetails[]> {
  let query = `
    SELECT b.*,
           mt.name as meeting_type_name,
           mt.duration_minutes as meeting_type_duration,
           u.name as host_name,
           u.email as host_email
    FROM bookings b
    JOIN meeting_types mt ON b.meeting_type_id = mt.id
    JOIN users u ON b.host_user_id = u.id
    WHERE b.host_user_id = $1
  `;
  const params: (string | Date)[] = [userId];
  let paramIndex = 2;

  if (status) {
    query += ` AND b.status = $${paramIndex++}`;
    params.push(status);
  }

  if (upcoming) {
    query += ` AND b.start_time > NOW()`;
  }

  query += ` ORDER BY b.start_time ASC`;

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Retrieves confirmed bookings within a date range for availability calculation.
 *
 * @description Used internally to determine busy periods when computing available
 * slots. Only returns confirmed bookings (excludes cancelled/rescheduled).
 * Results are ordered by start time.
 *
 * @param {string} userId - The UUID of the host user
 * @param {Date} startDate - Range start (inclusive)
 * @param {Date} endDate - Range end (inclusive)
 * @returns {Promise<Booking[]>} Array of confirmed bookings in the range
 *
 * @example
 * const weekStart = new Date('2024-01-15');
 * const weekEnd = new Date('2024-01-21');
 * const busySlots = await getBookingsForDateRange(userId, weekStart, weekEnd);
 */
export async function getBookingsForDateRange(
  userId: string,
  startDate: Date,
  endDate: Date
): Promise<Booking[]> {
  const result = await pool.query(
    `SELECT * FROM bookings
     WHERE host_user_id = $1
       AND status = 'confirmed'
       AND start_time >= $2
       AND start_time <= $3
     ORDER BY start_time`,
    [userId, startDate.toISOString(), endDate.toISOString()]
  );

  return result.rows;
}

/**
 * Computes dashboard statistics for a host user.
 *
 * @description Provides aggregated counts of bookings for display on the user
 * dashboard. Runs multiple parallel queries to efficiently compute statistics
 * for different time periods.
 *
 * @param {string} userId - The UUID of the host user
 * @returns {Promise<DashboardStats>} Statistics including:
 *   - total_bookings: All-time booking count
 *   - upcoming_bookings: Future confirmed bookings
 *   - total_meeting_types: Active meeting types count
 *   - bookings_this_week: Bookings created in current week
 *   - bookings_this_month: Bookings created in current month
 *
 * @example
 * const stats = await getDashboardStats(userId);
 * console.log(`You have ${stats.upcoming_bookings} upcoming meetings`);
 */
export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  const [totalResult, upcomingResult, meetingTypesResult, weekResult, monthResult] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*) as count FROM bookings WHERE host_user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT COUNT(*) as count FROM bookings
         WHERE host_user_id = $1 AND status = 'confirmed' AND start_time > NOW()`,
        [userId]
      ),
      pool.query(
        `SELECT COUNT(*) as count FROM meeting_types WHERE user_id = $1 AND is_active = true`,
        [userId]
      ),
      pool.query(
        `SELECT COUNT(*) as count FROM bookings
         WHERE host_user_id = $1 AND created_at >= $2 AND created_at <= $3`,
        [userId, weekStart.toISOString(), weekEnd.toISOString()]
      ),
      pool.query(
        `SELECT COUNT(*) as count FROM bookings
         WHERE host_user_id = $1 AND created_at >= $2 AND created_at <= $3`,
        [userId, monthStart.toISOString(), monthEnd.toISOString()]
      ),
    ]);

  return {
    total_bookings: parseInt(totalResult.rows[0].count),
    upcoming_bookings: parseInt(upcomingResult.rows[0].count),
    total_meeting_types: parseInt(meetingTypesResult.rows[0].count),
    bookings_this_week: parseInt(weekResult.rows[0].count),
    bookings_this_month: parseInt(monthResult.rows[0].count),
  };
}

/**
 * Updates the active bookings Prometheus gauge metric.
 *
 * @description Called after booking creation or cancellation to keep the
 * Prometheus metrics up to date. Queries the current count of confirmed
 * future bookings and updates the gauge. Errors are logged but not thrown.
 *
 * @returns {Promise<void>} Resolves when gauge is updated
 */
export async function updateActiveBookingsGauge(): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM bookings
       WHERE status = 'confirmed' AND start_time > NOW()`
    );
    activeBookingsGauge.set(parseInt(result.rows[0].count));
  } catch (error) {
    logger.error({ error }, 'Failed to update active bookings gauge');
  }
}

/**
 * Clears cached availability slots when bookings change.
 *
 * @description Ensures invitees see up-to-date availability after a booking
 * is created, cancelled, or rescheduled. Deletes all Redis cache keys matching
 * the pattern for the specified meeting type.
 *
 * @param {string} userId - The UUID of the host user (unused but included for API consistency)
 * @param {string} meetingTypeId - The UUID of the affected meeting type
 * @returns {Promise<void>} Resolves when cache is invalidated
 *
 * @example
 * // After creating a booking
 * await invalidateAvailabilityCache(hostUserId, meetingTypeId);
 */
export async function invalidateAvailabilityCache(
  userId: string,
  meetingTypeId: string
): Promise<void> {
  const keys = await redis.keys(`slots:${meetingTypeId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
